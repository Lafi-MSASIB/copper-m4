"use server";

// What the Refund Console can do: show the data, change the auto-refund limit,
// approve or reject a request. These are server actions for the Console's
// buttons only. No agent can reach them: the agents' tools live in tools.ts and
// router.ts, which never import this file, and nothing said in the chat can
// call them. (The Console has no login yet, so it is a demo, not a locked-down
// admin page.)
import { StoreUnavailableError } from "@/lib/copper/refund/db";
import { parseLimitDollars } from "@/lib/copper/refund/rules";
import {
  approveRequest,
  type AuditEntry,
  type ConsoleRequest,
  getLimitCents,
  listAudit,
  listOrders,
  listRequests,
  rejectRequest,
  saveLimitCents,
} from "@/lib/copper/refund/store";
import type { Order } from "@/lib/copper/refund/rules";

export type ConsoleData = {
  limitCents: number;
  orders: Order[];
  requests: ConsoleRequest[];
  audit: AuditEntry[];
};

export type ConsoleResult =
  { ok: true; data: ConsoleData } | { ok: false; error: string };

export type ActionResult = { ok: true } | { ok: false; error: string };

const UNAVAILABLE =
  "The order system isn't connected. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY and restart.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function describe(error: unknown): string {
  if (error instanceof StoreUnavailableError) return UNAVAILABLE;
  console.error(
    `[refund-console] ${error instanceof Error ? error.message : String(error)}`,
  );
  return "Something went wrong. Please try again.";
}

/** Everything the Console shows, in one read. */
export async function loadConsole(): Promise<ConsoleResult> {
  try {
    const [limitCents, orders, requests, audit] = await Promise.all([
      getLimitCents(),
      listOrders(),
      listRequests(),
      listAudit(),
    ]);
    return { ok: true, data: { limitCents, orders, requests, audit } };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

async function decide(
  requestId: string,
  run: typeof approveRequest,
): Promise<ActionResult> {
  if (typeof requestId !== "string" || !UUID.test(requestId)) {
    return { ok: false, error: "That isn't a valid request." };
  }
  try {
    return await run(requestId);
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

/** A person approves a request that is waiting. Anything else is an error. */
export async function approveRefund(requestId: string): Promise<ActionResult> {
  return decide(requestId, approveRequest);
}

/** A person rejects a request that is waiting. Anything else is an error. */
export async function rejectRefund(requestId: string): Promise<ActionResult> {
  return decide(requestId, rejectRequest);
}

/**
 * Saves a new auto-refund limit, typed in dollars. A bad value (negative, "abc",
 * three decimals) is refused and the saved limit stays as it was.
 */
export async function setRefundLimit(dollars: string): Promise<ActionResult> {
  const parsed = parseLimitDollars(dollars);
  if (!parsed.ok) return parsed;
  try {
    await saveLimitCents(parsed.cents);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}
