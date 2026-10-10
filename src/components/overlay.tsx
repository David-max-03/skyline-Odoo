"use client";

import { CircleAlert, CircleCheck, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button, cn } from "./ui";

// --- Dialog ---------------------------------------------------------------------

/**
 * Modal built on the native <dialog>: the browser provides the focus trap,
 * Escape to close, and inert background.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog element itself.
        if (event.target === ref.current) onClose();
      }}
      aria-labelledby="dialog-title"
      className={cn(
        "m-auto w-[calc(100vw-1.5rem)] rounded-card border border-line bg-surface p-0 text-body shadow-raised open:animate-rise",
        { sm: "max-w-md", md: "max-w-xl", lg: "max-w-3xl" }[size],
      )}
    >
      {open && (
        <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
          <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div>
              <h2 id="dialog-title" className="text-lg font-semibold">
                {title}
              </h2>
              {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-mr-1.5 -mt-1 flex size-9 shrink-0 items-center justify-center rounded-control text-muted hover:bg-sunken hover:text-ink"
            >
              <X className="size-4" aria-hidden />
            </button>
          </header>
          <div className="overflow-y-auto px-5 py-5">{children}</div>
        </div>
      )}
    </dialog>
  );
}

/** Right-aligned row of buttons at the bottom of a dialog form. */
export function DialogActions({ children }: { children: ReactNode }) {
  return <div className="mt-6 flex flex-wrap justify-end gap-2">{children}</div>;
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  children,
  confirmLabel,
  danger = false,
  loading = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  loading?: boolean;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={title} size="sm">
      <div className="text-sm text-body">{children}</div>
      <DialogActions>
        <Button variant="secondary" onClick={onClose}>
          Keep as is
        </Button>
        <Button variant={danger ? "danger" : "primary"} loading={loading} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// --- Toasts ---------------------------------------------------------------------

interface ToastItem {
  id: number;
  kind: "success" | "error";
  message: string;
}

interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast must be used inside <ToastProvider>");
  return api;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setItems((list) => list.filter((t) => t.id !== id)), []);

  const push = useCallback(
    (kind: ToastItem["kind"], message: string) => {
      const id = nextId.current++;
      setItems((list) => [...list.slice(-2), { id, kind, message }]);
      // Errors stay longer: they usually need reading twice.
      window.setTimeout(() => dismiss(id), kind === "error" ? 7000 : 4000);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({ success: (m) => push("success", m), error: (m) => push("error", m) }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        className="no-print pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:items-end"
      >
        {items.map((toast) => (
          <div
            key={toast.id}
            role={toast.kind === "error" ? "alert" : "status"}
            className="pointer-events-auto flex w-full max-w-sm animate-rise items-start gap-2.5 rounded-card border border-night-line bg-night px-4 py-3 text-sm text-on-night shadow-raised"
          >
            {toast.kind === "success" ? (
              <CircleCheck className="mt-0.5 size-4 shrink-0 text-ok-soft" aria-hidden />
            ) : (
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-bad-soft" aria-hidden />
            )}
            <p className="min-w-0 flex-1">{toast.message}</p>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              aria-label="Dismiss"
              className="-mr-1 flex size-6 shrink-0 items-center justify-center rounded text-on-night-muted hover:text-on-night"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
