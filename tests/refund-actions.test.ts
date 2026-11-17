// The Refund Console's actions: they refuse bad input, and only act on a request
// that is still waiting. The database is an in-memory copy.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakeDb,
  seedTables,
  type Tables,
} from "./helpers/fake-refund-db";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/copper/refund/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/copper/refund/db")>()),
  getDb: () => state.db,
  isStoreConfigured: () => state.db !== null,
}));

import {
  approveRefund,
  loadConsole,
  rejectRefund,
  setRefundLimit,
} from "@/lib/copper/refund/actions";
import { requestRefund } from "@/lib/copper/refund/store";

let tables: Tables;
const limit = () => tables.settings[0].auto_refund_limit_cents;

beforeEach(() => {
  tables = seedTables();
  state.db = createFakeDb(tables);
});

describe("setRefundLimit", () => {
  it("saves a valid limit typed in dollars", async () => {
    expect(await setRefundLimit("75")).toEqual({ ok: true });
    expect(limit()).toBe(7500);
    expect(await setRefundLimit("0")).toEqual({ ok: true });
    expect(limit()).toBe(0);
  });

  it.each(["-5", "abc", "NaN", "", "12.345", "1e3", " "])(
    "refuses %j and leaves the limit as it was (case 7)",
    async (text) => {
      const result = await setRefundLimit(text);
      expect(result.ok).toBe(false);
      expect(limit()).toBe(5000);
    },
  );

  it("refuses things that aren't text", async () => {
    expect((await setRefundLimit(undefined as never)).ok).toBe(false);
    expect((await setRefundLimit(-1 as never)).ok).toBe(false);
    expect(limit()).toBe(5000);
  });
});

describe("approve and reject", () => {
  async function waitingRequest(orderId = "ord_1004") {
    await requestRefund({
      customerId: "cust_demo",
      orderId,
      reason: "It stopped working",
    });
    return tables.refund_requests.find((r) => r.order_id === orderId)!
      .id as string;
  }

  it("approves a waiting request, once (case 6)", async () => {
    const id = await waitingRequest();
    expect(await approveRefund(id)).toEqual({ ok: true });
    expect((await approveRefund(id)).ok).toBe(false);
    expect((await rejectRefund(id)).ok).toBe(false);
    expect(tables.orders.find((o) => o.id === "ord_1004")?.status).toBe(
      "refunded",
    );
  });

  it("won't approve after a reject (case 6)", async () => {
    const id = await waitingRequest();
    expect(await rejectRefund(id)).toEqual({ ok: true });
    expect((await approveRefund(id)).ok).toBe(false);
    expect(tables.orders.find((o) => o.id === "ord_1004")?.status).toBe(
      "refund_rejected",
    );
  });

  it("refuses an id that isn't a request id", async () => {
    for (const bad of ["", "ord_1004", "1; drop table orders", 42 as never]) {
      expect((await approveRefund(bad)).ok).toBe(false);
      expect((await rejectRefund(bad)).ok).toBe(false);
    }
  });
});

describe("loadConsole", () => {
  it("returns the limit, the orders, the requests and the audit log", async () => {
    await requestRefund({
      customerId: "cust_demo",
      orderId: "ord_1004",
      reason: "Broken",
    });
    const result = await loadConsole();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.limitCents).toBe(5000);
    expect(result.data.orders).toHaveLength(8);
    expect(result.data.requests.map((r) => r.order_id)).toContain("ord_1004");
    expect(result.data.requests[0]).toHaveProperty("item");
    expect(result.data.audit.length).toBeGreaterThan(0);
  });

  it("says the order system isn't connected, instead of crashing, when there is no database", async () => {
    state.db = null;
    const result = await loadConsole();
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toMatch(/isn't connected/);
  });
});
