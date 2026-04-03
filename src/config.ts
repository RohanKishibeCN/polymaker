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
    spreadHalf: 0.02, // 距离中间价的单边价差，比如 mid=0.5, 买单0.48，卖单0.52。0.02 意味着 4% 的总价差
    maxInventory: 3, // 最大单边库存容忍度 (如果连续买到 3 份 Yes，则暂停买入)
    minLiquidity: 100, // 过滤掉完全没人的死水市场（盘口深度 < 100）
    maxLiquidity: 50000, // 过滤掉大选级别的热门市场（盘口深度 > 50000，大机构在玩）
  }
};

// Validate config
const missingKeys = Object.entries(config.polymarket)
  .filter(([_, value]) => !value)
  .map(([key]) => `polymarket.${key}`);

if (missingKeys.length > 0) {
  console.warn(`Missing Polymarket config keys: ${missingKeys.join(', ')}`);
}
