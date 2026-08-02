# Quant Engine

Real market signal → verifiable AI review → risk-guarded execution.

```
Hyperliquid mainnet (public API)   real prices, funding, OI, L2 book depth
        ↓
Mentis-method composite score      30% smart-money / 25% technical
                                   25% flow / 20% sentiment / −20% risk
        ↓
0G Compute (TEE inference)         recommendation + proofRef
        ↓
Risk guards                        notional / exposure / impact / kill switch
        ↓
Hyperliquid testnet                real matching engine, testnet USDC
```

## Run

```bash
npm i                        # only dep is ethers (attestation leg)
npx tsc -p tsconfig.json

node attestation/server.mjs  # x402 merchant, :8771 — keep internal, holds a key
node dist/server.js          # engine + dashboard, :8770

node scripts/verify-execution.mjs   # 13 end-to-end checks
```

Config via `.env.example` → `.env`. Without `ZG_API_KEY` the engine falls back
to deterministic rules; without `ATTEST_URL` + `KITE_BUYER_KEY` it skips
attestation. Both degrade visibly rather than silently.

### Compute-on-request

There is no background tick. A scan runs when `/api/state` is requested and is
cached for `CACHE_TTL_MS` (default 45s); concurrent requests share one in-flight
sweep instead of stacking. Measured: 5.6s cold, 22ms cached, and three parallel
`?fresh=1` requests produce exactly one scan.

This runs unchanged on a plain box and on request-scoped serverless, where a
`setInterval` would never fire.

| Endpoint | |
|---|---|
| `GET /api/state` | decisions (`?fresh=1` bypasses cache) |
| `GET /api/attestations` | settled on-chain records |
| `POST /api/scan` | force a scan |
| `GET /api/health` | liveness |

No install needed to typecheck if a sibling project already has TypeScript:

```bash
/path/to/signal-duel/node_modules/.bin/tsc -p tsconfig.json
```

## What is actually real

| Layer | Real? | Notes |
|---|---|---|
| Prices, funding, OI, book depth | **Yes** | Hyperliquid mainnet public info API |
| Technical indicators | **Yes** | Computed from 120 real 1h candles |
| Composite scoring | **Yes** | Deterministic, auditable |
| LLM recommendation | **Yes** with `ZG_API_KEY` | Otherwise deterministic rule fallback |
| Order matching | **Yes** | Hyperliquid testnet, real book |
| Money at risk | **No** | Testnet USDC |
| Smart-money dimension | **No** | Zero-weight placeholder — see below |

### Signals come from mainnet, orders go to testnet

Deliberate. Testnet books are too thin to produce meaningful signal, so scoring
reads mainnet while execution routes to testnet. The dashboard states this.

### The smart-money dimension is a placeholder

The 30% smart-money weight currently contributes **zero**, because honest
smart-money tracking needs a labelled wallet set. Mentis sells exactly that, and
their private `/api/v1/...` routes are undocumented, robots.txt-disallowed, and
explicitly "not a public contract" — so this repo implements their **published
weighting methodology** and does not touch their endpoints.

To activate the dimension, wire a licensed feed into
`buildSmartMoneyPlaceholder()` in `src/signals/sources.ts`. Options:

- Nansen via Kite x402 (~$0.01/call) — needs the Kite merchant allowlist cleared
- A direct Mentis licence — contact@gmentis.ai
- Your own wallet labelling over public chain data

Returning zero is the correct default: a fabricated smart-money score would
inject noise into 30% of every decision while looking authoritative.

## Why live trading is gated

`LIVE_TRADING` must equal the exact string `I_UNDERSTAND_THE_RISK`. A truthy
value like `1` or `true` will not arm it. This is so a copied `.env` or a stray
export cannot move real funds.

Even when armed, every order passes `evaluateGuards()`, which **fails closed**:

- per-order notional cap (default $50)
- total exposure cap (default $250)
- daily order count cap (default 20)
- price-impact abort (default 0.5%)
- gas ceiling (default 100 gwei)
- kill switch on 10% realised drawdown

## Enabling real testnet orders

Shadow mode prices against the real book but submits nothing. Real submission
needs EIP-712 action signing, which `src/execution/hyperliquid.ts` deliberately
does **not** hand-roll — a mis-signed action is a silent wrong-size or
wrong-side order. To enable:

1. Fund a testnet wallet at https://app.hyperliquid-testnet.xyz
2. `npm i @nktkas/hyperliquid` (or the official SDK)
3. Implement `submit()` using the SDK's signed `/exchange` action
4. Set `HL_ADDRESS` + `HL_PRIVATE_KEY`

## Venue evaluation (2026-08-02)

Chains assessed for real execution, with what was actually measured:

| Chain | Finding |
|---|---|
| **BotChain** | RPC live (chain 677), real UniV2 router at `0x5b90611d…41ad`, real swaps. **But** BOT is priced only by its own explorer at $9.82 — not on CoinGecko, not on any exchange, chain 677 absent from CoinGecko asset platforms. PnL would be unrealisable. Rejected. |
| **Kite** | Testnet live (chain 2368). x402 payment rail — structurally has no swap primitive. Usable for paying for data, not for trading. |
| **0G** | Inference/compute only. No trading surface. Used as the brain. |
| **Monad** | Mainnet live since 2025-11, ~$408M TVL across all protocols. Thin for quant; no local integration. Not pursued. |
| **Hyperliquid testnet** | Real matching engine, real book, free testnet USDC. **Selected.** |

The BotChain router and factory addresses above were recovered by decoding a
live `swapExactTokensForETH` transaction — the addresses in the integration
docs were placeholders (`0xBigAppleMVCollection` is not a valid address).

## Not financial advice

Simulated and testnet results do not predict live performance. The composite
score is a research tool, not a strategy. There is no backtest in this repo yet.
