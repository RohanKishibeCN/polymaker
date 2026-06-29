# 多账户/多策略分散 Expansion Plan

基于 Polymaker 现有网格做市策略 & 核心代码 (`market_maker.ts`, `surf_radar.ts`, `config.ts`) 的多账户扩展方案。

---

## 1. 为什么需要多账户？

当前架构是**单进程单账户**，存在以下硬瓶颈：

| 瓶颈 | 原因 | 上限 |
|------|------|------|
| 单账户仓位上限 | `maxPositionCount=30`, `targetMarketsCount` 受资金量限制 | 约 30-50 个市场 |
| LP Rewards 集中度 | 单 API Key 管理的所有市场共享同一份奖励 | 单市场收益薄 |
| 策略耦合 | 网格做市和方向性逻辑在同一进程 | 风控冲突，难以优化 |
| API 限流 | 单 API Key 的 cancel/order 频率受限 | 每秒 35 次 cancel |

**多账户 = 线性扩展**。每个新账户都是独立的做市主体，各管各的仓位，各跑各的策略。唯一共享的是 Surf Radar 扫描结果（只读）。

---

## 2. 策略矩阵

| 策略 | 代码基础 | 风险偏好 | 资金量建议 | 核心逻辑 |
|------|----------|----------|-----------|---------|
| **S1：网格做市** | 现有 `market_maker.ts` | 低（保守） | 500-1000 USDC/账户 | 双边报价赚价差 + LP Rewards，不押方向 |
| **S2：方向跟随** | 复用现有框架，改造挂单逻辑 | 中 | 300-500 USDC/账户 | 跟随 Surf Radar Smart Money Bias 做方向性押注 |
| **S3：套利做市** | 新增 `arbitrage_maker.ts` | 低（对冲） | 300-500 USDC/账户 | 在关联市场对之间锁定价差，Delta-Neutral |

---

## 3. 策略详述

### 3.1 S1：网格做市（你的现有策略）

保持现有策略主体不变。多账户场景下通过 **offset_start** 参数实现市场池隔离：

```
账户 A：offset_start=0，覆盖 gamma-api markets 0-299
账户 B：offset_start=300，覆盖 gamma-api markets 300-599
账户 C：offset_start=600，覆盖 gamma-api markets 600-899
```

#### 配置变化

新增环境变量 `POLYMARKET_OFFSET_START`，在 `config.ts` 中读取：

```typescript
offsetStart: parseIntEnv('POLYMARKET_OFFSET_START') || 0,
```

在 `runMarketMakingCycle()` 中，分页拉取时使用该偏移：

```typescript
let lastMarketOffset = config.bot.offsetStart;
```

这样每个账户拉取不同的市场池，资金完全不重叠，总覆盖市场数翻倍。

#### Notion 日志区分

每个账户在日报标题中加入账户标识：

```
环境变量 POLYMARKET_ACCOUNT_LABEL=A（或 B/C）
日报标题：Daily Summary [A]: 2026-06-25
```

写入 Notion 时使用不同的数据库 ID，或共享数据库但通过 Tag 区分。

---

### 3.2 S2：方向跟随策略

基于现有代码框架，核心改动点在选品逻辑和挂单逻辑。通过环境变量 `STRATEGY_MODE=directional` 激活。

#### 选品逻辑

```
1. 从 radar_signals.json 读取 markets 字段
2. 筛选条件：
   - smart_money_bias 为 'YES' 或 'NO'
   - updated_at TTL < 6 小时
   - status 不为 'HALTED'
3. 按 bias 信号新鲜度排序，取前 targetMarketsCount 个
4. 不再使用 Gamma API 的全量市场扫描（不需要 rewards 市场）
```

#### 挂单逻辑

```
1. 如果 bias = 'YES'（巨鲸在买 YES）：
   - 只挂 BUY YES 挂单（maker 价格）
   - 或等价的 SELL NO（如果 NO 库存更多）
   
2. 如果 bias = 'NO'（巨鲸在买 NO）：
   - 只挂 BUY NO 挂单（maker 价格）
   - 或等价的 SELL YES

3. 止盈规则：
   - 当仓位 PnL 达到 +5% 时，以 taker 价平仓
   - 平仓后该市场进入 24 小时冷却期，不再追入

4. 止损规则：
   - 硬止损阈值：-8%（比网格策略更紧）
   - 触发后无条件 taker 价清仓
   - 清仓后该市场进入 48 小时冷却期

5. 仓位管理：
   - 单市场最大敞口：总权益的 8%
   - 总持仓市场数上限：10
   - 不设 timeDecay（方向性策略不由时间决定去留）
   - 不设 spread freeze（方向性策略不赚价差）
```

#### 与网格策略的关键差异

| 维度 | 网格策略 | 方向跟随 |
|------|---------|---------|
| 选品来源 | Gamma API 全量市场 | Surf Radar Smart Money 信号 |
| 挂单方向 | 双边（Bid + Ask） | 单边（跟随 Bias） |
| 硬止损阈值 | -15% | -8% |
| 最大敞口 | 30% / 市场 | 8% / 市场 |
| timeDecay | 2 天出清 | 不适用 |
| spread freeze | 软 0.5 / 硬 0.8 | 不适用 |
| 目标市场数 | 7-15（依赖资金） | ≤ 10 |

---

### 3.3 S3：套利做市策略

完全独立的策略，新建 `src/arbitrage_maker.ts` 文件。核心逻辑是在**关联市场对之间做 Delta-Neutral 价差套利**。

#### 支持的套利对类型

| 类型 | 示例 | 价差来源 |
|------|------|---------|
| YES/NO 完美对冲 | "Team A wins" vs "Team A does not win" | `p + (1-p) - 1` 的误差 |
| 同事件不同期限 | "X happens in June" vs "X happens in July" | 时间溢价差异 |
| 跨平台价差 | Polymarket vs Kalshi 同一事件 | 不同平台的定价差异 |

#### 核心循环

```
每 30 分钟执行一次（与网格策略独立）:

1. 从 radar_signals.json 读取 target_whitelist
   → 这些是 Arbitrage Discovery (Action 2) 输出的套利配对的 condition_id

2. 对每个 condition_id：
   a. 调用 data-api 获取该 condition 下的市场详情
   b. 识别出关联的 token 对（如 YES/NO，或多结果市场的不同 outcome）
   c. 获取两个 token 的订单簿

3. 计算套利价差：
   对于 YES/NO 配对：
     spread = (bid_YES + bid_NO) - 1
     如果 spread > threshold (如 0.02)，存在套利空间
     
   挂单策略：
     - 在 YES 侧挂 BUY，在 NO 侧挂 BUY
     - 双边都成交后，你持有 (YES + NO) = $1 锁定价值
     - 成本 = buyPrice_YES + buyPrice_NO
     - 利润 = 1 - (buyPrice_YES + buyPrice_NO)
     
4. 对冲风控（最关键）：
   - 每 15 分钟检查双边是否都成交
   - 如果单边被吃（如只买到了 YES）：
     - 立即在当前盘口以 taker 价卖出 YES 平仓
     - 或者以 maker 价挂 SELL YES 止损
   - 持有未闭环的对冲仓位时，不再开新套利仓位
   - 最大同时开仓的套利对数：3

5. 资金管理：
   - 单笔套利最大投入：总权益的 10%
   - 总套利仓位上限：总权益的 30%
   - 保留 50% 现金作为对冲缓冲
```

#### 风控规则

```
1. Delta-Neutral 监控：
   - 每周期计算所有套利仓位的净敞口
   - 如果净敞口 > 总权益的 5%，触发对冲指令
   
2. 单边成交超时：
   - 如果单边成交后 30 分钟内另一侧未成交
   - 强制以 taker 价平仓已成交侧
   - 记录为"套利失败"，该配对冷却 24 小时

3. 结算风险：
   - 事件到期前 24 小时停止开新套利仓位
   - 到期前 6 小时强制平仓所有未平仓套利
```

---

## 4. PM2 多进程部署方案

### 4.1 目录结构

```
Polymaker/
├── .env.account1                # 账户1的环境变量（网格，offset=0）
├── .env.account2                # 账户2的环境变量（网格，offset=300）
├── .env.account3                # 账户3的环境变量（方向跟随）
├── .env.account4                # 账户4的环境变量（套利做市）
├── pm2.ecosystem.config.js      # 【新增】PM2 多进程配置
├── src/
│   ├── index.ts                 # 入口（添加 STRATEGY_MODE 选择）
│   ├── config.ts                # 配置（添加 offsetStart, accountLabel, strategyMode）
│   ├── market_maker.ts          # 网格做市主逻辑 + 方向跟随分支
│   ├── arbitrage_maker.ts       # 【新增】套利做市
│   ├── surf_radar.ts            # 雷达信号（保持不变，单进程运行）
│   └── shared/
│       ├── clb_utils.ts         # 【新增】共享 CLOB 客户端、余额查询、工具函数
│       └── heartbeat.ts         # 【新增】共享 Heartbeat 逻辑
```

### 4.2 PM2 生态配置文件

```javascript
// pm2.ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'surf-radar',
      script: 'npx',
      args: 'ts-node src/surf_radar.ts',
      env_file: '.env.account1',
      cron_restart: '0 */6 * * *',   // 每 6 小时重启一次防内存泄漏
      max_memory_restart: '200M'
    },
    {
      name: 'grid-account-a',
      script: 'npm',
      args: 'start',
      env_file: '.env.account1',
      env: {
        STRATEGY_MODE: 'grid',
        POLYMARKET_ACCOUNT_LABEL: 'A',
        POLYMARKET_OFFSET_START: '0'
      }
    },
    {
      name: 'grid-account-b',
      script: 'npm',
      args: 'start',
      env_file: '.env.account2',
      env: {
        STRATEGY_MODE: 'grid',
        POLYMARKET_ACCOUNT_LABEL: 'B',
        POLYMARKET_OFFSET_START: '300'
      }
    },
    {
      name: 'directional-account-c',
      script: 'npm',
      args: 'start',
      env_file: '.env.account3',
      env: {
        STRATEGY_MODE: 'directional',
        POLYMARKET_ACCOUNT_LABEL: 'C'
      }
    },
    {
      name: 'arbitrage-account-d',
      script: 'npx',
      args: 'ts-node src/arbitrage_maker.ts',
      env_file: '.env.account4',
      env: {
        POLYMARKET_ACCOUNT_LABEL: 'D'
      }
    }
  ]
};
```

### 4.3 环境变量文件模板

每个 `.env.accountN` 文件包含：

```
# --- Polymarket API ---
POLYMARKET_API_KEY=xxx
POLYMARKET_API_SECRET=xxx
POLYMARKET_API_PASSPHRASE=xxx
POLYMARKET_FUNDER_ADDRESS=0x...
PRIVATE_KEY=0x...

# --- Proxy ---
HTTPS_PROXY=http://...
HTTP_PROXY=http://...

# --- Bot Config ---
POLYMARKET_INITIAL_CAPITAL=500
POLYMARKET_TARGET_MARKETS_COUNT=7
POLYMARKET_SCAN_INTERVAL_MINUTES=30
POLYMARKET_RESERVE_CASH_USDC=50

# --- Polymarket ---
POLYMARKET_COLLATERAL_SYMBOL=USDC
RPC_URL=https://polygon-rpc.com

# --- Notion（每个账户写入不同的数据库）---
NOTION_TOKEN=xxx
NOTION_DATABASE_ID=xxx
```

### 4.4 进程编排命令

```bash
# === 初始化 ===
# 安装新依赖
npm install

# === 启动所有 ===
pm2 start pm2.ecosystem.config.js

# === 查看状态 ===
pm2 status

# === 查看单个策略日志 ===
pm2 logs grid-account-a
pm2 logs directional-account-c

# === 重启单个 ===
pm2 restart grid-account-b

# === 停止单个 ===
pm2 stop arbitrage-account-d

# === 停止所有 ===
pm2 stop pm2.ecosystem.config.js

# === 保存 PM2 状态（机器重启后自动恢复） ===
pm2 save
pm2 startup
```

---

## 5. 共享工具层抽离方案

### 5.1 从 `market_maker.ts` 中抽离的内容

#### `src/shared/clb_utils.ts`

```
抽离的通用函数：
- createClobClient(config)     // 初始化 CLOB 客户端 + 代理拦截
- getCashBalance()             // 查询稳定币余额
- getCollateralDecimals()      // 查询代币精度
- syncInventoryFromChain()     // 从 data-api 同步持仓
- roundToTickSize()            // 按 tickSize 舍入价格
- getValidTokenIds()           // 解析 token_id 数组
- getPositionPriorityTokenIds() // 获取关键持仓的 token_id
```

#### `src/shared/heartbeat.ts`

```
- startHeartbeat(clobClient)   // Heartbeat 逻辑，接受 clobClient 实例
- heartbeatId（模块级变量）
```

### 5.2 `market_maker.ts` 改造

改造后从外部导入共享函数：

```typescript
import { createClobClient, syncInventoryFromChain, ... } from './shared/clb_utils';
import { startHeartbeat } from './shared/heartbeat';

// CLOB 客户端通过工厂函数创建（每个账户独立的实例）
const clobClient = createClobClient(config);
```

### 5.3 `index.ts` 添加策略选择

```typescript
import { config } from './config';
import { runMarketMakingCycle } from './market_maker';
import { startHeartbeat } from './shared/heartbeat';

const mode = process.env.STRATEGY_MODE || 'grid';

async function main() {
  const clobClient = createClobClient();
  startHeartbeat(clobClient);

  if (mode === 'grid') {
    await runMarketMakingCycle(clobClient);
    setInterval(() => runMarketMakingCycle(clobClient), config.bot.scanIntervalMs);
  } else if (mode === 'directional') {
    process.env._DIRECTIONAL_MODE = 'true';
    await runMarketMakingCycle(clobClient);
    setInterval(() => runMarketMakingCycle(clobClient), config.bot.scanIntervalMs);
  }
}

main().catch(console.error);
```

---

## 6. 关键设计决策

### 6.1 账户间的独立性

| 维度 | 设计原则 | 原因 |
|------|----------|------|
| 资金隔离 | 完全隔离，各管各的地址 | 防止一个账户爆仓影响其他账户 |
| API Key | 完全独立 | 避免 Account-level rate limit |
| Notion 日志 | 每个账户写入不同数据库（或同一数据库不同 Tag） | 方便独立复盘 |
| Surf Radar | 共享 `radar_signals.json`（只读） | 扫描同一套数据，节省 Quota |
| Inventory State | 独立文件（如 `inventory_state_A.json`） | 持仓完全不共享 |

### 6.2 Surf Radar 共享策略

Surf Radar **只在一个进程中运行**（上述 PM2 配置中的 `surf-radar` 进程），其他策略进程**只读取** `radar_signals.json`，不写入。

```
surf-radar 进程（唯一写入者）
  ↓ 写入 radar_signals.json (原子操作 write + rename)
  ↓
grid-account-a  ← 读取 radar_signals.json（只读）
grid-account-b  ← 读取 radar_signals.json（只读）
directional-c   ← 读取 radar_signals.json（只读）
```

### 6.3 是否需要共享受锁

**不需要**。多账户策略最大的优势就是完全隔离。不同策略之间不需要知道对方的仓位，不需要共享风控状态。Surf Radar 的 `writeAtomic` 使用 `renameSync` 是 POSIX 原子操作，写入安全。

---

## 7. 实施路线图

| 阶段 | 任务 | 代码变更量 | 预计耗时 | 风险等级 |
|------|------|-----------|---------|---------|
| **Phase 1** | 抽离共享工具层（`clb_utils.ts`, `heartbeat.ts`） | 重构 `market_maker.ts` → 拆出 ~200 行 | 1 天 | 低 |
| **Phase 2** | index.ts + config.ts 支持 `STRATEGY_MODE` 分支 | 修改 ~50 行 | 0.5 天 | 低 |
| **Phase 3** | 方向跟随策略（S2）挂单逻辑改造 | `market_maker.ts` 条件分支 ~150 行 | 1-2 天 | 中 |
| **Phase 4** | 套利做市策略（S3）独立文件 | 新建 `arbitrage_maker.ts` ~400 行 | 2-3 天 | 高 |
| **Phase 5** | PM2 生态配置 + 多账户环境变量 | 新建 `pm2.ecosystem.config.js` + `.env.account*` | 0.5 天 | 低 |
| **Phase 6** | 逐步上线验证 | 运维观察 | 1-2 周 | - |

### 最小可行方案（最快产出）

建议从 **Phase 1 + Phase 2 + Phase 5** 起步：

```
第1步：抽离共享工具层（代码重构，不改变逻辑）
第2步：配置 2 个 .env 文件（不同 Account，不同 offset_start）
第3步：PM2 启动 2 个 grid 进程（覆盖 0-299 和 300-599 两个市场池）
第4步：观察 1 周
  - 验证两个账户的日报数据是否正常
  - 验证 LP Rewards 是否有提升
  - 确认无冲突现象
第5步：如果稳定，再决定是否扩展到 S2 方向跟随
```

---

## 8. 风险与注意事项

| 风险 | 等级 | 缓解措施 |
|------|------|---------|
| 多个进程同时调用 `cancelOrders` 互相影响 | ⚠️ 中 | 每个账户 API Key 独立，CLOB 订单不互斥 |
| RAM 占用翻倍 | 📊 低 | Node.js 单进程 ~50MB，3 个进程约 150MB，对 VPS 无压力 |
| 同一市场两个账户同时做市 | ⚠️ 中 | 通过 `offset_start` 隔离市场池；或在选品逻辑中标记已覆盖范围 |
| Surf Radar 写入并发 | ⚠️ 低 | `writeAtomic` 使用 `renameSync`，POSIX 原子操作安全 |
| 一个账户爆仓 | ⚠️ 中 | 资金完全隔离，不影响其他账户 |
| 套利策略单边被吃未对冲 | 🔴 高 | 严格的 30 分钟超时强制平仓 + 不超过 3 个同时开仓 |

### 监控清单

上线后需要监控的指标：

```
每个账户独立：
  - Equity 曲线（Notion 日报）
  - Cash 健康度（是否长期为 0）
  - 熔断触发次数
  - 硬止损触发次数
  - MaxDD

全局：
  - Surf Radar 信号是否正常更新（check radar_signals.json last_updated）
  - PM2 进程是否全部存活（pm2 status）
  - VPS 资源使用（CPU、RAM、磁盘）
```

---

## 9. 验收标准

### Phase 1-2 验收（最小可行方案）

- [ ] PM2 同时运行 2 个 grid 进程无冲突
- [ ] 两个账户的 Notion 日报正常生成，内容准确
- [ ] 每个账户独立拉取不同的市场池（offset_start 生效）
- [ ] 累计覆盖市场数 = 单账户 × 2
- [ ] 连续运行 7 天无致命错误

### Phase 3 验收（方向跟随）

- [ ] Surf Radar 信号正常读取，Smart Money Bias 正确解析
- [ ] 方向跟随模式不挂双边单
- [ ] +5% 止盈逻辑正常触发
- [ ] -8% 止损逻辑正常触发
- [ ] 方向跟随策略的 PnL 独立统计

### Phase 4 验收（套利做市）

- [ ] 套利配对正确识别
- [ ] 双边挂单成功
- [ ] 单边成交后 30 分钟内对冲逻辑正常触发
- [ ] 到期前强制平仓逻辑正常
- [ ] 套利策略日报独立生成
