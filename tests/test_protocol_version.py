"""Protocol V1/V2 identifier routing, ledger selection and signing-domain tests.

These pin the decisions that are expensive to get wrong in production:

  * the outcome id is chosen by Gamma's `version` and nothing else;
  * `clobTokenIds` (JSON string) and `positionIds` (native array) decode differently;
  * V2 markets sign against ExchangeV3 with domain version "3", V1 against
    CTFExchangeV2 with domain version "2";
  * on-chain balances are read from the ledger owning the market's version;
  * the V2 condition id for Router calls derives from the position id.
"""

from __future__ import annotations

import json

import pytest

from polymaker.catalog.gamma import parse_market
from polymaker.domain import MarketMeta, ProtocolVersion, TokenMeta
from polymaker.execution.ledger import (
    ASSET_TYPE_CTF,
    ASSET_TYPE_V2,
    CTF_LEDGER,
    POSITION_MANAGER,
    asset_type_for,
    bytes31,
    condition_id_from_position_id,
    event_id_of,
    is_decimal_id,
    ledger_for,
    module_id_of,
    narrow_v2_condition_id,
    outcome_index_of,
    v2_condition_id_bytes31,
)

# Documented example from /market-data/discover-markets (Polymarket V2).
DOC_POSITION_YES = "651150819117105875331414918119047680898421632356043490229292782433651916800"
DOC_POSITION_NO = "651150819117105875331414918119047680898421632356043490229292782433651916801"
DOC_CONDITION_31B = "0x017089ce3ba22aaa0a4cba8250b8c8e1eb0000000000000000000000000000"

CTF_YES = "107505882767731489358349912513945399560393482969656700824895970500493757150417"
CTF_NO = "7305630249804085635496399869905769372294302716159034447326228509068694952392"


def _v1_raw(**over: object) -> dict[str, object]:
    raw: dict[str, object] = {
        "conditionId": "0x747dc809fb79e1b05be09c42d6179459a58de2ef3e40f02484a4e1260f741f75",
        "question": "Will X happen?",
        "slug": "will-x-happen",
        "version": "v1",
        "clobTokenIds": json.dumps([CTF_YES, CTF_NO]),
        "positionIds": None,
        "outcomes": json.dumps(["Yes", "No"]),
        "orderPriceMinTickSize": 0.01,
        "orderMinSize": 5,
        "negRisk": False,
        "acceptingOrders": True,
        "rewardsMinSize": 10,
        "rewardsMaxSpread": 3.0,
        "feesEnabled": True,
        "feeSchedule": {"rate": 0.01, "takerOnly": True, "rebateRate": 0.25},
    }
    raw.update(over)
    return raw


def _v2_raw(**over: object) -> dict[str, object]:
    raw: dict[str, object] = {
        "conditionId": DOC_CONDITION_31B,
        "question": "Will Y happen?",
        "slug": "will-y-happen",
        "version": "v2",
        "clobTokenIds": None,
        "positionIds": [DOC_POSITION_YES, DOC_POSITION_NO],
        "outcomes": json.dumps(["Yes", "No"]),
        "orderPriceMinTickSize": 0.01,
        "orderMinSize": 5,
        "negRisk": False,
        "acceptingOrders": True,
        "rewardsMinSize": 10,
        "rewardsMaxSpread": 3.0,
        "feesEnabled": True,
        "feeSchedule": {"rate": 0.01, "takerOnly": True, "rebateRate": 0.25},
    }
    raw.update(over)
    return raw


# ── identifier selection ────────────────────────────────────────────────────


def test_v1_market_uses_clob_token_ids() -> None:
    m = parse_market(_v1_raw())
    assert m is not None
    assert m.version is ProtocolVersion.V1
    assert not m.is_v2
    assert (m.yes.token_id, m.no.token_id) == (CTF_YES, CTF_NO)


def test_v2_market_uses_position_ids() -> None:
    m = parse_market(_v2_raw())
    assert m is not None
    assert m.version is ProtocolVersion.V2
    assert m.is_v2
    assert (m.yes.token_id, m.no.token_id) == (DOC_POSITION_YES, DOC_POSITION_NO)


def test_both_id_fields_present_still_follows_version_v1() -> None:
    """The documented trap: a CTF market can also carry positionIds."""
    m = parse_market(_v1_raw(positionIds=[DOC_POSITION_YES, DOC_POSITION_NO]))
    assert m is not None
    assert m.version is ProtocolVersion.V1
    assert m.yes.token_id == CTF_YES, "field presence must not override version"


def test_both_id_fields_present_still_follows_version_v2() -> None:
    m = parse_market(_v2_raw(clobTokenIds=json.dumps([CTF_YES, CTF_NO])))
    assert m is not None
    assert m.version is ProtocolVersion.V2
    assert m.yes.token_id == DOC_POSITION_YES, "field presence must not override version"


@pytest.mark.parametrize("bad", [None, "", "v3", "2", "protocol-v2", 2])
def test_unsupported_version_is_rejected(bad: object) -> None:
    raw = _v1_raw()
    if bad is None:
        raw.pop("version")
    else:
        raw["version"] = bad
    assert parse_market(raw) is None


def test_version_parse_is_case_and_space_insensitive() -> None:
    assert ProtocolVersion.parse("V2") is ProtocolVersion.V2
    assert ProtocolVersion.parse(" v1 ") is ProtocolVersion.V1
    assert ProtocolVersion.parse("v3") is None
    assert ProtocolVersion.parse(None) is None


def test_non_decimal_ids_are_rejected() -> None:
    assert parse_market(_v1_raw(clobTokenIds=json.dumps(["tok-yes", "tok-no"]))) is None
    assert parse_market(_v2_raw(positionIds=["pos-a", "pos-b"])) is None


def test_binary_only() -> None:
    assert parse_market(_v2_raw(positionIds=["1", "2", "3"],
                               outcomes=json.dumps(["A", "B", "C"]))) is None


def test_v2_missing_position_ids_is_rejected() -> None:
    assert parse_market(_v2_raw(positionIds=None)) is None


def test_is_decimal_id() -> None:
    assert is_decimal_id("123")
    assert not is_decimal_id("")
    assert not is_decimal_id("-1")
    assert not is_decimal_id("0x1")
    assert not is_decimal_id(123)


# ── resolution status ───────────────────────────────────────────────────────


def test_v2_reads_resolution_status_not_uma() -> None:
    resolved = parse_market(_v2_raw(resolutionStatus="resolved"))
    assert resolved is not None and resolved.resolved

    active = parse_market(_v2_raw(resolutionStatus="active"))
    assert active is not None and not active.resolved

    # a V1-only field must not resolve a V2 market
    decoy = parse_market(_v2_raw(resolutionStatus="inactive", umaResolutionStatus="resolved"))
    assert decoy is not None and not decoy.resolved


def test_v1_reads_uma_resolution_status() -> None:
    resolved = parse_market(_v1_raw(umaResolutionStatus="resolved"))
    assert resolved is not None and resolved.resolved

    none = parse_market(_v1_raw())
    assert none is not None and not none.resolved


# ── ledger routing ──────────────────────────────────────────────────────────


def test_ledger_and_asset_type_routing() -> None:
    assert ledger_for(ProtocolVersion.V1) == CTF_LEDGER
    assert ledger_for(ProtocolVersion.V2) == POSITION_MANAGER
    assert asset_type_for(ProtocolVersion.V1) == ASSET_TYPE_CTF
    assert asset_type_for(ProtocolVersion.V2) == ASSET_TYPE_V2


def test_market_meta_ledger_follows_version() -> None:
    v2 = parse_market(_v2_raw())
    v1 = parse_market(_v1_raw())
    assert v2 is not None and v1 is not None
    assert v2.ledger() == POSITION_MANAGER
    assert v1.ledger() == CTF_LEDGER


# ── position-id / condition-id arithmetic ───────────────────────────────────


def test_documented_position_id_layout() -> None:
    """Cross-check our masks against the numbers published in the docs."""
    yes = int(DOC_POSITION_YES)
    no = int(DOC_POSITION_NO)
    assert no - yes == 1, "outcomes differ only in the outcome byte"
    assert outcome_index_of(yes) == 0 and outcome_index_of(no) == 1
    assert module_id_of(yes) == 1, "BinaryModule"


def test_condition_id_field_is_high_248_bits() -> None:
    """The condition id is the position id shifted down one byte (high bits).

    ``positionId >> 8`` and ``positionId & ~0xFF`` are NOT interchangeable: the mask
    leaves a trailing zero byte, overstating the value by a factor of 256.
    """
    yes = int(DOC_POSITION_YES)
    assert condition_id_from_position_id(yes) == yes >> 8
    assert condition_id_from_position_id(yes) != (yes & ~0xFF), "off-by-one-byte trap"
    assert condition_id_from_position_id(yes) < 2**248, "must fit bytes31"


def test_narrow_v2_condition_id_accepts_padded_form_only() -> None:
    """Documented rule: validate the final byte is zero before narrowing."""
    ok = "0x" + "11" * 31 + "00"
    assert narrow_v2_condition_id(ok) == bytes.fromhex("11" * 31)

    not_padded = "0x" + "11" * 31 + "ff"
    assert narrow_v2_condition_id(not_padded) is None, "must not guess"

    assert narrow_v2_condition_id("0x" + "11" * 20) is None, "wrong width"
    assert narrow_v2_condition_id("not-hex") is None


def test_documented_example_reproduced_by_shift_and_by_narrowing() -> None:
    """Both documented paths agree on the published example.

    ``positionId >> 8`` equals the docs' conditionId, and narrowing that conditionId's
    bytes32 (leading zero byte) form yields the same 31 bytes — i.e. the prose means
    "zero-extend to 32 bytes on the left, then drop the spare byte".
    """
    yes = int(DOC_POSITION_YES)
    doc = int(DOC_CONDITION_31B, 16)

    assert condition_id_from_position_id(yes) == doc, "docs: conditionId = positionId>>8"
    assert v2_condition_id_bytes31(yes) == doc.to_bytes(31, "big")

    narrowed = narrow_v2_condition_id(DOC_CONDITION_31B)
    assert narrowed is not None
    assert narrowed == doc.to_bytes(31, "big")
    assert len(narrowed) == 31


def test_v2_condition_bytes31_fallback_is_width_correct() -> None:
    cond = v2_condition_id_bytes31(int(DOC_POSITION_YES))
    assert len(cond) == 31
    assert int.from_bytes(cond, "big") == condition_id_from_position_id(int(DOC_POSITION_YES))
    # same condition for either outcome
    assert v2_condition_id_bytes31(int(DOC_POSITION_NO)) == cond


def test_event_id_clears_condition_and_outcome() -> None:
    pos = int(DOC_POSITION_YES)
    assert event_id_of(pos) == pos & ~0xFFFFFF
    assert event_id_of(pos) % 2**24 == 0


def test_bytes31_rejects_overflow() -> None:
    with pytest.raises(OverflowError):
        bytes31(2**248)
    with pytest.raises(OverflowError):
        bytes31(-1)


# ── signing-domain routing (SDK level) ──────────────────────────────────────


def _capture_domains(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str]]:
    """Build real signed orders and record (exchange, domain_version) per order."""
    import py_clob_client_v2.order_builder.builder as builder_mod
    from py_clob_client_v2.order_utils.exchange_order_builder_v2 import (
        ExchangeOrderBuilderV2 as _Orig,
    )

    captured: list[tuple[str, str]] = []

    class _Spy(_Orig):  # type: ignore[misc]
        def __init__(self, contract_address, chain_id, signer, generate_salt=None,
                     domain_version="2"):  # type: ignore[no-untyped-def]
            captured.append((contract_address, domain_version))
            super().__init__(contract_address, chain_id, signer, domain_version=domain_version)

    monkeypatch.setattr(builder_mod, "ExchangeOrderBuilderV2", _Spy)
    return captured


def _sign(version: ProtocolVersion, token_id: str, neg_risk: bool,
          captured: list[tuple[str, str]]) -> None:
    from eth_account import Account
    from py_clob_client_v2.clob_types import OrderArgsV2, PartialCreateOrderOptions
    from py_clob_client_v2.constants import POLYGON
    from py_clob_client_v2.order_builder.builder import OrderBuilder
    from py_clob_client_v2.signer import Signer

    acct = Account.from_key("0x" + "11" * 32)
    signer = Signer(acct.key.hex(), POLYGON)

    class _B(OrderBuilder):
        def _v2_order_signer(self):  # type: ignore[no-untyped-def]
            return self.signer.address()

    b = _B(signer, 0, acct.address)
    opts = PartialCreateOrderOptions(tick_size="0.01", neg_risk=neg_risk)
    if version is ProtocolVersion.V2:
        args = OrderArgsV2(position_id=token_id, price=0.5, size=10, side="BUY")
    else:
        args = OrderArgsV2(token_id=token_id, price=0.5, size=10, side="BUY")
    b.build_order(args, opts)


def test_v2_signs_against_exchange_v3_with_domain_3(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _capture_domains(monkeypatch)
    _sign(ProtocolVersion.V2, DOC_POSITION_YES, False, captured)
    assert captured == [("0xe3333700cA9d93003F00f0F71f8515005F6c00Aa", "3")]


def test_v2_neg_risk_still_routes_to_exchange_v3(monkeypatch: pytest.MonkeyPatch) -> None:
    """ExchangeV3 handles neg-risk itself, so neg_risk must not divert the route."""
    captured = _capture_domains(monkeypatch)
    _sign(ProtocolVersion.V2, DOC_POSITION_YES, True, captured)
    assert captured == [("0xe3333700cA9d93003F00f0F71f8515005F6c00Aa", "3")]


def test_v1_signs_against_ctf_exchange_with_domain_2(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _capture_domains(monkeypatch)
    _sign(ProtocolVersion.V1, CTF_YES, False, captured)
    assert captured == [("0xE111180000d2663C0091e4f400237545B87B996B", "2")]


def test_v1_neg_risk_routes_to_neg_risk_exchange(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _capture_domains(monkeypatch)
    _sign(ProtocolVersion.V1, CTF_YES, True, captured)
    assert captured == [("0xe2222d279d744050d28e00520010520000310F59", "2")]


# ── gateway routing ─────────────────────────────────────────────────────────


def _meta(version: ProtocolVersion, token: str) -> MarketMeta:
    other = "99999999999999999999999999999999999999999999999999999999999999999999"
    return MarketMeta(
        condition_id="0x" + "ab" * 32,
        question="q", slug="s",
        tokens=(TokenMeta(token, "Yes"), TokenMeta(other, "No")),
        tick_size=0.01, neg_risk=False, min_order_size=5.0,
        rewards_min_size=10.0, rewards_max_spread=3.0, rewards_daily_rate=0.0,
        maker_fee_bps=0, taker_fee_bps=0, fees_enabled=False,
        end_date_iso=None, event_id=None, version=version,
    )


def test_gateway_place_passes_position_id_for_v2() -> None:
    from polymaker.domain import Quote, Side
    from polymaker.execution.gateway import ExecutionGateway

    calls: list[dict[str, object]] = []

    class _Client:
        def create_order(self, args, options=None):  # type: ignore[no-untyped-def]
            calls.append({"position_id": getattr(args, "position_id", None),
                          "token_id": args.token_id})
            return {"signed": True}

        def post_orders(self, args, post_only=True):  # type: ignore[no-untyped-def]
            return [{"orderID": "o1"}]

    class _Cfg:
        class execution:  # noqa: N801
            post_only = True
            rate_budget_fraction = 0.25
        class wallet:  # noqa: N801
            data_api_host = "https://data-api.polymarket.com"

    gw = ExecutionGateway(_Cfg())  # type: ignore[arg-type]
    gw._paper = False
    gw._client = _Client()

    import asyncio as _asyncio

    v2 = _meta(ProtocolVersion.V2, DOC_POSITION_YES)
    _asyncio.run(gw.place([Quote(DOC_POSITION_YES, Side.BUY, 0.5, 10)], v2))
    assert calls[0]["position_id"] == DOC_POSITION_YES, "V2 must use position_id"
    assert calls[0]["token_id"] is None

    calls.clear()
    v1 = _meta(ProtocolVersion.V1, CTF_YES)
    _asyncio.run(gw.place([Quote(CTF_YES, Side.BUY, 0.5, 10)], v1))
    assert calls[0]["token_id"] == CTF_YES, "V1 must use token_id"
    assert calls[0]["position_id"] is None


async def _noop() -> None:
    return None
