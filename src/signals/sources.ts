/**
 * Public market-data adapters.
 *
 * Everything here hits documented, public, unauthenticated endpoints.
 * Nothing here scrapes gmentis.ai — see mentis-method.ts for why.
 *
 * Hyperliquid's info API is public and documented:
 *   https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
 */

import type {
  SmartMoneyInput,
  TechnicalInput,
  FlowInput,
  RiskInput,
} from "./mentis-method.js";

const HL_INFO = "https://api.hyperliquid.xyz/info";

async function hlPost<T>(body: unknown): Promise<T> {
  const res = await fetch(HL_INFO, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Hyperliquid ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export interface MarketSnapshot {
  coin: string;
  markPx: number;
  fundingRate: number;
  openInterest: number;
  dayNtlVlm: number;
  premium: number;
}

/** Live perp context for every listed coin. */
export async function fetchPerpContexts(): Promise<MarketSnapshot[]> {
  const [meta, ctxs] = await hlPost<[{ universe: { name: string }[] }, any[]]>({
    type: "metaAndAssetCtxs",
  });

  return meta.universe.map((u, i) => {
    const c = ctxs[i] ?? {};
    return {
      coin: u.name,
      markPx: Number(c.markPx ?? 0),
      fundingRate: Number(c.funding ?? 0),
      openInterest: Number(c.openInterest ?? 0),
      dayNtlVlm: Number(c.dayNtlVlm ?? 0),
      premium: Number(c.premium ?? 0),
    };
  });
}

/** Recent candles for technical structure. interval e.g. "1h". */
export async function fetchCandles(
  coin: string,
  interval = "1h",
  lookback = 120,
): Promise<{ t: number; o: number; h: number; l: number; c: number; v: number }[]> {
  const endTime = Date.now();
  const msPer: Record<string, number> = { "1m": 6e4, "15m": 9e5, "1h": 3.6e6, "4h": 1.44e7, "1d": 8.64e7 };
  const startTime = endTime - (msPer[interval] ?? 3.6e6) * lookback;

  const raw = await hlPost<any[]>({
    type: "candleSnapshot",
    req: { coin, interval, startTime, endTime },
  });

  return (raw ?? []).map((k) => ({
    t: Number(k.t),
    o: Number(k.o),
    h: Number(k.h),
    l: Number(k.l),
    c: Number(k.c),
    v: Number(k.v),
  }));
}

/** L2 book, used for real depth measurement rather than a guess. */
export async function fetchDepth1pct(coin: string): Promise<number> {
  const book = await hlPost<{ levels: [any[], any[]] }>({ type: "l2Book", coin });
  const [bids, asks] = book.levels ?? [[], []];
  const best = Number(bids?.[0]?.px ?? asks?.[0]?.px ?? 0);
  if (!best) return 0;

  const within = (side: any[], cmp: (px: number) => boolean) =>
    side
      .filter((l) => cmp(Number(l.px)))
      .reduce((s, l) => s + Number(l.px) * Number(l.sz), 0);

  return (
    within(bids ?? [], (px) => px >= best * 0.99) +
    within(asks ?? [], (px) => px <= best * 1.01)
  );
}

// ── derived technicals ────────────────────────────────────────────────

function sma(xs: number[], n: number): number {
  if (xs.length < n) return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  return xs.slice(-n).reduce((a, b) => a + b, 0) / n;
}

function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gain = 0;
  let loss = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  if (loss === 0) return 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

function realisedVol(closes: number[], periodsPerYear = 24 * 365): number {
  if (closes.length < 3) return 0;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance * periodsPerYear);
}

/** Signed trend measure from linear regression slope, normalised by vol. */
function trendStrength(closes: number[]): number {
  const n = closes.length;
  if (n < 10) return 0;
  const xs = Array.from({ length: n }, (_, i) => i);
  const mx = (n - 1) / 2;
  const my = closes.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (closes[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const slope = den ? num / den : 0;
  const norm = my ? (slope * n) / my : 0;
  return Math.max(-1, Math.min(1, norm * 5));
}

export function buildTechnical(candles: { c: number }[]): TechnicalInput {
  const closes = candles.map((c) => c.c);
  const last = closes.at(-1) ?? 0;
  const ma20 = sma(closes, 20);
  return {
    maDeviation: ma20 ? (last - ma20) / ma20 : 0,
    rsi: rsi(closes),
    realisedVol: realisedVol(closes),
    trendStrength: trendStrength(closes),
  };
}

export function buildFlow(snap: MarketSnapshot, oiPrev?: number): FlowInput {
  return {
    fundingRate: snap.fundingRate,
    oiChange24h: oiPrev && oiPrev > 0 ? (snap.openInterest - oiPrev) / oiPrev : 0,
    // Premium is a usable public proxy for taker pressure when we have no
    // per-trade tape: sustained positive premium means takers are lifting offers.
    takerImbalance: Math.max(-1, Math.min(1, snap.premium * 100)),
  };
}

export function buildRisk(depth1pctUsd: number, hoursToCatalyst = Infinity): RiskInput {
  return {
    // Without a wallet-level liquidation map we do not fake precision here;
    // 1.0 means "no known cluster nearby", which applies no penalty.
    liquidationProximity: 1,
    depth1pctUsd,
    hoursToCatalyst,
  };
}

/**
 * Smart-money proxy.
 *
 * Honest limitation: real smart-money tracking needs a labelled wallet set,
 * which is exactly what Mentis sells and what we are not scraping. Until a
 * licensed feed is wired in (Nansen via Kite x402 — see payments/kite-x402.ts),
 * this returns a zero-bias, zero-confidence input so the 30% weight
 * contributes nothing rather than contributing noise.
 */
export function buildSmartMoneyPlaceholder(): SmartMoneyInput {
  return { netBias: 0, winRate30d: 0.5, notionalUsd: 0, meanLeverage: 1 };
}
