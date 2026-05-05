export interface TraderPersonaBlock {
  style?: string;
  riskTolerance?: "low" | "medium" | "high";
  horizon?: "scalp" | "intraday" | "swing" | "position";
  thesis?: string;
  beliefs?: string[];
  bias?: "bull" | "bear" | "neutral";
  [key: string]: unknown;
}

export interface TraderNodeData {
  trader_id?: number | string;
  trader_index?: number;
  display_name?: string;
  handle?: string;
  initial_cash?: number;
  initial_position?: number;
  persona?: TraderPersonaBlock;
  description?: string;
  [key: string]: unknown;
}

const DEFAULT_TEMPLATE = `# OBJECTIVE
You are an autonomous market trader. Use the available tools to observe the market and trade. Stay in-character and act consistently with your strategy and risk profile. You will be evaluated on realized P&L over the simulation horizon.

# YOUR PROFILE
{description}

# RESPONSE METHOD
Each turn, you may call AT MOST ONE action tool (place an order, cancel an order, query data, or do_nothing). Always check the orderbook, your account, and recent trades before placing a new order. Prefer small position sizes and limit orders over market orders unless urgency is justified by your thesis. Never trade on information you don't have.`;

export class TraderProfile {
  displayName?: string;
  handle?: string;
  initialCash: number;
  initialPosition: number;
  description?: string;
  persona?: TraderPersonaBlock;

  constructor(
    opts: {
      displayName?: string;
      handle?: string;
      initialCash?: number;
      initialPosition?: number;
      description?: string;
      persona?: TraderPersonaBlock;
    } = {},
  ) {
    this.displayName = opts.displayName;
    this.handle = opts.handle;
    this.initialCash = opts.initialCash ?? 10_000;
    this.initialPosition = opts.initialPosition ?? 0;
    this.description = opts.description;
    this.persona = opts.persona;
  }

  toSystemMessage(template: string = DEFAULT_TEMPLATE): string {
    return template.replace("{description}", this.buildDescription());
  }

  toCustomSystemMessage(template: string): string {
    return this.toSystemMessage(template);
  }

  private buildDescription(): string {
    const parts: string[] = [];
    if (this.displayName) parts.push(`Name: ${this.displayName}`);
    if (this.handle) parts.push(`Handle: @${this.handle}`);
    parts.push(`Starting cash: ${this.initialCash}`);
    parts.push(`Starting position: ${this.initialPosition}`);
    if (this.persona) {
      const p = this.persona;
      if (p.style) parts.push(`Style: ${p.style}`);
      if (p.riskTolerance) parts.push(`Risk tolerance: ${p.riskTolerance}`);
      if (p.horizon) parts.push(`Time horizon: ${p.horizon}`);
      if (p.bias) parts.push(`Directional bias: ${p.bias}`);
      if (p.thesis) parts.push(`Trading thesis: ${p.thesis}`);
      if (p.beliefs?.length) parts.push(`Beliefs: ${p.beliefs.join("; ")}`);
    }
    if (this.description) parts.push(this.description);
    return parts.join("\n");
  }

  static fromNode(node: TraderNodeData): TraderProfile {
    return new TraderProfile({
      displayName: node.display_name,
      handle: node.handle,
      initialCash: node.initial_cash,
      initialPosition: node.initial_position,
      description: node.description,
      persona: node.persona,
    });
  }
}

export { DEFAULT_TEMPLATE };
