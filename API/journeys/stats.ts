/**
 * API/journeys/stats.ts — pure statistics for journeys and A/B experiments.
 * ──────────────────────────────────────────────────────────────────────────
 * - Duration histograms over JOURNEY_MS_BUCKETS and percentiles read from them
 *   (linear inside a bucket), so daily docs stay small and merge by addition.
 * - probabilityBest: Bayesian beta-binomial, Beta(1,1) prior, Monte Carlo with
 *   a seeded generator (same input → same answer).
 * - Wilson 95% interval, chi-square sample-ratio-mismatch p-value, and the
 *   per-variant sample size for a relative lift (two-sided α, power).
 */

import { JOURNEY_MS_BUCKETS } from "../../schemas/contracts.ts";

// ─── Histograms ─────────────────────────────────────────────────────────────

export const HIST_LEN = JOURNEY_MS_BUCKETS.length + 1; // last bucket is open-ended

export function emptyHist(): number[] {
  return new Array(HIST_LEN).fill(0);
}

export function bucketOf(ms: number): number {
  for (let i = 0; i < JOURNEY_MS_BUCKETS.length; i++) if (ms <= JOURNEY_MS_BUCKETS[i]) return i;
  return JOURNEY_MS_BUCKETS.length;
}

export function histAdd(hist: number[] | undefined, ms: number): number[] {
  const h = hist && hist.length === HIST_LEN ? hist : emptyHist();
  if (Number.isFinite(ms) && ms >= 0) h[bucketOf(ms)]++;
  return h;
}

export function histMerge(a: number[] | undefined, b: number[] | undefined): number[] {
  const out = emptyHist();
  for (let i = 0; i < HIST_LEN; i++) out[i] = (a?.[i] ?? 0) + (b?.[i] ?? 0);
  return out;
}

export const histCount = (h: number[] | undefined): number => (h ?? []).reduce((s, n) => s + (n || 0), 0);

/** q-quantile (0..1) of a histogram, interpolated inside the bucket; null when empty. */
export function histPercentile(h: number[] | undefined, q: number): number | null {
  const total = histCount(h);
  if (!h || !total) return null;
  const target = q * total;
  let cum = 0;
  for (let i = 0; i < HIST_LEN; i++) {
    const n = h[i] || 0;
    if (!n) continue;
    if (cum + n >= target) {
      const lo = i === 0 ? 0 : JOURNEY_MS_BUCKETS[i - 1];
      const hi = i < JOURNEY_MS_BUCKETS.length ? JOURNEY_MS_BUCKETS[i] : lo * 2;
      const frac = Math.min(1, Math.max(0, (target - cum) / n));
      return Math.round(lo + (hi - lo) * frac);
    }
    cum += n;
  }
  return null;
}

/** Exact quantile of raw numbers (tests, small sets). */
export function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

// ─── Random numbers (seeded) ────────────────────────────────────────────────

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng: () => number): number {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** Gamma(shape, 1) sample (Marsaglia–Tsang). */
export function gammaSample(shape: number, rng: () => number): number {
  if (shape < 1) return gammaSample(shape + 1, rng) * Math.pow(rng() || 1e-12, 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do {
      x = gaussian(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function betaSample(a: number, b: number, rng: () => number): number {
  const x = gammaSample(a, rng);
  const y = gammaSample(b, rng);
  return x / (x + y);
}

// ─── Experiment statistics ──────────────────────────────────────────────────

export interface Arm {
  visitors: number;
  conversions: number;
}

/** P(arm has the highest true rate), Beta(1+c, 1+n−c) posteriors, Monte Carlo. Sums to 1. */
export function probabilityBest(arms: Arm[], draws = 20000, seed = 20261028): number[] {
  if (!arms.length) return [];
  const rng = mulberry32(seed);
  const wins = new Array(arms.length).fill(0);
  for (let d = 0; d < draws; d++) {
    let best = -1;
    let bestI = 0;
    for (let i = 0; i < arms.length; i++) {
      const n = Math.max(0, arms[i].visitors);
      const c = Math.min(Math.max(0, arms[i].conversions), n);
      const x = betaSample(1 + c, 1 + n - c, rng);
      if (x > best) {
        best = x;
        bestI = i;
      }
    }
    wins[bestI]++;
  }
  return wins.map((w) => w / draws);
}

/** Wilson score interval for a rate. */
export function wilson(conversions: number, n: number, z = 1.959964): [number, number] {
  if (n <= 0) return [0, 0];
  const p = conversions / n;
  const z2 = z * z;
  const den = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** ln Γ(x), Lanczos approximation. */
export function lnGamma(x: number): number {
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Regularized upper incomplete gamma Q(a, x). */
export function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  if (x < a + 1) {
    // series for P, then Q = 1 − P
    let sum = 1 / a;
    let term = sum;
    for (let n = 1; n < 500; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-14) break;
    }
    return Math.max(0, 1 - sum * Math.exp(-x + a * Math.log(x) - lnGamma(a)));
  }
  // continued fraction (Lentz)
  let b = x + 1 - a;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return Math.min(1, Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h);
}

export function chiSquarePValue(stat: number, df: number): number {
  if (df <= 0) return 1;
  return gammaQ(df / 2, stat / 2);
}

/** Sample ratio mismatch: chi-square goodness of fit of visitors against the weights. */
export function srmPValue(observed: number[], weights: number[]): number {
  const n = observed.reduce((s, x) => s + x, 0);
  const wsum = weights.reduce((s, x) => s + x, 0);
  if (n === 0 || wsum <= 0 || observed.length < 2) return 1;
  let stat = 0;
  for (let i = 0; i < observed.length; i++) {
    const e = (n * weights[i]) / wsum;
    if (e > 0) stat += ((observed[i] - e) ** 2) / e;
  }
  return chiSquarePValue(stat, observed.length - 1);
}

export const SRM_P = 0.01;

/**
 * Visitors per variant to detect a relative lift `mde` over `baseline`
 * (two-sided α = 0.05, power 0.8). A zero baseline is read as 10%.
 */
export function sampleSizePerVariant(baseline: number, mde = 0.2, zAlpha = 1.959964, zBeta = 0.841621): number {
  const p1 = baseline > 0 && baseline < 1 ? baseline : 0.1;
  const p2 = Math.min(0.999, p1 * (1 + mde));
  const pBar = (p1 + p2) / 2;
  const num = zAlpha * Math.sqrt(2 * pBar * (1 - pBar)) + zBeta * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  return Math.ceil((num * num) / ((p2 - p1) ** 2));
}
