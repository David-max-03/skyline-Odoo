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
  useEffect,
  useId,
  useRef,
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
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-control font-medium transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.98] disabled:opacity-55 disabled:pointer-events-none select-none";

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
    <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
      <div className="min-w-0 flex-1">
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
      {actions && <div className="flex flex-wrap items-center gap-2 max-sm:w-full">{actions}</div>}
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
        // Font and tracking are set explicitly so a badge inside a heading does not inherit the display face.
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 font-sans text-xs font-medium tracking-normal",
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

/** A photo picker. The server checks the real file type and size; `accept` only guides the chooser. */
export function FileField({
  label,
  error,
  hint,
  optional,
  className,
  onFile,
  accept = "image/jpeg,image/png,image/webp",
}: FieldShell & { onFile: (file: File | null) => void; accept?: string }) {
  const id = useId();
  return (
    <FieldFrame id={id} label={label} error={error} hint={hint} optional={optional} className={className}>
      <input
        id={id}
        type="file"
        accept={accept}
        onChange={(event) => onFile(event.target.files?.[0] ?? null)}
        className={cn(
          CONTROL,
          "h-auto py-2 file:mr-3 file:cursor-pointer file:rounded-control file:border-0 file:bg-brand-soft file:px-3 file:py-1.5 file:text-[0.8125rem] file:font-medium file:text-brand-deep",
        )}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error, hint)}
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
  return <div className={cn("skeleton", className)} aria-hidden />;
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

/** Placeholder shaped like the table that is about to appear. */
export function TableSkeleton({ rows = 5, label = "Loading" }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">{label}…</span>
      <div className="hidden border-b border-line bg-sunken/60 px-5 py-3 sm:block">
        <Skeleton className="h-3 w-40" />
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4 border-b border-line px-5 py-4 last:border-0">
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className={cn("h-3.5", i % 2 ? "w-2/5" : "w-3/5")} />
            <Skeleton className="h-3 w-1/4" />
          </div>
          <Skeleton className="hidden h-6 w-20 rounded-full sm:block" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

/** Placeholder for a row of stat tiles. */
export function StatSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div role="status" aria-label="Loading figures" className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-card border border-line bg-surface p-4 shadow-card">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-4 h-7 w-28" />
          <Skeleton className="mt-3 h-3 w-36" />
        </div>
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
      <span className="mb-3 flex size-12 items-center justify-center rounded-full bg-sunken text-muted ring-8 ring-sunken/50">
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
    <div className="rounded-card border border-line bg-surface p-4 shadow-card sm:p-5">
      <div className="flex items-center gap-2.5">
        {Icon && (
          <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", TONES[tone])}>
            <Icon className="size-4" aria-hidden />
          </span>
        )}
        <p className="text-[0.8125rem] font-medium text-muted">{label}</p>
      </div>
      <p className="num mt-3 font-display text-[1.75rem] font-bold leading-none tracking-tight text-ink">{value}</p>
      {detail && <div className="mt-2 text-[0.8125rem] leading-snug text-muted">{detail}</div>}
    </div>
  );
}

/** A proportion bar, e.g. seats filled. Always paired with the numbers in text. */
export function Meter({
  value,
  max,
  label,
  tone = "brand",
  size = "sm",
}: {
  value: number;
  max: number;
  label: string;
  tone?: "brand" | "ok" | "warn" | "bad";
  size?: "sm" | "md";
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
      className={cn("w-full overflow-hidden rounded-full bg-line", size === "md" ? "h-2.5" : "h-1.5")}
    >
      <div className={cn("h-full rounded-full transition-[width] duration-300", fill)} style={{ width: `${ratio * 100}%` }} />
    </div>
  );
}

/**
 * Table shell with consistent cell rhythm.
 *
 * By default it scrolls sideways when it does not fit. With `stack`, each row
 * becomes a card on phones instead; give every <Td> a `label` (its column
 * name) and mark the title cell `layout="lead"` so the card reads well.
 */
export function Table({
  children,
  className,
  stack = false,
}: {
  children: ReactNode;
  className?: string;
  stack?: boolean;
}) {
  const ref = useRef<HTMLTableElement>(null);

  // Stacking changes the CSS display of the table and its rows, and some
  // screen readers then stop treating it as a table. Explicit ARIA roles keep
  // row and column navigation working. Rows are written as plain <tr> in
  // pages, so the roles are applied here and kept in step as rows change.
  useEffect(() => {
    const table = ref.current;
    if (!stack || !table) return;
    const apply = () => {
      table.querySelectorAll("thead, tbody, tfoot").forEach((el) => el.setAttribute("role", "rowgroup"));
      table.querySelectorAll("tr").forEach((el) => el.setAttribute("role", "row"));
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(table, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [stack]);

  return (
    <div className={stack ? "sm:overflow-x-auto" : "overflow-x-auto"}>
      <table
        ref={ref}
        role={stack ? "table" : undefined}
        className={cn("w-full min-w-[36rem] border-collapse text-left text-sm", stack && "stack-table", className)}
      >
        {children}
      </table>
    </div>
  );
}

export function Th({ children, className, align }: { children?: ReactNode; className?: string; align?: "right" }) {
  return (
    <th
      scope="col"
      role="columnheader"
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

export function Td({
  children,
  className,
  align,
  label,
  layout,
}: {
  children?: ReactNode;
  className?: string;
  align?: "right";
  /** Column name shown beside the value when the table is stacked. */
  label?: string;
  /** Stacked tables only: `lead` = the row's title, `block` = full width, `actions` = buttons. */
  layout?: "lead" | "block" | "actions";
}) {
  return (
    <td
      role="cell"
      data-label={label}
      data-layout={layout}
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
    <div role="group" aria-label={label} className="no-scrollbar inline-flex max-w-full gap-1 overflow-x-auto rounded-control bg-sunken p-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-[0.8125rem] font-medium transition-colors",
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
