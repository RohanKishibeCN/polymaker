# Adversarial review — execution / state / merge surface

Scope (read in full): `execution/gateway.py`, `execution/ledger.py`, `execution/reconciler.py`,
`state/store.py`, `state/tracker.py`, `userstream/parse.py`, `userstream/client.py`, `merge.py`.
Cross-read for call-site impact: `engine.py`, `risk/manager.py`, `doctor.py`, `moneydoctor.py`,
`livetest.py`, `domain.py`, `catalog/gamma.py`, `execution/ratelimit.py`, and the installed
`py-clob-client-v2==1.2.0` in `.venv` (confirmed: `OrderArgsV2`/`MarketOrderArgsV2` really do take
`position_id`, and `position_id` selects the ExchangeV3/domain-"3" route — so change #1/#4 are
wired to a real SDK capability, not a fabricated one).

Ranked by severity. "Trigger" = the concrete sequence that produces the failure.

---

## C1 — CRITICAL — `open_orders()` returns `[]` on failure, and callers treat `[]` as authoritative truth → duplicate live orders

`src/polymaker/execution/gateway.py:563-567` (returns `[]` on any exception) and
`src/polymaker/execution/gateway.py:552` + `:559-560` (a per-row parse failure is swallowed with
`continue`, so an *unexpected field name* silently produces an empty list with no warning).

Consumers that treat that empty list as a server-side snapshot:

- `engine.py:694` → `state.replace_open_orders(tok, by_token.get(tok, []))`, `grace_s` default
  `10.0` (`store.py:175`). Livecfg has `reconcile_interval_s = 20`, so **every** local order older
  than 10 s is dropped even though it is still resting at the exchange.
- `engine.py:572` (`_quarantine` → `_refresh_token_orders(meta)`, `grace_s=0.0`, `store.py:574`)
  and `engine.py:646` (heartbeat recovery, `grace_s=0.0`) wipe **all** local orders, including
  ones placed 200 ms ago.
- `engine.py:280-282` (startup) uses `grace_s=0.0` too.

Trigger (transient): the CLOB returns 429 on `/orders` for all 3 attempts, or the proxy hiccups →
`_get` raises → `return []`. Reconcile loop wipes the local order book → the quoter's next tick
(≤60 s baseline, or instantly on any book update) sees `state.orders_for()` empty → `reconcile()`
returns the full target set as `to_place` → `place()` re-posts **a second copy of every quote**.
The copies are untracked; the next successful reconcile re-adopts both and cancels the extra, so a
transient failure costs ~1 quoter tick of doubled exposure (two identical post-only orders at the
same price can both be filled by one sweep).

Trigger (deterministic, unbounded): `_get` requires `r["asset_id"]` (line 552) and
`r["side"]`/`r["price"]` in v1 names. If the CLOB's order rows are keyed differently for V2
(`position_id`/`token_id`) — which I could **not** verify offline — every row raises `KeyError` and
is swallowed by `except (KeyError, ValueError, TypeError): continue`. `open_orders()` then returns
`[]` *forever, with no warning*. Every quoter tick re-places a fresh copy of the whole target set;
none of the copies is ever tracked, and `cancel()` can never be issued for them (we never learn
their ids). Exposure grows linearly (~1 extra order set per minute per market) until the risk caps
trip on *positions*, not on orders — i.e. only after the extra orders fill.

Why the docstring's own rule is violated: `cancel()` (line 274-276) correctly documents "callers
must NOT drop the orders from local state on failure" — the same discipline is missing for
`open_orders()`. Fix: return `list[OpenOrder] | None` (None on failure / unexpected shape) and make
every `replace_open_orders` call site skip the wipe on `None`; add a `log.error` when rows are
present but the shape is unparsable (count skipped rows).

---

## C2 — HIGH — shutdown race leaves a live, untracked order (cancel-all runs while a `place()` POST is still in flight)

`engine.py:159-172`: `shutdown()` calls `t.cancel()` on every task **without awaiting them**, then
`await self.gateway.cancel_all()` (line 168) and `self.gateway.close()` (line 169 →
`gateway.py:138-139`, `ThreadPoolExecutor.shutdown(wait=False, cancel_futures=True)`).

`cancel_futures=True` only cancels *queued* work; a POST already executing inside an `clio-io`
thread cannot be cancelled. A quoter task parked in `await self._io(_place)` (`gateway.py:251`)
receives `CancelledError` at the await point, but the thread keeps running and the exchange can
accept the order **after** `cancel_all` has returned. `close(wait=False)` then lets the interpreter
exit. Result: a resting order with no local record, at process exit, with nobody left to cancel it
(the dead-man heartbeat helps only if the exchange honours a broken chain — `_hb_id` is a module
state we just destroyed).

Fix: `await asyncio.gather(*tasks, return_exceptions=True)` after cancelling, then drain the pool
(`self._pool.shutdown(wait=True)` or an `_io`-in-flight counter) **before** `cancel_all()`, and
re-verify with `open_orders()` after `cancel_all()`.

---

## C3 — HIGH — a FAILED trade reverses the position but never reverses cash → fake losses can trip the global kill switch

`tracker.py:88-98`: on `FAILED`, the code calls `self._store.apply_fill(...:reverse...)` directly and
**never** calls `self._on_fill(...)`. `_on_fill` is the only caller of `risk.note_fill`
(`engine.py:368-369`), and `note_fill` is the only writer of `_net_cash`
(`risk/manager.py:41-42`). Verified by grep: `note_fill(` has exactly one call site.

So after `MATCHED(BUY 100 @ 0.50)` → `FAILED`, the position returns to 0 but `_net_cash` keeps
`-50.0`. `equity = net_cash + inventory_value` (line 64) is permanently understated by the failed
notional; `daily_pnl` (line 68) goes negative; `daily_loss_kill_usdc` (line 87) halts **all**
markets and cancels everything ("manual_kill"/`daily_loss`) on money that was never spent. Several
failed matches (common on a chain with retries — `RETRYING` is expected traffic) can be enough.
The divergence check does not repair cash (it only `force_set_position`s).

Fix: route the reversal through `_on_fill` (or add an explicit `risk.note_fill(reverse_fill)` inside
the FAILED branch) so cash and inventory stay consistent.

---

## C4 — HIGH — `reconcile_positions()` can never zero a position that vanished from the API, and the engine skips reconcile entirely on an empty result

`store.py:119-128` iterates only the tokens present in `api_positions`; it never zeroes a *tracked*
token that the API no longer lists (the exchange closed it: merge, redeem, manual sell, liquidation).
`engine.py:674` compounds it: `if positions:` — an all-zero filter result does nothing.

Trigger: hold 300 YES/300 NO; the merger (or the operator) merges the pairs; on-chain YES/NO → 0 and
`/v2/positions?status=OPEN` no longer returns those tokens. Internal state keeps 300/300 forever
unless the chain divergence check happens to run for those tokens: `_check_position_divergence`
(`engine.py:712-749`) runs only `if rounds % 4 == 0` (≈80 s at the live 20 s cadence) and **skips
tokens with `inflight > 0`** (line 725) — precisely the tokens that just had a merge/fill.
In the meantime the quoter believes it is long 300 shares: it quotes SELLs it cannot deliver (order
rejections, error-rate breaker), `_maybe_merge` keeps computing a mergeable amount from phantom
inventory, and `_next_wake_s` fast-ticks a market with no inventory.

Fix: make the API read authoritative and symmetric — for every tracked token, `reconcile_positions`
should set size to `api.get(tok, 0.0)` (respecting the in-flight/recent-fill guards), which requires
C13 to be fixed first (a truncated read must not be treated as complete).

---

## C5 — HIGH — merges can be silently disabled forever, and a hung RPC wedges the merge lock permanently

a) `merge.py:159` returns `None` for `not self.can_merge`, and `engine.py:613` only alerts
`if tx is None and self.merger.can_merge`. With sig_type 3 (`livecfg/config.toml:4`) `can_merge`
requires `secrets.has_builder_creds` (`merge.py:143`). If the builder creds are absent/expired, every
`_maybe_merge` → `_merge_task` → `merge()` returns `None`, and the one alert that was supposed to end
the silence is gated off. Inventory simply never exits via merge, with no signal.

b) `merge.py:130` builds `Web3(Web3.HTTPProvider(rpc))` with **no request timeout** (contrast
`gateway.py:477`, which passes `request_kwargs={"timeout": 15}` and tries four endpoints). All merge
work happens inside `async with self._chain_lock:` (`engine.py:594`) and `asyncio.to_thread(...)`
(line 609). One hung `eth_getTransactionCount`/`sendRawTransaction`/`wait_for_transaction_receipt`
thread blocks the lock **forever**: every later merge awaits it, `self._merging.discard(cid)`
(`engine.py:623`) never runs for that market, and no exception is ever raised, so no alert fires.
Only one RPC endpoint is configured — no fallback.

Fix: `request_kwargs={"timeout": 15}`, multi-endpoint fallback (reuse `gateway._rpc`'s list),
`asyncio.wait_for` around the thread call, and alert on `can_merge is False`.

---

## C6 — HIGH (UNCERTAIN) — the CTF merge passes USDC.e as `collateralToken` while `PUSD_COLLATERAL` is defined and never used

`merge.py:34` `USDC_COLLATERAL = 0x2791Bca1...` is passed to
`CTF.mergePositions(collateralToken, ...)` at `merge.py:283` (EOA) and `merge.py:319`
(`_inner_merge_call`, the path used by sig_type 2/3 — i.e. the live `signature_type = 3`).
`merge.py:36` `PUSD_COLLATERAL = 0xC011a7E1...` is **dead code** — grep shows zero uses. The V2
Router branch instead derives everything from `conditionId`.

The CTF position id is a hash over (collateralToken, collectionId, conditionId, indexSet), so passing
the wrong collateral does not merge our pUSD-backed shares — it targets a different, empty position
set, which reverts. Under `signature_type=3` the revert happens through the relayer; `merge()`
catches it (`merge.py:170-173`) and returns `None` → alert only (no fund loss), but the primary
zero-impact exit is dead for every market.

Uncertainty: this is only a bug if the live V1 markets are pUSD-collateralised. The repo's own
migration report (§2.5 "抵押品仍是 pUSD `0xC011a7E1…` (6 位小数)") and the comment on `merge.py:35-36`
say they are; the presence of a hardcoded USDC.e suggests the address predates the pUSD switch.
Resolve with one read-only call: `CTF.getPositionId(PUSD_COLLATERAL, …)`/`balanceOf` against a known
YES token, or check `USDC.e` vs `pUSD` balances of the funder (`gateway._rpc()` + the ERC-20 ABI).
If pUSD is correct, this is a one-line fix — but it must be verified, not guessed.

---

## C7 — HIGH — heartbeat-recovery resync wipes orders with `grace_s=0.0` outside the per-market lock, racing the quoter

`engine.py:640-647`:

```
self.state.clear_orders()
for meta in self.metas.values():
    await self._refresh_token_orders(meta, grace_s=0.0)   # -> replace_open_orders(tok, live, grace_s=0.0)
```

The reconcile loop deliberately takes `self._locks[cid]` before touching order state
(`engine.py:687-694`) precisely because that snapshot is stale relative to a placement. This path
does not. Interleaving: quoter holds `_locks[cid]`, computes its plan, `await self.gateway.place(...)`
→ the heartbeat task runs `clear_orders()` and fetches the REST snapshot **taken before the
placement** → `replace_open_orders(..., grace_s=0.0)` drops the just-placed orders (grace 0 disables
the double-order guard by design) → the quoter resumes, upserts its orders… and the next reconcile
(or the next quoter tick before that) re-places them: duplicate live orders. Fix: take `_locks[cid]`
and use `grace_s >= 10` for anything except a *confirmed* server-side wipe.

---

## C8 — HIGH/MEDIUM — tracker state-machine holes: FAILED after restart is dropped, and the trade id is positional over a list that can change

a) `tracker.py:88-89`: `prior = self._applied.pop(ev.trade_id, None)`; `_applied` is in-memory and
`_load()` (`store.py:216-221`) restores positions only. A `FAILED` that arrives after a process
restart (or after the `MINED`→`CONFIRMED` pop) finds no `prior`, so the optimistic fill is **never
reversed**: phantom inventory plus (per C3) phantom cash. The fills table cannot help — nothing
consults it on the FAILED path. Only `_check_position_divergence` corrects the size, ~80 s later, and
it never corrects cash.

b) `parse.py:80`: `trade_id=f"{trade_id}:{i}" if len(msg['maker_orders']) > 1 else trade_id`, where
`i` enumerates **all** maker orders in the message (including other makers', which are skipped with
`continue` at line 59 but still consume an index). The MAKER id therefore depends on how many maker
orders the message happens to list. A `MATCHED` frame with `maker_orders=[other, ours]` yields
`T:1`; a later `CONFIRMED`/`FAILED` frame for the same trade that lists only our order (or lists them
in a different order) yields `T` (or `T:0`). Consequence: the terminal status is not matched,
`clear_inflight` never runs for it (so `inflight` stays > 0 until `expire_inflight`,
`store.py:144-158`, ~40 s) and the FAILED reversal never runs (per (a)). Use a stable key —
`f"{trade_id}:{maker_address}:{matched_amount}"` or the maker order's own id/hash.

c) `tracker.py:76-81`: `MINED` inside the `(CONFIRMED, MINED)` branch neither clears nor pops
(intentional per the comment), fine — but combined with (b) it means the guard lifecycle depends on
a positional id.

---

## C9 — MEDIUM — a malformed/missing `side` silently becomes BUY

`parse.py:110-111`: `_side` returns `Side.BUY` for anything that isn't exactly `"SELL"`
(case-insensitive). `normalize_order` (line 93-105) does `_side(msg.get("side"))` inside a `try` whose
`except (KeyError, ValueError, TypeError)` never triggers for `None`/`""`/`"Buy "`. An `order`
frame with a missing or renamed side key therefore records our resting **SELL** as a **BUY** in
`state.orders`. The reconciler keys on `(token_id, side)` (`reconciler.py:39-41`), so the real SELL
is invisible: the SELL target is re-placed (duplicate exposure on the wrong side) while the BUY
target is "kept" against an order that is actually a SELL. Given the file's own warning that field
names still need re-confirmation against the live user WS, this deserves a fail-closed fix
(return `None`/skip the event on an unknown side, log it).

---

## C10 — MEDIUM — reversing a FAILED BUY leaves a polluted average price

`store.py:97-107`: SELL fills never recompute `avg_price` (correct for real sells), and the reversal
of a failed BUY is applied as a SELL (`tracker.py:92-95`). Example: `100 @ 0.50`, then
`BUY 100 @ 0.90` → avg `0.70`, size 200; FAILED → sell 100 → size 100, avg **0.70** (should be
0.50). Every mark-to-market/`_market_notional`/`_event_group_cost` view built on `avg_price`
(`risk/manager.py:51,135,142`; `engine.py:888`) is now wrong, and `_check_position_divergence`
force-sets only the size, keeping the bad avg. Fix: recompute `avg_price` from the pre-fill snapshot
(e.g. store the pre-fill `(size, avg_price)` on the Fill / in `_applied`) or make the reversal an
exact undo rather than a synthetic opposite fill.

---

## C11 — MEDIUM — a successful merge is never written to state, and resting SELLs are not pulled first

`engine.py:590-623`: after `merger.merge(...)` returns a tx hash, nothing calls
`state.set_position`/`force_set_position` and no orders are cancelled. Two consequences:
(1) `pos_yes/pos_no` stay high until the chain divergence check (C4 timing, ~80 s), during which the
strategy sizes exits against inventory that no longer exists; (2) the merge destroys the shares
backing any **resting SELL** order on those tokens — a subsequent taker fill of that SELL cannot
settle (trade goes FAILED, feeding the C3/C8 machinery and the error-rate breaker). Cancel the SELL
side (or quarantine the market) before the merge, and decrement the store on success.

---

## C12 — MEDIUM — untracked-token fills and a startup prune can delete real, funded positions

a) `store.py:94` `apply_fill` inserts into `positions` with no trackedness check, and
`risk._total_exposure`/`_inventory_value` iterate **all** of `store.positions`
(`risk/manager.py:47-52,138-143`). A `trade` event for any market where our funder has resting orders
(operator's UI orders, leftovers from a previous config) becomes a position, moves `_net_cash`, and
inflates total exposure → spurious `total_exposure_cap` reduce-only, or a spurious `daily_loss` halt.
`drop_untracked_positions` runs only once, at startup (`engine.py:289`).

b) That same prune is destructive and runs *before* any position read: `engine.py:289` with
`_token_cid` built from markets that resolved. If Gamma is unreachable/`parse_market` returns `None`
for one configured market at boot (`engine.py:190-204`, `market_unresolved` → `continue`), its token
is not in `_token_cid`, so `drop_untracked_positions` (`store.py:223-235`) deletes the position from
memory **and from SQLite**, and `_only_traded` (line 316) then filters it out of the API read too —
so it cannot come back. Real inventory silently leaves the books (and cash stays), the exposure cap
under-counts, and the DB history is gone. Fix: only prune tokens that are provably not in the
*configured* market list, and never delete rows for a configured-but-unresolved market.

---

## C13 — MEDIUM — `positions()` reports a partial/failed read as success

`gateway.py:588-622`. The `for … else` (line 617-618) fires when 50 pages of `cursor` are consumed
without a `break`, logs `positions_pagination_capped`, and then **returns the partial dict** as if
complete. If the API's terminal sentinel is a non-empty string (the CLOB uses `"LTE="`; a Data API
cursor that never becomes falsy has the same effect), every reconcile refetches the same page 50×
(50 authenticated requests per reconcile round, every 20 s → rate budget burnt, and the `Retry-After`
backoff inside `_get_json_with_retry` amplifies it) and yields an incomplete position set. The
docstring promises "None when the read failed" — a truncated read is a failed read. Also
`gateway.py:582-583` returns `{}` (i.e. "flat") whenever `funder` is empty or `"0xPAPER"`, which
contradicts the None-means-unknown contract for the same reason (low practical impact today: the
engine aborts earlier if connect fails).

Fix: return `None` after the `else`, and (for C4's benefit) never return a set that is known to be
truncated.

---

## C14 — MEDIUM — unbounded `_aux_tasks` growth and unretrieved merge exceptions

`engine.py:83,588`: every merge appends a task to `self._aux_tasks` and nothing ever removes a
finished one, so the list (and each `Task`, with its result/exception) is retained for the process
lifetime. `run_forever`'s `gather(*self._aux_tasks)` (line 157) snapshots the list, and `shutdown`
cancels whatever is there. `_merge_task` has `try/finally` but **no `except`**, and nothing ever
awaits the task, so a raised exception (thread-pool exhaustion from `asyncio.to_thread`, a
`CancelledError` around shutdown, `token_balances` returning something unexpected) surfaces only as
asyncio's "Task exception was never retrieved" — i.e. swallowed. Fix: keep a set, discard on
completion via a done-callback that also logs the exception.

---

## C15 — MEDIUM — `_parse_place_response` maps order ids to quotes positionally

`gateway.py:263-271`: `zip(quotes, items, strict=False)`. If the batch response is shorter than the
request, reordered, or partially aggregated (a per-order error entry, a different key), order ids
are attached to the **wrong** `(token_id, side, price, size)`. With a matching count there is no
downstream check, so the state now holds an order attributed to the wrong token/price and the
reconciler will keep/cancel based on that lie. The shorter-response case is caught (the engine
quarantines when `len(placed) < len(plan.to_place)`, `engine.py:553-557`), which is why this is
Medium and not Critical. Fix: match on the response's own `asset_id`/`token_id`+side+price, and
treat a count mismatch as "ids unknown" rather than "these ids".

---

## C16 — MEDIUM (latent, gated by `merge_v2_enabled=false`) — `_merge_v2` sends a Gnosis-Safe wallet's merge from the EOA

`merge.py:203-213`: `if self._cfg.wallet.signature_type in (0, 2)` builds and signs a **direct EOA
transaction**. For sig_type 2 (Safe/proxy) the positions and collateral live in the Safe, not the
signer EOA, so `Router.merge` pulls from an account that holds nothing (revert) — or, if the EOA
happens to hold positions, the pUSD lands in the EOA instead of the Safe. The V1 path already knows
this (`_merge_safe`, `merge.py:325-366`, wraps `execTransaction`). The V2 branch must do the same.
Currently default-off, so latent — but it will mis-fire the moment someone enables the flag on a Safe
wallet.

---

## C17 — MEDIUM — on-chain nonce is read from `latest`, not `pending`

`merge.py:206`, `:293`, `:351`: `w3.eth.get_transaction_count(addr)` (default `block_identifier=
"latest"`). `_chain_lock` serialises merges *only while the previous call returns*; on a
`wait_for_transaction_receipt` timeout (180 s/120 s) the exception unwinds, releases the lock, and
the still-pending tx is invisible to the next `latest` read → the next merge **reuses the nonce** and
replaces the pending one (both were built with `maxFeePerGas = gas_price * 2`, so the replacement may
well be accepted). Net effect: a merge we believe happened was replaced by a different merge, silently.
Use `"pending"`, or track nonces explicitly per signer.

---

## C18 — MEDIUM/LOW — `heartbeat()` reports success even when the chain id is missing

`gateway.py:516-523`: on an HTTP 200 whose body has no `heartbeat_id`/`id`, `new_id` is `None`,
`self._hb_id = ""`, `_hb_failures = 0`, and the method returns `True`. The engine therefore never
enters `hb_blind` and never takes the recovery path (`engine.py:632-647`) that exists to resync after
the exchange auto-cancels on a broken chain. If the exchange rejects empty chain ids, we can sit
"healthy" in the engine's eyes while the server has cancelled everything. Treat an id-less response
as a failure (or log it distinctly and don't reset `_hb_failures`).

---

## C19 — MEDIUM/LOW — the doctor's balance heuristic was not updated with `collateral_balance`, and the CLIs leak the thread pool

`doctor.py:186-187` still does `v / 1e6 if v > 1e6 else v` for the *same* `/balance-allowance`
payload that `gateway.collateral_balance()` (`gateway.py:485-499`) now scales unconditionally. A raw
`"500000"` (0.5 pUSD) is reported by `doctor` as `500000.00 pUSD` and the "balance is 0" hint
(`doctor.py:75-77`) does not fire — the preflight can tell the operator they are funded when the
account is nearly empty. (The new unit-behaviour of `collateral_balance` itself is right; the
duplicate implementation in `doctor` is the defect.)

Resource leaks: `doctor.py:64`, `moneydoctor.py:55`, `livetest.py:47` construct an
`ExecutionGateway` (hence an 8-thread `ThreadPoolExecutor`, `gateway.py:127`) and never call
`gw.close()` — only `engine.shutdown()` does (`engine.py:169`). Each CLI invocation leaves up to 8
live threads until process exit; harmless today, but it is exactly the kind of leak that hides a
real one.

Also `moneydoctor.py:115-118`: `remaining = await gw.token_balance(...)` can never be `None` (it
returns `0.0` on RPC failure, `gateway.py:393-400`), so the `if remaining is not None` guard is dead
and an unreadable chain makes `remaining <= before + 0.5` **pass** — "position flat after
round-trip" is reported green after moving real money without ever reading the chain. Same pattern at
`moneydoctor.py:223-227`, where a failed read yields `amount = 0.0` and the retry loop silently
gives up leaving the position open. Use `_token_balance_opt`/`token_balances` here.

---

## C20 — LOW — `allowances_for()` can only ever see collateral allowances, and returns `0.0` for "spender absent"

`gateway.py:651-665` calls `balance_allowance()` with no args → `asset_type=COLLATERAL`
(`gateway.py:640`), then returns `0.0` when the spender key is missing. The documented use (its own
docstring, `ledger.asset_type_for`) is to preflight the V2 approvals, one of which
(`PositionManager → ExchangeV3`) lives on the **ERC-1155**, i.e. `asset_type=CONDITIONAL-V2`. A
missing `allowances` key (failed/odd read) also collapses to `None` vs `0.0` inconsistently with
`collateral_balance`. Currently no callers (grep: definition only), so LOW — but wire it to
`asset_type_for(version)` before anyone uses it.

---

## C21 — LOW — `other_token()` failure is silently treated as "same outcome"

`parse.py:72-73`: `token = other_token(taker_asset) or taker_asset`, keeping `our_side = taker_side`.
For a mint (we are the maker on the *other* outcome) with an unknown taker asset, we record a fill on
the token the **taker** bought, with the taker's side — the opposite sign of the real economics.
`engine._other_token` returns `None` for untracked tokens (`engine.py:873-875`), which is exactly
when C12's untracked-fill pollution already applies. Fail closed (skip the event + alert) instead.

---

## C22 — LOW (SDK, but reachable) — `_retry_on_version_update` can double-post a market order

`.venv/.../py_clob_client_v2/client.py:1251-1258` re-invokes the posting closure when the CLOB
`/version` changes between the two reads (the closure re-signs with a new salt → a *second* order,
not a resend). `create_and_post_market_order` is the affected entry point; in this repo that is
`gateway.market_order` (`gateway.py:347-351`), used only by `moneydoctor`. For FAK/FOK the amount is
capped by balance, but it is still an unexpected second taker order. Wrapping the call with a
duplicate-detection (compare the returned ids / rely on `tradeIDs`) or avoiding two `/version` reads
per post is the mitigation.

---

# Call-site audit of the changed return types (explicitly requested)

| API | Returns | Call site | Handling | Verdict |
|---|---|---|---|---|
| `token_balances` | `dict \| None` | `engine.py:597-605` (`_merge_task`) | `None` → skip + log (line 600-603); `.get(tok, 0.0)` defaults | OK for today (a partial dict is impossible: any exception aborts to `None`, `gateway.py:446-468`). The `0.0` default would silently skip a merge if `token_balances` ever gains a partial mode — use `if tok not in bals: return`. |
| `token_balances` | `dict \| None` | `engine.py:729-733` | `None` → skip + log; iterates `onchain.items()` only | OK, but note tokens *absent* from the dict are silently unchecked (line 734). |
| `positions` | `dict \| None` | `engine.py:290-298` (startup) | `None` → log + return, state untouched | Correct. |
| `positions` | `dict \| None` | `engine.py:671-679` | `None` → log, keep last known-good | Correct (the C4 hole is the *empty* case, not the `None` case). |
| `positions` | `dict \| None` | `doctor.py:79-89` | `None` → explicit check failure | Correct. |
| `collateral_balance` | `float \| None` | `moneydoctor.py:71-75` | `None` → abort with a red check | Correct. |
| `collateral_balance` | `float \| None` | `moneydoctor.py:124-130` | `None` → warn, cost not computed | Correct. |
| `balance_allowance` | `dict` (no failure signal) | `livetest.py:60-61`, `doctor.py:71-74`, `gateway.py:492`, `gateway.py:657` | failure returns `{}` → `collateral_balance`/`allowances_for` convert to `None`; livetest prints `{}` | Acceptable, but the type should be `dict \| None` for `allowances_for` (C20). |
| `token_balance` | `float` (**0.0 on failure**) | `moneydoctor.py:96,115,170,205,223` | `if bal is not None` (dead) / `or baseline` | **Defective** — see C19: false "flat" pass, and the sell-retry gives up. |
| `open_orders` | `list` (**[] on failure**) | `engine.py:273,278,576,680`, `moneydoctor.py:83,88`, `livetest.py:79` | treated as authoritative | **Defective** — C1. |
| `merge` | `str \| None` | `engine.py:609-621` | `None` + `can_merge` → alert | **Defective** — C5a. |

# Concurrency summary

- Nonce/merge serialisation is sound only while each merge call returns (C17, C5b).
- `_locks[cid]` correctly serialises quoter vs reconcile (`engine.py:422,691`), but the heartbeat
  recovery path (C7) and the startup prune bypass it.
- Double-place risks: C1 (failed/empty snapshot), C7 (stale snapshot + grace 0), C15 (mis-attributed
  ids), C2 (in-flight place at shutdown), C9 (mis-sided order in state).
- In-flight guard: leaks on the positional-id mismatch (C8b) and blocks the divergence check
  (`engine.py:725`) until `expire_inflight` fires (C4 interaction).
- No sqlite/httpx leaks found (`httpx.AsyncClient` is always used as a context manager; sqlite work is
  single-threaded). The `ThreadPoolExecutor` is closed only by `Engine.shutdown` (C19).

# Things I verified as *correct* (not padding — these are the "did they wire it right?" checks)

- `ledger_for`/`asset_type_for` route by `ProtocolVersion`; `gateway._token_balance_opt` and
  `token_balances` use them; `MarketMeta.ledger()` too. No remaining hardcoded CTF address in the
  *balance* path (the CTF address in `merge.py` is the V1 merge path, and the v2 Router branch is
  separate).
- `place()` and `market_order()` correctly pass `position_id=` only for `meta.is_v2`; the installed
  SDK 1.2.0 accepts exactly one of `token_id`/`position_id` and routes `position_id` to ExchangeV3
  (verified in `.venv/.../clob_types.py:9-15,112-146` and `order_builder/helpers.py:41-43`).
- `collateral_balance` divides by 1e6 unconditionally and returns `None` on any unreadable shape
  (`gateway.py:485-499`); `positions()` reads `data[].token_id`/`current_size`/`avg_price`, not
  `total_size` (`gateway.py:605-612`); `_split`/`_first` tolerances are fine.
- `retry` policy (`_get_json_with_retry`) is bounded, honours `Retry-After`, and re-raises on
  non-retryable statuses.

# Explicit uncertainties

1. **V2 CLOB order-row field names** (`asset_id` vs `position_id`/`token_id`) — determines whether C1
   is a transient blip or a permanent duplicate-order generator. Resolve with one authenticated
   `GET /data/orders` on a live V2 account (or the OpenAPI spec for the V2 orders endpoint).
2. **`/v2/positions` pagination sentinel** — if `next_cursor` never becomes falsy, C13 is live
   (50 requests/reconcile + truncated data).
3. **CTF collateral token** (C6) — needs the on-chain check described there.
4. **`filter_type`/`filter_amount` names on v2** — if rejected/ignored, dust positions below 1 share
   enter state (the code deliberately reproduced v1's `sizeThreshold=1`; unverified against v2).
5. **Maker "mint" detection** (`mo["outcome"] != taker_outcome`) — I could not verify the live field
   names/shape; a wrong reading flips the sign of a filled position (C9/C21 compounding).
