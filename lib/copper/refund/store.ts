// Every read and write of orders, refund requests, the auto-refund limit, chat
// state and the audit log lives here, and nowhere else. The database is the
// source of truth: the chat only ever holds a copy, and the model re-reads state
// through tools. To use a different backend, change this file and db.ts.
//
// Part 1 is what the agents' tools may call. Part 2 is for the Refund Console
// only (actions.ts): the agents' tools never import it.
import { getDb, StoreUnavailableError } from "@/lib/copper/refund/db";
import {
  decideRefund,
  isValidLimitCents,
  type Order,
  type OrderStatus,
  type RefundRequest,
  type RequestStatus,
} from "@/lib/copper/refund/rules";

import type { AgentId } from "@/lib/copper/refund/allowlists";

export type { AgentId };
export type Actor = "copper" | "refund_agent" | "system" | "human";

/**
 * There is no login, so every chat belongs to this one demo customer. It is
 * decided here on the server: neither the chat text nor the browser can
 * choose or change it.
 */
export const DEMO_CUSTOMER = { id: "cust_demo", name: "Maya Torres" } as const;

// A loose type for rows coming back from the database.
type Row = Record<string, unknown>;

function db() {
  const client = getDb();
  if (!client) throw new StoreUnavailableError();
  return client;
}

function fail(error: { message: string } | null): asserts error is null {
  if (error) throw new Error(error.message);
}

export async function logEvent(entry: {
  actor: Actor;
  event: string;
  orderId?: string | null;
  details?: Record<string, unknown>;
}): Promise<void> {
  const { error } = await db()
    .from("audit_log")
    .insert({
      actor: entry.actor,
      event: entry.event,
      order_id: entry.orderId ?? null,
      details: entry.details ?? {},
    });
  fail(error);
}

// ---------------------------------------------------------------------------
// Part 1: what the agents' tools may use
// ---------------------------------------------------------------------------

/** The automatic-refund limit, read from the database at the moment of the call. */
export async function getLimitCents(): Promise<number> {
  const { data, error } = await db()
    .from("settings")
    .select("auto_refund_limit_cents")
    .eq("id", true)
    .maybeSingle();
  fail(error);
  // No row means nothing has set a limit: send everything to a person.
  const limit = (data as Row | null)?.auto_refund_limit_cents;
  return isValidLimitCents(limit) ? limit : 0;
}

export type ChatState = {
  chatId: string;
  customerId: string;
  activeAgent: AgentId;
};

/** This chat's state. A chat the server hasn't seen starts with Copper. */
export async function getChatState(chatId: string): Promise<ChatState> {
  const client = db();
  const read = async () => {
    const { data, error } = await client
      .from("chat_state")
      .select("chat_id, customer_id, active_agent")
      .eq("chat_id", chatId)
      .maybeSingle();
    fail(error);
    return data as Row | null;
  };
  let row = await read();
  if (!row) {
    const { error } = await client.from("chat_state").upsert(
      {
        chat_id: chatId,
        customer_id: DEMO_CUSTOMER.id,
        active_agent: "copper",
      },
      { onConflict: "chat_id", ignoreDuplicates: true },
    );
    fail(error);
    row = await read();
  }
  return {
    chatId,
    customerId: String(row?.customer_id ?? DEMO_CUSTOMER.id),
    activeAgent: row?.active_agent === "refund" ? "refund" : "copper",
  };
}

export async function setActiveAgent(
  chatId: string,
  agent: AgentId,
): Promise<void> {
  const { error } = await db()
    .from("chat_state")
    .update({ active_agent: agent, updated_at: new Date().toISOString() })
    .eq("chat_id", chatId);
  fail(error);
}

/** The order, only if it belongs to this customer. Someone else's order is just "not found". */
export async function findOrderForCustomer(
  orderId: string,
  customerId: string,
): Promise<Order | null> {
  const { data, error } = await db()
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .eq("customer_id", customerId)
    .maybeSingle();
  fail(error);
  return (data as Order | null) ?? null;
}

async function findRequestByOrder(
  orderId: string,
): Promise<RefundRequest | null> {
  const { data, error } = await db()
    .from("refund_requests")
    .select("*")
    .eq("order_id", orderId)
    .maybeSingle();
  fail(error);
  return (data as RefundRequest | null) ?? null;
}

export type RefundOutcome =
  | { status: "not_found" }
  | { status: "refunded"; order: Order }
  | { status: "awaiting_approval"; order: Order }
  /** Already handled: nothing new was created, this is how it stands. */
  | {
      status: "already";
      order: Order;
      orderStatus: OrderStatus;
      request: RefundRequest | null;
    };

const UNIQUE_VIOLATION = "23505";

/**
 * The one way a refund starts. The rules are in rules.ts; this carries them out:
 * it reads the limit now, and every change is a compare-and-set (an update that
 * only succeeds while the row is still in the expected state), so asking twice
 * can never refund twice or queue a second request.
 */
export async function requestRefund(input: {
  customerId: string;
  orderId: string;
  reason: string;
}): Promise<RefundOutcome> {
  const { customerId, orderId, reason } = input;
  const order = await findOrderForCustomer(orderId, customerId);
  const limitCents = await getLimitCents();
  const decision = decideRefund({ order, customerId, limitCents });

  if (decision.outcome === "not_found" || !order) {
    await logEvent({
      actor: "refund_agent",
      event: "refund_order_not_found",
      orderId,
    });
    return { status: "not_found" };
  }

  const existing = async (): Promise<RefundOutcome> => {
    const current = (await findOrderForCustomer(orderId, customerId)) ?? order;
    return {
      status: "already",
      order: current,
      orderStatus: current.status,
      request: await findRequestByOrder(orderId),
    };
  };

  if (decision.outcome === "already_handled") {
    await logEvent({
      actor: "refund_agent",
      event: "refund_repeat_request",
      orderId,
      details: { order_status: decision.status },
    });
    return existing();
  }

  const auto = decision.outcome === "auto_approve";
  const status: RequestStatus = auto ? "auto_approved" : "pending_approval";
  const now = new Date().toISOString();

  // The unique constraint on order_id means a second request for the same order fails here.
  const created = await db()
    .from("refund_requests")
    .insert({
      order_id: orderId,
      amount_cents: order.amount_cents,
      reason,
      status,
      decided_by: auto ? "system" : null,
      decided_at: auto ? now : null,
    })
    .select()
    .single();
  if (created.error?.code === UNIQUE_VIOLATION) return existing();
  fail(created.error);

  const moved = await db()
    .from("orders")
    .update({ status: auto ? "refunded" : "refund_pending" })
    .eq("id", orderId)
    .eq("status", "paid")
    .select();
  fail(moved.error);
  if (!moved.data?.length) return existing();

  await logEvent({
    actor: auto ? "system" : "refund_agent",
    event: auto ? "refund_auto_approved" : "refund_pending_approval",
    orderId,
    details: { amount_cents: order.amount_cents, reason },
  });
  const updated: Order = {
    ...order,
    status: auto ? "refunded" : "refund_pending",
  };
  return auto
    ? { status: "refunded", order: updated }
    : { status: "awaiting_approval", order: updated };
}

export type RefundStatus =
  | { status: "not_found" }
  | { status: "no_request"; order: Order }
  | { status: "found"; order: Order; request: RefundRequest };

/** Where a refund stands, including a person's decision. */
export async function getRefundStatus(
  orderId: string,
  customerId: string,
): Promise<RefundStatus> {
  const order = await findOrderForCustomer(orderId, customerId);
  if (!order) return { status: "not_found" };
  const request = await findRequestByOrder(orderId);
  return request
    ? { status: "found", order, request }
    : { status: "no_request", order };
}

// ---------------------------------------------------------------------------
// Part 2: the Refund Console only (actions.ts). The agents' tools never import these.
// ---------------------------------------------------------------------------

export async function saveLimitCents(cents: number): Promise<void> {
  if (!isValidLimitCents(cents)) throw new Error("Invalid limit.");
  const { error } = await db()
    .from("settings")
    .update({ auto_refund_limit_cents: cents })
    .eq("id", true);
  fail(error);
  await logEvent({
    actor: "human",
    event: "limit_changed",
    details: { auto_refund_limit_cents: cents },
  });
}

export async function listOrders(): Promise<Order[]> {
  const { data, error } = await db()
    .from("orders")
    .select("*")
    .order("id", { ascending: true });
  fail(error);
  return (data ?? []) as Order[];
}

export type ConsoleRequest = RefundRequest & {
  item: string;
  customer_name: string;
};

export async function listRequests(): Promise<ConsoleRequest[]> {
  const { data, error } = await db()
    .from("refund_requests")
    .select("*")
    .order("created_at", { ascending: false });
  fail(error);
  const requests = (data ?? []) as RefundRequest[];
  const orders = new Map((await listOrders()).map((o) => [o.id, o]));
  return requests.map((r) => ({
    ...r,
    item: orders.get(r.order_id)?.item ?? "Unknown item",
    customer_name: orders.get(r.order_id)?.customer_name ?? "Unknown",
  }));
}

export type AuditEntry = {
  id: number;
  at: string;
  actor: Actor;
  event: string;
  order_id: string | null;
  details: Record<string, unknown>;
};

export async function listAudit(limit = 40): Promise<AuditEntry[]> {
  const { data, error } = await db()
    .from("audit_log")
    .select("*")
    .order("id", { ascending: false })
    .limit(limit);
  fail(error);
  return (data ?? []) as AuditEntry[];
}

export type DecisionResult = { ok: true } | { ok: false; error: string };

/**
 * A person approves or rejects a request. It only acts on a request that is
 * still waiting (the update is a compare-and-set), so approving twice, or
 * approving a rejected request, is an error and changes nothing.
 */
async function settleRequest(
  requestId: string,
  outcome: "approved" | "rejected",
): Promise<DecisionResult> {
  const settled = await db()
    .from("refund_requests")
    .update({
      status: outcome,
      decided_by: "human",
      decided_at: new Date().toISOString(),
    })
    .eq("id", requestId)
    .eq("status", "pending_approval")
    .select();
  fail(settled.error);
  const request = (settled.data?.[0] as RefundRequest | undefined) ?? null;
  if (!request) {
    return {
      ok: false,
      error:
        "That request isn't waiting for approval. It may already be decided.",
    };
  }

  const moved = await db()
    .from("orders")
    .update({ status: outcome === "approved" ? "refunded" : "refund_rejected" })
    .eq("id", request.order_id)
    .eq("status", "refund_pending")
    .select();
  fail(moved.error);

  await logEvent({
    actor: "human",
    event: outcome === "approved" ? "refund_approved" : "refund_rejected",
    orderId: request.order_id,
    details: { request_id: requestId, amount_cents: request.amount_cents },
  });
  return { ok: true };
}

export const approveRequest = (requestId: string) =>
  settleRequest(requestId, "approved");
export const rejectRequest = (requestId: string) =>
  settleRequest(requestId, "rejected");
