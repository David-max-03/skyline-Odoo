"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { Suspense, useEffect, useState, type FormEvent } from "react";
import { Logo } from "@/components/public-shell";
import { Button, Card, FormError, Skeleton, TextField } from "@/components/ui";
import { api, errorMessage, fieldErrors, useApi } from "@/lib/api-client";
import { ROLE_LABELS, type AccountRole, type SessionUser } from "@/lib/contracts";

interface Me {
  user: SessionUser | null;
  demo: { accounts: { email: string; name: string; role: AccountRole }[]; password: string } | null;
}

/** Only same-site paths are accepted, so the sign-in link cannot bounce people elsewhere. */
function safeNext(value: string | null): string | null {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : null;
}

/** Members land in the member area and staff in the committee area, whatever `next` says. */
function destination(user: SessionUser, next: string | null): string {
  const home = user.role === "member" ? "/member" : "/org";
  return next && (next === home || next.startsWith(`${home}/`)) ? next : home;
}

function LoginForm() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get("next"));
  const me = useApi<Me>("/api/auth/me");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const signedInAs = me.data?.user ?? null;
  useEffect(() => {
    if (signedInAs) router.replace(destination(signedInAs, next));
  }, [signedInAs, router, next]);

  async function signIn(credentials: { email: string; password: string }) {
    setWorking(true);
    setFormError(null);
    setErrors({});
    try {
      const { user } = await api<{ user: SessionUser }>("/api/auth/login", { method: "POST", body: credentials });
      // A full navigation, so the proxy and layout see the new cookie.
      window.location.assign(destination(user, next));
    } catch (error) {
      setErrors(fieldErrors(error));
      setFormError(errorMessage(error));
      setWorking(false);
    }
  }

  return (
    <div className="w-full max-w-md">
      <Link href="/" className="mb-8 inline-block rounded-control" aria-label="Skyline home">
        <Logo />
      </Link>
      <h1 className="text-2xl font-bold">Sign in</h1>
      <p className="mt-1 text-sm text-muted">
        Members sign in with their member ID or email. The committee signs in with their email.
      </p>

      <Card className="mt-6 p-5">
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void signIn({ email: identifier, password });
          }}
        >
          <FormError message={formError} />
          <TextField
            label="Email or member ID"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="you@example.com or SKY-M-0001"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            error={errors.email}
            required
          />
          <TextField label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} error={errors.password} required />
          <Button type="submit" size="lg" className="w-full" loading={working}>
            Sign in
          </Button>
        </form>
        <p className="mt-4 text-[0.8125rem] text-muted">
          Not a member yet?{" "}
          <Link href="/join" className="font-medium text-brand hover:underline">
            Apply to join
          </Link>
          . Forgotten your password, or never set one? Ask the treasurer for a new setup link.
        </p>
      </Card>

      {me.data?.demo && (
        <Card className="mt-4 p-5">
          <p className="flex items-center gap-2 text-sm font-semibold text-ink">
            <ShieldCheck className="size-4 text-brand" aria-hidden />
            Demo accounts
          </p>
          <p className="mt-1 text-[0.8125rem] text-muted">
            This is a demo installation. Each role sees and can do different things; the server enforces it.
          </p>
          <ul className="mt-3 space-y-2">
            {me.data.demo.accounts.map((account) => (
              <li key={account.email}>
                <button
                  type="button"
                  disabled={working}
                  onClick={() => void signIn({ email: account.email, password: me.data!.demo!.password })}
                  className="flex w-full items-center justify-between gap-3 rounded-control border border-line px-3 py-2.5 text-left transition-colors hover:border-brand-line hover:bg-brand-soft disabled:opacity-60"
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-ink">{ROLE_LABELS[account.role]}</span>
                    <span className="block truncate text-[0.8125rem] text-muted">
                      {account.name} · {account.email}
                    </span>
                  </span>
                  <span className="shrink-0 text-[0.8125rem] font-medium text-brand">Sign in →</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

export default function LoginPage() {
  return (
    <main id="main" className="flex min-h-dvh items-center justify-center px-4 py-10">
      <Suspense fallback={<Skeleton className="h-80 w-full max-w-md" />}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
