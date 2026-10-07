"""Async Gamma API client for market discovery.

Gamma (https://gamma-api.polymarket.com, no auth) returns everything the v1
scanner burned two extra REST calls per market to compute: best bid/ask,
liquidity, volume, reward params, fee schedule, tick size, tokens. We filter
server-side by the politics tag and liquidity/volume, so a full political-market
sweep is a handful of paginated requests.
"""

from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator
from typing import Any

import httpx

from polymaker.domain import MarketMeta, ProtocolVersion, TokenMeta
from polymaker.execution.ledger import is_decimal_id
from polymaker.logging import get_logger

log = get_logger("catalog.gamma")

POLITICS_TAG_SLUG = "politics"


class GammaClient:
    """Thin async wrapper over the Gamma REST endpoints we use."""

    def __init__(self, host: str = "https://gamma-api.polymarket.com", timeout: float = 20.0) -> None:
        self._host = host.rstrip("/")
        self._client = httpx.AsyncClient(base_url=self._host, timeout=timeout)

    async def __aenter__(self) -> GammaClient:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        await self._client.aclose()

    async def markets_by_condition(self, condition_ids: list[str]) -> dict[str, dict[str, Any]]:
        """Fetch current raw market dicts for specific condition ids (metadata
        refresh: detect closed/not-accepting/resolved and updated end dates)."""
        out: dict[str, dict[str, Any]] = {}
        if not condition_ids:
            return out
        try:
            r = await self._client.get(
                "/markets",
                params={"condition_ids": ",".join(condition_ids), "limit": len(condition_ids) + 5},
            )
            r.raise_for_status()
            for m in r.json():
                cid = m.get("conditionId")
                if cid:
                    out[cid] = m
        except (httpx.HTTPError, ValueError, KeyError) as exc:
            log.warning("markets_by_condition_failed", err=str(exc))
        return out

    async def market_by_slug(self, slug: str) -> dict[str, Any] | None:
        """Direct single-market lookup by slug (Gamma filters server-side).

        Used to re-read a traded market's live metadata rather than trusting a cached
        row: only Gamma is authoritative for `version`, and the cached catalog can be
        arbitrarily old.
        """
        return await self._one("/markets", {"slug": slug})

    async def market_by_condition_id(self, condition_id: str) -> dict[str, Any] | None:
        """Direct single-market lookup by condition id."""
        return await self._one("/markets", {"condition_ids": condition_id})

    async def _one(self, path: str, params: dict[str, Any]) -> dict[str, Any] | None:
        try:
            r = await self._client.get(path, params=params)
            r.raise_for_status()
            rows = r.json()
        except (httpx.HTTPError, ValueError, KeyError) as exc:
            log.warning("gamma_lookup_failed", path=path, err=str(exc))
            return None
        if isinstance(rows, list) and rows and isinstance(rows[0], dict):
            return rows[0]
        return None

    async def resolve_tag_id(self, slug: str) -> str | None:
        try:
            r = await self._client.get(f"/tags/slug/{slug}")
            r.raise_for_status()
            return str(r.json()["id"])
        except (httpx.HTTPError, KeyError, json.JSONDecodeError):
            log.warning("tag_resolve_failed", slug=slug)
            return None

    async def iter_markets(
        self,
        *,
        tag_id: str | None = None,
        related_tags: bool = True,
        min_liquidity: float = 0.0,
        min_volume_24hr: float = 0.0,
        limit: int = 100,  # Gamma caps a page at 100 regardless of a higher ask
        max_pages: int = 25,
    ) -> AsyncIterator[dict[str, Any]]:
        """Yield raw active/open market dicts, offset-paginated.

        Uses the offset `/markets` endpoint because it reliably supports
        `tag_id` filtering today. (Keyset is the go-forward per docs; switch when
        it supports tag filtering. See the README.)
        """
        offset = 0
        for _ in range(max_pages):
            params: dict[str, Any] = {
                "limit": limit,
                "offset": offset,
                "active": "true",
                "closed": "false",
                "order": "volume24hr",
                "ascending": "false",
            }
            if tag_id:
                params["tag_id"] = tag_id
                params["related_tags"] = "true" if related_tags else "false"
            if min_liquidity > 0:
                params["liquidity_num_min"] = min_liquidity
            if min_volume_24hr > 0:
                params["volume_num_min"] = min_volume_24hr

            r = await self._client.get("/markets", params=params)
            # Gamma returns 422 (not an empty page) once the offset runs past the
            # last result — treat that as the natural end of pagination.
            if r.status_code in (400, 422):
                log.info("pagination_end", offset=offset, status=r.status_code)
                return
            r.raise_for_status()
            batch = r.json()
            if not batch:
                return
            for m in batch:
                yield m
            if len(batch) < limit:
                return
            offset += limit


def parse_market(raw: dict[str, Any], reward_rates: dict[str, float] | None = None) -> MarketMeta | None:
    """Convert a Gamma market dict into our MarketMeta, or None if unusable.

    The outcome identifier is selected by Gamma's `version`, and ONLY by it. Both
    `clobTokenIds` and `positionIds` can be present on the same market (a CTF market
    can carry V2 position ids as PositionManager-workflow legs), so field presence is
    never a valid discriminator. The two id fields also arrive differently encoded:

        version == "v1"  ->  clobTokenIds : JSON-encoded string of decimal ids
        version == "v2"  ->  positionIds : native array of decimal id strings

    Versions other than v1/v2 are unsupported and rejected, as are missing or
    non-decimal ids.
    """
    slug = raw.get("slug")
    try:
        if not raw.get("acceptingOrders", False):
            return None

        version = ProtocolVersion.parse(raw.get("version"))
        if version is None:
            log.warning("unsupported_market_version", slug=slug,
                        version=repr(raw.get("version")))
            return None

        outcomes = _json_list(raw.get("outcomes"))
        token_ids = _outcome_ids(raw, version)
        if len(token_ids) != 2 or len(outcomes) != 2:
            return None  # only binary markets
        if not all(is_decimal_id(str(t)) for t in token_ids):
            # A non-decimal id would be silently unusable downstream (int() on the
            # order path, ledger reads), so reject the market instead.
            log.warning("non_decimal_outcome_id", slug=slug, version=version.value,
                        ids=[str(t)[:24] for t in token_ids])
            return None

        condition_id = raw["conditionId"]
        rate_map = reward_rates or {}
        fee = raw.get("feeSchedule") or {}
        taker_rate = float(fee.get("rate", 0.0) or 0.0)

        event_id = None
        events = raw.get("events") or []
        if events:
            event_id = str(events[0].get("id")) if events[0].get("id") is not None else None

        return MarketMeta(
            condition_id=condition_id,
            question=raw.get("question", ""),
            slug=raw.get("slug", ""),
            tokens=(
                TokenMeta(str(token_ids[0]), str(outcomes[0])),
                TokenMeta(str(token_ids[1]), str(outcomes[1])),
            ),
            tick_size=float(raw.get("orderPriceMinTickSize", 0.001) or 0.001),
            neg_risk=bool(raw.get("negRisk", False)),
            min_order_size=float(raw.get("orderMinSize", 5) or 5),
            rewards_min_size=float(raw.get("rewardsMinSize", 0) or 0),
            rewards_max_spread=float(raw.get("rewardsMaxSpread", 0) or 0),
            rewards_daily_rate=float(rate_map.get(condition_id, 0.0)),
            maker_fee_bps=0,  # makers pay zero
            taker_fee_bps=int(round(taker_rate * 10000)),
            fees_enabled=bool(raw.get("feesEnabled", False)),
            rebate_rate=float(fee.get("rebateRate", 0.0) or 0.0),
            end_date_iso=raw.get("endDate"),
            event_id=event_id,
            best_bid=float(raw.get("bestBid", 0) or 0),
            best_ask=float(raw.get("bestAsk", 0) or 0),
            liquidity_num=float(raw.get("liquidityNum", 0) or 0),
            volume_num=float(raw.get("volumeNum", 0) or 0),
            # prefer CLOB 24h volume (the taker flow that generates fees);
            # fall back to total 24h volume
            volume_24hr=float(raw.get("volume24hrClob") or raw.get("volume24hr") or 0),
            version=version,
            scanned_ts=time.time(),
            resolved=_is_resolved(raw, version),
        )
    except (KeyError, ValueError, TypeError) as exc:
        log.warning("parse_market_failed", err=str(exc), slug=slug)
        return None


def _outcome_ids(raw: dict[str, Any], version: ProtocolVersion) -> list[Any]:
    """Outcome ids for a market, decoded per its protocol version.

    `clobTokenIds` is a JSON string; `positionIds` is already a list. They are not
    interchangeable and must not be merged into one fallback chain.
    """
    if version is ProtocolVersion.V2:
        value = raw.get("positionIds")
        return value if isinstance(value, list) else _json_list(value)
    return _json_list(raw.get("clobTokenIds"))


def _is_resolved(raw: dict[str, Any], version: ProtocolVersion) -> bool:
    """Resolution flag, read from the field the market's version actually uses.

    V2 markets report `resolutionStatus` (inactive|active|resolved); V1 markets keep
    `umaResolutionStatus`. An unknown/absent value is not evidence of resolution.
    """
    if version is ProtocolVersion.V2:
        return str(raw.get("resolutionStatus") or "").strip().lower() == "resolved"
    return str(raw.get("umaResolutionStatus") or "").strip().lower() == "resolved"


def _json_list(value: Any) -> list[Any]:
    """clobTokenIds / outcomes arrive as JSON-encoded strings."""
    if value is None:
        return []
    if isinstance(value, list):
        return value
    try:
        parsed = json.loads(value)
        return parsed if isinstance(parsed, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


async def fetch_reward_rates(
    clob_host: str = "https://clob.polymarket.com", timeout: float = 20.0
) -> dict[str, float]:
    """Build {condition_id: daily USDC reward rate} from CLOB sampling-markets.

    These are the rewards-enabled markets; the daily rate isn't on Gamma.
    """
    usdc = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174"
    rates: dict[str, float] = {}
    async with httpx.AsyncClient(base_url=clob_host.rstrip("/"), timeout=timeout) as client:
        cursor = ""
        for _ in range(50):
            r = await client.get("/sampling-markets", params={"next_cursor": cursor})
            r.raise_for_status()
            data = r.json()
            for m in data.get("data", []):
                cid = m.get("condition_id")
                rate = 0.0
                for ri in (m.get("rewards") or {}).get("rates") or []:
                    if str(ri.get("asset_address", "")).lower() == usdc:
                        rate = float(ri.get("rewards_daily_rate", 0) or 0)
                        break
                if cid:
                    rates[cid] = rate
            cursor = data.get("next_cursor") or ""
            if not cursor or cursor == "LTE=":  # "LTE=" is the documented end sentinel
                break
    return rates
