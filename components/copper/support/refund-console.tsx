"use client";

// The Refund Console: the limit, the orders, the requests waiting for a person,
// the recent decisions and the audit log. It reloads every few seconds, so a
// refund asked for in the chat shows up here without a page refresh.
import { useCallback, useEffect, useState } from "react";
import {
  approveRefund,
  type ConsoleData,
  loadConsole,
  rejectRefund,
  setRefundLimit,
} from "@/lib/copper/refund/actions";
import {
  AuditLog,
  LimitCard,
  OrdersTable,
  PendingApprovals,
  RecentDecisions,
} from "./console-sections";

const REFRESH_MS = 4000;

export function RefundConsole() {
  const [data, setData] = useState<ConsoleData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await loadConsole();
      if (result.ok) {
        setData(result.data);
        setError(null);
      } else {
        setError(result.error);
      }
    } catch {
      setError("Couldn't reach the server. Retrying…");
    }
  }, []);

  useEffect(() => {
    // The first load starts on the next tick, then it repeats.
    const first = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [refresh]);

  // After any change, show the new state straight away.
  const then = (run: () => ReturnType<typeof setRefundLimit>) => async () => {
    const result = await run();
    await refresh();
    return result;
  };

  if (!data) {
    return (
      <p
        role={error ? "alert" : "status"}
        className="text-muted-foreground text-sm"
      >
        {error ?? "Loading the Refund Console…"}
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <p role="alert" className="text-chart-3 text-sm">
          {error}
        </p>
      )}
      <LimitCard
        limitCents={data.limitCents}
        onSave={(dollars) => then(() => setRefundLimit(dollars))()}
      />
      <PendingApprovals
        requests={data.requests}
        onApprove={(id) => then(() => approveRefund(id))()}
        onReject={(id) => then(() => rejectRefund(id))()}
      />
      <OrdersTable orders={data.orders} />
      <RecentDecisions requests={data.requests} />
      <AuditLog audit={data.audit} />
    </div>
  );
}
