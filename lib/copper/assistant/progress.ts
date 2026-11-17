// What Ask Copper is doing, step by step, as it streams in: Gemini's thinking
// summaries, each tool call (with what went in and what came out), and the
// reply. The panel draws this as it changes.

import type { AgentId } from "@/lib/copper/refund/allowlists";

export type ThinkingStep = { type: "thinking"; text: string };

export type ToolStep = {
  type: "tool";
  id: string;
  name: string;
  /** "calling" until the tool's result comes back. */
  state: "calling" | "done" | "error";
  input?: unknown;
  output?: unknown;
};

export type Step = ThinkingStep | ToolStep;

export type Progress = {
  steps: Step[];
  reply: string;
  status: "working" | "done" | "error";
  /** Which agent is answering (Module 4). Absent when nothing is routed. */
  agent?: AgentId;
  /** Which agent the chat belongs to for the next message, once this one is done. */
  activeAfter?: AgentId;
};

/** Every tool call in an answer, in order. */
export function toolCallsOf(progress: Progress) {
  return progress.steps
    .filter((step): step is ToolStep => step.type === "tool")
    .map(({ name, input, output }) => ({ name, input, output }));
}

/**
 * The tools Copper can use, and what each one does in plain English. The chat
 * panel lists these, so it lives here (and not in tools.ts, which reads the
 * database and can't be imported by a client component).
 */
export const TOOL_LABELS: Record<string, string> = {
  get_products: "Listing the products",
  get_prices: "Looking up prices",
  calculate_cost: "Working out the cost",
  check_availability: "Checking stock",
  search_docs: "Searching the documents",
  handoff_to_refund_agent: "Handing over to the Refund agent",
  lookup_order: "Looking up the order",
  request_refund: "Requesting the refund",
  check_refund_status: "Checking the refund's status",
  handoff_back_to_copper: "Handing back to Copper",
};
