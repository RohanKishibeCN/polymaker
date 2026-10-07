"""Online estimators driven by the live stream: EWMAs of vol, flow, toxicity.

All are time-decayed (half-life in seconds) so they behave correctly under
irregular event arrival — a burst of ticks and a quiet minute are weighted by
elapsed wall-clock, not by sample count. Pure state machines: feed them
observations with timestamps, read scalar summaries. No I/O.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass

from polymaker.domain import Side


class Ewma:
    """Time-decayed exponentially weighted mean.

    On each update the prior weight decays by 0.5 ** (dt / halflife); a fresh
    observation gets the remaining weight. The first observation seeds the mean.
    """

    __slots__ = ("halflife", "_value", "_last_ts", "_initialized", "out_of_order")

    def __init__(self, halflife_s: float) -> None:
        if halflife_s <= 0:
            raise ValueError("halflife must be positive")
        self.halflife = halflife_s
        self._value = 0.0
        self._last_ts = 0.0
        self._initialized = False
        self.out_of_order = 0  # observations dropped for arriving with a stale ts

    def update(self, value: float, ts: float) -> float:
        if not self._initialized:
            self._value = value
            self._last_ts = ts
            self._initialized = True
            return self._value
        if ts < self._last_ts:
            # Out-of-order observation (buffered WS frame, clock step, or two
            # estimators fed from different sources). Applying it would decay by
            # dt=0, i.e. take a full-weight sample out of sequence, AND move the clock
            # BACKWARDS so the next in-order sample is discounted twice. Treat a stale
            # timestamp as no-op and keep the clock monotonic.
            self.out_of_order += 1
            return self._value
        dt = ts - self._last_ts
        decay = 0.5 ** (dt / self.halflife)
        self._value = decay * self._value + (1.0 - decay) * value
        self._last_ts = ts
        return self._value

    def decay_to(self, ts: float) -> float:
        """Decay the stored value toward 0 as if observing 0 at `ts`.

        Used to age out flow/vol during silence without a new observation.
        """
        if self._initialized and ts > self._last_ts:
            dt = ts - self._last_ts
            self._value *= 0.5 ** (dt / self.halflife)
            self._last_ts = ts
        return self._value

    @property
    def value(self) -> float:
        return self._value

    @property
    def ready(self) -> bool:
        return self._initialized


class VolEstimator:
    """Realized volatility at two horizons from fair-value changes."""

    __slots__ = ("_short", "_long", "_last_fv", "_last_ts")

    def __init__(self, short_halflife_s: float, long_halflife_s: float) -> None:
        self._short = Ewma(short_halflife_s)
        self._long = Ewma(long_halflife_s)
        self._last_fv: float | None = None
        self._last_ts = 0.0

    def update(self, fv: float, ts: float) -> None:
        if self._last_fv is not None:
            r = fv - self._last_fv
            sq = r * r
            self._short.update(sq, ts)
            self._long.update(sq, ts)
        self._last_fv = fv
        self._last_ts = ts

    @property
    def short(self) -> float:
        return math.sqrt(max(0.0, self._short.value))

    @property
    def long(self) -> float:
        return math.sqrt(max(0.0, self._long.value))

    @property
    def ratio(self) -> float:
        """short/long vol ratio; >1 means recent activity above baseline."""
        lo = self.long
        return self.short / lo if lo > 1e-9 else 1.0


class FlowEstimator:
    """Signed aggressor flow and its normalized strength.

    Earlier this reported ``EWMA(signed) / EWMA(|size|)``. That ratio is bounded by 1
    in absolute value (|EWMA(x)| <= EWMA(|x|)), so a `trend_flow_z` of 1.5 or 2.6 could
    never be reached and the one-sided-flow TRENDING posture was dead configuration.

    This normalises the EWMA of signed flow by the EWMA of its squared magnitude,
    which has better dynamics but is STILL bounded to [-1, 1] (|mean| <= RMS). Any
    threshold above 1 is therefore unreachable by construction — `StrategyProfile`
    rejects one at load time rather than letting it silently never fire.

    `flow_scale` converts a trade size into a comparable unit for mixing sources
    (used for quote-count style markets where sizes are constant and only the count
    carries information).
    """

    __slots__ = ("_signed", "_sq", "_halflife")

    def __init__(self, halflife_s: float) -> None:
        self._signed = Ewma(halflife_s)
        self._sq = Ewma(halflife_s)
        self._halflife = halflife_s

    def update(self, aggressor: Side, size: float, ts: float, *, flow_scale: float = 1.0) -> None:
        x = (size if aggressor is Side.BUY else -size) * flow_scale
        self._signed.update(x, ts)
        self._sq.update(x * x, ts)

    def decay_to(self, ts: float) -> None:
        self._signed.decay_to(ts)
        self._sq.decay_to(ts)

    @property
    def signed(self) -> float:
        return self._signed.value

    @property
    def z(self) -> float:
        """One-sidedness of flow in [-1, 1]: sign is direction, |z| is persistence.

        Denominator is the RMS magnitude of recent flow (EWMA of x^2 on a slower
        half-life), so for a perfectly steady stream of same-size prints the mean
        tends to the RMS and z tends to +/-1; mixed two-way flow keeps z near 0.

        NOTE THE BOUND. |EWMA(x)| <= RMS(x) always, so |z| <= 1 is a mathematical
        property, not a tuning choice: a threshold above 1 can never fire. The
        previous implementation divided by EWMA(|x|) and was bounded for the same
        reason, which is why `trend_flow_z` had no effect at any setting.
        """
        rms = math.sqrt(max(self._sq.value, 0.0))
        return self._signed.value / rms if rms > 1e-9 else 0.0

    @property
    def imbalance(self) -> float:
        """Bounded net-flow ratio in [-1, 1]: 1 all buys, -1 all sells, 0 balanced.

        Distinct from `z` in interpretation and scale: this is a simple composition
        measure (mean / RMS), useful when only the direction mix matters and no
        threshold tuning against a z-score is wanted.
        """
        gross = math.sqrt(max(self._sq.value, 0.0))
        return self._signed.value / gross if gross > 1e-9 else 0.0


@dataclass(frozen=True, slots=True)
class MarkoutSample:
    """One resolved markout observation — the raw material of the live experiment.

    The EWMA summary is what the strategy reacts to, but a measurement run needs the
    individual samples: the mean can look benign while a fat tail of adverse fills
    quietly drains the account, and only the distribution reveals that.
    """

    token_id: str
    side: Side
    fill_fv: float          # fair value of the traded token at fill time
    end_fv: float           # fair value of that token at the horizon
    markout: float          # signed: + favourable, - adverse
    horizon_s: float
    fill_ts: float
    resolved_ts: float


@dataclass(slots=True)
class _PendingMarkout:
    fv_at_fill: float
    side: Side  # our side of the fill (BUY => we bought => adverse if price falls)
    due_ts: float
    token_id: str = ""  # which outcome, so the mark resolves in its own price space
    fill_ts: float = 0.0


class MarkoutTracker:
    """Measures adverse selection: how fair value moves against us after fills.

    For each fill we remember FV-at-fill and, after a horizon, compare to the
    then-current FV. Signed so that a *positive* markout means the trade was
    good (price moved in our favor) and negative means we got picked off. The
    toxicity summary is the magnitude of recent adverse (negative) markout,
    which the quoter turns into extra spread / less size.
    """

    __slots__ = ("_horizon_s", "_pending", "_markout", "_samples", "_max_samples")

    # Keep the most recent observations for the measurement run. Bounded so a long
    # session cannot grow memory without limit.
    DEFAULT_MAX_SAMPLES = 5000

    def __init__(self, horizon_s: float = 300.0, ewma_halflife_s: float = 1800.0,
                 max_samples: int = DEFAULT_MAX_SAMPLES) -> None:
        self._horizon_s = horizon_s
        self._pending: list[_PendingMarkout] = []
        self._markout = Ewma(ewma_halflife_s)
        self._samples: list[MarkoutSample] = []
        self._max_samples = max(0, max_samples)

    def record_fill(self, side: Side, token_fv_at_fill: float, ts: float,
                    token_id: str = "") -> None:
        """Queue a fill for marking out. `token_fv_at_fill` is the fair value OF THE
        TOKEN WE TRADED, in that token's own price space. `token_id` records which
        outcome it was, so the mark can later be resolved in the SAME space."""
        self._pending.append(
            _PendingMarkout(token_fv_at_fill, side, ts + self._horizon_s, token_id, ts)
        )

    def evaluate(
        self,
        yes_fv_now: float,
        ts: float,
        *,
        yes_token_id: str | None = None,
        token_in_yes_space: Callable[[float, str], float] | None = None,
        on_resolved: Callable[[MarkoutSample], None] | None = None,
    ) -> None:
        """Resolve any markouts whose horizon has elapsed.

        The stored fill price is in TOKEN space, so the current fair value must be
        converted into that same token's space before differencing. Comparing a NO
        fill's 1-fv against the YES fair value manufactures an enormous fake adverse
        move — for a market at 0.195 that is a markout of about -0.61, which pins
        toxicity and silently disables quoting for the next half hour.
        """
        still: list[_PendingMarkout] = []
        for p in self._pending:
            if ts < p.due_ts:
                still.append(p)
                continue
            fv_now = (
                token_in_yes_space(yes_fv_now, p.token_id)
                if (token_in_yes_space is not None and p.token_id)
                else yes_fv_now
            )
            move = fv_now - p.fv_at_fill
            # if we BOUGHT, a rise is good (+); if we SOLD, a fall is good (+)
            signed = move if p.side is Side.BUY else -move
            self._markout.update(signed, ts)
            if self._max_samples:
                sample = MarkoutSample(
                    token_id=p.token_id, side=p.side, fill_fv=p.fv_at_fill,
                    end_fv=fv_now, markout=signed, horizon_s=self._horizon_s,
                    fill_ts=p.fill_ts, resolved_ts=ts,
                )
                self._samples.append(sample)
                if len(self._samples) > self._max_samples:
                    del self._samples[: len(self._samples) - self._max_samples]
                # Report each sample so it can be persisted: a measurement run must
                # not depend on the process staying alive to keep its evidence.
                if on_resolved is not None:
                    on_resolved(sample)
        self._pending = still

    @property
    def pending(self) -> int:
        return len(self._pending)

    @property
    def samples(self) -> list[MarkoutSample]:
        """Recent resolved markout observations (oldest first)."""
        return list(self._samples)

    def stats(self) -> dict[str, float]:
        """Distribution summary of resolved samples — the experiment's core output.

        `adverse_rate` and `mean` together decide viability: a positive mean with a
        high adverse rate means the winners are rare and large, which is a very
        different (and more fragile) profile than a steady small edge.
        """
        vals = [s.markout for s in self._samples]
        n = len(vals)
        if n == 0:
            return {"n": 0.0, "mean": 0.0, "adverse_rate": 0.0, "worst": 0.0, "best": 0.0,
                    "mean_adverse": 0.0, "total": 0.0}
        adverse = [v for v in vals if v < 0]
        return {
            "n": float(n),
            "mean": sum(vals) / n,
            "adverse_rate": len(adverse) / n,
            "worst": min(vals),
            "best": max(vals),
            "mean_adverse": (sum(adverse) / len(adverse)) if adverse else 0.0,
            "total": sum(vals),
        }

    @property
    def markout(self) -> float:
        return self._markout.value

    @property
    def toxicity(self) -> float:
        """Non-negative adverse-selection score (0 when fills are benign)."""
        return max(0.0, -self._markout.value)


@dataclass(slots=True)
class MarketEstimators:
    """Bundle of the per-market online estimators the engine keeps."""

    vol: VolEstimator
    flow: FlowEstimator
    markout: MarkoutTracker
    last_fv: float | None = None
    last_fv_ts: float = 0.0

    def on_fair_value(
        self,
        fv: float,
        ts: float,
        *,
        yes_token_id: str | None = None,
        token_in_yes_space: Callable[[float, str], float] | None = None,
        on_markout: Callable[[MarkoutSample], None] | None = None,
    ) -> None:
        """Feed the YES-space fair value; the markout resolves in the fill's own space.

        `token_in_yes_space` converts a YES-space fair value into a specific token's
        price space (NO is 1 - YES). Without it we cannot mark out correctly, so
        pending markouts are left queued rather than resolved against the wrong space.
        """
        self.vol.update(fv, ts)
        if token_in_yes_space is not None and yes_token_id is not None:
            self.markout.evaluate(
                fv,
                ts,
                yes_token_id=yes_token_id,
                token_in_yes_space=token_in_yes_space,
                on_resolved=on_markout,
            )
        self.last_fv = fv
        self.last_fv_ts = ts
