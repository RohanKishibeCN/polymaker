# Polymaker 优化方案 v2（官方文档核验版）

**生成日期**: 2026-07-31（第一版）
**代码基准**: 当前 HEAD `95ceb7b`
**核验方式**: 逐条对照 Polymarket 官方文档（docs.polymarket.com，经 MCP 检索）与 [market_maker.ts](src/market_maker.ts) 实际执行逻辑
**重要说明**: 本版取代早期版本。早期版本声称"20 项修复已完成"，经官方文档与代码逐条核验，**仅 4 项真正实现，14 项未实现**。请以本版为准。

---

## 目录

0. [重要更正：文档-代码脱节清单](#0-重要更正文档-代码脱节清单)
1. [第一性原理：盈利来源分析](#1-第一性原理盈利来源分析)
2. [官方核验结论（证实 / 修正 / 新发现）](#2-官方核验结论证实--修正--新发现)
3. [当前代码问题清单（核验后）](#3-当前代码问题清单核验后)
4. [优化方案（分四阶段）](#4-优化方案分四阶段)
5. [官方做市指南对照表（验收标准）](#5-官方做市指南对照表验收标准)
6. [附录](#6-附录)

---

## 0. 重要更正：文档-代码脱节清单

早期版本（2026-06-22）声称"Phase 1-3 已完成，20 项修复落地"。逐条对照 [market_maker.ts](src/market_maker.ts) 实际代码后：

| 声称已完成 | 代码实际情况 | 判定 |
|---|---|---|
| Heartbeat 5 秒间隔 | 实际 **30 秒**（`setInterval(..., 30000)`），超官方 10 秒窗口 | ❌ 未实现 |
| 极端价格过滤器（管理/止损不跳过） | 不存在，仅 `price<=0 \|\| price>=1` | ❌ 未实现 |
| 撤单保留 SELL 单 | 每个 cycle 全量取消所有订单 | ❌ 未实现（撤单重挂本身合法，问题在低频+无 GTD） |
| 清仓暂停条件放宽 | 不存在 | ❌ 未实现 |
| maxPositionCount=30 | 实际为 **5**，且未真正执行 | ❌ 未实现 |
| Fills Buy/Sell 追踪 | 恒为 0，快照对比逻辑缺失 | ❌ 未实现 |
| forceCloseDays=7 强制清仓 | 不存在 | ❌ 未实现 |
| 动态 targetMarketsCount | 固定 `maxMarkets=5` | ❌ 未实现 |
| Whitelist 挪仓 / 实时风控告警 | `radar_signals.json` 从未被 market_maker 读取 | ❌ 未实现 |
| SOS 内嵌做市循环 / Smart Money 内嵌 | surf_radar.ts 与做市循环完全脱节 | ❌ 未实现 |
| Rewards 收入监测 | 已实现（activity API 检查 + balance_log 日对比） | ✅ 已实现 |
| pUSD 合约地址 | `0xC011a7...`，与官方一致 | ✅ 已实现 |
| createAndPostOrder 签名 | 已带 tickSize/negRisk/orderType | ✅ 已实现 |
| roundToTickSize | 已实现 | ✅ 已实现 |
| Notion 2000 字符分段 | 已实现 | ✅ 已实现 |
| tickSize-aware 价格舍入 | 已实现 | ✅ 已实现 |

> **结论**：14 项"已完成"中 10 项核心风控/策略项未落地。此前决策建立在错误认知上。

---

## 1. 第一性原理：盈利来源分析

做市商盈利只有三个来源：

1. **价差收入**（低买高卖、库存回转）→ 需要真实盘口 + 双向报价 + 库存偏斜管理
2. **做市激励**（LP Rewards / Maker Rebates）→ 平台补贴，官方随时可调，且是**相对份额零和竞争**
3. **方向性收益**（押对方向）→ 不是做市策略该干的事

**本代码只依赖来源 2（LP Rewards），且未评估自己在池中的相对份额。**

### 1.1 小资金刷 LP Rewards 在官方机制下不成立

官方 [Liquidity Rewards](https://docs.polymarket.com/programs/liquidity-rewards) 公式：

- `S(v,s) = ((v-s)/v)²`
- `Q_normal = Q_min / ΣQ_min` → **与其他做市商竞争同一个池子（零和）**
- **最低支付 $1，低于 $1 不发**（官方 Note）
- 每分钟随机采样，Epoch 7 天，每日 UTC 午夜发放

几百 U 资金在池中份额极小 → 每日奖励远低于 $1 → 拿不到任何钱。**这从数学上否定了"小资金刷 LP Rewards"策略。** 而代码整天按 `total_daily_rate` 排序选市场，从不估算自己在每个市场的可得分额。

### 1.2 Maker Rebates 同样是小资金陷阱

官方 [Maker Rebates](https://docs.polymarket.com/programs/maker-rebates)：

- `rebate = (your_fee_equivalent / total_fee_equivalent) * rebate_pool`（每市场独立竞争）
- 最低累计 **$1 才支付**
- 各类别 rebate：Crypto 20%、Sports 15%、Finance/Politics/Economics 等 25%、**Geopolitics 无费无 rebate**
- 只有你的 maker 单**被吃**才计入

小资金参与 = 份额极小 → 同样拿不到钱。

### 1.3 三大来源一个都没做对

| 来源 | 前提 | 代码现状 |
|------|------|---------|
| 价差收入 | 真实订单簿、双边报价、库存偏斜 | ❌ 从不读订单簿，单向建仓，无库存偏斜 |
| LP Rewards | 份额足够、带内双边报价 | ❌ 小资金零和竞争拿不到，极端价市场无法双边 |
| Maker Rebates | 双边被吃、fee-enabled 市场 | ❌ 无此追踪，Geopolitics 等无费市场也参与 |

---

## 2. 官方核验结论（证实 / 修正 / 新发现）

### 2.1 被官方文档证实 ✅

| # | 论断 | 官方出处 |
|---|------|---------|
| 1 | **Heartbeat 30s 致命**：10 秒未收到有效 heartbeat → 该 API 凭据下所有订单被取消；官方建议每 5 秒发送 | [Manage Orders](https://docs.polymarket.com/trading/manage-orders) |
| 2 | **盲做市**：官方下单流程第一步即"fetch the current order book"；做市最佳实践要求 "Use price guards — validate prices against the book midpoint" | [Place Orders](https://docs.polymarket.com/trading/place-orders)、[Market Making](https://docs.polymarket.com/trading/market-making) |
| 3 | **单向建仓**：midpoint 在 (0.90, 1.0] 或 [0, 0.10) 必须双边报价才得分；代码 `canSell` 需先有库存 → 极端价市场无法双边 | [Liquidity Rewards](https://docs.polymarket.com/programs/liquidity-rewards) |
| 4 | **90% 贱卖直接失血**：rebate/奖励均为相对份额制，贱卖无任何兜底 | [Maker Rebates](https://docs.polymarket.com/programs/maker-rebates) |
| 5 | pUSD 地址 `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` 正确 | [Contracts](https://docs.polymarket.com/resources/contracts) |
| 6 | rewards API 字段 `rewards_min_size / rewards_max_spread / total_daily_rate` 与代码一致 | [Rewards API](https://docs.polymarket.com/api-reference/rewards/get-current-active-rewards-configurations) |
| 7 | 奖励公式 `S(v,s)=((v-s)/v)²` 代码实现正确 | [Liquidity Rewards](https://docs.polymarket.com/programs/liquidity-rewards) |

### 2.2 需要修正的早期论断 ⚠️

| 早期说法 | 官方证据 | 修正 |
|---------|---------|------|
| postOnly 是风险 | 官方明确 post-only"立即匹配则拒绝"是做市商标准用法，做市指南推荐 | **postOnly 不是问题**，从风险清单删除 |
| "全量撤单"是 P0 缺陷 | 官方："订单不可原地修改，改价 = 撤旧单 + 挂新单"（cancel-and-replace 是标准流程） | 撤单重挂本身合理；真正问题是 30 分钟低频（官方要求实时/即时撤陈旧单）+ 全 GTC 无 GTD |
| 限流 35/s 风险 | 官方为 per-signer token bucket：Standard 档 order 40/s、cancel 80/s；另有 `open_orders_limit` 挂单数量上限 | 限流非当前主要矛盾；**open_orders_limit 是需要关注的新限制** |
| Heartbeat 失败 → 订单被清空 | 官方机制是安全特性：只有 heartbeat 被接受后才期待持续心跳 | 更准确推断：若该 Key 心跳从未被接受（代码注释也暗示持续 Invalid Heartbeat ID），订单不会被自动取消，但也**没有自动撤单保护**，陈旧 GTC 单一直挂着——与低频+无 GTD 叠加更危险 |

### 2.3 官方文档带来的新发现 🔍

1. **LP Rewards 是零和竞争 + $1 最低支付门槛** → 小资金刷奖励策略数学上不成立（战略根因）
2. **Geopolitics 市场 fee-free、无 rebate** → 代码无差别做市，部分市场做也是白做
3. **官方做市指南给出完整检查清单**，代码对照缺失：库存偏斜报价（Skew on inventory）、GTD 到期撤单、批量下单（Batch orders）、实时订单更新（Real-time order updates）
4. **奖励接口分页（500/页 + next_cursor）**，`getCurrentRewards()` 只取第一页，可能遗漏市场

---

## 3. 当前代码问题清单（核验后）

### P0（直接导致亏损）

| # | 问题 | 位置 | 说明 |
|---|------|------|------|
| P0-1 | **非奖励持仓按成本价 10% 自动贱卖** | market_maker.ts:658-660 | `sellPrice = avgCost * 0.1`，avgCost=0.5 的仓挂 0.05 卖，被吃即 -90%。奖励市场每日轮换 → 昨日持仓今日触发贱卖 |
| P0-2 | **盲做市（不读订单簿）** | market_maker.ts:760-766 | `bestBid/bestAsk = 最后成交价 ±1%` 虚构盘口，非真实订单簿。官方流程第一步即读 book |
| P0-3 | **单向建仓、库存滚雪球** | market_maker.ts:906-908 | `canSell` 需 held ≥ minSize；极端价市场（0.01/0.99）永远只买不卖 |
| P0-4 | **Heartbeat 30s > 官方 10s 窗口** | market_maker.ts:149 | 若心跳被接受，订单每 30s 后被服务器清空；若从未被接受则无自动撤单保护 |
| P0-5 | **权益按 avgCost 估值，风控数据失真** | market_maker.ts:564-566 | `inv.yes * avgCost` 而非实时市价，回撤/决策基于假数据 |

### P1（重要缺失）

| # | 问题 | 说明 |
|---|------|------|
| P1-1 | 硬止损(-15%)/时间衰减/强制清仓/MaxDD 全为空壳 | 文档声称实现，代码不存在 |
| P1-2 | Fills Buy/Sell 恒为 0 | 快照对比逻辑缺失 |
| P1-3 | 无类别分散 | 同质化事件扎堆风险（早期已诊断，未修） |
| P1-4 | 无到期时间过滤 / 全 GTC 无 GTD | 官方明确建议事件市场用 GTD，到期前避免陈旧暴露 |
| P1-5 | 无单市场/总敞口上限 | 现金瞬间枯竭 |
| P1-6 | 错误被 `catch {}` 静默吞掉（>15 处） | 订单失败无告警，无法诊断 |
| P1-7 | radar_signals.json 与做市循环脱节 | Surf Radar 白跑，SOS/Whitelist/Smart Money 信号无人消费 |
| P1-8 | 内存库存无持久化 | VPS 重启即清零 |
| P1-9 | 无库存偏斜报价 | 官方做市指南核心要求缺失 |

### P2（优化项）

| # | 问题 | 说明 |
|---|------|------|
| P2-1 | 每 cycle 重复调用 positions API 3 次 | 冗余请求 |
| P2-2 | 逐单串行提交，无批量下单 | 官方推荐 batch orders 降延迟 |
| P2-3 | rewards 只取第一页(500) | 官方接口分页，可能遗漏 |
| P2-4 | 每单前实时 RPC 查余额 | N 市场 = N 次 RPC |
| P2-5 | patch 版本错配 | patches 1.0.1 vs 安装 1.0.8，patch-package 可能静默失效 |

---

## 4. 优化方案（分四阶段）

### 阶段 0：止血（上线前必做，改动 <50 行）

1. **删除 90% 贱卖逻辑**（P0-1）——非奖励持仓不自动卖，或按真实市价挂单
2. **Heartbeat 30s → 5s**（P0-4）
3. **全量撤单 → 按需撤单**：仅撤价格偏离 >1¢ 或不在做市列表的订单；关键市场用 GTD 设到期
4. **如当前仍在实盘，建议先暂停**——P0-1 是确定性失血点

### 阶段 1：重建做市内核（真正的修复）

1. **读真实订单簿**（官方 Place Orders 第一步）：`GET /book?token_id=`，用真实 top-level bid/ask 定挂单价
2. **强制双向报价**：无库存时用 BUY NO 等效 SELL YES（官方 Market Making 明确此等价关系）
3. **库存偏斜报价**（官方核心要求）：有 YES 库存 → 压低 YES 卖价/抬高 NO 买价，形成回转闭环
4. **真实流动性过滤**：订单簿 top-level depth 门槛 + spread 过滤（0.02~0.15），跳过无人区
5. **资金硬上限**：单市场 ≤15% 权益、总敞口 ≤60%、现金预留 20%

### 阶段 2：把文档承诺真正落地

- R1/R2/R3（现金缓冲、Whitelist 挪仓、spread 冻结）
- 硬止损 -15% / 时间衰减 / MaxDD 追踪 / Fills 追踪
- radar_signals.json 真正接入做市循环
- 类别分散 + 到期时间过滤 + GTD
- 用实时市价算权益

### 阶段 3：可验证性

- dry-run/模拟盘模式，先用历史数据验证"买→卖→回转"闭环
- 每次改动先写"预期行为"，用日志/日报验证实际行为一致（本次亏损根因即文档与代码脱节）
- 若继续做 LP Rewards / Rebates，先量化自己的相对份额与预计日收益，低于 $1 直接放弃该市场

---

## 5. 官方做市指南对照表（验收标准）

官方 [Market Making](https://docs.polymarket.com/trading/market-making) 最佳实践清单，当前代码状态与验收目标：

| 官方要求 | 当前状态 | 验收目标 |
|---------|---------|---------|
| Quote both sides（双边报价） | ❌ 无库存时单边 | 任何市场可双向报价（BUY YES + BUY NO 或等效） |
| Skew on inventory（库存偏斜） | ❌ 无 | 有库存时价格/尺寸向减仓方向倾斜 |
| Cancel stale quotes（即时撤陈旧单） | ❌ 30 分钟全量撤 | 市场条件变化时即时撤单 |
| Use GTD for events（事件用 GTD） | ❌ 全 GTC | 到期前自动过期，避免陈旧暴露 |
| Batch orders（批量下单） | ❌ 逐单串行 | 相关报价单批提交 |
| Real-time data / order updates | ❌ 周期轮询 | 成交/订单变更可追踪 |
| Set size limits（尺寸上限） | ⚠️ 有 cash 检查 | 增加 token 库存上限 |
| Price guards（价格守卫） | ❌ 无 | 对订单簿 mid 校验价格，拒绝异常值 |
| Kill switch（一键撤全单） | ❌ 无 | 错误/超限时全部撤单 |

---

## 6. 附录

### 6.1 官方文档出处

| 主题 | 链接 |
|------|------|
| 订单管理 & Heartbeat | https://docs.polymarket.com/trading/manage-orders |
| 下单 & Post-Only | https://docs.polymarket.com/trading/place-orders |
| 做市指南 | https://docs.polymarket.com/trading/market-making |
| LP Rewards 机制 | https://docs.polymarket.com/programs/liquidity-rewards |
| Maker Rebates 机制 | https://docs.polymarket.com/programs/maker-rebates |
| 合约地址 | https://docs.polymarket.com/resources/contracts |
| Rewards API | https://docs.polymarket.com/api-reference/rewards/get-current-active-rewards-configurations |
| 交易限流 | https://docs.polymarket.com/api-reference/trading-rate-limits |

### 6.2 关键合约地址（官方）

| 合约 | 地址 |
|------|------|
| **pUSD — CollateralToken (proxy)** | `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` |
| pUSD — CollateralToken (impl) | `0x6bBCef9f7ef3B6C592c99e0f206a0DE94Ad0925f` |

### 6.3 收益模型（官方口径修正）

| 收入来源 | 官方机制 | 小资金现实 |
|---------|---------|-----------|
| LP Rewards | 每市场相对份额（零和）+ $1 最低支付 | 份额极小 → 通常拿不到 |
| Maker Rebates | fee_equivalent 份额 + $1 最低支付，按类别 15-25% | 需双边被吃，同样小资金陷阱 |
| 价差收入 | 唯一对小资金有意义，但需真实盘口+库存回转 | 当前代码未实现 |

### 6.4 风险清单（修正）

| 风险 | 等级 | 缓解 |
|------|------|------|
| 90% 贱卖触发 | 🔴 致命 | 阶段 0 立即删除 |
| 盲挂单被吃（逆向选择） | 🔴 高 | 读真实订单簿 + price guards |
| 单向库存堆积 | 🔴 高 | 强制双向报价 + 库存偏斜 |
| 陈旧 GTC 单长期挂着 | 🟡 中 | GTD + 即时撤单 |
| Heartbeat 窗口 | 🟡 中 | 5 秒间隔 |
| open_orders_limit | 🟡 中 | 监测挂单数量，超限即撤 |
| 到期前被碾压 | 🟡 中 | 到期过滤 + GTD |
| LP Rewards 拿不到 | 🟠 战略 | 先量化份额再决定是否参与 |

---

## 7. Reward 可行性量化分析（2026-07-31 追加，复盘用）

> 背景：用户问"当前资金量（约 500U）吃 reward 可行么"。本分析基于官方机制 + 当日实测官方 rewards API 数据，结论：**数学上基本不可行**。保留完整数据供后续复盘对照。

### 7.1 三重门槛（官方机制决定）

| 门槛 | 机制 | 影响 |
|------|------|------|
| **$1 最低支付线** | 官方 Liquidity Rewards：每日奖励低于 $1 **不发** | 赚不到 $1 = 白挂单 + 承担全部库存风险 |
| **相对份额零和竞争** | `Q_final = Q_epoch / ΣQ_epoch × 市场日奖励`；Q ∝ S(v,s) × size | 挂单量直接决定份额，受资金上限约束，大 MM 碾压 |
| **双边 + 带内报价才得分** | midpoint ∈ (0.90,1.0] / [0,0.10) **必须双边**才得分；单边在 [0.10,0.90] 按 1/3 折扣 | 代码 `canSell` 需先有库存 → 极端价市场无法双边 → 白挂 |

### 7.2 当日实测数据（2026-07-31 抓取 `GET /rewards/markets/current`）

| 指标 | 实测值 |
|------|--------|
| total_daily_rate 中位数 | **$3-5/天/市场** |
| 高奖励市场（≥$50/天） | 少数（赛事池，如 $60/$101/$210/天，min_size 20-50） |
| rewards_min_size 中位数 | 20-100 股（少量 500 股门槛） |
| rewards_max_spread | 2.5-5.5 美分（带内要求紧） |

### 7.3 500U 资金量化推演

- **可覆盖市场数**：双边报价 ≈ 买 YES @0.4 + 买 NO @0.6 各 100 股 = $100/市场 → 500U 最多 3-4 个市场
- **普通市场（rate $4/天）**：乐观 10% 份额 → $0.4/天 < $1 门槛 → **一分钱不发**
- **高奖励市场（rate $60-210/天）**：大 MM 主导，份额通常 <2% → $1.2-4/天勉强过门槛，但资金全锁 + 逆向选择风险 > 收益
- **期望值结论**：为负。用本金承担做市风险，赚一个大概率被 $1 门槛截断的零头

### 7.4 唯一可行路径（幸存者路径，需全部满足）

1. 只做高 rate（≥$30/天）+ 低竞争（min_size ≤ 20-50、参与 MM 少）的赛事/小众市场
2. 资金全仓 1-2 个市场，目标份额 ≥ 15%
3. 必须双边报价（含极端价市场），先修 `canSell`
4. 用官方 order book 验证真实 depth：top-level 已有几千股大单 → 直接放弃

满足时可能达到 **$3-10/天**，但属于幸存者路径，非稳健策略。

### 7.5 复盘决策（2026-07-31）

- [ ] 确认实际资金量（本分析按 500U 推断，待核实）
- [ ] 决定 reward 是否作为目标：**建议不作为核心**，500U 下正道是价差回转（库存偏斜+双向报价），reward 仅作附带
- [ ] 若坚持 reward：先 3-5 天模拟盘验证（真实订单簿模拟，每日算 `你的Q/总Q × rate`，连续 <$1 即放弃）

---

## 8. 套利可行性实测验证（2026-07-31 追加，复盘用）

> 背景：用户判断"无信息优势"，决定专注套利。本验证用官方 gamma API + CLOB `/book` 拉取真实订单簿，验证拆分/合并套利（策略 A）与结算收敛套利（策略 B）是否有肉吃。**结论：两个策略实测均为零机会。**

### 8.1 数据方法

- 官方 gamma API 拉市场，逐个 `GET /book?token_id=` 拉 YES/NO 双边订单簿
- 关键修正：**官方 book 的 asks 为降序排列，必须取 `min(ask)` 而非首元素**（首版脚本误取 asks[0] 导致全部 sumAsk≈1.998 的假象，已修正）
- 3 组样本，共约 300 个市场

### 8.2 实测结果

| 样本 | 可分析数 | sumAsk<1（买腿套利） | sumBid>1（卖腿套利） | 结算收敛机会 |
|------|---------|-------------------|-------------------|-------------|
| fee-free 高流动（100） | 68（双面有盘口） | **0** | **0** | — |
| 普通市场含 fee（100） | 99 | **0** | **0** | 0 |
| 已结算市场（100） | 1 | 0 | 0 | 0 |
| fee-free 低流动长尾（100） | 0（无订单簿） | — | — | — |

### 8.3 核心发现

1. **拆分/合并套利（策略 A）：实测零机会。**
   所有市场 `sumAsk` 精确落在 **1.001~1.01**，`sumBid` 精确落在 **0.990~0.999**——永远差一个 spread 宽度（~1¢）才到 1。Polymarket 做市商（含官方 MM）把 YES/NO 双侧钉在 `1 ± spread`，**你要套的 1¢ 正是别人挂的 spread**，买入+merge 反而倒亏。
2. **结算收敛套利（策略 B）：同样零机会。**
   100 个已结算市场仅 1 个有可交易订单簿，且 winner 价格已收敛到 0.99+。**结算时价格收敛快，resolve 后订单簿迅速清空，窗口不存在。**
3. **低流动长尾市场：根本没订单簿。**
   100 个低流动市场 0 个 enableOrderBook——"去无人交易的市场找错价"走不通，那些市场连 book 都没有。

### 8.4 结论（复盘要点）

> **套利的三个假设全部被数据否定：价差不存在、结算窗口不存在、长尾无流动性。**
> Polymarket 是被专业做市商高度定价的高效市场，**结构性无风险套利空间基本被消灭干净**。

结合第 7 章结论，当前可确认的"稳定赚钱"路径收敛为：

| 路径 | 状态 |
|------|------|
| 做市 / LP Reward | ❌ 已证伪（$1 门槛 + 份额零和） |
| 拆分/合并 / 结算套利 | ❌ **实测证伪（无价差、无窗口、无流动性）** |
| 信息优势 | ❌ 用户自评无优势 |
| Maker Rebates（被吃返佣） | ⚠️ 唯一剩项，但小资金份额小、天花板低 |
| 做市价差（库存偏斜） | ⚠️ 理论上可行，需承担库存风险 |

### 8.5 复盘决策（2026-07-31）

- [ ] **重新定位**：500U 不再追求"无风险稳定收益"，改为"最小成本验证做市/rebate 逻辑"（50-100U 真实盘验证）
- [ ] 若真实盘仍验证不了盈利 → **考虑撤出 Polymarket**，避免继续投入
- [ ] 套利方向：**终止开发**（已验证无空间），不再投入时间

---

## 9. 开源方案评估与 poly-maker 部署（2026-08-02 追加，复盘用）

> 背景：用户询问网上项目 "claude×quant"（关键词：5m polymarket agent / nautilus-core+quant-fork）。评估后决定：**不复刻方向性策略，改复用成熟开源做市框架**，已选定 `warproxxx/poly-maker` v2（MIT）并完成本机部署验证。

### 9.1 外部项目评估结论（claude×quant）

- 未精确命中同名仓库，但关键词画像清晰：Claude agent 构建的 Polymarket BTC 5 分钟 Up/Down 量化机器人，基于 NautilusTrader（nautilus-core）fork
- 公开战绩（@Dan1ro0 分析）：+$127,020 / 85 天 / 68,397 笔 / 56% 胜率 / ~$1,494/天
- **本质是方向性动量 + 速度竞赛**（temporal arbitrage、hedged directional exposure、inventory rotation），与用户"无信息/速度优势、专注套利"的定位冲突
- 三个数据陷阱：纸面交易 2.1x 无滑点/费用虚高；100+ bots 幸存者偏差；5m 市场 ~5c 双边成本吃掉薄优势
- **可借鉴的唯一资产**：NautilusTrader 的回测/事件驱动架构（用户老代码最缺回测能力）
- 结论：**该路径不适合当前条件**（无基础设施优势 = 给专业 bot 送钱）

### 9.2 开源方案筛选

| 项目 | 类型 | 决策 |
|------|------|------|
| **warproxxx/poly-maker v2** | maker-only 做市（政治市场） | ✅ **选定**：本地文件配置、paper 模式、fair value + inventory skew + regime + 风控齐全 |
| ent0n29/polybot | 完整微服务套件 | ⚠️ 参考架构 |
| ImMike/polymarket-arbitrage | 跨平台套利 | ❌ Kalshi 腿对用户不可用（美国限制） |
| elielieli909/polymarket-marketmaking | 老做市 bot | ❌ 2021 代码，API 早变 |
| 各类 5m sniper/copytrade | 方向性/速度 | ❌ 速度竞赛 + 幸存者偏差 |

### 9.3 与老 bot（market_maker.ts）的本质差异

| 维度 | 老 bot（结构性必亏） | poly-maker v2（正确策略·艰难环境） |
|------|------|------|
| 价格来源 | 虚构 midpoint±0.01 | 真实深度加权 fair value + 成交流修正 |
| 持仓管理 | 单向 YES 堆积 + 成本 10% 贱卖 | 双向对冲 + inventory skew + REDUCE_ONLY |
| 撤单逻辑 | 每 cycle 全量取消重挂 | regime 判断（TRENDING 减半 / EVENT 冷却） |
| 亏损刹车 | 无 | daily-loss kill switch + 各层级风控上限 |
| 盈亏可见性 | avgCost 估值失真 | journal + PnL 快照可复盘 |

> 老 bot 亏钱是确定性 bug；新 bot 亏钱风险来自 adverse selection（市场卷），只能靠规模/速度/信息对抗——500U 账户这三样都没有。**paper 跑通 ≠ 赚钱**。

### 9.4 本机部署验证结果（macOS + 本地代理 7897）

- `uv sync` 成功（独立 Python 3.12，隔离 VPS 现有 TS 环境）
- `scan`：9979 个 reward 市场费率加载，911 个政治市场入库
- `run --paper`：**零钱包凭证全链路跑通**（gateway_connected → 5 市场 10 token WS 订阅 → fair value/双侧报价/regime 持续 requote）
- 修复 1 处配置坑：`markets-add` 默认 profile `political-longdated` 在 strategy.toml 不存在 → 改用 `romania-pm`（paper 验证用）；livecfg 的 `live-tiny` profile 自洽
- 默认风控按 500U 账户设计：max_total_exposure 450U / max_market_notional 400U / daily_loss_kill 40U

### 9.5 VPS 部署决策

- **否决 TS 重写**（用户原提议）：poly-maker ~5000 行 + 83 测试，重写 = 自己从头实现，违背"复用开源"原则，且新 bug 风险高（老 bot 教训：承诺 20 项仅落地 4 项）
- **采用 uv 直跑**：uv 为用户级隔离工具，不碰系统 Python、不碰现有 TS 服务；VPS 唯一新增动作是装 uv + `uv run polymaker run`
- 已 commit 至仓库（`third_party_poly-maker/`，67 文件）；`.env`/运行产物全部 .gitignore 排除，VPS 需自行创建 .env（PK + BROWSER_ADDRESS）
- 老 TS bot 代码完整保留（复盘价值 + VPS 可能仍在运行）

### 9.6 复盘决策更新（2026-08-02）

- [ ] **先 paper 1-2 周**：`uv run polymaker run --paper` 攒真实行情模拟 PnL，数据出来再决定上不上真钱
- [ ] 实盘前置：VPS 上 `uv run polymaker doctor` 预检（钱包权限/签名类型/限流），通过后才上线
- [ ] 500U 实盘预期管理：作者警告 "competitive and can lose money"，最坏情况受 daily_loss_kill 40U/天保护
- [ ] 若 paper 数据显示负期望 → **执行 8.5 的撤出决策**
