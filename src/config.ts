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
    maxInvestment: 1, // USDC per trade to start safe
    scanInterval: 1000 * 60 * 60, // 1 hour
    profitThreshold: 0.01, // Minimum profit to execute arbitrage (in USDC)
  }
};

// Validate config
const missingKeys = Object.entries(config.polymarket)
  .filter(([_, value]) => !value)
  .map(([key]) => `polymarket.${key}`);

if (missingKeys.length > 0) {
  console.warn(`Missing Polymarket config keys: ${missingKeys.join(', ')}`);
}
