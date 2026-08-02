export interface OrderIntent {
  coin: string;
  side: "buy" | "sell";
  /** Notional in USD. */
  notionalUsd: number;
  /** Limit price. Market orders use an aggressive limit with slippage bound. */
  price: number;
  reduceOnly?: boolean;
}

export interface Fill {
  ok: boolean;
  venue: string;
  coin: string;
  side: "buy" | "sell";
  filledSz: number;
  avgPx: number;
  /** Venue order id or tx hash. */
  ref: string | null;
  /** Block explorer / venue URL for the human to click through and verify. */
  explorerUrl: string | null;
  error?: string;
  simulated: boolean;
}

export interface Venue {
  readonly id: string;
  readonly isReal: boolean;
  /** Human-readable note shown in the UI so nobody mistakes sim for real. */
  readonly disclosure: string;
  submit(intent: OrderIntent): Promise<Fill>;
  equityUsd(): Promise<number>;
}
