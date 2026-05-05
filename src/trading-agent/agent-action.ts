import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { Channel } from "../platform/channel.ts";
import { ActionType, OrderSide, type ActionResult } from "../platform/typing.ts";

export interface AgentToolContext {
  agentId: number;
  channel: Channel;
}

async function dispatch(
  ctx: AgentToolContext,
  action: ActionType,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  ctx.channel.writeToReceiveQueue([ctx.agentId, payload, action]);
  const { result } = await ctx.channel.readFromSendQueue(ctx.agentId);
  return result;
}

const sideSchema = z.enum([OrderSide.BUY, OrderSide.SELL]);
const biasSchema = z.enum(["bull", "bear", "neutral"]);

export function buildAgentTools(ctx: AgentToolContext, allowed: ActionType[]) {
  const all = {
    [ActionType.PLACE_LIMIT_ORDER]: createTool({
      id: ActionType.PLACE_LIMIT_ORDER,
      description:
        "Place a limit order at a specific price. Order rests on the book if it doesn't immediately cross.",
      inputSchema: z.object({
        side: sideSchema,
        price: z.number().positive(),
        size: z.number().positive(),
      }),
      execute: async (input) => dispatch(ctx, ActionType.PLACE_LIMIT_ORDER, input),
    }),

    [ActionType.PLACE_MARKET_ORDER]: createTool({
      id: ActionType.PLACE_MARKET_ORDER,
      description:
        "Place a market order. Crosses the book at the best available price. Use sparingly — pays taker fee and risks slippage.",
      inputSchema: z.object({
        side: sideSchema,
        size: z.number().positive(),
      }),
      execute: async (input) => dispatch(ctx, ActionType.PLACE_MARKET_ORDER, input),
    }),

    [ActionType.CANCEL_ORDER]: createTool({
      id: ActionType.CANCEL_ORDER,
      description: "Cancel one of your working orders by its order_id.",
      inputSchema: z.object({ order_id: z.number().int() }),
      execute: async (input) => dispatch(ctx, ActionType.CANCEL_ORDER, input),
    }),

    [ActionType.CANCEL_ALL_ORDERS]: createTool({
      id: ActionType.CANCEL_ALL_ORDERS,
      description: "Cancel all of your working orders at once.",
      execute: async () => dispatch(ctx, ActionType.CANCEL_ALL_ORDERS, {}),
    }),

    [ActionType.GET_ORDERBOOK]: createTool({
      id: ActionType.GET_ORDERBOOK,
      description: "Read the current order book (top N price levels) and the last mark price.",
      inputSchema: z.object({ depth: z.number().int().positive().max(50).default(10) }),
      execute: async (input) => dispatch(ctx, ActionType.GET_ORDERBOOK, input),
    }),

    [ActionType.GET_RECENT_TRADES]: createTool({
      id: ActionType.GET_RECENT_TRADES,
      description: "Read the most recent public trades (the tape).",
      inputSchema: z.object({ limit: z.number().int().positive().max(200).default(20) }),
      execute: async (input) => dispatch(ctx, ActionType.GET_RECENT_TRADES, input),
    }),

    [ActionType.GET_ACCOUNT]: createTool({
      id: ActionType.GET_ACCOUNT,
      description:
        "Inspect your own account: cash, position, average entry, realized + unrealized P&L, equity.",
      execute: async () => dispatch(ctx, ActionType.GET_ACCOUNT, {}),
    }),

    [ActionType.GET_OPEN_ORDERS]: createTool({
      id: ActionType.GET_OPEN_ORDERS,
      description: "List your currently working (open or partially filled) orders.",
      execute: async () => dispatch(ctx, ActionType.GET_OPEN_ORDERS, {}),
    }),

    [ActionType.DO_NOTHING]: createTool({
      id: ActionType.DO_NOTHING,
      description: "Skip this turn without trading.",
      execute: async () => dispatch(ctx, ActionType.DO_NOTHING, {}),
    }),

    [ActionType.COPY_TRADE]: createTool({
      id: ActionType.COPY_TRADE,
      description:
        "Start copying another trader's orders. Your account will automatically mirror their trades at the specified ratio.",
      inputSchema: z.object({
        leader_id: z.number().int().nonnegative(),
        ratio: z.number().positive().max(1).default(1.0),
      }),
      execute: async (input) => dispatch(ctx, ActionType.COPY_TRADE, input),
    }),

    [ActionType.UNFOLLOW]: createTool({
      id: ActionType.UNFOLLOW,
      description: "Stop copying the trader you are currently following.",
      execute: async () => dispatch(ctx, ActionType.UNFOLLOW, {}),
    }),

    [ActionType.GET_SIGNALS]: createTool({
      id: ActionType.GET_SIGNALS,
      description: "Read recent market signals shared by other traders.",
      inputSchema: z.object({ limit: z.number().int().positive().max(200).default(50) }),
      execute: async (input) => dispatch(ctx, ActionType.GET_SIGNALS, input),
    }),

    [ActionType.SHARE_SIGNAL]: createTool({
      id: ActionType.SHARE_SIGNAL,
      description: "Share a market analysis or signal with other traders.",
      inputSchema: z.object({
        content: z.string().min(1),
        symbol: z.string().optional(),
        bias: biasSchema.optional(),
      }),
      execute: async (input) => dispatch(ctx, ActionType.SHARE_SIGNAL, input),
    }),
  } as const;

  const out: Record<string, (typeof all)[keyof typeof all]> = {};
  for (const action of allowed) {
    const tool = all[action as keyof typeof all];
    if (tool) out[action] = tool;
  }
  return out;
}

/** All actions that have a tool exposed to LLM agents. */
export const ALL_TOOL_ACTIONS: readonly ActionType[] = [
  ActionType.PLACE_LIMIT_ORDER,
  ActionType.PLACE_MARKET_ORDER,
  ActionType.CANCEL_ORDER,
  ActionType.CANCEL_ALL_ORDERS,
  ActionType.GET_ORDERBOOK,
  ActionType.GET_RECENT_TRADES,
  ActionType.GET_ACCOUNT,
  ActionType.GET_OPEN_ORDERS,
  ActionType.DO_NOTHING,
  ActionType.COPY_TRADE,
  ActionType.UNFOLLOW,
  ActionType.GET_SIGNALS,
  ActionType.SHARE_SIGNAL,
] as const;
