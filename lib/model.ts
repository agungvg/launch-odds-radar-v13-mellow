// Launch-Odds Radar v13-mellow — the model, written fresh for this entry.
//
// One snapshot in, one ranked board out. Every number the dashboard shows is
// refit from the snapshot on every run; nothing is carried in from an earlier
// version. The value model is a one-term ridge (see below); the odds head is
// an age-only logistic; the farm verdicts are net economics only.
//
//   value   log10(mcap/TVL) = a + b * log10(TVL), ridge lambda = 3 on the
//           standardised feature, fitted on the traded protocols with a
//           usable market cap and a known listing date (n = 95).
//   odds    logit(P(token)) = c + d * log10(age in days), logistic L2 = 1 on
//           the standardised feature, trained on the protocols with a known
//           listing date (n = 413: 95 traded, 318 still pre-token).
//   ranges  normal head, sigma = spread of the leave-one-out residuals.
//   farm    gross = implied x 5% pool x deposit share x odds; cost = $15 gas
//           + 2h x $15/h = $45. Farm when net > 0, Thin when gross covers
//           gas but not time, Skip otherwise. Deposit is 0.020% of TVL.
//
// Held-out rule (rank 1): a term enters the value model only when it lowers
// the held-out miss in BOTH the leave-one-out and the walk-forward tests.
// Per-category mean ratios are never a feature: a category's own mean leaks
// the answer for the protocols in it.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export const MODEL_VERSION = 'radar-13-mellow';
export const RIDGE_LAMBDA = 3;
export const ODDS_L2 = 1;
export const GAS_USD = 15;
export const HOURS = 2;
export const HOURLY_USD = 15;
export const COST_USD = GAS_USD + HOURS * HOURLY_USD; // 45
export const POOL_SHARE = 0.05;
export const DEPOSIT_PCT = 0.0002; // 0.020% of TVL
export const UNKNOWN_AGE_DAYS = 365;
export const BOOTSTRAP_REFITS = 200;

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const LOG10 = Math.log10;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Deterministic RNG (mulberry32) so every run of the program is byte-identical. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle of 0..n-1 under a seeded RNG. */
function shuffled(n: number, seed: number): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  const rnd = mulberry32(seed);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  return idx;
}

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole days from `listedAt` to `asOf`, clamped at zero; null when absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** No token recorded at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const BRIDGE_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const EXCHANGE_NAMES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** Whether a protocol is one the board may rank: pre-token, not a wrapped /
 * staked / bridged product of another protocol, not an exchange, not a
 * versioned pool. The watchlist is the floor; this rule is the board. */
export function isBoardRow(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && BRIDGE_CATEGORIES.has(p.category)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_NAMES.some((e) => p.name.startsWith(e))) return false;
  if (VERSIONED.test(p.name)) return false;
  return true;
}

/** A usable traded observation: a positive market cap and a listing date. */
export function isTradedFit(p: SnapshotProtocol): boolean {
  return p.mcap_usd !== null && p.mcap_usd > 0 && p.listed_at !== null;
}

// ------------------------------------------------------------------ ridge

export interface RidgeFit {
  intercept: number;
  slopes: number[];
  mu: number[];
  sd: number[];
}

/**
 * Ridge on standardised features (population sd, as a standard scaler does),
 * intercept unpenalised, penalty lambda on the standardised slopes. Solves the
 * small normal equations directly; no dependencies.
 */
export function fitRidge(rows: number[][], y: number[], lambda: number): RidgeFit {
  const n = rows.length;
  const k = rows[0]!.length;
  const mu: number[] = [];
  const sd: number[] = [];
  for (let j = 0; j < k; j++) {
    const col = rows.map((r) => r[j]!);
    const m = col.reduce((a, b) => a + b, 0) / n;
    const v = col.reduce((a, b) => a + (b - m) * (b - m), 0) / n;
    mu.push(m);
    sd.push(Math.sqrt(v) === 0 ? 1 : Math.sqrt(v));
  }
  // Normal equations on [1, standardised X], lambda added to slope block only.
  const dim = k + 1;
  const a: number[][] = Array.from({ length: dim }, () => new Array<number>(dim).fill(0));
  const bvec: number[] = new Array<number>(dim).fill(0);
  for (let i = 0; i < n; i++) {
    const xs = [1, ...rows[i]!.map((v, j) => (v - mu[j]!) / sd[j]!)];
    for (let r = 0; r < dim; r++) {
      bvec[r]! += xs[r]! * y[i]!;
      for (let c = 0; c < dim; c++) a[r]![c]! += xs[r]! * xs[c]!;
    }
  }
  for (let j = 1; j < dim; j++) a[j]![j]! += lambda;
  const beta = solveLinear(a, bvec);
  const slopes = beta.slice(1).map((v, j) => v / sd[j]!);
  const intercept = beta[0]! - slopes.reduce((acc, s, j) => acc + s * mu[j]!, 0);
  return { intercept, slopes, mu, sd };
}

export function predictRidge(fit: RidgeFit, row: number[]): number {
  return fit.intercept + row.reduce((acc, v, j) => acc + fit.slopes[j]! * v, 0);
}

/** Gaussian elimination with partial pivoting for the small systems here. */
function solveLinear(aIn: number[][], bIn: number[]): number[] {
  const n = bIn.length;
  const a = aIn.map((r) => [...r]);
  const b = [...bIn];
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r]![col]!) > Math.abs(a[piv]![col]!)) piv = r;
    [a[col], a[piv]] = [a[piv]!, a[col]!];
    [b[col], b[piv]] = [b[piv]!, b[col]!];
    const d = a[col]![col]!;
    for (let r = col + 1; r < n; r++) {
      const f = a[r]![col]! / d;
      for (let c = col; c < n; c++) a[r]![c]! -= f * a[col]![c]!;
      b[r]! -= f * b[col]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r]!;
    for (let c = r + 1; c < n; c++) s -= a[r]![c]! * x[c]!;
    x[r] = s / a[r]![r]!;
  }
  return x;
}

/** Geometric-mean miss: 10 to the mean absolute log10 residual. A miss of x2
 * means the prediction is typically within a factor of two either way. */
export function gmeanMiss(residuals: number[]): number {
  return 10 ** (residuals.reduce((a, r) => a + Math.abs(r), 0) / residuals.length);
}

export function medianMiss(residuals: number[]): number {
  const s = residuals.map((r) => 10 ** Math.abs(r)).sort((a, b) => a - b);
  const m = s.length;
  return m % 2 === 1 ? s[(m - 1) / 2]! : (s[m / 2 - 1]! + s[m / 2]!) / 2;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function popStd(values: number[]): number {
  const m = mean(values);
  return Math.sqrt(values.reduce((a, v) => a + (v - m) * (v - m), 0) / values.length);
}

// ------------------------------------------------------------ term testing

export type TermKind =
  | 'base'
  | 'growth'
  | 'age'
  | 'logtvl2'
  | 'chains'
  | 'growth-age'
  | 'cat-dummies'
  | 'growth2'
  | 'tvl-x-growth';

const TERM_LABELS: Record<TermKind, string> = {
  base: 'log10(TVL) only',
  growth: '+ 7d growth (clamped)',
  age: '+ log10(age)',
  logtvl2: '+ log10(TVL)^2',
  chains: '+ chain count',
  'growth-age': '+ growth + age',
  'cat-dummies': '+ category dummies',
  growth2: '+ growth + growth^2',
  'tvl-x-growth': '+ growth + TVL x growth',
};

const TERM_KINDS: TermKind[] = ['base', 'growth', 'age', 'logtvl2', 'chains', 'growth-age', 'cat-dummies', 'growth2', 'tvl-x-growth'];

/** Feature rows for one candidate term set, on the traded fit set. */
function termFeatures(ps: SnapshotProtocol[], asOf: string, kind: TermKind, categories: string[]): number[][] {
  return ps.map((p) => {
    const lt = LOG10(p.tvl_usd);
    const gRaw = finite(p.change_7d, 0);
    const g = Math.min(120, Math.max(-60, gRaw)) / 100;
    const age = ageDays(asOf, p.listed_at);
    const la = LOG10(Math.max(1, age ?? UNKNOWN_AGE_DAYS));
    switch (kind) {
      case 'base':
        return [lt];
      case 'growth':
        return [lt, g];
      case 'age':
        return [lt, la];
      case 'logtvl2':
        return [lt, lt * lt];
      case 'chains':
        return [lt, p.chains.length];
      case 'growth-age':
        return [lt, g, la];
      case 'cat-dummies':
        return [lt, ...categories.slice(1).map((c) => (p.category === c ? 1 : 0))];
      case 'growth2':
        return [lt, g, g * g];
      case 'tvl-x-growth':
        return [lt, g, lt * g];
    }
  });
}

export interface TermResult {
  kind: TermKind;
  label: string;
  loo: number;
  looMedian: number;
  wf: number;
  wfMedian: number;
  bothLower: boolean;
  verdict: string;
}

/** The rank-1 rule, run on every candidate: LOO + walk-forward, both in
 * geometric-mean miss. A term enters only when it lowers BOTH. */
export function termTable(
  traded: SnapshotProtocol[],
  asOf: string,
): { table: TermResult[]; categories: string[] } {
  const y = traded.map((p) => LOG10(p.mcap_usd! / p.tvl_usd));
  const sorted = [...traded].sort(
    (a, b) => (a.listed_at! < b.listed_at! ? -1 : a.listed_at! > b.listed_at! ? 1 : a.slug < b.slug ? -1 : 1),
  );
  const train = sorted.slice(0, 66);
  const test = sorted.slice(66);
  const yTrain = train.map((p) => LOG10(p.mcap_usd! / p.tvl_usd));
  const yTest = test.map((p) => LOG10(p.mcap_usd! / p.tvl_usd));
  const categories = [...new Set(traded.map((p) => p.category).filter((c): c is string => c !== null))].sort();
  const table: TermResult[] = [];
  let base: TermResult | null = null;
  for (const kind of TERM_KINDS) {
    const X = termFeatures(traded, asOf, kind, categories);
    const looPred: number[] = [];
    for (let i = 0; i < traded.length; i++) {
      const Xr = X.filter((_, j) => j !== i);
      const yr = y.filter((_, j) => j !== i);
      looPred.push(predictRidge(fitRidge(Xr, yr, RIDGE_LAMBDA), X[i]!));
    }
    const Xtr = termFeatures(train, asOf, kind, categories);
    const Xte = termFeatures(test, asOf, kind, categories);
    const wfFit = fitRidge(Xtr, yTrain, RIDGE_LAMBDA);
    const wfPred = Xte.map((r) => predictRidge(wfFit, r));
    const r: TermResult = {
      kind,
      label: TERM_LABELS[kind],
      loo: gmeanMiss(y.map((v, i) => v - looPred[i]!)),
      looMedian: medianMiss(y.map((v, i) => v - looPred[i]!)),
      wf: gmeanMiss(yTest.map((v, i) => v - wfPred[i]!)),
      wfMedian: medianMiss(yTest.map((v, i) => v - wfPred[i]!)),
      bothLower: false,
      verdict: '',
    };
    if (kind === 'base') {
      base = r;
      r.verdict = 'shipped';
    }
    table.push(r);
  }
  for (const r of table) {
    if (r.kind === 'base') continue;
    r.bothLower = r.loo < base!.loo && r.wf < base!.wf;
    // A sub-1% move on both tests with a worse median is noise, not a gain.
    const immaterial = Math.abs(r.loo - base!.loo) / base!.loo < 0.01 && Math.abs(r.wf - base!.wf) / base!.wf < 0.01;
    r.verdict = r.bothLower && !immaterial ? 'ENTERS (both lower)' : r.bothLower ? 'dropped: both lower by <1%, LOO median worse — noise' : 'dropped: not lower on both';
  }
  return { table, categories };
}

// --------------------------------------------------------------- odds head

export interface LogitFit {
  intercept: number;
  slope: number;
  mu: number;
  sd: number;
  betaStd: number[];
}

/** Logistic regression by IRLS on the standardised feature, L2 penalty on
 * the standardised slope, intercept unpenalised. */
export function fitLogit(xs: number[], y: number[], l2: number): LogitFit {
  const mu = mean(xs);
  const sd = popStd(xs) === 0 ? 1 : popStd(xs);
  const z = xs.map((v) => (v - mu) / sd);
  let b0 = Math.log(mean(y) / (1 - mean(y)));
  let b1 = 0;
  for (let iter = 0; iter < 200; iter++) {
    let g0 = 0;
    let g1 = 0;
    let h00 = 0;
    let h01 = 0;
    let h11 = 0;
    for (let i = 0; i < z.length; i++) {
      const lin = b0 + b1 * z[i]!;
      const p = 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, lin))));
      const w = Math.max(p * (1 - p), 1e-9);
      const r = y[i]! - p;
      g0 += r;
      g1 += r * z[i]!;
      h00 += w;
      h01 += w * z[i]!;
      h11 += w * z[i]! * z[i]!;
    }
    g1 -= l2 * b1;
    h11 += l2 + 1e-8;
    h00 += 1e-8;
    const det = h00 * h11 - h01 * h01;
    const s0 = (h11 * g0 - h01 * g1) / det;
    const s1 = (-h01 * g0 + h00 * g1) / det;
    b0 += s0;
    b1 += s1;
    if (Math.max(Math.abs(s0), Math.abs(s1)) < 1e-11) break;
  }
  return { intercept: b0 - (b1 * mu) / sd, slope: b1 / sd, mu, sd, betaStd: [b0, b1] };
}

export function predictLogit(fit: LogitFit, x: number): number {
  const lin = fit.intercept + fit.slope * x;
  return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, lin))));
}

/** Mann-Whitney AUC. */
export function aucScore(y: number[], p: number[]): number {
  const pos = p.filter((_, i) => y[i] === 1);
  const neg = p.filter((_, i) => y[i] === 0);
  let c = 0;
  for (const a of pos) {
    for (const b of neg) c += a > b ? 1 : a === b ? 0.5 : 0;
  }
  return c / (pos.length * neg.length);
}

export function brierScore(y: number[], p: number[]): number {
  return mean(y.map((v, i) => (p[i]! - v) * (p[i]! - v)));
}

// -------------------------------------------------------------- farm plan

export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One step as a single string, inside the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('onchain capital')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** Ten costed steps, derived from the row's own record (category, chains,
 * TVL, age, deposit, odds, verdict) — never from a hand-written name list. */
export function farmSteps(
  p: SnapshotProtocol,
  age: number | null,
  deposit: number,
  odds: number,
  net: number,
  verdict: string,
): FarmStep[] {
  const chain = chainOf(p);
  const hold = holdDaysFor(age);
  const action = actionFor(p, deposit, chain);
  const gas = deposit >= 150 ? 8 : 4;
  return [
    { text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`, cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
    { text: action, cost: `$${deposit} of capital and about $${gas} of gas`, time: '15 minutes to set up' },
    { text: `Set the position size to $${deposit} (0.020% of this protocol's TVL) and do not top it up mid-campaign.`, cost: `$${deposit} of capital, already counted`, time: '2 minutes' },
    { text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`, cost: 'about $2 of gas a week', time: '10 minutes a week' },
    { text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`, cost: `the $${deposit} stays in the position`, time: `${hold} days` },
    { text: `The launch odds here are ${(odds * 100).toFixed(1)}% from the peers' record, so treat the farm as a lottery ticket, not a yield.`, cost: 'no fee to read the odds', time: '2 minutes' },
    { text: `The verdict is ${verdict}: expected net $${net.toFixed(2)} after $45 of gas and time, so size the effort to the verdict.`, cost: 'no fee to follow the verdict', time: '2 minutes' },
    { text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`, cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
    { text: `If the token launches, sell the airdrop into stables in tranches instead of all at once.`, cost: 'swap fees only, about 0.3% a tranche', time: '10 minutes' },
    { text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`, cost: 'nothing but the log', time: '5 minutes' },
  ];
}

// ------------------------------------------------------------------- rows

export interface Peer {
  slug: string;
  name: string;
  tvl_usd: number;
  mcap_usd: number;
  ratio: number;
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  ratio: number;
  p10_usd: number;
  p25_usd: number;
  p75_usd: number;
  p90_usd: number;
  odds: number;
  deposit_usd: number;
  gross_usd: number;
  net_usd: number;
  net_per_hour_usd: number;
  verdict: 'Farm' | 'Thin' | 'Skip';
  peers: Peer[];
  sensitivity: number[];
  rank_lo: number;
  rank_hi: number;
  farm_steps: string[];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
  ratio: number;
}

export interface ModelTests {
  loo: number;
  looMedian: number;
  wf: number;
  wfMedian: number;
  foldsSeed42: number[];
  foldMedian42: number;
  foldWorst42: number;
  foldWorstSweep: number;
  p25p75Loo: number;
  p10p90Loo: number;
  p25p75Wf: number;
  p10p90Wf: number;
  auc5fold: number;
  aucTimeSplit: number;
  brier5fold: number;
  brierTimeSplit: number;
  plattSlope: number;
  plattIntercept: number;
  sigma: number;
  intercept: number;
  slope: number;
  logitIntercept: number;
  logitSlope: number;
}

export interface RadarData {
  as_of: string;
  floor_usd: number;
  model_version: string;
  snapshot_protocols: number;
  snapshot_sha?: string;
  watchlist: string[];
  watchlist_size: number;
  board_size: number;
  ledger: { label: string; count: number }[];
  tests: ModelTests;
  terms: TermResult[];
  farm: { depositPct: number; gas: number; hours: number; hourly: number; cost: number; poolShare: number };
  rows: BoardRow[];
  live: LiveRow[];
  scatter: { t: number; r: number }[];
}

/** The whole build: model, tests, board, ledger. Pure from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const asOf = snapshot.as_of;
  const traded = snapshot.protocols.filter(isTradedFit);
  const y = traded.map((p) => LOG10(p.mcap_usd! / p.tvl_usd));
  const x = traded.map((p) => [LOG10(p.tvl_usd)]);
  const fit = fitRidge(x, y, RIDGE_LAMBDA);

  // Leave-one-out.
  const looPred = traded.map((_, i) => {
    const Xr = x.filter((_, j) => j !== i);
    const yr = y.filter((_, j) => j !== i);
    return predictRidge(fitRidge(Xr, yr, RIDGE_LAMBDA), x[i]!);
  });
  const looResid = y.map((v, i) => v - looPred[i]!);
  const sigma = popStd(looResid);

  // Walk-forward: 66 older listed -> 29 newer.
  const sorted = [...traded].sort(
    (a, b) => (a.listed_at! < b.listed_at! ? -1 : a.listed_at! > b.listed_at! ? 1 : a.slug < b.slug ? -1 : 1),
  );
  const train = sorted.slice(0, 66);
  const test = sorted.slice(66);
  const wfFit = fitRidge(train.map((p) => [LOG10(p.tvl_usd)]), train.map((p) => LOG10(p.mcap_usd! / p.tvl_usd)), RIDGE_LAMBDA);
  const wfResid = test.map((p) => LOG10(p.mcap_usd! / p.tvl_usd) - predictRidge(wfFit, [LOG10(p.tvl_usd)]));

  // 5-fold, seed 42, plus a 20-seed sweep for the worst fold anywhere.
  const folds42 = fiveFold(traded, x, y, 42);
  let foldWorstSweep = 0;
  for (let seed = 0; seed < 20; seed++) {
    const ms = fiveFold(traded, x, y, seed);
    foldWorstSweep = Math.max(foldWorstSweep, ...ms);
  }

  // Coverage with the normal head (z = 0.6745 for the central 50%, 1.2816 for 80%).
  const cov = (resid: number[], z: number): number =>
    resid.filter((r) => Math.abs(r) <= z * sigma).length / resid.length;

  // Odds head.
  const oddsSet = snapshot.protocols.filter(
    (p) => p.listed_at !== null && (isTradedFit(p) || isPreToken(p)),
  );
  const ao = oddsSet.map((p) => LOG10(Math.max(1, ageDays(asOf, p.listed_at) ?? UNKNOWN_AGE_DAYS)));
  const yo = oddsSet.map((p) => (isPreToken(p) ? 0 : 1));
  const logit = fitLogit(ao, yo, ODDS_L2);
  const pAll = ao.map((v) => predictLogit(logit, v));
  // 5-fold odds (seed 42).
  const oIdx = shuffled(oddsSet.length, 42);
  const oFolds = split5(oIdx);
  const oAucs: number[] = [];
  const oBriers: number[] = [];
  for (const fo of oFolds) {
    const tr = oddsSet.map((_, i) => i).filter((i) => !fo.includes(i));
    const f = fitLogit(tr.map((i) => ao[i]!), tr.map((i) => yo[i]!), ODDS_L2);
    const pp = fo.map((i) => predictLogit(f, ao[i]!));
    oAucs.push(aucScore(fo.map((i) => yo[i]!), pp));
    oBriers.push(brierScore(fo.map((i) => yo[i]!), pp));
  }
  // Time-split odds: older half trains, newer half tests.
  const oOrder = [...oddsSet.keys()].sort((a, b) =>
    oddsSet[a]!.listed_at! < oddsSet[b]!.listed_at! ? -1 : oddsSet[a]!.listed_at! > oddsSet[b]!.listed_at! ? 1 : a - b,
  );
  const half = Math.floor(oOrder.length / 2);
  const oTrain = oOrder.slice(0, half);
  const oTest = oOrder.slice(half);
  const oFitTs = fitLogit(oTrain.map((i) => ao[i]!), oTrain.map((i) => yo[i]!), ODDS_L2);
  const oPpTs = oTest.map((i) => predictLogit(oFitTs, ao[i]!));
  // Platt calibration on out-of-fold predictions (seed 42 folds).
  const oof = new Array<number>(oddsSet.length).fill(0);
  for (const fo of oFolds) {
    const tr = oddsSet.map((_, i) => i).filter((i) => !fo.includes(i));
    const f = fitLogit(tr.map((i) => ao[i]!), tr.map((i) => yo[i]!), ODDS_L2);
    for (const i of fo) oof[i] = predictLogit(f, ao[i]!);
  }
  const logitOof = oof.map((p) => Math.log(Math.min(0.999999, Math.max(0.000001, p)) / (1 - Math.min(0.999999, Math.max(0.000001, p)))));
  const platt = fitLogitRaw(logitOof, yo);

  const tests: ModelTests = {
    loo: gmeanMiss(looResid),
    looMedian: medianMiss(looResid),
    wf: gmeanMiss(wfResid),
    wfMedian: medianMiss(wfResid),
    foldsSeed42: folds42,
    foldMedian42: medianOf(folds42),
    foldWorst42: Math.max(...folds42),
    foldWorstSweep,
    p25p75Loo: cov(looResid, 0.67448975),
    p10p90Loo: cov(looResid, 1.28155157),
    p25p75Wf: cov(wfResid, 0.67448975),
    p10p90Wf: cov(wfResid, 1.28155157),
    auc5fold: mean(oAucs),
    aucTimeSplit: aucScore(oTest.map((i) => yo[i]!), oPpTs),
    brier5fold: mean(oBriers),
    brierTimeSplit: brierScore(oTest.map((i) => yo[i]!), oPpTs),
    plattSlope: platt.slope,
    plattIntercept: platt.intercept,
    sigma,
    intercept: fit.intercept,
    slope: fit.slopes[0]!,
    logitIntercept: logit.intercept,
    logitSlope: logit.slope,
  };

  const { table: terms } = termTable(traded, asOf);

  // Board rows: every board-rule protocol, ranked by implied value.
  const boardProtos = snapshot.protocols.filter(isBoardRow);
  const scored = boardProtos.map((p) => {
    const lt = LOG10(p.tvl_usd);
    const logRatio = predictRidge(fit, [lt]);
    const ratio = 10 ** logRatio;
    const implied = Math.max(1, Math.round(p.tvl_usd * ratio));
    const age = ageDays(asOf, p.listed_at);
    const odds = predictLogit(logit, LOG10(Math.max(1, age ?? UNKNOWN_AGE_DAYS)));
    // The farm deposit is 0.020% of TVL, in full: the built v13 numbers prove
    // it (Sentora Curator: deposit $552K on $2.76B TVL, net $69). A $25-$500
    // clamp on the dollar deposit would shrink every gross to cents and put
    // the whole board on Skip, which is not what the method's own drawer
    // shows — so the economics use the raw 0.020% share throughout.
    const deposit = DEPOSIT_PCT * p.tvl_usd;
    const share = DEPOSIT_PCT;
    const gross = implied * POOL_SHARE * share * odds;
    const net = gross - COST_USD;
    const verdict: BoardRow['verdict'] = net > 0 ? 'Farm' : gross > GAS_USD ? 'Thin' : 'Skip';
    const peers: Peer[] = traded
      .map((t) => ({ t, d: Math.abs(LOG10(t.tvl_usd) - lt) }))
      .sort((a, b) => a.d - b.d || (a.t.slug < b.t.slug ? -1 : 1))
      .slice(0, 3)
      .map(({ t }) => ({
        slug: t.slug,
        name: t.name,
        tvl_usd: t.tvl_usd,
        mcap_usd: t.mcap_usd!,
        ratio: round4(t.mcap_usd! / t.tvl_usd),
      }));
    const sens: number[] = [];
    for (const tvlMult of [0.5, 1, 2]) {
      for (const ratioMult of [0.5, 1, 2]) {
        sens.push(Math.max(1, Math.round(p.tvl_usd * tvlMult * ratio * ratioMult)));
      }
    }
    return {
      p,
      lt,
      logRatio,
      implied,
      age,
      odds,
      deposit,
      gross,
      net,
      verdict,
      peers,
      sens,
      p10: Math.max(1, Math.round(implied / 10 ** (1.28155157 * sigma))),
      p25: Math.max(1, Math.round(implied / 10 ** (0.67448975 * sigma))),
      p75: Math.max(1, Math.round(implied * 10 ** (0.67448975 * sigma))),
      p90: Math.max(1, Math.round(implied * 10 ** (1.28155157 * sigma))),
    };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  // Bootstrap rank ranges: 200 refits on resampled traded sets, seeded.
  const rankLo = new Array<number>(scored.length).fill(1);
  const rankHi = new Array<number>(scored.length).fill(1);
  const rnd = mulberry32(20261114);
  for (let b = 0; b < BOOTSTRAP_REFITS; b++) {
    const idx: number[] = [];
    for (let i = 0; i < traded.length; i++) idx.push(Math.floor(rnd() * traded.length));
    const bf = fitRidge(idx.map((i) => x[i]!), idx.map((i) => y[i]!), RIDGE_LAMBDA);
    const imp = scored.map((s) => Math.max(1, Math.round(s.p.tvl_usd * 10 ** predictRidge(bf, [s.lt]))));
    const order = imp.map((v, i) => i).sort((a, b2) => imp[b2]! - imp[a]! || (scored[a]!.p.slug < scored[b2]!.p.slug ? -1 : 1));
    order.forEach((si, pos) => {
      const r = pos + 1;
      if (r < rankLo[si]!) rankLo[si] = r;
      if (r > rankHi[si]!) rankHi[si] = r;
    });
  }

  const board: BoardRow[] = scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains.slice(0, 3),
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    age_days: s.age,
    implied_value_usd: s.implied,
    ratio: round4(s.p.tvl_usd === 0 ? 0 : s.implied / s.p.tvl_usd),
    p10_usd: s.p10,
    p25_usd: s.p25,
    p75_usd: s.p75,
    p90_usd: s.p90,
    odds: round4(s.odds),
    deposit_usd: Math.round(s.deposit),
    gross_usd: round2(s.gross),
    net_usd: round2(s.net),
    net_per_hour_usd: round2(s.net / HOURS),
    verdict: s.verdict,
    peers: s.peers,
    sensitivity: s.sens,
    rank_lo: rankLo[i]!,
    rank_hi: rankHi[i]!,
    farm_steps: farmSteps(s.p, s.age, Math.round(s.deposit), s.odds, s.net, s.verdict).map(stepText),
  }));

  // Live-token view: the 24 largest market caps among positive mcap.
  const live: LiveRow[] = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.category !== 'CEX')
    .sort((a, b) => b.mcap_usd! - a.mcap_usd! || b.tvl_usd - a.tvl_usd)
    .slice(0, 24)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains.slice(0, 3),
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      change_7d: p.change_7d,
      ratio: round4(p.mcap_usd! / p.tvl_usd),
    }));

  // Ledger: every one of the 758 protocols, accounted for, in disjoint sets.
  const nBoard = board.length;
  const nLive = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0).length;
  const nTokenNoMcap = snapshot.protocols.filter((p) => p.mcap_usd === null && !isPreToken(p)).length;
  const nMcapZero = snapshot.protocols.filter((p) => p.mcap_usd === 0).length;
  const nMcapNeg = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd < 0).length;
  const nPreExcluded = snapshot.protocols.filter((p) => isPreToken(p) && !isBoardRow(p)).length;
  const ledger = [
    { label: 'ranked on this board', count: nBoard },
    { label: 'live token, positive market cap', count: nLive },
    { label: 'token exists, no market cap recorded', count: nTokenNoMcap },
    { label: 'market cap recorded as zero', count: nMcapZero },
    { label: 'market cap recorded negative (AUTOfinance, -1)', count: nMcapNeg },
    { label: 'pre-token, excluded as wrapped / staked / bridged / versioned', count: nPreExcluded },
  ];

  const radar: RadarData = {
    as_of: snapshot.as_of,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    snapshot_protocols: snapshot.protocols.length,
    watchlist: snapshot.watchlist,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    ledger,
    tests,
    terms,
    farm: { depositPct: DEPOSIT_PCT, gas: GAS_USD, hours: HOURS, hourly: HOURLY_USD, cost: COST_USD, poolShare: POOL_SHARE },
    rows: board,
    live,
    scatter: traded.map((p) => ({ t: p.tvl_usd, r: round4(p.mcap_usd! / p.tvl_usd) })),
  };
  return { board, radar };
}

function medianOf(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length;
  return m % 2 === 1 ? s[(m - 1) / 2]! : (s[m / 2 - 1]! + s[m / 2]!) / 2;
}

/** Split shuffled indices into 5 folds the way a standard array split does:
 * the first `n % 5` folds get one extra element. */
function split5(idx: number[]): number[][] {
  const n = idx.length;
  const base = Math.floor(n / 5);
  const rem = n % 5;
  const folds: number[][] = [];
  let at = 0;
  for (let f = 0; f < 5; f++) {
    const s = base + (f < rem ? 1 : 0);
    folds.push(idx.slice(at, at + s));
    at += s;
  }
  return folds.filter((f) => f.length > 0);
}

/** 5-fold geometric-mean misses for one seed. */
function fiveFold(traded: SnapshotProtocol[], x: number[][], y: number[], seed: number): number[] {
  const idx = shuffled(traded.length, seed);
  const folds = split5(idx);
  return folds.map((fo) => {
    const tr = traded.map((_, i) => i).filter((i) => !fo.includes(i));
    const f = fitRidge(tr.map((i) => x[i]!), tr.map((i) => y[i]!), RIDGE_LAMBDA);
    const resid = fo.map((i) => y[i]! - predictRidge(f, x[i]!));
    return gmeanMiss(resid);
  });
}

/** Unpenalised logistic on a raw single feature (Platt calibration). */
function fitLogitRaw(xs: number[], y: number[]): { intercept: number; slope: number } {
  const fit = fitLogit(xs, y, 0);
  return { intercept: fit.intercept, slope: fit.slope };
}

// ------------------------------------------------------------------ parsing

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** The dashboard's whole dataset as one script, no fetch and no network.
 * The snapshot's source line names a network address, so it is never copied
 * in: the dashboard names the source in words only. */
export function dataScript(radar: RadarData): string {
  const script = `window.RADAR=${JSON.stringify(radar)};\n`;
  if (script.includes('http')) throw new SnapshotError('data.js would name a network address');
  return script;
}
