/**
 * Price simulators — pluggable price processes that drive the mark price
 * of a market over time. Each simulator yields ticks lazily via `next()`.
 *
 * Built-ins:
 *   - `ConstantPrice`     fixed price, used for position-only simulations
 *   - `RandomWalk`        Brownian motion with optional drift
 *   - `GBM`               geometric Brownian motion (log-normal, more realistic for prices)
 *   - `MeanReversion`     Ornstein-Uhlenbeck (price reverts to a target mean)
 *   - `Replay`            replays a recorded tick array (subsumes MarketDataFeed)
 *   - `JumpDiffusion`     base process + Poisson jumps (news shocks)
 *   - `Composite`         chain N simulators back-to-back
 *   - `Scripted`          base + scripted multipliers at specific steps
 *
 * All simulators are deterministic when constructed with a numeric `seed`.
 */

export interface PriceTick {
  price: number;
  volume?: number;
  timestamp?: number;
}

export interface PriceSimulator {
  /** Produce the next tick, or `null` when the simulator is exhausted. */
  next(): PriceTick | null;
  /** Optional reset to start. Infinite simulators may no-op. */
  reset?(): void;
  /** Whether more ticks are available. Default true for infinite simulators. */
  hasNext?(): boolean;
}

// ─── Deterministic RNG (mulberry32) ───────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller transform → standard normal. */
function normal(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ─── Implementations ──────────────────────────────────────────────────────

export interface ConstantPriceOptions {
  price: number;
  steps?: number;
}

/** Always emits the same price. Useful for position-only sims. */
export class ConstantPrice implements PriceSimulator {
  private remaining: number;
  constructor(private opts: ConstantPriceOptions) {
    this.remaining = opts.steps ?? Infinity;
  }
  next(): PriceTick | null {
    if (this.remaining <= 0) return null;
    if (Number.isFinite(this.remaining)) this.remaining -= 1;
    return { price: this.opts.price };
  }
  hasNext(): boolean {
    return this.remaining > 0;
  }
  reset(): void {
    this.remaining = this.opts.steps ?? Infinity;
  }
}

export interface RandomWalkOptions {
  start: number;
  sigma: number;
  drift?: number;
  steps?: number;
  seed?: number;
  floor?: number;
}

/** Arithmetic Brownian motion: p_{t+1} = p_t + drift + sigma * Z. */
export class RandomWalk implements PriceSimulator {
  private price: number;
  private remaining: number;
  private rng: () => number;
  constructor(private opts: RandomWalkOptions) {
    this.price = opts.start;
    this.remaining = opts.steps ?? Infinity;
    this.rng = mulberry32(opts.seed ?? Date.now() & 0xffffffff);
  }
  next(): PriceTick | null {
    if (this.remaining <= 0) return null;
    if (Number.isFinite(this.remaining)) this.remaining -= 1;
    const z = normal(this.rng);
    this.price += (this.opts.drift ?? 0) + this.opts.sigma * z;
    if (this.opts.floor !== undefined) {
      this.price = Math.max(this.opts.floor, this.price);
    }
    return { price: this.price };
  }
  hasNext(): boolean {
    return this.remaining > 0;
  }
  reset(): void {
    this.price = this.opts.start;
    this.remaining = this.opts.steps ?? Infinity;
    this.rng = mulberry32(this.opts.seed ?? Date.now() & 0xffffffff);
  }
}

export interface GBMOptions {
  start: number;
  /** Drift (per step). Use small value, e.g. 0.0001. */
  mu: number;
  /** Volatility (per step). e.g. 0.01 for ~1% moves. */
  sigma: number;
  /** Time delta. Default 1 — set lower for finer ticks. */
  dt?: number;
  steps?: number;
  seed?: number;
}

/** Geometric Brownian motion — the textbook stock price process. */
export class GBM implements PriceSimulator {
  private price: number;
  private remaining: number;
  private rng: () => number;
  constructor(private opts: GBMOptions) {
    this.price = opts.start;
    this.remaining = opts.steps ?? Infinity;
    this.rng = mulberry32(opts.seed ?? Date.now() & 0xffffffff);
  }
  next(): PriceTick | null {
    if (this.remaining <= 0) return null;
    if (Number.isFinite(this.remaining)) this.remaining -= 1;
    const dt = this.opts.dt ?? 1;
    const z = normal(this.rng);
    const drift = (this.opts.mu - 0.5 * this.opts.sigma ** 2) * dt;
    const diffusion = this.opts.sigma * Math.sqrt(dt) * z;
    this.price = this.price * Math.exp(drift + diffusion);
    return { price: this.price };
  }
  hasNext(): boolean {
    return this.remaining > 0;
  }
  reset(): void {
    this.price = this.opts.start;
    this.remaining = this.opts.steps ?? Infinity;
    this.rng = mulberry32(this.opts.seed ?? Date.now() & 0xffffffff);
  }
}

export interface MeanReversionOptions {
  start: number;
  /** Long-run mean the price reverts toward. */
  mu: number;
  /** Speed of mean reversion. Higher = snaps back faster. */
  theta: number;
  /** Volatility per step. */
  sigma: number;
  dt?: number;
  steps?: number;
  seed?: number;
}

/** Ornstein-Uhlenbeck mean-reverting process. */
export class MeanReversion implements PriceSimulator {
  private price: number;
  private remaining: number;
  private rng: () => number;
  constructor(private opts: MeanReversionOptions) {
    this.price = opts.start;
    this.remaining = opts.steps ?? Infinity;
    this.rng = mulberry32(opts.seed ?? Date.now() & 0xffffffff);
  }
  next(): PriceTick | null {
    if (this.remaining <= 0) return null;
    if (Number.isFinite(this.remaining)) this.remaining -= 1;
    const dt = this.opts.dt ?? 1;
    const z = normal(this.rng);
    const reversion = this.opts.theta * (this.opts.mu - this.price) * dt;
    const shock = this.opts.sigma * Math.sqrt(dt) * z;
    this.price += reversion + shock;
    return { price: this.price };
  }
  hasNext(): boolean {
    return this.remaining > 0;
  }
  reset(): void {
    this.price = this.opts.start;
    this.remaining = this.opts.steps ?? Infinity;
    this.rng = mulberry32(this.opts.seed ?? Date.now() & 0xffffffff);
  }
}

export interface ReplayOptions {
  /** Pre-recorded ticks. */
  ticks: PriceTick[];
}

/** Replays a recorded tick array — backtesting's primary simulator. */
export class Replay implements PriceSimulator {
  private cursor = 0;
  constructor(private opts: ReplayOptions) {}
  next(): PriceTick | null {
    if (this.cursor >= this.opts.ticks.length) return null;
    return this.opts.ticks[this.cursor++] ?? null;
  }
  hasNext(): boolean {
    return this.cursor < this.opts.ticks.length;
  }
  reset(): void {
    this.cursor = 0;
  }
  size(): number {
    return this.opts.ticks.length;
  }
}

export interface JumpDiffusionOptions {
  base: PriceSimulator;
  /** Probability of a jump per step. */
  jumpProb: number;
  /** Mean of log-jump multiplier. 0 = no bias. */
  jumpMean?: number;
  /** Std of log-jump multiplier. e.g. 0.05 for ±5% jumps. */
  jumpStd?: number;
  seed?: number;
}

/** Wraps any simulator with Poisson jumps — useful for news shocks. */
export class JumpDiffusion implements PriceSimulator {
  private rng: () => number;
  constructor(private opts: JumpDiffusionOptions) {
    this.rng = mulberry32(opts.seed ?? Date.now() & 0xffffffff);
  }
  next(): PriceTick | null {
    const tick = this.opts.base.next();
    if (!tick) return null;
    if (this.rng() < this.opts.jumpProb) {
      const z = normal(this.rng);
      const logMult = (this.opts.jumpMean ?? 0) + (this.opts.jumpStd ?? 0.05) * z;
      tick.price = tick.price * Math.exp(logMult);
    }
    return tick;
  }
  hasNext(): boolean {
    return this.opts.base.hasNext?.() ?? true;
  }
  reset(): void {
    this.opts.base.reset?.();
  }
}

/** Run multiple simulators back-to-back: regime-shift scenarios. */
export class Composite implements PriceSimulator {
  private idx = 0;
  constructor(private parts: PriceSimulator[]) {}
  next(): PriceTick | null {
    while (this.idx < this.parts.length) {
      const tick = this.parts[this.idx]!.next();
      if (tick) return tick;
      this.idx += 1;
    }
    return null;
  }
  hasNext(): boolean {
    return this.idx < this.parts.length;
  }
  reset(): void {
    this.idx = 0;
    for (const p of this.parts) p.reset?.();
  }
}

export interface ScriptedShock {
  atStep: number;
  /** Multiplier applied to base.next().price at that step. >1 = pump, <1 = dump. */
  multiplier: number;
}

export interface ScriptedOptions {
  base: PriceSimulator;
  shocks: ScriptedShock[];
}

/** Base process + scripted multiplicative shocks at chosen steps. */
export class Scripted implements PriceSimulator {
  private step = 0;
  constructor(private opts: ScriptedOptions) {}
  next(): PriceTick | null {
    const tick = this.opts.base.next();
    if (!tick) return null;
    const shock = this.opts.shocks.find((s) => s.atStep === this.step);
    this.step += 1;
    if (shock) tick.price *= shock.multiplier;
    return tick;
  }
  hasNext(): boolean {
    return this.opts.base.hasNext?.() ?? true;
  }
  reset(): void {
    this.step = 0;
    this.opts.base.reset?.();
  }
}
