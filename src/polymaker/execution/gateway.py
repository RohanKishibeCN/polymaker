"""ExecutionGateway: the only component that sends actions to the CLOB.

Wraps the synchronous py-clob-client-v2 (which owns the hard V2 EIP-712 signing,
pUSD balance adjustment, and tick/fee caching) and offloads its blocking network
calls to a thread pool so the asyncio hot path never stalls. Every quote goes out
**post-only** (the maker-only mandate, enforced at the exchange).

A `paper=True` gateway shares the same path but fabricates order ids instead of
posting — so paper mode exercises the full pipeline.
"""

from __future__ import annotations

import asyncio
import itertools
import random
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from typing import Any, TypeVar

import httpx
from web3 import Web3
from web3.middleware import ExtraDataToPOAMiddleware

from polymaker.config import Config
from polymaker.domain import MarketMeta, OpenOrder, OrderState, ProtocolVersion, Quote, Side
from polymaker.execution.ledger import (
    ASSET_TYPE_COLLATERAL,
    ERC1155_ABI,
    ledger_for,
)
from polymaker.execution.ratelimit import TokenBucket
from polymaker.journal import Journal
from polymaker.logging import get_logger

log = get_logger("execution.gateway")

_T = TypeVar("_T")

# Collateral (pUSD) is a 6-decimal fixed-point ERC-20: 1_000_000 base units == 1 pUSD.
_COLLATERAL_DECIMALS = 1_000_000.0

# Data API v2 pagination guard: 1000 rows/page, so this allows ~50k positions.
_MAX_POSITION_PAGES = 50

# HTTP statuses worth a bounded retry (rate limit / transient server / proxy hiccup).
_RETRY_STATUS = frozenset({429, 500, 502, 503, 504})


def _tick_str(tick: float) -> str:
    return f"{tick:g}"


async def _get_json_with_retry(
    client: httpx.AsyncClient,
    url: str,
    *,
    params: dict[str, Any],
    attempts: int = 3,
) -> Any:
    """GET with bounded backoff on 429/5xx. Raises the last HTTPError on failure.

    The Data API signals load with 429 + Retry-After and DB-pool exhaustion with
    503 request_timeout; both are transient, so a short exponential backoff keeps
    a routine reconcile from being recorded as a hard failure.
    """
    last: httpx.HTTPError | None = None
    for attempt in range(attempts):
        try:
            r = await client.get(url, params=params)
            if r.status_code in _RETRY_STATUS and attempt < attempts - 1:
                retry_after = r.headers.get("Retry-After", "")
                try:
                    delay = float(retry_after)
                except (TypeError, ValueError):
                    delay = 0.5 * (2**attempt) + random.random() * 0.25
                await asyncio.sleep(min(delay, 5.0))
                continue
            r.raise_for_status()
            return r.json()
        except httpx.HTTPError as exc:
            last = exc
            status = getattr(getattr(exc, "response", None), "status_code", None)
            if status is not None and status not in _RETRY_STATUS:
                raise
            if attempt < attempts - 1:
                await asyncio.sleep(min(0.5 * (2**attempt) + random.random() * 0.25, 5.0))
    assert last is not None
    raise last


def _as_float(value: Any) -> float | None:
    """Best-effort float. Base-unit balances arrive as strings; never raise."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


class ExecutionGateway:
    def __init__(
        self,
        cfg: Config,
        journal: Journal | None = None,
        *,
        paper: bool = False,
    ) -> None:
        self._cfg = cfg
        self._paper = paper
        self._journal = journal
        self._client: Any = None  # py_clob_client_v2.ClobClient
        self._creds: Any = None
        self._address: str = ""  # signer EOA
        self._funder: str = ""  # funds/positions live here (proxy/deposit wallet)
        self._data_host = cfg.wallet.data_api_host
        # rate budgets: fraction of documented POST/DELETE ceilings (per second)
        f = cfg.execution.rate_budget_fraction
        self._order_bucket = TokenBucket(rate_per_s=200.0 * f, burst=500.0 * f)
        self._cancel_bucket = TokenBucket(rate_per_s=200.0 * f, burst=500.0 * f)
        self._paper_ids = itertools.count(1)
        self._hb_id: str = ""  # heartbeat chain
        self._hb_failures: int = 0
        # dedicated, bounded pool for blocking order/HTTP calls so a burst of
        # requotes across many markets can't starve the default executor
        self._pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="clob-io")

    @property
    def paper(self) -> bool:
        return self._paper

    @property
    def order_pressure(self) -> float:
        """0 = plenty of order-post budget, 1 = about to queue (shed load)."""
        return self._order_bucket.pressure

    def drain(self, timeout_s: float = 10.0) -> None:
        """Wait for in-flight client calls to finish before we cancel/replace orders.

        `shutdown()` used to race: cancel_all() could run while a place() POST was
        still executing on the pool (cancel_futures only drops QUEUED work, it cannot
        stop a call already in flight). The order could then be accepted AFTER the
        cancel, leaving a live untracked order at process exit.
        """
        self._pool.shutdown(wait=True, cancel_futures=True)

    def close(self) -> None:
        # WARNING: prefer drain() first when live orders may be in flight.
        self._pool.shutdown(wait=False, cancel_futures=True)

    async def _io(self, fn: Callable[..., _T], *args: Any) -> _T:
        """Run a blocking client call on the dedicated pool."""
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._pool, fn, *args)

    @property
    def creds(self) -> Any:
        return self._creds

    @property
    def address(self) -> str:
        """The signing EOA address."""
        return self._address

    @property
    def funder(self) -> str:
        """The address holding funds/positions (proxy/deposit wallet, or the EOA)."""
        return self._funder or self._address

    # ── lifecycle ───────────────────────────────────────────────────────
    async def connect(self) -> None:
        """Build the client and derive L2 API creds (network). No-op fields in paper."""
        sec = self._cfg.secrets
        if self._paper and not sec.has_wallet:
            # paper mode runs the full pipeline without a wallet (no orders posted)
            self._address = sec.browser_address or "0xPAPER"
            self._funder = sec.browser_address or self._address
            log.info("gateway_connected", address=self._address[:10], paper=True)
            return
        if not sec.has_wallet:
            raise RuntimeError("no wallet configured (set PK and BROWSER_ADDRESS in .env)")

        def _build() -> tuple[Any, Any, str]:
            from py_clob_client_v2.client import ClobClient

            client = ClobClient(
                host=self._cfg.wallet.clob_host,
                chain_id=self._cfg.wallet.chain_id,
                key=sec.pk,
                # use_server_time=False: fetching /time before EVERY signed order
                # adds a full round-trip per op (latency killer through a proxy).
                # We check clock drift once below and rely on the local (NTP) clock.
                signature_type=self._cfg.wallet.signature_type,
                funder=sec.browser_address,
            )
            creds = client.create_or_derive_api_key()
            client.set_api_creds(creds)
            return client, creds, client.get_address()

        self._client, self._creds, self._address = await self._io(_build)
        await self._check_clock_drift()
        # funds/positions live on the funder (proxy/deposit wallet); fall back to EOA
        self._funder = sec.browser_address or self._address
        log.info("gateway_connected", signer=self._address[:10], funder=self._funder[:10],
                 paper=self._paper)

    async def _check_clock_drift(self) -> None:
        """Warn once if the local clock is skewed vs the exchange (affects L2 auth)."""
        try:
            async with httpx.AsyncClient(timeout=10.0) as c:
                r = await c.get(f"{self._cfg.wallet.clob_host}/time")
                server = float(r.text.strip().strip('"'))
            drift = abs(time.time() - server)
            if drift > 5.0:
                log.warning("clock_drift", drift_s=round(drift, 1),
                            note="sync system clock (NTP) — large skew can fail order auth")
            else:
                log.info("clock_ok", drift_s=round(drift, 1))
        except (httpx.HTTPError, ValueError) as exc:
            log.warning("clock_check_failed", err=str(exc))

    # ── placement ───────────────────────────────────────────────────────
    async def place(self, quotes: list[Quote], meta: MarketMeta) -> list[OpenOrder]:
        if not quotes:
            return []
        await self._order_bucket.acquire(len(quotes))
        ts = time.time()
        self._journal_write("orders_out", [asdict(q) for q in quotes], ts)

        if self._paper:
            return [self._paper_order(q) for q in quotes]

        def _place() -> list[OpenOrder]:
            from py_clob_client_v2.clob_types import (
                OrderArgsV2,
                OrderType,
                PartialCreateOrderOptions,
                PostOrdersV2Args,
            )

            opts = PartialCreateOrderOptions(tick_size=_tick_str(meta.tick_size), neg_risk=meta.neg_risk)
            args = []
            for q in quotes:
                # V2 markets sign against ExchangeV3 (EIP-712 domain version "3");
                # passing the id as `position_id` is what selects that route, and
                # ExchangeV3 ignores neg_risk. V1/CTF markets keep `token_id` and
                # resolve to CTFExchangeV2 with domain version "2".
                order_args = (
                    OrderArgsV2(position_id=q.token_id, price=q.price, size=q.size,
                                side=q.side.value)
                    if meta.is_v2
                    else OrderArgsV2(token_id=q.token_id, price=q.price, size=q.size,
                                     side=q.side.value)
                )
                signed = self._client.create_order(order_args, options=opts)
                args.append(PostOrdersV2Args(order=signed, orderType=OrderType.GTC))
            resp = self._client.post_orders(args, post_only=self._cfg.execution.post_only)
            return self._parse_place_response(resp, quotes)

        try:
            return await self._io(_place)
        except Exception as exc:  # noqa: BLE001 - surface + continue; engine handles error rate
            log.error("place_failed", err=str(exc), n=len(quotes))
            return []

    def _paper_order(self, q: Quote) -> OpenOrder:
        oid = f"paper-{next(self._paper_ids)}"
        return OpenOrder(oid, q.token_id, q.side, q.price, q.size, OrderState.LIVE)

    def _parse_place_response(self, resp: Any, quotes: list[Quote]) -> list[OpenOrder]:
        """Map a batch post response to OpenOrders. Tolerant of shape variants;
        the user-WS order events + REST snapshot reconcile anything we miss."""
        items = resp if isinstance(resp, list) else resp.get("orders", resp.get("data", []))
        out: list[OpenOrder] = []
        for q, item in zip(quotes, items if isinstance(items, list) else [], strict=False):
            oid = _first(item, "orderID", "orderId", "order_id", "id", "hash")
            if not oid:
                log.warning("place_response_missing_id", item=str(item)[:120])
                continue
            out.append(OpenOrder(str(oid), q.token_id, q.side, q.price, q.size, OrderState.LIVE))
        return out

    # ── cancellation ────────────────────────────────────────────────────
    async def cancel(self, order_ids: list[str]) -> bool:
        """Cancel by id. Returns True on success — callers must NOT drop the
        orders from local state on failure (they may still be live)."""
        if not order_ids or self._paper:
            return True
        await self._cancel_bucket.acquire(1)

        def _cancel() -> None:
            self._client.cancel_orders(order_ids)

        try:
            await self._io(_cancel)
            return True
        except Exception as exc:  # noqa: BLE001
            log.error("cancel_failed", err=str(exc), n=len(order_ids))
            return False

    async def cancel_asset(self, asset_id: str) -> bool:
        """Cancel every order on one token (idempotent quarantine primitive)."""
        if self._paper:
            return True

        def _cancel() -> None:
            from py_clob_client_v2.clob_types import OrderMarketCancelParams

            self._client.cancel_market_orders(OrderMarketCancelParams(asset_id=asset_id))

        try:
            await self._io(_cancel)
            return True
        except Exception as exc:  # noqa: BLE001
            log.error("cancel_asset_failed", err=str(exc), token=asset_id[:12])
            return False

    async def cancel_all(self) -> None:
        if self._paper or self._client is None:
            return
        await self._io(self._client.cancel_all)
        log.info("cancel_all_sent")

    # ── market (taker) orders — used by moneydoctor, NOT the maker strategy ──
    async def market_order(
        self, token_id: str, side: Side, amount: float, meta: MarketMeta,
        *, fak: bool = True,
    ) -> dict[str, Any]:
        """Place a marketable order. amount = USD for BUY, shares for SELL.

        This is a TAKER order (crosses the spread) — only the moneydoctor live
        self-test uses it; the maker strategy never does.
        """
        if self._paper or self._client is None:
            return {"paper": True}

        def _do() -> dict[str, Any]:
            from py_clob_client_v2.clob_types import (
                MarketOrderArgsV2,
                OrderType,
                PartialCreateOrderOptions,
            )

            ot = OrderType.FAK if fak else OrderType.FOK
            # V2 routes through ExchangeV3 via position_id; V1 stays on token_id.
            # NOTE (V2): a FAK/FOK BUY targets COLLATERAL while GTC/GTD targets
            # shares, so `amount` means pUSD for a market BUY and shares for SELL.
            args = (
                MarketOrderArgsV2(position_id=token_id, amount=amount,
                                  side=side.value, order_type=ot)
                if meta.is_v2
                else MarketOrderArgsV2(token_id=token_id, amount=amount,
                                       side=side.value, order_type=ot)
            )
            opts = PartialCreateOrderOptions(tick_size=_tick_str(meta.tick_size),
                                             neg_risk=meta.neg_risk)
            try:
                resp = self._client.create_and_post_market_order(args, opts, order_type=ot)
                return resp if isinstance(resp, dict) else {"resp": resp}
            except Exception as exc:  # noqa: BLE001 - surface as data, never crash the caller
                return {"status": "failed", "error": str(exc)}

        return await self._io(_do)

    async def get_book(self, token_id: str) -> dict[str, float]:
        """Live best bid/ask + touch depth for one token (public REST)."""
        try:
            async with httpx.AsyncClient(timeout=15.0) as c:
                r = await c.get(f"{self._cfg.wallet.clob_host}/book",
                                params={"token_id": token_id})
                r.raise_for_status()
                b = r.json()
                bids = [(float(x["price"]), float(x["size"])) for x in b.get("bids", [])]
                asks = [(float(x["price"]), float(x["size"])) for x in b.get("asks", [])]
                best_bid = max(bids)[0] if bids else 0.0
                best_ask = min(asks)[0] if asks else 1.0
                ask_depth = sum(s for p, s in asks if p <= best_ask + 1e-9)
                bid_depth = sum(s for p, s in bids if p >= best_bid - 1e-9)
                return {"best_bid": best_bid, "best_ask": best_ask,
                        "ask_depth": ask_depth, "bid_depth": bid_depth}
        except (httpx.HTTPError, KeyError, ValueError) as exc:
            log.warning("get_book_failed", err=str(exc))
            return {}

    async def get_full_book(
        self, token_id: str
    ) -> tuple[list[tuple[float, float]], list[tuple[float, float]], str | None] | None:
        """Full L2 book (bids, asks, hash) via public REST — for periodic
        integrity refresh against the WS book."""
        try:
            async with httpx.AsyncClient(timeout=15.0) as c:
                r = await c.get(f"{self._cfg.wallet.clob_host}/book",
                                params={"token_id": token_id})
                r.raise_for_status()
                b = r.json()
                bids = [(float(x["price"]), float(x["size"])) for x in b.get("bids", [])]
                asks = [(float(x["price"]), float(x["size"])) for x in b.get("asks", [])]
                return bids, asks, b.get("hash")
        except (httpx.HTTPError, KeyError, ValueError) as exc:
            log.warning("get_full_book_failed", err=str(exc))
            return None

    async def token_balance(self, token_id: str, version: ProtocolVersion) -> float:
        """On-chain outcome-share balance held by the funder.

        Returns 0.0 on RPC failure. Prefer `_token_balance_opt` / `token_balances`
        when the caller must distinguish "0 shares" from "couldn't read".
        """
        bal = await self._token_balance_opt(token_id, version)
        return bal if bal is not None else 0.0

    async def _token_balance_opt(
        self, token_id: str, version: ProtocolVersion = ProtocolVersion.V1
    ) -> float | None:
        """Exact share balance, or None when no RPC answered.

        The ERC-1155 ledger holding the shares depends on the market's protocol
        version: CTF markets live in Conditional Tokens, Polymarket V2 markets in
        PositionManager. Sending one system's id to the other always reads 0.
        """
        ledger = ledger_for(version)

        def _read() -> float | None:
            w3 = self._rpc()
            if w3 is None:
                return None
            c = w3.eth.contract(address=Web3.to_checksum_address(ledger), abi=ERC1155_ABI)
            raw = c.functions.balanceOf(Web3.to_checksum_address(self.funder), int(token_id)).call()
            return float(raw) / 1e6

        try:
            return await self._io(_read)
        except Exception as exc:  # noqa: BLE001
            log.warning("token_balance_failed", err=str(exc), version=version.value)
            return None

    async def token_balances(
        self, token_ids: list[str] | dict[str, ProtocolVersion]
    ) -> dict[str, float] | None:
        """Batch on-chain balances, one RPC session per ledger.

        Accepts either a plain list of token ids (all assumed CTF, the legacy
        call shape) or a ``{token_id: version}`` mapping so that V1 and V2 batches
        can be read back-to-back. Returns None on RPC failure so callers can tell
        "no positions" from "couldn't read" — a distinction that matters, because
        the divergence monitor treats an empty read as authoritative truth.
        """
        if not token_ids:
            return {}
        wanted: dict[str, ProtocolVersion] = (
            dict(token_ids)
            if isinstance(token_ids, dict)
            else {t: ProtocolVersion.V1 for t in token_ids}
        )

        def _read() -> dict[str, float] | None:
            w3 = self._rpc()
            if w3 is None:
                return None
            funder = Web3.to_checksum_address(self.funder)
            out: dict[str, float] = {}
            for version in ProtocolVersion:
                ids = [t for t, v in wanted.items() if v is version]
                if not ids:
                    continue
                c = w3.eth.contract(
                    address=Web3.to_checksum_address(ledger_for(version)), abi=ERC1155_ABI
                )
                for tid in ids:
                    raw = c.functions.balanceOf(funder, int(tid)).call()
                    out[tid] = float(raw) / 1e6
            return out

        try:
            return await self._io(_read)
        except Exception as exc:  # noqa: BLE001
            log.warning("token_balances_failed", err=str(exc))
            return None

    def _rpc(self) -> Any:
        """First RPC endpoint that answers, or None. Blocking (call on the pool)."""
        configured = self._cfg.secrets.polygon_rpc or self._cfg.wallet.polygon_rpc
        rpcs = [configured, "https://polygon-bor-rpc.publicnode.com",
                "https://polygon.llamarpc.com", "https://rpc.ankr.com/polygon"]
        for rpc in dict.fromkeys(rpcs):  # dedupe, keep order
            try:
                w3 = Web3(Web3.HTTPProvider(rpc, request_kwargs={"timeout": 15}))
                w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)
                _ = w3.eth.block_number  # fail fast on a dead endpoint
                return w3
            except Exception:  # noqa: BLE001, PERF203 - try the next RPC
                continue
        return None

    async def collateral_balance(self) -> float | None:
        """pUSD (collateral) balance on the funder, or None if it can't be read.

        The CLOB returns `balance` as a 6-decimal fixed-point string
        (1_000_000 == 1 pUSD); it must be scaled unconditionally. A magnitude
        heuristic silently misreads any balance at or below 1 pUSD.
        """
        ba = await self.balance_allowance()
        if not isinstance(ba, dict):
            return None
        for k in ("balance", "collateral", "amount"):
            if k in ba:
                raw = _as_float(ba[k])
                return None if raw is None else raw / _COLLATERAL_DECIMALS
        return None

    # ── heartbeat (dead-man switch) ─────────────────────────────────────
    async def heartbeat(self) -> bool:
        """Send one chained heartbeat. Returns True on success.

        The exchange expects each heartbeat to carry the previous heartbeat_id.
        Consecutive failures are tracked in `heartbeat_failures`: after enough
        misses the exchange auto-cancels ALL our orders, so the engine must
        stop quoting and resync once the heartbeat recovers.
        """
        if self._paper or self._client is None:
            return True

        def _beat() -> Any:
            return self._client.post_heartbeat(self._hb_id)

        try:
            resp = await self._io(_beat)
            new_id = _first(resp, "heartbeat_id", "heartbeatId", "id")
            self._hb_id = str(new_id) if new_id else ""
            if self._hb_failures:
                log.info("heartbeat_recovered", after_failures=self._hb_failures)
            self._hb_failures = 0
            return True
        except Exception as exc:  # noqa: BLE001
            self._hb_failures += 1
            self._hb_id = ""  # broken chain — restart it
            log.warning("heartbeat_failed", err=str(exc), consecutive=self._hb_failures)
            return False

    @property
    def heartbeat_failures(self) -> int:
        return self._hb_failures

    # ── reads ───────────────────────────────────────────────────────────
    async def open_orders(self) -> list[OpenOrder] | None:
        """Our live orders from the CLOB, or None when the read failed.

        Returning [] on failure is dangerous: every caller treats the result as an
        authoritative snapshot, so an empty list makes the reconciler believe nothing
        is resting and re-place the whole target set — duplicate live orders we have no
        ids for. Failure must therefore be distinguishable from "no orders".

        Rows that cannot be parsed are counted and reported rather than silently
        skipped, because a field-name mismatch would otherwise look identical to an
        empty book.
        """
        if self._paper or self._client is None:
            return []

        def _get() -> list[OpenOrder]:
            raw = self._client.get_open_orders()
            rows = raw if isinstance(raw, list) else raw.get("data", raw.get("orders", []))
            if not isinstance(rows, list):
                raise ValueError(f"unexpected open-orders payload: {type(raw).__name__}")
            out: list[OpenOrder] = []
            skipped = 0
            for r in rows:
                try:
                    side = Side(str(r["side"]).upper())
                    remaining = float(r.get("original_size", r.get("size", 0))) - float(
                        r.get("size_matched", 0)
                    )
                    # V2 order rows may key the asset as `token_id`/`position_id`;
                    # accept the known spellings rather than dropping the row.
                    asset = _first(r, "asset_id", "assetId", "token_id", "tokenId", "position_id")
                    if asset is None:
                        skipped += 1
                        continue
                    oid = _first(r, "id", "orderID", "orderId", "order_id", "hash")
                    if oid is None:
                        skipped += 1
                        continue
                    out.append(
                        OpenOrder(
                            str(oid),
                            str(asset),
                            side,
                            float(r["price"]),
                            remaining,
                            OrderState.LIVE,
                        )
                    )
                except (KeyError, ValueError, TypeError):
                    skipped += 1
                    continue
            if skipped:
                log.warning("open_orders_rows_skipped", skipped=skipped, total=len(rows),
                            note="field-shape mismatch would otherwise look like an empty book")
            return out

        try:
            return await self._io(_get)
        except Exception as exc:  # noqa: BLE001
            log.warning("open_orders_failed", err=str(exc))
            return None

    async def positions(self) -> dict[str, tuple[float, float]] | None:
        """{asset_id: (size, avg_price)} from Data API v2 (reconcile use).

        Uses `/v2/positions` because Data API v1 is retired on 2026-10-24. v2 wraps
        the payload in `data`, names fields in snake_case, pages with an opaque
        cursor, and folds the lifecycle into `status`. Note `current_size` is the
        live holding while `total_size` is *lifetime bought* shares — using the
        latter would massively overstate exposure.

        Queries the FUNDER (where positions live), not the signer EOA. Returns None
        when the read failed (so callers never mistake a failed read for flat).
        """
        user = self.funder
        if not user or not user.startswith("0x") or user == "0xPAPER":
            return {}
        out: dict[str, tuple[float, float]] = {}
        cursor: str | None = None
        try:
            async with httpx.AsyncClient(timeout=15.0) as c:
                for _ in range(_MAX_POSITION_PAGES):
                    params: dict[str, Any] = {
                        "user": user,
                        "status": "OPEN",
                        "limit": 1000,
                        # keep v1's `sizeThreshold=1` semantics on the v2 API
                        "filter_type": "TOKENS",
                        "filter_amount": 1,
                    }
                    if cursor:
                        params["cursor"] = cursor
                    payload = await _get_json_with_retry(c, f"{self._data_host}/v2/positions",
                                                         params=params)
                    rows = payload.get("data") if isinstance(payload, dict) else None
                    if rows is None:
                        log.warning("positions_unexpected_shape", got=str(payload)[:120])
                        return None
                    for p in rows:
                        if not isinstance(p, dict):
                            continue
                        tok = p.get("token_id")
                        size = _as_float(p.get("current_size"))
                        if tok is None or size is None or size <= 0:
                            continue
                        out[str(tok)] = (size, _as_float(p.get("avg_price")) or 0.0)
                    page = payload.get("pagination")
                    cursor = page.get("next_cursor") if isinstance(page, dict) else None
                    if not cursor:
                        break
                else:
                    log.warning("positions_pagination_capped", pages=_MAX_POSITION_PAGES)
        except (httpx.HTTPError, ValueError, TypeError) as exc:
            log.warning("positions_failed", err=str(exc))
            return None
        return out

    async def balance_allowance(
        self, asset_type: str | None = None, token_id: str | None = None
    ) -> dict[str, Any]:
        """Balance/allowance snapshot from the CLOB (for `doctor` / approvals).

        `asset_type` defaults to COLLATERAL (pUSD). Pass ``CONDITIONAL`` for CTF
        outcome shares or ``CONDITIONAL-V2`` for V2 positions — see
        `polymaker.execution.ledger.asset_type_for`.
        """
        if self._client is None:
            return {}

        def _get() -> dict[str, Any]:
            from py_clob_client_v2.clob_types import BalanceAllowanceParams

            params = BalanceAllowanceParams(
                asset_type=asset_type or ASSET_TYPE_COLLATERAL, token_id=token_id
            )
            result: dict[str, Any] = self._client.get_balance_allowance(params)
            return result

        try:
            return await self._io(_get)
        except Exception as exc:  # noqa: BLE001
            log.warning("balance_allowance_failed", err=str(exc), asset_type=asset_type)
            return {}

    async def allowances_for(self, spender: str) -> float | None:
        """Allowance (pUSD base units -> float) granted to `spender`, or None.

        Used to preflight the V2 approvals, which existing CTF permissions do NOT
        grant: BUY needs pUSD->ExchangeV3 and SELL needs PositionManager->ExchangeV3.
        """
        ba = await self.balance_allowance()
        allow = ba.get("allowances") if isinstance(ba, dict) else None
        if not isinstance(allow, dict):
            return None
        for addr, amount in allow.items():
            if str(addr).lower() == spender.lower():
                raw = _as_float(amount)
                return None if raw is None else raw / _COLLATERAL_DECIMALS
        return 0.0

    def _journal_write(self, kind: str, payload: Any, ts: float) -> None:
        if self._journal is not None:
            self._journal.write(kind, payload, ts)


def _first(d: Any, *keys: str) -> Any:
    if not isinstance(d, dict):
        return None
    for k in keys:
        if k in d and d[k]:
            return d[k]
    return None
