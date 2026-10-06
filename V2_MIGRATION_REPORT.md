# Polymaker × Polymarket Protocol V2 迁移评估报告

**报告日期**：2026-10-06
**代码基线**：HEAD `f90158a`（`src/polymaker`，5655 行 Python，111 tests passed / 2 skipped）
**文档基线**：docs.polymarket.com 官方文档实时抓取（Protocol V2 Migration 三篇 + Data API v2 + Contracts + Onchain Position Data + pUSD + WSS/Heartbeat/Fees）
**结论一句话**：项目当前是一个**完全基于 CTF（v1）标识符**的做市系统。官方 Protocol V2 迁移**不要求改任何业务逻辑**，但要求改**标识符选择、签名域、余额读取、链上仓位操作**四个横切面——这四条正好是当前代码的四个硬编码假设。**今天还能跑，是因为 v2 市场尚未出现在 live feed（实测 1200 个活跃市场 100% 为 `v1`）；一旦 v2 市场进入扫描范围，当前代码会静默用错误的 ID 下单。**

---

## 目录

1. [本地项目分析](#1-本地项目分析)
2. [官方迁移要求拆解](#2-官方迁移要求拆解)
3. [差异矩阵：逐条对照](#3-差异矩阵逐条对照)
4. [问题清单（按严重度分级）](#4-问题清单按严重度分级)
5. [优化方案：三阶段迁移路线](#5-优化方案三阶段迁移路线)
6. [验收标准与回归测试清单](#6-验收标准与回归测试清单)
7. [附录：地址与 ABI 速查](#7-附录地址与-abi-速查)

---

## 1. 本地项目分析

### 1.1 系统定位

Polymaker 是**单进程 asyncio 的纯 maker 做市机器人**，聚焦政治类市场，通过刷流动性激励（Liquidity Rewards）+ maker 返佣（Maker Rebates）获利。核心特征：

| 维度 | 实现 |
|---|---|
| 资金/凭证 | `.env` 存 `PK` + `BROWSER_ADDRESS`；`signature_type=3`（POLY_1271 Deposit Wallet） |
| 配置 | 3 个 TOML（`config.toml` / `strategy.toml` / `markets.toml`），Pydantic 校验 |
| 状态 | 单文件 SQLite（`state.db`）：catalog / positions / fills / order_log / pnl_snapshots |
| 市场发现 | Gamma `/markets`（tag=politics，offset 分页）→ 评分 → SQLite catalog |
| 行情 | 单条 market WSS → 每 token 一个 `OrderBook` |
| 策略 | 纯函数 `(book, inventory, params, clock) → TargetQuotes`，可单测 |
| 下单 | `ExecutionGateway` 包 `py-clob-client-v2`，全部 post-only，线程池卸载阻塞调用 |
| 风控 | 逐市场/事件组/总敞口上限 + 日亏 kill switch + WS 陈旧熔断 + 心跳 dead-man switch |
| 退出 | 优先 SELL 限价；满仓对冲时走链上 merge 变回抵押品 |

数据流（README 自述，与代码一致）：

```
market WS ─▶ OrderBook ─▶ (wake) ─▶ Quoter ─▶ strategy(纯) ─▶ reconcile ─▶ ExecutionGateway
user WS   ─▶ StateStore                                         RiskManager ┘   (post-only, heartbeat)
Gamma     ─▶ Catalog/scanner ─▶ SQLite            periodic REST reconcile ┘
```

### 1.2 标识符的完整传播链（迁移的核心）

这是理解本次迁移的关键。当前代码里 **"token_id" 一词贯穿全系统**，而这个概念在 Protocol V2 里被拆成两个不可互换的标识符：

```
Gamma market
  └─ parse_market()          catalog/gamma.py:127   ← 只读 clobTokenIds，忽略 version / positionIds
       └─ MarketMeta.tokens: (TokenMeta(token_id), TokenMeta(token_id))   domain.py:62
            ├─ md.set_markets()          → WSS 订阅 assets_ids        marketdata/service.py:122
            ├─ engine._token_cid{}       → token→condition 反查表      engine.py:195
            ├─ state.positions{}         → 持仓账本（主键 = token_id）  state/store.py
            ├─ gateway.place(quote)      → OrderArgsV2(token_id=...)   execution/gateway.py:172
            ├─ gateway.token_balances()  → CTF.balanceOf(funder, tid)  execution/gateway.py:386
            ├─ userstream normalize_*    → 按 asset_id 匹配订单/成交    userstream/parse.py:50
            ├─ merger.merge(condition_id) → CTF/adapter mergePositions  merge.py:107
            └─ gateway.positions()       → data-api /positions[].asset  execution/gateway.py:492
```

**全链路只认 CTF token ID，且没有任何一处读取 Gamma 的 `version` 字段。** 这是本次评估最重要的单一发现。

### 1.3 关键外部依赖

| 依赖 | 当前版本 | 最新版本 | 差异 |
|---|---|---|---|
| `py-clob-client-v2` | **1.0.2** | **1.2.0** | 1.2.0 新增 `exchange_v3`、`position_id` 参数与 v3 签名路由 |
| CLOB `/version` | 返回 `{"version":2}` | — | SDK 据此选择 ExchangeV2 域 |
| Data API | `/positions`（v1） | 2026-10-24 退役 | 见 §4 P1-Ⅱ |

实测已安装 SDK 1.0.2 的 `order_builder/builder.py` 只支持 `version in (1, 2)`，**`version == 3` 会抛 `ValueError: unsupported order version 3`**；1.2.0 才把 `3` 加入分支并指向 `contract_config.exchange_v3`。

### 1.4 代码现状快照

| 项 | 数值 |
|---|---|
| Python 源码 | 5655 行 / 30 文件 |
| 测试 | 111 passed, 2 skipped（0.57s，纯离线） |
| Lint / 类型 | ruff + mypy strict 干净（自述） |
| 仓库内 V2 关键词 | `grep -rn "positionId\|position_id\|ExchangeV3\|CONDITIONAL-V2"` → **0 命中** |
| catalog 新鲜度 | 911 行，最新 `scanned_ts = 2026-08-03`（**距今 64 天**） |
| 当前交易列表 | 3 个配置市场，实测全部 `version=v1`、`acceptingOrders=true` |

---

## 2. 官方迁移要求拆解

官方给了三份并行的迁移指南（SDK / API / 合约）。本项目是 **"直接调 API + 自己签名"（API 路径）叠加 "直接调合约"（Contract 路径）**，SDK 路径只能部分适用。

### 2.1 一句话总纲

> **Protocol V2 引入新的 position token 和合约**，用于交易、仓位操作与结算。
> **已有的 CTF 持仓不会被转换。**
> 对已经使用 pUSD 和 CTFExchangeV2 订单格式的集成，**抵押品、钱包、CLOB 凭证和端点都不变**。

最后一句非常重要：**迁移不改业务/不改认证/不改端点**，只改四件事。

### 2.2 四项必改（API 路径）

| # | 要求 | 官方原文要点 |
|---|---|---|
| ① | **按 `version` 选择交易 ID** | `version=="v2"` → `positionIds`（十进制字符串数组）；`version=="v1"` → `clobTokenIds`（JSON 编码字符串）。**"即使两个字段同时存在，也必须按 version 选"**。拒绝缺失/不支持版本、outcome 不匹配、非十进制 ID |
| ② | **V2 授权（ExchangeV3）** | BUY：pUSD 上 `approve(EXCHANGE_V3, amount)`（需覆盖手续费）；SELL：PositionManager 上 `setApprovalForAll(EXCHANGE_V3, true)`。**"已有 CTF 授权不覆盖这两项"** |
| ③ | **刷新并读取余额** | `CONDITIONAL-V2` 选 V2 仓位，`COLLATERAL` 选 pUSD，`CONDITIONAL` 保留给 CTF；读 `/balance-allowance` 检查 `allowances` 里 ExchangeV3 的条目 |
| ④ | **改签名域为 v3** | `{name:"Polymarket CTF Exchange", version:"3", chainId:137, verifyingContract:0xe3333700...c00Aa}`；**订单结构保持 CTFExchangeV2 不变，只把 `order.tokenId` 设为 V2 position ID 并重签**；CTF 订单保留 ExchangeV2 与域版本 `"2"` |

### 2.3 四项配套（易漏）

| # | 要求 | 官方原文要点 |
|---|---|---|
| ⑤ | **identifier/subscription 一致性** | 行情、价格、订单、market 订阅（`assets_ids`）全部用同一个 asset ID；**user-stream 的 `markets` 和"市场级撤单"仍用 condition ID** |
| ⑥ | **V2 结算状态改读 `resolutionStatus`** | V2 用 `resolutionStatus`（`inactive`/`active`/`resolved`）；V1 继续用 `umaResolutionStatus` |
| ⑦ | **自定义成交计算要改** | `counterAmount = floor(makerAssetFill × takerAmount / makerAmount)`；BUY 的 `makerAssetFill` 是抵押品，SELL 是份额；**ExchangeV3 会按实际花费扣减 BUY 的剩余抵押预算**；GTC/GTD 的 BUY 目标是**份额**，FOK/FAK 的 BUY 目标是**抵押品**；BUY 手续费加到抵押品支出，SELL 手续费从收入扣除 |
| ⑧ | **仓位操作换 Router** | V2 用 `Router.split/merge/redeem(bytes31 conditionId, ...)`，`outcomeIndex` 为 `0`=YES / `1`=NO（取代 CTF 的 index set `1`/`2`）；split 需 pUSD `approve(ROUTER)`，merge/redeem 需 PositionManager `setApprovalForAll(ROUTER, true)`；余额与转账走 PositionManager；**`conditionId` 是 `bytes31`，`bytes32` 边界要右补零** |

### 2.4 一个必须避开的认知陷阱

> "**字段存在与否不能可靠地区分系统**，因为一个 CTF 市场也可能作为 PositionManager 工作流的一条腿出现（Combo legs）。"

实测验证：NFL 比赛市场 `version="v1"` 但**同时带 `positionIds`**。**因此绝不能用"有 positionIds 就是 v2"来判定**——必须以 `version` 为准。这条几乎踩中所有"图省事"的实现。

### 2.5 明确**不需要**改的部分（防止过度迁移）

| 项 | 结论 |
|---|---|
| 抵押品 | 仍是 pUSD `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`（6 位小数） |
| CLOB 端点 / L2 凭证（POLY_* 头） | 不变 |
| 钱包类型与 `signature_type` | 不变 |
| 订单 EIP-712 结构体字段 | 不变（`salt/maker/signer/tokenId/makerAmount/takerAmount/side/signatureType/timestamp/metadata/builder`） |
| market WSS URL / 订阅帧 / 事件字段名 | 不变（只有 asset ID **取值**变） |
| user WSS URL / 认证帧 / 事件名 `order`/`trade` | 不变 |
| 手续费与返佣公式 | 不变，**官方没有任何 V1/V2 费率差异** |
| 心跳（`POST /v1/heartbeats`，5s，10s 超时） | 不变 |

---

## 3. 差异矩阵：逐条对照

| # | 迁移要求 | 当前实现 | 位置 | 判定 |
|---|---|---|---|---|
| ① | 按 `version` 选 ID | 无脑取 `clobTokenIds`；`version`/`positionIds` 均未读取 | `catalog/gamma.py:127` | ❌ **缺失** |
| ① | 拒绝未知版本/非十进制 ID | 无校验 | `catalog/gamma.py:122-172` | ❌ 缺失 |
| ② | V2 BUY 授权 ExchangeV3 | 无授权代码（沿用现有 CTF 授权） | — | ❌ 缺失 |
| ② | V2 SELL 授权 PositionManager | 无 | — | ❌ 缺失 |
| ③ | `asset_type=CONDITIONAL-V2` | SDK `AssetType` 只有 `COLLATERAL`/`CONDITIONAL` | `gateway.py:506-510` | ❌ **阻塞** |
| ③ | 读 `allowances[ExchangeV3]` | `balance_allowance()` 只回传原始 dict，无 ExchangeV3 校验 | `gateway.py:500` | ⚠️ 不完整 |
| ④ | 签名域 version `"3"` | SDK 1.0.2 只支持 `version in (1,2)`，`3` 直接抛错 | SDK 侧 | ❌ **阻塞** |
| ④ | 传 position ID 而非 token ID | `OrderArgsV2(token_id=q.token_id, ...)` | `gateway.py:172` | ❌ 阻塞 |
| ⑤ | 行情/订单/订阅用同一 asset ID | 一致，但那个 ID 是 CTF token ID | `service.py:122`, `engine.py:103` | ⚠️ 一致但取错 |
| ⑤ | user-stream `markets` 用 condition ID | `UserStream.set_markets(list(self.metas))` 传 condition ID | `engine.py:110` | ✅ 正确 |
| ⑥ | V2 读 `resolutionStatus` | 只读 `acceptingOrders` / `closed` | `engine.py:669-671` | ❌ 缺失（低危） |
| ⑦ | 按 maker 签名金额算成交 | 直接用 user-stream 的 `matched_amount` | `userstream/parse.py:62` | ⚠️ 需核验 |
| ⑧ | Router.merge(bytes31) | CTF `mergePositions` + 旧 NegRiskAdapter | `merge.py:26-27,122-174` | ❌ **缺失** |
| — | 链上仓位读 CTF 合约 | `CTF 0x4D97...6045` 硬编码 | `gateway.py:339,380` | ❌ **V2 下读不到** |
| — | Data API v1 | `/positions` 裸数组 | `gateway.py:489` | ❌ **2026-10-24 退役** |

---

## 4. 问题清单（按严重度分级）

### P0 — 阻断级（V2 上线即失效或资金风险）

---

#### P0-1｜`version` 被完全忽略，V2 市场会静默用错 ID 交易

**证据**

```python
# src/polymaker/catalog/gamma.py:127
token_ids = _json_list(raw.get("clobTokenIds"))   # ← 只读这一个字段
```

`parse_market()` 全函数没有出现过 `version` 或 `positionIds`（仓库级 grep 0 命中）。而官方文档对 V2 市场给出的是：

```json
{ "version": "v2", "clobTokenIds": null,
  "positionIds": ["651150819117105875331414918119047680898421632356043490229292782433651916800", "...801"] }
```

**失效链条**：V2 市场进入 catalog → `_json_list(None)` 返回 `[]` → `len(token_ids) != 2` → `return None` → **市场被静默丢弃**（扫描器只 `continue`，无告警）。这是"良性"失败。

**真正的危险路径**是组合情形：文档明确指出"字段存在与否不能可靠区分系统"，实测 NFL 市场 `version=v1` 却带 `positionIds`。若未来某 V2 市场同时保留 `clobTokenIds`（文档明确允许"两个字段同时存在"），则代码会**选中 CTF token ID 并把它当作 V2 position ID 送去签名**。后果：
- 最好情况：签名域的 `tokenId` 合法但对应 CTF 资产 → 订单被拒或挂到错误资产上；
- 最坏情况：**在错误的资产上成交，形成无法平掉的仓位**。

**另一条隐蔽失效路径**：`engine._resolve_markets()` 优先从 **catalog 缓存**取 meta：

```python
# src/polymaker/engine.py:179
meta = self.catalog.get_by_slug(entry.slug) if entry.slug else None
if meta is None and entry.condition_id:
    meta = self.catalog.get(entry.condition_id)
if meta is None:   # ← 只有 miss 才回源 Gamma
    meta = await self._fetch_meta(gamma, ...)
```

`state.db` 的 catalog 最新时间戳是 **2026-08-03，已过期 64 天**。市场若从 v1 迁移到 v2（官方支持 registration-gated 的链上迁移），缓存里的 token ID 会**保持陈旧且不一致**，而代码永远不会回源校验版本。

**修复**：见 §5 Phase 1（`MarketMeta` 增加 `version` 字段 + 按 version 选 ID + 缓存带版本与 TTL 校验）。

---

#### P0-2｜链上余额读的是 CTF 合约，V2 下恒为 0

**证据**

```python
# src/polymaker/execution/gateway.py:339 / 380
address=Web3.to_checksum_address("0x4D97DCd97eC945f40cF65F87097ACe5EA0476045")
abi = [{"name": "balanceOf", ...}]          # 单参重载注释写错（实际是 ERC-1155 双参）
raw = ctf.functions.balanceOf(funder, int(tid)).call()
```

V2 的 ERC-1155 账本是 **PositionManager `0x006F54F7f9A22e0000CC2AB60031000000ae9fEF`**，不是 Conditional Tokens。官方警告：**"不要把 CTF token ID 发给 PositionManager，也不要把 position ID 发给 Conditional Tokens。"**

**影响面比看起来大得多**——这个函数被三处关键逻辑消费：

1. **`engine._check_position_divergence()`**（`engine.py:625`）：以链上为权威，内部状态与链上偏差 >1 股就告警并把内部状态**强制改写成链上值**。V2 下链上恒返 `0` → 会把真实持仓**强制清零**，随后风控敞口、`_maybe_merge` 的额度、`_next_wake_s` 的持仓加速循环（`held >= min_order_size`）**全部建立在"我没仓位"的幻觉上**。
2. **`engine._merge_task()`**（`engine.py:534`）：`amount = min(amount, bals[yes], bals[no])`，链上返 0 → `raw <= 0` → **merge 永远不执行**，库存无法通过 merge 退出。
3. **`moneydoctor`**（`moneydoctor.py:93,112,164,199,217`）：自检读不到余额 → 误判成交/未成交。

**这是整个报告里后果最严重的一条**：不是"功能缺失"，而是**会让系统在错误的状态上继续做市**。

**修复**：抽一层 `PositionLedger` 抽象，按 `meta.version` 分派到 CTF 或 PositionManager；`state.force_set_position` 增加"链上读取失败/返回空"的三态保护（区分"读到 0" vs "读不到"）。注意 `_token_balance_opt` 已有 `None` 语义，但 `token_balances`（批量版）用 `if not onchain: return`，**空 dict 与失败无法区分**——V2 下所有余额返回 `{'tid': 0.0}` 非空，保护失效。

---

#### P0-3｜签名域无法切到 v3，且 SDK 版本过旧

**证据（实测已安装的 1.0.2）**

```python
# .venv/.../py_clob_client_v2/order_builder/builder.py:210
raise ValueError(f"unsupported order version {version}")
```

1.0.2 的 `build_order()` 只处理 `version == 1` 与 `version == 2`。1.2.0 的分支是：

```python
elif version in (2, 3):
    exchange_address = (contract_config.exchange_v3 if version == 3
                        else contract_config.neg_risk_exchange_v2 if options.neg_risk
                        else contract_config.exchange_v2)
    ...
    builder = ExchangeOrderBuilderV2(exchange_address, ..., domain_version=str(version))
```

且 1.2.0 的 `config.py` 新增：

```python
exchange_v3="0xe3333700cA9d93003F00f0F71f8515005F6c00Aa"     # 与官方文档完全一致 ✅
```

以及路由函数（1.2.0 新增）：

```python
# order_builder/helpers.py:37
def _resolve_order_routing(order_args, version=None):
    position_id = getattr(order_args, "position_id", None)
    asset_id = _resolve_order_asset(order_args.token_id, position_id)
    return asset_id, 3 if position_id is not None else version
```

即 **1.2.0 通过"传 `position_id` 而不是 `token_id`"来自动选 v3 域**——这正是本项目需要的能力，1.0.2 完全没有。

**另一个版本问题**：CLOB `/version` 实测返回 `{"version":2}`。1.2.0 的 `__resolve_version()` 会把它缓存为 2；只有在传 `position_id` 时才被覆盖为 3。所以**升级 SDK 但代码仍传 `token_id` 的话，V2 仍然不会生效**——SDK 升级是必要条件，不是充分条件。

**顺带**：changelog 2026-07-17 明确要求"SDK 用户在任何 rollout 前升级到最新 CLOB client"，因为 `POST /order` 成功 FAK/FOK 匹配后**不再返回 `transactionHashes`，改返回 `tradeIDs`**。本项目 `moneydoctor` 依赖匹配结果自检，跨过这个版本有踩坑风险。

---

#### P0-4｜`AssetType` 没有 `CONDITIONAL-V2`

```python
# .venv/.../py_clob_client_v2/clob_types.py:229（1.0.2 与 1.2.0 相同）
class AssetType:
    COLLATERAL = "COLLATERAL"
    CONDITIONAL = "CONDITIONAL"          # ← 无 CONDITIONAL-V2
```

好消息：SDK 只是把值原样透传（`if params.asset_type: p["asset_type"] = str(params.asset_type)`），且 `AssetType` 是普通类而非 `Enum`，**可以直接传字符串 `"CONDITIONAL-V2"` 绕开**。但注意这是**未文档化的旁路**：官方 `clob-openapi.yaml` 的 `asset_type` 枚举里**也只有** `COLLATERAL` / `CONDITIONAL`，`CONDITIONAL-V2` 只出现在迁移指南正文。属于**文档与 spec 不一致**，需实盘验证。

同时 `balance_allowance()` 需要补 `ExchangeV3` 的授权检查——官方要求"检查 `allowances` 里 ExchangeV3 的条目"，当前只回传原始 dict 不做判断。

---

#### P0-5｜Data API v1 于 2026-10-24 退役（距今 18 天）

**证据**

```python
# src/polymaker/execution/gateway.py:489
r = await c.get(f"{self._data_host}/positions", params={"user": user})   # v1
...
str(p["asset"]): (float(p["size"]), float(p.get("avgPrice", 0)))
```

官方：**"Data API v1 is retired on October 24, 2026."** 迁移映射 `GET /positions` → `GET /v2/positions`，且契约全面变化：

| 维度 | v1（当前） | v2（目标） |
|---|---|---|
| 响应包封 | 裸数组 | `{"data": [...], "pagination": {...}}` |
| 字段命名 | camelCase | **snake_case** |
| 资产 ID | `asset` | `token_id` |
| 持仓量 | `size` | `current_size`（`total_size` 是**累计买入**，不是当前持仓） |
| 均价 | `avgPrice` | `avg_price` |
| 条件 ID | `conditionId` | `condition_id` |
| 分页 | `limit`/`offset`（offset 上限 10000） | 不透明 `cursor`（`offset` 只是展示元数据，**传了会 400**） |
| 生命周期 | 单一 | `status` = `OPEN`/`REDEEMABLE`/`REDEEMABLE_LOST`/`MERGEABLE`/`CLOSED` |
| 阈值 | `sizeThreshold` | `filter_type` + `filter_amount` |
| 速率 | `/positions` 150 req/10s | `/v2/positions` 200 req/10s |
| 错误 | — | `429`+`Retry-After`、`503 request_timeout`、`{error, code, retryable, trace_id}` + `x-trace-id` |

**注意 `size` → `current_size` 的陷阱**：若照抄字段名把 `total_size` 当持仓量，持仓会被**严重高估**（累计买入 ≫ 当前持仓），风控会误触发 reduce-only、仓位偏斜会算错方向。这是一个非常容易犯且后果明确的迁移 bug。

**顺带发现的第二个 bug**：v1 的 `sizeThreshold` 默认值是 `1`（股），v2 的 `filter_amount` 默认值是 `0.1`。当前代码不传该参数，v1 下会**过滤掉 <1 股的碎仓**；迁移到 v2 后若不显式指定 `filter_amount`，会开始返回 0.1–1 股之间的碎仓——`state.reconcile_positions()` 会因此凭空多出小额持仓，`_total_exposure()` 与 `_market_notional()` 会略微漂移。建议显式传 `filter_type=TOKENS&filter_amount=1` 以保持现有语义。

**修复**：`positions()` 改读 `/v2/positions`，解析 `data[].token_id` / `current_size` / `avg_price`；跟随 `pagination.next_cursor`；携带 `status=OPEN`；对 `429` 做退避。**注意 v1 下线日期与本文档无关，是硬 deadline。**

---

### P1 — 高优先级（功能不可用 / 已过期）

---

#### P1-6｜merge 路径：既不能处理 V2，V1 的 neg-risk 腿也已过期

**证据**

```python
# src/polymaker/merge.py:27
NEG_RISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296"   # ← 官方标注 deprecated
```

官方 changelog（2026-07-14）：**"Relayer: deprecating CLOB v1 Neg Risk Adapter"** —— 该地址 `0xd91E80...296` 被弃用，新的 neg-risk 适配器是 **`0xadA2005600Dec949baf300f4C6120000bDB6eAab`**（NegRiskCtfCollateralAdapter）；**relayer 对旧地址的调用已于 2026-07-17 完全退役**。

本项目的 `signature_type=3`（Deposit Wallet）走的正是 relayer 路径：

```python
# src/polymaker/merge.py:242 → :253
to, data = self._inner_merge_call(condition_id, amount_raw, neg_risk)   # neg_risk 时 to = 旧 adapter
resp = client.execute_deposit_wallet_batch([call], ...)                  # 经 relayer 提交
```

**所以当前配置下 neg-risk 市场的 merge 很可能已经静默失败**（`merge()` 捕获所有异常只打日志返 `None`，不告警不重试）。这会影响 neg-risk 市场的库存退出——而这些市场正是政治类做市的主力。

**并且 V2 的 merge 是完全不同的调用**，当前一行都没实现：

```solidity
// 官方 V2 Router ABI（注意 conditionId 是 bytes31，不是 bytes32）
function merge(bytes31 conditionId, uint256 amount)
```

授权也不同：`PositionManager.setApprovalForAll(ROUTER, true)`，且**现有 CTF 授权不覆盖**。

**修复**：短期把 `NEG_RISK_ADAPTER` 换成 `0xadA200...eAab` 并加失败告警；中期实现 V2 Router 分支（`bytes31` 窄化需校验"末字节为零"）。

---

#### P1-7｜`resolutionStatus` 未读取（V2 结算检测盲区）

当前只靠 `acceptingOrders` / `closed` 判定停机（`engine.py:669`）。官方：V2 的结算状态在 `resolutionStatus`（`inactive`/`active`/`resolved`），V1 继续用 `umaResolutionStatus`。若某 V2 市场 resolved 后 `acceptingOrders` 未及时翻转，会出现**在已结算市场上继续挂单**的窗口。

**修复**：`refresh_market_metadata()` 增加按 version 分派的状态读取，`resolved` 直接进 `_halted`。

---

#### P1-8｜成交计算未按 V2 规则核验

官方给了 V2 的自算成交公式与两个反直觉规则：

- `counterAmount = floor(makerAssetFill × takerAmount / makerAmount)`
- **ExchangeV3 会按实际花费扣减 BUY 的剩余抵押预算**
- **GTC/GTD 的 BUY 目标是份额；FOK/FAK 的 BUY 目标是抵押品**
- BUY 手续费**加到**抵押品支出；SELL 手续费**从**收入扣除

当前 `userstream/parse.py:62` 直接取 `mo["matched_amount"]` 作为份额。对本项目而言（post-only 永远做 maker，只用 GTC）**大概率无需改动**，但 `moneydoctor` 用 FAK 市价单自检（`gateway.market_order(fak=True)`），**FAK 的 amount 语义在 V2 下变成抵押品**——需要按 `market_order` 的调用点重新核验 `amount` 单位。

**修复**：加一条针对 FAK/FOK 语义的断言与文档注释；在 `moneydoctor` 里显式标注 amount 单位。

---

### P2 — 中优先级（健壮性 / 可观测性）

| # | 问题 | 位置 | 说明 |
|---|---|---|---|
| P2-9 | catalog 无 TTL，元数据可陈旧 64 天 | `engine.py:179` | 应校验 `scanned_ts` 新鲜度并强制回源 Gamma（因为 **version 只有 Gamma 权威**） |
| P2-10 | `token_balances` 无法区分"读到 0"和"读不到" | `gateway.py:356-397` | 非空 dict 全 0 时保护失效；应返回 `None` 或 `Optional[dict]` |
| P2-11 | `collateral_balance` 的启发式换算可疑 | `gateway.py:406` | `v / 1e6 if v > 1e6 else v`——官方明确 `balance` 是 **6 位定点字符串**，应无条件 `/1e6`。浮点启发式会在余额恰好 ≤1 pUSD 时少算 100 万倍 |
| P2-12 | 市价单/撤单的 V2 语义未标注 | `gateway.py:228,264` | `OrderMarketCancelParams(asset_id=...)` 在 V2 下应是 position ID；官方明确"市场级撤单用 condition ID"，需要区分单资产撤单 vs 市场级撤单 |
| P2-13 | WSS 应用层心跳未实现 | `marketdata/service.py:117` | 当前依赖协议层 `ping_interval=5/ping_timeout=10`；官方要求**应用层每 10s 发文本帧 `PING`**，服务端回 `PONG`。协议层 ping 实测可用，但与应用层心跳是两条独立机制，建议补齐以匹配官方预期 |
| P2-14 | 无 V2 授权自检 | `doctor.py` | `doctor` 应在 V2 市场上检查 `allowances[ExchangeV3]`，否则首次下单才失败 |
| P2-15 | `parse_market` 对非 2-outcome 的 V2 市场无区分日志 | `catalog/gamma.py:129` | 目前静默 `return None`，扫描时看不到"因 V2 被丢弃"的市场数量。加一条 `log.debug/info` 计数便于观测迁移进度 |

---

### P3 — 低优先级（官方建议 / 长期）

| # | 建议 | 来源 |
|---|---|---|
| P3-16 | 官方做市建议：**GTC/GTD 为主 + post-only**（已满足✅）、**无原地改单，必须 cancel/replace**（已满足✅）、**批量提交**（已满足✅）、**价格护栏校验中间价**（部分满足）、**kill switch**（已满足✅）、**重连后先拉 open orders + 近期 trades 再恢复**（已满足✅） | `/trading/market-making` |
| P3-17 | 授时/延迟：延迟市场上被 delay 的订单**不可撤**（`engine` 的 reconciliation 需容错 `delayed` 状态）；`GET /clob-markets/{condition_id}` 的 `itode: true` 可预判 | `/concepts/order-lifecycle` |
| P3-18 | 返佣细节可写入报告/评分：按市场独立计算、每日 UTC 发放、**最低 $1 才发放**、返佣比例由 Polymarket 单方决定 | `/programs/maker-rebates` |
| P3-19 | 流动性激励实际评分公式：`S(v,s)=((v-s)/v)²·b`，scaling factor `c=3.0`，双侧 `Qmin` 规则、中点须在 `[0.10,0.90]` | `/programs/liquidity-rewards` |
| P3-20 | 考虑迁移到统一 SDK `polymarket-client>=0.12.0`（Python ≥3.11）——它原生区分 `position_id`/`token_id`、内置 `setup_trading_approvals()`、并覆盖 Gamma/Data API | `/migrate/clob-sdk-to-unified-sdk` |

---

## 5. 优化方案：三阶段迁移路线

### 阶段划分原则

- **Phase 0 是硬 deadline 驱动**（Data API v1 于 2026-10-24 退役），**与 Protocol V2 是否上线无关**，必须最先做。
- **Phase 1 是"能力就位"**：让系统**能**处理 v2，但行为对 v1 市场零改变（关键：可随时部署，无回归风险）。
- **Phase 2 是"链上落地"**：授权、余额、merge 的 V2 分支。
- 每阶段结束都应保持 `111 tests` 全绿 + ruff/mypy 干净。

---

### Phase 0｜立即做（不依赖 V2 上线，硬 deadline）

| 任务 | 文件 | 验收 |
|---|---|---|
| 0.1 升级 SDK 到 `py-clob-client-v2==1.2.0` | `pyproject.toml` | `uv lock` 更新；`_resolve_order_routing`/`exchange_v3` 可用；现有 111 测试全绿 |
| 0.2 Data API 改读 `/v2/positions` | `gateway.py:479-498` | 用 `data[].token_id` / `current_size` / `avg_price`；跟随 `next_cursor`；`status=OPEN`；`429` 退避 |
| 0.3 修复 `collateral_balance` 定点换算 | `gateway.py:399-409` | 无条件按 6 位小数换算；补单测覆盖 `<1 pUSD` 边界 |
| 0.4 `token_balances` 失败语义 | `gateway.py:356-397` | 返回 `dict \| None`，全失败时 `None`；`_check_position_divergence` 对 `None` 早退 |
| 0.5 换用新 NegRisk 适配器 | `merge.py:27` | `0xd91E80...296` → `0xadA2005600Dec949baf300f4C6120000bDB6eAab`；merge 失败加 `alerter.alert` |
| 0.6 catalog 新鲜度校验 | `engine.py:179` | `MarketMeta` 带 `scanned_ts`，超 TTL（如 24h）强制回源 Gamma |

> **Phase 0 完成后**：CTF 路径完全保持现状，同时消除 18 天后的服务中断风险，并拿到 V2 所需的 SDK 能力。

---

### Phase 1｜能力就位（可随时部署，对 v1 零行为改变）

**1.1 扩展领域模型**

```python
# src/polymaker/domain.py
class ProtocolVersion(str, Enum):
    V1 = "v1"          # CTF token ID, ExchangeV2, domain "2"
    V2 = "v2"          # Position ID,  ExchangeV3, domain "3"

@dataclass(frozen=True, slots=True)
class TokenMeta:
    token_id: str          # 保持字段名不变以最小化改动面
    outcome: str
    version: ProtocolVersion = ProtocolVersion.V1   # 新增

@dataclass(frozen=True, slots=True)
class MarketMeta:
    ...
    version: ProtocolVersion = ProtocolVersion.V1   # 新增（市场级）
```

**1.2 按 `version` 选择 ID（核心）**

```python
# src/polymaker/catalog/gamma.py  parse_market()
raw_version = str(raw.get("version") or "").lower()
if raw_version == "v2":
    version, ids = ProtocolVersion.V2, raw.get("positionIds")
elif raw_version == "v1":
    version, ids = ProtocolVersion.V1, _json_list(raw.get("clobTokenIds"))
else:
    log.warning("unsupported_market_version", slug=raw.get("slug"), version=raw_version)
    return None                      # 官方：把 v1/v2 之外的版本视为不支持

if version is ProtocolVersion.V1:
    ids = _json_list(raw.get("clobTokenIds"))
token_ids = ids if isinstance(ids, list) else []
if len(token_ids) != 2 or len(outcomes) != 2:
    return None
# 官方：拒绝非十进制 ID
if not all(_is_decimal(x) for x in token_ids):
    log.warning("non_decimal_asset_id", slug=raw.get("slug"))
    return None
```

> ⚠️ **注意 `clobTokenIds` 是 JSON 字符串，`positionIds` 是原生数组**——两者解析方式不同，这是最容易写错的一行。
> ⚠️ **绝不能用 `if raw.get("positionIds")` 判定 V2**（实测 v1 市场也带该字段，文档亦明确警告）。

**1.3 下单路径分流**

```python
# src/polymaker/execution/gateway.py  place()._place()
for q in quotes:
    if meta.version is ProtocolVersion.V2:
        args = OrderArgsV2(position_id=q.token_id, price=q.price, size=q.size, side=q.side.value)
    else:
        args = OrderArgsV2(token_id=q.token_id, price=q.price, size=q.size, side=q.side.value)
    signed = self._client.create_order(args, options=opts)
```

SDK 1.2.0 的 `_resolve_order_routing` 会据此自动选 ExchangeV3 与域版本 `"3"`。

**1.4 余额读取抽象**

```python
# 新增 src/polymaker/execution/ledger.py
LEDGER = {ProtocolVersion.V1: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",   # Conditional Tokens
          ProtocolVersion.V2: "0x006F54F7f9A22e0000CC2AB60031000000ae9fEF"}   # PositionManager
```

`token_balance(s)` 按 `meta.version` 选账本。注意官方未在页面上给出 PositionManager 的 `balanceOf` 签名，但 PositionManager 是标准 ERC-1155 账本，`balanceOf(address,uint256)` 是**推断**而非文档保证——**Phase 1 必须先在真实 v2 市场做只读验证**（见 §6）。

**1.5 resolution 状态**

`refresh_market_metadata()` 按 version 读 `resolutionStatus`（v2）或 `umaResolutionStatus`（v1）；`resolved` → `_halted`。

**Phase 1 验收**：对全部 v1 市场行为**逐位不变**（用 journal 回放或 A/B 对比 `TargetQuotes`）；v2 市场在 paper 模式下能完成"订阅 → 报价 → 记账"全链路。

---

### Phase 2｜链上落地（V2 真正可交易）

| 任务 | 实现 | 关键细节 |
|---|---|---|
| 2.1 授权自检 | `doctor` 检查 `asset_type=COLLATERAL` 与 `CONDITIONAL-V2` 的 `allowances[0xe333...00Aa]` | BUY 需 pUSD→ExchangeV3；SELL 需 PositionManager→ExchangeV3 |
| 2.2 授权执行 | 新增 `gateway.ensure_v2_approvals()` | 一次性，需等上链确认后再刷新 CLOB 缓存（`/balance-allowance/update`，50 req/10s） |
| 2.3 `balance_allowance` 支持 V2 | 传字符串 `"CONDITIONAL-V2"` 绕开 1.2.0 `AssetType` 缺项 | **属未文档化旁路，须实盘验证**；失败则回退到直接 REST |
| 2.4 V2 merge | 新增 Router 分支：`merge(bytes31 conditionId, uint256 amount)` | `conditionId` 由 position ID 派生：`positionId >> 8` 后编码为**恰好 31 字节**（保留前导零）；`bytes32` 边界右补零；`1_000_000` = 1 pUSD/1 share；需 `PositionManager.setApprovalForAll(ROUTER, true)` |
| 2.5 V2 redeem | `redeem(bytes31 conditionId, uint256 outcomeIndex, uint256 amount)` | `outcomeIndex` 为 `0`=YES / `1`=NO（**取代** CTF 的 index set `1`/`2`）；或启用 AutoRedeemer：`positionManager.setApprovalForAll(AUTO_REDEEMER, true)` |
| 2.6 迁移上下文 | `state.force_set_position` 保护 + `_merging` 去重 | V2 下 `token_balances` 返回 0 时必须区分"空仓"与"读不到" |

**Phase 2 验收**：见 §6。

---

## 6. 验收标准与回归测试清单

### 6.1 只读验证（Phase 1 前必做，零资金风险）

用一个真实的 v2 市场（可从官方文档示例 `0x017089ce3ba22aaa0a4cba8250b8c8e1eb0000000000000000000000000000` 或 Gamma `version=v2` 查询入手）验证：

- [ ] `GET /markets?limit=1` 返回 `version="v2"` 与 `positionIds` 数组（而非 JSON 字符串）
- [ ] `GET https://clob.polymarket.com/book?token_id=<POSITION_ID>` 返回 `"version":"v2"`（官方：CTF book 无此字段）
- [ ] `balanceOf` 在 **PositionManager `0x006F54...9fEF`** 上返回数值；在 Conditional Tokens 上返回 0（**验证推断的 ABI**）
- [ ] position ID 位布局自检：`moduleId = pid >> 248` ∈ {1,2,3}；`outcomeIndex = pid & 0xff` ∈ {0,1}；YES/NO 两个 ID 仅差 1
- [ ] `conditionId` 派生自检：`encodeBytes31(pid >> 8)` 的**末字节为零**（官方给的窄化校验）
- [ ] Gamma `conditionId` 的末 12 个 hex 是否全 0（文档示例为 `...eb0000000000000000000000000000`）—— 决定市场级撤单与 user-stream `markets` 该传哪个值
- [ ] **一致性断言**：V2 市场下 `Gamma.conditionId == encodeBytes31(positionId >> 8)`。这条决定了一个关键分叉——若相等，则 `MarketMeta.condition_id` 与 `asset_ids` 天然自洽（`engine._token_cid` 映射无需改动）；若不等，说明 Gamma 给的是旧 CTF condition ID，则 `state` 的 token→condition 反查表、`userstream` 的 `markets` 过滤、`_event_group_cost` 全部需要按 version 分派
- [ ] `asset_type=CONDITIONAL-V2` 的 `/balance-allowance` 实测是否被接受（文档/spec 冲突项）

### 6.2 单元测试（新增，纯离线）

| 测试 | 内容 |
|---|---|
| `test_parse_market_v2_selects_position_ids` | `version=v2` → 取 `positionIds`（数组形式） |
| `test_parse_market_v1_selects_clob_token_ids` | `version=v1` → 取 `clobTokenIds`（**JSON 字符串**形式） |
| `test_parse_market_both_fields_present_uses_version` | **两字段同时存在**时以 `version` 为准（官方强制要求） |
| `test_parse_market_rejects_unknown_version` | `version="v3"` / 缺失 / `null` → `None` |
| `test_parse_market_rejects_non_decimal_ids` | 非十进制 ID → `None` |
| `test_place_routes_position_id_for_v2` | mock client，断言 V2 传 `position_id=`，V1 传 `token_id=` |
| `test_token_balance_uses_position_manager_for_v2` | 断言合约地址按 version 分派 |
| `test_positions_v2_parses_current_size_not_total_size` | 断言用 `current_size`；用 `total_size` 的样本必须失败 |
| `test_collateral_balance_fixed_point` | `balance="500000"` → 0.5（回归 P2-11） |
| `test_merge_condition_id_bytes31_narrowing` | 派生 ID 末字节非零时拒绝 |

### 6.3 小额实盘验收（Phase 2，官方"Verify the Migration"要求）

官方明确要求**在 v2 和 CTF 两个市场上都验证 BUY/SELL 成交与余额**：

- [ ] V2 市场：深度 post-only 挂单 + 撤单（无成交，免费）→ 验证签名域 `"3"` 被接受
- [ ] V2 市场：最小额 BUY → user-stream `trade` 事件 → 内部 `positions` 与 PositionManager 链上余额一致
- [ ] V2 市场：最小额 SELL → 验证 `setApprovalForAll(EXCHANGE_V3)` 生效
- [ ] V2 市场：merge 一对 YES+NO → pUSD 到账 → `token_balances` 归零
- [ ] **CTF 市场重复上述四项**（官方要求的回归，确保 v1 未被破坏）
- [ ] 心跳：`POST /v1/heartbeats` 5s 节奏、10s 超时行为不变

---

## 7. 附录：地址与 ABI 速查

### 7.1 按 version 分派总表（官方权威）

| Gamma `version` | 仓位系统 | Outcome ID | ERC-1155 账本 | 交易所域版本 | 交易所地址 |
|---|---|---|---|---|---|
| `"v2"` | Polymarket V2 | `positionId` | PositionManager | `"3"` | ExchangeV3 |
| `"v1"` | CTF | `tokenId` | Conditional Tokens | `"2"` | CTF Exchange |

> 官方原话：**"字段存在与否不能可靠地区分系统"**——**只认 `version`**。

### 7.2 关键合约（Polygon 137）

| 合约 | 地址 |
|---|---|
| **ExchangeV3** | `0xe3333700cA9d93003F00f0F71f8515005F6c00Aa` |
| **PositionManager**（proxy） | `0x006F54F7f9A22e0000CC2AB60031000000ae9fEF` |
| **Router**（proxy） | `0x12121212006e4CD160D18e3f00711DA5c3372600` |
| CTF Exchange（V2 域） | `0xE111180000d2663C0091e4f400237545B87B996B` |
| Neg Risk CTF Exchange | `0xe2222d279d744050d28e00520010520000310F59` |
| Conditional Tokens（CTF） | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` |
| pUSD（CollateralToken） | `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` |
| Neg Risk Adapter（**已弃用**） | `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296` |
| NegRiskCtfCollateralAdapter（**当前**） | `0xadA2005600Dec949baf300f4C6120000bDB6eEab` |
| AutoRedeemer | `0xa1200000d0002264C9a1698e001292D00E1b00af` |
| BinaryModule | `0x1000008dD9001B968442c1000017eaE6E0dA00Ba` |
| NegRiskModule | `0x200000900045e3B6259600682756002200028933` |

### 7.3 V2 关键 ABI

```solidity
// Router —— 注意 conditionId 是 bytes31
function split(bytes31 conditionId, uint256 amount)
function merge(bytes31 conditionId, uint256 amount)
function redeem(bytes31 conditionId, uint256 outcomeIndex, uint256 amount)

// PositionManager
function getPayout(uint256 positionId, uint256 amount) view returns (uint256)
// 余额读取（标准 ERC-1155，官方页面未明示，需实测验证）
function balanceOf(address account, uint256 id) view returns (uint256)
```

### 7.4 V2 EIP-712 签名域

```json
{ "name": "Polymarket CTF Exchange", "version": "3", "chainId": 137,
  "verifyingContract": "0xe3333700cA9d93003F00f0F71f8515005F6c00Aa" }
```

### 7.5 Position ID 位布局

```text
[moduleId | baseHash | arity | reserved | resolutionChain | conditionIndex | outcomeIndex]
  8 bits    128 bits  16 bits   64 bits       16 bits          16 bits          8 bits
  248-255   120-247   104-119   40-103        24-39             8-23             0-7
```

```text
moduleId       = positionId >> 248            (1=Binary, 2=NegRisk, 3=Combinatorial)
outcomeIndex   = positionId & 0xff            (0=YES, 1=NO)
conditionId    = positionId，清除 bit 0..7     → bytes31
eventId        = positionId，清除 bit 0..23    → bytes29
conditionIndex = (positionId >> 8) & 0xffff
arity          = (positionId >> 104) & 0xffff
```

> `bytes31`/`bytes29` 在 `bytes32` 边界处**右补零**。Binary 条件 arity=0、conditionIndex=0，故 Condition ID 与 Event ID 位等价。

---

## 8. 结论与建议行动顺序

**当前状态**：代码质量高、架构清晰、测试扎实，**没有任何 V2 相关代码**（grep 0 命中）。今天可以正常运行，因为实测 1200 个活跃市场 **100% 是 `v1`**。

**风险判断**：这不是"要不要迁移"的问题，而是**三个独立 deadline 叠加**：

1. **Data API v1 于 2026-10-24 退役**（**18 天后**）——与 V2 无关，必然中断。
2. **Neg Risk Adapter 已于 2026-07-17 退役**——neg-risk 市场的 merge 目前**很可能已在静默失败**。
3. **Protocol V2 上线时间未公布**，但一旦有新市场以 `v2` 发布进入扫描范围，当前代码存在**在错误资产上成交**的路径。

**建议行动顺序**（按投入产出比）：

| 顺序 | 动作 | 工期估计 | 理由 |
|---|---|---|---|
| 1 | **Phase 0**（6 项） | 1–2 天 | 消除 18 天后的硬中断 + 修复已失效的 neg-risk merge + 拿到 V2 所需 SDK 能力 |
| 2 | **§6.1 只读验证** | 0.5 天 | 把"推断"变成"事实"（尤其 PositionManager `balanceOf` 与 `CONDITIONAL-V2`），避免后续基于错误假设开发 |
| 3 | **Phase 1**（能力就位） | 2–3 天 | 对 v1 零风险可部署；V2 上线即自动适配，无需临场改动 |
| 4 | **Phase 2**（链上落地） | 3–5 天 | 需要真实 v2 市场才能完整验收；可等 v2 市场出现后再做 2.4/2.5 |

**一个必须坚持的设计原则**：所有 V2 相关判断**只允许读 Gamma 的 `version`**。不要用"有没有 `positionIds`"、"conditionId 末位是否为零"、"token ID 数值大小"之类的启发式——官方已明确警告字段存在性不可靠，而实测数据（v1 市场带 `positionIds`）也证实了这一点。

---

*报告基于 2026-10-06 的代码与官方文档快照。官方文档为前向日期快照（changelog/audit 条目日期至 2026-10），本报告在发现文档与 `clob-openapi.yaml` 冲突处均已标注，未做归一化处理。*
