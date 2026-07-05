# Polymarket 做市策略优化方案

## 一、当前策略诊断

### 1.1 策略当前状态

| 参数 | 值 |
|------|-----|
| 资金 | 460 PUSD |
| 同时做市市场数 | 7 |
| 每个市场仓位上限 | 25% (115 PUSD) |
| 挂单价 (midPrice 0.50) | Bid 0.48 / Ask 0.52 (Layer 1), Bid 0.46 / Ask 0.55 (Layer 2) |
| 时间衰减 | 2 天 |
| 强制清仓 | 7 天 |
| 硬止损 | -15% PnL |

### 1.2 日报数据揭示的问题

| 指标 | 数值 | 问题 |
|------|------|------|
| Fills Buy | 5503 | **全部是买单** |
| Fills Sell | 0 | **零卖单** |
| PnL | -4.88% / 天 | 年化 -1780% |
| 活跃市场 | 15 个都满仓 | 全部是 "Trump meeting" / "xxx governor/Senator" 同质化 |
| Avg Spread | ±0.030 | 在 0.01/0.99 市场里空间太小 |

### 1.3 根因分析

#### Bug #1: midPrice 统计幻觉

```typescript
// market_maker.ts:990
const midPrice = (tm.bestBid + tm.bestAsk) / 2;
// 对于 bid=0.01, ask=0.99 的市场：midPrice = 0.50
// 但这不反映任何真实概率！
```

**问题：** 二元预测市场的 spread = 0.98 意味着没有做市商。`midPrice=0.50` 只是算术平均，不是市场共识概率。真实概率可能是 0.02 或 0.95。

**后果：** 你的 `myBidPrice = 0.48` 在真实概率 < 0.32 时就是亏钱买单。5503 股全是这样来的。

#### Bug #2: 单向成交

二元预测市场 YES token 和 NO token 价格应该满足 `YES + NO ≈ $1.00`。但在无做市商的市场里：
- 只有想买 YES 的人挂了 0.01 的 bid（等着捡便宜）
- 只有想卖 YES 的人挂了 0.99 的 ask（等着宰人）
- 你的 0.48 bid（买 YES）在真实概率 ~0.25 时看起来很便宜 → 所有人把 YES 卖给你
- 你的 0.48 bid（买 NO）= 等效于 0.52 卖 YES → 太贵了，没人买

**你每天 5503 股全是买 YES，相当于每天在未知方向盲目建仓。**

#### Bug #3: 市场同质化

日报 15 个持仓全部是 "Politics" 类：
- 5 个 Trump meeting
- 5 个 Governor/Senator 选举
- 5 个其他政治人物

一个月的选举结果出来，**15 个仓位会同时往一个方向走，一刀砍 15 个**。

#### Bug #4: 盘口深度假象

```
[DBG] New Rihanna...: ask=0.990 bid=0.010 spread=0.9800 sz=58652/38644
```

这两个数字（58652/38644）是**总挂单量，不是买一/卖一的量**。`sz=bidSizeTop/askSizeTop` 是你从 orderbook 读的 **top-level size**。当 bidSizeTop=40652 时意味着有很多人挂 0.01 bid（等着捡便宜），不代表这个市场流动性好。

#### Bug #5: rebate 不确定性

Polymarket 的 Builder rewards 是由社区 + 官方决定的，**随时可能被削减或取消**。没有任何合约保证 rebate 率。

---

## 二、优化方案

### 分层设计：L0（必须）→ L1（推荐）→ L2（可选）

---

### L0-1: Spread 上限过滤

**问题：** 选所有 spread 的市场，包括 0.01/0.99 这种无人区。
**修复：** 新增 spread 上限，只做有做市商的市场。

```typescript
// market_maker.ts:821 之后，选市场阶段新增
// spread = bestAsk - bestBid

// L0-1: 过滤 spread > 0.15 的市场（真正的做市商市场 spread 在 0.02-0.08）
if (!hasInventory && spread > 0.15) {
  continue;
}
```

**预期效果：** 候选市场从 300 降到 ~60-80，但都是有人在做市的市场，midPrice 更接近真实概率，减少单向成交。

---

### L0-2: midPrice 概率修正

**问题：** `midPrice = (bid+ask)/2 = 0.50` 对所有的 0.01/0.99 市场都一样，没有信息含量。
**修复：** 引入市场共识概率——用 book 的第二档来估算真实 mid。

```typescript
// market_maker.ts:990 替换 midPrice 计算
// 用前 3 档 bid/ask 的加权均价代替简单的 (bestBid+bestAsk)/2
// 如果有足够深的 book，用 VWAP mid；否则用 Gamma 的 last traded price 作为概率
const midPrice = calculateFairMidPrice(orderbook, market);
```

补充函数：

```typescript
function calculateFairMidPrice(orderbook: any, market: any): number {
  // 优先用 Gamma 返回的 last traded price
  const gammaMid = market.lastTradePrice || market.outcomePrices
    ? parseFloat(market.outcomePrices)
    : null;
  if (gammaMid && gammaMid > 0.01 && gammaMid < 0.99) return gammaMid;

  // 其次用订单簿前 3 层加权均价估算
  const bids = orderbook.bids || [];
  const asks = orderbook.asks || [];

  if (bids.length >= 3 && asks.length >= 3) {
    let bidWeightedSum = 0, bidWeightTotal = 0;
    let askWeightedSum = 0, askWeightTotal = 0;

    for (let i = 0; i < Math.min(bids.length, 3); i++) {
      const price = parseFloat(bids[i].price);
      const size = parseFloat(bids[i].size);
      if (price >= 0.05) {
        bidWeightedSum += price * size;
        bidWeightTotal += size;
      }
    }
    for (let i = 0; i < Math.min(asks.length, 3); i++) {
      const price = parseFloat(asks[i].price);
      const size = parseFloat(asks[i].size);
      if (price <= 0.95) {
        askWeightedSum += price * size;
        askWeightTotal += size;
      }
    }

    if (bidWeightTotal > 0 && askWeightTotal > 0) {
      const vwapBid = bidWeightedSum / bidWeightTotal;
      const vwapAsk = askWeightedSum / askWeightTotal;
      return (vwapBid + vwapAsk) / 2;
    }
  }

  // Fallback: 用算术平均，但钳制到 0.15-0.85
  const rawMid = (parseFloat(orderbook.asks?.[0]?.price || '0.99') +
                  parseFloat(orderbook.bids?.[0]?.price || '0.01')) / 2;
  return Math.max(0.15, Math.min(0.85, rawMid));
}
```

**预期效果：** 挂单价更精准，避免在真实概率 0.20 的市场用 0.48 买入 YES。

---

### L0-3: 盘口深度下限提升

**问题：** `bidSizeTop >= 15` 太小，你的 21 股 Layer 1 一旦成交就吃掉 140% 的 top-level 流动性，后面 Layer 2 完全裸露。
**修复：**

```typescript
// market_maker.ts:819，选市场阶段
// 从 >= 15 提高到 >= 100
if (!hasInventory && (bidSizeTop < 100 || askSizeTop < 100)) continue;
```

**预期效果：** Top-level 至少有 100 股缓冲，你的 21 股挂出去有时间调整。

---

### L0-4: 跨类别分散（Tag 多样性强化）

**问题：** tagCounter 只存 tag 名字（"Politics"），不关心跨 Category 分布，导致全仓同一类。
**修复：**

在 `config.ts` 新增：

```typescript
// config.ts bot 块新增
categoryMaxShare: 0.25,  // 同一大类最多占 25% 的仓位
```

在 `market_maker.ts` 选市场阶段（tagCounter 之后）新增：

```typescript
// 新增 category 配额，防止过度集中
const categoryTag = market.tags?.[0] || 'Unknown';
const categoryCountInInventory = Object.values(inventory)
  .filter(() => markerCurrencyTag === categoryTag).length;
if (!isManagement && !hasInventory && categoryCountInInventory >= Math.floor(config.bot.maxPositionCount * 0.25)) {
  continue;
}
```

**预期效果：** 最多 25% 仓位在同一类别（15 个位置中最多 4 个 "Politics"），剩下的分给 "Sports"、"Crypto"、"Entertainment"。

---

### L1-1: 动态 spreadHalf（市场波动性自适应）

**问题：** spreadHalfBase 永远是 0.02，不管市场条件。
**修复：**

```typescript
// 替换当前固定 dynamicSpreadHalf
let dynamicSpreadHalf = config.bot.spreadHalfBase;

// 市场 spread 越宽，我们的 spreadHalf 也越宽（补偿不确定性）
// 但不要超过 spreadHalfMax
const marketSpread = bestAsk - bestBid;
if (marketSpread > 0.04) dynamicSpreadHalf += (marketSpread - 0.04) * 0.3;
if (marketSpread > 0.08) dynamicSpreadHalf += (marketSpread - 0.08) * 0.2;

// 深度越浅，价差适当加宽（体现流动性补偿）
if (bidSizeTop < 200 || askSizeTop < 200) dynamicSpreadHalf += 0.005;
if (bidSizeTop < 100 || askSizeTop < 100) dynamicSpreadHalf += 0.01;

dynamicSpreadHalf = Math.max(0.015, Math.min(dynamicSpreadHalf, config.bot.spreadHalfMax));
```

**预期效果：** 在低流动性市场自动加大价差，减少被动建仓。

---

### L1-2: 双向成交量平衡检测

**问题：** 没发现 buy/sell 不平衡就没办法调整。
**修复：** 在每轮周期统计 buy/sell 比，偏差过大时预警。

在全局新增：

```typescript
let fillsBuyCount = 0;
let fillsSellCount = 0;

// 在 runMarketMakingCycle 末尾加入
const buyRatio = fillsSellCount > 0 ? fillsBuyCount / fillsSellCount : Infinity;
if (fillsBuyCount >= 100 && buyRatio > 5) {
  console.log(`[!] BUY/SELL imbalance detected: ${fillsBuyCount} buys vs ${fillsSellCount} sells. 
Consider increasing spread or reducing exposure.`);
}
```

---

### L1-3: 市场到期时间过滤

**问题：** 二元预测市场到期时 YES+NO = $1，但到期前两天价格剧烈波动。
**修复：**

```typescript
// 选市场阶段，新增到期检查
const marketEndTime = market.endTime || market.expiration || market.closeTime;
if (marketEndTime && !hasInventory) {
  const hoursUntilClose = (new Date(marketEndTime).getTime() - Date.now()) / (1000 * 3600);
  if (hoursUntilClose < 48) continue; // 到期 < 48h，不新开仓
  if (hoursUntilClose < 24) continue; // 到期 < 24h，有仓也强制清仓
}
```

**预期效果：** 避免在到期前被方向性资金碾压。

---

### L2-1: rebate 验证

**问题：** 没有验证 Polymarket 实际给了多少 rebate，只是在日报里推算。
**修复：** 新增 CLOS 余额快照记录（而非只依赖 RPC `getCashBalance`），每小时记录一次 USDC 余额变化。比较 `CLOB 显示的允许余额 - 实际总支出` 来验证 rebate。

```typescript
// 每次 cycle 开始前记录快照
const PREV_BALANCE_FILE = path.join(__dirname, '../prev_balance.json');
let prevCash = 0;
try { prevCash = JSON.parse(fs.readFileSync(PREV_BALANCE_FILE, 'utf8')).cash || 0; } catch {}

const realPnl = cashBalance - prevCash;  // 真实资金变化
fs.writeFileSync(PREV_BALANCE_FILE, JSON.stringify({ cash: cashBalance, date: Date.now() }));

if (realPnl > 0) {
  console.log(`[Profit] Cycle PnL: +${realPnl.toFixed(2)} PUSD`);
}
```

---

### L2-2: 按市场条件分类挂单

**问题：** 无论 spread 多大，都按同一个 spreadHalf 挂单。
**修复：**

```typescript
// 根据 spread 计算不同的 spreadHalf
let marketTier: 'healthy' | 'wide' | 'extreme';
if (spread <= 0.05) marketTier = 'healthy';
else if (spread <= 0.10) marketTier = 'wide';
else marketTier = 'extreme';

let tierSpreadHalf = config.bot.spreadHalfBase;
if (marketTier === 'wide') tierSpreadHalf = Math.max(0.03, spread * 0.3);
if (marketTier === 'extreme') tierSpreadHalf = Math.max(0.05, spread * 0.2);

dynamicSpreadHalf = tierSpreadHalf;
```

**预期效果：** wide spread（0.05-0.10）市场用 0.03 spreadHalf，extreme（0.10-0.15）用 0.05。

---

## 三、优化后预期

| 指标 | 优化前 | 优化后预期 |
|------|--------|-----------|
| 可选市场 | 300（含大量无人区） | 60-80（都有做市商） |
| Fills Buy/Sell | 5503 : 0 | 接近 1:1 |
| 单向建仓 | 每轮都在接盘 | 双向正常挂单 |
| 持仓同质化 | 15 个全是 Politics | 最多 4 个 Politics |
| midPrice 准确度 | 总是 0.50 | 基于 Gamma/lastTrade/orderbook 加权 |
| 每日 PnL | -4.88% | 趋于 0%，靠 rebate 盈利 |
| 年化预期 | -1780% | +15-40%（取决于 rebate） |

---

## 四、实施路线

| 优先级 | 改动 | 文件 | 行数 |
|--------|------|------|------|
| 🔴 L0-1 | Spread 上限过滤 | market_maker.ts | ~5 |
| 🔴 L0-2 | midPrice 修正 | market_maker.ts | ~30 |
| 🔴 L0-3 | 深度下限提升 | market_maker.ts | ~1 |
| 🔴 L0-4 | 跨类别分散 | market_maker.ts + config.ts | ~15 |
| 🟡 L1-1 | 动态 spreadHalf | market_maker.ts | ~15 |
| 🟡 L1-2 | 成交量平衡检测 | market_maker.ts | ~10 |
| 🟡 L1-3 | 到期过滤 | market_maker.ts | ~10 |
| 🟢 L2-1 | rebate 验证 | market_maker.ts | ~15 |
| 🟢 L2-2 | 按条件挂单 | market_maker.ts | ~15 |

**建议：** 先只实施 L0（4 个改动），跑 3 天看效果。有效果再逐步加 L1/L2。

**风险：** 无。L0 都是保守过滤（缩小做市范围、提高准确度），不会引入新风险。

---

## 五、回退方案

如果优化后效果不如预期，从 git 恢复：

```bash
git checkout HEAD~1 src/market_maker.ts
git checkout HEAD~1 src/config.ts
pm2 restart polymarket-bot
```
