"""RiskManager: pre-trade gates and circuit breakers.

Consulted by the engine before every quote set. Returns a per-market decision
(size scale / reduce-only / halt) and owns the global kill switches.

Two rules are enforced here, both learned from live measurement:

  1. **Resting BUY orders are exposure.** A maker's downside is not its filled
     inventory but the whole stack of bids left in the book: on a $450 account the
     configured quote sizes put roughly $420 of bids at risk. Counting only filled
     positions left every cap blind to that, so exposure must be
     ``filled + resting``.
  2. **A matched YES+NO pair is nearly risk-free, not double risk.** Both outcome
     tokens together redeem for one dollar, so a balanced pair costs p+(1-p) and is
     worth 1. Charging the full notional of both legs against a cap marked a fully
     hedged book as over-limit while a genuinely directional bag went unnoticed.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

from polymaker.config import RiskConfig
from polymaker.domain import Fill, MarketMeta, OpenOrder, Side
from polymaker.logging import get_logger
from polymaker.state.store import StateStore

log = get_logger("risk.manager")


@dataclass(frozen=True, slots=True)
class RiskDecision:
    halt: bool  # HALTED regime for this market
    reduce_only: bool  # REDUCE_ONLY regime for this market
    size_scale: float  # multiply quote sizes by this [0,1]
    reason: str = ""


class RiskManager:
    def __init__(self, cfg: RiskConfig, store: StateStore) -> None:
        self._cfg = cfg
        self._store = store
        self._marks: dict[str, float] = {}  # token_id -> fair value
        self._net_cash = 0.0  # cumulative signed cash from fills (+sell, -buy)
        self._day_start_equity = 0.0
        self._killed = False
        # Rolling error window: a latched, never-decaying ratio turns one transient
        # reject storm into a permanent shutdown that looks like "no fills".
        self._recent_order_results: list[tuple[float, bool]] = []
        self._error_window_s = 300.0

    # ── PnL bookkeeping ─────────────────────────────────────────────────
    def note_fill(self, fill: Fill) -> None:
        self._net_cash += (fill.price * fill.size) * (1 if fill.side is Side.SELL else -1)

    def update_mark(self, token_id: str, fv: float) -> None:
        self._marks[token_id] = fv

    def _inventory_value(self) -> float:
        total = 0.0
        for tok, pos in self._store.positions.items():
            if pos.size > 0:
                total += pos.size * self._marks.get(tok, pos.avg_price)
        return total

    @property
    def net_cash(self) -> float:
        return self._net_cash

    @property
    def inventory_value(self) -> float:
        return self._inventory_value()

    @property
    def equity(self) -> float:
        return self._net_cash + self._inventory_value()

    @property
    def daily_pnl(self) -> float:
        return self.equity - self._day_start_equity

    def reset_day(self) -> None:
        """Re-baseline the daily loss window (called on a UTC day change)."""
        self._day_start_equity = self.equity
        log.info("risk_day_reset", equity=round(self.equity, 2))

    # ── error-rate breaker (rolling window) ─────────────────────────────
    def note_order_result(self, ok: bool, now: float | None = None) -> None:
        ts = time.time() if now is None else now
        self._recent_order_results.append((ts, ok))
        self._prune(ts)

    def _prune(self, now: float) -> None:
        cutoff = now - self._error_window_s
        if self._recent_order_results and self._recent_order_results[0][0] < cutoff:
            self._recent_order_results = [
                (t, ok) for t, ok in self._recent_order_results if t >= cutoff
            ]

    @property
    def error_rate(self) -> float:
        """Failure fraction over the recent window, or 0 with too few samples."""
        now = time.time()
        self._prune(now)
        n = len(self._recent_order_results)
        if n < 20:
            return 0.0
        errs = sum(1 for _, ok in self._recent_order_results if not ok)
        return errs / n

    # ── global kill switch ──────────────────────────────────────────────
    def global_halt(self) -> tuple[bool, str]:
        if self._killed:
            return True, "manual_kill"
        if self.daily_pnl <= -self._cfg.daily_loss_kill_usdc:
            return True, f"daily_loss {self.daily_pnl:.0f}"
        if self.error_rate >= self._cfg.max_order_error_rate:
            return True, f"error_rate {self.error_rate:.2f}"
        return False, ""

    def kill(self) -> None:
        self._killed = True
        log.critical("kill_switch_engaged")

    # ── per-market evaluation ───────────────────────────────────────────
    def evaluate(
        self,
        meta: MarketMeta,
        *,
        ws_stale: bool,
        event_group_cost: float,
        resting_buy_notional: float = 0.0,
    ) -> RiskDecision:
        halted, why = self.global_halt()
        if halted:
            return RiskDecision(True, False, 0.0, why)
        if ws_stale:
            return RiskDecision(True, False, 0.0, "ws_stale")

        resting = max(0.0, resting_buy_notional)
        market_notional = self._market_notional(meta) + resting
        total_exposure = self._total_exposure() + resting

        # hard caps -> reduce only
        if market_notional >= self._cfg.max_market_notional_usdc:
            return RiskDecision(False, True, 1.0, "market_cap")
        if event_group_cost >= self._cfg.max_event_group_loss_usdc:
            return RiskDecision(False, True, 1.0, "event_group_cap")
        if total_exposure >= self._cfg.max_total_exposure_usdc:
            return RiskDecision(False, True, 1.0, "total_exposure_cap")

        # soft scaling: taper size as any cap is approached (worst-binding wins)
        scale = min(
            _headroom(market_notional, self._cfg.max_market_notional_usdc),
            _headroom(total_exposure, self._cfg.max_total_exposure_usdc),
            _headroom(event_group_cost, self._cfg.max_event_group_loss_usdc),
        )
        return RiskDecision(False, False, scale, "")

    def _market_notional(self, meta: MarketMeta) -> float:
        """Directional risk of a market's filled inventory (pairs netted out).

        A balanced YES+NO pair redeems for its share count, so only the IMBALANCE
        carries directional risk.
        """
        yes = self._store.position(meta.yes.token_id)
        no = self._store.position(meta.no.token_id)
        balanced = min(yes.size, no.size)
        imbalance_yes = max(0.0, yes.size - balanced)
        imbalance_no = max(0.0, no.size - balanced)
        return (
            imbalance_yes * self._marks.get(meta.yes.token_id, yes.avg_price or 0.5)
            + imbalance_no * self._marks.get(meta.no.token_id, no.avg_price or 0.5)
        )

    def _total_exposure(self) -> float:
        """Gross marked value of all held positions.

        Kept gross across markets: a directional bag in any single market should
        still trip the global cap even when it sits in a different event group.
        """
        total = 0.0
        for tok, pos in self._store.positions.items():
            if pos.size > 0:
                total += pos.size * self._marks.get(tok, pos.avg_price or 0.5)
        return total


def _headroom(current: float, cap: float) -> float:
    """1.0 well below the cap, tapering to 0 as we approach it (from 70%)."""
    if cap <= 0:
        return 1.0
    frac = current / cap
    if frac <= 0.7:
        return 1.0
    return max(0.0, (1.0 - frac) / 0.3)


def resting_buy_notional(orders: list[OpenOrder], market_tokens: set[str]) -> float:
    """Notional of our resting BUY orders on a set of tokens.

    These are unfilled but committed: the exchange will honour them, so they must
    consume the exposure budget exactly like filled inventory does.
    """
    total = 0.0
    for o in orders:
        if o.side is Side.BUY and o.token_id in market_tokens:
            total += o.price * o.size
    return total
