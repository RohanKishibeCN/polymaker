import dotenv from 'dotenv';
dotenv.config();

export const config = {
  polymarket: {
    apiKey: (process.env.POLYMARKET_API_KEY || '').trim(),
    secret: (process.env.POLYMARKET_API_SECRET || '').trim(),
    passphrase: (process.env.POLYMARKET_API_PASSPHRASE || '').trim(),
    funderAddress: (process.env.POLYMARKET_FUNDER_ADDRESS || '').trim(),
    privateKey: (process.env.PRIVATE_KEY || '').trim(),
    // Polymarket 地理封锁风控需要的 geoBlockToken
    geoBlockToken: (process.env.POLYMARKET_GEOBLOCK_TOKEN || '').trim(),
  },
  notion: {
    token: (process.env.NOTION_TOKEN || '').trim(),
    databaseId: (process.env.NOTION_DATABASE_ID || '').trim(),
  },
  bot: {
    // 基础配置
    // 初始投入资金 (用于计算盈亏)
    initialCapital: Number(process.env.POLYMARKET_INITIAL_CAPITAL) || 70,
    // 如果没有在 .env 里设置，默认使用 25 USDC 以满足大部分市场的官方流动性奖励门槛
    maxInvestment: Number(process.env.POLYMARKET_MAX_INVESTMENT) || 25, 
    // 如果没有在 .env 里设置，默认改为每 30 分钟扫描一次，大幅节省代理流量成本
    scanInterval: 1000 * 60 * (Number(process.env.POLYMARKET_SCAN_INTERVAL_MINUTES) || 30), 

    // 做市策略配置 (Market Making)
    targetMarketsCount: 5, // 想要同时做市的市场数量（前期测试选 5 个冷门市场）
    spreadHalf: 0.015, // 距离中间价的单边价差。0.015 意味着 3% 的总价差，更容易挤进去
    maxInventory: 3, // 最大单边库存容忍度
    minLiquidity: 10, // 再次放宽下限，因为官方 API 返回的 liquidity 计算方式和实际订单簿深度有差异
    maxLiquidity: 500000, // 放宽上限
  }
};

// Validate config
const missingKeys = Object.entries(config.polymarket)
  .filter(([_, value]) => !value)
  .map(([key]) => `polymarket.${key}`);

if (missingKeys.length > 0) {
  console.warn(`Missing Polymarket config keys: ${missingKeys.join(', ')}`);
}
