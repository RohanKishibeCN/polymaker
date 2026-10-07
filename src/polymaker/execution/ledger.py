"""ERC-1155 ledger routing for Polymarket's two position systems.

Outcome shares live in exactly one of two ledgers, chosen by the market's
protocol version (Gamma's `version` field):

  * ``v1`` / CTF            -> Conditional Tokens
  * ``v2`` / Polymarket V2  -> PositionManager

The two systems use unrelated id spaces. Polymarket's docs are explicit:
"Do not send a CTF token ID to PositionManager or a Position ID to Conditional
Tokens." Sending one system's id to the other does not error — it simply reads
zero, which is why every balance read must be routed by version rather than
defaulted.

This module exists separately from ``execution.gateway`` so that pure domain code
(``MarketMeta.ledger()``) can route ledgers without importing the execution layer.
"""

from __future__ import annotations

from polymaker.domain import ProtocolVersion

# ── Polygon mainnet (chain 137) ─────────────────────────────────────────────
CTF_LEDGER = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"  # Conditional Tokens
POSITION_MANAGER = "0x006F54F7f9A22e0000CC2AB60031000000ae9fEF"  # Polymarket V2

# pUSD (CollateralToken) — the collateral for BOTH systems.
PUSD = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB"

# V2 settlement contracts.
EXCHANGE_V3 = "0xe3333700cA9d93003F00f0F71f8515005F6c00Aa"
ROUTER = "0x12121212006e4CD160D18e3f00711DA5c3372600"
AUTO_REDEEMER = "0xa1200000d0002264C9a1698e001292D00E1b00af"

# Legacy V1 exchange contracts (for reference / assertions).
CTF_EXCHANGE_V2 = "0xE111180000d2663C0091e4f400237545B87B996B"
NEG_RISK_EXCHANGE_V2 = "0xe2222d279d744050d28e00520010520000310F59"

# The CLOB's balance-allowance `asset_type` selector per position system.
ASSET_TYPE_CTF = "CONDITIONAL"
ASSET_TYPE_V2 = "CONDITIONAL-V2"
ASSET_TYPE_COLLATERAL = "COLLATERAL"

_LEDGERS: dict[ProtocolVersion, str] = {
    ProtocolVersion.V1: CTF_LEDGER,
    ProtocolVersion.V2: POSITION_MANAGER,
}

# Minimal ERC-1155 read surface shared by both ledgers.
ERC1155_ABI = [
    {
        "name": "balanceOf",
        "type": "function",
        "stateMutability": "view",
        "inputs": [{"name": "account", "type": "address"}, {"name": "id", "type": "uint256"}],
        "outputs": [{"name": "", "type": "uint256"}],
    }
]


def ledger_for(version: ProtocolVersion) -> str:
    """The ERC-1155 contract owning outcome balances for this protocol version."""
    return _LEDGERS[version]


def asset_type_for(version: ProtocolVersion) -> str:
    """The CLOB `asset_type` selector used to read outcome balances for a version.

    The migration guide documents ``CONDITIONAL-V2`` for V2 positions and
    ``CONDITIONAL`` for CTF positions. Note that ``CONDITIONAL-V2`` is absent from
    the published CLOB OpenAPI enum, so callers must tolerate a rejected request.
    """
    return ASSET_TYPE_V2 if version is ProtocolVersion.V2 else ASSET_TYPE_CTF


def module_id_of(position_id: int) -> int:
    """Top byte of a V2 position id: 1=Binary, 2=NegRisk, 3=Combinatorial."""
    return position_id >> 248


def outcome_index_of(position_id: int) -> int:
    """Low byte of a V2 position id: 0 = YES, 1 = NO."""
    return position_id & 0xFF


def condition_id_of(position_id: int) -> int:
    """Strip the outcome byte, yielding the (bytes31) V2 condition id as an int."""
    return position_id & ~0xFF


def event_id_of(position_id: int) -> int:
    """Strip the condition and outcome fields, yielding the (bytes29) event id."""
    return position_id & ~0xFFFFFF


def bytes31(value: int) -> bytes:
    """Encode an int as exactly 31 big-endian bytes (V2 condition-id width).

    Raises ValueError if the value needs more than 31 bytes, which would mean it
    is not a valid V2 condition id.
    """
    return value.to_bytes(31, "big")


def condition_id_from_position_id(position_id: int) -> int:
    """The condition-id field of a V2 position id, as an int.

    The documented layout puts the condition id in the position id's HIGH bits
    (``conditionId = positionId with bits 0..7 cleared``), so the field itself is
    the id shifted down by one byte.
    """
    return position_id >> 8


def v2_condition_id_bytes31(position_id: int) -> bytes:
    """Best-effort bytes31 V2 condition id from a position id (FALLBACK PATH).

    NOT VERIFIED against a live V2 market. The docs' contract-migration prose says a
    bytes32 boundary value is "right-padded with zero bytes", while the documented
    example in /market-data/discover-markets does not reproduce under
    ``positionId >> 8``. With no live V2 market available to settle it, this
    fallback left-zero-extends the field (the layout-consistent reading).

    Prefer `narrow_v2_condition_id` with Gamma's own `conditionId`; only use this
    when no condition id is at hand, and expect to re-verify it against a live
    market before enabling V2 on-chain operations (see `wallet.merge_v2_enabled`).
    """
    if position_id < 0:
        raise ValueError(f"negative position id: {position_id}")
    return bytes31(condition_id_from_position_id(position_id))


def narrow_v2_condition_id(condition_id: str) -> bytes | None:
    """Normalise Gamma's V2 condition id into the bytes31 the Router expects.

    Accepts either the already-31-byte form or a 32-byte zero-extended form. The
    documented guard is kept: "For a padded V2 bytes32 value, validate its final byte
    is zero before narrowing." A non-zero final byte means the value is not the padded
    form, so we refuse rather than construct a bogus condition id.
    """
    raw = _hex_to_bytes(condition_id)
    if raw is None:
        return None
    if len(raw) == 31:
        return raw
    if len(raw) == 32:
        if raw[-1] != 0:
            return None
        return raw[:31]
    return None


def _hex_to_bytes(value: str) -> bytes | None:
    text = value[2:] if value.startswith(("0x", "0X")) else value
    if len(text) % 2:
        text = "0" + text
    try:
        return bytes.fromhex(text)
    except ValueError:
        return None


def is_decimal_id(value: object) -> bool:
    """True for a non-empty all-digit string (the only id form docs permit)."""
    return isinstance(value, str) and value.isdigit() and len(value) > 0
