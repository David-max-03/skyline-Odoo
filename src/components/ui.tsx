"use client";

/**
 * Skyline UI kit: the presentational building blocks every page uses.
 * Nothing here knows about events, members or money. Restyle freely; the only
 * contract is each component's props.
 */

import clsx, { type ClassValue } from "clsx";
import Link from "next/link";
import { CircleAlert, Inbox, LoaderCircle, RefreshCw, type LucideIcon } from "lucide-react";
import {
  useId,
  type ButtonHTMLAttributes,
  type ComponentProps,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

export const cn = (...values: ClassValue[]) => clsx(values);

// --- Button ---------------------------------------------------------------------

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-control font-medium transition-colors duration-150 disabled:opacity-55 disabled:pointer-events-none select-none";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-brand text-on-brand hover:bg-brand-strong active:bg-brand-deep",
  secondary: "border border-line-strong bg-surface text-ink hover:bg-sunken active:bg-line",
  ghost: "text-body hover:bg-sunken hover:text-ink active:bg-line",
  danger: "border border-bad/30 bg-surface text-bad hover:bg-bad-soft active:bg-bad-soft",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-9 px-3 text-[0.8125rem]",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-5 text-base",
};

export function buttonClass(variant: ButtonVariant = "primary", size: ButtonSize = "md", extra?: string) {
  return cn(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], extra);
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and blocks repeat clicks while an action is in flight. */
  loading?: boolean;
  icon?: LucideIcon;
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  icon: Icon,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonClass(variant, size, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <LoaderCircle className="size-4 animate-spin" aria-hidden />
      ) : (
        Icon && <Icon className="size-4 shrink-0" aria-hidden />
      )}
      {children}
    </button>
  );
}

export function LinkButton({
  variant = "primary",
  size = "md",
  icon: Icon,
  className,
  children,
  ...rest
}: ComponentProps<typeof Link> & { variant?: ButtonVariant; size?: ButtonSize; icon?: LucideIcon }) {
  return (
    <Link className={buttonClass(variant, size, className)} {...rest}>
      {Icon && <Icon className="size-4 shrink-0" aria-hidden />}
      {children}
    </Link>
  );
}

// --- Surfaces -------------------------------------------------------------------

export function Card({ className, children, ...rest }: ComponentProps<"section">) {
  return (
    <section
      className={cn("min-w-0 rounded-card border border-line bg-surface shadow-card", className)}
      {...rest}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-line px-5 py-4">
      <div className="min-w-0">
        <h2 className="text-[0.9375rem] font-semibold">{title}</h2>
        {description && <p className="mt-0.5 text-[0.8125rem] text-muted">{description}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </header>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  back,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        {back && (
          <Link href={back.href} className="mb-1 inline-block text-[0.8125rem] font-medium text-brand hover:underline">
            ← {back.label}
          </Link>
        )}
        <h1 className="text-2xl font-bold sm:text-[1.7rem]">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

// --- Badge ----------------------------------------------------------------------

export type Tone = "neutral" | "brand" | "ok" | "warn" | "bad";

const TONES: Record<Tone, string> = {
  neutral: "bg-sunken text-body",
  brand: "bg-brand-soft text-brand-deep",
  ok: "bg-ok-soft text-ok-strong",
  warn: "bg-warn-soft text-warn",
  bad: "bg-bad-soft text-bad",
};

export function Badge({
  tone = "neutral",
  icon: Icon,
  children,
  className,
}: {
  tone?: Tone;
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium",
        TONES[tone],
        className,
      )}
    >
      {Icon && <Icon className="size-3" aria-hidden />}
      {children}
    </span>
  );
}

// --- Form fields ----------------------------------------------------------------

const CONTROL =
  "block w-full rounded-control border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-subtle transition-colors hover:border-subtle focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25 disabled:bg-sunken disabled:text-muted aria-[invalid=true]:border-bad aria-[invalid=true]:focus:ring-bad/25";

interface FieldShell {
  label: string;
  error?: string;
  hint?: ReactNode;
  /** Appended to the label for optional fields. */
  optional?: boolean;
  className?: string;
}

function FieldFrame({
  id,
  label,
  error,
  hint,
  optional,
  className,
  children,
}: FieldShell & { id: string; children: ReactNode }) {
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-[0.8125rem] font-medium text-ink">
        {label}
        {optional && <span className="ml-1 font-normal text-subtle">(optional)</span>}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} role="alert" className="mt-1.5 flex items-start gap-1 text-[0.8125rem] text-bad">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${id}-hint`} className="mt-1.5 text-[0.8125rem] text-muted">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

const describedBy = (id: string, error?: string, hint?: ReactNode) =>
  error ? `${id}-error` : hint ? `${id}-hint` : undefined;

export function TextField({
  label,
  error,
  hint,
  optional,
  className,
  prefix,
  ...input
}: FieldShell & Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "prefix"> & { prefix?: string }) {
  const id = useId();
  return (
    <FieldFrame id={id} label={label} error={error} hint={hint} optional={optional} className={className}>
      <div className="relative">
        {prefix && (
          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted" aria-hidden>
            {prefix}
          </span>
        )}
        <input
          id={id}
          className={cn(CONTROL, "h-10", prefix && "pl-7")}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, error, hint)}
          {...input}
        />
      </div>
    </FieldFrame>
  );
}

export function SelectField({
  label,
  error,
  hint,
  optional,
  className,
  children,
  ...select
}: FieldShell & Omit<SelectHTMLAttributes<HTMLSelectElement>, "className">) {
  const id = useId();
  return (
    <FieldFrame id={id} label={label} error={error} hint={hint} optional={optional} className={className}>
      <select
        id={id}
        className={cn(CONTROL, "h-10 pr-8")}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error, hint)}
        {...select}
      >
        {children}
      </select>
    </FieldFrame>
  );
}

export function TextAreaField({
  label,
  error,
  hint,
  optional,
  className,
  ...textarea
}: FieldShell & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className">) {
  const id = useId();
  return (
    <FieldFrame id={id} label={label} error={error} hint={hint} optional={optional} className={className}>
      <textarea
        id={id}
        rows={3}
        className={cn(CONTROL, "py-2 leading-relaxed")}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error, hint)}
        {...textarea}
      />
    </FieldFrame>
  );
}

export function CheckboxField({
  label,
  hint,
  ...input
}: { label: string; hint?: ReactNode } & Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "className">) {
  const id = useId();
  return (
    <div className="flex items-start gap-2.5">
      <input id={id} type="checkbox" className="mt-0.5 size-4 shrink-0 accent-(--brand)" {...input} />
      <div>
        <label htmlFor={id} className="text-sm font-medium text-ink">
          {label}
        </label>
        {hint && <p className="text-[0.8125rem] text-muted">{hint}</p>}
      </div>
    </div>
  );
}

/** A short message above a form: what failed, in words. */
export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div role="alert" className="flex items-start gap-2 rounded-control bg-bad-soft px-3 py-2.5 text-sm text-bad">
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{message}</span>
    </div>
  );
}

// --- States ---------------------------------------------------------------------

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-control bg-line/70", className)} aria-hidden />;
}

export function LoadingBlock({ label = "Loading", rows = 4 }: { label?: string; rows?: number }) {
  return (
    <div role="status" aria-live="polite" className="space-y-3 p-5">
      <span className="sr-only">{label}…</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cn("h-9", i % 3 === 2 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}

export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <span className="mb-3 flex size-11 items-center justify-center rounded-full bg-sunken text-muted">
        <Icon className="size-5" aria-hidden />
      </span>
      <h3 className="text-[0.9375rem] font-semibold">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center px-6 py-12 text-center">
      <span className="mb-3 flex size-11 items-center justify-center rounded-full bg-bad-soft text-bad">
        <CircleAlert className="size-5" aria-hidden />
      </span>
      <h3 className="text-[0.9375rem] font-semibold">This could not be loaded</h3>
      <p className="mt-1 max-w-sm text-sm text-muted">{message}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" icon={RefreshCw} className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/** A coloured inline message. Use for things the reader should know, not for errors in forms. */
export function Notice({
  tone = "brand",
  icon: Icon,
  title,
  children,
  className,
}: {
  tone?: Tone;
  icon?: LucideIcon;
  title?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start gap-2.5 rounded-control px-3.5 py-3 text-sm", TONES[tone], className)}>
      {Icon && <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />}
      <div className="min-w-0">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={cn(title && "mt-0.5")}>{children}</div>}
      </div>
    </div>
  );
}

// --- Data display -----------------------------------------------------------------

/** One headline figure with its label and an optional line of context. */
export function Stat({
  label,
  value,
  detail,
  icon: Icon,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  icon?: LucideIcon;
  tone?: Tone;
}) {
  return (
    <div className="rounded-card border border-line bg-surface p-4 shadow-card">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[0.8125rem] font-medium text-muted">{label}</p>
        {Icon && (
          <span className={cn("flex size-7 items-center justify-center rounded-md", TONES[tone])}>
            <Icon className="size-4" aria-hidden />
          </span>
        )}
      </div>
      <p className="num mt-2 font-display text-2xl font-bold tracking-tight text-ink">{value}</p>
      {detail && <p className="mt-1 text-[0.8125rem] text-muted">{detail}</p>}
    </div>
  );
}

/** A proportion bar, e.g. seats filled. Always paired with the numbers in text. */
export function Meter({
  value,
  max,
  label,
  tone = "brand",
}: {
  value: number;
  max: number;
  label: string;
  tone?: "brand" | "ok" | "warn" | "bad";
}) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const fill = { brand: "bg-brand", ok: "bg-ok", warn: "bg-accent", bad: "bg-bad" }[tone];
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className="h-1.5 w-full overflow-hidden rounded-full bg-line"
    >
      <div className={cn("h-full rounded-full transition-[width] duration-300", fill)} style={{ width: `${ratio * 100}%` }} />
    </div>
  );
}

/** Horizontally scrollable table shell with consistent cell rhythm. */
export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className={cn("w-full min-w-[36rem] border-collapse text-left text-sm", className)}>{children}</table>
    </div>
  );
}

export function Th({ children, className, align }: { children?: ReactNode; className?: string; align?: "right" }) {
  return (
    <th
      scope="col"
      className={cn(
        "border-b border-line bg-sunken/60 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted first:pl-5 last:pr-5",
        align === "right" && "text-right",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({ children, className, align }: { children?: ReactNode; className?: string; align?: "right" }) {
  return (
    <td
      className={cn(
        "border-b border-line px-4 py-3 align-middle first:pl-5 last:pr-5",
        align === "right" && "num text-right",
        className,
      )}
    >
      {children}
    </td>
  );
}

/** A row of mutually exclusive filters. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string; count?: number }[];
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex max-w-full flex-wrap gap-1 rounded-control bg-sunken p-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[0.8125rem] font-medium transition-colors",
            value === option.value ? "bg-surface text-ink shadow-card" : "text-muted hover:text-ink",
          )}
        >
          {option.label}
          {option.count !== undefined && <span className="num text-xs text-subtle">{option.count}</span>}
        </button>
      ))}
    </div>
  );
}
