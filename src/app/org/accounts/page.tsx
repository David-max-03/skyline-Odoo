"use client";

import {
  CircleAlert,
  Copy,
  Info,
  KeyRound,
  MoreHorizontal,
  Search,
  ShieldOff,
  UserCheck,
  UserCog,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ConfirmDialog, Dialog, DialogActions, useToast } from "@/components/overlay";
import { useCan } from "@/components/session";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  FormError,
  LoadingBlock,
  Notice,
  PageHeader,
  Segmented,
  SelectField,
  Table,
  Td,
  TextField,
  Th,
  buttonClass,
  cn,
} from "@/components/ui";
import { api, errorMessage, fieldErrors, useApi } from "@/lib/api-client";
import {
  ROLES,
  ROLE_LABELS,
  type CommitteeAccount,
  type CommitteeAccountCreated,
  type CommitteeSetupLink,
  type Member,
  type Role,
} from "@/lib/contracts";
import { formatDate, formatDateTime } from "@/lib/dates";

type Status = "active" | "invited" | "disabled";
const statusOf = (a: CommitteeAccount): Status => (a.disabledAt ? "disabled" : a.setupPending ? "invited" : "active");
const STATUS_LABELS: Record<Status, string> = { active: "Active", invited: "Invited", disabled: "Disabled" };
const STATUS_TONES = { active: "ok", invited: "warn", disabled: "bad" } as const;
const ROLE_TONES = { admin: "brand", treasurer: "neutral", organizer: "neutral" } as const;

const SEARCH_INPUT =
  "h-10 w-full rounded-control border border-line-strong bg-surface pl-9 pr-3 text-sm text-ink placeholder:text-subtle focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25";

/** The president's committee management: who can sign in to the committee area, in which role. */
export default function AccountsPage() {
  const toast = useToast();
  const canManage = useCan("manageAccounts");
  const accounts = useApi<CommitteeAccount[]>(canManage ? "/api/accounts" : null);
  const [search, setSearch] = useState("");
  const [role, setRole] = useState<Role | "all">("all");
  const [status, setStatus] = useState<Status | "all">("all");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<CommitteeAccount | null>(null);
  const [disabling, setDisabling] = useState<CommitteeAccount | null>(null);
  const [relinking, setRelinking] = useState<CommitteeAccount | null>(null);
  const [link, setLink] = useState<CommitteeSetupLink | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function changeStatus(account: CommitteeAccount, action: "disable" | "enable") {
    setBusy(account.id);
    try {
      await api(`/api/accounts/${account.id}`, { method: "POST", body: { action } });
      toast.success(
        action === "disable"
          ? `${account.name} is signed out everywhere and can no longer sign in.`
          : `${account.name} can sign in again with their existing password.`,
      );
      setDisabling(null);
      accounts.reload();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function newLink(account: CommitteeAccount) {
    setBusy(account.id);
    try {
      setLink(await api<CommitteeSetupLink>(`/api/accounts/${account.id}/setup-link`, { method: "POST" }));
      setRelinking(null);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  if (!canManage) {
    return (
      <>
        <PageHeader title="Committee" description="Who can sign in to the committee area, and in which role." />
        <Notice tone="neutral" icon={Info}>
          Only the president can see or change committee accounts.
        </Notice>
      </>
    );
  }

  const all = accounts.data ?? [];
  const needle = search.trim().toLowerCase();
  const shown = all.filter(
    (a) =>
      (role === "all" || a.role === role) &&
      (status === "all" || statusOf(a) === status) &&
      (!needle || a.name.toLowerCase().includes(needle) || a.email.toLowerCase().includes(needle)),
  );
  const count = (s: Status | "all") => (s === "all" ? all.length : all.filter((a) => statusOf(a) === s).length);

  function actionsFor(account: CommitteeAccount): MenuItem[] {
    if (account.isYou) return [];
    const items: MenuItem[] = [{ label: "Change role", icon: UserCog, onSelect: () => setEditing(account) }];
    if (account.disabledAt) {
      items.push({ label: "Restore access", icon: UserCheck, onSelect: () => changeStatus(account, "enable") });
    } else {
      // A president with a password never gets a link from someone else; the server refuses it too.
      if (account.setupPending || account.role !== "admin") {
        items.push({
          label: account.setupPending ? "New setup link" : "Reset password link",
          icon: KeyRound,
          onSelect: () => (account.setupPending ? newLink(account) : setRelinking(account)),
        });
      }
      items.push({ label: "Remove access", icon: ShieldOff, danger: true, onSelect: () => setDisabling(account) });
    }
    return items;
  }

  return (
    <>
      <PageHeader
        title="Committee"
        description="Who can sign in to the committee area, and in which role. Only presidents see this page."
        actions={
          <Button icon={UserPlus} onClick={() => setAdding(true)}>
            Add Committee Member
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented
          label="Filter by status"
          value={status}
          onChange={setStatus}
          options={(["all", "active", "invited", "disabled"] as const).map((s) => ({
            value: s,
            label: s === "all" ? "All" : STATUS_LABELS[s],
            count: count(s),
          }))}
        />
        <select
          aria-label="Filter by role"
          value={role}
          onChange={(e) => setRole(e.target.value as Role | "all")}
          className="h-10 rounded-control border border-line-strong bg-surface px-3 pr-8 text-sm text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
        >
          <option value="all">All roles</option>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
        <div className="relative w-full sm:ml-auto sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" aria-hidden />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or email"
            aria-label="Search committee accounts by name or email"
            className={SEARCH_INPUT}
          />
        </div>
      </div>

      <Card>
        {accounts.error && !accounts.data ? (
          <ErrorState message={accounts.error.message} onRetry={accounts.reload} />
        ) : !accounts.data ? (
          <LoadingBlock label="Loading committee accounts" />
        ) : shown.length === 0 ? (
          <EmptyState
            icon={UserCog}
            title={all.length === 0 ? "No committee accounts" : "No accounts match"}
            description={all.length === 0 ? undefined : "Try a different search or filter."}
          />
        ) : (
          <Table stack>
            <thead>
              <tr>
                <Th>Person</Th>
                <Th>Role</Th>
                <Th>Added</Th>
                <Th>Status</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {shown.map((account) => (
                <tr key={account.id} className={account.disabledAt ? "text-subtle" : "hover:bg-sunken/50"}>
                  <Td layout="lead">
                    <div className="font-medium text-ink">
                      {account.name}
                      {account.isYou && <span className="ml-2 text-xs font-medium text-muted">You</span>}
                    </div>
                    <div className="break-all text-[0.8125rem] text-muted">{account.email}</div>
                    {account.memberNo && (
                      <div className="text-[0.8125rem] text-muted">
                        Also member <span className="font-mono">{account.memberNo}</span>
                      </div>
                    )}
                  </Td>
                  <Td label="Role">
                    <Badge tone={ROLE_TONES[account.role]}>{ROLE_LABELS[account.role]}</Badge>
                  </Td>
                  <Td label="Added" className="whitespace-nowrap text-muted">
                    {formatDate(account.createdAt.slice(0, 10))}
                  </Td>
                  <Td label="Status">
                    <Badge tone={STATUS_TONES[statusOf(account)]}>{STATUS_LABELS[statusOf(account)]}</Badge>
                  </Td>
                  <Td layout="actions">
                    {account.isYou ? (
                      <span className="text-[0.8125rem] text-muted">Your account</span>
                    ) : (
                      <RowMenu label={`Actions for ${account.name}`} items={actionsFor(account)} loading={busy === account.id} />
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Notice tone="neutral" icon={Info} title="Accounts are never deleted" className="mt-4">
        Removing access signs the person out and stops them signing in, but keeps the account, because ledger entries, reviews and
        check-ins carry its name. You cannot remove your own access or change your own role, so there is always an active president.
      </Notice>

      <AddDialog
        open={adding}
        onClose={() => setAdding(false)}
        taken={new Set(all.map((a) => a.memberNo).filter((n): n is string => n !== null))}
        onCreated={(created) => {
          setAdding(false);
          setLink(created.setupLink);
          accounts.reload();
        }}
      />

      <RoleDialog
        account={editing}
        onClose={() => setEditing(null)}
        onSaved={(updated) => {
          setEditing(null);
          toast.success(`${updated.name} is now ${ROLE_LABELS[updated.role]} and has been signed out.`);
          accounts.reload();
        }}
      />

      <ConfirmDialog
        open={disabling !== null}
        onClose={() => setDisabling(null)}
        onConfirm={() => disabling && changeStatus(disabling, "disable")}
        title={`Remove access for ${disabling?.name ?? "this account"}?`}
        confirmLabel="Remove access"
        danger
        loading={busy !== null}
      >
        <p>They are signed out on every device straight away and cannot sign in again until you restore access.</p>
        <p className="mt-3 text-muted">
          The account is disabled, not deleted: ledger entries, reviews and check-ins keep their name.
          {disabling?.memberNo && ` Their membership (${disabling.memberNo}) is not affected.`}
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={relinking !== null}
        onClose={() => setRelinking(null)}
        onConfirm={() => relinking && newLink(relinking)}
        title={`Create a password link for ${relinking?.name ?? "this account"}?`}
        confirmLabel="Create link"
        loading={busy !== null}
      >
        <p>Whoever opens the link can choose a new password for this account, so pass it only to {relinking?.name}.</p>
        <p className="mt-3 text-muted">Their current password keeps working until the link is used.</p>
      </ConfirmDialog>

      <LinkDialog link={link} onClose={() => setLink(null)} />
    </>
  );
}

// --- Row actions menu -------------------------------------------------------------

interface MenuItem {
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  danger?: boolean;
}

/**
 * A menu button. The list is positioned against the viewport so the table's
 * scroll container cannot clip it. Arrow keys move, Escape closes, and focus
 * goes back to the button.
 */
function RowMenu({ label, items, loading }: { label: string; items: MenuItem[]; loading: boolean }) {
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!at) return;
    list.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const close = () => setAt(null);
    const outside = (event: MouseEvent) => {
      if (!list.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("mousedown", outside);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", outside);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [at]);

  function toggle() {
    if (at) return setAt(null);
    const box = button.current!.getBoundingClientRect();
    setAt({ top: box.bottom + 4, right: Math.max(8, window.innerWidth - box.right) });
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const options = [...(list.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      options[(index + step + options.length) % options.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      options[event.key === "Home" ? 0 : options.length - 1]?.focus();
    } else if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") event.preventDefault();
      setAt(null);
      button.current?.focus();
    }
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        className={buttonClass("secondary", "sm")}
        disabled={loading}
        aria-busy={loading || undefined}
        aria-haspopup="menu"
        aria-expanded={at !== null}
        aria-controls={at ? id : undefined}
        aria-label={label}
        onClick={toggle}
      >
        <MoreHorizontal className="size-4 shrink-0" aria-hidden />
        Actions
      </button>
      {at && (
        <div
          ref={list}
          id={id}
          role="menu"
          aria-label={label}
          onKeyDown={onKeyDown}
          style={{ top: at.top, right: at.right }}
          className="fixed z-50 min-w-48 rounded-card border border-line bg-surface p-1 text-left shadow-raised"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setAt(null);
                button.current?.focus();
                item.onSelect();
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-control px-3 py-2 text-sm font-medium hover:bg-sunken focus:bg-sunken focus:outline-none",
                item.danger ? "text-bad" : "text-ink",
              )}
            >
              <item.icon className="size-4" aria-hidden />
              {item.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

// --- Add ----------------------------------------------------------------------------

interface AddProps {
  onClose: () => void;
  onCreated: (created: CommitteeAccountCreated) => void;
  /** Member numbers that already have a committee account. */
  taken: Set<string>;
}

function AddDialog({ open, ...props }: AddProps & { open: boolean }) {
  return (
    <Dialog open={open} onClose={props.onClose} title="Add Committee Member" description="They choose their own password with a one-time link.">
      {/* Mounted only while open, so each opening starts with an empty form. */}
      {open && <AddForm {...props} />}
    </Dialog>
  );
}

function AddForm({ onClose, onCreated, taken }: AddProps) {
  const [mode, setMode] = useState<"new" | "member">("new");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role | "">("");
  const [query, setQuery] = useState("");
  const [member, setMember] = useState<Member | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const members = useApi<Member[]>(mode === "member" ? "/api/members" : null);

  const needle = query.trim().toLowerCase();
  const matches = needle
    ? (members.data ?? [])
        .filter((m) => m.name.toLowerCase().includes(needle) || m.email.toLowerCase().includes(needle) || m.memberNo.toLowerCase().includes(needle))
        .slice(0, 6)
    : [];

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const found: Record<string, string> = {};
    if (!role) found.role = "Choose a committee role";
    if (mode === "member" && !member) found.memberId = "Choose a member";
    if (mode === "new" && name.trim().length < 2) found.name = "Enter the person's full name";
    if (mode === "new" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) found.email = "Enter a valid email address";
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setWorking(true);
    try {
      const body = mode === "member" ? { role, memberId: member!.id } : { role, name: name.trim(), email: email.trim() };
      onCreated(await api<CommitteeAccountCreated>("/api/accounts", { method: "POST", body }));
    } catch (error) {
      setErrors(fieldErrors(error));
      setFormError(errorMessage(error));
    } finally {
      setWorking(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4 text-sm">
      <FormError message={formError} />
      <Segmented
        label="Who to add"
        value={mode}
        onChange={(next) => {
          setMode(next);
          setErrors({});
          setFormError(null);
        }}
        options={[
          { value: "new", label: "New person" },
          { value: "member", label: "Existing member" },
        ]}
      />

      {mode === "new" ? (
        <>
          <TextField label="Full name" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} autoComplete="off" required />
          <TextField
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={errors.email}
            hint="They sign in with this email."
            autoComplete="off"
            required
          />
        </>
      ) : member ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-line bg-sunken px-3 py-2.5">
          <div className="min-w-0">
            <p className="font-medium text-ink">
              {member.name} <span className="font-mono font-normal text-muted">· {member.memberNo}</span>
            </p>
            <p className="break-all text-[0.8125rem] text-muted">{member.email}</p>
          </div>
          <Button size="sm" variant="secondary" onClick={() => setMember(null)}>
            Change
          </Button>
        </div>
      ) : (
        <div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name, email or member ID"
              aria-label="Search members by name, email or member ID"
              aria-invalid={errors.memberId ? true : undefined}
              className={SEARCH_INPUT}
            />
          </div>
          {errors.memberId && (
            <p role="alert" className="mt-1.5 text-[0.8125rem] text-bad">
              {errors.memberId}
            </p>
          )}
          <div className="mt-2" aria-live="polite">
            {members.error && !members.data ? (
              <p className="text-bad">{members.error.message}</p>
            ) : !members.data ? (
              <p className="text-muted">Loading members…</p>
            ) : !needle ? (
              <p className="text-muted">Type to search {members.data.length} members.</p>
            ) : matches.length === 0 ? (
              <p className="text-muted">No member matches.</p>
            ) : (
              <ul className="divide-y divide-line rounded-control border border-line">
                {matches.map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      disabled={taken.has(m.memberNo)}
                      onClick={() => {
                        setMember(m);
                        setErrors({});
                      }}
                      className="flex w-full flex-wrap items-center justify-between gap-x-3 px-3 py-2 text-left hover:bg-sunken focus:bg-sunken focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <span className="min-w-0">
                        <span className="font-medium text-ink">{m.name}</span>
                        <span className="block break-all text-[0.8125rem] text-muted">
                          <span className="font-mono">{m.memberNo}</span> · {m.email}
                        </span>
                      </span>
                      {taken.has(m.memberNo) && <span className="text-xs text-muted">Already on the committee</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <SelectField label="Committee role" value={role} onChange={(e) => setRole(e.target.value as Role | "")} error={errors.role} required>
        <option value="">Choose a role</option>
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABELS[r]}
          </option>
        ))}
      </SelectField>

      {role === "admin" && (
        <Notice tone="warn" icon={CircleAlert} title="A president has full access">
          Including money, members, and adding or removing other committee accounts.
        </Notice>
      )}
      {mode === "member" && (
        <p className="text-muted">
          Their member record, member ID, membership and history stay exactly as they are. Committee access is a separate sign-in
          with the same email and its own password, which they set with the link. Their member password keeps working for the
          member area.
        </p>
      )}

      {mode === "member" && member && role && (
        <p role="status" className="rounded-control border border-line bg-sunken px-3 py-2.5 text-ink">
          <span className="font-medium">{member.name}</span> (<span className="font-mono">{member.memberNo}</span>) will be linked to a
          new committee account with the role <span className="font-medium">{ROLE_LABELS[role]}</span>.
        </p>
      )}

      <DialogActions>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" icon={UserPlus} loading={working}>
          {mode === "member" ? "Confirm and create link" : "Add and create link"}
        </Button>
      </DialogActions>
    </form>
  );
}

// --- Edit role ------------------------------------------------------------------------

function RoleDialog({
  account,
  onClose,
  onSaved,
}: {
  account: CommitteeAccount | null;
  onClose: () => void;
  onSaved: (updated: CommitteeAccount) => void;
}) {
  return (
    <Dialog open={account !== null} onClose={onClose} title="Change role" description={account ? `${account.name} · ${account.email}` : undefined} size="sm">
      {account && <RoleForm key={account.id} account={account} onClose={onClose} onSaved={onSaved} />}
    </Dialog>
  );
}

function RoleForm({
  account,
  onClose,
  onSaved,
}: {
  account: CommitteeAccount;
  onClose: () => void;
  onSaved: (updated: CommitteeAccount) => void;
}) {
  const [role, setRole] = useState<Role>(account.role);
  const [formError, setFormError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setWorking(true);
    try {
      onSaved(await api<CommitteeAccount>(`/api/accounts/${account.id}`, { method: "PATCH", body: { role } }));
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setWorking(false);
    }
  }

  return (
    <form onSubmit={save} noValidate className="space-y-4 text-sm">
      <FormError message={formError} />
      <SelectField label="Committee role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABELS[r]}
          </option>
        ))}
      </SelectField>
      {role === "admin" && account.role !== "admin" && (
        <Notice tone="warn" icon={CircleAlert} title="A president has full access">
          Including money, members, and adding or removing other committee accounts.
        </Notice>
      )}
      <p className="text-muted">They are signed out everywhere, and the new role applies when they sign in again.</p>
      <DialogActions>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" loading={working} disabled={role === account.role}>
          Save role
        </Button>
      </DialogActions>
    </form>
  );
}

// --- The one-time link ---------------------------------------------------------------

/** Shows a setup link to the president who just created it. Only its hash is stored, so this is the only time it is seen. */
function LinkDialog({ link, onClose }: { link: CommitteeSetupLink | null; onClose: () => void }) {
  const toast = useToast();
  const url = link && typeof window !== "undefined" ? `${window.location.origin}${link.path}` : "";

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied.");
    } catch {
      toast.error("Could not copy. Select the link and copy it by hand.");
    }
  }

  return (
    <Dialog
      open={link !== null}
      onClose={onClose}
      title="Password setup link"
      description={link ? `For ${link.name} · ${ROLE_LABELS[link.role]}` : undefined}
    >
      {link && (
        <div className="space-y-4 text-sm">
          <Notice tone="warn" icon={CircleAlert} title="Send this to them yourself">
            Skyline does not send email. Pass the link to {link.name.split(" ")[0]} privately ({link.email}). It is shown only now,
            and whoever opens it chooses the password.
          </Notice>
          <div>
            <label htmlFor="committee-setup-link" className="mb-1.5 block text-[0.8125rem] font-medium text-ink">
              One-time link
            </label>
            <div className="flex gap-2">
              <input
                id="committee-setup-link"
                readOnly
                value={url}
                onFocus={(e) => e.target.select()}
                className="h-10 min-w-0 flex-1 rounded-control border border-line-strong bg-sunken px-3 font-mono text-[0.8125rem] text-ink"
              />
              <Button variant="secondary" icon={Copy} onClick={copy}>
                Copy
              </Button>
            </div>
          </div>
          <ul className="list-disc space-y-1 pl-5 text-muted">
            <li>Works once, then stops.</li>
            <li>Expires {formatDateTime(link.expiresAt)}.</li>
            <li>Creating another link for this account cancels this one.</li>
          </ul>
          <DialogActions>
            <Button onClick={onClose}>Done</Button>
          </DialogActions>
        </div>
      )}
    </Dialog>
  );
}
