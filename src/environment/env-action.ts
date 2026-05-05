import type { ActionType } from "../platform/typing.ts";

export class ManualAction {
  actionType: ActionType;
  actionArgs: Record<string, unknown>;

  constructor(opts: { actionType: ActionType; actionArgs?: Record<string, unknown> }) {
    this.actionType = opts.actionType;
    this.actionArgs = opts.actionArgs ?? {};
  }
}

export class LLMAction {
  readonly kind = "llm" as const;
}

export type AnyAction = ManualAction | LLMAction;
