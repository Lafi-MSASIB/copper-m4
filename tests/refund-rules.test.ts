// The refund rules: pure functions, so they can be tested with no database and
// no AI. These are the rules the model can never argue past.
import { describe, expect, it } from "vitest";
import {
  canDecide,
  centsToUsd,
  decideRefund,
  isValidLimitCents,
  type Order,
  parseLimitDollars,
  validateReason,
} from "@/lib/copper/refund/rules";

const order = (overrides: Partial<Order> = {}): Order => ({
  id: "ord_1001",
  customer_id: "cust_demo",
  customer_name: "Maya Torres",
  item: "Copper Notes charging puck",
  amount_cents: 1200,
  status: "paid",
  created_at: "2026-11-17T12:00:00Z",
  ...overrides,
});

describe("decideRefund", () => {
  it("auto-approves an amount under the limit", () => {
    expect(
      decideRefund({
        order: order(),
        customerId: "cust_demo",
        limitCents: 5000,
      }),
    ).toEqual({ outcome: "auto_approve" });
  });

  it("auto-approves an amount exactly equal to the limit", () => {
    const result = decideRefund({
      order: order({ amount_cents: 5000 }),
      customerId: "cust_demo",
      limitCents: 5000,
    });
    expect(result).toEqual({ outcome: "auto_approve" });
  });

  it("sends an amount one cent over the limit to a person", () => {
    const result = decideRefund({
      order: order({ amount_cents: 5001 }),
      customerId: "cust_demo",
      limitCents: 5000,
    });
    expect(result).toEqual({ outcome: "needs_approval" });
  });

  it("with a limit of 0, even a $12 order needs a person", () => {
    expect(
      decideRefund({ order: order(), customerId: "cust_demo", limitCents: 0 }),
    ).toEqual({ outcome: "needs_approval" });
  });

  it("reports another customer's order, and a missing order, the same way: not found", () => {
    const theirs = order({ customer_id: "cust_other" });
    expect(
      decideRefund({
        order: theirs,
        customerId: "cust_demo",
        limitCents: 5000,
      }),
    ).toEqual({ outcome: "not_found" });
    expect(
      decideRefund({ order: null, customerId: "cust_demo", limitCents: 5000 }),
    ).toEqual({ outcome: "not_found" });
  });

  it.each(["refunded", "refund_pending", "refund_rejected"] as const)(
    "does nothing new for an order that is already %s",
    (status) => {
      expect(
        decideRefund({
          order: order({ status }),
          customerId: "cust_demo",
          limitCents: 999999,
        }),
      ).toEqual({ outcome: "already_handled", status });
    },
  );
});

describe("the limit", () => {
  it("accepts whole cents of zero or more, and rejects the rest", () => {
    expect(isValidLimitCents(0)).toBe(true);
    expect(isValidLimitCents(5000)).toBe(true);
    for (const bad of [
      -1,
      12.5,
      Number.NaN,
      Infinity,
      "5000",
      null,
      undefined,
    ]) {
      expect(isValidLimitCents(bad)).toBe(false);
    }
  });

  it("turns what a person types into cents", () => {
    expect(parseLimitDollars("50")).toEqual({ ok: true, cents: 5000 });
    expect(parseLimitDollars(" 12.5 ")).toEqual({ ok: true, cents: 1250 });
    expect(parseLimitDollars("0")).toEqual({ ok: true, cents: 0 });
    expect(parseLimitDollars("0.00")).toEqual({ ok: true, cents: 0 });
  });

  it.each(["-5", "abc", "NaN", "", "1.234", "1e3", "$50", "5 0", "Infinity"])(
    "rejects %j",
    (text) => {
      expect(parseLimitDollars(text).ok).toBe(false);
    },
  );

  it("rejects things that aren't text", () => {
    expect(parseLimitDollars(50).ok).toBe(false);
    expect(parseLimitDollars(undefined).ok).toBe(false);
  });

  it("rejects an absurdly large limit", () => {
    expect(parseLimitDollars("99999999999").ok).toBe(false);
  });
});

describe("approvals and reasons", () => {
  it("only a request still waiting can be decided", () => {
    expect(canDecide("pending_approval")).toBe(true);
    for (const status of ["approved", "rejected", "auto_approved"] as const) {
      expect(canDecide(status)).toBe(false);
    }
  });

  it("needs a short, real reason", () => {
    expect(validateReason("It broke")).toEqual({
      ok: true,
      reason: "It broke",
    });
    expect(validateReason("  ok ").ok).toBe(false);
    expect(validateReason("").ok).toBe(false);
    expect(validateReason(42).ok).toBe(false);
    expect(validateReason("x".repeat(301)).ok).toBe(false);
  });

  it("shows cents as dollars", () => {
    expect(centsToUsd(1200)).toBe("$12.00");
    expect(centsToUsd(120000)).toBe("$1,200.00");
    expect(centsToUsd(0)).toBe("$0.00");
  });
});
