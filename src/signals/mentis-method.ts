/**
 * Mentis-style composite scoring, reimplemented from the published methodology.
 *
 * IMPORTANT — provenance:
 * This module implements the *weighting framework* Mentis documents publicly.
 * It does NOT call any gmentis.ai endpoint. Their private `/api/v1/...` routes
 * are undocumented, robots.txt-disallowed, and explicitly "not a public
 * contract", so we feed this framework from public sources instead
 * (see ./sources.ts).
 *
 * Weights (published framework):
 *   +30%  smart-money positioning
 *   +25%  technical structure
 *   +25%  flow / momentum confirmation
 *   +20%  sentiment & catalyst
 *   -20%  risk penalty (applied after, can push a score negative)
 */

export interface SmartMoneyInput {
  /** Net directional bias of tracked profitable wallets, -1 (short) .. +1 (long). */
  netBias: number;
  /** Share of tracked wallets on the winning side of the last 30d, 0..1. */
  winRate30d: number;
  /** Aggregate notional of tracked positions, USD. Used for confidence weighting. */
  notionalUsd: number;
  /** Mean leverage across tracked positions. High leverage = fragile positioning. */
  meanLeverage: number;
}

export interface TechnicalInput {
  /** Price relative to 20-period MA, as a fraction. +0.05 = 5% above. */
  maDeviation: number;
  /** RSI 0..100. */
  rsi: number;
  /** Realised volatility, annualised fraction. 0.8 = 80%. */
  realisedVol: number;
  /** Trend persistence, -1..+1 (e.g. Hurst-like or ADX-derived signed measure). */
  trendStrength: number;
}

export interface FlowInput {
  /** Perp funding rate, per 8h, as a fraction. Positive = longs pay shorts. */
  fundingRate: number;
  /** Open interest change over 24h, as a fraction. */
  oiChange24h: number;
  /** Net taker volume imbalance, -1..+1. */
  takerImbalance: number;
}

export interface RiskInput {
  /** Distance to the densest liquidation cluster, as a fraction of price. */
  liquidationProximity: number;
  /** Depth of the book within 1%, USD. Thin books are penalised hard. */
  depth1pctUsd: number;
  /** Hours until a known high-impact catalyst. Infinity if none. */
  hoursToCatalyst: number;
}

export interface ScoreBreakdown {
  smartMoney: number;
  technical: number;
  flow: number;
  sentiment: number;
  riskPenalty: number;
  composite: number;
  /** -1..+1. Sign is direction, magnitude is conviction. */
  direction: "long" | "short" | "flat";
  confidence: number;
  notes: string[];
}

const clamp = (v: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));

/** Confidence weighting: a $10k signal should not carry a $10M signal's weight. */
function notionalConfidence(usd: number): number {
  if (usd <= 0) return 0;
  // log-scaled, saturating around $10M
  return Math.min(1, Math.log10(usd + 1) / 7);
}

export function scoreSmartMoney(i: SmartMoneyInput): number {
  const conf = notionalConfidence(i.notionalUsd);
  // Win rate is centred at 0.5 — a 50% cohort carries no information.
  const edge = (i.winRate30d - 0.5) * 2;
  // Crowded high-leverage positioning is a fade signal, not a follow signal.
  const leverageDiscount = i.meanLeverage > 10 ? 0.5 : 1;
  return clamp(i.netBias * edge * conf * leverageDiscount);
}

export function scoreTechnical(i: TechnicalInput): number {
  // Mean-reversion component: stretched price pulls the score against the move.
  const reversion = -clamp(i.maDeviation * 4);
  // RSI extremes
  const rsiSignal = i.rsi > 70 ? -0.6 : i.rsi < 30 ? 0.6 : (50 - i.rsi) / 50 * 0.3;
  // Trend component pulls with the move — these two intentionally fight.
  const trend = clamp(i.trendStrength);
  // Vol scaling: high vol degrades all technical signal quality.
  const volScale = 1 / (1 + Math.max(0, i.realisedVol - 0.5));
  return clamp((reversion * 0.3 + rsiSignal * 0.3 + trend * 0.4) * volScale);
}

export function scoreFlow(i: FlowInput): number {
  // Extreme funding is a crowding signal — fade it.
  const fundingFade = -clamp(i.fundingRate * 200);
  // Rising OI confirms whatever direction taker flow is pushing.
  const oiConfirm = clamp(i.oiChange24h * 2) * clamp(i.takerImbalance);
  return clamp(fundingFade * 0.5 + oiConfirm * 0.5);
}

export function scoreRisk(i: RiskInput): number {
  let penalty = 0;
  const notes: string[] = [];

  // Near a liquidation cluster = cascade risk.
  if (i.liquidationProximity < 0.03) penalty += 0.6;
  else if (i.liquidationProximity < 0.08) penalty += 0.3;

  // Thin book = you are the exit liquidity.
  if (i.depth1pctUsd < 50_000) penalty += 0.7;
  else if (i.depth1pctUsd < 250_000) penalty += 0.35;

  // Event risk
  if (i.hoursToCatalyst < 6) penalty += 0.5;
  else if (i.hoursToCatalyst < 24) penalty += 0.2;

  return Math.min(1, penalty);
}

export function composite(
  sm: SmartMoneyInput,
  tech: TechnicalInput,
  flow: FlowInput,
  risk: RiskInput,
  sentiment = 0,
): ScoreBreakdown {
  const smartMoney = scoreSmartMoney(sm);
  const technical = scoreTechnical(tech);
  const flowScore = scoreFlow(flow);
  const riskPenalty = scoreRisk(risk);

  const raw =
    smartMoney * 0.30 +
    technical * 0.25 +
    flowScore * 0.25 +
    clamp(sentiment) * 0.20;

  // Risk penalty scales the signal toward zero rather than flipping it —
  // a dangerous setup should mean "don't trade", never "trade the other way".
  const compositeScore = raw * (1 - riskPenalty);

  const notes: string[] = [];
  if (riskPenalty > 0.5) notes.push("high risk penalty — position size should be cut or skipped");
  if (sm.meanLeverage > 10) notes.push("tracked cohort is highly levered; crowding risk");
  if (risk.depth1pctUsd < 250_000) notes.push("thin book — slippage will dominate edge");
  if (Math.abs(compositeScore) < 0.15) notes.push("below conviction threshold");

  const direction =
    compositeScore > 0.15 ? "long" : compositeScore < -0.15 ? "short" : "flat";

  return {
    smartMoney,
    technical,
    flow: flowScore,
    sentiment: clamp(sentiment),
    riskPenalty,
    composite: compositeScore,
    direction,
    confidence: Math.abs(compositeScore),
    notes,
  };
}
