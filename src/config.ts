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
    // 【第一轮迭代】资金比例 Size
    sizePct: Number(process.env.POLYMARKET_SIZE_PCT) || 0.05, // 每次挂单金额占总权益比例（5%）
    maxMarketPct: Number(process.env.POLYMARKET_MAX_MARKET_PCT) || 0.15, // 单市场占用资金上限（15%）
    
    // 如果没有在 .env 里设置，默认改为每 30 分钟扫描一次，大幅节省代理流量成本
    scanInterval: 1000 * 60 * (Number(process.env.POLYMARKET_SCAN_INTERVAL_MINUTES) || 30), 

    // 做市策略配置 (Market Making)
    targetMarketsCount: 5, // 想要同时做市的市场数量
    // 【第一轮迭代】极低频宽价差防守
    spreadHalfBase: 0.02, // 保守基准半价差 (总价差 4%)
    spreadHalfMax: 0.06, // 最大允许半价差
    inventorySkewFactor: Number(process.env.POLYMARKET_INVENTORY_SKEW_FACTOR) || 0.02, // 库存倾斜的最大降价幅度（默认 0.02 即 2 美分）
    minLiquidity: 10, // 再次放宽下限，因为官方 API 返回的 liquidity 计算方式和实际订单簿深度有差异
    maxLiquidity: 500000, // 放宽上限
  }
};

// Validate config
const missingKeys = Object.entries(config.polymarket)
  .filter(([key, value]) => key !== 'geoBlockToken' && !value) // geoBlockToken is optional when using a proxy
  .map(([key]) => `polymarket.${key}`);

if (missingKeys.length > 0) {
  console.warn(`[Warning] Missing Polymarket config keys: ${missingKeys.join(', ')}`);
}

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
if (!proxyUrl) {
  console.warn(`[Warning] No HTTP/HTTPS proxy configured. You might encounter Geo-block errors on VPS.`);
}
