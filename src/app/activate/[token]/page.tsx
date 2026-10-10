"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { CircleCheck, KeyRound } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Logo } from "@/components/public-shell";
import { Button, Card, FormError, LinkButton, Notice, Skeleton, TextField } from "@/components/ui";
import { ApiError, api, errorMessage, fieldErrors } from "@/lib/api-client";
import { MEMBER_PASSWORD_MIN, type SetupTokenInfo } from "@/lib/contracts";
import { formatDateTime } from "@/lib/dates";

type State =
  | { step: "checking" }
  | { step: "invalid"; message: string }
  | { step: "form"; info: SetupTokenInfo }
  | { step: "done"; memberNo: string };

export default function ActivatePage() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<State>({ step: "checking" });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<SetupTokenInfo>("/api/auth/setup/check", { method: "POST", body: { token } }).then(
      (info) => !cancelled && setState({ step: "form", info }),
      (error: unknown) => !cancelled && setState({ step: "invalid", message: errorMessage(error) }),
    );
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (password !== confirm) {
      setErrors({ confirm: "The two passwords do not match" });
      return;
    }
    setErrors({});
    setWorking(true);
    try {
      const result = await api<{ memberNo: string }>("/api/auth/setup", { method: "POST", body: { token, password } });
      setState({ step: "done", memberNo: result.memberNo });
    } catch (error) {
      // A link that stopped working while the form was open cannot be retried.
      if (error instanceof ApiError && error.code === "invalid_link") {
        setState({ step: "invalid", message: error.message });
      } else {
        setErrors(fieldErrors(error));
        setFormError(errorMessage(error));
      }
    } finally {
      setWorking(false);
    }
  }

  return (
    <main id="main" className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <Link href="/" className="mb-8 inline-block rounded-control" aria-label="Skyline home">
          <Logo />
        </Link>

        {state.step === "checking" && (
          <div role="status" aria-label="Checking your link">
            <Skeleton className="h-64 w-full" />
          </div>
        )}

        {state.step === "invalid" && (
          <>
            <h1 className="text-2xl font-bold">This link cannot be used</h1>
            <Card className="mt-6 p-5">
              <p className="text-sm">{state.message}</p>
              <p className="mt-3 text-sm text-muted">
                Setup links work once and expire after three days. Ask the treasurer or president to send you a new one.
              </p>
              <LinkButton href="/login" variant="secondary" className="mt-5">
                Go to sign in
              </LinkButton>
            </Card>
          </>
        )}

        {state.step === "form" && (
          <>
            <h1 className="text-2xl font-bold">Set your password</h1>
            <p className="mt-1 text-sm text-muted">
              For {state.info.name}, member ID <span className="font-mono text-ink">{state.info.memberNo}</span>. This link works once and
              expires {formatDateTime(state.info.expiresAt)}.
            </p>
            <Card className="mt-6 p-5">
              <form onSubmit={submit} noValidate className="space-y-4">
                <FormError message={formError} />
                <TextField
                  label="New password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  error={errors.password}
                  hint={`At least ${MEMBER_PASSWORD_MIN} characters. A few unrelated words work well.`}
                  required
                  autoFocus
                />
                <TextField
                  label="Type it again"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  error={errors.confirm}
                  required
                />
                <Button type="submit" size="lg" className="w-full" icon={KeyRound} loading={working}>
                  Set password
                </Button>
              </form>
            </Card>
          </>
        )}

        {state.step === "done" && (
          <>
            <h1 className="text-2xl font-bold">Your account is ready</h1>
            <Card className="mt-6 p-5">
              <Notice tone="ok" icon={CircleCheck} title="Password saved">
                Sign in with your member ID <span className="font-mono">{state.memberNo}</span> or your email.
              </Notice>
              <LinkButton href="/login" size="lg" className="mt-5 w-full">
                Sign in
              </LinkButton>
            </Card>
          </>
        )}
      </div>
    </main>
  );
}
