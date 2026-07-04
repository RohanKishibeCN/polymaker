# Polymarket 新账户 API 配置指南

## 前置条件

1. 通过邮箱在 [polymarket.com](https://polymarket.com) 注册新账户
2. 充值至少 $1，在网页上完成一笔交易（任意市场、任意方向）—— 这一步激活账户并部署 deposit wallet
3. 在 Settings → Account 导出私钥（Export Private Key）
4. 在 Settings → Builders 创建 Builder API Key，记录 key/secret/passphrase

## 地址说明

| 地址类型 | 示例 | 用途 |
|---------|------|------|
| **EOA 地址** | `0x8945...` | 私钥对应的地址，用于签名 |
| **Deposit Wallet** | `0x387f...` | 充值地址，资金存放位置 |
| **Builder 地址** | `0xc986...` | Settings → Builders 页面显示，**供 POLY_1271 的 funderAddress 使用** |

> **关键区分：** Builder 地址 ≠ Deposit Wallet。Builder 地址是 Polymarket 后端为你的 Builder 身份创建的 proxy wallet，deposit wallet 只是充值地址。

## 正确配置

### .env 参数

```env
PRIVATE_KEY="0x你的私钥"
POLYMARKET_FUNDER_ADDRESS="0xc986...你的Builder地址"
POLYMARKET_API_KEY="Builder页面生成的key"
POLYMARKET_API_SECRET="Builder页面生成的secret"
POLYMARKET_API_PASSPHRASE="Builder页面生成的passphrase"
POLYMARKET_COLLATERAL_ADDRESS="0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB"
POLYMARKET_COLLATERAL_SYMBOL=PUSD
POLYMARKET_COLLATERAL_DECIMALS=6
POLYMARKET_INITIAL_CAPITAL="你的总资金"
POLYMARKET_SIZE_PCT=0.08
POLYMARKET_MAX_MARKET_PCT=0.25
POLYMARKET_MAX_POSITION_COUNT=15
POLYMARKET_RESERVE_CASH_USDC=50
RPC_URL="https://polygon-bor.publicnode.com"
```

### 代码配置

```typescript
// market_maker.ts
const clobClient = new ClobClient({
  host: 'https://clob.polymarket.com',
  chain: Chain.POLYGON,
  signer: walletClient,                    // viem WalletClient
  creds: { key, secret, passphrase },      // Builder 页面的 API key
  signatureType: SignatureTypeV2.POLY_1271, // 类型 3
  funderAddress: config.polymarket.funderAddress, // Builder 地址（不是 deposit wallet！）
});

// 初始化后必须调用一次 updateBalanceAllowance
await clob.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
```

## 错误总结

### 错误 1：funderAddress 填了 deposit wallet

**现象：** `the order signer address has to be the address of the API KEY`

**原因：** POLY_1271 把 order 的 signer 设为 funderAddress。如果 funderAddress=deposit wallet (0x387f)，而 API key 绑定在 Builder 地址 (0xc986)，签名不匹配。

**修复：** `POLYMARKET_FUNDER_ADDRESS` 填 Builder 地址。

---

### 错误 2：签名类型用错

**现象：** `maker address not allowed, please use the deposit wallet flow`

**原因：** 用了 `POLY_GNOSIS_SAFE` (类型 2)，新账户不支持。

**修复：** 改用 `POLY_1271` (类型 3)。

---

### 错误 3：viem / ethers 混用

**现象：** 同样的私钥，`generate_api_key.ts` 和 `market_maker.ts` 用不同的签名库派生/使用 API key，导致签名格式不一致。

**原因：** viem 的 WalletClient 和 ethers 的 Wallet 在 EIP-712 签名实现上有细微差异，Polymarket 后端校验失败。

**修复：** 统一使用 viem WalletClient，generate 和 market maker 用同一个库。

---

### 错误 4：freezeAddSpreadHard 过滤全部市场

**现象：** `Selected 0 target markets`，明明有 300 个活跃市场却一个不选。

**原因：** `freezeAddSpreadHard=0.90`，但二元预测市场 bid ~0.01 / ask ~0.99，spread = 0.98。所有市场的 spread > 0.90 → 全部跳过。旧账户有仓位（hasInventory=true）绕过了这个过滤，新账户空仓撞上。

**修复：** 删除选市场阶段的 freezeAddSpreadHard 过滤，只保留 price bounds（0.10-0.90）和盘口深度（>=15）过滤。

---

### 错误 5：freezeAddSpreadHard 阻止新户挂单

**现象：** 市场选出来了但订单被跳过（`canIncreaseExposure=false`）。

**原因：** `freezeBlocksBuys = isHardFrozen`，新市场 spread=0.98 > 0.90 → 所有订单被冻结。

**修复：** `isHardFrozen` 只在 `tm.hasInventory` 时生效，新账户不受影响。

---

### 错误 6：getCashBalance RPC 全部失败

**现象：** `Current Equity: ~460 PUSD` 但 `cashAvailableForBuys=0`，订单全部被跳过。

**原因：** 只配了一个 RPC URL，该 URL 不可用时 `getCashBalance()` 返回 0。L537 的 fallback 只修复了 totalEquity 显示值，没修复 cashBalance，导致 canIncreaseExposure 检查失败。

**修复：** `getCashBalance()` 增加多个 RPC fallback + 上次成功的缓存值，L537 里一并修复 cashBalance。

---

### 错误 7：rewards 过滤对新账户无效

**现象：** `Selected 0 target markets`，page 分页正常。

**原因：** Gamma API 对大部分市场返回 `clobRewards=[]`，旧代码 `rewards && rewards.length === 0` 会把所有非奖励市场跳过。新账户没有持仓不能绕过。

**修复：** 删除 rewards-only 过滤，改用 price bounds + 盘口深度。

---

### 错误 8：反复清空 API key 导致自动派生绑定错误

**现象：** 明明配了 Builder 页面 key，重启后被 `initClobClient()` 覆盖成 SDK 派生的 key。

**原因：** `sed` 清空脚本把 .env 里的 API key 清空，`initClobClient()` 发现 key 为空就自动调用 `createOrDeriveApiKey()` 重新派生。SDK 派生的 key 只绑定 EOA，不绑定 Builder 地址，导致后续订单 signer 不匹配。

**修复：** 如果 Builder 页面 already 有 key，不要在 .env 里清空它。`initClobClient()` 只在 key 为空时才派生。

---

### 错误 9：updateBalanceAllowance 缺失

**现象：** 所有配置看起来正确但仍报签名错误。

**原因：** 文档 Step 5 明确要求：初始化 ClobClient 后调用 `updateBalanceAllowance({ asset_type: AssetType.COLLATERAL })`。这一步在 Polymarket 后端建立 EOA 与 deposit wallet 的关联。

**修复：** 在 `initClobClient()` 中 ClobClient 创建后立即调用。

---

### 错误 10：Builder API key 与 CLOB API key 不是两套系统

**纠正：** Builder 页面生成的 key/secret/passphrase 可以用于 CLOB 交易，不需要额外派生。只要 funderAddress 填对（Builder 地址），签名方式用 POLY_1271。

## 快速排查清单

| 检查项 | 正确值 |
|--------|--------|
| `signatureType` | `POLY_1271` (3) |
| `funderAddress` | Builder 页面地址（不是 deposit wallet） |
| API key 来源 | Builder 页面 |
| signer 库 | viem WalletClient（和 generate 脚本一致） |
| `updateBalanceAllowance()` | 创建 ClobClient 后立即调用 |
| `POLYMARKET_COLLATERAL_ADDRESS` | `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` |
| 清除旧 state 文件 | `rm -f state.json balance_log.json radar_signals.json` |
