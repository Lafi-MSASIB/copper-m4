// store.ts against an in-memory copy of the database: the refund flow, step by
// step. This is where "ask twice", "limit 0", "approve twice" and the rest are
// checked, because the database, not the chat, is the source of truth.
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
  approveRequest,
  DEMO_CUSTOMER,
  findOrderForCustomer,
  getChatState,
  getLimitCents,
  getRefundStatus,
  listRequests,
  rejectRequest,
  requestRefund,
  saveLimitCents,
  setActiveAgent,
} from "@/lib/copper/refund/store";

let tables: Tables;
const ask = (orderId: string, customerId = DEMO_CUSTOMER.id) =>
  requestRefund({ customerId, orderId, reason: "It stopped working" });
const requestsFor = (orderId: string) =>
  tables.refund_requests.filter((r) => r.order_id === orderId);
const orderStatus = (orderId: string) =>
  tables.orders.find((o) => o.id === orderId)?.status;
const events = (name: string) =>
  tables.audit_log.filter((entry) => entry.event === name);

beforeEach(() => {
  tables = seedTables();
  state.db = createFakeDb(tables);
});

describe("requestRefund", () => {
  it("refunds a small order straight away and says who decided", async () => {
    const result = await ask("ord_1001");
    expect(result.status).toBe("refunded");
    expect(orderStatus("ord_1001")).toBe("refunded");
    expect(requestsFor("ord_1001")).toHaveLength(1);
    expect(requestsFor("ord_1001")[0]).toMatchObject({
      status: "auto_approved",
      decided_by: "system",
    });
    expect(events("refund_auto_approved")).toHaveLength(1);
  });

  it("holds a large order for a person and issues nothing", async () => {
    const result = await ask("ord_1004");
    expect(result.status).toBe("awaiting_approval");
    expect(orderStatus("ord_1004")).toBe("refund_pending");
    expect(requestsFor("ord_1004")[0]).toMatchObject({
      status: "pending_approval",
      decided_by: null,
      decided_at: null,
    });
  });

  it("asking twice never makes a second refund or a second request (case 1)", async () => {
    await ask("ord_1004");
    const second = await ask("ord_1004");
    expect(second.status).toBe("already");
    expect(requestsFor("ord_1004")).toHaveLength(1);
    expect(events("refund_pending_approval")).toHaveLength(1);

    await ask("ord_1001");
    const again = await ask("ord_1001");
    expect(again.status).toBe("already");
    expect(requestsFor("ord_1001")).toHaveLength(1);
    expect(events("refund_auto_approved")).toHaveLength(1);
  });

  it("two requests at the same moment still make just one (case 1, in a race)", async () => {
    const [a, b] = await Promise.all([ask("ord_1004"), ask("ord_1004")]);
    expect([a.status, b.status].sort()).toEqual([
      "already",
      "awaiting_approval",
    ]);
    expect(requestsFor("ord_1004")).toHaveLength(1);
  });

  it("with a limit of 0, even the $12 order goes to a person (case 3)", async () => {
    await saveLimitCents(0);
    const result = await ask("ord_1001");
    expect(result.status).toBe("awaiting_approval");
    expect(orderStatus("ord_1001")).toBe("refund_pending");
  });

  it("an amount exactly equal to the limit is auto-approved (case 8)", async () => {
    await saveLimitCents(4900);
    expect((await ask("ord_1003")).status).toBe("refunded");
    await saveLimitCents(4899);
    expect((await ask("ord_1002")).status).toBe("refunded");
  });

  it("a raised limit auto-approves the next request, but never one already waiting (case 4)", async () => {
    await ask("ord_1004");
    expect(orderStatus("ord_1004")).toBe("refund_pending");

    await saveLimitCents(50000);
    // asking again for the waiting order changes nothing
    expect((await ask("ord_1004")).status).toBe("already");
    expect(orderStatus("ord_1004")).toBe("refund_pending");
    expect(requestsFor("ord_1004")[0].status).toBe("pending_approval");
    // a new order under the new limit goes through
    expect((await ask("ord_1005")).status).toBe("refunded");
  });

  it("reads the limit when the request is made, not before (case 4)", async () => {
    expect(await getLimitCents()).toBe(5000);
    await saveLimitCents(100);
    expect(await getLimitCents()).toBe(100);
    expect((await ask("ord_1002")).status).toBe("awaiting_approval");
  });

  it("reports another customer's order as not found, and touches nothing (case 5)", async () => {
    const result = await ask("ord_2001");
    expect(result).toEqual({ status: "not_found" });
    expect(orderStatus("ord_2001")).toBe("paid");
    expect(requestsFor("ord_2001")).toHaveLength(0);
    expect(await findOrderForCustomer("ord_2001", DEMO_CUSTOMER.id)).toBeNull();
    expect(await getRefundStatus("ord_2001", DEMO_CUSTOMER.id)).toEqual({
      status: "not_found",
    });
  });

  it("reports an order that doesn't exist the same way", async () => {
    expect(await ask("ord_9999")).toEqual({ status: "not_found" });
  });

  it("won't refund an order that was already refunded or rejected", async () => {
    const refunded = await ask("ord_1007");
    expect(refunded.status).toBe("already");
    expect(requestsFor("ord_1007")).toHaveLength(1);

    await ask("ord_1004");
    const [pending] = await listRequests();
    await rejectRequest(pending.id);
    expect((await ask("ord_1004")).status).toBe("already");
    expect(orderStatus("ord_1004")).toBe("refund_rejected");
  });
});

describe("a person approves or rejects", () => {
  async function waiting(orderId = "ord_1004") {
    await ask(orderId);
    return tables.refund_requests.find((r) => r.order_id === orderId)!
      .id as string;
  }

  it("approving refunds the order and records who decided", async () => {
    const id = await waiting();
    expect(await approveRequest(id)).toEqual({ ok: true });
    expect(orderStatus("ord_1004")).toBe("refunded");
    expect(requestsFor("ord_1004")[0]).toMatchObject({
      status: "approved",
      decided_by: "human",
    });
    expect(events("refund_approved")).toHaveLength(1);
  });

  it("rejecting marks the order rejected", async () => {
    const id = await waiting();
    expect(await rejectRequest(id)).toEqual({ ok: true });
    expect(orderStatus("ord_1004")).toBe("refund_rejected");
    expect(requestsFor("ord_1004")[0].status).toBe("rejected");
  });

  it("approving twice, or after a reject, is an error and changes nothing (case 6)", async () => {
    const id = await waiting();
    expect(await approveRequest(id)).toEqual({ ok: true });
    const again = await approveRequest(id);
    expect(again.ok).toBe(false);
    expect(await rejectRequest(id)).toMatchObject({ ok: false });
    expect(orderStatus("ord_1004")).toBe("refunded");
    expect(events("refund_approved")).toHaveLength(1);

    const other = await waiting("ord_1005");
    expect(await rejectRequest(other)).toEqual({ ok: true });
    expect(await approveRequest(other)).toMatchObject({ ok: false });
    expect(orderStatus("ord_1005")).toBe("refund_rejected");
  });

  it("can't decide an automatic refund or a request that doesn't exist", async () => {
    await ask("ord_1001");
    const auto = requestsFor("ord_1001")[0].id as string;
    expect(await approveRequest(auto)).toMatchObject({ ok: false });
    expect(
      await approveRequest("00000000-0000-4000-8000-000000000000"),
    ).toMatchObject({ ok: false });
  });

  it("the customer's status check shows the person's decision", async () => {
    const id = await waiting();
    const before = await getRefundStatus("ord_1004", DEMO_CUSTOMER.id);
    expect(before).toMatchObject({
      status: "found",
      request: { status: "pending_approval" },
    });
    await approveRequest(id);
    const after = await getRefundStatus("ord_1004", DEMO_CUSTOMER.id);
    expect(after).toMatchObject({
      status: "found",
      order: { status: "refunded" },
      request: { status: "approved", decided_by: "human" },
    });
  });
});

describe("the limit setting", () => {
  it("refuses a limit that isn't whole cents of zero or more (case 7)", async () => {
    for (const bad of [-1, 12.5, Number.NaN, 1e12]) {
      await expect(saveLimitCents(bad)).rejects.toThrow();
    }
    expect(await getLimitCents()).toBe(5000);
  });

  it("saves a valid limit and logs who changed it", async () => {
    await saveLimitCents(7500);
    expect(await getLimitCents()).toBe(7500);
    expect(events("limit_changed")).toHaveLength(1);
  });

  it("with no setting saved, sends everything to a person", async () => {
    tables.settings.length = 0;
    expect(await getLimitCents()).toBe(0);
  });
});

describe("chat state", () => {
  it("a new chat starts with Copper, for the one demo customer", async () => {
    const chat = await getChatState("11111111-1111-4111-8111-111111111111");
    expect(chat).toEqual({
      chatId: "11111111-1111-4111-8111-111111111111",
      customerId: "cust_demo",
      activeAgent: "copper",
    });
  });

  it("remembers the active agent on the server", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    await getChatState(id);
    await setActiveAgent(id, "refund");
    expect((await getChatState(id)).activeAgent).toBe("refund");
    await setActiveAgent(id, "copper");
    expect((await getChatState(id)).activeAgent).toBe("copper");
  });
});
