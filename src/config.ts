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
const initialCapitalEnv = parseNumberEnv('POLYMARKET_INITIAL_CAPITAL');
const reserveCashUsdcEnv = parseNumberEnv('POLYMARKET_RESERVE_CASH_USDC');
const maxMarketsEnv = parseIntEnv('POLYMARKET_MAX_MARKETS');
const minBidAskDepthEnv = parseIntEnv('POLYMARKET_MIN_BID_ASK_DEPTH');
const minBidPriceEnv = parseNumberEnv('POLYMARKET_MIN_BID_PRICE');
const maxAskPriceEnv = parseNumberEnv('POLYMARKET_MAX_ASK_PRICE');
const spreadFromMidEnv = parseNumberEnv('POLYMARKET_SPREAD_FROM_MIDPOINT');

export const config = {
  polymarket: {
    apiKey: (process.env.POLYMARKET_API_KEY || '').trim(),
    secret: (process.env.POLYMARKET_API_SECRET || '').trim(),
    passphrase: (process.env.POLYMARKET_API_PASSPHRASE || '').trim(),
    funderAddress: (process.env.POLYMARKET_FUNDER_ADDRESS || '').trim(),
    privateKey: (process.env.PRIVATE_KEY || '').trim(),
    geoBlockToken: (process.env.POLYMARKET_GEOBLOCK_TOKEN || '').trim(),
  },
  notion: {
    token: (process.env.NOTION_TOKEN || '').trim(),
    databaseId: (process.env.NOTION_DATABASE_ID || '').trim(),
  },
  bot: {
    scanIntervalMs: (scanIntervalMinutesEnv && scanIntervalMinutesEnv > 0 ? scanIntervalMinutesEnv * 60 * 1000 : 3600 * 1000),
    maxMarkets: (maxMarketsEnv && maxMarketsEnv > 0 ? maxMarketsEnv : 5),
    minBidAskDepth: (minBidAskDepthEnv && minBidAskDepthEnv > 0 ? minBidAskDepthEnv : 1),
    minBidPrice: (minBidPriceEnv && minBidPriceEnv > 0 ? minBidPriceEnv : 0.10),
    maxAskPrice: (maxAskPriceEnv && maxAskPriceEnv > 0 ? maxAskPriceEnv : 0.90),
    spreadFromMidpoint: (spreadFromMidEnv && spreadFromMidEnv > 0 ? spreadFromMidEnv : 0.02),
    maxPositionCount: 5,
    initialCapital: (initialCapitalEnv && initialCapitalEnv > 0 ? initialCapitalEnv : 500),
    reserveCashUsdc: (reserveCashUsdcEnv && reserveCashUsdcEnv > 0 ? reserveCashUsdcEnv : 50),
  },
};

// Validate config
const missingKeys = Object.entries(config.polymarket)
  .filter(([key, value]) => key !== 'geoBlockToken' && !value)
  .map(([key]) => `polymarket.${key}`);

if (missingKeys.length > 0) {
  console.warn(`[Warning] Missing Polymarket config keys: ${missingKeys.join(', ')}`);
}

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
if (!proxyUrl) {
  console.warn(`[Warning] No HTTP/HTTPS proxy configured. You might encounter Geo-block errors on VPS.`);
}
