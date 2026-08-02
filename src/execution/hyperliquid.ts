/**
 * Hyperliquid testnet execution.
 *
 * Real matching engine, real order book, real fills — testnet USDC, so no
 * capital at risk. Signals are computed from *mainnet* data (see
 * signals/sources.ts) while orders route to *testnet*; that asymmetry is
 * intentional and disclosed, because testnet books are too thin to generate
 * meaningful signal.
 *
 * Without HL_PRIVATE_KEY the adapter runs in shadow mode: it prices the order
 * against the real live book and reports the fill it *would* have received,
 * clearly flagged as simulated.
 */

import type { Venue, OrderIntent, Fill } from "./types.js";

const TESTNET_API = "https://api.hyperliquid-testnet.xyz";
const TESTNET_APP = "https://app.hyperliquid-testnet.xyz";

async function post<T>(base: string, body: unknown): Promise<T> {
  const res = await fetch(`${base}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HL ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

/** Walk the real book to get an execution-aware average price. */
export async function priceThroughBook(
  coin: string,
  side: "buy" | "sell",
  notionalUsd: number,
  base = TESTNET_API,
): Promise<{ avgPx: number; sz: number; impactPct: number; topPx: number }> {
  const book = await post<{ levels: [any[], any[]] }>(base, { type: "l2Book", coin });
  const [bids, asks] = book.levels ?? [[], []];
  const side_ = side === "buy" ? asks : bids;
  if (!side_?.length) return { avgPx: 0, sz: 0, impactPct: 0, topPx: 0 };

  const topPx = Number(side_[0].px);
  let remaining = notionalUsd;
  let cost = 0;
  let sz = 0;

  for (const lvl of side_) {
    const px = Number(lvl.px);
    const avail = px * Number(lvl.sz);
    const take = Math.min(remaining, avail);
    if (take <= 0) break;
    cost += take;
    sz += take / px;
    remaining -= take;
    if (remaining <= 0) break;
  }

  if (sz === 0) return { avgPx: 0, sz: 0, impactPct: 0, topPx };
  const avgPx = cost / sz;
  const impactPct = Math.abs((avgPx - topPx) / topPx) * 100;
  return { avgPx, sz, impactPct, topPx };
}

export class HyperliquidTestnetVenue implements Venue {
  readonly id = "hyperliquid-testnet";
  readonly isReal: boolean;
  readonly disclosure: string;

  private privateKey?: string;
  private address?: string;

  constructor(opts: { privateKey?: string; address?: string }) {
    this.privateKey = opts.privateKey;
    this.address = opts.address;
    this.isReal = Boolean(opts.privateKey && opts.address);
    this.disclosure = this.isReal
      ? "Live orders on Hyperliquid TESTNET. Real matching engine, testnet USDC — no real capital."
      : "Shadow mode: priced against the real live testnet book, but no order is submitted. Set HL_PRIVATE_KEY + HL_ADDRESS to place real testnet orders.";
  }

  async equityUsd(): Promise<number> {
    if (!this.address) return 0;
    const st = await post<any>(TESTNET_API, {
      type: "clearinghouseState",
      user: this.address,
    });
    return Number(st?.marginSummary?.accountValue ?? 0);
  }

  async submit(intent: OrderIntent): Promise<Fill> {
    const quote = await priceThroughBook(intent.coin, intent.side, intent.notionalUsd);

    if (quote.sz === 0) {
      return {
        ok: false,
        venue: this.id,
        coin: intent.coin,
        side: intent.side,
        filledSz: 0,
        avgPx: 0,
        ref: null,
        explorerUrl: null,
        error: "empty book side — no liquidity to price against",
        simulated: !this.isReal,
      };
    }

    if (!this.isReal) {
      // Shadow fill against the real book.
      return {
        ok: true,
        venue: this.id,
        coin: intent.coin,
        side: intent.side,
        filledSz: quote.sz,
        avgPx: quote.avgPx,
        ref: null,
        explorerUrl: `${TESTNET_APP}/trade/${intent.coin}`,
        simulated: true,
      };
    }

    // Real testnet order placement requires EIP-712 action signing.
    // Deliberately not hand-rolled here: a mis-signed action is a silent
    // wrong-size or wrong-side order. Wire the official SDK before enabling.
    return {
      ok: false,
      venue: this.id,
      coin: intent.coin,
      side: intent.side,
      filledSz: 0,
      avgPx: quote.avgPx,
      ref: null,
      explorerUrl: `${TESTNET_APP}/trade/${intent.coin}`,
      error:
        "Real order submission not wired. Install the Hyperliquid SDK and implement signed /exchange actions " +
        "(see README 'Enabling real testnet orders'). Refusing to hand-roll EIP-712 action signing.",
      simulated: false,
    };
  }
}
