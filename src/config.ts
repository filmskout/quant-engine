/**
 * Global configuration and hard safety rails.
 *
 * The defaults here are deliberately conservative: the engine runs in `paper`
 * mode and refuses to touch real funds unless LIVE_TRADING is explicitly set
 * to the exact string "I_UNDERSTAND_THE_RISK". This is not decoration — see
 * execution/guards.ts, which fails closed.
 */

export type VenueId = "paper" | "botchain";

export interface Limits {
  /** Max notional per single order, in quote units (USD-equivalent). */
  maxOrderNotional: number;
  /** Max total notional deployed across all open positions. */
  maxTotalExposure: number;
  /** Max orders per 24h rolling window. */
  maxDailyOrders: number;
  /** Abort if a single order would move the pool more than this fraction. */
  maxPriceImpactPct: number;
  /** Abort if gas price exceeds this (gwei). */
  maxGasGwei: number;
  /** Halt everything if realised drawdown exceeds this fraction of start equity. */
  killSwitchDrawdownPct: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxOrderNotional: 50,
  maxTotalExposure: 250,
  maxDailyOrders: 20,
  maxPriceImpactPct: 0.5,
  maxGasGwei: 100,
  killSwitchDrawdownPct: 10,
};

export interface Config {
  venue: VenueId;
  live: boolean;
  limits: Limits;
  zerog: { baseUrl: string; apiKey?: string; model: string };
  gonka: { baseUrl?: string; apiKey?: string; model: string };
  kite: { baseUrl?: string; apiKey?: string; enabled: boolean };
  botchain: {
    rpcUrl: string;
    chainId: number;
    router: string;
    factory: string;
    privateKey?: string;
  };
}

/**
 * Live trading is gated on an exact-match sentinel rather than a truthy env
 * var, so that a stray `LIVE_TRADING=1` or a copied .env cannot arm real money.
 */
const LIVE_SENTINEL = "I_UNDERSTAND_THE_RISK";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const live = env.LIVE_TRADING === LIVE_SENTINEL;
  const venue = (env.VENUE as VenueId) ?? "paper";

  return {
    venue,
    live,
    limits: {
      ...DEFAULT_LIMITS,
      ...(env.MAX_ORDER_NOTIONAL && {
        maxOrderNotional: Number(env.MAX_ORDER_NOTIONAL),
      }),
      ...(env.MAX_TOTAL_EXPOSURE && {
        maxTotalExposure: Number(env.MAX_TOTAL_EXPOSURE),
      }),
    },
    zerog: {
      baseUrl: env.ZG_BASE_URL ?? "https://router-api.0g.ai/v1",
      apiKey: env.ZG_API_KEY,
      model: env.ZG_MODEL ?? "deepseek-v4-pro",
    },
    gonka: {
      baseUrl: env.GONKA_BASE_URL,
      apiKey: env.GONKA_API_KEY,
      model: env.GONKA_MODEL ?? "kimi-k2.7-code",
    },
    kite: {
      baseUrl: env.KITE_BASE_URL,
      apiKey: env.KITE_API_KEY,
      enabled: env.KITE_ENABLED === "true",
    },
    botchain: {
      rpcUrl: env.BOTCHAIN_RPC_URL ?? "https://rpc.botchain.ai",
      chainId: 677,
      // Verified on-chain 2026-08-02 by reading a live swapExactTokensForETH tx.
      // These are NOT from documentation — the documented addresses were placeholders.
      router: "0x5b90611d4eb8fc82fc2e3d1f0501dd6f434441ad",
      factory: "0x9c937ebc3748825026677e20b13b5e306494a38d",
      privateKey: env.BOTCHAIN_PRIVATE_KEY,
    },
  };
}
