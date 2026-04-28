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
    sizePct: 0.05,
    maxMarketPct: 0.15,
    spreadHalfBase: 0.02,
    spreadHalfMax: 0.04,
    inventorySkewFactor: 0.02,
    timeDecayDays: 2, // 缩短为 2 天清理死仓
    timeDecaySkewFactor: 0.06, // 加大出清力度
    hardStopLossPct: -0.15,
    enableDualLayerGrid: true,
    initialCapital: (initialCapitalEnv && initialCapitalEnv > 0 ? initialCapitalEnv : 500)
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
