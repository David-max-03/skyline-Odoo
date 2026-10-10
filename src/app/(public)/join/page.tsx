"use client";

import { Check, CircleCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Money } from "@/components/domain";
import { Button, Card, FormError, LinkButton, Notice, PageHeader, TextField } from "@/components/ui";
import { api, errorMessage, fieldErrors } from "@/lib/api-client";
import { SETTINGS, type JoinResult } from "@/lib/contracts";

const BENEFITS = [
  "Member prices on event tickets",
  "Member prices on hoodies and T-shirts",
  "A vote at the annual general meeting",
  "Member-only announcements",
];

export default function JoinPage() {
  const [values, setValues] = useState({ name: "", email: "", studentId: "", phone: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [joined, setJoined] = useState<JoinResult | null>(null);

  const set = (key: keyof typeof values) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setWorking(true);
    setFormError(null);
    setErrors({});
    try {
      const result = await api<JoinResult>("/api/public/join", {
        method: "POST",
        body: { ...values, studentId: values.studentId || null, phone: values.phone || null },
      });
      setJoined(result);
    } catch (error) {
      setErrors(fieldErrors(error));
      setFormError(errorMessage(error));
    } finally {
      setWorking(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Become a member"
        description={
          <>
            Membership costs <Money cents={SETTINGS.membershipFeeCents} /> and runs until 31 December. Sign up here, then pay your dues to a committee
            member to activate it.
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <Card className="p-5">
          {joined ? (
            <div>
              <Notice tone="ok" icon={CircleCheck} title={`Welcome, ${joined.name.split(" ")[0]}`}>
                You are on the member list.
              </Notice>
              <dl className="mt-5 space-y-3 text-sm">
                <div>
                  <dt className="text-muted">Your member number</dt>
                  <dd className="font-mono text-2xl font-bold text-ink">{joined.memberNo}</dd>
                </div>
                <div>
                  <dt className="text-muted">Dues to pay</dt>
                  <dd className="text-lg font-semibold text-ink">
                    <Money cents={joined.duesOwedCents} />
                  </dd>
                </div>
              </dl>
              <p className="mt-4 text-sm">
                Write the number down. Member prices start working once a committee member records your payment. No payment was taken on this
                site.
              </p>
              <LinkButton href="/events" className="mt-5">
                Browse events
              </LinkButton>
            </div>
          ) : (
            <form onSubmit={submit} noValidate className="space-y-4">
              <FormError message={formError} />
              <TextField label="Full name" autoComplete="name" value={values.name} onChange={set("name")} error={errors.name} required />
              <TextField
                label="Email"
                type="email"
                autoComplete="email"
                value={values.email}
                onChange={set("email")}
                error={errors.email}
                hint="Use the same email when you buy tickets to get member prices."
                required
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField label="Student ID" value={values.studentId} onChange={set("studentId")} error={errors.studentId} optional />
                <TextField label="Phone" type="tel" autoComplete="tel" value={values.phone} onChange={set("phone")} error={errors.phone} optional />
              </div>
              <Button type="submit" size="lg" loading={working}>
                Sign me up
              </Button>
              <p className="text-[0.8125rem] text-muted">
                Your details are visible only to the committee and are used to run the club.
              </p>
            </form>
          )}
        </Card>
        <Card className="h-fit p-5">
          <h2 className="text-[0.9375rem] font-semibold">What you get</h2>
          <ul className="mt-3 space-y-2.5 text-sm">
            {BENEFITS.map((benefit) => (
              <li key={benefit} className="flex items-start gap-2.5">
                <Check className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden />
                {benefit}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
