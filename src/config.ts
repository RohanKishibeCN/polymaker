import dotenv from 'dotenv';
dotenv.config();

export const config = {
  polymarket: {
    apiKey: process.env.POLYMARKET_API_KEY || '',
    secret: process.env.POLYMARKET_API_SECRET || '',
    passphrase: process.env.POLYMARKET_API_PASSPHRASE || '',
    funderAddress: process.env.POLYMARKET_FUNDER_ADDRESS || '',
    privateKey: process.env.PRIVATE_KEY || '',
  },
  notion: {
    token: process.env.NOTION_TOKEN || '',
    databaseId: process.env.NOTION_DATABASE_ID || '',
  },
  bot: {
    // 基础配置
    maxInvestment: 1, // USDC per trade to start safe
    scanInterval: 1000 * 60 * 15, // 每 15 分钟扫描并更新一次挂单
    
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
