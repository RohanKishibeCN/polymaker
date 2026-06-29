import dotenv from 'dotenv';
dotenv.config();

function parseNumberEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function parseIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

const scanIntervalMinutesEnv = parseNumberEnv('POLYMARKET_SCAN_INTERVAL_MINUTES');
const targetMarketsCountEnv = parseIntEnv('POLYMARKET_TARGET_MARKETS_COUNT');
const tagQuotaEnv = parseIntEnv('POLYMARKET_TAG_QUOTA');
const initialCapitalEnv = parseNumberEnv('POLYMARKET_INITIAL_CAPITAL');
const reserveCashUsdcEnv = parseNumberEnv('POLYMARKET_RESERVE_CASH_USDC');
const freezeAddSpreadSoftEnv = parseNumberEnv('POLYMARKET_FREEZE_ADD_SPREAD_SOFT');
const freezeAddSpreadHardEnv = parseNumberEnv('POLYMARKET_FREEZE_ADD_SPREAD_HARD');
const reallocateMaxMarketsEnv = parseIntEnv('POLYMARKET_REALLOCATE_MAX_MARKETS');
const maxPositionCountEnv = parseIntEnv('POLYMARKET_MAX_POSITION_COUNT');

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
    scanIntervalMs: (scanIntervalMinutesEnv && scanIntervalMinutesEnv > 0 ? scanIntervalMinutesEnv * 60 * 1000 : 3600 * 1000),
    targetMarketsCount: (targetMarketsCountEnv && targetMarketsCountEnv > 0 ? targetMarketsCountEnv : 7),
    tagQuota: (tagQuotaEnv && tagQuotaEnv > 0 ? tagQuotaEnv : 2),
    sizePct: 0.12,
    maxMarketPct: 0.30,
    spreadHalfBase: 0.02,
    spreadHalfMax: 0.04,
    inventorySkewFactor: 0.02,
    timeDecayDays: 2, // 缩短为 2 天清理死仓
    timeDecaySkewFactor: 0.06, // 加大出清力度
    hardStopLossPct: -0.15,
    forceCloseDays: 7, // 7 天后强制清仓，不限价格
    enableDualLayerGrid: true,
    maxPositionCount: (maxPositionCountEnv && maxPositionCountEnv > 0 ? maxPositionCountEnv : 30), // 可通过 env 调整
    initialCapital: (initialCapitalEnv && initialCapitalEnv > 0 ? initialCapitalEnv : 500),
    reserveCashUsdc: (reserveCashUsdcEnv && reserveCashUsdcEnv > 0 ? reserveCashUsdcEnv : 50),
    freezeAddSpreadSoft: (freezeAddSpreadSoftEnv && freezeAddSpreadSoftEnv > 0 ? freezeAddSpreadSoftEnv : 0.5),
    freezeAddSpreadHard: (freezeAddSpreadHardEnv && freezeAddSpreadHardEnv > 0 ? freezeAddSpreadHardEnv : 0.8),
    reallocateMaxMarkets: (reallocateMaxMarketsEnv && reallocateMaxMarketsEnv > 0 ? reallocateMaxMarketsEnv : 2)
  },
  getTargetMarketsCount(capital: number): number {
    if (capital <= 500) return 7;
    if (capital <= 1000) return 10;
    if (capital <= 2000) return 12;
    return 15;
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
