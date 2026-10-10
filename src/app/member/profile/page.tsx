"use client";

import { useState, type FormEvent } from "react";
import { useToast } from "@/components/overlay";
import { Button, Card, CardHeader, ErrorState, FormError, LoadingBlock, PageHeader, TextField } from "@/components/ui";
import { api, errorMessage, fieldErrors, useApi } from "@/lib/api-client";
import { MEMBER_PASSWORD_MIN, type MemberDetail } from "@/lib/contracts";

function ContactForm({ member, onSaved }: { member: MemberDetail; onSaved: () => void }) {
  const toast = useToast();
  const [phone, setPhone] = useState(member.phone ?? "");
  const [studentId, setStudentId] = useState(member.studentId ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    setErrors({});
    try {
      await api("/api/me", { method: "PATCH", body: { phone: phone || null, studentId: studentId || null } });
      toast.success("Your details are saved.");
      onSaved();
    } catch (error) {
      setErrors(fieldErrors(error));
      setFormError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4 p-5">
      <FormError message={formError} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Name" value={member.name} disabled readOnly />
        <TextField label="Member ID" value={member.memberNo} disabled readOnly />
      </div>
      <TextField label="Email" value={member.email} disabled readOnly hint="To change your name or email, ask the treasurer." />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Phone" type="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} error={errors.phone} optional />
        <TextField label="Student ID" value={studentId} onChange={(e) => setStudentId(e.target.value)} error={errors.studentId} optional />
      </div>
      <Button type="submit" loading={saving}>
        Save details
      </Button>
    </form>
  );
}

function PasswordForm() {
  const toast = useToast();
  const [values, setValues] = useState({ currentPassword: "", newPassword: "", confirm: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (key: keyof typeof values) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (values.newPassword !== values.confirm) {
      setErrors({ confirm: "The two passwords do not match" });
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      await api("/api/me/password", { method: "POST", body: { currentPassword: values.currentPassword, newPassword: values.newPassword } });
      toast.success("Password changed. Other devices have been signed out.");
      setValues({ currentPassword: "", newPassword: "", confirm: "" });
    } catch (error) {
      setErrors(fieldErrors(error));
      setFormError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4 p-5">
      <FormError message={formError} />
      <TextField label="Current password" type="password" autoComplete="current-password" value={values.currentPassword} onChange={set("currentPassword")} error={errors.currentPassword} required />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="New password"
          type="password"
          autoComplete="new-password"
          value={values.newPassword}
          onChange={set("newPassword")}
          error={errors.newPassword}
          hint={`At least ${MEMBER_PASSWORD_MIN} characters.`}
          required
        />
        <TextField label="Type it again" type="password" autoComplete="new-password" value={values.confirm} onChange={set("confirm")} error={errors.confirm} required />
      </div>
      <Button type="submit" loading={saving}>
        Change password
      </Button>
    </form>
  );
}

export default function ProfilePage() {
  const me = useApi<MemberDetail>("/api/me");
  return (
    <>
      <PageHeader title="Profile" description="Your contact details and password." />
      {me.error && !me.data ? (
        <Card>
          <ErrorState message={me.error.message} onRetry={me.reload} />
        </Card>
      ) : !me.data ? (
        <Card>
          <LoadingBlock label="Loading your profile" />
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader title="Contact details" />
            <ContactForm key={me.data.id} member={me.data} onSaved={me.reload} />
          </Card>
          <Card className="h-fit">
            <CardHeader title="Password" description="Changing it signs you out everywhere else." />
            <PasswordForm />
          </Card>
        </div>
      )}
    </>
  );
}
