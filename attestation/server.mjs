/**
 * Decision Attestation Service — an x402 merchant on kite-testnet.
 *
 * The quant engine pays a micro-fee (PIEUSD) to notarise a trading decision.
 * Settlement is a real on-chain transferWithAuthorization executed by the
 * Pieverse facilitator, producing a real tx hash you can open in the explorer.
 *
 * Why this exists: a recommendation with a 0G proofRef tells you *which model*
 * said it. This adds *when* it was said, immutably, before the outcome was
 * known. Together they make a decision auditable after the fact rather than
 * something that can be quietly rewritten.
 *
 * Flow (x402 v2):
 *   POST /attest            -> 402 + accepts[] terms
 *   POST /attest + X-Payment -> facilitator /v2/verify -> /v2/settle -> receipt
 *
 * Run: node attestation/server.mjs
 */

import { createServer } from "node:http";
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.ATTEST_PORT ?? 8771);
const PIEUSD = "0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A";
const FACILITATOR = "https://facilitator.pieverse.io/v2";
const EXPLORER = "https://testnet.kitescan.ai";
// Both of these are load-bearing and were wrong on the first attempt:
// the facilitator rejects `gokite-aa` ("No facilitator registered for scheme")
// and expects CAIP-2 form for the network, not the human name "kite-testnet".
const SCHEME = "exact";
const NETWORK = "eip155:2368"; // kite-testnet

// Price per attestation: 0.01 PIEUSD (18 decimals).
const PRICE_WEI = (10n ** 18n / 100n).toString();

const MERCHANT =
  process.env.MERCHANT_ADDRESS ??
  "0xBb070c09a1319d762380F079Ad6a98DEC54fCA0C";

const LEDGER = join(__dirname, "attestations.jsonl");

/** Canonical hash of the decision — this is what gets notarised. */
function decisionHash(d) {
  const canonical = JSON.stringify({
    coin: d.coin,
    action: d.action,
    sizePct: d.sizePct,
    composite: d.composite,
    markPx: d.markPx,
    proofRef: d.proofRef ?? null,
    ts: d.ts,
  });
  return "0x" + createHash("sha256").update(canonical).digest("hex");
}

function terms(resourceUrl) {
  return {
    scheme: SCHEME,
    network: NETWORK,
    // x402 v2 uses `amount`, not v1's `maxAmountRequired`.
    amount: PRICE_WEI,
    asset: PIEUSD,
    payTo: MERCHANT,
    maxTimeoutSeconds: 300,
    // The facilitator reconstructs the EIP-712 domain from `extra`. Omit it and
    // verify returns isValid:false / missing_eip712_domain even though the
    // signature itself is perfectly valid and the payer recovers correctly.
    extra: {
      name: "pieUSD",
      version: "1",
      merchantName: "Quant Decision Attestation",
      priceHuman: "0.01",
    },
    resource: {
      url: resourceUrl,
      description: "Immutable on-chain notarisation of a trading decision hash",
      mimeType: "application/json",
      serviceName: "quant-attest",
    },
    outputSchema: {
      type: "object",
      properties: {
        decisionHash: { type: "string" },
        txHash: { type: "string" },
        explorerUrl: { type: "string" },
        attestedAt: { type: "number" },
      },
    },
  };
}

async function facilitate(path, body) {
  const res = await fetch(`${FACILITATOR}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep raw */
  }
  return { ok: res.ok, status: res.status, json, text };
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const send = (code, obj, headers = {}) => {
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, X-Payment",
      ...headers,
    });
    res.end(JSON.stringify(obj));
  };

  if (req.method === "OPTIONS") return send(204, {});

  if (url.pathname === "/health") {
    return send(200, { ok: true, merchant: MERCHANT, network: NETWORK, price: PRICE_WEI });
  }

  if (url.pathname === "/attestations") {
    const lines = existsSync(LEDGER)
      ? readFileSync(LEDGER, "utf8").trim().split("\n").filter(Boolean)
      : [];
    return send(200, {
      count: lines.length,
      items: lines.slice(-50).map((l) => JSON.parse(l)).reverse(),
    });
  }

  if (url.pathname !== "/attest" || req.method !== "POST") {
    return send(404, { error: "not found" });
  }

  const decision = await readBody(req);
  if (!decision?.coin || !decision?.action) {
    return send(400, { error: "body must include at least { coin, action }" });
  }

  const resourceUrl = `http://localhost:${PORT}/attest`;
  const xPayment = req.headers["x-payment"];

  // No payment yet -> quote the terms.
  if (!xPayment) {
    return send(402, {
      x402Version: 2,
      error: "payment required",
      accepts: [terms(resourceUrl)],
    });
  }

  // Payment presented -> verify then settle.
  let paymentPayload;
  try {
    paymentPayload = JSON.parse(Buffer.from(String(xPayment), "base64").toString("utf8"));
  } catch {
    return send(400, { error: "X-Payment is not valid base64 JSON" });
  }

  const requirements = terms(resourceUrl);
  const body = { x402Version: 2, paymentPayload, paymentRequirements: requirements };

  const verify = await facilitate("verify", body);
  if (!verify.ok || verify.json?.isValid === false) {
    return send(402, {
      error: "payment verification failed",
      detail: verify.json ?? verify.text.slice(0, 400),
    });
  }

  const settle = await facilitate("settle", body);
  if (!settle.ok) {
    return send(402, {
      error: "settlement failed",
      detail: settle.json ?? settle.text.slice(0, 400),
    });
  }

  const txHash =
    settle.json?.transaction ?? settle.json?.txHash ?? settle.json?.transactionHash ?? null;

  const record = {
    decisionHash: decisionHash(decision),
    coin: decision.coin,
    action: decision.action,
    composite: decision.composite ?? null,
    proofRef: decision.proofRef ?? null,
    payer: paymentPayload?.payload?.authorization?.from ?? null,
    amountWei: PRICE_WEI,
    txHash,
    explorerUrl: txHash ? `${EXPLORER}/tx/${txHash}` : null,
    network: NETWORK,
    attestedAt: Date.now(),
  };

  appendFileSync(LEDGER, JSON.stringify(record) + "\n");
  console.log(`[attest] ${record.coin} ${record.action} -> ${txHash ?? "(no tx in response)"}`);

  return send(
    200,
    record,
    txHash
      ? { "X-Payment-Response": Buffer.from(JSON.stringify({ txHash })).toString("base64") }
      : {},
  );
});

server.listen(PORT, () => {
  console.log(`\n  Attestation merchant  http://localhost:${PORT}`);
  console.log(`  merchant  : ${MERCHANT}`);
  console.log(`  asset     : PIEUSD ${PIEUSD}`);
  console.log(`  price     : ${Number(PRICE_WEI) / 1e18} PIEUSD per attestation`);
  console.log(`  facilitator: ${FACILITATOR}\n`);
});
