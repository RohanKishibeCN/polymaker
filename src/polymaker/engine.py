"""Engine: wires every component into a single async event loop.

Data flow per market:
  market WS -> OrderBook -> (wake) -> Quoter task -> strategy (pure) -> reconcile
  -> ExecutionGateway ; user WS -> StateStore ; periodic REST reconcile + heartbeat.

One lightweight quoter task per market, woken by book/fill events and debounced.
The strategy layer is pure; the engine owns all the state and I/O around it.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from datetime import datetime
from typing import Any

from polymaker.alerts import Alerter
from polymaker.catalog.gamma import GammaClient, fetch_reward_rates, parse_market
from polymaker.catalog.store import CatalogStore
from polymaker.config import Config, MarketEntry, StrategyProfile
from polymaker.domain import Fill, MarketMeta, ProtocolVersion, Regime, Side
from polymaker.execution.gateway import ExecutionGateway
from polymaker.execution.reconciler import reconcile
from polymaker.journal import Journal
from polymaker.logging import get_logger
from polymaker.marketdata.parse import TradePrint
from polymaker.marketdata.service import MarketDataService
from polymaker.merge import Merger
from polymaker.risk.manager import RiskManager, resting_buy_notional
from polymaker.state.store import StateStore
from polymaker.state.tracker import UserEventProcessor
from polymaker.strategy.estimators import (
    FlowEstimator,
    MarketEstimators,
    MarkoutTracker,
    VolEstimator,
)
from polymaker.strategy.quoting import (
    QuoteInputs,
    compute_fair_value,
    construct_quotes,
    exit_urgency,
)
from polymaker.strategy.regime import RegimeInputs, RegimeMachine
from polymaker.userstream.client import UserStream

log = get_logger("engine")


class Engine:
    def __init__(self, cfg: Config, *, paper: bool = False) -> None:
        self.cfg = cfg
        self.paper = paper
        self._running = False

        self.journal = Journal(cfg.paths.journal_dir, enabled=cfg.engine.journal,
                               day="paper" if paper else "live")
        self.state = StateStore(cfg.paths.db)
        self.catalog = CatalogStore(cfg.paths.db)
        self.gateway = ExecutionGateway(cfg, self.journal, paper=paper)
        self.risk = RiskManager(cfg.risk, self.state)
        self.merger = Merger(cfg)
        self.alerter = Alerter(cfg.secrets.alert_webhook_url, proxy=cfg.proxy)

        self.md = MarketDataService(on_dirty=self._on_dirty, on_trade=self._on_trade,
                                    journal=self.journal, proxy=cfg.proxy)
        self.user_proc = UserEventProcessor(self.state, on_change=self._wake_cid,
                                            on_fill=self._on_fill)
        self.user: UserStream | None = None

        # per-market state
        self.metas: dict[str, MarketMeta] = {}
        self.profiles: dict[str, StrategyProfile] = {}
        self.est: dict[str, MarketEstimators] = {}
        self.regime_m: dict[str, RegimeMachine] = {}
        self._dirty: dict[str, asyncio.Event] = {}
        self._sweep: dict[str, bool] = {}
        self._merging: set[str] = set()
        self._token_cid: dict[str, str] = {}
        self._locks: dict[str, asyncio.Lock] = {}  # per-market: serialize recompute vs reconcile
        self._halted: set[str] = set()  # markets closed/resolved/not-accepting
        self._last_quote_fv: dict[str, float] = {}  # requote suppression
        self._position_since: dict[str, float] = {}  # token -> when we first held it
        self._book_unusable_since: dict[str, float] = {}  # cid -> first bad-book tick
        # supervised tasks: name -> (factory, task) so a dead task restarts
        self._task_specs: dict[str, Any] = {}
        self._tasks: dict[str, asyncio.Task[Any]] = {}
        self._aux_tasks: list[asyncio.Task[Any]] = []  # fire-and-forget (merges)
        # health / recovery signals
        self._reconcile_now = asyncio.Event()
        self._last_day_reset = time.time()  # UTC-day boundary for the daily loss window
        self._user_started = False  # user WS task launched (live mode)
        self._hb_was_down = False
        self._chain_lock = asyncio.Lock()  # serialize on-chain txs (nonce safety)

    # ── lifecycle ───────────────────────────────────────────────────────
    async def start(self) -> None:
        self._running = True
        await self.gateway.connect()
        await self._resolve_markets()
        if not self.metas:
            log.warning("no_markets_selected", hint="add markets to config/markets.toml, run `polymaker scan`")
        # freshen reward/fee/end-date params from live Gamma BEFORE quoting so a
        # stale catalog (e.g. old reward min-size) can't mis-size our orders
        await self.refresh_market_metadata()
        await self._startup_reconcile()

        # subscribe feeds
        self.md.set_markets([(cid, [m.yes.token_id, m.no.token_id]) for cid, m in self.metas.items()])
        self.user = UserStream(
            self.gateway.creds, self.gateway.funder, self.user_proc,
            other_token=self._other_token, condition_of_token=self._cid_of_token,
            journal=self.journal, proxy=self.cfg.proxy,
            on_reconnect=self._on_user_reconnect,
        )
        self.user.set_markets(list(self.metas))

        # launch supervised tasks (a dead task is restarted, never silently gone)
        self._spawn("market_ws", self.md.run)
        if not self.paper:
            assert self.user is not None
            self._spawn("user_ws", self.user.run)
            # register the dead-man switch BEFORE any quoter can place an order,
            # so a crash between placing and the first heartbeat still auto-cancels
            with contextlib.suppress(Exception):
                await self.gateway.heartbeat()
            self._spawn("heartbeat", self._heartbeat_loop)
            self._user_started = True
        self._spawn("reconcile", self._reconcile_loop)
        self._spawn("metadata", self._metadata_refresh_loop)
        self._spawn("maintenance", self._maintenance_loop)
        for cid in self.metas:
            self._spawn(f"quote:{cid[:8]}", lambda c=cid: self._quoter(c))
        self._spawn("supervisor", self._supervise)
        self.risk.reset_day()
        log.info("engine_started", markets=len(self.metas), paper=self.paper)

    def _spawn(self, name: str, factory: Any) -> None:
        self._task_specs[name] = factory
        self._tasks[name] = asyncio.create_task(factory(), name=name)

    _supervise_interval_s: float = 5.0
    # how long a market's book may stay unusable before we pull its quotes, when we
    # are NOT halted/blind (e.g. a sweep cleared one side)
    _bad_book_pull_after_s: float = 3.0

    async def _supervise(self) -> None:
        """Restart any engine task that exits while we're running. Never down."""
        while self._running:
            await asyncio.sleep(self._supervise_interval_s)
            for name, task in list(self._tasks.items()):
                if name == "supervisor" or not task.done():
                    continue
                if not self._running:
                    return
                exc = None
                with contextlib.suppress(asyncio.CancelledError, asyncio.InvalidStateError):
                    exc = task.exception()
                log.critical("task_died_restarting", task=name, err=str(exc) if exc else "exited")
                self.alerter.alert("task_died", f"{name} died: {exc}", critical=True)
                self._tasks[name] = asyncio.create_task(self._task_specs[name](), name=name)

    async def run_forever(self) -> None:
        await self.start()
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.gather(*self._tasks.values(), *self._aux_tasks)

    async def shutdown(self) -> None:
        self._running = False
        log.info("engine_shutdown")
        self.md.stop()
        if self.user:
            self.user.stop()
        tasks = [*self._tasks.values(), *self._aux_tasks]
        for t in tasks:
            t.cancel()
        # AWAIT the cancellations: without this a place() POST may still be in flight
        # when cancel_all() returns, so the order can land afterwards and survive as a
        # live, untracked order at exit.
        for t in tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await t
        # Drain the blocking client pool for the same reason, but BOUNDED: a hung
        # client call must not stop us from reaching cancel_all, which is the step
        # that actually protects the account.
        with contextlib.suppress(Exception, asyncio.TimeoutError):
            await asyncio.wait_for(asyncio.to_thread(self.gateway.drain), timeout=10.0)
        with contextlib.suppress(Exception):
            await self.gateway.cancel_all()
        self.gateway.close()
        self.journal.close()
        self.state.close()
        self.catalog.close()

    # ── market resolution ───────────────────────────────────────────────
    async def _resolve_markets(self) -> None:
        """Resolve every configured market, always re-reading Gamma for the live row.

        The catalog is a scan cache, not a source of truth: it stores whatever the last
        `scan` saw, which can be weeks old. Only Gamma is authoritative for `version`,
        and `version` decides which identifier we trade and which ledger holds the
        shares — so a stale cached row could make us quote a dead id. The cache is
        therefore used only as a fallback when Gamma cannot be reached.
        """
        reward_rates: dict[str, float] | None = None
        async with GammaClient(self.cfg.wallet.gamma_host) as gamma:
            for entry in self.cfg.enabled_markets:
                if reward_rates is None:
                    reward_rates = await fetch_reward_rates(self.cfg.wallet.clob_host)
                raw = await self._live_market(gamma, entry.slug, entry.condition_id)
                meta = parse_market(raw, reward_rates) if raw else None
                if meta is not None:
                    self.catalog.upsert_market(meta)
                else:
                    cached = self._cached_meta(entry)
                    if cached is not None:
                        log.warning("market_using_stale_cache", ref=entry.ref,
                                    scanned_age_s=round(time.time() - cached.scanned_ts, 1),
                                    version=cached.version.value,
                                    note="Gamma row unavailable/unsupported; version may be stale")
                        meta = cached
                if meta is None:
                    log.warning("market_unresolved", ref=entry.ref)
                    continue
                self._register_market(meta, entry)

    def _cached_meta(self, entry: MarketEntry) -> MarketMeta | None:
        if entry.slug:
            cached = self.catalog.get_by_slug(entry.slug)
            if cached is not None:
                return cached
        return self.catalog.get(entry.condition_id) if entry.condition_id else None

    def _register_market(self, meta: MarketMeta, entry: MarketEntry) -> None:
        self.metas[meta.condition_id] = meta
        self.profiles[meta.condition_id] = self.cfg.profile_for(entry)
        self.est[meta.condition_id] = self._make_estimators(self.profiles[meta.condition_id])
        self.regime_m[meta.condition_id] = RegimeMachine()
        self._dirty[meta.condition_id] = asyncio.Event()
        self._locks[meta.condition_id] = asyncio.Lock()
        for tok in (meta.yes.token_id, meta.no.token_id):
            self._token_cid[tok] = meta.condition_id

    async def _live_market(
        self, gamma: GammaClient, slug: str | None, condition_id: str | None
    ) -> dict[str, Any] | None:
        """Direct Gamma row for a configured market, or None if not obtainable."""
        if slug:
            raw = await gamma.market_by_slug(slug)
            if raw is not None:
                return raw
        if condition_id:
            return await gamma.market_by_condition_id(condition_id)
        return None

    async def _fetch_meta(
        self, gamma: GammaClient, slug: str | None, condition_id: str | None,
        reward_rates: dict[str, float],
    ) -> MarketMeta | None:
        raw = await self._live_market(gamma, slug, condition_id)
        if raw is not None:
            meta = parse_market(raw, reward_rates)
            if meta is not None:
                self.catalog.upsert_market(meta)
            return meta
        # Fall back to a tag-scoped sweep (covers markets Gamma won't return by slug).
        tag_id = self.catalog.cached_tag("politics")
        if tag_id is None:  # cold start: resolve + cache so the sweep is scoped
            tag_id = await gamma.resolve_tag_id("politics")
            if tag_id:
                self.catalog.cache_tag("politics", tag_id)
        async for raw in gamma.iter_markets(tag_id=tag_id, max_pages=25):
            if (slug and raw.get("slug") == slug) or (condition_id and raw.get("conditionId") == condition_id):
                m = parse_market(raw, reward_rates)
                if m:
                    self.catalog.upsert_market(m)
                return m
        return None

    @staticmethod
    def _make_estimators(p: StrategyProfile) -> MarketEstimators:
        return MarketEstimators(
            vol=VolEstimator(p.vol_short_halflife_s, p.vol_long_halflife_s),
            flow=FlowEstimator(p.flow_ewma_halflife_s),
            markout=MarkoutTracker(),
        )

    async def _startup_reconcile(self) -> None:
        with contextlib.suppress(Exception):
            await self.gateway.cancel_all()  # clean slate; heartbeat covers crashes
        # cancel-all may have partially failed — verify no orders remain, and
        # cancel/adopt any stragglers so we never quote on top of an unknown order
        with contextlib.suppress(Exception):
            leftover = await self.gateway.open_orders()
            if leftover is None:
                log.warning("startup_orders_unreadable")
            elif leftover:
                log.warning("startup_orders_remain", n=len(leftover))
                for tok in {o.token_id for o in leftover}:
                    await self.gateway.cancel_asset(tok)
                still = await self.gateway.open_orders()
                if still is None:
                    # Cannot confirm the wipe -> do not clobber local order state.
                    log.error("startup_orders_recheck_failed")
                    raise RuntimeError("open-orders recheck failed")
                for tok in self._token_cid:
                    self.state.replace_open_orders(
                        tok, [o for o in still if o.token_id == tok], grace_s=0.0
                    )
                if still:
                    log.error("startup_orders_stuck", n=len(still))
                    self.alerter.alert("startup_orders_stuck",
                                       f"{len(still)} orders survived cancel-all", critical=True)
        # purge positions that leaked in for markets we don't trade (manual UI
        # bets etc.) so they can't distort exposure caps or PnL
        self.state.drop_untracked_positions(set(self._token_cid))
        read = await self.gateway.positions()
        if read is None:
            # A failed read must never be mistaken for "we are flat": leave the
            # persisted state untouched and let the next reconcile retry.
            log.warning("startup_positions_unreadable")
            return
        positions = self._only_traded(read)
        if positions:
            self.state.reconcile_positions(positions)
            log.info("startup_positions", n=len(positions))
        self._seed_position_clocks()

    def _token_versions(self, tokens: list[str]) -> dict[str, ProtocolVersion]:
        """Map our traded token ids to their market's protocol version, so ledger
        reads are routed to the correct ERC-1155 contract."""
        out: dict[str, ProtocolVersion] = {}
        for tok in tokens:
            cid = self._token_cid.get(tok)
            meta = self.metas.get(cid) if cid else None
            if meta is not None:
                out[tok] = meta.version
        return out

    def _only_traded(self, positions: dict[str, tuple[float, float]]) -> dict[str, tuple[float, float]]:
        """Scope account positions to tokens WE trade. Manual/UI positions in
        other markets are the operator's business — they must not enter our
        state, exposure caps, or PnL."""
        return {t: v for t, v in positions.items() if t in self._token_cid}

    # ── callbacks ───────────────────────────────────────────────────────
    def _on_dirty(self, condition_id: str, token_id: str) -> None:
        ev = self._dirty.get(condition_id)
        if ev is not None:
            ev.set()

    def _wake_cid(self, condition_id: str) -> None:
        ev = self._dirty.get(condition_id)
        if ev is not None:
            ev.set()

    def _wake_all(self) -> None:
        for ev in self._dirty.values():
            ev.set()

    def _on_user_reconnect(self) -> None:
        """User WS reconnected: events during the gap were lost — force an
        immediate REST reconcile before trusting our state again."""
        log.warning("user_ws_reconnected_forcing_reconcile")
        self._reconcile_now.set()

    def _on_trade(self, tp: TradePrint) -> None:
        cid = self._token_cid.get(tp.asset_id)
        if cid is None:
            return
        p = self.profiles[cid]
        self.est[cid].flow.update(tp.aggressor, tp.size, tp.ts)
        # A trade only flags a SWEEP (-> pull quotes) if it's genuinely toxic:
        # large in absolute terms AND large relative to the resting depth it
        # consumed (i.e. it actually ate through the book). A big trade absorbed
        # by a deep book doesn't move the price and isn't toxic — for a liquid
        # market the FV-jump detector is the real event signal. event_sweep_mult
        # sets how many order-sizes big the print must be to even be considered.
        base = p.base_size_usdc / max(tp.price, 0.01)
        if tp.size < p.event_sweep_mult * base:
            return
        book = self.md.book(tp.asset_id)
        if book is None:
            return
        bb, ba = book.best_bid(), book.best_ask()
        if bb is None or ba is None:
            return
        # aggressor BUY lifts asks; SELL hits bids — measure the side it consumed
        if tp.aggressor is Side.BUY:
            consumed = book.depth_within(Side.SELL, ba.price, ba.price + 3 * book.tick_size)
        else:
            consumed = book.depth_within(Side.BUY, bb.price - 3 * book.tick_size, bb.price)
        if consumed > 0 and tp.size >= p.event_sweep_frac * consumed:
            self._sweep[cid] = True

    def _on_fill(self, fill: Fill) -> None:
        # Scope BOTH the cash ledger and the inventory clock to markets we actually
        # quote. `note_fill` used to run before this check, so a manual UI trade the
        # operator made in a market we quote would move our net_cash and inventory
        # basis — and because equity is derived from net_cash, a withdrawal could
        # then look like a trading loss and trip the daily-loss kill switch.
        cid = self._token_cid.get(fill.token_id)
        if cid is None:
            log.debug("fill_ignored_untracked", token=fill.token_id[:12],
                      side=fill.side.value, size=fill.size)
            return
        self.risk.note_fill(fill)
        if fill.side is Side.BUY and fill.size > 0:
            # start the hold clock for exit urgency (an exit that never becomes
            # urgent is an exit that never happens)
            self._position_since.setdefault(fill.token_id, fill.ts)
        elif fill.side is Side.SELL:
            self._position_since.pop(fill.token_id, None)
        cid = self._token_cid.get(fill.token_id)
        if cid is None:
            return
        est = self.est[cid]
        fv = est.last_fv if est.last_fv is not None else fill.price
        token_fv = fv if fill.token_id == self.metas[cid].yes.token_id else (1.0 - fv)
        # Record in the FILLED token's price space and remember which token it was,
        # so the mark can later be resolved in that same space (see _token_fv).
        est.markout.record_fill(fill.side, token_fv, fill.ts, fill.token_id)

    def _seed_position_clocks(self, now: float | None = None) -> None:
        """Start the hold clock for inventory we did not buy in this process.

        `_position_since` is otherwise written only by live fills, so after a restart
        with a bag every `held_s` was 0, exit urgency stayed 0, and the exits rested
        above the market forever — the exact failure urgency exists to prevent.
        """
        ts = time.time() if now is None else now
        for token_id, pos in self.state.positions.items():
            if pos.size > 0 and token_id not in self._position_since:
                self._position_since[token_id] = ts

    def _sync_position_clock(self, token_id: str, size: float, now: float | None = None) -> None:
        """Keep the hold clock consistent with the current holding."""
        ts = time.time() if now is None else now
        if size > 0:
            self._position_since.setdefault(token_id, ts)
        else:
            self._position_since.pop(token_id, None)

    def _token_fv(self, yes_fv: float, token_id: str, cid: str | None = None) -> float:
        """Convert a YES-space fair value into `token_id`'s own price space.

        YES and NO are complementary (NO = 1 - YES), and every per-token estimator
        (markout, exit pricing) must stay in one consistent space.
        """
        resolved = cid or self._token_cid.get(token_id)
        meta = self.metas.get(resolved) if resolved else None
        if meta is None or token_id == meta.yes.token_id:
            return yes_fv
        return 1.0 - yes_fv

    # ── quoter ──────────────────────────────────────────────────────────
    async def _quoter(self, cid: str) -> None:
        debounce = self.cfg.engine.debounce_ms / 1000.0
        base_tick = self.cfg.engine.quoter_tick_s
        ev = self._dirty[cid]
        while self._running:
            try:
                # Book/fill events wake us instantly. Otherwise we refresh on a
                # slow baseline tick, EXCEPT: if an EVENT cool-off is active,
                # wake precisely when it ends (re-enter promptly, not up to a
                # minute late); if we're holding inventory, tick faster to walk
                # exit urgency.
                timeout = self._next_wake_s(cid, base_tick)
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(ev.wait(), timeout=timeout)
                if ev.is_set():
                    await asyncio.sleep(debounce)  # coalesce a burst of updates
                ev.clear()
                await self._recompute(cid)
            except asyncio.CancelledError:
                break
            except Exception as exc:  # noqa: BLE001
                log.error("quoter_error", cid=cid[:8], err=str(exc))
                await asyncio.sleep(0.5)

    def _next_wake_s(self, cid: str, base_tick: float) -> float:
        now = time.time()
        wake = base_tick
        rm = self.regime_m.get(cid)
        if rm is not None:
            cd = rm.cooloff_remaining(now)
            if cd > 0:
                wake = min(wake, cd + 0.5)  # re-enter right when cool-off ends
        meta = self.metas.get(cid)
        if meta is not None:  # holding inventory -> tick faster to manage exits
            held = self.state.position(meta.yes.token_id).size + self.state.position(meta.no.token_id).size
            if held >= meta.min_order_size:
                wake = min(wake, 10.0)
        return max(1.0, wake)

    def _blind_state(self, cid: str, now: float) -> tuple[bool, bool, bool, bool, bool]:
        """(blind, market_stale, user_blind, hb_blind, halted) for one market.

        Shared by the quote path and the "book unusable" path so a halt is enforced
        even when we cannot compute fair value.
        """
        market_stale = (
            not self.md.connected
            and self.md.disconnected_since > 0.0
            and (now - self.md.disconnected_since) > self.cfg.risk.ws_stale_halt_s
        )
        user_blind = (
            self._user_started
            and self.user is not None
            and not self.user.connected
            and (now - self.user.disconnected_since) > self.cfg.risk.user_ws_blind_halt_s
        )
        hb_blind = (
            not self.paper
            and self.cfg.engine.heartbeat
            and self.gateway.heartbeat_failures >= self.cfg.risk.heartbeat_halt_failures
        )
        halted = cid in self._halted
        return (market_stale or user_blind or hb_blind or halted,
                market_stale, user_blind, hb_blind, halted)

    async def _halted_or_blind(self, cid: str) -> bool:
        blind, _, _, _, _ = self._blind_state(cid, time.time())
        if blind:
            return True
        halted, _ = self.risk.global_halt()
        return halted

    async def _recompute(self, cid: str) -> None:
        lock = self._locks.get(cid)
        if lock is None:
            return
        async with lock:  # serialize vs the reconcile loop mutating this market
            await self._recompute_locked(cid)

    async def _maybe_pull_on_bad_book(self, cid: str, reason: str) -> None:
        """Pull resting quotes when the book is unusable for longer than a grace.

        A sweep that clears one side of the book leaves it "unusable" (one-sided) while
        the WS link stays healthy, so `_halted_or_blind` is false and the old path left
        every previous quote resting — exposed to exactly the flow that just swept it.
        A short grace avoids churn on a transient crossed/dusty book.
        """
        now = time.time()
        if await self._halted_or_blind(cid):
            self._book_unusable_since.pop(cid, None)
            await self._pull_all_quotes(cid, reason)
            return
        since = self._book_unusable_since.setdefault(cid, now)
        if now - since >= self._bad_book_pull_after_s:
            await self._pull_all_quotes(cid, reason)
            # consume the sweep flag so a stale sweep cannot linger
            self._sweep.pop(cid, None)

    async def _pull_all_quotes(self, cid: str, reason: str) -> None:
        """Cancel every resting order for a market, regardless of book state.

        A halt must be enforced even when the book is unusable. Previously a
        one-sided/empty/crossed book caused an early return BEFORE the risk and
        reconcile steps, so a sweep that cleared the bid side left every previous
        quote resting with no risk check and no way to enforce HALTED.
        """
        meta = self.metas.get(cid)
        if meta is None:
            return
        live = self.state.orders_for(meta.yes.token_id) + self.state.orders_for(meta.no.token_id)
        if not live:
            return
        log.warning("quotes_pulled", cid=cid[:8], reason=reason, n=len(live))
        ok = await self.gateway.cancel([o.order_id for o in live])
        if ok:
            for o in live:
                self.state.remove_order(o.order_id)

    async def _recompute_locked(self, cid: str) -> None:
        meta = self.metas[cid]
        p = self.profiles[cid]
        yes_book = self.md.book(meta.yes.token_id)
        no_book = self.md.book(meta.no.token_id)

        # An unusable book (missing, one-sided, crossed/locked) means fair value is
        # unreliable, so we cannot quote — but we must still enforce any halt and pull
        # resting orders rather than leaving them exposed to the flow that broke it.
        if yes_book is None or yes_book.is_empty:
            await self._maybe_pull_on_bad_book(cid, "book_unusable")
            return

        bb, ba = yes_book.best_bid(), yes_book.best_ask()
        if bb is None or ba is None or bb.price >= ba.price:
            await self._maybe_pull_on_bad_book(cid, "book_crossed")
            return

        now = time.time()
        micro = yes_book.microprice(p.micro_levels)
        if micro is None:
            await self._maybe_pull_on_bad_book(cid, "no_microprice")
            return
        self._book_unusable_since.pop(cid, None)  # book is healthy again
        est = self.est[cid]
        est.flow.decay_to(now)
        fv = compute_fair_value(micro, est.flow.z, meta.tick_size)
        prev_fv = est.last_fv
        est.on_fair_value(fv, now, yes_token_id=meta.yes.token_id,
                          token_in_yes_space=self._token_fv)

        self.risk.update_mark(meta.yes.token_id, fv)
        self.risk.update_mark(meta.no.token_id, 1.0 - fv)

        pos_yes = self.state.position(meta.yes.token_id)
        pos_no = self.state.position(meta.no.token_id)
        q_max = p.q_max_usdc
        inv_util = abs(pos_yes.size - pos_no.size) * fv / q_max if q_max > 0 else 0.0
        hours_to_end = _hours_to_end(meta.end_date_iso, now)

        # ── blind/stale conditions ──────────────────────────────────────────
        # A QUIET market with a live WS link is NOT stale — the CLOB WS pings
        # every 5s (pong-timeout 10s), so a dead link flips `connected` within
        # ~15s. Gating on the connection (not book-mutation recency) stops a
        # legitimately-quiet thin market from false-halting into zero rewards.
        blind, market_stale, user_blind, hb_blind, halted = self._blind_state(cid, now)
        if blind:
            log.warning("market_blind", cid=cid[:8], market_stale=market_stale,
                        user_blind=user_blind, hb_blind=hb_blind, halted=halted)
            self.alerter.alert(
                f"blind:{cid[:8]}",
                f"{meta.question[:40]} blind (stale={market_stale} user={user_blind} "
                f"hb={hb_blind} halted={halted})",
                critical=hb_blind,
            )

        # Resting BUY orders are committed capital: count them against the caps, or a
        # full stack of bids can fill on an account the caps believed was empty. The
        # GLOBAL cap needs every market's resting bids, not just this one's, or N
        # markets can each pass while committing N x the cap.
        all_tokens = {t for m in self.metas.values() for t in (m.yes.token_id, m.no.token_id)}
        all_orders = [o for t in all_tokens for o in self.state.orders_for(t)]
        resting = resting_buy_notional(
            self.state.orders_for(meta.yes.token_id) + self.state.orders_for(meta.no.token_id),
            {meta.yes.token_id, meta.no.token_id},
        )
        rd = self.risk.evaluate(meta, ws_stale=blind,
                                event_group_cost=self._event_group_cost(meta),
                                resting_buy_notional=resting,
                                global_resting_buy_notional=resting_buy_notional(
                                    all_orders, all_tokens))
        if rd.halt and rd.reason not in ("ws_stale",):
            self.alerter.alert(
                f"risk_halt:{rd.reason}", f"risk halt: {rd.reason}",
                critical=any(k in rd.reason for k in ("daily_loss", "kill", "error_rate")),
            )
        ws_stale = blind
        regime = self.regime_m[cid].decide(
            RegimeInputs(
                now=now, tick=meta.tick_size, fv=fv, prev_fv=prev_fv,
                vol_ratio=est.vol.ratio, flow_z=est.flow.z, inventory_util=inv_util,
                hours_to_end=hours_to_end, sweep_flagged=self._sweep.pop(cid, False),
                ws_stale=ws_stale, risk_halt=rd.halt, risk_reduce_only=rd.reduce_only,
            ),
            p,
        )

        # Exit urgency was previously never populated, so every exit rested at
        # fv + delta — ABOVE the market — and inventory only unwound if price
        # happened to rally to us. Derive it from how long we have held, and force
        # it to the maximum when a halt/reduce means we want OUT rather than more
        # quotes.
        held_yes_s = now - self._position_since.get(meta.yes.token_id, now)
        held_no_s = now - self._position_since.get(meta.no.token_id, now)
        force_exit = rd.halt or rd.reduce_only
        tq = construct_quotes(QuoteInputs(
            meta=meta, regime=regime, fv=fv, vol_short=est.vol.short,
            toxicity=est.markout.toxicity, yes_view=yes_book.view(),
            no_view=(no_book.view() if no_book else _empty_view()),
            pos_yes=pos_yes, pos_no=pos_no, profile=p, now=now,
            risk_size_scale=rd.size_scale,
            mid_price=micro,
            yes_exit_urgency=1.0 if force_exit else exit_urgency(held_yes_s, p.exit_urgency_s),
            no_exit_urgency=1.0 if force_exit else exit_urgency(held_no_s, p.exit_urgency_s),
        ))

        # A leg can be declined for being too small to score (below the reward floor)
        # or because no price both scores and respects the required edge. Either way it
        # earns nothing, so surface it: a one-sided quote forfeits two-sided reward
        # eligibility and the operator should know before wondering where income went.
        want = {meta.yes.token_id, meta.no.token_id}
        got = {q.token_id for q in tq.quotes if q.side is Side.BUY}
        if want - got:
            log.warning("entry_leg_declined", cid=cid[:8], regime=regime.value,
                        missing=sorted(t[:12] for t in (want - got)),
                        note="below reward floor / band cannot fit the required edge")

        live = self.state.orders_for(meta.yes.token_id) + self.state.orders_for(meta.no.token_id)
        plan = reconcile(tq, live, tick=meta.tick_size,
                         reprice_ticks=p.reprice_ticks, resize_frac=p.resize_frac)
        if plan.is_noop:
            self._maybe_merge(cid, meta, p, pos_yes.size, pos_no.size)
            return

        if plan.to_cancel:
            ok = await self.gateway.cancel(plan.to_cancel)
            if ok:
                for oid in plan.to_cancel:
                    self.state.remove_order(oid)
            else:
                # cancel MAY have partially applied server-side — keep our view,
                # resync from REST, and skip placing this cycle (avoid doubles)
                await self._refresh_token_orders(meta, grace_s=10.0)
                self._dirty[cid].set()
                return
        placed_n = 0
        if plan.to_place:
            # LOAD SHED: under rate-budget pressure, skip *new* quotes in calm
            # regimes (cancels/exits above already ran) so we don't inject latency
            # right when the book is busy. Risk regimes always place.
            shed = (
                not self.paper
                and self.gateway.order_pressure > 0.85
                and regime in (Regime.QUIET, Regime.TRENDING)
            )
            if shed:
                log.warning("shed_load", cid=cid[:8], pressure=round(self.gateway.order_pressure, 2))
                self._dirty[cid].set()  # retry soon
            else:
                placed = await self.gateway.place(plan.to_place, meta)
                placed_n = len(placed)
                self.risk.note_order_result(len(placed) == len(plan.to_place))
                for o in placed:
                    self.state.upsert_order(o)
                if len(placed) < len(plan.to_place):
                    # QUARANTINE: a failed/partial batch may still have posted
                    # orders we don't have ids for. Cancel everything on these
                    # tokens (idempotent) and resync — never risk an untracked order.
                    await self._quarantine(meta, reason="place_incomplete")
        self._last_quote_fv[cid] = fv
        log.info("requote", cid=cid[:8], regime=regime.value, fv=round(fv, 4),
                 place=placed_n, cancel=len(plan.to_cancel),
                 pos_yes=round(pos_yes.size, 1), pos_no=round(pos_no.size, 1),
                 tox=round(est.markout.toxicity, 3), flowz=round(est.flow.z, 2))
        self._maybe_merge(cid, meta, p, pos_yes.size, pos_no.size)

    async def _quarantine(self, meta: MarketMeta, reason: str) -> None:
        """Cancel all orders on a market's tokens and resync state from REST."""
        log.warning("quarantine", cid=meta.condition_id[:8], reason=reason)
        for tok in (meta.yes.token_id, meta.no.token_id):
            await self.gateway.cancel_asset(tok)
            for o in self.state.orders_for(tok):
                self.state.remove_order(o.order_id)
        await self._refresh_token_orders(meta)

    async def _refresh_token_orders(self, meta: MarketMeta, grace_s: float = 0.0) -> bool:
        """Open-orders resync for one market's tokens (grace_s=0 = authoritative).

        Returns False without touching local state when the read failed: a failed
        read must never wipe orders we believe are live, or the reconciler will
        re-place them as duplicates.
        """
        live = await self.gateway.open_orders()
        if live is None:
            log.warning("order_resync_skipped", cid=meta.condition_id[:8],
                        reason="open_orders_unreadable")
            return False
        for tok in (meta.yes.token_id, meta.no.token_id):
            self.state.replace_open_orders(
                tok, [o for o in live if o.token_id == tok], grace_s=grace_s
            )
        return True

    def _maybe_merge(self, cid: str, meta: MarketMeta, p: StrategyProfile,
                     yes_size: float, no_size: float) -> None:
        amount = min(yes_size, no_size)
        if amount < p.merge_min_size or cid in self._merging or self.paper:
            return
        self._merging.add(cid)
        self._aux_tasks.append(asyncio.create_task(self._merge_task(cid, meta, amount)))

    async def _merge_task(self, cid: str, meta: MarketMeta, amount: float) -> None:
        try:
            # serialize all on-chain txs so concurrent merges can't reuse a nonce;
            # read on-chain balances as source of truth for the mergeable amount
            async with self._chain_lock:
                # route the ledger read by protocol version: V2 shares live in
                # PositionManager, so reading CTF would return a flat 0 and abort.
                bals = await self.gateway.token_balances(
                    {meta.yes.token_id: meta.version, meta.no.token_id: meta.version}
                )
                if bals is None:
                    # unreadable -> do NOT assume flat; skip rather than merge blind
                    log.warning("merge_skipped_balances_unreadable", cid=cid[:8])
                    return
                amount = min(amount, bals.get(meta.yes.token_id, 0.0),
                             bals.get(meta.no.token_id, 0.0))
                raw = int(amount * 1e6)
                if raw <= 0:
                    return
                tx = await asyncio.to_thread(
                    self.merger.merge, meta.condition_id, raw, meta.neg_risk,
                    meta.version, meta.yes.token_id,
                )
                if tx is None:
                    # Two distinct silent failures used to hide here: the merge did
                    # nothing because it cannot run at all (missing builder creds for
                    # a DepositWallet), or it tried and failed. Both leave inventory
                    # stuck, so report with the right cause instead of staying quiet.
                    if not self.merger.can_merge:
                        log.error("merge_unavailable", cid=cid[:8],
                                  signature_type=self.cfg.wallet.signature_type,
                                  hint="DepositWallet merges need POLY_BUILDER_* creds")
                        self.alerter.alert(
                            f"merge_unavailable:{cid[:8]}",
                            f"cannot merge on {meta.slug[:32]}: signature_type="
                            f"{self.cfg.wallet.signature_type} requires builder "
                            f"credentials ({amount:.1f} pairs stuck)",
                        )
                    else:
                        log.error("merge_returned_none", cid=cid[:8], amount=raw,
                                  version=meta.version.value)
                        self.alerter.alert(
                            f"merge_failed:{cid[:8]}",
                            f"merge of {amount:.1f} pairs on {meta.slug[:32]} returned no tx",
                        )
        finally:
            self._merging.discard(cid)

    # ── background loops ────────────────────────────────────────────────
    async def _heartbeat_loop(self) -> None:
        if not self.cfg.engine.heartbeat:
            return
        halt_after = self.cfg.risk.heartbeat_halt_failures
        while self._running:
            ok = await self.gateway.heartbeat()
            if not ok and self.gateway.heartbeat_failures >= halt_after and not self._hb_was_down:
                # exchange is (or soon will be) auto-cancelling everything we
                # have live; recompute will see hb_blind and pull quotes
                self._hb_was_down = True
                log.critical("heartbeat_down_halting", failures=self.gateway.heartbeat_failures)
                self._wake_all()
            elif ok and self._hb_was_down:
                self._hb_was_down = False
                log.warning("heartbeat_recovered_resyncing")
                # Read BEFORE clearing. The dead-man switch normally means the exchange
                # already cancelled everything, but a local-only heartbeat gap leaves
                # real orders resting. Clearing first and then failing the read (the
                # same network blip can cause both) would empty local state while
                # orders are still live, and the quoter would re-place them.
                authoritative = True
                for cid, meta in self.metas.items():
                    lock = self._locks.get(cid)
                    if lock is None:
                        continue
                    # Take the market lock: the quoter may be mid-place(), and a
                    # snapshot taken before that placement would drop the just-placed
                    # orders and cause duplicates.
                    async with lock:
                        with contextlib.suppress(Exception):
                            if not await self._refresh_token_orders(meta, grace_s=0.0):
                                authoritative = False
                if not authoritative:
                    # Could not confirm the server state -> keep whatever we have and
                    # let the next reconcile retry, rather than risk duplicates.
                    log.error("heartbeat_recovery_read_failed_keeping_state")
                else:
                    # Drop local orders that the authoritative snapshot did not list.
                    live_ids = {
                        o.order_id
                        for tok in self._token_cid
                        for o in self.state.orders_for(tok)
                    }
                    log.info("heartbeat_recovery_resynced", orders=len(live_ids))
                self._wake_all()
            await asyncio.sleep(self.cfg.engine.heartbeat_interval_s)

    async def _reconcile_loop(self) -> None:
        rounds = 0
        while self._running:
            # periodic cadence, but wake immediately when a reconnect/recovery
            # demands an urgent resync
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(
                    self._reconcile_now.wait(),
                    timeout=self.cfg.engine.reconcile_interval_s,
                )
            forced = self._reconcile_now.is_set()
            self._reconcile_now.clear()
            rounds += 1
            try:
                # a MATCHED whose settlement event was lost would block a token's
                # reconciliation forever — expire stale in-flight guards first
                expired = self.state.expire_inflight(self.cfg.engine.reconcile_interval_s * 2)
                if expired:
                    self.alerter.alert("inflight_expired",
                                       f"{len(expired)} stuck in-flight guards cleared")

                read = await self.gateway.positions()
                if read is not None:
                    # Authoritative: this read lists the funder's open positions, so
                    # one we track that is absent has genuinely closed (merge, redeem
                    # or a manual sell) and must be zeroed rather than kept forever.
                    zeroed = self.state.reconcile_positions(
                        self._only_traded(read), authoritative=True
                    )
                    if zeroed:
                        self.alerter.alert(
                            "position_closed_elsewhere",
                            f"{len(zeroed)} tracked position(s) disappeared from the API; zeroed",
                        )
                        for tok in zeroed:
                            cid = self._token_cid.get(tok)
                            if cid:
                                self._wake_cid(cid)
                else:
                    # unreadable -> do NOT treat as flat; open orders below still
                    # reconcile, and positions stay as last known-good.
                    log.warning("positions_unreadable_reconcile")
                live = await self.gateway.open_orders()
                if live is None:
                    # Unreadable snapshot: keep local order state as-is. Wiping it
                    # here would make the quoter re-place every quote as a duplicate.
                    log.warning("open_orders_unreadable_reconcile")
                else:
                    by_token: dict[str, list[Any]] = {}
                    for o in live:
                        by_token.setdefault(o.token_id, []).append(o)
                    # iterate ALL our tokens, not just those in the REST response — a
                    # token whose orders vanished server-side must be cleaned up too.
                    # Hold the market lock so we don't race the quoter mid-flight.
                    for cid, meta in self.metas.items():
                        lock = self._locks.get(cid)
                        if lock is None:
                            continue
                        async with lock:
                            for tok in (meta.yes.token_id, meta.no.token_id):
                                if self.state.inflight(tok) == 0:
                                    self.state.replace_open_orders(tok, by_token.get(tok, []))
                if forced:
                    log.info("forced_reconcile_done",
                             positions=(-1 if read is None else len(read)),
                             open_orders=(-1 if live is None else len(live)))
                    self._wake_all()
            except Exception as exc:  # noqa: BLE001
                log.warning("reconcile_error", err=str(exc))

            # slower loops: on-chain position divergence + pnl snapshot + WAL
            if rounds % 4 == 0:
                with contextlib.suppress(Exception):
                    await self._check_position_divergence()
                with contextlib.suppress(Exception):
                    await self._reconcile_cash()
            self.state.record_pnl(self.risk.equity, self.risk.net_cash,
                                  self.risk.inventory_value, self.risk.daily_pnl)
            if rounds % 20 == 0:
                # re-baseline the daily loss window on a UTC day change; without this
                # `daily_pnl` was lifetime PnL and the $ cap was really a since-start cap
                if _utc_day_changed(self._last_day_reset):
                    self.risk.reset_day()
                    self._last_day_reset = time.time()
                self.state.checkpoint_wal()

    async def _check_position_divergence(self) -> None:
        """Compare internal positions to on-chain truth; alert + correct on drift.

        Catches subtle fill-attribution bugs before they compound. On-chain is
        authoritative (it's what the exchange settles), so we correct to it —
        but only for tokens with no in-flight trades (optimistic state is newer).

        Safety: this function OVERWRITES internal state from chain, so it must never
        act on a failed or partial read. `token_balances` returns None when every RPC
        failed and routes each token to the ledger owning its protocol version; a
        read against the wrong ledger would look like a legitimate "0 shares" and
        would zero out real inventory.
        """
        tokens = [t for t in self._token_cid if self.state.inflight(t) == 0]
        versions = self._token_versions(tokens)
        if not versions:
            return
        onchain = await self.gateway.token_balances(versions)
        if onchain is None:
            log.warning("divergence_check_skipped", reason="balances_unreadable",
                        n=len(versions))
            return
        for tok, chain_size in onchain.items():
            internal = self.state.position(tok).size
            if abs(internal - chain_size) > max(1.0, 0.02 * chain_size):
                log.error("position_divergence", token=tok[:12],
                          internal=round(internal, 2), onchain=round(chain_size, 2),
                          version=versions.get(tok, ProtocolVersion.V1).value)
                self.alerter.alert(
                    f"divergence:{tok[:8]}",
                    f"position drift: internal {internal:.1f} vs on-chain {chain_size:.1f}",
                    critical=True,
                )
                self.state.force_set_position(tok, chain_size, self.state.position(tok).avg_price,
                                              source="onchain")
                cid = self._token_cid.get(tok)
                if cid:
                    self._wake_cid(cid)

    async def _reconcile_cash(self) -> None:
        """Snap the cash ledger to the exchange's real pUSD balance.

        `net_cash` only ever moves on fills, so deposits and withdrawals are invisible
        to equity — a withdrawal is indistinguishable from a trading loss and could
        trip the daily-loss kill switch on money that was never lost. We also cannot
        see manual UI trades that touch the same funder, which is the other source of
        drift. Rather than guess the cause, reconcile to reality and surface the size
        of the adjustment.
        """
        if self.paper or self.gateway.paper:
            return
        exchange_cash = await self.gateway.collateral_balance()
        if exchange_cash is None:
            log.debug("cash_reconcile_skipped", reason="balance_unreadable")
            return
        delta = self.risk.reconcile_cash(exchange_cash, self.risk.inventory_value)
        if delta:
            self.alerter.alert(
                "cash_reconciled",
                f"cash ledger adjusted by {delta:+.2f} pUSD (deposit/withdrawal or "
                f"unattributed fill); cumulative {self.risk.cash_adjustments:+.2f}",
            )

    async def refresh_market_metadata(self) -> None:
        """Pull fresh metadata from Gamma for all traded markets: halt on
        closed/not-accepting, and freshen reward/fee/end-date params so we quote
        at the CURRENT reward minimum, band, and fees (these change over time —
        e.g. the reward min-size jumping 50->100 shares). Called at startup and
        periodically. Safe to await."""
        if not self.metas:
            return
        try:
            async with GammaClient(self.cfg.wallet.gamma_host) as gamma:
                raws = await gamma.markets_by_condition(list(self.metas))
        except Exception as exc:  # noqa: BLE001
            log.warning("metadata_refresh_error", err=str(exc))
            return
        for cid, raw in raws.items():
            if cid not in self.metas:
                continue
            # A market whose protocol version changed has moved to a different id
            # space and ledger. Our subscribed ids and cached balances belong to the
            # old system, so halt for an operator restart instead of quoting ids that
            # now resolve to nothing.
            fresh_version = ProtocolVersion.parse(raw.get("version"))
            if fresh_version is not None and fresh_version is not self.metas[cid].version:
                if cid not in self._halted:
                    self._halted.add(cid)
                    log.critical("market_version_changed", cid=cid[:8],
                                 was=self.metas[cid].version.value,
                                 now=fresh_version.value)
                    self.alerter.alert(
                        f"version_changed:{cid[:8]}",
                        f"{self.metas[cid].question[:40]} moved "
                        f"{self.metas[cid].version.value} -> {fresh_version.value}; restart required",
                        critical=True,
                    )
                    meta = self.metas[cid]
                    for tok in (meta.yes.token_id, meta.no.token_id):
                        with contextlib.suppress(Exception):
                            await self.gateway.cancel_asset(tok)
                    self._wake_cid(cid)
                continue
            accepting = bool(raw.get("acceptingOrders", True))
            closed = bool(raw.get("closed", False))
            resolved = _is_resolved_raw(raw, self.metas[cid].version)
            if closed or not accepting or resolved:
                if cid not in self._halted:
                    self._halted.add(cid)
                    log.critical("market_halted_by_meta", cid=cid[:8], closed=closed,
                                 accepting=accepting, resolved=resolved)
                    self.alerter.alert(f"halted:{cid[:8]}",
                                       f"{self.metas[cid].question[:40]} closed/not-accepting/resolved",
                                       critical=True)
                    meta = self.metas[cid]
                    for tok in (meta.yes.token_id, meta.no.token_id):
                        with contextlib.suppress(Exception):
                            await self.gateway.cancel_asset(tok)
                    self._wake_cid(cid)
                continue
            self._halted.discard(cid)
            self._apply_meta_refresh(cid, raw)

    def _apply_meta_refresh(self, cid: str, raw: dict[str, Any]) -> None:
        import dataclasses

        old = self.metas[cid]
        fee = raw.get("feeSchedule") or {}
        rate = _fnum(fee.get("rate"))
        candidates: dict[str, Any] = {
            "rewards_min_size": _fnum(raw.get("rewardsMinSize")),
            "rewards_max_spread": _fnum(raw.get("rewardsMaxSpread")),
            "taker_fee_bps": int(round(rate * 10000)) if rate is not None else None,
            "rebate_rate": _fnum(fee.get("rebateRate")),
            "end_date_iso": raw.get("endDate"),
            "min_order_size": _fnum(raw.get("orderMinSize")),
            # tick size MUST be refreshed: Polymarket re-tickets a market as its
            # price approaches the extremes (0.001 -> 0.01). `meta.tick_size` is what
            # signs orders and snaps prices, so a stale value means every order goes
            # off-grid, gets rejected, and the batch failure triggers quarantine churn.
            "tick_size": _fnum(raw.get("orderPriceMinTickSize")),
        }
        updates = {k: v for k, v in candidates.items()
                   if v is not None and getattr(old, k) != v}
        if updates:
            self.metas[cid] = dataclasses.replace(old, **updates)
            log.info("meta_refreshed", cid=cid[:8], **updates)
            if "tick_size" in updates:
                # Resting orders were priced on the old grid; they must be repriced.
                log.warning("tick_size_changed_requoting", cid=cid[:8],
                            was=old.tick_size, now=updates["tick_size"])
                book = self.md.book(old.yes.token_id) if old.tokens else None
                if book is not None:
                    book.set_tick_size(updates["tick_size"])
            self._wake_cid(cid)

    async def _metadata_refresh_loop(self) -> None:
        while self._running:
            await asyncio.sleep(self.cfg.engine.catalog_refresh_s)
            await self.refresh_market_metadata()

    async def _maintenance_loop(self) -> None:
        """Periodic REST book refresh to catch any silently-missed WS deltas."""
        while self._running:
            await asyncio.sleep(120.0)
            for meta in list(self.metas.values()):
                for tok in (meta.yes.token_id, meta.no.token_id):
                    with contextlib.suppress(Exception):
                        await self._refresh_book(tok)

    async def _refresh_book(self, token_id: str) -> None:
        levels = await self.gateway.get_full_book(token_id)
        if levels is None:
            return
        bids, asks, book_hash = levels
        book = self.md.book(token_id)
        if book is None:
            return
        # drift check: only overwrite if the REST top-of-book disagrees with ours
        cur_bb = book.best_bid()
        cur_ba = book.best_ask()
        rest_bb = max((p for p, _ in bids), default=None)
        rest_ba = min((p for p, _ in asks), default=None)
        drift = (
            (cur_bb is None) != (rest_bb is None)
            or (cur_ba is None) != (rest_ba is None)
            or (cur_bb and rest_bb and abs(cur_bb.price - rest_bb) > book.tick_size)
            or (cur_ba and rest_ba and abs(cur_ba.price - rest_ba) > book.tick_size)
        )
        if drift:
            log.warning("book_drift_corrected", token=token_id[:12])
            book.apply_snapshot(bids, asks, time.time(), book_hash)
            cid = self._token_cid.get(token_id)
            if cid:
                self._wake_cid(cid)

    # ── helpers ─────────────────────────────────────────────────────────
    def _other_token(self, token_id: str) -> str | None:
        cid = self._token_cid.get(token_id)
        return self.metas[cid].other_token(token_id) if cid else None

    def _cid_of_token(self, token_id: str) -> str | None:
        return self._token_cid.get(token_id)

    def _event_group_cost(self, meta: MarketMeta) -> float:
        if not meta.event_id:
            return 0.0
        cost = 0.0
        for m in self.metas.values():
            if m.event_id == meta.event_id:
                for tok in (m.yes.token_id, m.no.token_id):
                    pos = self.state.position(tok)
                    cost += pos.size * pos.avg_price
        return cost


def _fnum(v: object) -> float | None:
    if v is None:
        return None
    try:
        return float(v)  # type: ignore[arg-type]
    except (ValueError, TypeError):
        return None


def _utc_day_changed(last_ts: float) -> bool:
    """True when `last_ts` falls on a different UTC calendar day than now."""
    from datetime import UTC, datetime

    last = datetime.fromtimestamp(last_ts, tz=UTC).date()
    now = datetime.now(UTC).date()
    return last != now


def _is_resolved_raw(raw: dict[str, Any], version: ProtocolVersion) -> bool:
    """Resolution flag from the field the market's version actually reports.

    V2 markets use `resolutionStatus`; V1 keeps `umaResolutionStatus`. Reading the
    wrong one would leave a resolved V2 market quoting indefinitely.
    """
    field = "resolutionStatus" if version is ProtocolVersion.V2 else "umaResolutionStatus"
    return str(raw.get(field) or "").strip().lower() == "resolved"


def _hours_to_end(end_date_iso: str | None, now: float) -> float | None:
    if not end_date_iso:
        return None
    try:
        dt = datetime.fromisoformat(end_date_iso.replace("Z", "+00:00"))
        hrs = (dt.timestamp() - now) / 3600.0
        # A past end date on a still-trading market is a stale/placeholder date
        # (common for "next X" appointment markets) — treat as unknown so we
        # don't wrongly HALT. The true end is signalled by acceptingOrders=False,
        # which the metadata refresh already halts on.
        return hrs if hrs > 0.0 else None
    except (ValueError, TypeError):
        return None


def _empty_view() -> Any:
    from polymaker.marketdata.orderbook import BookView

    return BookView(None, 0.0, None, 0.0, None, None, 0.0, 0.0)
