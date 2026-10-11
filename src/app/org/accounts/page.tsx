"use client";

import { Info, ShieldOff, UserCheck, UserCog } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog, useToast } from "@/components/overlay";
import { useCan } from "@/components/session";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, LoadingBlock, Notice, PageHeader, Table, Td, Th } from "@/components/ui";
import { api, errorMessage, useApi } from "@/lib/api-client";
import { ROLE_LABELS, type CommitteeAccount } from "@/lib/contracts";
import { formatDate } from "@/lib/dates";

/** The president's list of committee accounts, with the switch that turns one off. */
export default function AccountsPage() {
  const toast = useToast();
  const canManage = useCan("manageAccounts");
  const accounts = useApi<CommitteeAccount[]>(canManage ? "/api/accounts" : null);
  const [disabling, setDisabling] = useState<CommitteeAccount | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function change(account: CommitteeAccount, action: "disable" | "enable") {
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

  return (
    <>
      <PageHeader
        title="Committee accounts"
        description="Who can sign in to the committee area, and in which role."
      />

      {!canManage ? (
        <Notice tone="neutral" icon={Info}>
          Only the president can see or change committee accounts.
        </Notice>
      ) : (
        <div className="space-y-4">
          <Card>
            <CardHeader title="Accounts" description="Disabling keeps everything the account recorded; it only stops the sign-in." />
            {accounts.error && !accounts.data ? (
              <ErrorState message={accounts.error.message} onRetry={accounts.reload} />
            ) : !accounts.data ? (
              <LoadingBlock label="Loading accounts" />
            ) : accounts.data.length === 0 ? (
              <EmptyState icon={UserCog} title="No accounts" />
            ) : (
              <Table stack>
                <thead>
                  <tr>
                    <Th>Person</Th>
                    <Th>Role</Th>
                    <Th>Added</Th>
                    <Th>Status</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {accounts.data.map((account) => (
                    <tr key={account.id} className={account.disabledAt ? "text-subtle" : "hover:bg-sunken/50"}>
                      <Td layout="lead">
                        <div className="font-medium text-ink">
                          {account.name}
                          {account.isYou && <span className="ml-2 text-xs font-medium text-muted">You</span>}
                        </div>
                        <div className="text-[0.8125rem] text-muted">{account.email}</div>
                      </Td>
                      <Td label="Role">{ROLE_LABELS[account.role]}</Td>
                      <Td label="Added" className="whitespace-nowrap text-muted">{formatDate(account.createdAt.slice(0, 10))}</Td>
                      <Td label="Status">
                        {account.disabledAt ? <Badge tone="bad">Disabled</Badge> : <Badge tone="ok">Active</Badge>}
                      </Td>
                      <Td layout="actions">
                        {account.isYou ? null : account.disabledAt ? (
                          <Button size="sm" variant="secondary" icon={UserCheck} loading={busy === account.id} onClick={() => change(account, "enable")}>
                            Enable
                          </Button>
                        ) : (
                          <Button size="sm" variant="ghost" icon={ShieldOff} className="!text-bad hover:!bg-bad-soft" onClick={() => setDisabling(account)}>
                            Disable
                          </Button>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          <Notice tone="neutral" icon={Info} title="Adding an account">
            New committee accounts are created from the command line by whoever holds the database connection, not from this page.
            You cannot disable your own account, so there is always one active president.
          </Notice>
        </div>
      )}

      <ConfirmDialog
        open={disabling !== null}
        onClose={() => setDisabling(null)}
        onConfirm={() => disabling && change(disabling, "disable")}
        title={`Disable ${disabling?.name ?? "this account"}?`}
        confirmLabel="Disable account"
        danger
        loading={busy !== null}
      >
        <p>They are signed out on every device straight away and cannot sign in again until you enable the account.</p>
        <p className="mt-3 text-muted">Nothing they recorded is removed: ledger entries, reviews and check-ins keep their name.</p>
      </ConfirmDialog>
    </>
  );
}
