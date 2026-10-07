"""Unit tests for the online estimators (vol, flow, markout/toxicity)."""

from __future__ import annotations

import pytest

from polymaker.domain import Side
from polymaker.strategy.estimators import (
    Ewma,
    FlowEstimator,
    MarkoutTracker,
    VolEstimator,
)


def test_ewma_seeds_then_decays():
    e = Ewma(halflife_s=10.0)
    assert not e.ready
    e.update(1.0, ts=0.0)
    assert e.value == 1.0
    # after exactly one half-life, a 0 observation pulls the mean halfway
    e.update(0.0, ts=10.0)
    assert e.value == pytest.approx(0.5, abs=1e-9)


def test_ewma_decay_to_ages_value():
    e = Ewma(halflife_s=10.0)
    e.update(1.0, ts=0.0)
    e.decay_to(ts=10.0)  # one half-life of silence
    assert e.value == pytest.approx(0.5, abs=1e-9)


def test_vol_estimator_rises_with_movement():
    v = VolEstimator(short_halflife_s=5.0, long_halflife_s=100.0)
    # quiet: tiny moves
    fv, t = 0.5, 0.0
    for _ in range(20):
        t += 1.0
        v.update(fv, t)  # no change -> zero vol
    assert v.short == pytest.approx(0.0, abs=1e-6)
    # sudden jumps -> short vol jumps, ratio > 1
    for step in (0.05, -0.04, 0.06):
        t += 1.0
        fv += step
        v.update(fv, t)
    assert v.short > 0.01
    assert v.ratio > 1.0


def test_flow_estimator_sign_and_z():
    f = FlowEstimator(halflife_s=10.0)
    t = 0.0
    for _ in range(5):
        t += 1.0
        f.update(Side.BUY, 100, t)  # persistent buying
    assert f.signed > 0
    assert f.z > 0.5  # strongly one-sided
    # now heavy selling flips the sign over time
    for _ in range(10):
        t += 1.0
        f.update(Side.SELL, 200, t)
    assert f.signed < 0
    assert f.z < 0


def test_markout_toxicity_from_adverse_fills():
    mt = MarkoutTracker(horizon_s=30.0, ewma_halflife_s=100.0)
    # we BUY at fv=0.50; price then falls to 0.45 after the horizon -> adverse
    mt.record_fill(Side.BUY, token_fv_at_fill=0.50, ts=0.0)
    mt.evaluate(0.50, ts=10.0)  # before horizon: nothing resolves
    assert mt.markout == 0.0
    mt.evaluate(0.45, ts=31.0)  # after horizon: -0.05 markout
    assert mt.markout < 0
    assert mt.toxicity > 0


def test_markout_benign_fills_are_not_toxic():
    mt = MarkoutTracker(horizon_s=30.0, ewma_halflife_s=100.0)
    # we BUY at 0.50; price rises to 0.55 -> favorable, not toxic
    mt.record_fill(Side.BUY, token_fv_at_fill=0.50, ts=0.0)
    mt.evaluate(0.55, ts=31.0)
    assert mt.markout > 0
    assert mt.toxicity == 0.0


# ── markout price-space regression ──────────────────────────────────────────


def test_no_fill_markout_is_zero_when_yes_fv_is_unchanged():
    """A NO fill at an unchanged fair value is NOT an adverse move.

    Regression: the tracker stored the NO token's value (1 - fv) but resolved it
    against the YES fair value, manufacturing a markout of |2*fv - 1| — about -0.61
    for a market at 0.195 — which pinned toxicity and silently disabled quoting. The
    bot's primary quote is BUY-NO, so this fired on the first fill.
    """
    from polymaker.strategy.estimators import MarkoutTracker

    fv = 0.195  # YES-space fair value
    yes_id, no_id = "yes-tok", "no-tok"

    def in_yes_space(yes_fv: float, token_id: str) -> float:
        return yes_fv if token_id == yes_id else 1.0 - yes_fv

    t = MarkoutTracker(horizon_s=0.0)  # resolve immediately
    t.record_fill(Side.BUY, token_fv_at_fill=1.0 - fv, ts=0.0, token_id=no_id)
    t.evaluate(fv, ts=1.0, yes_token_id=yes_id, token_in_yes_space=in_yes_space)
    assert t.toxicity == 0.0, f"fake adverse mark: {t.markout}"

    # a YES fill in the same scenario is likewise neutral
    t2 = MarkoutTracker(horizon_s=0.0)
    t2.record_fill(Side.BUY, token_fv_at_fill=fv, ts=0.0, token_id=yes_id)
    t2.evaluate(fv, ts=1.0, yes_token_id=yes_id, token_in_yes_space=in_yes_space)
    assert t2.toxicity == 0.0


def test_no_fill_markout_detects_a_real_adverse_move():
    """Sanity: a genuine adverse move on the NO leg still registers as toxicity.

    NO fair value FALLING is adverse for a bought NO leg. In YES space that means the
    YES fair value RISING.
    """
    from polymaker.strategy.estimators import MarkoutTracker

    yes_id, no_id = "yes-tok", "no-tok"

    def in_yes_space(yes_fv: float, token_id: str) -> float:
        return yes_fv if token_id == yes_id else 1.0 - yes_fv

    fv_at_fill = 0.195
    t = MarkoutTracker(horizon_s=0.0)
    t.record_fill(Side.BUY, token_fv_at_fill=1.0 - fv_at_fill, ts=0.0, token_id=no_id)
    # YES fair value rises 0.195 -> 0.295, so NO fair value falls 0.805 -> 0.705
    t.evaluate(0.295, ts=1.0, yes_token_id=yes_id, token_in_yes_space=in_yes_space)
    assert t.toxicity > 0.05, "a real adverse move must register"


# ── per-fill markout sampling (the measurement experiment's raw material) ────


def test_markout_samples_are_recorded_per_fill():
    """Every resolved fill must yield one inspectable sample.

    The EWMA summary is what the strategy reacts to, but a measurement run needs the
    distribution: a benign mean can hide a fat tail of adverse fills.
    """
    from polymaker.strategy.estimators import MarkoutTracker

    t = MarkoutTracker(horizon_s=0.0)
    t.record_fill(Side.BUY, token_fv_at_fill=0.50, ts=1.0, token_id="y")
    t.evaluate(0.45, ts=2.0)  # adverse: price fell after we bought
    t.record_fill(Side.BUY, token_fv_at_fill=0.50, ts=3.0, token_id="y")
    t.evaluate(0.55, ts=4.0)  # favourable

    s = t.samples
    assert len(s) == 2
    assert s[0].markout < 0 and s[1].markout > 0
    assert s[0].token_id == "y" and s[0].side is Side.BUY
    stats = t.stats()
    assert stats["n"] == 2
    assert stats["adverse_rate"] == 0.5
    assert stats["worst"] < 0 < stats["best"]


def test_markout_samples_are_bounded():
    """A long session must not grow the sample buffer without limit."""
    from polymaker.strategy.estimators import MarkoutTracker

    t = MarkoutTracker(horizon_s=0.0, max_samples=3)
    for i in range(10):
        t.record_fill(Side.BUY, token_fv_at_fill=0.5, ts=float(i), token_id="y")
        t.evaluate(0.5 - 0.01 * i, ts=float(i) + 0.5)
    assert len(t.samples) <= 3, "samples must be capped"


def test_markout_on_resolved_callback_fires():
    """Samples must be reportable as they resolve, so evidence survives a restart."""
    from polymaker.strategy.estimators import MarkoutTracker

    seen = []
    t = MarkoutTracker(horizon_s=0.0)
    t.record_fill(Side.BUY, token_fv_at_fill=0.5, ts=0.0, token_id="y")
    t.evaluate(0.4, ts=1.0, on_resolved=seen.append)
    assert len(seen) == 1
    assert seen[0].markout == pytest.approx(-0.1)


def test_markout_stats_empty_is_safe():
    from polymaker.strategy.estimators import MarkoutTracker

    st = MarkoutTracker().stats()
    assert st["n"] == 0 and st["mean"] == 0.0 and st["adverse_rate"] == 0.0


def test_market_estimators_passes_markout_callback():
    from polymaker.domain import Side
    from polymaker.strategy.estimators import (
        FlowEstimator,
        MarketEstimators,
        MarkoutTracker,
        VolEstimator,
    )

    est = MarketEstimators(vol=VolEstimator(10, 100), flow=FlowEstimator(10),
                           markout=MarkoutTracker(horizon_s=0.0))
    got = []
    est.markout.record_fill(Side.BUY, 0.5, 0.0, "yes-tok")
    est.on_fair_value(0.45, 1.0, yes_token_id="yes-tok",
                      token_in_yes_space=lambda fv, t: fv, on_markout=got.append)
    assert len(got) == 1


def test_markout_summary_reflects_real_samples(tmp_path):
    """End-to-end: fills -> markout samples -> a summary an operator can act on."""
    from polymaker.strategy.estimators import MarkoutTracker

    t = MarkoutTracker(horizon_s=0.0)
    # three adverse fills, one favourable -> adverse_rate 0.75, negative mean
    for i in range(3):
        t.record_fill(Side.BUY, 0.50, float(i), "y")
        t.evaluate(0.48, float(i) + 0.5)
    t.record_fill(Side.BUY, 0.50, 10.0, "y")
    t.evaluate(0.52, 10.5)
    st = t.stats()
    assert st["n"] == 4
    assert st["adverse_rate"] == pytest.approx(0.75)
    assert st["mean"] < 0, "net adverse selection must show as a negative mean"
    assert st["mean_adverse"] < 0 < st["best"]
