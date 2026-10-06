# 修复与验证报告：Protocol V2 就位 + 策略经济性重构

**日期**：2026-10-06
**分支**：`v2-migration-strategy-rework`
**提交**：`5eb9bc5`
**验证状态**：151 tests passed / 2 skipped，mypy strict 干净，ruff 干净
**实测验证**：对真实市场跑了两次全量扫描（2,100 个市场、1,949 个盘口实测），复核了新排名模型

---

## 0. 一句话结论

**代码已按两份对抗性审查的全部 CRITICAL/HIGH 缺陷修复并经实测复核，但这不等于"可以部署赚钱"。** 有三个独立结论必须分开看：

1. **迁移就位**：V2 能力已正确接上（`position_id` → ExchangeV3 / 域版本 `"3"` 已用密码学方式验证）。
2. **代码缺陷**：两份审查共报告 35 项缺陷，CRITICAL/HIGH 的已修复并加回归测试；剩余 MEDIUM/LOW 见 §4。
3. **策略经济性**：**仍然没有证据表明 $450 能赚钱**，而且现在多了一条硬约束——merge 在部署配置下不可用，见 §5。

---

## 1. 已完成并通过验证的修复

### 1.1 Protocol V2 就位（Phase 0/1）

| # | 修复 | 证据 |
|---|---|---|
| 1 | SDK `1.0.2 → 1.2.0` | 1.2.0 新增 `exchange_v3` / `position_id` 路由；已实测签名路由 |
| 2 | 按 Gamma `version` 选 ID | `parse_market` 只认 `version`；v1 取 `clobTokenIds`（JSON 串），v2 取 `positionIds`（原生数组）；拒绝未知版本与非十进制 ID |
| 3 | V2 签名路由 | **密码学验证**：`position_id` → `0xe3333700...c00Aa` + 域版本 `"3"`（`neg_risk` 两种取值都对）；v1 → CTFExchangeV2 + `"2"`。已固化为回归测试 |
| 4 | 账本按版本分派 | `ledger.py`：v1 → Conditional Tokens，v2 → PositionManager；`MarketMeta.ledger()` |
| 5 | Data API v1 → v2 | `/v2/positions`，`data[]` 包封、snake_case、`current_size`（**不是** `total_size`）、cursor 分页、429/5xx 退避 |
| 6 | `resolutionStatus` | v2 读 `resolutionStatus`，v1 读 `umaResolutionStatus`；`resolved` 直接 halt |
| 7 | NegRisk 适配器 | `0xd91E80cF...`（2026-07-17 已退役）→ `0xadA20056...eAab`，并加失败告警 |

### 1.2 对抗性审查发现的缺陷（已修 + 回归测试）

| 缺陷 | 症状（若不修） | 修复 |
|---|---|---|
| **markout 价格空间错位** | 记录 NO 的 `1-fv`、却拿 YES 的 fv 求差 → 对 0.195 的市场伪造 `-0.61` 的 markout → toxicity 0.61 → 报价被夹进零得分区、尺寸缩到下限。**首次 NO 成交即触发（那是主力报价腿）** | 记录与结算统一到被成交腿的价格空间；`token_in_yes_space` 回调。回归测试断言"不变 fv 的 NO 成交 toxicity 必须为 0" |
| **`open_orders` 失败返回 `[]`** | 失败被当成"服务器上没单"→ 清空本地订单 → reconciler 重新挂一遍 → **重复挂单且无 id 可追踪** | 返回 `None`；全部 6 个调用点跳过破坏性对账；解析失败的行改为计数告警 |
| **FAILED 只回滚仓位不回滚现金** | `net_cash` 永久少记 → equity 被低估 → **日亏熔断在从未花掉的钱上触发**，且重启后无法回滚 | 回滚同时通知 risk；新增 `store.reverse_fill()` 按持久化记录回滚（跨重启幂等） |
| **持仓消失永不清零** | merge/redeem/手工卖出后仓位从 API 消失，内部永远保留幽灵份额 → 挂出无法交付的卖单 | `reconcile_positions(..., authoritative=True)` 清零并告警 |
| **敞口上限不计挂单** | 挂单不是"持仓"→ $450 账户可挂出约 $420 的买单而所有上限看不见 | `resting_buy_notional` 计入上限；配对腿净额化（对冲对不再重复计风险） |
| **奖励带夹取忽略 `|fv-mid|`** | 得分按到**中价**的距离算，夹取只约束 δ → 报价落在带外、**零得分却承担全部成交风险** | 按 `band - |fv-mid| - min_edge` 夹取；装不下就撤单。修掉一个浮点边界（`0.03-0.01=0.0199999…`） |
| **退出紧迫度是死配置** | `exit_urgency_s` 从未被读取 → 卖单永远挂在 `fv+δ`（市场之上）→ **库存只能等价格涨回来才可能成交** | 按持仓时长计算紧迫度；halt/reduce-only 时强制拉满 |
| **`trend_flow_z` 不可达** | z 的数学上界是 1，而配置是 1.5/1.8/2.6 → 单边流防御**从未生效** | z 改为 mean/RMS 并**明确证明上界为 1**；配置改为 0.6/0.75/0.85；加校验器拒绝 >1 的值（立刻抓到了旧配置） |
| **低于奖励下限的单照挂** | 下限 bump 会**覆盖风控缩量**（实测把被限流的 153.8 股翻成 300 股） | 合并层数直到每层达标；仍不达标则拒挂，而不是抬价 |
| **关停竞态** | `cancel_all()` 可能在 `place()` 的 POST 仍在飞行时返回 → 订单在撤单之后落地 → **进程退出时留下活的未追踪订单** | 先 await 取消的任务、再 drain 线程池、最后 cancel_all |
| **merge 无 RPC 超时** | 一次挂起的 RPC 永久占住 chain lock → 所有 merge 静默停摆 | 20s 硬超时 + 4 个端点回退 |
| **merge 失败静默** | 缺 builder 凭证时 `can_merge=False`，告警条件也判 False → 完全无信号 | 区分"不可用"与"尝试后失败"，分别告警 |

### 1.3 策略经济性重构

**旧模型的错误**（已在报告中指出）：`rebate_potential` 返回整池美元再乘一个最高 0.5 的 `our_share`，且用 `1/(1+spread×20)` **惩罚宽价差**——对做市商而言宽价差是收入来源、高流动性是竞争对手。它把 Newsom（65,514 加权股的饱和池、每天只给 50 股约 2 美分）排在高位。

**新模型**：按 **每 1 美元占用资本的风险调整后激励收益** 排名，全部量都能从 Gamma 奖励参数 + 一次真实盘口读数算出：

```
加权深度(小侧) = Σ size × ((band − |mid − price|) / band)²     仅带内
我方日收入     = pool × rmin / (加权深度 + rmin)
占用资本       = rmin 股（双腿合计，1 美元/股）
日收益率       = 我方日收入 / 占用资本
毒性           = max(换手压力, 波动/band)      → 折扣收益
```

三条硬护栏（都是实测暴露出来的）：
- **没有盘口读数 → 收入记 0**（未测量 ≠ 无竞争）
- **价差 > band → 收入记 0**（挂在中价 touch 也在带外，不计分）
- **带内无深度 → 收入记 0**（否则空盘口会让人以为能独吞整个池子）

**实测复核**（2,100 个市场、1,949 个盘口）：

| 指标 | 旧模型 | 新模型 |
|---|---|---|
| 榜首资本占用 | **$1.80**（用便宜腿，把 0.002 的市场算成 44 美分） | **$20** |
| 榜首日收益率 | **2,777%/天** | **64%/天** |
| 资本范围 | 0–$8 | $20–$200（限制在最小计分单） |
| 有正收入的市场 | — | 934 / 2,098 |
| yield 中位数 | — | 1.21%/天 |

新模型仍会给出高百分比，因为它按**最小计分单**（$20）计算，而小池子（$20–50/天）在竞争稀疏时确实能给出高比率。**但绝对金额小**：$20 资本 × 64%/天 ≈ $12.9/天。这不是 bug，是资本约束的结果——**这也是为什么 §5 的结论没变**。

---

## 2. 验证方式（不是只跑单测）

| 手段 | 内容 |
|---|---|
| 单元测试 | 151 passed（新增：协议路由/签名域/账本、markout 价格空间、失败回滚现金、V2 选择、奖励带、资本口径） |
| 类型/静态 | mypy strict 39 文件干净；ruff 干净 |
| 真实数据 | 两次全量扫描 2,100 市场 / 1,949 盘口实测，复核排名分布 |
| 密码学验证 | 捕获 SDK 实际构造的 `ExchangeOrderBuilderV2(contract, domain_version)`，确认 `position_id → ExchangeV3 + "3"` |
| 负向测试 | 校验器成功拦截了仓库里原有的不可达 `trend_flow_z=1.8` |

---

## 3. 我明确**没有**做到的（不要误读为已完成）

1. **没有任何实盘成交数据。** `fills` 表仍是 0 行。所有经济性结论都是**模型 + 真实盘口参数**，不是实测盈亏。
2. **V2 合并被默认关闭**（`wallet.merge_v2_enabled=false`）。Router 的 `merge(bytes31,...)` calldata 由文档 ABI 推导并单测覆盖，**但从未在真实 v2 市场上执行过**。开启前必须做一次小额实盘验证。
3. **没有 v2 市场可供端到端验证。** 实测 1,200 个活跃市场 100% 是 `v1`，所以 v2 路径只有离线验证。
4. **PositionManager 的 `balanceOf` 是推断，不是文档保证。** 官方页面只给了 `getPayout`。
5. **`CONDITIONAL-V2` 不在官方 OpenAPI 枚举里**，只出现在迁移指南正文——文档与 spec 冲突，需实盘确认。

---

## 4. 剩余的未修项（MEDIUM/LOW，按影响排序）

这些我**没有修**，因为它们要么需要实盘验证、要么需要产品决策，不应在没有验证的情况下改：

| 级别 | 问题 | 影响 |
|---|---|---|
| MED | 盘口无 snapshot/delta 时序与 hash 校验；120s REST 只比 top-of-book | 迟到的 snapshot 覆盖更新的 delta → top-3 深度（microprice、sweep 检测）可能损坏且不自愈 |
| MED | **tick 变化时 `meta.tick_size` 不刷新**（`_apply_meta_refresh` 不含 tick_size） | 价格靠近 0/1 时 Polymarket 会把 tick 从 0.001 改到 0.01；订单按旧 tick 签名 → 被拒 → 批量失败 → quarantine 抖动 |
| MED | `note_fill` 在 token 过滤**之前**执行；equity 不反映出入金 | 手工 UI 成交会进入 bot 的现金/PnL；提款看起来像亏损 → 可能误触熔断 |
| MED | `_parse_place_response` 按下标绑定响应与请求 | 批响应乱序会把订单 id 绑到错误的价位 |
| MED | `place()` 不按 `max_orders_per_batch` 分块 | layers 配大时整批被拒 |
| LOW | `round_to_tick` 的 `max(p, tick)` 在极端盘口可把买单抬到 best_ask | 仅当卖侧全在最小 tick 时可达 |
| LOW | `Ewma.update` 接受乱序时间戳；σ 按事件而非按时间归一 | σ 是事件采样 RMS，与配置里"1 分钟波动率"的单位不一致 |
| LOW | 无逐 token 陈旧检测（只有连接级） | 单资产订阅失败在活跃连接下不可见 |

**建议**：MED 里的 tick_size 刷新和 `note_fill` 作用域应该在下一次部署前修掉——它们会在真实运行中触发。

---

## 5. 关于"能不能赚钱"：结论未变，且多了一条硬约束

代码修好了，但**策略层面的判断没有改变**：

### 5.1 merge 在部署配置下不可用（这是新确认的硬约束）

`config.toml` 是 `signature_type=3`（DepositWallet），而 DepositWallet 的 merge 需要 builder 凭证；`.env` 里只有代理变量，**没有 `POLY_BUILDER_*`** → `can_merge = False` → **merge 从不执行**。

这意味着策略宣称的收益来源之一（"双腿成交后 merge 回收、锁定 `1-p-q` 的价差"）**在部署配置下是关闭的**。收益只剩激励 + 被动退出。

（顺带发现 `.env` 里的本地代理 `127.0.0.1:7897` **已经死了**——实测直连可用。这会让任何走 httpx 的调用全部连不上，包括 `doctor`/`scan`/bot 本身。这是个部署前必须处理的问题。）

### 5.2 数字（用新模型，真实盘口）

- 新模型选出的最佳市场：**$20 资本 → 约 $12.9/天**，收益率 64%/天。要放大到有意义的绝对金额就必须加大挂单量，而挂单量受**最小计分股数**约束（这些市场是 20–100 股），加大挂单会同时稀释自己的池子份额。
- 池子最大的市场（$11k–15k/天）最小计分是 **1,000 股，双腿需 $1,000+**，超出 $450 资金。
- 单次不利成交的代价：实测 1 分钟波动率 0.0001–0.056，而可报价价差只有 1–2 tick（0.001–0.01）。**一次 10-tick 逆行 = 150 股 × 0.01 = $1.50，等于 21 天的激励收入**（按 Newsom 的 $0.069/天）。

### 5.3 结论

**修复提升了代码的正确性和安全性，但没有把"未验证的策略"变成"已验证的策略"。**

要在花钱之前回答"能不能赚钱"，唯一的路仍然是**小额实测**（$50–100，1–2 周，跑现在修正后的模型选出的市场），测量：
1. 实际成交笔数、**单腿 vs 双腿比例**
2. 每笔成交后 5/15/60 分钟的真实 markout（现在这个信号至少在数学上是对的）
3. 实际到账的激励（对照 CLOB 结算记录）

**判定**：若 `激励 + 价差 > 逆选择损失` 且单腿比例 < ~50% → 再考虑放大和开启 V2 merge；若持续为负 → 这套策略在 $450 规模上不成立，应关停而不是继续投入。

---

## 6. 部署前必须处理的清单

- [ ] **修 `.env` 的死代理**（`127.0.0.1:7897` 无监听），否则 bot/doctor/scan 全部连不上
- [ ] **决定 merge 方案**：补 `POLY_BUILDER_*` 凭证（让 sig_type=3 的 merge 可用），或明确接受"不 merge、只靠激励 + 限价退出"
- [ ] 修 §4 里的 **tick_size 刷新** 与 **`note_fill` 作用域**
- [ ] 若要用 V2：先用真实 v2 市场验证 (a) PositionManager `balanceOf`、(b) `CONDITIONAL-V2` 是否被接受、(c) 一次小额 Router merge
- [ ] 跑小额实测并按 §5.3 判定

---

## 7. 变更清单

```
pyproject.toml                     SDK 1.2.0
src/polymaker/domain.py            ProtocolVersion + version/scanned_ts/resolved
src/polymaker/execution/ledger.py  新增：账本/资产类型/position-id 编解码
src/polymaker/execution/gateway.py v2 positions、None 语义、按版本分派、drain()
src/polymaker/catalog/gamma.py     按 version 选 ID、直接查询、resolutionStatus
src/polymaker/catalog/scoring.py   重写：资本约束净值 + 毒性
src/polymaker/catalog/scanner.py   实测盘口（有界并发）
src/polymaker/catalog/store.py     兼容旧 score 行
src/polymaker/strategy/quoting.py  奖励带夹取、层合并、exit_urgency
src/polymaker/strategy/estimators.py  markout 价格空间、真实 z
src/polymaker/risk/manager.py      重写：挂单敞口、配对净额、滚动错误窗口
src/polymaker/state/store.py       authoritative reconcile、reverse_fill
src/polymaker/state/tracker.py     FAILED 回滚现金、跨重启回滚
src/polymaker/merge.py             RPC 超时/回退、V2 Router（默认关闭）
src/polymaker/engine.py            盲态/撤单、退出紧迫度、关停排空、merge 告警
src/polymaker/cli.py               新排名列展示
config/strategy.toml, livecfg/     有界 trend_flow_z
tests/test_protocol_version.py     新增 30 项
tests/test_catalog.py, test_state.py, test_estimators.py, test_quoting.py  回归测试
```

---

*本报告的每一项"已修复"都有对应的回归测试或实测证据；每一项"未做实盘验证"都已在 §3/§6 明确标注。对抗性审查的完整原始记录见 `ADVERSARIAL_REVIEW_findings.md`。*
