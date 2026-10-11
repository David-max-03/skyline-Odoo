"use client";

import { ShoppingBag } from "lucide-react";
import { Money, OrderStatusBadge } from "./domain";
import { PayOrderOnline } from "./order-payment";
import { Badge, Card, EmptyState, ErrorState, LinkButton, LoadingBlock, PageHeader } from "./ui";
import { useApi } from "@/lib/api-client";
import type { ShopOrder } from "@/lib/contracts";
import { formatDateTime } from "@/lib/dates";

/**
 * The signed-in person's own merchandise orders, with "pay online" on the
 * unpaid ones. Used in the member area, and on the shop for a committee
 * account that orders as the member it is linked to.
 */
export function MyOrders() {
  const { data, error, reload } = useApi<ShopOrder[]>("/api/me/orders");
  const shop = (
    <LinkButton href="/shop" icon={ShoppingBag}>
      Visit the shop
    </LinkButton>
  );

  return (
    <>
      <PageHeader title="My orders" description="Merchandise you have ordered. Pay online here, or pay the committee when you collect; hand-over is recorded by the committee." actions={shop} />
      {error && !data ? (
        <Card>
          <ErrorState message={error.message} onRetry={reload} />
        </Card>
      ) : !data ? (
        <Card>
          <LoadingBlock label="Loading your orders" />
        </Card>
      ) : data.length === 0 ? (
        <Card>
          <EmptyState icon={ShoppingBag} title="No orders yet" description="Orders you place in the shop show here." action={shop} />
        </Card>
      ) : (
        <ul className="space-y-4">
          {data.map((order) => (
            <li key={order.code}>
              <Card>
                <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3.5">
                  <div>
                    <p className="font-mono text-sm font-bold text-ink">{order.code}</p>
                    <p className="text-[0.8125rem] text-muted">Placed {formatDateTime(order.createdAt)}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-display text-lg font-bold text-ink">
                      <Money cents={order.totalCents} />
                    </p>
                    {order.unpaidCents > 0 ? (
                      <Badge tone="warn">
                        <Money cents={order.unpaidCents} /> to pay
                      </Badge>
                    ) : (
                      order.totalCents > 0 && <Badge tone="ok">Paid</Badge>
                    )}
                  </div>
                </header>
                <ul className="divide-y divide-line text-sm">
                  {order.lines.map((line) => (
                    <li key={line.orderId} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                      <span className="min-w-0">
                        <span className="font-medium text-ink">
                          {line.quantity} × {line.productName}
                        </span>{" "}
                        <span className="text-muted">
                          ({line.size}) · <Money cents={line.unitPriceCents} /> each
                        </span>
                      </span>
                      <span className="flex items-center gap-2">
                        <Money cents={line.totalCents} />
                        {line.status !== "cancelled" && <Badge tone={line.paymentStatus === "paid" ? "ok" : "warn"}>{line.paymentStatus === "paid" ? "Paid" : "Unpaid"}</Badge>}
                        <OrderStatusBadge status={line.status} />
                      </span>
                    </li>
                  ))}
                </ul>
                {/* The server's answer after a payment replaces what is shown, by reloading the list. */}
                <div className="border-t border-line px-5 py-3.5 empty:hidden">
                  <PayOrderOnline order={order} onOrder={reload} />
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
