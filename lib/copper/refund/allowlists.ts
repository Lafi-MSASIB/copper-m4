// Which tools each agent may use, as explicit lists. This is the one place the
// sharing between the two agents is decided, so it is easy to review. It has no
// server code in it, so the chat panel can import it to show each agent's tools.
// router.ts uses these lists to hand each agent its tools and to refuse any
// other tool when it runs.

export type AgentId = "copper" | "refund";

/**
 * The tools both agents may use. Only read-only tools that change nothing may
 * be shared. Today that is exactly one: search_docs.
 */
export const SHARED_TOOLS = ["search_docs"] as const;

export const COPPER_TOOLS = [
  "get_products",
  "get_prices",
  "calculate_cost",
  "check_availability",
  "handoff_to_refund_agent",
  ...SHARED_TOOLS,
] as const;

export const REFUND_TOOLS = [
  "lookup_order",
  "request_refund",
  "check_refund_status",
  "handoff_back_to_copper",
  ...SHARED_TOOLS,
] as const;

export const ALLOWLISTS: Record<AgentId, readonly string[]> = {
  copper: COPPER_TOOLS,
  refund: REFUND_TOOLS,
};

export const AGENT_NAMES: Record<AgentId, string> = {
  copper: "Copper",
  refund: "Refund agent",
};

export function isToolAllowed(agent: AgentId, tool: string): boolean {
  return ALLOWLISTS[agent].includes(tool);
}
