import type { MarketSpec } from "../platform/typing.ts";

interface PresetOptsBase {
  symbol: string;
  baseAsset?: string;
  quoteAsset?: string;
  tickSize?: number;
  lotSize?: number;
  takerFeeBps?: number;
  makerFeeBps?: number;
}

interface PresetDefaults {
  tickSize: number;
  lotSize: number;
  takerFeeBps: number;
  makerFeeBps: number;
  /** Used as `quoteAsset` fallback when the symbol doesn't carry one. */
  defaultQuoteAsset: string;
}

function buildSpec(opts: PresetOptsBase, defaults: PresetDefaults): MarketSpec {
  const [base, quote] = opts.symbol.includes("/")
    ? opts.symbol.split("/")
    : [opts.symbol, defaults.defaultQuoteAsset];
  return {
    symbol: opts.symbol,
    baseAsset: opts.baseAsset ?? base ?? opts.symbol,
    quoteAsset: opts.quoteAsset ?? quote ?? defaults.defaultQuoteAsset,
    tickSize: opts.tickSize ?? defaults.tickSize,
    lotSize: opts.lotSize ?? defaults.lotSize,
    takerFeeBps: opts.takerFeeBps ?? defaults.takerFeeBps,
    makerFeeBps: opts.makerFeeBps ?? defaults.makerFeeBps,
  };
}

/**
 * Build a `MarketSpec` for a generic spot pair. Use when you'd otherwise reach
 * for a "default" — Sealion intentionally exposes no global default so that
 * fees, tick size, and lot size are always explicit at the call site.
 *
 * @example
 * ```ts
 * const market = spotPreset({ symbol: "BTC/USDT" });
 * const cheap = spotPreset({ symbol: "BTC/USDT", takerFeeBps: 1, makerFeeBps: 0 });
 * ```
 */
export function spotPreset(opts: PresetOptsBase): MarketSpec {
  return buildSpec(opts, {
    tickSize: 0.01,
    lotSize: 0.0001,
    takerFeeBps: 7,
    makerFeeBps: 2,
    defaultQuoteAsset: "QUOTE",
  });
}

/**
 * Perpetual-swap-styled `MarketSpec` — tighter tick, smaller lot, lower fees.
 * Funding-rate logic isn't baked in; wire it via a `PriceSimulator` if needed.
 */
export function perpPreset(opts: PresetOptsBase): MarketSpec {
  return buildSpec(opts, {
    tickSize: 0.1,
    lotSize: 0.001,
    takerFeeBps: 5,
    makerFeeBps: 2,
    defaultQuoteAsset: "QUOTE",
  });
}

/** Equity-styled `MarketSpec` — wider tick, integer-share lot, flat fees. */
export function equityPreset(opts: Omit<PresetOptsBase, "baseAsset" | "quoteAsset">): MarketSpec {
  return buildSpec(opts, {
    tickSize: 0.01,
    lotSize: 1,
    takerFeeBps: 3,
    makerFeeBps: 3,
    defaultQuoteAsset: "USD",
  });
}

/** Pure escape hatch — full control over every field. */
export function customMarket(spec: MarketSpec): MarketSpec {
  return { ...spec };
}
