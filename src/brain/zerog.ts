/**
 * 0G Compute client — verifiable TEE inference.
 *
 * Every call sets verify_tee and surfaces the returned proof reference, so a
 * trading decision can be audited after the fact: you can show *which* model
 * produced *which* recommendation, attested inside a TEE.
 *
 * Known limitation (as of 2026-07-15 smoke test): 0G has no standalone public
 * verification endpoint yet. The proofRef comes from the `ZG-Res-Key` response
 * header, falling back to the response id. Treat it as a reference to paste
 * into the pc.0g.ai verifier when that ships — not as a verified proof today.
 * We label it accordingly in the UI rather than overclaiming.
 */

export interface Recommendation {
  action: "open_long" | "open_short" | "close" | "hold";
  sizePct: number;
  confidence: number;
  reasoning: string;
  invalidation: string;
}

export interface BrainResult {
  rec: Recommendation;
  proofRef: string | null;
  teeVerified: boolean;
  model: string;
  raw: unknown;
}

const SYSTEM_PROMPT = `You are a disciplined crypto derivatives risk analyst.

You receive a quantitative signal breakdown produced by a composite scoring
model. Your job is NOT to re-derive the signal — it is to sanity-check it
against the market context and decide whether it is actionable.

Rules you must follow:
- If the composite score magnitude is below the caller's minConviction value
  (supplied in the payload; assume 0.15 if absent), the answer is "hold". Do
  not manufacture conviction that the numbers do not support.
- If risk penalty exceeds 0.5, either "hold" or size below 25%.
- If book depth within 1% is under $250k, cap sizePct at 10% regardless of score.
- sizePct is a percentage of the configured max order notional, 0-100.
- Always state a concrete invalidation level or condition.
- Never claim certainty. Never reference guaranteed returns.

Respond with strict JSON only, no markdown fence:
{"action":"open_long|open_short|close|hold","sizePct":0-100,"confidence":0-1,"reasoning":"...","invalidation":"..."}`;

export interface ZeroGOpts {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs?: number;
  retries?: number;
}

export async function askBrain(
  payload: Record<string, unknown>,
  opts: ZeroGOpts,
): Promise<BrainResult> {
  if (!opts.apiKey) {
    throw new Error(
      "ZG_API_KEY not set. Get one at https://pc.0g.ai (connect wallet -> deposit -> API Keys). " +
        "Run with BRAIN=off to use the raw composite score without LLM review.",
    );
  }

  const body = {
    model: opts.model,
    verify_tee: true,
    temperature: 0.2,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(payload) },
    ],
  };

  const retries = opts.retries ?? 2;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 45_000);

      const res = await fetch(`${opts.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ctl.signal,
      }).finally(() => clearTimeout(timer));

      if (res.status === 429 || res.status >= 500) {
        throw new Error(`0G ${res.status}: ${await res.text()}`);
      }
      if (!res.ok) {
        // 4xx other than 429 will not be fixed by retrying.
        return Promise.reject(new Error(`0G ${res.status}: ${await res.text()}`));
      }

      const proofRef = res.headers.get("ZG-Res-Key");
      const json: any = await res.json();
      const content: string = json?.choices?.[0]?.message?.content ?? "";

      return {
        rec: parseRecommendation(content),
        proofRef: proofRef ?? json?.id ?? null,
        teeVerified: Boolean(json?.tee_verified ?? proofRef),
        model: json?.model ?? opts.model,
        raw: json,
      };
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

/**
 * Models that emit a <think> block (minimax-m3, some deepseek variants) prepend
 * reasoning before the JSON. Strip it, then take the outermost JSON object.
 */
export function parseRecommendation(content: string): Recommendation {
  let s = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`brain returned no JSON object: ${content.slice(0, 200)}`);
  }

  const obj = JSON.parse(s.slice(start, end + 1));
  const action = obj.action;
  if (!["open_long", "open_short", "close", "hold"].includes(action)) {
    throw new Error(`brain returned invalid action: ${action}`);
  }

  return {
    action,
    sizePct: Math.max(0, Math.min(100, Number(obj.sizePct ?? 0))),
    confidence: Math.max(0, Math.min(1, Number(obj.confidence ?? 0))),
    reasoning: String(obj.reasoning ?? "").slice(0, 2000),
    invalidation: String(obj.invalidation ?? "").slice(0, 500),
  };
}

/**
 * Deterministic fallback when no LLM is available. Mirrors the system prompt's
 * hard rules so that BRAIN=off degrades to something defensible rather than
 * silently trading on an unreviewed score.
 */
export function ruleBasedFallback(
  composite: number,
  riskPenalty: number,
  depth1pctUsd: number,
  minConviction = 0.15,
): Recommendation {
  if (Math.abs(composite) < minConviction) {
    return {
      action: "hold",
      sizePct: 0,
      confidence: Math.abs(composite),
      reasoning: `Composite score below the ${minConviction} conviction threshold.`,
      invalidation: `Re-evaluate when |composite| exceeds ${minConviction}.`,
    };
  }

  let sizePct = Math.min(100, Math.abs(composite) * 100);
  if (riskPenalty > 0.5) sizePct = Math.min(sizePct, 25);
  if (depth1pctUsd < 250_000) sizePct = Math.min(sizePct, 10);

  return {
    action: composite > 0 ? "open_long" : "open_short",
    sizePct,
    confidence: Math.abs(composite),
    reasoning:
      `Rule-based fallback (no LLM). composite=${composite.toFixed(3)}, ` +
      `riskPenalty=${riskPenalty.toFixed(2)}, depth1pct=$${Math.round(depth1pctUsd).toLocaleString()}.`,
    invalidation: "Exit if composite flips sign or risk penalty exceeds 0.7.",
  };
}
