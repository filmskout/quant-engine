/**
 * x402 v2 buyer for kite-testnet PIEUSD.
 *
 * Self-signed EIP-3009 transferWithAuthorization. This deliberately bypasses
 * the Kite merchant allowlist (`host_not_in_executable_catalog`), which blocks
 * kpass agent:session execute against non-catalogue hosts and has no
 * self-serve route. The payment layer here implements x402 v2 directly; the
 * Pieverse facilitator submits the transaction and pays gas, which is why the
 * buyer needs no native KITE balance.
 *
 * Ported from the implementation proven on 2026-07-15 (first settled tx
 * 0xb18983c1…). The type quirks below are load-bearing — see comments.
 */

export const PIEUSD = "0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A";
export const KITE_CHAIN_ID = 2368;
export const KITE_EXPLORER = "https://testnet.kitescan.ai";

const DOMAIN = {
  name: "pieUSD",
  version: "1",
  chainId: KITE_CHAIN_ID,
  verifyingContract: PIEUSD,
};

const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

export interface AttestationReceipt {
  paid: boolean;
  status: number;
  decisionHash?: string;
  txHash?: string | null;
  explorerUrl?: string | null;
  payer?: string;
  amountWei?: string;
  error?: string;
}

/**
 * ethers is loaded dynamically so the engine still runs (with attestation
 * disabled) in environments where it is not installed.
 */
async function loadEthers(): Promise<any> {
  try {
    return await import("ethers");
  } catch {
    throw new Error(
      "ethers not installed — attestation disabled. " +
        "Install it, or point KITE_ETHERS_PATH at an existing ethers install.",
    );
  }
}

export async function attest(
  url: string,
  decision: Record<string, unknown>,
  privateKey: string,
): Promise<AttestationReceipt> {
  const { ethers } = await loadEthers();
  const wallet = new ethers.Wallet(privateKey);

  const base = {
    method: "POST",
    headers: { "Content-Type": "application/json" } as Record<string, string>,
    body: JSON.stringify(decision),
  };

  // 1) Unpaid request -> expect 402 with terms.
  const r1 = await fetch(url, base);
  if (r1.status !== 402) {
    return {
      paid: false,
      status: r1.status,
      error: `expected 402, got ${r1.status}`,
    };
  }

  const quote: any = await r1.json();
  const terms = quote?.accepts?.[0];
  if (!terms) return { paid: false, status: 402, error: "402 without accepts terms" };

  // 2) Sign EIP-3009.
  const now = Math.floor(Date.now() / 1000);
  // Sign over numeric values...
  const authNum = {
    from: wallet.address,
    to: terms.payTo,
    value: terms.amount,
    validAfter: 0,
    validBefore: now + (terms.maxTimeoutSeconds ?? 300),
    nonce: ethers.hexlify(ethers.randomBytes(32)),
  };
  const signature = await wallet.signTypedData(DOMAIN, TYPES, authNum);

  // ...but x402 v2 requires these as strings in the payload. Sending numbers
  // here makes the facilitator reject the payload despite a valid signature.
  const authorization = {
    ...authNum,
    value: String(authNum.value),
    validAfter: "0",
    validBefore: String(authNum.validBefore),
  };

  // 3) PaymentPayload must echo the chosen terms in `accepted`.
  const paymentPayload = {
    x402Version: 2,
    accepted: terms,
    payload: { signature, authorization },
  };
  const xPayment = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");

  // 4) Retry with payment.
  const r2 = await fetch(url, {
    ...base,
    headers: { ...base.headers, "X-Payment": xPayment },
  });
  const data: any = await r2.json().catch(() => null);

  if (!r2.ok) {
    return {
      paid: false,
      status: r2.status,
      error: data?.error ?? `settlement failed (${r2.status})`,
    };
  }

  return {
    paid: true,
    status: r2.status,
    decisionHash: data?.decisionHash,
    txHash: data?.txHash ?? null,
    explorerUrl: data?.explorerUrl ?? null,
    payer: wallet.address,
    amountWei: terms.amount,
  };
}
