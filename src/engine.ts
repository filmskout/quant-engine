/**
 * The decision loop: real market data -> composite score -> LLM review ->
 * risk guards -> execution. Every stage records what it saw and why it acted,
 * so a decision can be reconstructed after the fact.
 */

import { loadConfig, type Config } from "./config.js";
import {
  fetchPerpContexts,
  fetchCandles,
  fetchDepth1pct,
  buildTechnical,
  buildFlow,
  buildRisk,
  buildSmartMoneyPlaceholder,
  type MarketSnapshot,
} from "./signals/sources.js";
import { composite, type ScoreBreakdown } from "./signals/mentis-method.js";
import { askBrain, ruleBasedFallback, type Recommendation } from "./brain/zerog.js";
import { evaluateGuards, type GuardState } from "./execution/guards.js";
import { HyperliquidTestnetVenue, priceThroughBook } from "./execution/hyperliquid.js";
import type { Fill, OrderIntent, Venue } from "./execution/types.js";
import { attest, type AttestationReceipt } from "./payments/kite-x402.js";
import {
  readOmen, recordAgreement, agreementRate,
  type MetaphysicsReading, type AgreementStat,
} from "./signals/metaphysics.js";

export interface Decision {
  ts: number;
  coin: string;
  markPx: number;
  score: ScoreBreakdown;
  rec: Recommendation;
  brain: { source: "0g" | "fallback"; model?: string; proofRef?: string | null; teeVerified?: boolean };
  guards: { allowed: boolean; reasons: string[]; notionalUsd: number };
  fill?: Fill;
  depth1pctUsd: number;
  attestation?: AttestationReceipt;
  /**
   * Entertainment/comparison layer only. Computed alongside the real signal
   * and never mixed into `score`. See signals/metaphysics.ts.
   */
  omen?: MetaphysicsReading;
  omenAgreement?: AgreementStat;
}

/**
 * Conviction floor below which nothing trades. Lowering this via env is a
 * demo lever to exercise the full pipeline when the live market is quiet — it
 * does not make weak signals good, and the dashboard surfaces the active value.
 */
function minConviction(): number {
  const v = Number(process.env.MIN_CONVICTION);
  return Number.isFinite(v) && v > 0 ? v : 0.15;
}

export class Engine {
  private cfg: Config;
  private venue: Venue;
  private oiPrev = new Map<string, number>();
  private guardState: GuardState;

  constructor(cfg: Config = loadConfig(), venue?: Venue) {
    this.cfg = cfg;
    this.venue =
      venue ??
      new HyperliquidTestnetVenue({
        privateKey: process.env.HL_PRIVATE_KEY,
        address: process.env.HL_ADDRESS,
      });
    this.guardState = {
      ordersToday: 0,
      openExposureUsd: 0,
      startEquityUsd: 0,
      currentEquityUsd: 0,
      halted: false,
    };
  }

  get disclosure() {
    return this.venue.disclosure;
  }

  /** Rank the universe by liquidity so we score names that can actually be traded. */
  async universe(topN = 8): Promise<MarketSnapshot[]> {
    const ctxs = await fetchPerpContexts();
    return ctxs
      .filter((c) => c.markPx > 0 && c.dayNtlVlm > 0)
      .sort((a, b) => b.dayNtlVlm - a.dayNtlVlm)
      .slice(0, topN);
  }

  async analyse(snap: MarketSnapshot): Promise<Omit<Decision, "fill" | "guards">> {
    const [candles, depth] = await Promise.all([
      fetchCandles(snap.coin, "1h", 120),
      fetchDepth1pct(snap.coin),
    ]);

    const tech = buildTechnical(candles);
    const flow = buildFlow(snap, this.oiPrev.get(snap.coin));
    this.oiPrev.set(snap.coin, snap.openInterest);
    const risk = buildRisk(depth);
    const sm = buildSmartMoneyPlaceholder();

    const score = composite(sm, tech, flow, risk);

    const payload = {
      coin: snap.coin,
      markPx: snap.markPx,
      fundingRate: snap.fundingRate,
      openInterest: snap.openInterest,
      dayVolumeUsd: snap.dayNtlVlm,
      depth1pctUsd: depth,
      technical: tech,
      flow,
      scoreBreakdown: score,
      minConviction: minConviction(),
    };

    let rec: Recommendation;
    let brain: Decision["brain"];

    if (process.env.BRAIN === "off" || !this.cfg.zerog.apiKey) {
      rec = ruleBasedFallback(score.composite, score.riskPenalty, depth, minConviction());
      brain = { source: "fallback" };
    } else {
      try {
        const r = await askBrain(payload, this.cfg.zerog);
        rec = r.rec;
        brain = {
          source: "0g",
          model: r.model,
          proofRef: r.proofRef,
          teeVerified: r.teeVerified,
        };
      } catch (e) {
        // A brain outage must not silently become "trade on the raw score".
        rec = ruleBasedFallback(score.composite, score.riskPenalty, depth, minConviction());
        brain = { source: "fallback" };
        rec.reasoning = `[0G unavailable: ${(e as Error).message.slice(0, 120)}] ${rec.reasoning}`;
      }
    }

    // Comparison layer. Deliberately computed AFTER `score` and `rec` so it is
    // structurally impossible for it to influence either. It is recorded, shown,
    // and scored for agreement — never acted on.
    const omen = readOmen(snap.coin, new Date(), process.env.MBTI ?? "INTJ");
    recordAgreement(snap.coin, score.direction, omen.direction);

    return {
      ts: Date.now(),
      coin: snap.coin,
      markPx: snap.markPx,
      score,
      rec,
      brain,
      depth1pctUsd: depth,
      omen,
      omenAgreement: agreementRate(),
    };
  }

  async act(analysis: Omit<Decision, "fill" | "guards">): Promise<Decision> {
    const { rec, coin, markPx } = analysis;

    if (rec.action === "hold" || rec.sizePct <= 0) {
      return {
        ...analysis,
        guards: { allowed: false, reasons: ["recommendation is hold"], notionalUsd: 0 },
      };
    }

    const side = rec.action === "open_long" ? "buy" : "sell";
    const requested = (rec.sizePct / 100) * this.cfg.limits.maxOrderNotional;

    const quote = await priceThroughBook(coin, side, requested).catch(() => null);

    const intent: OrderIntent = {
      coin,
      side,
      notionalUsd: requested,
      price: quote?.avgPx || markPx,
    };

    const verdict = evaluateGuards(intent, this.guardState, this.cfg.limits, {
      priceImpactPct: quote?.impactPct,
    });

    if (!verdict.allowed) {
      return {
        ...analysis,
        guards: { allowed: false, reasons: verdict.reasons, notionalUsd: 0 },
      };
    }

    const fill = await this.venue.submit({
      ...intent,
      notionalUsd: verdict.adjustedNotionalUsd,
    });

    if (fill.ok) {
      this.guardState.ordersToday += 1;
      this.guardState.openExposureUsd += verdict.adjustedNotionalUsd;
    }

    return {
      ...analysis,
      guards: {
        allowed: true,
        reasons: verdict.reasons,
        notionalUsd: verdict.adjustedNotionalUsd,
      },
      fill,
    };
  }

  /**
   * Notarise a decision on kite-testnet. Only actionable decisions are
   * attested — paying to timestamp "hold" on every symbol every minute would
   * burn PIEUSD for no audit value.
   *
   * A failed attestation never blocks or reverses a trade; it is recorded as a
   * failure on the decision so the gap is visible rather than silent.
   */
  async attestDecision(d: Decision): Promise<Decision> {
    const url = process.env.ATTEST_URL;
    const key = process.env.KITE_BUYER_KEY;
    if (!url || !key) return d;
    if (d.rec.action === "hold") return d;

    try {
      const receipt = await attest(
        url,
        {
          coin: d.coin,
          action: d.rec.action,
          sizePct: d.rec.sizePct,
          composite: d.score.composite,
          markPx: d.markPx,
          proofRef: d.brain.proofRef ?? null,
          ts: d.ts,
        },
        key,
      );
      return { ...d, attestation: receipt };
    } catch (e) {
      return {
        ...d,
        attestation: { paid: false, status: 0, error: (e as Error).message },
      };
    }
  }

  /**
   * Analyse the universe concurrently. Serially this was ~15s per symbol
   * (dominated by the 0G round-trip), so five symbols meant a 78s page load.
   * Analysis is independent per symbol, so it fans out.
   *
   * `act` and `attestDecision` stay sequential after the fan-in: both mutate
   * shared guard state (order count, exposure) and spend PIEUSD, so racing them
   * could overshoot the exposure cap.
   */
  async tick(topN = 5): Promise<Decision[]> {
    const uni = await this.universe(topN);

    const analysed = await Promise.all(
      uni.map(async (snap) => {
        try {
          return await this.analyse(snap);
        } catch (e) {
          // One bad symbol must not kill the sweep.
          console.error(`[${snap.coin}] ${(e as Error).message}`);
          return null;
        }
      }),
    );

    const out: Decision[] = [];
    for (const a of analysed) {
      if (!a) continue;
      try {
        const acted = await this.act(a);
        out.push(await this.attestDecision(acted));
      } catch (e) {
        console.error(`[${a.coin}] act/attest: ${(e as Error).message}`);
      }
    }
    return out;
  }
}
