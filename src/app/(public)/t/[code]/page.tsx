"use client";

import { useParams, useSearchParams } from "next/navigation";
import { Ban, Check, CircleCheck, Clock, Copy, MapPin, Printer } from "lucide-react";
import { Suspense, useEffect } from "react";
import { Money } from "@/components/domain";
import { useToast } from "@/components/overlay";
import { Badge, Button, Card, ErrorState, LinkButton, Notice, Skeleton } from "@/components/ui";
import { useApi } from "@/lib/api-client";
import type { PublicTicket } from "@/lib/contracts";
import { formatDateTime, formatShortDateTime } from "@/lib/dates";

function TicketView() {
  const { code } = useParams<{ code: string }>();
  const isNew = useSearchParams().get("new") === "1";
  const toast = useToast();
  const { data: ticket, error, reload } = useApi<PublicTicket>(`/api/public/tickets/${encodeURIComponent(code)}`);

  // Payment and entry are recorded by staff, so refresh quietly while the page is open.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, 20_000);
    return () => window.clearInterval(timer);
  }, [reload]);

  if (error && !ticket) {
    return (
      <Card className="mx-auto max-w-md">
        <ErrorState
          message={error.status === 404 ? "No ticket matches this link. Check that the whole code was copied." : error.message}
          onRetry={reload}
        />
      </Card>
    );
  }
  if (!ticket) {
    return <Skeleton className="mx-auto h-[32rem] max-w-md" />;
  }

  const dead = ticket.status === "cancelled" || ticket.event.status === "cancelled";

  return (
    <div className="mx-auto max-w-md">
      {isNew && !dead && (
        <Notice tone="ok" icon={CircleCheck} title="You are registered" className="no-print mb-4">
          This page is your ticket. Bookmark it or take a screenshot; anyone with this link can show it.
        </Notice>
      )}

      <Card className="overflow-hidden">
        <div className="bg-night px-6 py-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-accent">Skyline ticket</p>
          <h1 className="mt-1 text-2xl font-extrabold !text-white">{ticket.event.title}</h1>
          <p className="mt-2 text-sm text-on-night-muted">{formatDateTime(ticket.event.startsAt)}</p>
          <p className="flex items-center gap-1 text-sm text-on-night-muted">
            <MapPin className="size-3.5 shrink-0" aria-hidden />
            {ticket.event.venue}
          </p>
        </div>

        <div className="px-6 py-6">
          {dead ? (
            <Notice tone="bad" icon={Ban} title={ticket.event.status === "cancelled" ? "This event was cancelled" : "This ticket was cancelled"}>
              It can no longer be used for entry.
              {ticket.paymentStatus === "paid" && " If you paid, the committee has a refund recorded for you."}
            </Notice>
          ) : (
            <>
              <div
                className="ticket-qr mx-auto w-full max-w-[15rem] rounded-card border border-line bg-white p-3"
                role="img"
                aria-label={`QR code for ticket ${ticket.code}`}
                // The SVG is generated on our server from the ticket code alone.
                dangerouslySetInnerHTML={{ __html: ticket.qrSvg }}
              />
              <p className="mt-3 text-center font-mono text-lg font-semibold tracking-wider text-ink">{ticket.code}</p>
              <p className="text-center text-[0.8125rem] text-muted">If the scanner fails, read this code to the person at the door.</p>
            </>
          )}

          <dl className="mt-6 grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2.5 border-t border-line pt-5 text-sm">
            <dt className="text-muted">Name</dt>
            <dd className="text-right font-medium text-ink">{ticket.attendeeName}</dd>
            <dt className="text-muted">Price</dt>
            <dd className="text-right text-ink">
              {ticket.priceCents === 0 ? "Free" : <Money cents={ticket.priceCents} />}
              {ticket.isMember && <span className="text-muted"> · member price</span>}
            </dd>
            <dt className="text-muted">Payment</dt>
            <dd className="text-right">
              {ticket.paymentStatus === "paid" ? (
                <Badge tone="ok" icon={Check}>Paid</Badge>
              ) : ticket.paymentStatus === "free" ? (
                <Badge>Nothing to pay</Badge>
              ) : (
                <Badge tone="warn" icon={Clock}>Not paid yet</Badge>
              )}
            </dd>
            <dt className="text-muted">Entry</dt>
            <dd className="text-right">
              {ticket.checkedInAt ? (
                <Badge tone="ok" icon={Check}>Checked in {formatShortDateTime(ticket.checkedInAt)}</Badge>
              ) : (
                <span className="text-ink">Not used yet</span>
              )}
            </dd>
          </dl>

          {!dead && ticket.paymentStatus === "pending" && (
            <Notice tone="warn" icon={Clock} className="mt-5">
              Pay <Money cents={ticket.priceCents} className="font-semibold" /> to a committee member before the event or at the door. This page
              shows <strong>Paid</strong> once they record it.
            </Notice>
          )}
        </div>
      </Card>

      <div className="no-print mt-4 flex flex-wrap justify-center gap-2">
        <Button
          variant="secondary"
          icon={Copy}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(window.location.origin + `/t/${ticket.code}`);
              toast.success("Ticket link copied.");
            } catch {
              toast.error("Could not copy. Select the address bar and copy it instead.");
            }
          }}
        >
          Copy link
        </Button>
        <Button variant="secondary" icon={Printer} onClick={() => window.print()}>
          Print
        </Button>
        <LinkButton href="/events" variant="ghost">
          More events
        </LinkButton>
      </div>
    </div>
  );
}

export default function TicketPage() {
  return (
    <Suspense fallback={<Skeleton className="mx-auto h-[32rem] max-w-md" />}>
      <TicketView />
    </Suspense>
  );
}
