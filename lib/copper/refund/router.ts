// The router: which instructions and which tools the active agent gets.
//
// The allowlists (allowlists.ts) say who may use what. Here they are enforced
// twice: an agent is only handed its own tools, and every tool checks again at
// the moment it runs that it belongs to the agent the server says is active.
// A tool outside the list is refused and logged, whatever the chat says.
import type { ToolSet } from "ai";
import { COPPER_INSTRUCTIONS } from "@/lib/copper/assistant/instructions";
import {
  copperTools,
  makeHandoffToRefundAgent,
} from "@/lib/copper/assistant/tools";
import {
  ALLOWLISTS,
  type AgentId,
  isToolAllowed,
} from "@/lib/copper/refund/allowlists";
import { REFUND_INSTRUCTIONS } from "@/lib/copper/refund/instructions";
import { getChatState, logEvent } from "@/lib/copper/refund/store";
import { type AgentContext, makeRefundTools } from "@/lib/copper/refund/tools";

export {
  AGENT_NAMES,
  ALLOWLISTS,
  COPPER_TOOLS,
  REFUND_TOOLS,
  SHARED_TOOLS,
  isToolAllowed,
  type AgentId,
} from "@/lib/copper/refund/allowlists";

type AnyTool = ToolSet[string];

/** Every tool that exists, built for this chat. The allowlists decide who gets which. */
function everyTool(ctx: AgentContext): Record<string, AnyTool> {
  return {
    ...copperTools,
    handoff_to_refund_agent: makeHandoffToRefundAgent(ctx),
    ...makeRefundTools(ctx),
  };
}

const ACTOR = { copper: "copper", refund: "refund_agent" } as const;

/** Wraps a tool so it checks the allowlist, and the active agent, each time it runs. */
function guarded(
  agent: AgentId,
  name: string,
  ctx: AgentContext,
  original: AnyTool,
): AnyTool {
  const run = original.execute;
  if (!run) return original;
  return {
    ...original,
    execute: async (input: unknown, options: never) => {
      const active = (await getChatState(ctx.chatId)).activeAgent;
      if (!isToolAllowed(agent, name) || active !== agent) {
        await logEvent({
          actor: ACTOR[agent],
          event: "tool_refused",
          details: { tool: name, active_agent: active },
        });
        return {
          status: "refused",
          message: `The ${name} tool isn't available right now.`,
        };
      }
      return run(input as never, options);
    },
  } as AnyTool;
}

/** The tools an agent may use, each guarded. */
export function toolsFor(agent: AgentId, ctx: AgentContext): ToolSet {
  const all = everyTool(ctx);
  return Object.fromEntries(
    ALLOWLISTS[agent].map((name) => [
      name,
      guarded(agent, name, ctx, all[name]),
    ]),
  );
}

export const INSTRUCTIONS: Record<AgentId, string> = {
  copper: COPPER_INSTRUCTIONS,
  refund: REFUND_INSTRUCTIONS,
};

/** Everything the active agent runs with: its instructions and its tools. */
export function harnessFor(agent: AgentId, ctx: AgentContext) {
  return { instructions: INSTRUCTIONS[agent], tools: toolsFor(agent, ctx) };
}

/** The tool that hands the chat to the other agent, so the app can stop on it. */
export const HANDOFF_TOOLS = [
  "handoff_to_refund_agent",
  "handoff_back_to_copper",
] as const;
