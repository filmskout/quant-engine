/**
 * Risk guards. These fail CLOSED: any check that cannot be evaluated blocks
 * the order rather than waving it through.
 */

import type { Limits } from "../config.js";
import type { OrderIntent } from "./types.js";

export interface GuardState {
  ordersToday: number;
  openExposureUsd: number;
  startEquityUsd: number;
  currentEquityUsd: number;
  halted: boolean;
  haltReason?: string;
}

export interface GuardVerdict {
  allowed: boolean;
  reasons: string[];
  /** Possibly reduced notional. Never larger than requested. */
  adjustedNotionalUsd: number;
}

export function evaluateGuards(
  intent: OrderIntent,
  state: GuardState,
  limits: Limits,
  ctx: { gasGwei?: number; priceImpactPct?: number },
): GuardVerdict {
  const reasons: string[] = [];
  let notional = intent.notionalUsd;

  if (state.halted) {
    return {
      allowed: false,
      reasons: [`engine halted: ${state.haltReason ?? "unknown"}`],
      adjustedNotionalUsd: 0,
    };
  }

  // Kill switch on realised drawdown.
  if (state.startEquityUsd > 0) {
    const dd =
      ((state.startEquityUsd - state.currentEquityUsd) / state.startEquityUsd) * 100;
    if (dd >= limits.killSwitchDrawdownPct) {
      return {
        allowed: false,
        reasons: [
          `kill switch: drawdown ${dd.toFixed(2)}% >= ${limits.killSwitchDrawdownPct}%`,
        ],
        adjustedNotionalUsd: 0,
      };
    }
  }

  if (state.ordersToday >= limits.maxDailyOrders) {
    reasons.push(`daily order cap reached (${limits.maxDailyOrders})`);
  }

  if (notional > limits.maxOrderNotional) {
    reasons.push(
      `notional $${notional.toFixed(2)} capped to $${limits.maxOrderNotional}`,
    );
    notional = limits.maxOrderNotional;
  }

  const projected = state.openExposureUsd + notional;
  if (projected > limits.maxTotalExposure) {
    const room = Math.max(0, limits.maxTotalExposure - state.openExposureUsd);
    reasons.push(
      `total exposure would hit $${projected.toFixed(2)} > $${limits.maxTotalExposure}; room $${room.toFixed(2)}`,
    );
    notional = Math.min(notional, room);
  }

  // Fail closed on unknown gas / impact when the venue is expected to report them.
  if (ctx.gasGwei !== undefined && ctx.gasGwei > limits.maxGasGwei) {
    reasons.push(`gas ${ctx.gasGwei} gwei > ${limits.maxGasGwei}`);
    notional = 0;
  }
  if (
    ctx.priceImpactPct !== undefined &&
    ctx.priceImpactPct > limits.maxPriceImpactPct
  ) {
    reasons.push(
      `price impact ${ctx.priceImpactPct.toFixed(3)}% > ${limits.maxPriceImpactPct}%`,
    );
    notional = 0;
  }

  if (notional <= 0) {
    return { allowed: false, reasons, adjustedNotionalUsd: 0 };
  }
  if (state.ordersToday >= limits.maxDailyOrders) {
    return { allowed: false, reasons, adjustedNotionalUsd: 0 };
  }

  return { allowed: true, reasons, adjustedNotionalUsd: notional };
}
