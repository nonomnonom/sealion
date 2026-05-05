import type { TradingAgent } from "./agent.ts";

/**
 * `TraderGraph` — registry of trading agents with optional copy-trade edges.
 *
 * - Nodes are trading agents (`TradingAgent`).
 * - Edges encode copy-trade relationships, directed leader → follower.
 * - A follower may copy at most one leader at a time.
 *
 * For flat-collection use, just call `addAgent` / `getAgent` / `getAgents`.
 * Edges are entirely optional.
 *
 * @example
 * ```ts
 * const traders = new TraderGraph();
 * traders.addAgent(new TradingAgent({ agentId: 0, profile, model: "openai/gpt-4o-mini" }));
 * traders.addAgent(new TradingAgent({ agentId: 1, profile, model: "openai/gpt-4o-mini" }));
 * traders.addEdge(0, 1, 0.5); // agent 1 copies agent 0 at 50% size
 * ```
 */
export class TraderGraph {
  private agents: Map<number, TradingAgent> = new Map();
  private leaderToFollowers: Map<number, Set<number>> = new Map();
  private followerToLeader: Map<number, number> = new Map();
  private copyRatios: Map<string, number> = new Map(); // "leaderId:followerId" → ratio

  // ── Nodes ───────────────────────────────────────────────────────────────

  addAgent(agent: TradingAgent): void {
    this.agents.set(agent.agentId, agent);
  }

  removeAgent(agent: TradingAgent | number): void {
    const id = typeof agent === "number" ? agent : agent.agentId;
    this.removeAllEdgesForAgent(id);
    this.agents.delete(id);
  }

  getAgent(agentId: number): TradingAgent {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Trader ${agentId} not in graph`);
    return agent;
  }

  /** Returns `[id, agent]` tuples. With `agentIds`, returns only the requested ids. */
  getAgents(agentIds?: number[]): Array<[number, TradingAgent]> {
    if (agentIds) return agentIds.map((id) => [id, this.getAgent(id)]);
    return [...this.agents.entries()];
  }

  hasAgent(agentId: number): boolean {
    return this.agents.has(agentId);
  }

  getNumNodes(): number {
    return this.agents.size;
  }

  // ── Edges (copy-trade) ──────────────────────────────────────────────────

  /** Add a copy-trade edge: follower mirrors leader at `ratio`. Replaces existing. */
  addEdge(leaderId: number, followerId: number, ratio = 1.0): void {
    if (!this.agents.has(leaderId)) throw new Error(`Leader ${leaderId} not in graph`);
    if (!this.agents.has(followerId)) throw new Error(`Follower ${followerId} not in graph`);
    if (leaderId === followerId) throw new Error("Agent cannot copy itself");

    if (this.followerToLeader.has(followerId)) this.removeEdge(followerId);

    if (!this.leaderToFollowers.has(leaderId)) {
      this.leaderToFollowers.set(leaderId, new Set());
    }
    this.leaderToFollowers.get(leaderId)!.add(followerId);
    this.followerToLeader.set(followerId, leaderId);
    this.copyRatios.set(`${leaderId}:${followerId}`, ratio);
  }

  /** Remove the copy edge for `followerId` (no-op if none). */
  removeEdge(followerId: number): void {
    const leaderId = this.followerToLeader.get(followerId);
    if (leaderId === undefined) return;
    this.followerToLeader.delete(followerId);
    this.leaderToFollowers.get(leaderId)?.delete(followerId);
    this.copyRatios.delete(`${leaderId}:${followerId}`);
  }

  getEdges(): Array<[leaderId: number, followerId: number, ratio: number]> {
    const out: Array<[number, number, number]> = [];
    for (const [followerId, leaderId] of this.followerToLeader) {
      out.push([leaderId, followerId, this.copyRatios.get(`${leaderId}:${followerId}`) ?? 1]);
    }
    return out;
  }

  getNumEdges(): number {
    return this.followerToLeader.size;
  }

  // ── Edge queries ────────────────────────────────────────────────────────

  getFollowers(leaderId: number): TradingAgent[] {
    const ids = this.leaderToFollowers.get(leaderId);
    if (!ids) return [];
    return [...ids]
      .map((id) => this.agents.get(id))
      .filter((a): a is TradingAgent => a !== undefined);
  }

  getFollowerIds(leaderId: number): number[] {
    const ids = this.leaderToFollowers.get(leaderId);
    return ids ? [...ids] : [];
  }

  getLeader(followerId: number): TradingAgent | null {
    const leaderId = this.followerToLeader.get(followerId);
    if (leaderId === undefined) return null;
    return this.agents.get(leaderId) ?? null;
  }

  getCopyRatio(leaderId: number, followerId: number): number {
    return this.copyRatios.get(`${leaderId}:${followerId}`) ?? 1;
  }

  isCopying(agentId: number): boolean {
    return this.followerToLeader.has(agentId);
  }

  isLeader(agentId: number): boolean {
    const set = this.leaderToFollowers.get(agentId);
    return set !== undefined && set.size > 0;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  reset(): void {
    this.agents.clear();
    this.leaderToFollowers.clear();
    this.followerToLeader.clear();
    this.copyRatios.clear();
  }

  private removeAllEdgesForAgent(agentId: number): void {
    const followerIds = this.leaderToFollowers.get(agentId);
    if (followerIds) {
      for (const fid of followerIds) {
        this.followerToLeader.delete(fid);
        this.copyRatios.delete(`${agentId}:${fid}`);
      }
      this.leaderToFollowers.delete(agentId);
    }
    const leaderId = this.followerToLeader.get(agentId);
    if (leaderId !== undefined) {
      this.followerToLeader.delete(agentId);
      this.leaderToFollowers.get(leaderId)?.delete(agentId);
      this.copyRatios.delete(`${leaderId}:${agentId}`);
    }
  }
}
