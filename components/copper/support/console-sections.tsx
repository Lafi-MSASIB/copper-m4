"use client";

// The pieces of the Refund Console: the limit, the orders, the requests waiting
// for a person, the recent decisions and the audit log. They only draw what the
// Console hands them; the container (refund-console.tsx) does the loading.
import { ChevronDownIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ActionResult, ConsoleData } from "@/lib/copper/refund/actions";
import {
  canDecide,
  centsToUsd,
  type OrderStatus,
  type RequestStatus,
} from "@/lib/copper/refund/rules";
import { cn } from "@/lib/utils";

const time = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "";

const ORDER_STATUS: Record<OrderStatus, { label: string; className: string }> =
  {
    paid: { label: "Paid", className: "bg-muted text-foreground" },
    refund_pending: {
      label: "Refund pending",
      className: "bg-chart-4 text-chart-5",
    },
    refunded: { label: "Refunded", className: "bg-accent text-white" },
    refund_rejected: {
      label: "Refund rejected",
      className: "bg-chart-3 text-white",
    },
  };

const REQUEST_LABEL: Record<RequestStatus, string> = {
  pending_approval: "Waiting for approval",
  auto_approved: "Auto-approved",
  approved: "Approved",
  rejected: "Rejected",
};

export function StatusBadge({ status }: { status: OrderStatus }) {
  const { label, className } = ORDER_STATUS[status];
  return (
    <Badge variant="outline" className={cn("border-0", className)}>
      {label}
    </Badge>
  );
}

export function LimitCard({
  limitCents,
  onSave,
}: {
  limitCents: number;
  onSave: (dollars: string) => Promise<ActionResult>;
}) {
  // What the person is typing; empty until they start, so refreshes never overwrite it.
  const [typed, setTyped] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const shown = typed ?? (limitCents / 100).toFixed(2);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    const result = await onSave(shown);
    setSaving(false);
    if (result.ok) {
      setTyped(null);
      setMessage({
        ok: true,
        text: "Saved. It applies to the next refund request.",
      });
    } else {
      setMessage({ ok: false, text: result.error });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Auto-refund limit</CardTitle>
        <CardDescription>
          Refunds at or under this amount go through on their own. Anything over
          it waits here for a person. Zero means every refund waits.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="limit">Limit (USD)</Label>
            <Input
              id="limit"
              inputMode="decimal"
              value={shown}
              onChange={(event) => {
                setTyped(event.target.value);
                setMessage(null);
              }}
              className="w-40"
            />
          </div>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
          {message && (
            <p
              role={message.ok ? "status" : "alert"}
              className={cn(
                "text-sm",
                message.ok ? "text-accent" : "text-chart-3",
              )}
            >
              {message.text}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

export function OrdersTable({ orders }: { orders: ConsoleData["orders"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Orders</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Order</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Item</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orders.map((order) => (
              <TableRow key={order.id}>
                <TableCell className="font-mono text-xs">{order.id}</TableCell>
                <TableCell>{order.customer_name}</TableCell>
                <TableCell>{order.item}</TableCell>
                <TableCell className="text-right font-mono">
                  {centsToUsd(order.amount_cents)}
                </TableCell>
                <TableCell>
                  <StatusBadge status={order.status} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function PendingApprovals({
  requests,
  onApprove,
  onReject,
}: {
  requests: ConsoleData["requests"];
  onApprove: (id: string) => Promise<ActionResult>;
  onReject: (id: string) => Promise<ActionResult>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const waiting = requests.filter((r) => canDecide(r.status));

  async function decide(
    id: string,
    run: (id: string) => Promise<ActionResult>,
  ) {
    setBusy(id);
    setError(null);
    const result = await run(id);
    if (!result.ok) setError(result.error);
    setBusy(null);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pending approvals</CardTitle>
        <CardDescription>
          Refunds over the limit. Nothing is refunded until a person approves.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {waiting.length === 0 && (
          <p className="text-muted-foreground text-sm">Nothing is waiting.</p>
        )}
        {waiting.map((request) => (
          <div
            key={request.id}
            data-testid="pending-request"
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
          >
            <div className="min-w-0 space-y-0.5 text-sm">
              <p className="font-medium">
                {request.item}{" "}
                <span className="text-muted-foreground font-mono text-xs font-normal">
                  {request.order_id}
                </span>
              </p>
              <p>
                <span className="font-mono">
                  {centsToUsd(request.amount_cents)}
                </span>{" "}
                <span className="text-muted-foreground">
                  · {request.customer_name} · {time(request.created_at)}
                </span>
              </p>
              <p className="text-muted-foreground">Reason: {request.reason}</p>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={busy === request.id}
                onClick={() => decide(request.id, onApprove)}
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy === request.id}
                onClick={() => decide(request.id, onReject)}
              >
                Reject
              </Button>
            </div>
          </div>
        ))}
        {error && (
          <p role="alert" className="text-chart-3 text-sm">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function RecentDecisions({
  requests,
}: {
  requests: ConsoleData["requests"];
}) {
  const decided = requests.filter((r) => !canDecide(r.status)).slice(0, 10);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent decisions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {decided.length === 0 && (
          <p className="text-muted-foreground text-sm">No decisions yet.</p>
        )}
        {decided.map((request) => (
          <p key={request.id} className="text-sm">
            <span className="font-medium">{REQUEST_LABEL[request.status]}</span>{" "}
            <span className="font-mono">
              {centsToUsd(request.amount_cents)}
            </span>{" "}
            {request.item}{" "}
            <span className="text-muted-foreground">
              ({request.order_id}) · by {request.decided_by ?? "no one yet"} ·{" "}
              {time(request.decided_at)}
            </span>
          </p>
        ))}
      </CardContent>
    </Card>
  );
}

export function AuditLog({ audit }: { audit: ConsoleData["audit"] }) {
  return (
    <Collapsible>
      <Card>
        <CardHeader>
          <CollapsibleTrigger className="flex w-full items-center justify-between text-left">
            <CardTitle>Audit log ({audit.length})</CardTitle>
            <ChevronDownIcon className="size-4" />
          </CollapsibleTrigger>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="space-y-1.5">
            {audit.map((entry) => (
              <p key={entry.id} className="font-mono text-xs">
                <span className="text-muted-foreground">{time(entry.at)}</span>{" "}
                {entry.actor} · {entry.event}
                {entry.order_id ? ` · ${entry.order_id}` : ""}
              </p>
            ))}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
