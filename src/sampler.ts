/**
 * Background agreement sampler.
 *
 * Accumulates omen-vs-quant direction samples so the agreement rate has a
 * denominator worth reading. Deliberately cheap: it needs only market data
 * (public, free) plus two pure functions. It does NOT call 0G, does NOT touch
 * the venue, and does NOT spend PIEUSD — so running it continuously costs
 * essentially nothing and cannot affect trading.
 *
 * ── On the statistics, honestly ────────────────────────────────────────
 * Samples are not fully independent:
 *   - the omen's time component only changes every 时辰 (2h), so everything
 *     sampled within one 时辰 shares it;
 *   - composite scores are autocorrelated minute to minute.
 * To buy real variation we sweep the WHOLE liquid universe rather than the
 * same five names, because the asset-element term differs per symbol. The
 * UI reports `shichenCovered` next to `samples` so nobody reads 500
 * correlated draws as 500 independent ones.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { fetchPerpContexts, fetchCandles, buildTechnical, buildFlow, buildRisk,
         buildSmartMoneyPlaceholder } from "./signals/sources.js";
import { composite } from "./signals/mentis-method.js";
import { readOmen, recordAgreement, agreementRate,
         exportTally, importTally } from "./signals/metaphysics.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE = join(__dirname, "..", "data", "agreement.json");

export function loadStore() {
  try {
    if (existsSync(STORE)) {
      importTally(JSON.parse(readFileSync(STORE, "utf8")));
      const a = agreementRate();
      console.log(`[sampler] restored ${a.samples} samples (${(a.rate * 100).toFixed(1)}%)`);
    }
  } catch (e) {
    console.error("[sampler] could not restore store:", (e as Error).message);
  }
}

export function saveStore() {
  try {
    mkdirSync(dirname(STORE), { recursive: true });
    writeFileSync(STORE, JSON.stringify(exportTally()));
  } catch (e) {
    console.error("[sampler] could not persist store:", (e as Error).message);
  }
}

let running = false;
let cycles = 0;

/**
 * One sweep: score `breadth` liquid symbols and record whether the omen
 * agreed with the quant direction on each.
 */
export async function sampleOnce(breadth = 12, mbti = "INTJ"): Promise<number> {
  const ctxs = await fetchPerpContexts();
  const universe = ctxs
    .filter((c) => c.markPx > 0 && c.dayNtlVlm > 0)
    .sort((a, b) => b.dayNtlVlm - a.dayNtlVlm)
    .slice(0, breadth);

  let n = 0;
  const now = new Date();

  // Candles dominate the wall clock; fan out but keep the batch modest so we
  // stay well inside Hyperliquid's rate limits.
  const results = await Promise.all(
    universe.map(async (snap) => {
      try {
        const candles = await fetchCandles(snap.coin, "1h", 60);
        if (!candles.length) return null;
        const score = composite(
          buildSmartMoneyPlaceholder(),
          buildTechnical(candles),
          buildFlow(snap),
          // depth is not fetched here — an extra L2 call per symbol per cycle is
          // not worth it, and depth only feeds the risk penalty, not direction.
          buildRisk(1_000_000),
        );
        const omen = readOmen(snap.coin, now, mbti);
        return { coin: snap.coin, q: score.direction, o: omen.direction, sc: omen.bazi.shichen };
      } catch {
        return null;
      }
    }),
  );

  for (const r of results) {
    if (!r) continue;
    recordAgreement(r.coin, r.q, r.o, r.sc);
    n++;
  }
  cycles++;
  saveStore();
  return n;
}

export function startSampler() {
  if (running) return;
  if (process.env.SAMPLER === "off") {
    console.log("[sampler] disabled (SAMPLER=off)");
    return;
  }
  running = true;

  const intervalMs = Number(process.env.SAMPLER_INTERVAL_MS ?? 90_000);
  const breadth = Number(process.env.SAMPLER_BREADTH ?? 12);
  const target = Number(process.env.SAMPLER_TARGET ?? 600);

  loadStore();
  console.log(
    `[sampler] on — every ${intervalMs / 1000}s x ${breadth} symbols, target ${target} samples`,
  );

  const tick = async () => {
    const a = agreementRate();
    if (a.samples >= target) {
      // Target reached: stop burning requests. The rate is what it is.
      console.log(
        `[sampler] target reached: ${a.samples} samples, ${(a.rate * 100).toFixed(1)}% ` +
          `(95% CI ${(a.ci95![0] * 100).toFixed(1)}–${(a.ci95![1] * 100).toFixed(1)}%)`,
      );
      running = false;
      return;
    }
    try {
      const n = await sampleOnce(breadth, process.env.MBTI ?? "INTJ");
      const b = agreementRate();
      if (cycles % 5 === 0 || n === 0) {
        console.log(
          `[sampler] +${n} -> ${b.samples} samples, ${(b.rate * 100).toFixed(1)}%, ` +
            `${b.shichenCovered} 时辰`,
        );
      }
    } catch (e) {
      console.error("[sampler] cycle failed:", (e as Error).message);
    }
    if (running) setTimeout(tick, intervalMs);
  };

  // Small initial delay so the first page load is not competing for sockets.
  setTimeout(tick, 5_000);
}
