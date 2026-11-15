// The token radar's model: one sealed snapshot in, one ranked board out.
//
// The board ranks protocols that record no token yet: what a launch would be worth if the
// protocol's record stayed as it is. Protocols whose token already trades are never ranked;
// they are set aside as the live set, and they do one job for the model first: they calibrate
// it. The snapshot's own trading protocols say what the market pays per dollar of TVL in each
// category, and the radar applies that price to the protocols still to come.
//
//   implied = TVL x category_multiple x momentum x maturity x breadth
//
//   category_multiple  the median market-cap/TVL of the snapshot's tokenized protocols in the
//                      same category, each ratio clamped to [0.01, 4] before the median, shrunk
//                      toward the global median with a prior of 4 samples, clamped to
//                      [0.05, 2.5]. A category with no trading protocol takes the global
//                      median. No protocol name is ever special-cased.
//   momentum           1 + 0.45 x tanh(clamp(change_7d, -50, 150) / 40): a week of growth
//                      lifts the value, a shrinking week discounts it, and the tanh keeps one
//                      wild week from dominating. Unreported change counts as 0.
//   maturity           0.70 + 0.30 x min(age_days, 1825) / 1825: five years of running with
//                      no token earns the full factor. An unreported listing date counts as
//                      the snapshot's own median age, not a guess at any one protocol.
//   breadth            1 + 0.025 x min(chains - 1, 8): each extra chain the TVL already sits
//                      on adds a little, capped at eight.
//
// The board covers every slug in the snapshot's watchlist, then adds the strongest pre-token
// protocols below the floor under the same exclusions the watchlist itself uses: no CEX, no
// versioned pool of another protocol, and no wrapped, staked or bridged product (the Bridge,
// Canonical Bridge, Liquid Staking, Liquid Restaking and Restaked BTC categories, names
// carrying a whole word wrapped, staked or staking, and names opening with an exchange's).
// A wrapped product of a token that already trades is not a launch still to come, at any TVL.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
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

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'calibrated-1';

/** The model's fixed constants. The multiples are not here: the snapshot calibrates them. */
export const MODEL = {
  /** Each tokenized protocol's market-cap/TVL ratio is clamped to this before any median. */
  ratio_clamp_lo: 0.01,
  ratio_clamp_hi: 4,
  /** Shrinkage: a category median counts as this many extra samples of the global median. */
  prior_samples: 4,
  /** A category multiple, after shrinkage, is clamped to this. */
  multiple_lo: 0.05,
  multiple_hi: 2.5,
  momentum_weight: 0.45,
  momentum_scale: 40,
  momentum_floor: -50,
  momentum_cap: 150,
  maturity_base: 0.7,
  maturity_span: 0.3,
  maturity_days: 1825,
  breadth_per_chain: 0.025,
  breadth_max_extra: 8,
  /** How many pre-token protocols below the floor the early radar carries, by TVL. */
  early_rows: 160,
  /** How many live-token protocols the set-aside view carries, by market cap. */
  live_rows: 24,
} as const;

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A whole day count from `listedAt` to `asOf`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of an already-sorted array; 0 for an empty one. */
function medianOf(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** One category's calibration: the multiple the model applies and how many trading protocols priced it. */
export interface CategoryCalibration {
  category: string;
  multiple: number;
  samples: number;
}

/** What the snapshot's trading protocols teach the model, plus the age an unlisted date falls back to. */
export interface Calibration {
  global_multiple: number;
  trading_protocols: number;
  reference_age_days: number;
  categories: CategoryCalibration[];
  byCategory: Map<string, CategoryCalibration>;
}

/**
 * Calibrate the model from the snapshot itself: every protocol whose token trades and whose
 * record carries both a market cap and a TVL contributes its market-cap/TVL ratio.
 */
export function calibrate(snapshot: Snapshot): Calibration {
  const trading = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const ratio = (p: SnapshotProtocol): number => clamp(p.mcap_usd! / p.tvl_usd, MODEL.ratio_clamp_lo, MODEL.ratio_clamp_hi);
  const globalMedian = medianOf(trading.map(ratio).sort((a, b) => a - b));

  const ratiosByCategory = new Map<string, number[]>();
  for (const p of trading) {
    const key = p.category ?? '';
    const list = ratiosByCategory.get(key);
    if (list === undefined) ratiosByCategory.set(key, [ratio(p)]);
    else list.push(ratio(p));
  }
  const categories: CategoryCalibration[] = [];
  const byCategory = new Map<string, CategoryCalibration>();
  for (const key of [...ratiosByCategory.keys()].sort()) {
    const samples = ratiosByCategory.get(key)!.slice().sort((a, b) => a - b);
    const catMedian = medianOf(samples);
    const n = samples.length;
    const shrunk = (n * catMedian + MODEL.prior_samples * globalMedian) / (n + MODEL.prior_samples);
    const entry: CategoryCalibration = { category: key, multiple: round4(clamp(shrunk, MODEL.multiple_lo, MODEL.multiple_hi)), samples: n };
    categories.push(entry);
    byCategory.set(key, entry);
  }

  const ages = snapshot.protocols
    .map((p) => ageDays(snapshot.as_of, p.listed_at))
    .filter((a): a is number => a !== null)
    .sort((a, b) => a - b);
  return {
    global_multiple: round4(globalMedian),
    trading_protocols: trading.length,
    reference_age_days: ages.length > 0 ? Math.round(medianOf(ages)) : 365,
    categories,
    byCategory,
  };
}

/** Whether a protocol records no token at all: no market cap, no CoinGecko id, no symbol. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** Categories that are wrapped, staked or bridged products of another protocol, per the watchlist's own rule. */
const PRODUCT_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC']);
/** A whole word wrapped, staked or staking anywhere in the name. */
const PRODUCT_WORD = /\b(wrapped|staked|staking)\b/i;
/** A name that opens with an exchange's name. */
const EXCHANGE_LEAD = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/** Whether a pre-token protocol below the floor is a launch still to come, not a product of one that trades. */
export function isEarlyCandidate(p: SnapshotProtocol): boolean {
  return (
    isPreToken(p) &&
    p.category !== 'CEX' &&
    !PRODUCT_CATEGORIES.has(p.category ?? '') &&
    !VERSIONED.test(p.name) &&
    !PRODUCT_WORD.test(p.name) &&
    !EXCHANGE_LEAD.test(p.name)
  );
}

/** The factors one protocol is scored with, and the implied value they multiply to. */
export interface ScoreBreakdown {
  category_multiple: number;
  calibration_samples: number;
  momentum_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
  age_days: number | null;
  implied_value_usd: number;
}

/** Score one pre-token protocol from the snapshot's figures and the calibration alone. */
export function scoreProtocol(p: SnapshotProtocol, snapshot: Snapshot, calib: Calibration): ScoreBreakdown {
  const cal = calib.byCategory.get(p.category ?? '');
  const multiple = cal === undefined ? calib.global_multiple : cal.multiple;
  const samples = cal === undefined ? 0 : cal.samples;
  const growth = clamp(p.change_7d ?? 0, MODEL.momentum_floor, MODEL.momentum_cap);
  const momentum = 1 + MODEL.momentum_weight * Math.tanh(growth / MODEL.momentum_scale);
  const age = ageDays(snapshot.as_of, p.listed_at);
  const ageUsed = age ?? calib.reference_age_days;
  const maturity = MODEL.maturity_base + (Math.min(Math.max(ageUsed, 0), MODEL.maturity_days) / MODEL.maturity_days) * MODEL.maturity_span;
  const breadth = 1 + MODEL.breadth_per_chain * Math.min(Math.max(p.chains.length - 1, 0), MODEL.breadth_max_extra);
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * momentum * maturity * breadth));
  return {
    category_multiple: multiple,
    calibration_samples: samples,
    momentum_multiplier: round4(momentum),
    maturity_multiplier: round4(maturity),
    breadth_multiplier: round4(breadth),
    age_days: age,
    implied_value_usd: implied,
  };
}

// ------------------------------------------------------------------ farm plans

/** A small deterministic hash of a slug, so plan phrasing varies by protocol and never by run. */
function slugHash(slug: string): number {
  let h = 2166136261;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const L2_CHAINS = new Set([
  'Arbitrum', 'Base', 'Optimism', 'Polygon', 'zkSync Era', 'Linea', 'Scroll', 'Mantle', 'Blast',
  'Unichain', 'Mode', 'Taiko', 'Starknet', 'Manta', 'Zora', 'Fraxtal', 'Sonic', 'Berachain', 'Monad',
]);

type ChainClass = 'solana' | 'l1' | 'l2' | 'other';

function chainClass(chain: string): ChainClass {
  if (chain === 'Solana') return 'solana';
  if (chain === 'Ethereum') return 'l1';
  if (L2_CHAINS.has(chain)) return 'l2';
  return 'other';
}

/** What one transaction costs on a chain, in the plain words a farmer budgets with. */
function gasText(cls: ChainClass, chain: string): string {
  if (cls === 'solana') return 'about $0.05 of SOL in fees';
  if (cls === 'l1') return 'about $6-20 of Ethereum gas (act in quiet hours)';
  if (cls === 'l2') return `about $0.20-$2 of gas on ${chain}`;
  return `a few dollars of gas at most on ${chain} - check the wallet estimate before signing`;
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(tvl: number): number {
  if (tvl >= 5_000_000_000) return 500;
  if (tvl >= 1_000_000_000) return 250;
  if (tvl >= 250_000_000) return 150;
  if (tvl >= 50_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  if (age < 730) return 35;
  return 30;
}

/** Whole dollars the way a reader scans them: $2.75B, $812M, $45K. */
function fmtUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${n}`;
}

/** A 7-day change the way a reader scans it: +12.5%, -4.0%, or a note that none is reported. */
function fmtChange(change: number | null): string {
  if (change === null) return 'unreported';
  return `${change > 0 ? '+' : ''}${change.toFixed(1)}%`;
}

type Playbook = 'dex' | 'lending' | 'cdp' | 'perp' | 'yield' | 'curator' | 'bridge' | 'rwa' | 'launchpad' | 'prediction' | 'insurance' | 'staking' | 'generic';

const PLAYBOOK_BY_CATEGORY = new Map<string, Playbook>([
  ['Dexs', 'dex'],
  ['Lending', 'lending'],
  ['Uncollateralized Lending', 'lending'],
  ['CDP', 'cdp'],
  ['CDP Manager', 'cdp'],
  ['Derivatives', 'perp'],
  ['Interest Rate Derivatives', 'perp'],
  ['Options', 'perp'],
  ['Options Vault', 'perp'],
  ['Yield', 'yield'],
  ['Yield Aggregator', 'yield'],
  ['Leveraged Farming', 'yield'],
  ['Farm', 'yield'],
  ['Basis Trading', 'yield'],
  ['Risk Curators', 'curator'],
  ['Onchain Capital Allocator', 'curator'],
  ['Liquidity Manager', 'curator'],
  ['Collateral Management', 'curator'],
  ['Cross Chain Bridge', 'bridge'],
  ['RWA', 'rwa'],
  ['Launchpad', 'launchpad'],
  ['Prediction Market', 'prediction'],
  ['Insurance', 'insurance'],
  ['Staking Pool', 'staking'],
  ['Restaking', 'staking'],
]);

function playbookFor(p: SnapshotProtocol): Playbook {
  const exact = PLAYBOOK_BY_CATEGORY.get(p.category ?? '');
  if (exact !== undefined) return exact;
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend')) return 'lending';
  if (c.includes('dex') || c.includes('swap')) return 'dex';
  if (c.includes('perp') || c.includes('derivative') || c.includes('option')) return 'perp';
  if (c.includes('yield') || c.includes('farm')) return 'yield';
  if (c.includes('bridge')) return 'bridge';
  if (c.includes('stak') || c.includes('restak')) return 'staking';
  if (c.includes('rwa') || c.includes('real world')) return 'rwa';
  return 'generic';
}

/** The playbook's core position: the one action that makes the wallet a user of the protocol. */
function coreStep(book: Playbook, name: string, chain: string, cap: number, gas: string): string {
  switch (book) {
    case 'dex':
      return `Trade and provide liquidity on ${name}: swap $${cap} of USDC into the pool's pair asset, then deposit $${cap} into its busiest USDC pool on ${chain} and leave the LP position open. Cost: $${cap} of capital plus ${gas}. Time: 20 minutes to set up.`;
    case 'lending':
      return `Supply $${cap} of USDC to ${name}'s main lending market on ${chain}; the big stablecoin markets are the ones points and incentive programs usually count first. Cost: $${cap} of capital plus ${gas}. Time: 15 minutes to set up.`;
    case 'cdp':
      return `Open a small vault on ${name}: deposit $${cap} of ETH or a liquid staking token as collateral on ${chain} and mint no more than 35% of its value in the protocol's stablecoin, so a bad week cannot liquidate you. Cost: $${cap} of collateral plus ${gas}. Time: 20 minutes.`;
    case 'perp':
      return `Deposit $${cap} of USDC as margin on ${name} and open one small hedged pair - long one major, short another of equal size - so volume and open interest accrue without directional risk. Cost: $${cap} of margin, roughly 0.1% in trading fees, plus ${gas}. Time: 25 minutes.`;
    case 'yield':
      return `Deposit $${cap} of USDC into ${name}'s highest-TVL vault on ${chain} and keep the vault shares in the same wallet; a vault balance held across days is the activity a yield protocol can score. Cost: $${cap} of capital plus ${gas}. Time: 15 minutes.`;
    case 'curator':
      return `Split $${cap} of USDC across two of ${name}'s curated vaults on ${chain}, weighted 60/40 by vault TVL, so one vault hitting its cap or pausing cannot zero the position. Cost: $${cap} of capital plus ${gas} on each deposit. Time: 20 minutes.`;
    case 'bridge':
      return `Bridge $${cap} of USDC from Ethereum to ${chain} through ${name}, then use the bridged USDC inside one app on the far side the same day; a bridge-and-use round trip is the activity bridge snapshots count. Cost: $${cap} moved, the bridge fee (usually under 0.1%), plus ${gas}. Time: 30 minutes including the wait.`;
    case 'rwa':
      return `Mint $${cap} of ${name}'s yield-bearing asset on ${chain} with USDC and hold the tokens in the farming wallet; finish any eligibility check only inside the protocol's own app, never on a lookalike site. Cost: $${cap} of capital plus ${gas}. Time: 20 minutes, longer if a check is manual.`;
    case 'launchpad':
      return `Register the farming wallet on ${name} and take part in one live sale or staking round with $${cap}; a small completed allocation counts for more than watchlist clicks ever will. Cost: $${cap} committed for the round plus ${gas}. Time: 30 minutes.`;
    case 'prediction':
      return `Fund ${name} with $${cap} of USDC and place two small positions on its most liquid markets, on questions you can settle from public news. Cost: $${cap} at risk plus ${gas}. Time: 20 minutes.`;
    case 'insurance':
      return `Buy $${cap} of cover on a major protocol through ${name} on ${chain} and keep the policy to expiry; cover buyers are the users an insurance protocol rewards first. Cost: the premium, roughly 2-3% of the cover per year, plus ${gas}. Time: 15 minutes.`;
    case 'staking':
      return `Stake $${cap} of the chain's staking asset through ${name} on ${chain} and keep the receipt token in the wallet; unstaking queues mean this should be money you can leave for a month. Cost: $${cap} staked plus ${gas}. Time: 15 minutes.`;
    default:
      return `Deposit $${cap} of USDC into ${name} on ${chain} through its own app and keep the position open; use the product the way its homepage leads, not a side contract. Cost: $${cap} of capital plus ${gas}. Time: 15 minutes to set up.`;
  }
}

/** The playbook's second action: the follow-through that separates a user from a one-off visitor. */
function secondStep(book: Playbook, name: string, cap2: number, gas: string): string {
  switch (book) {
    case 'dex':
      return `Add a second, smaller position of $${cap2} in a correlated pool (the ETH/USDC pool if ${name} has one) so the wallet's history shows range, not a single trade. Cost: $${cap2} plus ${gas}. Time: 15 minutes.`;
    case 'lending':
      return `Borrow $${cap2} of USDC against the supply once and repay it within the week: one completed borrow-and-repay cycle is the action lending snapshots most reliably record. Cost: a few cents of interest plus ${gas}. Time: 10 minutes.`;
    case 'cdp':
      return `Repay a slice of the minted stablecoin and top the collateral back up once, so the vault shows both mint and repay activity, not just a deposit. Cost: ${gas} on each transaction. Time: 10 minutes.`;
    case 'perp':
      return `Close and reopen the hedge once a week at a similar size; steady weekly volume beats one large trade in most points formulas. Cost: roughly 0.1% in fees per round trip plus ${gas}. Time: 10 minutes a week.`;
    case 'yield':
      return `Move $${cap2} into a second vault running a different strategy (a lending vault if the first is a basis vault), so the wallet is not riding one yield source. Cost: $${cap2} plus ${gas}. Time: 15 minutes.`;
    case 'curator':
      return `Rebalance once after two weeks: shift 10-20% toward whichever of the two vaults grew its TVL share, and write both vault addresses into the farm log. Cost: ${gas} on each move. Time: 15 minutes.`;
    case 'bridge':
      return `Bridge a second, smaller amount ($${cap2}) back the other way a week later, so the wallet shows traffic in both directions rather than a single crossing. Cost: $${cap2} moved, fees under 0.1%, plus ${gas}. Time: 30 minutes.`;
    case 'rwa':
      return `When the first yield lands (often monthly), claim or compound it and leave the proceeds in the asset instead of withdrawing to the wallet. Cost: ${gas}. Time: 5 minutes when due.`;
    case 'launchpad':
      return `Hold whatever the round issues and join ${name}'s next round rather than flipping the first allocation; repeat participants are the wallets launchpads remember. Cost: no new capital. Time: 10 minutes a round.`;
    case 'prediction':
      return `Settle finished positions promptly and roll $${cap2} into a fresh market each week; a settled history is what a prediction market can score. Cost: ${gas} per settlement. Time: 10 minutes a week.`;
    case 'insurance':
      return `Renew or extend the cover once before it expires, so coverage runs continuously across snapshot dates instead of lapsing after a single purchase. Cost: another premium slice plus ${gas}. Time: 10 minutes.`;
    case 'staking':
      return `Claim staking rewards once they pass $5 and restake them into the same position, so the balance the snapshots see keeps compounding. Cost: ${gas} per claim. Time: 5 minutes.`;
    default:
      return `Repeat the core action once at half size ($${cap2}) in a later week, so the wallet's history spans more than one day. Cost: $${cap2} plus ${gas}. Time: 10 minutes.`;
  }
}

/**
 * A protocol's farm plan: six steps, each an action with what it costs and how long it takes.
 * Category picks the playbook; chains set the wallet and the gas; TVL sets the capital; age
 * sets the hold; the protocol's own 7-day figure sets the sizing note. No name is special-cased.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const cls = chainClass(chain);
  const gas = gasText(cls, chain);
  const cap = capitalFor(p.tvl_usd);
  const cap2 = Math.max(25, Math.round(cap / 2));
  const hold = holdDaysFor(age);
  const book = playbookFor(p);
  const variant = slugHash(p.slug) % 2;
  const wallet = cls === 'solana' ? 'a fresh Solana wallet (Phantom or Solflare)' : 'a fresh EVM wallet used only for farming';
  const setupGas = cls === 'solana' ? 'about $0.05 to fund it' : cls === 'l1' ? 'about $5 of gas for the first approval' : 'under $1 of gas';

  const setup =
    variant === 0
      ? `Create ${wallet} and fund it with only what the ${p.name} farm needs; write the seed phrase on paper and keep it offline, never in a screenshot or a notes app. Cost: ${setupGas}. Time: 10 minutes.`
      : `Set up ${wallet} dedicated to ${p.name}; never farm from your main wallet, and keep the recovery phrase offline on paper. Cost: ${setupGas}. Time: 10 minutes.`;

  const sizing =
    p.change_7d === null
      ? `Size by the record, not the hype: ${p.name} holds ${fmtUsd(p.tvl_usd)} of TVL and the snapshot reports no 7-day change for it, so keep this farm at the standard $${cap} size and re-check the trend before adding anything. Cost: nothing. Time: 5 minutes a week.`
      : variant === 0
        ? `Size by the record, not the hype: ${p.name} holds ${fmtUsd(p.tvl_usd)} of TVL and moved ${fmtChange(p.change_7d)} in the last 7 days, so keep this farm under 10% of your total airdrop budget and add only if TVL is still rising at the weekly check. Cost: nothing. Time: 5 minutes a week.`
        : `Read the trend before adding: the 7-day TVL change is ${fmtChange(p.change_7d)} on ${fmtUsd(p.tvl_usd)} of TVL. If it prints negative at two weekly checks in a row, stop adding and let the existing position ride. Cost: nothing. Time: 5 minutes a week.`;

  const holdStep = `Keep the ${p.name} position open at least ${hold} days and touch it once a week - a claim, a rebalance or a small repeat of the core action - so the wallet appears in several weekly snapshots, not just one. Cost: ${gas} a week at most. Time: 10 minutes a week for ${hold} days.`;

  const watch =
    variant === 0
      ? `Check ${p.name}'s own site and announcement channel weekly for a points page or a token post; if a claim ever opens, use only the link the protocol itself publishes, and never pay a fee to claim. Cost: nothing to check. Time: 5 minutes a week.`
      : `Log every transaction hash, date and balance in a farm log, and check ${p.name}'s official channels weekly; a claim, if one ever opens, is announced there first - treat any other claim site as a scam. Cost: nothing. Time: 10 minutes a week.`;

  return [setup, coreStep(book, p.name, chain, cap, gas), secondStep(book, p.name, cap2, gas), sizing, holdStep, watch];
}

// ------------------------------------------------------------------ the board

/** One row of board.json: the ranked board's row, with the model's own arithmetic shown. */
export interface BoardRow {
  rank: number;
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
  token_status: 'pre-token';
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: {
    category_multiple: number;
    calibration_samples: number;
    momentum_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
  };
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value, never a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the calibration behind the model. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  calibration: {
    global_multiple: number;
    trading_protocols: number;
    reference_age_days: number;
    categories: CategoryCalibration[];
  };
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: BoardRow[];
  live: LiveRow[];
}

const bySlugAsc = (a: SnapshotProtocol, b: SnapshotProtocol): number => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, calib: Calibration): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isEarlyCandidate(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || bySlugAsc(a, b))
    .slice(0, MODEL.early_rows);
  for (const p of early) chosen.set(p.slug, p);

  const watchlist = new Set(snapshot.watchlist);
  const scored = [...chosen.values()].map((p) => ({ p, score: scoreProtocol(p, snapshot, calib) }));
  scored.sort((a, b) => b.score.implied_value_usd - a.score.implied_value_usd || bySlugAsc(a.p, b.p));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token' as const,
    watchlist: watchlist.has(s.p.slug),
    age_days: s.score.age_days,
    implied_value_usd: s.score.implied_value_usd,
    model: {
      category_multiple: s.score.category_multiple,
      calibration_samples: s.score.calibration_samples,
      momentum_multiplier: s.score.momentum_multiplier,
      maturity_multiplier: s.score.maturity_multiplier,
      breadth_multiplier: s.score.breadth_multiplier,
    },
    farm_steps: farmSteps(s.p, s.score.age_days),
  }));
}

/** The live-token protocols, by market cap, for the dashboard's set-aside view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || bySlugAsc(a, b))
    .slice(0, MODEL.live_rows)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const calib = calibrate(snapshot);
  const board = buildBoard(snapshot, calib);
  const live = liveRows(snapshot);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    calibration: {
      global_multiple: calib.global_multiple,
      trading_protocols: calib.trading_protocols,
      reference_age_days: calib.reference_age_days,
      categories: calib.categories,
    },
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !r.watchlist).length,
    live_size: live.length,
    rows: board,
    live,
  };
  return { board, radar };
}

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
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, values, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100 to 4000`;
  const seen = new Set<string>();
  for (const r of board) {
    if (seen.has(r.slug)) return `slug ${r.slug} appears twice`;
    seen.add(r.slug);
  }
  const missing = snapshot.watchlist.filter((s) => !seen.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  const byRank = board.slice().sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i++) {
    if (byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return `row ${byRank[i]!.slug} outranks ${byRank[i - 1]!.slug} on implied value`;
  }
  if (board.length >= 2 && byRank[0]!.implied_value_usd === byRank[board.length - 1]!.implied_value_usd) {
    return 'every row shares one implied value: a board that ranks nothing by value is not a ranking';
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const trimmed = s.trim().length;
      if (trimmed < 20 || trimmed > 600) return `${r.slug} has a farm step of ${trimmed} trimmed characters`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
