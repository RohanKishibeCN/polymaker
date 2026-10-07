"""Regression tests for the defects found by adversarial review.

Each test names the concrete failure it prevents. These are deliberately written
against the REAL code paths that the earlier suite passed straight through.
"""

from __future__ import annotations

import pytest

from polymaker.domain import Fill, Side, TradeState
from polymaker.state.store import StateStore
from polymaker.state.tracker import TradeEvent, UserEventProcessor


@pytest.fixture
def store(tmp_path):  # type: ignore[no-untyped-def]
    s = StateStore(tmp_path / "s.db")
    yield s
    s.close()


# ── A1: guard must be evaluated for ABSENT tokens too ───────────────────────


def test_authoritative_reconcile_does_not_zero_in_flight_position(store: StateStore) -> None:
    """A position with an unsettled fill must survive an empty authoritative read.

    Regression: the guard set was built from the RESPONSE, so a token that was both
    absent and in-flight got zeroed anyway — wiping live inventory and causing the
    next requote to buy more.
    """
    store.apply_fill(Fill("tok-1", Side.BUY, 0.5, 100.0, "t1", 1.0))
    store.mark_inflight("tok-1")
    zeroed = store.reconcile_positions({}, authoritative=True)
    assert zeroed == []
    assert store.position("tok-1").size == 100.0, "in-flight inventory must not be wiped"


def test_authoritative_reconcile_does_not_zero_recent_fill(store: StateStore) -> None:
    """A fill the API has not indexed yet must not be zeroed by a stale read."""
    import time

    store.apply_fill(Fill("tok-1", Side.BUY, 0.5, 100.0, "t1", time.time()))
    zeroed = store.reconcile_positions({}, authoritative=True)
    assert zeroed == []
    assert store.position("tok-1").size == 100.0


def test_authoritative_reconcile_still_zeroes_a_genuinely_closed_position(
    store: StateStore,
) -> None:
    """The mechanism must still work for a merge/redeem/manual sell."""
    store.apply_fill(Fill("tok-1", Side.BUY, 0.5, 100.0, "t1", 0.0))  # old ts: unguarded
    zeroed = store.reconcile_positions({}, authoritative=True)
    assert zeroed == ["tok-1"]
    assert store.position("tok-1").size == 0.0


# ── A2: positions() must not report a false "flat" ──────────────────────────


class _Resp:
    def __init__(self, payload: object, status: int = 200) -> None:
        self._payload = payload
        self.status_code = status
        self.headers: dict[str, str] = {}

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            import httpx

            raise httpx.HTTPStatusError("err", request=None, response=None)  # type: ignore[arg-type]

    def json(self) -> object:
        return self._payload


@pytest.mark.asyncio
async def test_positions_not_applicable_returns_none(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """A funder we cannot query must read as UNKNOWN, not as flat."""
    from polymaker.config import Config
    from polymaker.execution.gateway import ExecutionGateway

    gw = ExecutionGateway(Config())
    gw._funder = "0xPAPER"
    assert await gw.positions() is None, "paper/no-wallet must not look like 'no positions'"


@pytest.mark.asyncio
async def test_positions_unparsable_rows_return_none(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """A page whose rows do not match the schema is a drift, not an empty portfolio."""
    import httpx

    from polymaker.config import Config
    from polymaker.execution.gateway import ExecutionGateway

    gw = ExecutionGateway(Config())
    gw._funder = "0x" + "11" * 20

    class _Client:
        async def __aenter__(self):  # type: ignore[no-untyped-def]
            return self

        async def __aexit__(self, *a):  # type: ignore[no-untyped-def]
            return False

        async def get(self, url, params=None):  # type: ignore[no-untyped-def]
            # v1/camelCase shape: `tokenId`/`currentSize` instead of token_id/current_size
            return _Resp({"data": [{"tokenId": "1", "currentSize": 5}],
                          "pagination": {"next_cursor": None}})

    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: _Client())
    assert await gw.positions() is None, "schema drift must not read as 'flat'"


@pytest.mark.asyncio
async def test_positions_missing_pagination_returns_none(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """Without pagination metadata a listing cannot be proven complete."""
    import httpx

    from polymaker.config import Config
    from polymaker.execution.gateway import ExecutionGateway

    gw = ExecutionGateway(Config())
    gw._funder = "0x" + "11" * 20

    class _Client:
        async def __aenter__(self):  # type: ignore[no-untyped-def]
            return self

        async def __aexit__(self, *a):  # type: ignore[no-untyped-def]
            return False

        async def get(self, url, params=None):  # type: ignore[no-untyped-def]
            return _Resp({"data": [{"token_id": "1", "current_size": 5, "avg_price": 0.5}]})

    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: _Client())
    assert await gw.positions() is None


@pytest.mark.asyncio
async def test_positions_empty_list_is_a_valid_flat_answer(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """An explicitly empty, complete listing IS authoritative: we hold nothing."""
    import httpx

    from polymaker.config import Config
    from polymaker.execution.gateway import ExecutionGateway

    gw = ExecutionGateway(Config())
    gw._funder = "0x" + "11" * 20

    class _Client:
        async def __aenter__(self):  # type: ignore[no-untyped-def]
            return self

        async def __aexit__(self, *a):  # type: ignore[no-untyped-def]
            return False

        async def get(self, url, params=None):  # type: ignore[no-untyped-def]
            return _Resp({"data": [], "pagination": {"next_cursor": None}})

    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: _Client())
    assert await gw.positions() == {}


# ── B: open_orders() must not report a false "no orders" ────────────────────


@pytest.mark.asyncio
async def test_open_orders_all_rows_unparsable_returns_none() -> None:
    """An all-skipped payload must be UNREADABLE, not an empty book.

    Regression: returning [] let the reconciler drop every live order and re-place
    the whole target as duplicates.
    """
    from polymaker.config import Config
    from polymaker.execution.gateway import ExecutionGateway

    gw = ExecutionGateway(Config())
    gw._paper = False

    class _Client:
        def get_open_orders(self):  # type: ignore[no-untyped-def]
            # every row has an unusable side spelling
            return [{"id": "1", "asset_id": "9", "side": "NOPE", "price": 0.5}]

    gw._client = _Client()
    assert await gw.open_orders() is None


@pytest.mark.asyncio
async def test_open_orders_empty_payload_is_valid() -> None:
    from polymaker.config import Config
    from polymaker.execution.gateway import ExecutionGateway

    gw = ExecutionGateway(Config())
    gw._paper = False

    class _Client:
        def get_open_orders(self):  # type: ignore[no-untyped-def]
            return []

    gw._client = _Client()
    assert await gw.open_orders() == []


@pytest.mark.asyncio
async def test_open_orders_accepts_v2_asset_field_names() -> None:
    """V2 rows may key the asset differently; the row must not be dropped."""
    from polymaker.config import Config
    from polymaker.execution.gateway import ExecutionGateway

    gw = ExecutionGateway(Config())
    gw._paper = False

    class _Client:
        def get_open_orders(self):  # type: ignore[no-untyped-def]
            return [{"id": "42", "token_id": "777", "side": "BUY", "price": 0.5,
                     "original_size": 10, "size_matched": 4}]

    gw._client = _Client()
    orders = await gw.open_orders()
    assert orders is not None and len(orders) == 1
    assert orders[0].token_id == "777"
    assert orders[0].size == pytest.approx(6.0)


# ── D: reversal must be restart-safe and must not undo a settled fill ───────


def test_settled_fill_is_not_reversed_by_a_late_failed(store: StateStore) -> None:
    """A duplicate/late FAILED for a settled trade must not subtract real inventory."""
    store.apply_fill(Fill("tok-1", Side.BUY, 0.5, 100.0, "t1", 1.0))
    store.mark_fill_settled("t1")
    assert store.reverse_fill("t1") is None, "settled fills must be immutable"
    assert store.position("tok-1").size == 100.0


def test_reverse_fill_is_idempotent(store: StateStore) -> None:
    store.apply_fill(Fill("tok-1", Side.BUY, 0.5, 100.0, "t1", 1.0))
    assert store.reverse_fill("t1") is not None
    assert store.reverse_fill("t1") is None  # already reversed
    assert store.position("tok-1").size == 0.0


def test_failed_after_restart_reverses_inventory_but_not_cash(tmp_path) -> None:  # type: ignore[no-untyped-def]
    """Across a restart the cash ledger is process-local; only inventory is undone.

    Crediting cash here invented money this process never debited (verified: equity
    +50 on a trade that should net to zero).
    """
    from polymaker.config import RiskConfig
    from polymaker.risk.manager import RiskManager

    db = tmp_path / "s.db"
    s1 = StateStore(db)
    p1 = UserEventProcessor(s1)
    p1.on_trade(TradeEvent("tok-1", Side.BUY, 0.5, 100.0, "t1", TradeState.MATCHED, 1.0), "cid")
    s1.close()

    s2 = StateStore(db)
    assert s2.position("tok-1").size == 100.0  # restored
    risk = RiskManager(RiskConfig(), s2)
    assert risk.net_cash == 0.0  # a fresh process knows nothing about past cash
    p2 = UserEventProcessor(s2, on_fill=risk.note_fill)
    p2.on_trade(TradeEvent("tok-1", Side.BUY, 0.5, 100.0, "t1", TradeState.FAILED, 5.0), "cid")
    assert s2.position("tok-1").size == 0.0, "inventory reversal is restart-safe"
    assert risk.net_cash == 0.0, "cash must NOT be invented across a restart"
    s2.close()


# ── E1: the global cap must see every market's resting orders ───────────────


def test_global_cap_counts_all_markets_resting_orders(store: StateStore) -> None:
    """N markets each under the cap must not sum past it.

    Regression: only the current market's resting notional was added, so 5 markets x
    $400 passed a $500 total cap.
    """
    from polymaker.config import RiskConfig
    from polymaker.domain import MarketMeta, TokenMeta
    from polymaker.risk.manager import RiskManager

    cfg = RiskConfig(max_total_exposure_usdc=500.0)
    risk = RiskManager(cfg, store)

    def meta(i: int) -> MarketMeta:
        return MarketMeta(
            condition_id=f"0x{i}", question="q", slug=f"s{i}",
            tokens=(TokenMeta(f"y{i}", "Yes"), TokenMeta(f"n{i}", "No")),
            tick_size=0.01, neg_risk=False, min_order_size=5.0, rewards_min_size=0.0,
            rewards_max_spread=0.0, rewards_daily_rate=0.0, maker_fee_bps=0,
            taker_fee_bps=0, fees_enabled=False, end_date_iso=None, event_id=None,
        )

    # this market's own resting orders are small; OTHER markets hold $2000 in total
    d = risk.evaluate(meta(0), ws_stale=False, event_group_cost=0.0,
                      resting_buy_notional=100.0, global_resting_buy_notional=2000.0)
    assert d.reduce_only and d.reason == "total_exposure_cap"


def test_resting_orders_do_not_feed_the_size_taper(store: StateStore) -> None:
    """Resting orders must not shrink the size that produces them (churn loop)."""
    from polymaker.config import RiskConfig
    from polymaker.domain import MarketMeta, TokenMeta
    from polymaker.risk.manager import RiskManager

    cfg = RiskConfig(max_total_exposure_usdc=1000.0, max_market_notional_usdc=1000.0)
    risk = RiskManager(cfg, store)
    m = MarketMeta(
        condition_id="0xc", question="q", slug="s",
        tokens=(TokenMeta("y", "Yes"), TokenMeta("n", "No")),
        tick_size=0.01, neg_risk=False, min_order_size=5.0, rewards_min_size=0.0,
        rewards_max_spread=0.0, rewards_daily_rate=0.0, maker_fee_bps=0, taker_fee_bps=0,
        fees_enabled=False, end_date_iso=None, event_id=None,
    )
    # a large resting stack, but no filled inventory: the taper must stay at 1.0
    d = risk.evaluate(m, ws_stale=False, event_group_cost=0.0,
                      resting_buy_notional=800.0, global_resting_buy_notional=800.0)
    assert d.size_scale == 1.0, "resting orders must not taper the size that creates them"


# ── quoting: out-of-band entries are capped in, and exits survive ───────────


def test_band_unreachable_still_manages_exits(meta, profile) -> None:  # type: ignore[no-untyped-def]
    """If the band cannot fit an entry, held inventory must STILL get an exit.

    Regression: the early return fired before the exits were built, leaving the bag
    with no way out.
    """
    from polymaker.domain import Position, Regime
    from polymaker.strategy.quoting import QuoteInputs, construct_quotes
    from tests.conftest import view

    tight = meta.__class__(
        condition_id="0xt", question="q", slug="s",
        tokens=meta.tokens, tick_size=0.01, neg_risk=False, min_order_size=5.0,
        rewards_min_size=10.0, rewards_max_spread=1.0,  # 1c band, 1 tick, base 2 ticks
        rewards_daily_rate=10.0, maker_fee_bps=0, taker_fee_bps=0, fees_enabled=False,
        end_date_iso=None, event_id=None,
    )
    tq = construct_quotes(QuoteInputs(
        meta=tight, regime=Regime.QUIET, fv=0.50, vol_short=0.0, toxicity=0.0,
        yes_view=view(0.49, 0.51), no_view=view(0.49, 0.51),
        pos_yes=Position("yes-token", 100.0, 0.5), pos_no=Position("no-token"),
        profile=profile, now=1000.0, mid_price=0.50,
        yes_exit_urgency=1.0, no_exit_urgency=1.0,
    ))
    sells = [q for q in tq.quotes if q.side.value == "SELL"]
    assert sells, "an unreachable band must not silence exits"


def test_entry_quotes_stay_inside_the_reward_band(meta, profile) -> None:  # type: ignore[no-untyped-def]
    """Entry quotes must land within the band even when inventory skew pushes them."""
    from polymaker.domain import Position, Regime, Side
    from polymaker.strategy.quoting import QuoteInputs, construct_quotes
    from tests.conftest import view

    tq = construct_quotes(QuoteInputs(
        meta=meta, regime=Regime.QUIET, fv=0.195, vol_short=0.02, toxicity=0.0,
        yes_view=view(0.19, 0.196), no_view=view(0.8, 0.81),
        pos_yes=Position("yes-token", 200.0, 0.19), pos_no=Position("no-token"),
        profile=profile, now=1000.0, mid_price=0.195,
    ))
    band = meta.rewards_max_spread / 100.0
    buys = [q for q in tq.quotes if q.side is Side.BUY]
    assert buys, "the market has band room, so entries must exist"
    for q in buys:
        # The band is measured from each token's OWN midpoint: NO quotes around
        # 1 - mid, not around the YES mid.
        token_mid = 0.195 if q.token_id == "yes-token" else 1.0 - 0.195
        assert abs(token_mid - q.price) <= band + 1e-9, (
            f"entry {q.token_id}@{q.price} is outside the {band} band "
            f"(mid {token_mid}; would earn nothing)"
        )
