"""Market attractiveness scoring for the scanner.

The previous model scored `daily_reward_rate x our_liquidity_share` and added a
*rebate pool* term scaled by a fixed `min(0.5, 100/liquidity)` factor. That ranked
markets by pool size rather than by what a given capital base can actually earn, and
it credited rebate income that is only earned on fills we win, not on liquidity we
post. Measured against live books it put a 65,000-weighted-share market (which pays
about 2 cents a day to a 50-share quote) near the top.

This module scores the decision a small maker actually faces:

    how much reward income can my constrained order capture, and what does that
    yield on the capital it ties up, net of the adverse selection I must survive?

Everything is computed from Gamma's per-market reward parameters plus one live
order-book read:

  * ``reward_daily_income`` — the pool share our minimum scoring order can win.
  * ``reward_yield_pct``    — that income per day per dollar of capital deployed.
  * ``toxicity``            — turnover pressure against in-band depth: how likely the
                              book is to move through our resting quotes.
  * ``competition``         — weighted depth already competing inside the band.

Pure functions over MarketMeta + an optional BookStats, so all of it is unit-testable.
"""

from __future__ import annotations

from dataclasses import dataclass

from polymaker.domain import MarketMeta


@dataclass(frozen=True, slots=True)
class BookStats:
    """A live order-book read used to size the reward competition.

    `weighted_shares` is the SCORE-WEIGHTED depth already resting inside the reward
    band on the *thinner* side, i.e. the competition for the pool:

        sum(size * ((band - |mid - price|) / band) ** 2)   for band-internal levels

    `one_minute_vol` is the stdev of 1-minute price changes, when measured.
    """

    weighted_shares: float = 0.0
    one_minute_vol: float = 0.0
    mid: float = 0.0
    spread: float = 0.0
    touch_depth: float = 0.0
    our_distance_cents: float = 0.0
    """How far from the mid we expect our own quote to sit, in cents. Competition is
    weighted by distance, so pretending we score at full weight while competitors do
    not would overstate our share (up to ~4x when the spread equals the band)."""


@dataclass(frozen=True, slots=True)
class MarketScore:
    condition_id: str
    reward_daily_income: float  # our $/day from the reward pool at minimum size
    reward_yield_pct: float  # reward_daily_income / capital deployed, per day
    rebate_potential: float  # whole-market daily rebate pool (context, not ours)
    competition: float  # weighted shares already in-band on the thin side
    toxicity: float  # 0 = placid, 1 = severe adverse-selection risk
    spread: float
    extremity: float  # 0 = mid near 0.5 (good), 1 = near 0/1
    capital_usdc: float  # capital the minimum scoring order ties up
    score: float


def _mid(m: MarketMeta, book: BookStats | None = None) -> float:
    if book is not None and 0.0 < book.mid < 1.0:
        return book.mid
    if m.best_bid > 0 and m.best_ask > 0:
        return (m.best_bid + m.best_ask) / 2.0
    return 0.5


def reward_score_weight(distance_cents: float, band_cents: float) -> float:
    """Official in-band scoring weight: ((v - s) / v)^2, clamped to [0, 1].

    `v` is the max qualifying distance from the midpoint (rewardsMaxSpread) and `s`
    is the order's actual distance. Orders outside the band score nothing.
    """
    if band_cents <= 0:
        return 0.0
    if distance_cents < 0:
        distance_cents = 0.0
    if distance_cents > band_cents:
        return 0.0
    ratio = (band_cents - distance_cents) / band_cents
    return ratio * ratio


def min_qualifying_shares(m: MarketMeta) -> float:
    """Smallest order that can score, per the market's reward rules."""
    if m.rewards_daily_rate <= 0 or m.rewards_max_spread <= 0:
        return 0.0
    return max(m.rewards_min_size, m.min_order_size, 0.0)


def capital_for_min_order(m: MarketMeta, book: BookStats | None = None) -> float:
    """USDC tied up by a minimum scoring two-sided quote.

    We post BUY-YES and BUY-NO for `shares` each. The two legs cost
    ``shares * p + shares * (1 - p)`` = ``shares`` dollars together, and the pair
    redeems for `shares` once merged. So the capital at stake is simply the share
    count — one dollar per share.

    This deliberately does NOT use the cheaper leg. Scoring the cheap side alone
    makes a market trading at 0.002 look like it needs 44 cents of capital, which
    then reports a five-figure daily yield. A two-sided quote on a near-zero market
    must still fund the 0.998 leg.
    """
    shares = min_qualifying_shares(m)
    if shares <= 0:
        return 0.0
    return shares


def band_reachable(m: MarketMeta, book: BookStats | None = None) -> bool:
    """Whether a quote can actually sit inside the reward band.

    The band is a maximum distance from the midpoint. If the quoted spread is already
    wider than the band, an order at the touch is outside it and scores nothing, so
    the market cannot be reward-farmed as measured.
    """
    band = m.rewards_max_spread / 100.0
    if band <= 0:
        return False
    spread = book.spread if (book is not None and book.spread > 0) else 0.0
    if spread <= 0 and m.best_bid > 0 and m.best_ask > 0:
        spread = max(0.0, m.best_ask - m.best_bid)
    if spread <= 0:
        return True  # no spread information; do not reject on a guess
    return spread <= band


def reward_daily_income(m: MarketMeta, book: BookStats | None = None) -> float:
    """Our share of the daily reward pool at minimum qualifying size.

    The pool splits by score share, so our take is ``pool * ours / (existing + ours)``
    where `ours` is our full-weight score at the touch.

    Returns 0 when the payout cannot be justified by a real measurement:

    * no book read — the competition is unknown, and an unmeasured field is not empty;
    * the spread exceeds the band — a touch quote would fall outside it and not score;
    * nothing is resting in the band at all — with no observable competition the
      share formula would hand us the entire pool, which is an artefact of an empty
      or stale book rather than a real edge.
    """
    shares = min_qualifying_shares(m)
    if shares <= 0 or book is None:
        return 0.0
    if not band_reachable(m, book):
        return 0.0
    existing = max(book.weighted_shares, 0.0)
    if existing <= 0:
        # Nothing measurable in the band. Claiming the whole pool here is how a dead
        # market masquerades as the best opportunity in the catalog.
        return 0.0
    # Apply the SAME distance weight to ourselves that every competitor's size
    # already carries, so the share is apples-to-apples.
    our_score = shares * reward_score_weight(book.our_distance_cents, m.rewards_max_spread)
    if our_score <= 0:
        # Our own quote would sit outside the band and earn nothing.
        return 0.0
    our_share = our_score / (existing + our_score)
    return m.rewards_daily_rate * our_share


def reward_yield_pct(m: MarketMeta, book: BookStats | None = None) -> float:
    """Reward income per day as a percentage of the capital it ties up."""
    capital = capital_for_min_order(m, book)
    if capital <= 0:
        return 0.0
    return reward_daily_income(m, book) / capital * 100.0


def competition(m: MarketMeta, book: BookStats | None = None) -> float:
    """Score-weighted in-band depth already competing for this pool."""
    return max(book.weighted_shares, 0.0) if book is not None else 0.0


def toxicity(m: MarketMeta, book: BookStats | None = None,
             vol_1m: float | None = None) -> float:
    """Adverse-selection pressure from a market's MEASURED volatility, 0..1.

    Only volatility is used, deliberately. An earlier version also scored 24h volume
    against in-band depth; that ratio saturates at the square of the depth ratio and
    returned 1.0 for essentially every live market, which carries no information and
    merely flattened the ranking.

    The signal is the drift faced over a typical holding period (~15 minutes) relative
    to the reward band:

        sigma_15m = sigma_1m * sqrt(15)
        toxicity  = min(1, sigma_15m / band)

    If the price wanders the whole band inside the time we expect to hold, a resting
    order is more likely to be run over than paid for. With no volatility measured we
    return 0: a penalty invented from volume alone is guesswork, and the live quote
    path has its own measured toxicity (per-fill markout) to protect it.
    """
    band = m.rewards_max_spread / 100.0
    sigma = vol_1m if vol_1m is not None else (book.one_minute_vol if book else 0.0)
    if band <= 0 or not sigma or sigma <= 0:
        return 0.0
    return float(min(1.0, (sigma * (15.0 ** 0.5)) / band))


def rebate_potential(m: MarketMeta) -> float:
    """Estimated daily maker-rebate POOL for the market (whole-market context).

    Per-share taker fee = fee_rate * p*(1-p), so daily fees are
    ``vol * fee_rate * (1 - mid)`` and the rebate pool is that times the rebate rate.
    This is the pool, NOT our income: we only earn it on maker fills we win.
    """
    if not m.fees_enabled or m.rebate_rate <= 0 or m.taker_fee_bps <= 0:
        return 0.0
    vol24 = m.volume_24hr
    if vol24 <= 0:
        return 0.0
    fee_rate = m.taker_fee_bps / 10000.0
    mid = _mid(m)
    daily_fees = vol24 * fee_rate * (1.0 - mid)
    return round(daily_fees * m.rebate_rate, 2)


def extremity(m: MarketMeta, book: BookStats | None = None) -> float:
    """0 near 0.5 (balanced), ->1 near the 0/1 boundary."""
    mid = _mid(m, book)
    return min(1.0, abs(mid - 0.5) / 0.5)


def score_market(
    m: MarketMeta,
    book: BookStats | None = None,
    *,
    vol_1m: float | None = None,
) -> MarketScore:
    """Rank a market by risk-adjusted reward yield per dollar of capital.

    `score` is reward yield discounted by toxicity and extremity. It is a *relative*
    ranking signal — an absolute profit forecast would require knowing our future fill
    share, which no static read can supply.
    """
    income = reward_daily_income(m, book)
    capital = capital_for_min_order(m, book)
    yield_pct = reward_yield_pct(m, book)
    comp = competition(m, book)
    tox = toxicity(m, book, vol_1m)
    ext = extremity(m, book)
    rp = rebate_potential(m)
    spread = max(0.0, m.best_ask - m.best_bid) if (m.best_bid and m.best_ask) else 1.0

    # discount the yield for the risk of being run over and for payoff asymmetry
    risk_discount = (1.0 - 0.7 * tox) * (1.0 - 0.5 * ext)
    score = yield_pct * max(0.0, risk_discount)

    return MarketScore(
        condition_id=m.condition_id,
        reward_daily_income=round(income, 4),
        reward_yield_pct=round(yield_pct, 4),
        rebate_potential=round(rp, 2),
        competition=round(comp, 2),
        toxicity=round(tox, 4),
        spread=round(spread, 4),
        extremity=round(ext, 4),
        capital_usdc=round(capital, 2),
        score=round(score, 4),
    )
