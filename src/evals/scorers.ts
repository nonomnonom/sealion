/**
 * Lightweight scorer factories for evaluating LLM trader decisions.
 *
 * Sealion's scorers follow Mastra's scorer interface shape — they return an
 * object with `id`, `description`, and an async `run()` that yields a numeric
 * score (0..1) plus an optional `reason`. They can be plugged directly into
 * `new Agent({ scorers: { ... } })` once converted via `createScorer` from
 * `@mastra/evals`, or used standalone for offline batch evaluation.
 */

import type { Database } from "bun:sqlite";
import { computeMetrics } from "../metrics.ts";

export interface ScoredResult {
  score: number;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface PnLScorerOptions {
  /** Final equity floor that maps to score=0 (e.g. starting equity). */
  baselineEquity: number;
  /** Final equity that maps to score=1 (e.g. starting × 1.5). */
  targetEquity: number;
}

/**
 * Score a trader's run by realized P&L. Maps `[baseline → target]` linearly
 * onto `[0 → 1]`, clamped. Useful as a Mastra `live` scorer attached to a
 * trading agent — it tells you "did this run succeed by P&L?".
 */
export function createPnLScorer(opts: PnLScorerOptions) {
  return {
    id: "sealion-pnl",
    description: "Score by final equity vs baseline/target equity.",
    run: async (input: {
      db: Database;
      agentId: number;
      startingCash: number;
      startingPosition?: number;
    }): Promise<ScoredResult> => {
      const m = computeMetrics(input.db, input.agentId, input.startingCash, {
        startingPosition: input.startingPosition,
      });
      const range = opts.targetEquity - opts.baselineEquity;
      if (range === 0) return { score: 0, reason: "baseline equals target" };
      const raw = (m.finalEquity - opts.baselineEquity) / range;
      const score = Math.max(0, Math.min(1, raw));
      return {
        score,
        reason: `final equity ${m.finalEquity.toFixed(2)} vs baseline ${opts.baselineEquity}, target ${opts.targetEquity}`,
        metadata: {
          totalReturnPct: m.totalReturnPct,
          sharpe: m.sharpe,
          maxDrawdownPct: m.maxDrawdownPct,
          numTrades: m.numTrades,
        },
      };
    },
  };
}

/**
 * Heuristic check: did the agent's trading direction stay consistent with
 * its persona's `bias`? Returns 1 when net buying matches a `"bull"` bias
 * or net selling matches a `"bear"` bias; 0.5 for neutral; lower otherwise.
 */
export function createPersonaConsistencyScorer() {
  return {
    id: "sealion-persona-consistency",
    description: "Score by alignment between persona bias and trade direction.",
    run: async (input: {
      db: Database;
      agentId: number;
      bias: "bull" | "bear" | "neutral" | undefined;
    }): Promise<ScoredResult> => {
      const rows = input.db
        .query<
          { taker_side: string; size: number; buy_agent_id: number; sell_agent_id: number },
          [number, number]
        >(
          `SELECT taker_side, size, buy_agent_id, sell_agent_id
           FROM trade WHERE buy_agent_id = ? OR sell_agent_id = ?`,
        )
        .all(input.agentId, input.agentId);
      let bought = 0;
      let sold = 0;
      for (const r of rows) {
        if (r.buy_agent_id === input.agentId) bought += r.size;
        if (r.sell_agent_id === input.agentId) sold += r.size;
      }
      const total = bought + sold;
      if (total === 0) return { score: 0.5, reason: "no trades" };
      const skew = (bought - sold) / total; // ∈ [-1, 1] — positive = net buying
      let score: number;
      switch (input.bias) {
        case "bull":
          score = (skew + 1) / 2; // 1 when only buying, 0 when only selling
          break;
        case "bear":
          score = (1 - skew) / 2; // 1 when only selling, 0 when only buying
          break;
        default:
          score = 1 - Math.abs(skew); // 1 when balanced, 0 at extremes
      }
      return {
        score: Math.max(0, Math.min(1, score)),
        reason: `bought=${bought}, sold=${sold}, bias=${input.bias ?? "n/a"}`,
      };
    },
  };
}
