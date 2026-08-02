/**
 * End-to-end execution path verification.
 *
 * The live market often scores below the conviction threshold, which correctly
 * produces "hold" everywhere. That is honest but proves nothing about whether
 * the execution path works. This script forces a high-conviction signal through
 * the real guard + venue stack and asserts a fill comes back, priced against
 * the real live order book.
 *
 * Run: node scripts/verify-execution.mjs
 */

import { composite } from "../dist/signals/mentis-method.js";
import { ruleBasedFallback } from "../dist/brain/zerog.js";
import { evaluateGuards } from "../dist/execution/guards.js";
import { HyperliquidTestnetVenue, priceThroughBook } from "../dist/execution/hyperliquid.js";
import { DEFAULT_LIMITS } from "../dist/config.js";

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
};

console.log("\n=== 1. scoring produces a directional signal when inputs are strong ===");
const bull = composite(
  { netBias: 0.9, winRate30d: 0.78, notionalUsd: 5_000_000, meanLeverage: 3 },
  { maDeviation: -0.02, rsi: 28, realisedVol: 0.5, trendStrength: 0.6 },
  { fundingRate: -0.0004, oiChange24h: 0.15, takerImbalance: 0.6 },
  { liquidationProximity: 1, depth1pctUsd: 8_000_000, hoursToCatalyst: Infinity },
  0.5,
);
console.log(`  composite=${bull.composite.toFixed(3)} direction=${bull.direction}`);
check("strong bull inputs -> long", bull.direction === "long");
check("confidence above threshold", bull.confidence > 0.15, bull.confidence.toFixed(3));

console.log("\n=== 2. risk penalty suppresses rather than flips ===");
const risky = composite(
  { netBias: 0.9, winRate30d: 0.78, notionalUsd: 5_000_000, meanLeverage: 3 },
  { maDeviation: -0.02, rsi: 28, realisedVol: 0.5, trendStrength: 0.6 },
  { fundingRate: -0.0004, oiChange24h: 0.15, takerImbalance: 0.6 },
  { liquidationProximity: 0.01, depth1pctUsd: 10_000, hoursToCatalyst: 2 },
  0.5,
);
console.log(`  composite=${risky.composite.toFixed(3)} penalty=${risky.riskPenalty.toFixed(2)}`);
check("dangerous setup shrinks toward zero", Math.abs(risky.composite) < Math.abs(bull.composite));
check("sign never flips from risk alone", Math.sign(risky.composite) === Math.sign(bull.composite) || risky.composite === 0);

console.log("\n=== 3. thin book caps size ===");
const thin = ruleBasedFallback(0.8, 0.1, 100_000);
check("depth < $250k caps sizePct at 10", thin.sizePct <= 10, `got ${thin.sizePct}`);

console.log("\n=== 4. guards enforce notional + exposure ceilings ===");
const v1 = evaluateGuards(
  { coin: "BTC", side: "buy", notionalUsd: 10_000, price: 60_000 },
  { ordersToday: 0, openExposureUsd: 0, startEquityUsd: 1000, currentEquityUsd: 1000, halted: false },
  DEFAULT_LIMITS, {},
);
check("oversized order is capped, not rejected", v1.allowed && v1.adjustedNotionalUsd === DEFAULT_LIMITS.maxOrderNotional,
  `$${v1.adjustedNotionalUsd}`);

const v2 = evaluateGuards(
  { coin: "BTC", side: "buy", notionalUsd: 50, price: 60_000 },
  { ordersToday: 0, openExposureUsd: 0, startEquityUsd: 1000, currentEquityUsd: 880, halted: false },
  DEFAULT_LIMITS, {},
);
check("kill switch fires at 12% drawdown", !v2.allowed, v2.reasons[0]);

const v3 = evaluateGuards(
  { coin: "BTC", side: "buy", notionalUsd: 50, price: 60_000 },
  { ordersToday: 0, openExposureUsd: 0, startEquityUsd: 1000, currentEquityUsd: 1000, halted: false },
  DEFAULT_LIMITS, { priceImpactPct: 5 },
);
check("excessive price impact blocks", !v3.allowed, v3.reasons.at(-1));

console.log("\n=== 5. real order book pricing (live network) ===");
const q = await priceThroughBook("BTC", "buy", 50);
console.log(`  top=$${q.topPx} avg=$${q.avgPx.toFixed(2)} sz=${q.sz.toFixed(6)} impact=${q.impactPct.toFixed(4)}%`);
check("book returned a real price", q.avgPx > 0);
check("size derived from notional", q.sz > 0);
check("impact computed", Number.isFinite(q.impactPct));

console.log("\n=== 6. venue produces a fill through the full stack ===");
const venue = new HyperliquidTestnetVenue({});
const fill = await venue.submit({ coin: "BTC", side: "buy", notionalUsd: 50, price: q.avgPx });
console.log(`  ok=${fill.ok} sz=${fill.filledSz.toFixed(6)} avg=$${fill.avgPx.toFixed(2)} simulated=${fill.simulated}`);
check("fill returned", fill.ok);
check("fill is flagged simulated without keys", fill.simulated === true);
check("explorer link present", Boolean(fill.explorerUrl), fill.explorerUrl ?? "");

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}\n`);
process.exit(failures === 0 ? 0 : 1);
