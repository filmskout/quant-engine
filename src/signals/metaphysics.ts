/**
 * 玄学对照层 — Metaphysics comparison layer.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * READ THIS BEFORE WIRING ANYTHING HERE INTO A TRADING DECISION.
 *
 * BaZi (八字), Zi Wei Dou Shu (紫微斗数) and MBTI have no demonstrated
 * predictive power over financial markets. Nothing in this module is
 * permitted to influence the composite score in mentis-method.ts, and the
 * engine never passes these values to the risk gates or the venue.
 *
 * It exists for two legitimate reasons:
 *   1. It is a culturally familiar, visually rich layer for the UI.
 *   2. Run side by side with the real signal, it becomes an honest
 *      demonstration: `agreementRate()` measures how often the two agree.
 *      Over a large sample that number should sit near 50% — i.e. a coin
 *      flip. Showing that is more educational than hiding it.
 *
 * The calendar maths, by contrast, IS real. The sexagenary (干支) cycle is
 * deterministic arithmetic, so the pillars below are correctly computed
 * rather than invented. Simplifications are noted inline.
 * ─────────────────────────────────────────────────────────────────────────
 */

export const HEAVENLY_STEMS = ["甲","乙","丙","丁","戊","己","庚","辛","壬","癸"] as const;
export const EARTHLY_BRANCHES = ["子","丑","寅","卯","辰","巳","午","未","申","酉","戌","亥"] as const;

export type Element = "wood" | "fire" | "earth" | "metal" | "water";

export const ELEMENT_ZH: Record<Element, string> = {
  wood: "木", fire: "火", earth: "土", metal: "金", water: "水",
};

/** 天干五行 — two stems per element, yang then yin. */
const STEM_ELEMENT: Element[] = [
  "wood","wood","fire","fire","earth","earth","metal","metal","water","water",
];

/** 地支五行 */
const BRANCH_ELEMENT: Element[] = [
  "water","earth","wood","wood","earth","fire",
  "fire","earth","metal","metal","earth","water",
];

export interface Pillar {
  stem: string;
  branch: string;
  stemElement: Element;
  branchElement: Element;
  index: number;
}

/**
 * Julian Day Number at noon UTC for a Gregorian date.
 * Standard Fliegel–Van Flandern algorithm.
 */
export function julianDayNumber(y: number, m: number, d: number): number {
  const a = Math.floor((14 - m) / 12);
  const yy = y + 4800 - a;
  const mm = m + 12 * a - 3;
  return (
    d + Math.floor((153 * mm + 2) / 5) + 365 * yy +
    Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045
  );
}

function pillarFromIndex(i: number): Pillar {
  const idx = ((i % 60) + 60) % 60;
  return {
    stem: HEAVENLY_STEMS[idx % 10],
    branch: EARTHLY_BRANCHES[idx % 12],
    stemElement: STEM_ELEMENT[idx % 10],
    branchElement: BRANCH_ELEMENT[idx % 12],
    index: idx,
  };
}

export interface BaZi {
  year: Pillar;
  month: Pillar;
  day: Pillar;
  hour: Pillar;
  /** Count of each element across all eight characters. */
  elements: Record<Element, number>;
  dominant: Element;
  weakest: Element;
  /** 时辰 name, e.g. 子时. */
  shichen: string;
}

const SHICHEN = ["子","丑","寅","卯","辰","巳","午","未","申","酉","戌","亥"];

/**
 * Compute the four pillars for an instant.
 *
 * Simplifications (documented rather than hidden):
 *  - Year boundary uses Feb 4 as a fixed proxy for 立春; the true boundary
 *    shifts by up to a day year to year.
 *  - Month pillar uses fixed month boundaries rather than the 24 solar terms.
 *  - Local time is treated as China Standard Time (UTC+8), the convention
 *    for 八字.
 * Day and hour pillars are exact.
 */
export function computeBaZi(at: Date = new Date()): BaZi {
  // shift to UTC+8
  const cst = new Date(at.getTime() + 8 * 3600 * 1000);
  const Y = cst.getUTCFullYear();
  const M = cst.getUTCMonth() + 1;
  const D = cst.getUTCDate();
  const h = cst.getUTCHours();

  // 年柱 — sexagenary year, rolled back before 立春 (Feb 4 proxy)
  const solarYear = M < 2 || (M === 2 && D < 4) ? Y - 1 : Y;
  const year = pillarFromIndex(solarYear - 4);

  // 月柱 — month branch starts at 寅 for the first solar month.
  // Stem follows the 五虎遁 rule from the year stem.
  const monthBranchIdx = (M + 1) % 12;
  const monthStemIdx = ((year.index % 10) % 5) * 2 + Math.floor((M + 1) / 1) % 10;
  const month = pillarFromIndex(
    ((monthStemIdx % 10) + 60 - ((monthStemIdx % 10) - monthBranchIdx + 60) % 12 * 0) % 60,
  );
  // The line above keeps stem/branch consistent; recompose explicitly so the
  // pair is always a valid 干支 combination.
  const monthFixed: Pillar = {
    stem: HEAVENLY_STEMS[((year.index % 10) * 2 + M + 1) % 10],
    branch: EARTHLY_BRANCHES[monthBranchIdx],
    stemElement: STEM_ELEMENT[((year.index % 10) * 2 + M + 1) % 10],
    branchElement: BRANCH_ELEMENT[monthBranchIdx],
    index: month.index,
  };

  // 日柱 — exact. Anchor verified: 2000-01-01 -> 戊午.
  const jdn = julianDayNumber(Y, M, D);
  const day = pillarFromIndex(jdn + 49);

  // 时柱 — 2-hour 时辰; 23:00 rolls into the next 子时.
  const shichenIdx = Math.floor(((h + 1) % 24) / 2);
  const hourStemIdx = ((day.index % 10) % 5) * 2 + shichenIdx;
  const hour: Pillar = {
    stem: HEAVENLY_STEMS[hourStemIdx % 10],
    branch: EARTHLY_BRANCHES[shichenIdx],
    stemElement: STEM_ELEMENT[hourStemIdx % 10],
    branchElement: BRANCH_ELEMENT[shichenIdx],
    index: (hourStemIdx % 10) * 6 + shichenIdx,
  };

  const elements: Record<Element, number> = {
    wood: 0, fire: 0, earth: 0, metal: 0, water: 0,
  };
  for (const p of [year, monthFixed, day, hour]) {
    elements[p.stemElement] += 1;
    elements[p.branchElement] += 1;
  }
  const sorted = (Object.keys(elements) as Element[]).sort(
    (a, b) => elements[b] - elements[a],
  );

  return {
    year, month: monthFixed, day, hour,
    elements,
    dominant: sorted[0],
    weakest: sorted[sorted.length - 1],
    shichen: SHICHEN[shichenIdx] + "时",
  };
}

// ── 紫微斗数 (simplified 命宫 placement) ────────────────────────────────

export const ZIWEI_PALACES = [
  "命宫","兄弟","夫妻","子女","财帛","疾厄",
  "迁移","交友","官禄","田宅","福德","父母",
] as const;

export const ZIWEI_STARS = [
  "紫微","天机","太阳","武曲","天同","廉贞",
  "天府","太阴","贪狼","巨门","天相","天梁","七杀","破军",
] as const;

export interface ZiWei {
  palace: string;
  star: string;
  /** Which palace the wealth axis (财帛) lands relative to 命宫. */
  wealthPalace: string;
  brightness: "庙" | "旺" | "平" | "陷";
}

export function computeZiWei(bazi: BaZi): ZiWei {
  const branchIdx = EARTHLY_BRANCHES.indexOf(bazi.hour.branch as any);
  const monthIdx = EARTHLY_BRANCHES.indexOf(bazi.month.branch as any);
  const lifeIdx = ((monthIdx - branchIdx) % 12 + 12) % 12;
  const starIdx = (bazi.day.index + lifeIdx) % ZIWEI_STARS.length;
  const bright = ["庙","旺","平","陷"] as const;
  return {
    palace: ZIWEI_PALACES[lifeIdx],
    star: ZIWEI_STARS[starIdx],
    wealthPalace: ZIWEI_PALACES[(lifeIdx + 4) % 12],
    brightness: bright[(bazi.day.index + monthIdx) % 4],
  };
}

// ── MBTI trader profile ────────────────────────────────────────────────

export type MBTI = string;

export interface MbtiProfile {
  type: MBTI;
  /** Risk appetite 0..1 — from the T/F and J/P axes. */
  riskAppetite: number;
  /** Preference for trend following vs mean reversion, -1..+1. */
  trendBias: number;
  label: string;
}

/**
 * Maps an MBTI code to trading-style parameters. This is a *persona* setting,
 * not a market prediction — it describes the configured operator, not the
 * asset. It is surfaced so users can see how a stated risk appetite would
 * have reshaped position sizing, which is a real and useful comparison.
 */
export function mbtiProfile(type: string): MbtiProfile {
  const t = (type || "INTJ").toUpperCase().slice(0, 4);
  const has = (c: string) => t.includes(c);
  const riskAppetite =
    (has("E") ? 0.28 : 0.12) +
    (has("N") ? 0.22 : 0.14) +
    (has("T") ? 0.24 : 0.12) +
    (has("P") ? 0.26 : 0.14);
  const trendBias = (has("S") ? 0.4 : -0.3) + (has("J") ? 0.25 : -0.2);
  return {
    type: t,
    riskAppetite: Math.max(0, Math.min(1, riskAppetite)),
    trendBias: Math.max(-1, Math.min(1, trendBias)),
    label:
      (has("E") ? "外向" : "内向") +
      (has("N") ? "直觉" : "实感") +
      (has("T") ? "思考" : "情感") +
      (has("J") ? "判断" : "感知"),
  };
}

// ── the comparison signal ──────────────────────────────────────────────

export interface MetaphysicsReading {
  bazi: BaZi;
  ziwei: ZiWei;
  mbti: MbtiProfile;
  /** -1..+1. Entertainment only. Never reaches the composite. */
  omenScore: number;
  direction: "long" | "short" | "flat";
  narrative: string;
}

/** Element affinity per asset, by first letter — arbitrary by construction. */
function assetElement(coin: string): Element {
  const order: Element[] = ["wood","fire","earth","metal","water"];
  let h = 0;
  for (const ch of coin) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return order[h % 5];
}

/** 五行生克 — generating cycle scores +, overcoming cycle scores −. */
const GENERATES: Record<Element, Element> = {
  wood: "fire", fire: "earth", earth: "metal", metal: "water", water: "wood",
};
const OVERCOMES: Record<Element, Element> = {
  wood: "earth", earth: "water", water: "fire", fire: "metal", metal: "wood",
};

export function readOmen(coin: string, at: Date, mbtiType = "INTJ"): MetaphysicsReading {
  const bazi = computeBaZi(at);
  const ziwei = computeZiWei(bazi);
  const mbti = mbtiProfile(mbtiType);
  const ae = assetElement(coin);

  let s = 0;
  if (GENERATES[bazi.dominant] === ae) s += 0.5;
  if (GENERATES[ae] === bazi.dominant) s += 0.25;
  if (OVERCOMES[bazi.dominant] === ae) s -= 0.5;
  if (OVERCOMES[ae] === bazi.dominant) s -= 0.25;
  s += ({ 庙: 0.25, 旺: 0.12, 平: 0, 陷: -0.25 } as const)[ziwei.brightness];
  s += mbti.trendBias * 0.15;

  const omenScore = Math.max(-1, Math.min(1, s));
  const direction = omenScore > 0.15 ? "long" : omenScore < -0.15 ? "short" : "flat";

  return {
    bazi, ziwei, mbti, omenScore, direction,
    narrative:
      `${bazi.day.stem}${bazi.day.branch}日 · ${bazi.shichen}，` +
      `四柱${ELEMENT_ZH[bazi.dominant]}旺${ELEMENT_ZH[bazi.weakest]}弱；` +
      `${coin} 属${ELEMENT_ZH[ae]}，与日主${
        GENERATES[bazi.dominant] === ae ? "相生" :
        OVERCOMES[bazi.dominant] === ae ? "相克" : "无明显生克"
      }。紫微${ziwei.star}坐${ziwei.palace}（${ziwei.brightness}），财帛在${ziwei.wealthPalace}。`,
  };
}

// ── divergence tracking ────────────────────────────────────────────────

export interface AgreementStat {
  samples: number;
  agreements: number;
  rate: number;
  /**
   * Distinct 时辰 buckets covered. Samples inside one 时辰 share the entire
   * time component of the omen, so they are NOT independent. This is the
   * honest denominator to reason about, and the UI shows it next to `samples`.
   */
  shichenCovered?: number;
  /** Wilson 95% interval on the rate — meaningful only if samples are independent. */
  ci95?: [number, number];
}

const tally = new Map<string, { n: number; hit: number }>();
const shichenSeen = new Set<string>();

/** Wilson score interval — better than normal approximation at small n. */
function wilson(hit: number, n: number): [number, number] {
  if (!n) return [0, 0];
  const z = 1.96, p = hit / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - s) / d), Math.min(1, (c + s) / d)];
}

/** Snapshot for persistence across restarts. */
export function exportTally() {
  return {
    tally: Object.fromEntries(tally),
    shichen: [...shichenSeen],
  };
}

export function importTally(snap: unknown) {
  const s = snap as { tally?: Record<string, { n: number; hit: number }>; shichen?: string[] };
  if (!s?.tally) return;
  for (const [k, v] of Object.entries(s.tally)) {
    if (typeof v?.n === "number" && typeof v?.hit === "number") tally.set(k, { ...v });
  }
  (s.shichen ?? []).forEach((x) => shichenSeen.add(x));
}

/**
 * Record whether the omen direction matched the quant direction for a symbol.
 * This is the honest payoff of the whole layer: watch the rate converge to
 * ~50% and you have demonstrated, with live data, that the omen carries no
 * information the quant signal does not already have.
 */
export function recordAgreement(
  coin: string,
  quantDir: string,
  omenDir: string,
  shichen?: string,
) {
  const hit = quantDir === omenDir ? 1 : 0;
  for (const k of ["ALL", `C:${coin}`]) {
    const cur = tally.get(k) ?? { n: 0, hit: 0 };
    cur.n += 1;
    cur.hit += hit;
    tally.set(k, cur);
  }
  if (shichen) shichenSeen.add(shichen);
}

export function agreementRate(coin?: string): AgreementStat {
  const k = coin ? `C:${coin}` : "ALL";
  const t = tally.get(k) ?? { n: 0, hit: 0 };
  return {
    samples: t.n,
    agreements: t.hit,
    rate: t.n ? t.hit / t.n : 0,
    shichenCovered: shichenSeen.size,
    ci95: wilson(t.hit, t.n),
  };
}
