/**
 * Zero-dependency HTTP server: serves the dashboard and the engine's decisions.
 *
 * Compute-on-request. There is no background tick — a scan runs when someone
 * asks for /api/state, and the result is cached for CACHE_TTL_MS so that a
 * page doing 15s polling (or ten people opening it at once) does not fan out
 * into ten Hyperliquid sweeps and ten 0G calls.
 *
 * This shape works unchanged on a plain box and on request-scoped serverless,
 * where a background setInterval would simply never run.
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Engine, type Decision } from "./engine.js";
import { loadConfig } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8770);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS ?? 45_000);
const TOP_N = Number(process.env.TOP_N ?? 5);

const cfg = loadConfig();
const engine = new Engine(cfg);

interface Snapshot {
  decisions: Decision[];
  computedAt: number;
  error: string | null;
  durationMs: number;
}

let cache: Snapshot | null = null;
/** In-flight scan, so concurrent requests share one sweep instead of stacking. */
let inflight: Promise<Snapshot> | null = null;

async function runScan(): Promise<Snapshot> {
  const t0 = Date.now();
  try {
    const decisions = await engine.tick(TOP_N);
    const snap: Snapshot = {
      decisions,
      computedAt: Date.now(),
      error: null,
      durationMs: Date.now() - t0,
    };
    console.log(
      `[scan] ${new Date().toISOString()} n=${decisions.length} ` +
        `acted=${decisions.filter((d) => d.fill?.ok).length} ${snap.durationMs}ms`,
    );
    return snap;
  } catch (e) {
    console.error("[scan] failed:", (e as Error).message);
    return {
      decisions: cache?.decisions ?? [],
      computedAt: Date.now(),
      error: (e as Error).message,
      durationMs: Date.now() - t0,
    };
  }
}

async function getSnapshot(force = false): Promise<Snapshot> {
  const fresh = cache && Date.now() - cache.computedAt < CACHE_TTL_MS;
  if (!force && fresh) return cache!;
  if (inflight) return inflight;

  inflight = runScan().finally(() => {
    inflight = null;
  });
  cache = await inflight;
  return cache;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const json = (code: number, body: unknown) => {
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(body));
  };

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  if (url.pathname === "/api/health") {
    return json(200, { ok: true, cached: Boolean(cache), ttlMs: CACHE_TTL_MS });
  }

  if (url.pathname === "/api/state") {
    const snap = await getSnapshot(url.searchParams.get("fresh") === "1");
    return json(200, {
      decisions: snap.decisions,
      computedAt: snap.computedAt,
      durationMs: snap.durationMs,
      cacheTtlMs: CACHE_TTL_MS,
      stale: Date.now() - snap.computedAt > CACHE_TTL_MS,
      lastError: snap.error,
      venue: { id: "hyperliquid-testnet", disclosure: engine.disclosure },
      config: {
        live: cfg.live,
        limits: cfg.limits,
        brain: process.env.BRAIN === "off" || !cfg.zerog.apiKey ? "fallback" : "0g",
        minConviction: Number(process.env.MIN_CONVICTION) || 0.15,
        signalSource: "hyperliquid-mainnet-public",
      },
    });
  }

  // Proxy the merchant's settled-attestation ledger so the dashboard can show
  // real on-chain records even on scans where nothing new was actionable.
  if (url.pathname === "/api/attestations") {
    const base = process.env.ATTEST_URL?.replace(/\/attest$/, "");
    if (!base) return json(200, { count: 0, items: [], disabled: true });
    try {
      const r = await fetch(`${base}/attestations`);
      return json(200, await r.json());
    } catch (e) {
      return json(200, { count: 0, items: [], error: (e as Error).message });
    }
  }

  if (url.pathname === "/api/scan" && req.method === "POST") {
    const snap = await getSnapshot(true);
    return json(200, { ok: true, count: snap.decisions.length, durationMs: snap.durationMs });
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    try {
      const html = readFileSync(join(__dirname, "..", "public", "index.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    } catch {
      res.writeHead(500);
      return res.end("dashboard not found");
    }
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`\n  Quant Engine  http://localhost:${PORT}`);
  console.log(`  mode     : compute-on-request (cache ${CACHE_TTL_MS}ms)`);
  console.log(`  venue    : ${engine.disclosure}`);
  console.log(
    `  brain    : ${process.env.BRAIN === "off" || !cfg.zerog.apiKey ? "rule-based fallback" : "0G Compute"}`,
  );
  console.log(`  live     : ${cfg.live ? "ARMED" : "disarmed (paper/shadow)"}\n`);
});
