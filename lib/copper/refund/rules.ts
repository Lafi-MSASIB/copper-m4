// The refund rules, as plain functions with no database and no AI in them, so
// they can be tested on their own. The model never decides any of this: the
// app calls these, and the answer is final.

export type OrderStatus =
  "paid" | "refund_pending" | "refunded" | "refund_rejected";

export type RequestStatus =
  "pending_approval" | "approved" | "rejected" | "auto_approved";

export type Order = {
  id: string;
  customer_id: string;
  customer_name: string;
  item: string;
  /** Money is always whole cents, never a decimal number. */
  amount_cents: number;
  status: OrderStatus;
  created_at: string;
};

export type RefundRequest = {
  id: string;
  order_id: string;
  amount_cents: number;
  reason: string;
  status: RequestStatus;
  decided_by: "system" | "human" | null;
  created_at: string;
  decided_at: string | null;
};

/** The biggest limit the Console accepts: $1,000,000.00. */
export const MAX_LIMIT_CENTS = 100_000_000;

/** 1200 becomes "$12.00". */
export function centsToUsd(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export type RefundDecision =
  | { outcome: "not_found" }
  /** Not paid any more: asking again must never refund or queue a second time. */
  | { outcome: "already_handled"; status: OrderStatus }
  | { outcome: "auto_approve" }
  | { outcome: "needs_approval" };

/**
 * What should happen to a refund request, in this order:
 * 1. The order has to exist and belong to this customer (otherwise "not found",
 *    the same answer as for an order that doesn't exist).
 * 2. Only a paid order can be refunded. A refunded, pending or rejected order
 *    is already handled, so a second request changes nothing.
 * 3. At or under the limit the refund goes through; over it, a person decides.
 * `limitCents` comes from the database at the moment of the request, never from
 * the chat or a prompt.
 */
export function decideRefund(input: {
  order: Order | null;
  customerId: string;
  limitCents: number;
}): RefundDecision {
  const { order, customerId, limitCents } = input;
  if (!order || order.customer_id !== customerId) {
    return { outcome: "not_found" };
  }
  if (order.status !== "paid") {
    return { outcome: "already_handled", status: order.status };
  }
  return order.amount_cents <= limitCents
    ? { outcome: "auto_approve" }
    : { outcome: "needs_approval" };
}

/** A limit is whole cents, zero or more. Zero means every refund needs a person. */
export function isValidLimitCents(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_LIMIT_CENTS
  );
}

/**
 * Turns what a person typed in the Console ("50", "12.5", "0.00") into cents.
 * Anything else (negative, "abc", NaN, three decimals) is rejected, so a bad
 * value can never reach the saved setting.
 */
export function parseLimitDollars(
  text: unknown,
): { ok: true; cents: number } | { ok: false; error: string } {
  if (typeof text !== "string" || !/^\d+(\.\d{1,2})?$/.test(text.trim())) {
    return {
      ok: false,
      error: "Enter a dollar amount like 50 or 50.00 (zero or more).",
    };
  }
  const cents = Math.round(Number(text.trim()) * 100);
  if (!isValidLimitCents(cents)) {
    return { ok: false, error: "That limit is too large." };
  }
  return { ok: true, cents };
}

/** Only a request still waiting for a person can be approved or rejected. */
export function canDecide(status: RequestStatus): boolean {
  return status === "pending_approval";
}

/** A refund needs a short, real reason. */
export function validateReason(
  reason: unknown,
): { ok: true; reason: string } | { ok: false; error: string } {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (text.length < 3) {
    return { ok: false, error: "A short reason for the refund is needed." };
  }
  if (text.length > 300) {
    return {
      ok: false,
      error: "The reason is too long (300 characters at most).",
    };
  }
  return { ok: true, reason: text };
}
