"""Order/trade lifecycle processing over the StateStore.

Consumes *normalized* user-stream events (the wire-format extraction lives in
userstream/, so this is unit-testable with synthetic events) and drives the
state machine from the README:

    Trade:  MATCHED -> MINED -> CONFIRMED
                 └──────────-> FAILED (roll back the optimistic fill, reconcile)

Because we quote post-only, we are always the maker; `our_side` is our side of
each match. We apply the fill optimistically at MATCHED and reverse it on FAILED.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from polymaker.domain import Fill, OpenOrder, OrderState, Side, TradeState
from polymaker.logging import get_logger
from polymaker.state.store import StateStore

log = get_logger("state.tracker")


@dataclass(frozen=True, slots=True)
class TradeEvent:
    token_id: str
    our_side: Side
    price: float
    size: float
    trade_id: str
    status: TradeState
    ts: float


@dataclass(frozen=True, slots=True)
class OrderEvent:
    order_id: str
    token_id: str
    side: Side
    price: float
    remaining_size: float  # original - matched
    is_cancel: bool = False


class UserEventProcessor:
    """Applies normalized trade/order events to the store."""

    def __init__(
        self,
        store: StateStore,
        on_change: Callable[[str], None] | None = None,
        on_fill: Callable[[Fill], None] | None = None,
    ) -> None:
        self._store = store
        self._on_change = on_change or (lambda _cid: None)
        self._on_fill = on_fill or (lambda _fill: None)
        # trade_id -> applied Fill, so FAILED can reverse exactly what we applied
        self._applied: dict[str, Fill] = {}

    def on_trade(self, ev: TradeEvent, condition_id: str) -> None:
        if ev.status is TradeState.MATCHED:
            if ev.trade_id in self._applied:
                return  # idempotent: already counted this match (in-memory fast path)
            fill = Fill(ev.token_id, ev.our_side, ev.price, ev.size, ev.trade_id, ev.ts, is_maker=True)
            if not self._store.apply_fill(fill):
                # duplicate at the persistent layer (replay after CONFIRMED or
                # across restarts) — apply NO side effects
                return
            self._store.mark_inflight(ev.token_id)
            self._applied[ev.trade_id] = fill
            self._on_fill(fill)
            self._on_change(condition_id)

        elif ev.status in (TradeState.CONFIRMED, TradeState.MINED):
            if ev.status is TradeState.CONFIRMED:
                # Terminal success. Clear the guard for tokens we still believe are
                # in flight; a CONFIRMED for a trade we never applied (e.g. after a
                # restart) must still release the guard rather than leak it.
                if ev.trade_id in self._applied or self._store.inflight(ev.token_id) > 0:
                    self._store.clear_inflight(ev.token_id)
                # Mark it settled in the store so a later duplicate FAILED cannot
                # reverse inventory the exchange has already credited.
                self._store.mark_fill_settled(ev.trade_id)
                self._applied.pop(ev.trade_id, None)
                self._on_change(condition_id)

        elif ev.status is TradeState.RETRYING:
            # tx being retried on-chain — it may still succeed. Keep the
            # optimistic fill and the inflight guard; only FAILED is terminal.
            log.warning("trade_retrying", trade_id=ev.trade_id, token=ev.token_id[:12])

        elif ev.status is TradeState.FAILED:
            prior = self._applied.pop(ev.trade_id, None)
            if prior is not None:
                self._reverse_fill(prior, ev, condition_id)
            else:
                # No in-memory record: either we never applied it, or we restarted
                # between MATCHED and FAILED. Undo the persisted inventory, but NOT the
                # cash: `RiskManager._net_cash` is process-local and starts at 0 after a
                # restart, so crediting the reverse here would invent money that this
                # process never debited (verified: produced equity +50 on a trade that
                # should net to 0). `_reconcile_cash` snaps the ledger to the exchange
                # shortly afterwards, which is the correct authority for cash.
                undone = self._store.reverse_fill(ev.trade_id)
                if undone is not None:
                    self._store.clear_inflight(ev.token_id)
                    log.warning("trade_failed_reversed_no_cash", trade_id=ev.trade_id,
                                token=ev.token_id[:12], side=undone.side.value,
                                size=undone.size,
                                note="cash side not reversed across a restart")
                    self._on_change(condition_id)
                else:
                    self._store.clear_inflight(ev.token_id)

    def _reverse_fill(self, prior: Fill, ev: TradeEvent, condition_id: str) -> None:
        reversed_fill = Fill(prior.token_id, prior.side.opposite, prior.price, prior.size,
                             f"{prior.trade_id}:reverse", prior.ts, is_maker=True)
        if self._store.apply_fill(reversed_fill):
            self._reverse_effects(prior, ev, condition_id)

    def _reverse_effects(self, prior: Fill, ev: TradeEvent, condition_id: str) -> None:
        """Undo the money side of a fill that will never settle.

        The original optimistic application moved BOTH inventory and cash: inventory
        via `apply_fill`, cash via `on_fill` -> `risk.note_fill`. Reversing only the
        inventory left `net_cash` permanently overstated by the purchase, which
        understates equity and can latch the daily-loss kill switch on money that was
        never spent. The reverse fill must therefore be reported to risk as well.
        """
        self._store.clear_inflight(ev.token_id)
        log.warning("trade_failed_reversed", trade_id=ev.trade_id,
                    token=ev.token_id[:12], side=prior.side.value, size=prior.size)
        self._on_fill(Fill(prior.token_id, prior.side.opposite, prior.price, prior.size,
                           f"{prior.trade_id}:reverse", prior.ts, is_maker=True))
        self._on_change(condition_id)

    def on_order(self, ev: OrderEvent, condition_id: str) -> None:
        if ev.is_cancel or ev.remaining_size <= 0:
            self._store.remove_order(ev.order_id)
        else:
            state = OrderState.LIVE
            self._store.upsert_order(
                OpenOrder(ev.order_id, ev.token_id, ev.side, ev.price, ev.remaining_size, state)
            )
        self._on_change(condition_id)
