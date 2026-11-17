// The Refund agent's own tools. They are built for one chat, with that chat's
// customer already filled in by the server, so the model never chooses who it is
// helping. Each tool returns plain data and a short message; the rules (the
// limit, ownership, no double refunds) are in rules.ts and store.ts, not here.
// The Console's approve, reject and limit actions are NOT here: no agent can
// reach them.
import { tool } from "ai";
import { z } from "zod";
import { StoreUnavailableError } from "@/lib/copper/refund/db";
import {
  centsToUsd,
  type Order,
  type RequestStatus,
  validateReason,
} from "@/lib/copper/refund/rules";
import {
  findOrderForCustomer,
  getRefundStatus,
  logEvent,
  requestRefund,
  setActiveAgent,
} from "@/lib/copper/refund/store";

/** Who the tools act for. Set by the server from the chat's saved state. */
export type AgentContext = { chatId: string; customerId: string };

const orderId = z
  .string()
  .trim()
  .regex(/^ord_[A-Za-z0-9]{1,24}$/, "An order number looks like ord_1001.")
  .describe("The order number, like ord_1001.");

const NOT_FOUND = "I couldn't find that order on your account.";
const UNAVAILABLE =
  "The order system can't be reached right now. Please try again soon.";

/** Lets a tool say "the order system is down" instead of crashing the chat. */
async function safely<T>(run: () => Promise<T>) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof StoreUnavailableError) {
      return { status: "unavailable" as const, message: UNAVAILABLE };
    }
    console.error(
      `[refund-agent] ${error instanceof Error ? error.message : String(error)}`,
    );
    return { status: "unavailable" as const, message: UNAVAILABLE };
  }
}

const describeOrder = (order: Order) => ({
  id: order.id,
  item: order.item,
  amountText: centsToUsd(order.amount_cents),
  orderStatus: order.status,
});

const REQUEST_MESSAGES: Record<RequestStatus, string> = {
  pending_approval: "Waiting for a team member to review it.",
  approved: "A team member approved the refund, and the order is refunded.",
  rejected: "A team member reviewed the request and did not approve it.",
  auto_approved: "The refund was processed automatically.",
};

export function makeRefundTools({ chatId, customerId }: AgentContext) {
  return {
    lookup_order: tool({
      description:
        "Looks up one of the customer's orders by order number. Returns the item, the amount and the order's status, or says it couldn't find the order.",
      inputSchema: z.object({ orderId }),
      execute: async ({ orderId }) =>
        safely(async () => {
          const order = await findOrderForCustomer(orderId, customerId);
          return order
            ? { status: "ok" as const, order: describeOrder(order) }
            : { status: "not_found" as const, message: NOT_FOUND };
        }),
    }),

    request_refund: tool({
      description:
        "Asks for a refund on one order. This is the only way a refund starts. The result says whether it was refunded, is waiting for a team member's approval, or was already handled. Never promise an outcome before this returns.",
      inputSchema: z.object({
        orderId,
        reason: z
          .string()
          .trim()
          .min(3, "A short reason for the refund is needed.")
          .max(300)
          .describe("Why the customer wants the refund, in a few words."),
      }),
      execute: async (input) =>
        safely(async () => {
          const checked = validateReason(input.reason);
          if (!checked.ok) {
            return { status: "error" as const, message: checked.error };
          }
          const outcome = await requestRefund({
            customerId,
            orderId: input.orderId,
            reason: checked.reason,
          });
          switch (outcome.status) {
            case "not_found":
              return { status: "not_found" as const, message: NOT_FOUND };
            case "refunded":
              return {
                status: "refunded" as const,
                order: describeOrder(outcome.order),
                message: `The refund of ${centsToUsd(outcome.order.amount_cents)} has been issued.`,
              };
            case "awaiting_approval":
              return {
                status: "awaiting_approval" as const,
                order: describeOrder(outcome.order),
                message:
                  "A team member needs to review this refund. Nothing has been refunded yet.",
              };
            case "already":
              return {
                status: "already_handled" as const,
                order: describeOrder(outcome.order),
                message: outcome.request
                  ? REQUEST_MESSAGES[outcome.request.status]
                  : "A refund for that order has already been handled.",
              };
          }
        }),
    }),

    check_refund_status: tool({
      description:
        "Checks where a refund stands for one order, including a team member's decision. Use it whenever the customer asks about a refund's status.",
      inputSchema: z.object({ orderId }),
      execute: async ({ orderId }) =>
        safely(async () => {
          const found = await getRefundStatus(orderId, customerId);
          if (found.status === "not_found") {
            return { status: "not_found" as const, message: NOT_FOUND };
          }
          if (found.status === "no_request") {
            return {
              status: "no_request" as const,
              order: describeOrder(found.order),
              message: "No refund has been requested for that order yet.",
            };
          }
          return {
            status: "found" as const,
            order: describeOrder(found.order),
            requestStatus: found.request.status,
            decidedBy: found.request.decided_by,
            message: REQUEST_MESSAGES[found.request.status],
          };
        }),
    }),

    handoff_back_to_copper: tool({
      description:
        "Hands the chat back to Copper, the shopping assistant. Use it when the refund is dealt with, or the customer asks about anything other than refunds and refund policy.",
      inputSchema: z.object({}),
      execute: async () =>
        safely(async () => {
          await setActiveAgent(chatId, "copper");
          await logEvent({ actor: "refund_agent", event: "handoff_to_copper" });
          return {
            status: "ok" as const,
            message: "Handing the chat back to Copper.",
          };
        }),
    }),
  };
}
