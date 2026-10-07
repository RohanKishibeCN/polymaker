"""The scanner: sweep Gamma for political markets, measure their books, score, persist.

Replaces the v1 data_updater (hour-long crawl of every order book, written to Google
Sheets). A politics-filtered sweep plus a bounded set of book reads here is seconds
and one process.

Scoring depends on the *live book*, not just Gamma's headline numbers: the reward pool
is split by score share, so what a constrained order actually earns is decided by the
depth already resting inside the reward band. Gamma cannot report that, so each
candidate's book is read (concurrently, bounded) and the in-band weighted depth on the
thinner side is aggregated.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

import httpx

from polymaker.catalog.gamma import (
    POLITICS_TAG_SLUG,
    GammaClient,
    fetch_reward_rates,
    parse_market,
)
from polymaker.catalog.scoring import BookStats, score_market
from polymaker.catalog.store import CatalogStore
from polymaker.domain import MarketMeta
from polymaker.logging import get_logger

log = get_logger("catalog.scanner")

# Book reads are public and cheap, but a political sweep can surface hundreds of
# reward markets; keep the fan-out bounded so we do not trip Cloudflare.
_BOOK_CONCURRENCY = 8
_BOOK_TIMEOUT_S = 20.0


@dataclass(frozen=True, slots=True)
class ScanConfig:
    tag_slug: str = POLITICS_TAG_SLUG
    min_liquidity: float = 1000.0
    min_volume_24hr: float = 0.0
    rewards_only: bool = True  # keep only markets in the liquidity-rewards program
    gamma_host: str = "https://gamma-api.polymarket.com"
    clob_host: str = "https://clob.polymarket.com"
    measure_books: bool = True  # read live books for accurate reward competition


async def fetch_book_stats(
    client: httpx.AsyncClient,
    token_ids: tuple[str, str],
    *,
    band_cents: float,
) -> BookStats | None:
    """Aggregate the score-weighted in-band depth on the thinner side of a book.

    The reward score of a resting order is ``size * ((band - distance) / band)^2``
    measured from the midpoint, so the depth competing for the pool is the weighted sum
    of everything inside the band. The *thinner* side binds: a two-sided quote only
    scores as well as its weaker leg.
    """
    results: list[tuple[float, float, float]] = []  # (thinner_weight, its dist, mid)
    mid: float | None = None
    spread = 0.0
    for tid in token_ids:
        try:
            r = await client.get("/book", params={"token_id": tid})
            r.raise_for_status()
            book = r.json()
        except (httpx.HTTPError, ValueError) as exc:
            log.debug("book_read_failed", token=str(tid)[:12], err=str(exc))
            return None
        bids = _levels(book.get("bids"))
        asks = _levels(book.get("asks"))
        if not bids or not asks:
            return None
        best_bid = max(bids)[0]
        best_ask = min(asks)[0]
        this_mid = (best_bid + best_ask) / 2.0
        w_bid = _weighted_depth(bids, this_mid, band_cents)
        w_ask = _weighted_depth(asks, this_mid, band_cents)
        # The thinner side sets the competition, and we would quote AT the touch on
        # that same side, so its distance from the mid is the distance we score at.
        if w_bid <= w_ask:
            thinner, dist = w_bid, abs(this_mid - best_bid) * 100.0
        else:
            thinner, dist = w_ask, abs(best_ask - this_mid) * 100.0
        results.append((thinner, dist, this_mid))
        if mid is None:
            mid, spread = this_mid, max(0.0, best_ask - best_bid)
    if mid is None or not results:
        return None
    thinner, dist, _ = min(results, key=lambda t: t[0])
    return BookStats(weighted_shares=thinner, mid=mid, spread=spread,
                     our_distance_cents=dist)


def _levels(items: Any) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    if not isinstance(items, list | tuple):
        return out
    for it in items:
        if not isinstance(it, dict):
            continue
        try:
            out.append((float(it["price"]), float(it["size"])))
        except (KeyError, TypeError, ValueError):
            continue
    return out


def _weighted_depth(levels: list[tuple[float, float]], mid: float, band_cents: float) -> float:
    total = 0.0
    for price, size in levels:
        distance = abs(mid - price) * 100.0
        if distance > band_cents:
            continue
        ratio = (band_cents - distance) / band_cents
        total += size * ratio * ratio
    return total


async def run_scan(store: CatalogStore, cfg: ScanConfig) -> list[MarketMeta]:
    """Fetch, parse, filter, measure, score, and persist. Returns the kept markets."""
    reward_rates = await fetch_reward_rates(cfg.clob_host)
    log.info("reward_rates_loaded", n=len(reward_rates))

    kept: list[MarketMeta] = []
    seen = 0
    async with GammaClient(cfg.gamma_host) as gamma:
        tag_id = store.cached_tag(cfg.tag_slug) or await gamma.resolve_tag_id(cfg.tag_slug)
        if tag_id:
            store.cache_tag(cfg.tag_slug, tag_id)

        async for raw in gamma.iter_markets(
            tag_id=tag_id,
            min_liquidity=cfg.min_liquidity,
            min_volume_24hr=cfg.min_volume_24hr,
        ):
            seen += 1
            meta = parse_market(raw, reward_rates)
            if meta is None:
                continue
            if cfg.rewards_only and meta.rewards_daily_rate <= 0:
                continue
            kept.append(meta)

    books: dict[str, BookStats] = {}
    if cfg.measure_books:
        books = await _measure_books(cfg.clob_host, kept)

    for m in kept:
        store.upsert_market(m, score_market(m, books.get(m.condition_id)))

    log.info("scan_complete", seen=seen, kept=len(kept), measured=len(books), tag=cfg.tag_slug)
    return kept


async def _measure_books(clob_host: str, metas: list[MarketMeta]) -> dict[str, BookStats]:
    """Read each candidate's book concurrently, bounded, skipping failures."""
    if not metas:
        return {}
    sem = asyncio.Semaphore(_BOOK_CONCURRENCY)
    out: dict[str, BookStats] = {}

    async with httpx.AsyncClient(base_url=clob_host.rstrip("/"), timeout=_BOOK_TIMEOUT_S) as client:
        async def one(m: MarketMeta) -> None:
            tokens = (m.yes.token_id, m.no.token_id)
            try:
                async with sem:
                    stats = await fetch_book_stats(client, tokens, band_cents=m.rewards_max_spread)
            except Exception as exc:  # noqa: BLE001 - one bad book must not fail the scan
                log.debug("book_measure_failed", slug=m.slug, err=str(exc))
                return
            if stats is not None:
                out[m.condition_id] = stats

        await asyncio.gather(*(one(m) for m in metas))

    log.info("books_measured", measured=len(out), attempted=len(metas))
    return out
