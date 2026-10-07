"""Tests for market parsing, scoring, and the SQLite catalog store."""

from __future__ import annotations

import json

from polymaker.catalog.gamma import parse_market
from polymaker.catalog.scoring import BookStats, score_market
from polymaker.catalog.store import CatalogStore
from polymaker.domain import ProtocolVersion

RAW = {
    "conditionId": "0xabc",
    "question": "Will candidate X win?",
    "slug": "will-x-win",
    "version": "v1",
    "clobTokenIds": json.dumps(["101", "202"]),
    "outcomes": json.dumps(["Yes", "No"]),
    "orderPriceMinTickSize": 0.01,
    "orderMinSize": 5,
    "negRisk": True,
    "acceptingOrders": True,
    "rewardsMinSize": 10,
    "rewardsMaxSpread": 3.0,
    "feesEnabled": True,
    "feeSchedule": {"rate": 0.01, "takerOnly": True, "rebateRate": 0.25},
    "bestBid": 0.48,
    "bestAsk": 0.50,
    "liquidityNum": 20000.0,
    "volumeNum": 500000.0,
    "volume24hrClob": 12000.0,
    "endDate": "2028-11-07T00:00:00Z",
    "events": [{"id": 999, "slug": "2028-election"}],
}


def test_parse_market_maps_fields():
    m = parse_market(RAW, reward_rates={"0xabc": 42.0})
    assert m is not None
    assert m.condition_id == "0xabc"
    assert m.yes.token_id == "101"
    assert m.no.token_id == "202"
    assert m.version is ProtocolVersion.V1
    assert m.tick_size == 0.01
    assert m.neg_risk is True
    assert m.rewards_daily_rate == 42.0
    assert m.taker_fee_bps == 100  # 0.01 -> 100 bps
    assert m.maker_fee_bps == 0  # V2 makers pay zero
    assert m.rebate_rate == 0.25
    assert m.event_id == "999"


def test_parse_market_rejects_non_binary_and_closed():
    triple = {**RAW, "clobTokenIds": json.dumps(["a", "b", "c"]),
              "outcomes": json.dumps(["A", "B", "C"])}
    assert parse_market(triple) is None
    not_accepting = {**RAW, "acceptingOrders": False}
    assert parse_market(not_accepting) is None


def test_score_requires_a_measurable_book():
    """No book, or an empty band, must score zero rather than imply free money.

    With no competing depth the share formula would hand us the entire pool, which is
    how a dead or stale book masquerades as the best opportunity in the catalog.
    """
    good = parse_market(RAW, {"0xabc": 100.0})
    assert good is not None
    assert score_market(good).reward_daily_income == 0.0  # unmeasured
    assert score_market(good, BookStats(weighted_shares=0)).reward_daily_income == 0.0
    assert score_market(
        good, BookStats(weighted_shares=500, mid=0.49)
    ).reward_daily_income > 0.0


def test_capital_is_both_legs_not_the_cheap_leg():
    """A two-sided quote funds both outcomes, so capital == share count.

    Regression: scoring only the cheaper leg made a market trading at 0.002 report
    44 cents of capital and a five-figure daily yield.
    """
    near_zero = parse_market({**RAW, "rewardsMinSize": 20, "bestBid": 0.001,
                              "bestAsk": 0.003}, {"0xabc": 50.0})
    assert near_zero is not None
    sc = score_market(near_zero, BookStats(weighted_shares=10, mid=0.002, spread=0.002))
    assert sc.capital_usdc == 20.0, "20 shares means $20 at risk, not $0.04"


def test_spread_wider_than_band_cannot_score():
    """If the quoted spread exceeds the band, a touch quote falls outside it."""
    m = parse_market({**RAW, "rewardsMinSize": 20, "rewardsMaxSpread": 2.0},
                     {"0xabc": 50.0})
    assert m is not None
    wide = BookStats(weighted_shares=500, mid=0.5, spread=0.10)  # 10c spread, 2c band
    assert score_market(m, wide).reward_daily_income == 0.0
    tight = BookStats(weighted_shares=500, mid=0.5, spread=0.01)
    assert score_market(m, tight).reward_daily_income > 0.0


def test_score_prefers_more_reward_for_less_competition():
    """Same pool, thinner book -> better income and score."""
    m = parse_market(RAW, {"0xabc": 100.0})
    assert m is not None
    quiet = score_market(m, BookStats(weighted_shares=50, mid=0.49, spread=0.01))
    crowded = score_market(m, BookStats(weighted_shares=50_000, mid=0.49, spread=0.01))
    assert quiet.reward_daily_income > crowded.reward_daily_income
    assert quiet.score > crowded.score


def test_newsom_style_saturated_pool_pays_pennies():
    """Regression for the real failure: a huge in-band book makes the pool worthless.

    Live Newsom 2028 data: $30/day pool, 50-share min, ~65k weighted shares in band.
    The old model ranked this near the top; it actually pays about 2 cents a day on
    $50 of committed capital.
    """
    m = parse_market({**RAW, "rewardsMinSize": 50}, {"0xabc": 30.0})
    assert m is not None
    sc = score_market(m, BookStats(weighted_shares=65_514, mid=0.156, spread=0.008))
    assert sc.reward_daily_income < 0.05, f"expected pennies, got {sc.reward_daily_income}"
    assert sc.capital_usdc == 50.0
    assert sc.score < 0.1


def test_score_penalizes_extremity():
    balanced = parse_market(RAW, {"0xabc": 50.0})
    extreme = parse_market({**RAW, "conditionId": "0xext", "bestBid": 0.96, "bestAsk": 0.98},
                           {"0xext": 50.0})
    assert balanced is not None and extreme is not None
    assert score_market(extreme).extremity > score_market(balanced).extremity


def test_no_reward_program_scores_zero():
    m = parse_market({**RAW, "rewardsMinSize": 0, "rewardsMaxSpread": 0}, {"0xabc": 0.0})
    assert m is not None
    sc = score_market(m, BookStats(weighted_shares=0, mid=0.49))
    assert sc.reward_daily_income == 0.0 and sc.score == 0.0
    assert sc.capital_usdc == 0.0


def test_store_roundtrip_and_top(tmp_path):
    store = CatalogStore(tmp_path / "s.db")
    m = parse_market(RAW, {"0xabc": 42.0})
    store.upsert_market(m)
    assert store.get("0xabc").condition_id == "0xabc"
    assert store.get_by_slug("will-x-win").slug == "will-x-win"
    top = store.top(10)
    assert len(top) == 1 and top[0][0].condition_id == "0xabc"
    # tokens survive the JSON round-trip as a 2-tuple
    assert len(store.get("0xabc").tokens) == 2
    store.close()


def test_store_upsert_is_idempotent(tmp_path):
    store = CatalogStore(tmp_path / "s.db")
    m = parse_market(RAW, {"0xabc": 42.0})
    store.upsert_market(m)
    store.upsert_market(m)  # second time updates, not duplicates
    assert len(store.top(10)) == 1
    store.close()


def test_our_reward_score_is_distance_weighted_like_the_competition():
    """Our own score must carry the same distance weight as every competitor's size.

    Regression: we scored ourselves at full weight while competitors' sizes were
    distance-weighted, which overstated our pool share by up to ~4x when the spread
    approached the band.
    """
    m = parse_market({**RAW, "rewardsMinSize": 100, "rewardsMaxSpread": 5.0},
                     {"0xabc": 100.0})
    assert m is not None
    # at the touch (distance ~1c of a 5c band) we keep most of our weight
    at_touch = score_market(m, BookStats(weighted_shares=1000, mid=0.49,
                                         our_distance_cents=1.0))
    # sitting at the band edge we earn essentially nothing, despite the same size
    at_edge = score_market(m, BookStats(weighted_shares=1000, mid=0.49,
                                        our_distance_cents=5.0))
    assert at_touch.reward_daily_income > 0
    assert at_edge.reward_daily_income == 0.0


def test_our_score_is_zero_when_we_would_not_score():
    m = parse_market({**RAW, "rewardsMinSize": 100, "rewardsMaxSpread": 2.0},
                     {"0xabc": 100.0})
    assert m is not None
    outside = score_market(m, BookStats(weighted_shares=500, mid=0.49,
                                        our_distance_cents=3.0))
    assert outside.reward_daily_income == 0.0


# ── configuration preflight ─────────────────────────────────────────────────


def test_preflight_flags_unknown_profile():
    """A market pointing at a missing profile must be caught before the first quote."""
    from polymaker.config import Config, MarketEntry, StrategyProfile

    cfg = Config(
        profiles={"known": StrategyProfile()},
        markets=[MarketEntry(slug="s", profile="typo-profile")],
    )
    issues = cfg.preflight()
    assert any("unknown profile" in i for i in issues), issues


def test_preflight_flags_no_enabled_markets():
    from polymaker.config import Config, StrategyProfile

    cfg = Config(profiles={"known": StrategyProfile()}, markets=[])
    assert any("no enabled markets" in i for i in cfg.preflight())


def test_preflight_passes_for_a_consistent_config():
    from polymaker.config import Config, MarketEntry, StrategyProfile

    cfg = Config(
        profiles={"known": StrategyProfile()},
        markets=[MarketEntry(slug="s", profile="known")],
    )
    assert cfg.preflight() == []


def test_require_live_secrets_blocks_a_walletless_live_run():
    from polymaker.config import Config

    cfg = Config()
    assert cfg.require_live_secrets(), "live mode must require a wallet"
