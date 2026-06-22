# Polymaker 完整优化方案

基于最新官方文档（docs.polymarket.com）逐行对照代码实际执行逻辑后的诊断报告。
生成日期: 2026-06-22 | 更新: 2026-06-22（第三轮：Phase 1-3 实现后）
当前代码 commit: `03d6950` (2026-05-05)
资金要求: 无硬性要求，方案适配任意资金规模。

---

## 实施进度

| Phase | 内容 | 状态 |
|-------|------|------|
| Phase 1 | 紧急修复（6项P0） | ✅ 已完成 |
| Phase 2 | 监控完善（5项P1） | ✅ 已完成 |
| Phase 3 | 策略优化（4项P2） | ✅ 已完成 |
| Phase 4 | Surf Radar 重构 | ✅ 已完成 |

### 编译验证
```
npx tsc --noEmit  → 0 errors
```

### 已完成项（20项）
- [x] pUSD 合约地址 → `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`
- [x] Heartbeat 5秒间隔，CLOB V2 防清空
- [x] createAndPostOrder 签名修正（tickSize + negRisk + orderType）
- [x] tickSize/negRisk 从 gamma API 提取
- [x] 极端价格过滤器：管理/止损仓位不跳过
- [x] 撤单逻辑：保留 SELL 订单
- [x] 清仓暂停条件放宽（5股taker价试水）
- [x] 持仓数量上限（maxPositionCount=30）
- [x] Fills Buy/Sell 追踪（snapshot对比）
- [x] MaxDD 追踪（peakEquity + 每日重置）
- [x] V1 兼容代码全量移除（USE_V2_SDK, feeRateOverride, feeRateBps）
- [x] LP rewards 新字段兼容（min_incentive_size/max_incentive_spread）
- [x] Notion 2000字符分段写入
- [x] forceCloseDays=7 强制清仓逻辑（taker价格全量清仓）
- [x] 实时风险告警替代 `(No manual alerts)`
- [x] 动态 targetMarketsCount（基于资金量自动调整：500→7, 1000→10, 2000→12, >2000→15）
- [x] Rewards 收入监测（balance_log.json 日对比 + 日报展示）
- [x] Whitelist reallocateCount 动态提升（Whitelist出现时从2→3）
- [x] tickSize-aware price rounding（roundToTickSize 替代硬编码 toFixed(2)）
- [x] Surf Radar 重构：SOS内嵌做市循环（30min TTL）+ Smart Money 扫描（4h间隔）+ fs.watch移除 + Action 间隔延长

---

## 核心发现（第二轮校核追加）

**本轮额外发现了两个在第一次分析中被完全遗漏的致命问题：**

1. **Heartbeat 缺失**——CLOB V2 要求每 10 秒发送 heartbeat，否则**服务器自动取消全部订单**。当前代码完全没有 heartbeat 实现。
2. **createAndPostOrder 签名错误**——V2 SDK 的 `createAndPostOrder` 现在需要 `{ tickSize, negRisk }` 和 `orderType` 参数，当前代码调用缺少这两个参数，**所有订单可能全部被无声拒绝**。

---

## 目录

1. [当前系统勘误表（17个问题）](#1-当前系统勘误表17个问题)
2. [P0 致命缺陷修复（6项）](#2-p0-致命缺陷修复6项)
3. [P1 中等问题修复（5项）](#3-p1-中等问题修复5项)
4. [P2 策略优化（5项）](#4-p2-策略优化5项)
5. [Surf Radar 优化（4项）](#5-surf-radar-优化4项)
6. [其他改进项（4项）](#6-其他改进项4项)
7. [实施路线图（4个Phase, 共5-6天）](#7-实施路线图)
8. [附录：合约地址、收益模型、风险清单](#8-附录)

---

## 1. 当前系统勘误表（17个问题）

### 1.1 与官方文档不符——API/合约层面（5项）

| # | 问题 | 当前代码 | 官方文档 | 严重 |
|---|------|---------|---------|------|
| **A1** | **Heartbeat 缺失** | 完全没有 heartbeat | CLOB V2 要求 10 秒内发一次 heartbeat，否则**服务器主动取消全部订单** | **P0** |
| **A2** | **createAndPostOrder 缺少 tickSize/negRisk/orderType** | `createAndPostOrder(orderPayload)` | V2 SDK 签名: `createAndPostOrder(orderPayload, { tickSize, negRisk }, orderType)` | **P0** |
| **A3** | **pUSD 合约地址错误** | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` (标准 USDC) | `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` (pUSD) | **P0** |
| A4 | **SDK 包导入路径错误** | `import { ... } from '@polymarket/clob-client'` | `@polymarket/clob-client-v2`（旧包已废弃） | P1 |
| A5 | **费率和 nonce 字段死代码** | `feeRateBps`，`nonce` 仍在设置 | V2 费率由协议匹配时设置，`nonce` 已移除 | P2 |

### 1.2 代码执行缺陷——逻辑层面（8项）

| # | 问题 | 位置 | 影响 | 严重 |
|---|------|------|------|------|
| **B1** | **极端价格过滤器无条件跳过** | `market_maker.ts:927-933` | 管理队列/硬止损仓位永远被跳过 | **P0** |
| **B2** | **全量撤单消灭 SELL 订单** | `market_maker.ts:821-856` | 无活跃 SELL 单 → 无人能吃你的单 → 无 rebates | **P0** |
| B3 | **清仓暂停太保守** | `market_maker.ts:1124-1146` (spread>0.3 暂停) | 死仓清不掉 | P1 |
| B4 | **无持仓数量上限** | 无 `maxPositionCount` | 95持仓分散管理 | P1 |
| B5 | **Fills Buy/Sell 始终 N/A** | `market_maker.ts:333` (TODO) | 缺核心指标 | P1 |
| B6 | **MaxDD 始终 N/A** | `market_maker.ts:329` (硬编码) | 无回撤追踪 | P1 |
| B7 | **positions API 每轮3调用** | syncInventory + getPriority + dailySummary | 冗余请求 | P2 |
| B8 | **Same sizePct 所有市场** | `config.ts:45` `sizePct: 0.05` | 不同市场同仓位 | P2 |

### 1.3 Surf Radar 集成问题（4项）

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| C1 | **HALTED TTL 10分 vs 扫描 30 分** | `surf_radar.ts:617` + 30min 周期 | SOS 信号永不及做市函数 |
| C2 | **fs.watch 不可靠** | `surf_radar.ts:290` | 可能遗漏 SOS |
| C3 | **Smart Money 覆盖率 3%** | `surf_radar.ts:153` (Top3持仓/6h) | 95个只扫3个 |
| C4 | **外部 CLI 单点故障** | `surf_radar.ts:122` (`npx surf`) | 工具不可用→Radar瘫痪 |

---

## 2. P0 致命缺陷修复（6项）

### 修复 1：Heartbeat 实现（最关键）

**为什么必须实现**：

CLOB V2 的心跳机制设计是为保证做市商的活跃性。如果服务端在 10 秒内收不到有效 heartbeat，**所有该 API key 下的挂单全部自动取消**。当前代码完全没有实现 heartbeat → 每次挂单后 10-15 秒就被服务器清空 → 你永远没有挂单。

**文件**: `market_maker.ts`（新增函数）

```typescript
let heartbeatId = '';

/**
 * CLOB V2 要求每 10 秒发送一次 heartbeat。
 * 否则服务器自动取消该 API key 下的全部订单。
 */
async function startHeartbeat() {
  setInterval(async () => {
    try {
      const resp = await clobClient.postHeartbeat(heartbeatId);
      heartbeatId = resp.heartbeat_id || '';
    } catch (e: any) {
      console.warn(`[Heartbeat] Failed: ${e.message}`);
      // 失败时重置 ID
      heartbeatId = '';
    }
  }, 5000); // 5 秒一次，保证在 10 秒窗口内
}
```

**调用位置**: `index.ts` 或在 `runMarketMakingCycle` 首次执行时启动。

### 修复 2：createAndPostOrder 签名修正

**为什么必须修正**：

V2 SDK 的 `createAndPostOrder` 方法签名已改变：
```
V1: createAndPostOrder(orderPayload)
V2: createAndPostOrder(orderPayload, { tickSize, negRisk }, orderType)
```

当前代码用 V1 格式调用 → 参数缺失 → 订单被服务器拒绝 → **错误被 `catch (e: any)` 吞掉，你完全看不到任何错误日志**。

**文件**: `market_maker.ts` 所有 `createAndPostOrder` 调用点

当前代码每个挂单调用的形式：
```typescript
const res = await clobClient.createAndPostOrder(orderPayload);
```

修正为：
```typescript
// 需要从市场数据中获取 tickSize 和 negRisk
const tickSize = tm.tickSize || "0.01";  // 后续从 getTickSize() 获取
const negRisk = tm.negRisk || false;     // 后续从 getNegRisk() 获取

const res = await clobClient.createAndPostOrder(
  orderPayload,
  { tickSize, negRisk },
  "GTC"  // OrderType.GTC
);
```

**配套修改**: 在市场选择阶段，为每个 market 添加 `tickSize` 和 `negRisk` 字段：
```typescript
// 在市场对象中添加
const tm: any = {
  // ... 现有字段 ...
  tickSize: await clobClient.getTickSize(yesTokenId).catch(() => "0.01"),
  negRisk: await clobClient.getNegRisk(yesTokenId).catch(() => false),
};
```

或者使用 `getClobMarketInfo()` 一次性获取：
```typescript
const marketInfo = await clobClient.getClobMarketInfo(yesTokenId).catch(() => null);
// marketInfo.mts → minimum tick size
// marketInfo.fd → fee details
// 判断 negRisk 可以使用 marketInfo.negRisk 字段
```

### 修复 3：pUSD 合约地址

**文件**: `market_maker.ts:222`

```diff
- ? '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'  // USDC
+ ? '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB'  // pUSD
```

pUSD 的 `decimals = 6`（与标准 USDC 相同），现有的 `getCollateralDecimals` 仍然有效。

### 修复 4：极端价格过滤器不跳过管理/止损仓位

**文件**: `market_maker.ts:927-933`

```diff
if (midPrice <= 0.10 || midPrice >= 0.90) {
-  console.log(`... Skipping.`);
-  dailyStats.circuitBreakTriggers++;
-  lastMidPrices[tm.yesTokenId] = midPrice;
-  continue;
+  if (isHardStopTriggered || tm.isManagement || tm.hasInventory) {
+    console.log(`[!] Extreme bounds (${midPrice.toFixed(3)}) but management required.`);
+    // 继续执行，但使用激进价格清仓
+  } else {
+    console.log(`[!] Circuit Breaker: Price ${midPrice.toFixed(3)} extreme. Skipping.`);
+    dailyStats.circuitBreakTriggers++;
+    lastMidPrices[tm.yesTokenId] = midPrice;
+    continue;
+  }
}
```

### 修复 5：全量撤单 → 保留正常订单

**文件**: `market_maker.ts:821-856`

当前每个周期取消所有订单。改为只取消以下情况的订单：
- 不在当前做市列表中的市场
- 价格偏离超过 1 分
- 硬止损/时间衰减触发的市场

```typescript
for (const o of openOrders || []) {
  const marketId = o.market;
  if (!marketId) continue;

  // 找到对应的目标市场
  const targetMarket = targetMarkets.find(tm =>
    tm.yesTokenId === o.asset_id || tm.noTokenId === o.asset_id
  );

  if (!targetMarket) {
    // 市场已不在做市列表 → 取消
    cancelIds.push(o.id);
    continue;
  }

  // 检查是否需要更新价格
  const desiredPrice = getDesiredPriceForOrder(targetMarket, o);
  if (Math.abs(Number(o.price) - desiredPrice) > 0.01) {
    cancelIds.push(o.id);
  }
  // 价格匹配 → 保留
}
```

`getDesiredPriceForOrder` 函数需要基于市场参数和持仓方向计算目标挂单价。

### 修复 6：清仓暂停条件放宽

**文件**: `market_maker.ts:1124-1146`

```diff
if ((isHardStopTriggered || isTimeDecayed) && (tm.bestAsk - tm.bestBid) > 0.3) {
+  if (tm.hasInventory || isHardStopTriggered) {
+    currentLayerSize = Math.min(currentLayerSize, 5);
+    myAskPrice = tm.bestBid;  // taker 价卖
+    myBidPrice = tm.bestAsk;  // taker 价买
+    console.log(`[!] Wide spread (${(tm.bestAsk-tm.bestBid).toFixed(2)}) but forced. Minimal size.`);
+  } else {
    console.log(`... Pausing liquidation to avoid excessive slippage.`);
    continue;
+  }
}
```

---

## 3. P1 中等问题修复（5项）

### 修复 7：持仓数量上限

**文件**: `config.ts:41-59`

```diff
bot: {
+  maxPositionCount: 30,
  ...
}
```

**文件**: `market_maker.ts:638-640`

```diff
- if (!isManagement && !hasInventory && !isWhitelisted && newMarketsCount >= config.bot.targetMarketsCount) {
+ const currentInventoryCount = Object.keys(inventory).filter(k =>
+   inventory[k].yes > 0 || inventory[k].no > 0
+ ).length;
+ if (!isManagement && !hasInventory && !isWhitelisted &&
+    (newMarketsCount >= config.bot.targetMarketsCount ||
+     currentInventoryCount >= config.bot.maxPositionCount)) {
  continue;
}
```

### 修复 8：Fills Buy/Sell 追踪

每个周期挂单前 snapshot 持仓数量，下个周期对比差异：

```typescript
// 在 syncInventoryFromChain 中新旧对比
const prevSnapshot = new Map(Object.entries(inventory).map(([k, v]) => [k, v.yes + v.no]));
// ... 同步最新持仓后 ...
for (const [key, currentInv] of Object.entries(inventory)) {
  const prev = prevSnapshot.get(key) || 0;
  const current = currentInv.yes + currentInv.no;
  if (current > prev) dailyStats.fillsBuy += (current - prev);
  if (current < prev) dailyStats.fillsSell += (prev - current);
}
```

### 修复 9：MaxDD 追踪

```typescript
let peakEquity = config.bot.initialCapital;
// 每个周期更新:
if (totalEquity > peakEquity) peakEquity = totalEquity;
const maxDrawdown = peakEquity > 0 ? (peakEquity - totalEquity) / peakEquity : 0;
```

### 修复 10：消除重复 API 调用

将 `syncInventoryFromChain` + `getPositionPriorityTokenIds` 合并为单次 positions API 调用。

### 修复 11：Notion 2000 字符扩容

使用 Notion blocks API 分段写入，或将完整数据写本地日志，Notion 只推摘要。

---

## 4. P2 策略优化（5项）

### 优化 1：移除 V1 兼容代码

**文件**: `market_maker.ts:1-6`

```diff
- import { ..., SignatureTypeV2 } from '@polymarket/clob-client';
+ import { ..., SignatureTypeV2 } from '@polymarket/clob-client-v2';
- const USE_V2_SDK = process.env.USE_V2_SDK === 'true';
```

连带清理：
- `createAndPostOrderWithFeeFallback` → 简化为 `createAndPostOrder`（不需要 fee fallback）
- `getCashBalance` 移除 V1 分支
- `feeRateOverrideByTokenId` 变量删除

### 优化 2：LP rewards 字段兼容

```diff
- rewardsMinSize: gm.rewardsMinSize || 0,
- rewardsMaxSpread: gm.rewardsMaxSpread || 0,
+ rewardsMinSize: gm.min_incentive_size || gm.rewardsMinSize || 0,
+ rewardsMaxSpread: gm.max_incentive_spread || gm.rewardsMaxSpread || 0,
```

### 优化 3：目标市场数动态调整

```typescript
getTargetMarketsCount(capital: number): number {
  if (capital <= 500) return 7;
  if (capital <= 1000) return 10;
  if (capital <= 2000) return 12;
  return 15;
}
```

### 优化 4：动态仓位分配

基于市场 spread 动态调整 spreadHalf：
```typescript
let dynamicSpreadHalf = config.bot.spreadHalfBase;
if (tm.spread > 0.10) dynamicSpreadHalf += 0.02;
if (tm.spread > 0.20) dynamicSpreadHalf += 0.02;
if (tm.bidSizeTop < 50 || tm.askSizeTop < 50) dynamicSpreadHalf += 0.01;
```

### 优化 5：订单生命周期管理

```
第1周期: 正常挂单（Bid + Ask），记录挂单价格
第2周期: 比较旧单价格 vs 目标价格
  - 偏离 < 1分 → 保留
  - 偏离 > 1分 → 取消旧单，重新挂
第N周期: 同上
特殊:
  - 硬止损 → 更新价格为 taker 价格
  - 现金不足 → 取消 BUY，保留 SELL
  - heartbeat 维护 → 5秒间隔
```

---

## 5. Surf Radar 优化（4项）

### 优化 6：SOS 价格检测内嵌做市循环

```
不再依赖 fs.watch 和 surf_radar.ts 的 Action 3。
直接在 market_maker.ts 的 runMarketMakingCycle 中:
  - 维护 lastMidPrices
  - 检测 price jump → 直接标记 HALTED（30 分钟 TTL，与扫描周期匹配）
  - HALTED 缓存到内存 Map 中，有效期 30 分钟
```

### 优化 7：Smart Money 扫描内嵌

```typescript
// 每个周期检查是否需要 Smart Money 扫描（每 4 小时，Top 5 持仓）
if (Date.now() - lastSmartMoneyScan > 4 * 60 * 60 * 1000) {
  for (const tokenId of getTop5InventoryTokenIds()) {
    // 调用 npx surf 的 smart money 命令
  }
  lastSmartMoneyScan = Date.now();
}
```

### 优化 8：Arbitrage Discovery 保留为独立进程

`surf_radar.ts` 作为独立进程运行，只负责：
- Action 2: Arbitrage Discovery（每 24 小时 → 节约 quota）
- 写入 `radar_signals.json`

### 优化 9：移除 fs.watch 依赖

将 SOS 写入改为 polling 模式（market_maker 每 30 秒检查 SOS 文件），替代不可靠的 `fs.watch`。

---

## 6. 其他改进项（4项）

### 改进 1：Rewards 收入监测

```typescript
// 每日对比余额变化
const todayBalance = await getCashBalance();
const income = todayBalance - yesterdayBalance;
if (income >= 1) {
  console.log(`[Rewards] Daily income: ~${income.toFixed(2)} PUSD`);
}
// 写入 daily summary
```

### 改进 2：实时风控告警

替代 `(No manual alerts)`：

```typescript
const alerts: string[] = [];
if (maxDD > 0.15) alerts.push(`MaxDD ${(maxDD*100).toFixed(1)}%`);
if (cashBalance < reserveCashUsdc) alerts.push(`Cash below reserve`);
if (largeLosers.length > 0) alerts.push(`${largeLosers.length} positions >20 PUSD loss`);
if (deadPositions > 5) alerts.push(`${deadPositions} dead positions (Eq<1 PUSD)`);
```

### 改进 3：pUSD vs USDC 的 getCashBalance 重写

当前代码通过 `eth_call` 读 ERC-20 `balanceOf` 查询余额。V2 的 pUSD 是标准 ERC-20，`decimals=6`，与旧 USDC 相同。RLPC 查询逻辑不变，只改地址即可。

但有一个风险：如果用户的资金还在 USDC.e 没 wrap 成 pUSD，则需要先 wrap。代码应同时检查 USDC.e 余额并警告用户。

### 改进 4：Whitelist R2 挪仓优化

- Whitelist 市场即使现金充足也优先参与（改变排序优先级）
- `reallocateMaxMarkets` 从 2 增至 3（当 Whitelist 出现时）

---

## 7. 实施路线图

### Phase 1：使系统正常运行（1-2天）
```
目标: 修复所有导致订单挂不上去的 Bug

[P0] Heartbeat 实现
[P0] createAndPostOrder 签名修正 (tickSize + negRisk + orderType)
[P0] pUSD 合约地址修复
[P0] 极端价格过滤器修复（管理队列不跳过）
[P0] 全量撤单修复（保留正常订单）
[P1] 清仓暂停放宽（管理队列小仓试水）
```

### Phase 2：监控和风控完善（1天）
```
目标: 全面追踪策略运行状态

[P1] Fills Buy/Sell 追踪
[P1] MaxDD 追踪
[P1] 持仓数量上限
[P2] 消除重复 API 调用
[P2] 实时风控告警
```

### Phase 3：策略现代化（1-2天）
```
目标: 使用 V2 最新特性，提升收益

[P2] 移除 V1 兼容代码
[P2] LP rewards 字段更新
[P2] 动态 targetMarketsCount
[P2] 基于波动率的动态仓位
[P2] 订单生命周期管理
[P2] Rewards 收入监测
```

### Phase 4：Surf Radar 重构（1天）
```
目标: 让 Radar 产生价值

SOS 内嵌做市循环（30 分钟 TTL 匹配）
Smart Money 改为做市循环触发
Action 2 保持为独立进程（24h 间隔节约 quota）
移除 fs.watch
```

---

## 8. 附录

### 8.1 关键合约地址（来自官方文档）

| 合约 | 地址 |
|------|------|
| **pUSD** | `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` |
| CTF Exchange V2 | `0xE111180000d2663C0091e4f400237545B87B996B` |
| Neg Risk CTF Exchange | `0xe2222d279d744050d28e00520010520000310F59` |
| CTF (条件代币) | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` |
| USDC.e (Polygon) | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` |

### 8.2 收益模型

| 收入来源 | 条件 | 频率 | 预计 ($500) | 预计 ($2000) |
|---------|------|------|------------|-------------|
| **Maker Rebates** | 限价单被吃（Provider） | 每日 UTC 午夜 | $0.50-2/天 | $2-8/天 |
| **Liquidity Rewards** | 限价单在 midpoint 附近 | 每日 | $0-1/天 | $1-3/天 |
| **点差收入** | 双边填价成交 | 每笔 | $0.10-0.50/次 | $0.20-1.00/次 |

Maker Rebates = taker fees 的百分比。政治市场 taker fee 4%，rebate 25%。

### 8.3 关键风险清单

| 风险 | 缓解 |
|------|------|
| 方向性持仓亏损 | -15% 硬止损 + 7 天强制清仓 |
| Heartbeat 丢失→全部取消 | 5 秒间隔实现 |
| tickSize 不匹配→订单拒绝 | 使用 getTickSize() 获取 |
| 比赛到期结算 | 提前7天停止开新仓 |
| API 限流 | 每秒限 35 次 cancel，注意节流 |

---

> **核心结论**：之前发现的两个 P0 Bug（极端价格过滤器、全量撤单）是重要问题，但 **Heartbeat 缺失** 和 **createAndPostOrder 签名错误** 才是真正的系统级致命缺陷。Heartbeat 缺失导致所有订单在 10 秒内被服务器清除；签名错误导致 order 可能从未成功提交。这两个问题的修复是 Phase 1 中最高优先级。
