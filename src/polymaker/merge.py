"""Native Python position merger (replaces the Node.js poly_merger subprocess).

When we hold both YES and NO in the same market, merging the pair returns
collateral (1 USDC/pUSD per pair) — a maker-only exit with zero market impact.

Execution paths by wallet type (config.wallet.signature_type):
  * EOA (0):        direct contract call (`_merge_eoa`).
  * Gnosis Safe (2): wrapped in the Safe's `execTransaction`, owner eth_sign (`_merge_safe`).
  * Polymarket V2 DepositWallet (1/3): `_merge_deposit_wallet` — the wallet's `execute()`
    ONLY accepts calls from its factory (driven by Polymarket's relayer), so we sign an
    EIP-712 batch (owner) and submit it via the builder relayer (gasless — relayer pays).
    Verified live 2026-07-09 (LeBron neg-risk merge, tx 0x4d2a2064). Needs self-generated
    builder API creds (clob.create_builder_api_key) in .env. See memory merge-deposit-wallet.
"""

from __future__ import annotations

from typing import Any

from polymaker.config import Config
from polymaker.domain import ProtocolVersion
from polymaker.execution.ledger import narrow_v2_condition_id, v2_condition_id_bytes31
from polymaker.logging import get_logger

log = get_logger("merge")

# Polygon mainnet contracts.
# NOTE: the CLOB-v1 Neg Risk Adapter (0xd91E80cF...296) was deprecated 2026-07-14 with a
# grace period that ended 2026-07-17; relayer calls to it are fully retired, so the old
# address silently fails for DepositWallet (sig_type 1/3) merges. Use the current adapter.
CONDITIONAL_TOKENS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"
NEG_RISK_ADAPTER = "0xadA2005600Dec949baf300f4C6120000bDB6eAab"  # NegRiskCtfCollateralAdapter
LEGACY_NEG_RISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296"  # deprecated, do not use
USDC_COLLATERAL = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
# pUSD is what the collateral adapters and V2 position ops expect as collateralToken.
PUSD_COLLATERAL = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB"

# ── Polymarket Protocol V2 position operations (Router) ─────────────────────
# V2 positions live in PositionManager, not CTF, and split/merge/redeem through the
# Router. The condition id is bytes31 (CTF's is bytes32) and outcomeIndex is 0=YES /
# 1=NO, replacing CTF's index sets 1/2.
ROUTER = "0x12121212006e4CD160D18e3f00711DA5c3372600"
POSITION_MANAGER = "0x006F54F7f9A22e0000CC2AB60031000000ae9fEF"

_ROUTER_ABI = [
    {
        "name": "merge",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "conditionId", "type": "bytes31"},
            {"name": "amount", "type": "uint256"},
        ],
        "outputs": [],
    },
    {
        "name": "split",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "conditionId", "type": "bytes31"},
            {"name": "amount", "type": "uint256"},
        ],
        "outputs": [],
    },
]

_CTF_ABI = [
    {
        "name": "mergePositions",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "collateralToken", "type": "address"},
            {"name": "parentCollectionId", "type": "bytes32"},
            {"name": "conditionId", "type": "bytes32"},
            {"name": "partition", "type": "uint256[]"},
            {"name": "amount", "type": "uint256"},
        ],
        "outputs": [],
    }
]
_NEG_RISK_ABI = [
    {
        "name": "mergePositions",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "conditionId", "type": "bytes32"},
            {"name": "amount", "type": "uint256"},
        ],
        "outputs": [],
    }
]
# Gnosis Safe (Polymarket proxy wallet) — the merge tx is routed through the Safe's
# execTransaction, owner-signed. Ported from the old poly_merger/safe-helpers.js.
_ZERO = "0x0000000000000000000000000000000000000000"
_SAFE_ABI = [
    {"name": "nonce", "type": "function", "stateMutability": "view", "inputs": [],
     "outputs": [{"type": "uint256"}]},
    {"name": "getTransactionHash", "type": "function", "stateMutability": "view",
     "inputs": [{"name": "to", "type": "address"}, {"name": "value", "type": "uint256"},
                {"name": "data", "type": "bytes"}, {"name": "operation", "type": "uint8"},
                {"name": "safeTxGas", "type": "uint256"}, {"name": "baseGas", "type": "uint256"},
                {"name": "gasPrice", "type": "uint256"}, {"name": "gasToken", "type": "address"},
                {"name": "refundReceiver", "type": "address"}, {"name": "_nonce", "type": "uint256"}],
     "outputs": [{"type": "bytes32"}]},
    {"name": "execTransaction", "type": "function", "stateMutability": "payable",
     "inputs": [{"name": "to", "type": "address"}, {"name": "value", "type": "uint256"},
                {"name": "data", "type": "bytes"}, {"name": "operation", "type": "uint8"},
                {"name": "safeTxGas", "type": "uint256"}, {"name": "baseGas", "type": "uint256"},
                {"name": "gasPrice", "type": "uint256"}, {"name": "gasToken", "type": "address"},
                {"name": "refundReceiver", "type": "address"}, {"name": "signatures", "type": "bytes"}],
     "outputs": [{"type": "bool"}]},
]
class Merger:
    def __init__(self, cfg: Config) -> None:
        self._cfg = cfg
        self._w3: Any = None
        self._account: Any = None

    def _ensure_web3(self) -> None:
        """Build a Web3 client with a HARD request timeout and endpoint fallback.

        Without a timeout a single hung RPC call blocks forever — and because every
        merge runs under the engine's chain lock, that permanently disables all merges
        with no exception and no alert. Mirrors the fallback list used for balances.
        """
        if self._w3 is not None:
            return
        from eth_account import Account
        from web3 import Web3
        from web3.middleware import ExtraDataToPOAMiddleware

        configured = self._cfg.secrets.polygon_rpc or self._cfg.wallet.polygon_rpc
        rpcs = [configured, "https://polygon-bor-rpc.publicnode.com",
                "https://polygon.llamarpc.com", "https://rpc.ankr.com/polygon"]
        last: Exception | None = None
        for rpc in dict.fromkeys(rpcs):
            try:
                w3 = Web3(Web3.HTTPProvider(rpc, request_kwargs={"timeout": 20}))
                w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)
                _ = w3.eth.block_number  # fail fast on a dead endpoint
                self._w3 = w3
                self._account = Account.from_key(self._cfg.secrets.pk)
                return
            except Exception as exc:  # noqa: BLE001, PERF203 - try the next endpoint
                last = exc
                continue
        raise RuntimeError(f"no usable polygon RPC endpoint (last error: {last})")

    @property
    def can_merge(self) -> bool:
        """EOA (0) and Gnosis Safe (2) merge on-chain directly. The V2 DepositWallet
        (1/3) merges via the builder relayer — possible only when builder creds are
        configured (self-generate once with clob.create_builder_api_key)."""
        st = self._cfg.wallet.signature_type
        if st in (0, 2):
            return True
        return self._cfg.secrets.has_builder_creds

    def merge(
        self,
        condition_id: str,
        amount_raw: int,
        neg_risk: bool,
        version: ProtocolVersion = ProtocolVersion.V1,
        position_id: str | None = None,
    ) -> str | None:
        """Merge `amount_raw` (6-dec) YES+NO pairs. Returns tx hash or None.

        V1/CTF merges through Conditional Tokens (or the Neg Risk Adapter). V2 merges
        through the Router and takes a bytes31 condition id, derived from the
        position id when one is supplied.
        """
        if amount_raw <= 0 or not self.can_merge:
            return None
        try:
            if version is ProtocolVersion.V2:
                return self._merge_v2(condition_id, amount_raw, position_id)
            st = self._cfg.wallet.signature_type
            if st == 0:
                return self._merge_eoa(condition_id, amount_raw, neg_risk)
            if st == 2:  # POLY_GNOSIS_SAFE
                return self._merge_safe(condition_id, amount_raw, neg_risk)
            return self._merge_deposit_wallet(condition_id, amount_raw, neg_risk)  # 1/3
        except Exception as exc:  # noqa: BLE001
            log.error("merge_failed", condition=condition_id[:12], err=str(exc),
                      version=version.value)
            return None

    def _merge_v2(
        self, condition_id: str, amount_raw: int, position_id: str | None
    ) -> str | None:
        """Merge V2 positions through the Router.

        The Router takes `merge(bytes31 conditionId, uint256 amount)` and pulls the
        pairs from the caller via PositionManager operator approval
        (`setApprovalForAll(ROUTER, true)`) — an approval the existing CTF grants do
        NOT cover. Without it the tx reverts, so we refuse rather than burn gas.

        Gated behind `wallet.merge_v2_enabled` (default off): the calldata shape is
        derived from documented ABIs and verified offline, but has not yet been
        exercised against a live V2 market. Enable only after a small live merge.
        """
        if not self._cfg.wallet.merge_v2_enabled:
            log.warning("merge_v2_disabled", condition=condition_id[:12],
                        hint="set wallet.merge_v2_enabled=true after verifying a live merge")
            return None

        self._ensure_web3()
        w3 = self._w3
        cond = self._v2_condition_bytes31(condition_id, position_id)
        if cond is None:
            return None

        c = w3.eth.contract(address=w3.to_checksum_address(ROUTER), abi=_ROUTER_ABI)
        fn = c.functions.merge(cond, amount_raw)
        # Build via the deposit wallet (sig 1/3) or directly from the EOA.
        if self._cfg.wallet.signature_type in (0, 2):
            tx = fn.build_transaction({
                "from": self._account.address,
                "nonce": w3.eth.get_transaction_count(self._account.address),
                "chainId": self._cfg.wallet.chain_id,
                "gas": 400_000,
                "maxFeePerGas": w3.eth.gas_price * 2,
                "maxPriorityFeePerGas": w3.to_wei(30, "gwei"),
            })
            signed = self._account.sign_transaction(tx)
            tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
        else:
            data = fn.build_transaction(
                {"gas": 0, "gasPrice": 0, "nonce": 0, "chainId": self._cfg.wallet.chain_id}
            )["data"]
            tx_hash = self._relay_deposit_wallet_call(w3.to_checksum_address(ROUTER), data)

        receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=180)
        status = receipt.get("status", 1)
        h = str(receipt["transactionHash"].hex())
        log.info("merge_v2_sent", condition=condition_id[:12], amount=amount_raw,
                 tx=h[:14], status=status)
        if status != 1:
            raise RuntimeError(f"router v2 merge reverted: {h}")
        return h

    def _v2_condition_bytes31(self, condition_id: str, position_id: str | None) -> bytes | None:
        """bytes31 condition id for Router V2 calls.

        Prefers narrowing Gamma's own bytes32 `conditionId` (authoritative) and only
        falls back to deriving from the position id, which is the unverified path.
        """
        narrowed = narrow_v2_condition_id(condition_id)
        if narrowed is not None:
            return narrowed
        log.warning("merge_v2_condition_not_padded", condition=condition_id[:24],
                    hint="using derived position-id fallback (unverified)")
        if position_id is not None and str(position_id).isdigit():
            return v2_condition_id_bytes31(int(position_id))
        return None

    def _relay_deposit_wallet_call(self, target: str, data: str) -> str:
        """Submit one call through the DepositWallet + builder relayer (gasless)."""
        import os
        import time as _time

        from py_builder_relayer_client.client import RelayClient
        from py_builder_relayer_client.models import DepositWalletCall
        from py_builder_signing_sdk.config import BuilderConfig
        from py_builder_signing_sdk.sdk_types import BuilderApiKeyCreds

        w3, sec = self._w3, self._cfg.secrets
        if self._cfg.proxy:
            for k in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
                      "http_proxy", "https_proxy", "all_proxy"):
                os.environ[k] = self._cfg.proxy
        creds = BuilderApiKeyCreds(
            key=sec.builder_key, secret=sec.builder_secret, passphrase=sec.builder_passphrase)
        client = RelayClient(
            sec.relayer_url, self._cfg.wallet.chain_id, private_key=sec.pk,
            builder_config=BuilderConfig(local_builder_creds=creds))
        nonce = client.get_nonce(self._account.address, "WALLET")["nonce"]
        deadline = str(int(_time.time()) + 3600)
        call = DepositWalletCall(target=target, value="0", data=data)
        resp = client.execute_deposit_wallet_batch(
            [call], w3.to_checksum_address(sec.browser_address), nonce, deadline)
        return str(getattr(resp, "transaction_hash", None) or getattr(resp, "hash", None))

    def _merge_eoa(self, condition_id: str, amount_raw: int, neg_risk: bool) -> str:
        self._ensure_web3()
        w3 = self._w3
        addr = self._account.address
        cond = _to_bytes32(condition_id)

        if neg_risk:
            c = w3.eth.contract(address=w3.to_checksum_address(NEG_RISK_ADAPTER), abi=_NEG_RISK_ABI)
            fn = c.functions.mergePositions(cond, amount_raw)
        else:
            c = w3.eth.contract(address=w3.to_checksum_address(CONDITIONAL_TOKENS), abi=_CTF_ABI)
            fn = c.functions.mergePositions(
                w3.to_checksum_address(USDC_COLLATERAL),
                b"\x00" * 32,  # parent collection id (top-level market)
                cond,
                [1, 2],  # partition: the two outcome slots
                amount_raw,
            )

        tx = fn.build_transaction(
            {
                "from": addr,
                "nonce": w3.eth.get_transaction_count(addr),
                "chainId": self._cfg.wallet.chain_id,
                "gas": 300_000,
                "maxFeePerGas": w3.eth.gas_price * 2,
                "maxPriorityFeePerGas": w3.to_wei(30, "gwei"),
            }
        )
        signed = self._account.sign_transaction(tx)
        tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
        receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
        h = str(receipt["transactionHash"].hex())
        log.info("merge_sent", condition=condition_id[:12], amount=amount_raw, tx=h[:14])
        return h

    def _inner_merge_call(self, condition_id: str, amount_raw: int, neg_risk: bool) -> tuple[str, str]:
        """Build the CTF/adapter mergePositions call → (to, calldata-hex)."""
        w3 = self._w3
        cond = _to_bytes32(condition_id)
        if neg_risk:
            to = w3.to_checksum_address(NEG_RISK_ADAPTER)
            c = w3.eth.contract(address=to, abi=_NEG_RISK_ABI)
            fn = c.functions.mergePositions(cond, amount_raw)
        else:
            to = w3.to_checksum_address(CONDITIONAL_TOKENS)
            c = w3.eth.contract(address=to, abi=_CTF_ABI)
            fn = c.functions.mergePositions(
                w3.to_checksum_address(USDC_COLLATERAL), b"\x00" * 32, cond, [1, 2], amount_raw)
        # encode calldata offline (explicit gas/nonce -> no RPC estimation)
        data = fn.build_transaction(
            {"gas": 0, "gasPrice": 0, "nonce": 0, "chainId": self._cfg.wallet.chain_id})["data"]
        return to, data

    def _merge_safe(self, condition_id: str, amount_raw: int, neg_risk: bool) -> str:
        """Route the merge through the Polymarket proxy/Gnosis Safe: build the
        mergePositions call, wrap it in the Safe's execTransaction, and owner-sign
        the Safe tx hash with the eth_sign flavor (v += 4). Ported from the old
        poly_merger/safe-helpers.js."""
        from eth_account.messages import encode_defunct

        self._ensure_web3()
        w3, signer = self._w3, self._account
        to, data = self._inner_merge_call(condition_id, amount_raw, neg_risk)

        safe_addr = w3.to_checksum_address(self._cfg.secrets.browser_address)
        safe = w3.eth.contract(address=safe_addr, abi=_SAFE_ABI)
        s_nonce = safe.functions.nonce().call()
        # Safe tx: value=0, operation=CALL(0), all gas/refund fields 0 (owner pays gas)
        safe_tx_hash = safe.functions.getTransactionHash(
            to, 0, data, 0, 0, 0, 0, _ZERO, _ZERO, s_nonce).call()

        sig = signer.sign_message(encode_defunct(primitive=bytes(safe_tx_hash)))
        raw = bytes(sig.signature)                     # r(32)+s(32)+v(1), v in {27,28}
        packed = raw[:64] + bytes([raw[64] + 4])       # Safe eth_sign signature: v += 4

        tx = safe.functions.execTransaction(
            to, 0, data, 0, 0, 0, 0, _ZERO, _ZERO, packed
        ).build_transaction({
            "from": signer.address,
            "nonce": w3.eth.get_transaction_count(signer.address),
            "chainId": self._cfg.wallet.chain_id,
            "gas": 600_000,
            "maxFeePerGas": w3.eth.gas_price * 2,
            "maxPriorityFeePerGas": w3.to_wei(30, "gwei"),
        })
        signed = signer.sign_transaction(tx)
        tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
        receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=180)
        h = str(receipt["transactionHash"].hex())
        status = receipt.get("status", 1)
        log.info("merge_sent_safe", condition=condition_id[:12], amount=amount_raw,
                 tx=h[:14], status=status)
        if status != 1:
            raise RuntimeError(f"safe merge reverted: {h}")
        return h

    def _merge_deposit_wallet(self, condition_id: str, amount_raw: int, neg_risk: bool) -> str:
        """Merge via Polymarket's V2 DepositWallet + builder relayer (gasless).

        The wallet's execute() only accepts calls from its factory (driven by the
        relayer), so we can't self-submit. Instead sign an EIP-712 batch (owner) with
        the mergePositions call and POST it to the relayer, which submits on-chain and
        pays the gas. Requests route through cfg.proxy (Polymarket geo-blocks). Verified
        live 2026-07-09 (neg-risk merge, tx 0x4d2a2064)."""
        self._ensure_web3()
        w3 = self._w3
        to, data = self._inner_merge_call(condition_id, amount_raw, neg_risk)
        h = self._relay_deposit_wallet_call(w3.to_checksum_address(to), data)
        receipt = w3.eth.wait_for_transaction_receipt(h, timeout=180)
        status = receipt.get("status", 1)
        log.info("merge_sent_deposit_wallet", condition=condition_id[:12],
                 amount=amount_raw, tx=h[:14], status=status)
        if status != 1:
            raise RuntimeError(f"deposit-wallet merge reverted: {h}")
        return h


def _to_bytes32(hex_str: str) -> bytes:
    s = hex_str[2:] if hex_str.startswith("0x") else hex_str
    return bytes.fromhex(s.rjust(64, "0"))
