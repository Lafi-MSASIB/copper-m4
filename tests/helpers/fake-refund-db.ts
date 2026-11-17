// A tiny in-memory stand-in for the Supabase client, with just the calls
// store.ts uses (select, insert, update, upsert, eq, order, limit, maybeSingle,
// single). It behaves like the real tables where the rules depend on it: one
// refund request per order (a second insert fails with the real "duplicate"
// code), and an update with filters only changes rows that still match.
import { randomUUID } from "node:crypto";

type Row = Record<string, unknown>;
type Result = {
  data: unknown;
  error: { code?: string; message: string } | null;
};

export type Tables = {
  orders: Row[];
  refund_requests: Row[];
  settings: Row[];
  chat_state: Row[];
  audit_log: Row[];
};

const order = (
  id: string,
  customer_id: string,
  customer_name: string,
  item: string,
  amount_cents: number,
  status = "paid",
): Row => ({
  id,
  customer_id,
  customer_name,
  item,
  amount_cents,
  status,
  created_at: "2026-11-17T12:00:00Z",
});

/** The same demo data as the real database's seed. */
export function seedTables(): Tables {
  return {
    orders: [
      order(
        "ord_1001",
        "cust_demo",
        "Maya Torres",
        "Copper Notes charging puck",
        1200,
      ),
      order(
        "ord_1002",
        "cust_demo",
        "Maya Torres",
        "Copper Home wall bracket",
        2500,
      ),
      order(
        "ord_1003",
        "cust_demo",
        "Maya Torres",
        "Copper Notes carry pouch",
        4900,
      ),
      order(
        "ord_1004",
        "cust_demo",
        "Maya Torres",
        "Copper Home Starter Bundle",
        18000,
      ),
      order(
        "ord_1005",
        "cust_demo",
        "Maya Torres",
        "Copper Notes Classroom Pack (3)",
        45000,
      ),
      order(
        "ord_1006",
        "cust_demo",
        "Maya Torres",
        "Copper Home Family Pack (8)",
        120000,
      ),
      order(
        "ord_1007",
        "cust_demo",
        "Maya Torres",
        "Copper Notes",
        12900,
        "refunded",
      ),
      order("ord_2001", "cust_other", "Jordan Lee", "Copper Home", 14900),
    ],
    refund_requests: [
      {
        id: randomUUID(),
        order_id: "ord_1007",
        amount_cents: 12900,
        reason: "Changed my mind",
        status: "approved",
        decided_by: "human",
        created_at: "2026-11-17T12:00:00Z",
        decided_at: "2026-11-17T12:05:00Z",
      },
    ],
    settings: [{ id: true, auto_refund_limit_cents: 5000 }],
    chat_state: [],
    audit_log: [],
  };
}

const UNIQUE: Partial<Record<keyof Tables, string>> = {
  orders: "id",
  refund_requests: "order_id",
  settings: "id",
  chat_state: "chat_id",
};

class Query implements PromiseLike<Result> {
  private op: "select" | "insert" | "update" | "upsert" = "select";
  private filters: [string, unknown][] = [];
  private payload: Row = {};
  private ignoreDuplicates = false;
  private returning = false;
  private sort: { column: string; ascending: boolean } | null = null;
  private max: number | null = null;
  private one: "maybe" | "exactly" | null = null;

  constructor(
    private tables: Tables,
    private table: keyof Tables,
  ) {}

  select() {
    this.returning = true;
    return this;
  }
  insert(row: Row) {
    this.op = "insert";
    this.payload = row;
    return this;
  }
  update(patch: Row) {
    this.op = "update";
    this.payload = patch;
    return this;
  }
  upsert(row: Row, options?: { ignoreDuplicates?: boolean }) {
    this.op = "upsert";
    this.payload = row;
    this.ignoreDuplicates = Boolean(options?.ignoreDuplicates);
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push([column, value]);
    return this;
  }
  order(column: string, options?: { ascending?: boolean }) {
    this.sort = { column, ascending: options?.ascending ?? true };
    return this;
  }
  limit(count: number) {
    this.max = count;
    return this;
  }
  maybeSingle() {
    this.one = "maybe";
    return this;
  }
  single() {
    this.one = "exactly";
    return this;
  }

  then<A = Result, B = never>(
    onfulfilled?: ((value: Result) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }

  private matches(row: Row) {
    return this.filters.every(([column, value]) => row[column] === value);
  }

  private shape(rows: Row[]): Result {
    if (this.one) {
      if (rows.length === 0 && this.one === "exactly") {
        return { data: null, error: { message: "no rows" } };
      }
      return { data: rows[0] ?? null, error: null };
    }
    return { data: rows, error: null };
  }

  private run(): Result {
    const rows = this.tables[this.table];
    if (this.op === "select") {
      let found = rows.filter((row) => this.matches(row));
      if (this.sort) {
        const { column, ascending } = this.sort;
        found = [...found].sort((a, b) => {
          const x = a[column] as string | number;
          const y = b[column] as string | number;
          return (x < y ? -1 : x > y ? 1 : 0) * (ascending ? 1 : -1);
        });
      }
      if (this.max !== null) found = found.slice(0, this.max);
      return this.shape(found.map((row) => ({ ...row })));
    }

    if (this.op === "update") {
      const changed = rows.filter((row) => this.matches(row));
      for (const row of changed) Object.assign(row, this.payload);
      return this.returning
        ? this.shape(changed.map((row) => ({ ...row })))
        : { data: null, error: null };
    }

    // insert and upsert
    const key = UNIQUE[this.table];
    const duplicate = key && rows.some((row) => row[key] === this.payload[key]);
    if (duplicate) {
      return this.op === "upsert" && this.ignoreDuplicates
        ? { data: null, error: null }
        : {
            data: null,
            error: { code: "23505", message: "duplicate key value" },
          };
    }
    const row: Row = { created_at: new Date().toISOString(), ...this.payload };
    if (this.table === "refund_requests" && !row.id) row.id = randomUUID();
    if (this.table === "audit_log") {
      row.id = rows.length + 1;
      row.at = row.at ?? new Date().toISOString();
    }
    rows.push(row);
    return this.returning
      ? this.shape([{ ...row }])
      : { data: null, error: null };
  }
}

export function createFakeDb(tables: Tables) {
  return {
    from(table: keyof Tables) {
      return new Query(tables, table);
    },
  };
}
