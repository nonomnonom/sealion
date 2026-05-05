import { Agent } from "@mastra/core/agent";
import type { AgentConfig, ToolsInput } from "@mastra/core/agent";
import { Channel } from "../platform/channel.ts";
import { TraderProfile } from "../platform/config/trader-info.ts";
import { ActionType, type ActionResult } from "../platform/typing.ts";
import { ALL_TOOL_ACTIONS, buildAgentTools } from "./agent-action.ts";
import { MarketEnvironment } from "./agent-environment.ts";

/**
 * Mastra's `Agent.generate` is overloaded across AI SDK v4 and v5 with subtly
 * different `ModelMessage` shapes. The exact options type isn't trivially
 * extractable, so callers in this file cast through `unknown` at the boundary.
 */

/** Mastra-compatible model. Accepts a string shorthand ("openai/gpt-4o-mini"),
 * an AI-SDK `LanguageModel`, or any value Mastra's model router accepts. */
export type ModelInput = NonNullable<AgentConfig["model"]>;

/** Mastra `Memory` (or compatible) — typed as the field on `AgentConfig`. */
export type MemoryInput = NonNullable<AgentConfig["memory"]>;

/** Mastra `scorers` config (per-agent, per-scorer config + sampling). */
export type ScorersInput = NonNullable<AgentConfig["scorers"]>;

export interface TradingAgentOptions {
  agentId: number;
  profile: TraderProfile;
  /** Required only when LLM-driven actions are used. Manual-only sims may omit. */
  model?: ModelInput;
  channel?: Channel;
  availableActions?: ActionType[];
  systemTemplate?: string;
  /** Extra Mastra tools merged with built-in trading tools. */
  extraTools?: ToolsInput;
  /** Max LLM tool-loop iterations per `performActionByLLM` call. Default 1. */
  maxIteration?: number;
  /** Mastra `Memory` instance — gives the trader a persistent journal. */
  memory?: MemoryInput;
  /** Resource ID used for memory scoping. Defaults to `trader-${agentId}`. */
  memoryResourceId?: string;
  /** Thread ID used for memory scoping. Defaults to `run-default`. */
  memoryThreadId?: string;
  /** Per-agent Mastra scorers attached for live evaluation. */
  scorers?: ScorersInput;
}

export class TradingAgent {
  agentId: number;
  profile: TraderProfile;
  channel: Channel;
  market: MarketEnvironment;
  availableActions: ActionType[];
  maxIteration: number;

  private model?: ModelInput;
  private systemTemplate?: string;
  private extraTools?: ToolsInput;
  private memory?: MemoryInput;
  private memoryResourceId: string;
  private memoryThreadId: string;
  private scorers?: ScorersInput;
  private cachedAgent: Agent | null = null;

  constructor(opts: TradingAgentOptions) {
    this.agentId = opts.agentId;
    this.profile = opts.profile;
    this.channel = opts.channel ?? new Channel();
    this.market = new MarketEnvironment(this.agentId, this.channel);
    this.maxIteration = opts.maxIteration ?? 1;
    this.model = opts.model;
    this.systemTemplate = opts.systemTemplate;
    this.extraTools = opts.extraTools;
    this.memory = opts.memory;
    this.memoryResourceId = opts.memoryResourceId ?? `trader-${opts.agentId}`;
    this.memoryThreadId = opts.memoryThreadId ?? "run-default";
    this.scorers = opts.scorers;

    this.availableActions = opts.availableActions?.length
      ? opts.availableActions
      : [...ALL_TOOL_ACTIONS];
  }

  /** Lazily-constructed underlying Mastra `Agent`. */
  get agent(): Agent {
    if (this.cachedAgent) return this.cachedAgent;
    if (!this.model) {
      throw new Error(
        `TradingAgent ${this.agentId} has no model — cannot run LLM actions. ` +
          "Pass `model` when constructing it (e.g. 'openai/gpt-4o-mini').",
      );
    }
    const tools: ToolsInput = {
      ...this.extraTools,
      ...buildAgentTools({ agentId: this.agentId, channel: this.channel }, this.availableActions),
    };
    const instructions = this.systemTemplate
      ? this.profile.toCustomSystemMessage(this.systemTemplate)
      : this.profile.toSystemMessage();
    const cfg: AgentConfig = {
      id: `sealion-trader-${this.agentId}`,
      name: this.profile.handle ?? this.profile.displayName ?? `Trader ${this.agentId}`,
      instructions,
      model: this.model,
      tools,
    };
    if (this.memory) cfg.memory = this.memory;
    if (this.scorers) cfg.scorers = this.scorers;
    this.cachedAgent = new Agent(cfg);
    return this.cachedAgent;
  }

  setChannel(channel: Channel): void {
    this.channel = channel;
    this.market = new MarketEnvironment(this.agentId, channel);
    this.cachedAgent = null;
  }

  async openAccount(): Promise<ActionResult> {
    this.channel.writeToReceiveQueue([
      this.agentId,
      {
        display_name: this.profile.displayName,
        handle: this.profile.handle,
        cash: this.profile.initialCash,
        position: this.profile.initialPosition,
      },
      ActionType.OPEN_ACCOUNT,
    ]);
    const { result } = await this.channel.readFromSendQueue(this.agentId);
    return result;
  }

  /**
   * Run one LLM turn: build the market context, call `agent.generate()`, return
   * the raw Mastra result. Tool calls during generation flow through `Channel`
   * → `Exchange` like any other action. On generate failure, logs to stderr
   * and returns `{ error }` — the run continues.
   */
  async performActionByLLM(): Promise<unknown> {
    const ctxText = await this.market.toTextPrompt();
    const userMsg =
      `New tick. Decide whether to act and which tool to call. Read your account ` +
      `and recent trades if you don't have fresh information.\n\n` +
      `Current market:\n${ctxText}`;
    const generateOpts: Record<string, unknown> = { maxSteps: this.maxIteration };
    if (this.memory) {
      generateOpts.memory = {
        resource: this.memoryResourceId,
        thread: this.memoryThreadId,
      };
    }
    try {
      return await this.agent.generate(userMsg, generateOpts as never);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const stack = e instanceof Error ? e.stack : undefined;
      console.error(
        `[sealion] TradingAgent ${this.agentId} (${this.profile.handle ?? ""}) ` +
          `generate() failed: ${message}`,
        stack ? `\n${stack}` : "",
      );
      return { error: message };
    }
  }

  async performActionByData(
    actionType: ActionType,
    actionArgs: Record<string, unknown> = {},
  ): Promise<ActionResult> {
    this.channel.writeToReceiveQueue([this.agentId, actionArgs, actionType]);
    const { result } = await this.channel.readFromSendQueue(this.agentId);
    return result;
  }

  async performInterview(prompt: string): Promise<unknown> {
    try {
      const generated = await this.agent.generate(prompt, { maxSteps: 1 } as never);
      const text = (generated as { text?: string }).text ?? "";
      const dispatchResult = await this.performActionByData(ActionType.INTERVIEW, {
        prompt,
        response: text,
      });
      return {
        agentId: this.agentId,
        prompt,
        content: text,
        success: dispatchResult.success,
      };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error(`[sealion] TradingAgent ${this.agentId} interview failed: ${error}`);
      return { agentId: this.agentId, prompt, error, success: false };
    }
  }

  toString(): string {
    return `TradingAgent(agent_id=${this.agentId}, handle=${this.profile.handle ?? ""})`;
  }
}
