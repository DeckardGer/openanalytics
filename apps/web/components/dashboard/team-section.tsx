"use client";

import { AnimatePresence, motion } from "motion/react";
import * as React from "react";
import { createPortal } from "react-dom";
import { CreditCardIcon, ViewIcon } from "hugeicons-react";
import {
  ChevronDownIcon,
  DeleteIcon,
  PlusIcon,
  SettingsIcon,
} from "@/components/icons/hugeicons";
import { useDeploymentSettings } from "@/components/dashboard/deployment-section";
import { FlowDialog } from "@/components/dashboard/flow-dialog";
import { SettingsPanel } from "@/components/dashboard/settings-panel";
import {
  DropdownMenu,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  SkeletonBar,
  SkeletonCircle,
  SkeletonReveal,
} from "@/components/ui/skeleton-reveal";
import { UserAvatar } from "@/components/ui/user-avatar";
import {
  ApiError,
  errorCodeOf,
  LIVE_API,
  presentError,
  team,
  type SiteInvite,
  type SiteMember,
  type SiteRole,
  type SiteSummary,
} from "@/lib/api";
import { isSuccessorRequired, SuccessorDialog } from "@seam/slots";
import { useSession } from "@/lib/auth-client";
import { MOCK_INVITES, MOCK_MEMBERS, MOCK_SELF_USER_ID } from "@/lib/mock";
import { useAction, useApi } from "@/lib/use-api";
import { cn } from "@/lib/utils";

/**
 * Team — members, invites, roles.
 *
 * The contract rules this UI encodes:
 *  - `SiteMember` carries `email` and `name` (`name` null when never set) —
 *    rows show the person, never a UUID.
 *  - Only an owner may grant or revoke `owner`; an admin's role picker hides
 *    the option rather than letting them discover a 403.
 *  - Demoting or removing the billing owner answers 409
 *    `BILLING_OWNER_SUCCESSOR_REQUIRED` — a successor flow, not an error.
 *  - The invite list is a work queue: `pending` rows plus `expired` ones
 *    (30 days past expiry). Resend revives an expired invitation with a new
 *    token — and kills the previous link. Revoke works on both.
 *  - The two 409s on invite are different codes with different remedies:
 *    `IDEMPOTENCY_CONFLICT` (a live invite exists — act on the list) vs
 *    `ALREADY_MEMBER` (nothing to send).
 */

/** What a member row leads with: the name, else the address. */
export function memberLabel(member: SiteMember): string {
  return member.name ?? member.email;
}

export const ROLE_COPY: Record<SiteRole, { label: string; hint: string }> = {
  owner: {
    label: "Owner",
    hint: "Manages the team, credentials, exports and deletion.",
  },
  admin: { label: "Admin", hint: "Manages the team and credentials." },
  viewer: { label: "Viewer", hint: "Reads dashboards." },
};

const ROLES: SiteRole[] = ["owner", "admin", "viewer"];

/**
 * The invite dialog's long answers — what each role actually opens, from the
 * capability matrix. The badges keep `ROLE_COPY`'s one line; the person
 * choosing a role for a teammate deserves the boundaries spelled out,
 * including the ones that stay with the owner.
 */
/** The card's glyph: an admin turns the dials, a viewer only looks. */
const INVITE_ROLE_ICON: Partial<
  Record<SiteRole, React.ComponentType<{ className?: string }>>
> = {
  admin: SettingsIcon,
  viewer: ViewIcon,
};

const INVITE_ROLE_DETAIL: Record<SiteRole, string> = {
  owner: "", // never offered from this dialog — ownership moves by transfer
  admin:
    "Runs the site day to day: invites and removes teammates, manages API keys, connects and disconnects integrations, runs imports, edits settings. Revenue, raw exports, deleting the site and billing stay with the owner.",
  viewer:
    "Reads every dashboard (analytics, realtime, reports); revenue stays with the owner. Changes nothing: no settings, no keys, no team.",
};

export function TeamSection({ site }: { site: SiteSummary }) {
  const session = useSession();
  const selfId = LIVE_API
    ? (session.data?.user.id ?? null)
    : MOCK_SELF_USER_ID;
  const canManage = site.role === "owner" || site.role === "admin";
  const isOwner = site.role === "owner";

  const members = useApi(
    () => team.members(site.site_id).then((page) => page.items),
    () => MOCK_MEMBERS,
    site.site_id
  );
  const invites = useApi(
    () => team.invites(site.site_id).then((page) => page.items),
    () => MOCK_INVITES,
    site.site_id
  );
  // Only to say whether the operator still has to configure mail. Cheap — one
  // small read that answers `{ editable: false }` for everybody else — and it
  // is the difference between an invite that silently goes nowhere and a
  // sentence saying why.
  const { settings: deploymentSettings } = useDeploymentSettings();

  // Mock-mode copies so actions stay visible without an api behind them.
  const [localMembers, setLocalMembers] = React.useState<SiteMember[] | null>(
    null
  );
  const [localInvites, setLocalInvites] = React.useState<SiteInvite[] | null>(
    null
  );
  const memberRows = localMembers ?? members.data ?? [];
  const inviteRows = localInvites ?? invites.data ?? [];

  const [inviting, setInviting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Set when demotion/removal hits BILLING_OWNER_SUCCESSOR_REQUIRED (409).
  const [successorFor, setSuccessorFor] = React.useState<SiteMember | null>(
    null
  );

  const fail = (raised: unknown) => {
    if (errorCodeOf(raised) === "BILLING_OWNER_SUCCESSOR_REQUIRED") return; // handled by caller
    setError(presentError(raised).body);
  };

  /**
   * The one send, both modes. Throws — the invite flow presents the
   * failure, because the remedy copy belongs beside the form that caused
   * it. Mock mode raises the same code the server would, so the flow's
   * branches are exercised offline too.
   */
  const performInvite = async (email: string, role: SiteRole) => {
    if (!LIVE_API) {
      // Only a *pending* invite blocks a re-invite — an expired row no
      // longer holds the address's slot, matching the server.
      if (
        inviteRows.some(
          (pending) => pending.email === email && pending.status === "pending"
        )
      ) {
        throw new ApiError("IDEMPOTENCY_CONFLICT", "already invited", {
          status: 409,
        });
      }
      setLocalInvites([
        ...inviteRows,
        {
          invite_id: crypto.randomUUID(),
          email,
          role,
          invited_by_user_id: selfId,
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
          status: "pending",
        },
      ]);
      return;
    }
    await team.invite(site.site_id, { email, role });
    invites.reload();
  };

  /** A transient confirmation under the list — resends need their one fact
   *  said out loud: the previous link is dead. */
  const [notice, setNotice] = React.useState<string | null>(null);

  const resendInvite = (pending: SiteInvite) => {
    setError(null);
    if (!LIVE_API) {
      setLocalInvites(
        inviteRows.map((entry) =>
          entry.invite_id === pending.invite_id
            ? {
                ...entry,
                status: "pending" as const,
                expires_at: new Date(
                  Date.now() + 7 * 86_400_000
                ).toISOString(),
              }
            : entry
        )
      );
      setNotice(
        `A fresh invitation is on its way to ${pending.email}. The previous link no longer works.`
      );
      return;
    }
    team.resendInvite(site.site_id, pending.invite_id).then(() => {
      setNotice(
        `A fresh invitation is on its way to ${pending.email}. The previous link no longer works.`
      );
      invites.reload();
    }, (raised: unknown) => {
      const code = errorCodeOf(raised);
      setError(
        code === "ALREADY_MEMBER"
          ? "They joined in the meantime. Nothing to resend."
          : code === "IDEMPOTENCY_CONFLICT"
            ? "A newer invitation to that address already exists. Act on that one."
            : presentError(raised).body
      );
      invites.reload();
    });
  };

  const revokeInvite = (pending: SiteInvite) => {
    if (!LIVE_API) {
      setLocalInvites(
        inviteRows.filter((entry) => entry.invite_id !== pending.invite_id)
      );
      return;
    }
    // A second delete answers 404 — refetch rather than assume either way.
    team
      .revokeInvite(site.site_id, pending.invite_id)
      .then(() => invites.reload(), fail);
  };

  const changeRole = (member: SiteMember, nextRole: SiteRole) => {
    if (member.role === nextRole) return;
    setError(null);
    if (!LIVE_API) {
      // The member who funds the site needs a successor before they can step
      // down — a refusal only the hosted deployment raises, so design mode
      // only rehearses it where that dialog exists.
      if (
        SuccessorDialog &&
        member.user_id === MOCK_SELF_USER_ID &&
        nextRole !== "owner"
      ) {
        setSuccessorFor(member);
        return;
      }
      setLocalMembers(
        memberRows.map((entry) =>
          entry.user_id === member.user_id
            ? { ...entry, role: nextRole }
            : entry
        )
      );
      return;
    }
    team.changeRole(site.site_id, member.user_id, nextRole).then(() => {
      members.reload();
    }, (raised: unknown) => {
      fail(raised);
      if (isSuccessorRequired?.(raised)) {
        setSuccessorFor(member);
      } else if (errorCodeOf(raised) === "VALIDATION_FAILED") {
        setError("The site's last owner cannot be demoted.");
      }
    });
  };

  const remove = (member: SiteMember) => {
    setError(null);
    if (!LIVE_API) {
      if (SuccessorDialog && member.user_id === MOCK_SELF_USER_ID) {
        setSuccessorFor(member);
        return;
      }
      setLocalMembers(
        memberRows.filter((entry) => entry.user_id !== member.user_id)
      );
      return;
    }
    team.remove(site.site_id, member.user_id).then(() => {
      members.reload();
    }, (raised: unknown) => {
      fail(raised);
      if (isSuccessorRequired?.(raised)) {
        setSuccessorFor(member);
      }
    });
  };

  // Pixel-matched to the member rows — and only the rows: the chrome and the
  // invite form below never wait, and the count in the strip swaps in place
  // like the API panel's key count.
  const rowsSkeleton = (
    <ul className="divide-y divide-border">
      {[0, 1, 2].map((index) => (
        <li className="flex items-center gap-3 px-5 py-3" key={index}>
          <SkeletonCircle className="size-8" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <SkeletonBar className="h-3.5 w-24" />
            <SkeletonBar className="h-3 w-40 max-w-full" />
          </div>
          <SkeletonBar className="h-3 w-12" />
        </li>
      ))}
    </ul>
  );

  // Both lists gate the one reveal: invitations landing a beat after the
  // members used to pop a whole section in below the rows.
  const settled = members.phase !== "loading" && invites.phase !== "loading";

  return (
    <SettingsPanel
      action={
        !settled ? (
          <SkeletonBar className="mr-2 h-3.5 w-20 animate-pulse" />
        ) : members.phase === "ready" ? (
          <span className="pr-2 text-xs text-muted-foreground">
            {memberRows.length} {memberRows.length === 1 ? "member" : "members"}
          </span>
        ) : null
      }
      title="Team"
    >
      <SkeletonReveal ready={settled} skeleton={rowsSkeleton}>
      {!settled ? null : members.phase === "error" ? (
        <div className="flex flex-col items-start gap-2 p-5">
          <p className="text-sm font-medium">{members.error.title}</p>
          <p className="text-sm text-muted-foreground">{members.error.body}</p>
          {members.error.retryable ? (
            <Button onClick={members.reload} size="sm" variant="secondary">
              Try again
            </Button>
          ) : null}
        </div>
      ) : (
      <>
      <ul className="divide-y divide-border">
        {memberRows.map((member) => {
          const isSelf = member.user_id === selfId;
          // An admin can neither grant nor revoke owner — hide, don't 403.
          const assignable = ROLES.filter(
            (entry) =>
              (isOwner || (entry !== "owner" && member.role !== "owner")) &&
              entry !== member.role
          );
          return (
            <li
              key={member.user_id}
              className="group flex items-center gap-3 px-5 py-3"
            >
              <UserAvatar seed={member.user_id} size={32} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">
                    {isSelf ? "You" : memberLabel(member)}
                  </span>
                  {isSelf && site.is_billing_owner ? (
                    <Badge
                      icon={<CreditCardIcon />}
                      size="sm"
                      variant="secondary"
                    >
                      Billing
                    </Badge>
                  ) : null}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {member.email}
                </span>
              </span>

              {canManage && assignable.length > 0 ? (
                <DropdownMenu
                  className="w-40"
                  trigger={
                    <button
                      className="flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted-foreground outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      title={ROLE_COPY[member.role].hint}
                      type="button"
                    >
                      {ROLE_COPY[member.role].label}
                      <ChevronDownIcon className="size-3" />
                    </button>
                  }
                >
                  {assignable.map((entry) => (
                    <DropdownMenuItem
                      key={entry}
                      onClick={() => changeRole(member, entry)}
                    >
                      Make {ROLE_COPY[entry].label.toLowerCase()}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenu>
              ) : (
                <span
                  className="text-xs text-muted-foreground"
                  title={ROLE_COPY[member.role].hint}
                >
                  {ROLE_COPY[member.role].label}
                </span>
              )}

              {canManage && !isSelf ? (
                <button
                  aria-label={`Remove ${memberLabel(member)}`}
                  className="flex size-7 cursor-pointer items-center justify-center rounded-lg text-muted-foreground/0 outline-none transition-colors hover:bg-destructive/10 hover:text-destructive-foreground focus-visible:ring-2 focus-visible:ring-ring group-hover:text-muted-foreground"
                  onClick={() => remove(member)}
                  type="button"
                >
                  <DeleteIcon className="size-4" />
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>

      {inviteRows.length > 0 ? (
        <div className="border-t border-border">
          <p className="px-5 pb-1.5 pt-3 text-xs font-medium text-muted-foreground">
            Invitations
          </p>
          <ul className="divide-y divide-border">
            {inviteRows.map((pending) => (
              <li
                key={pending.invite_id}
                className="group flex items-center gap-3 px-5 py-2.5"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-2 rounded-full",
                    pending.status === "pending"
                      ? "bg-warning"
                      : "bg-muted-foreground/40"
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">
                    {pending.email}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {pending.status === "expired"
                      ? "Expired. Resend to invite again"
                      : `Expires ${new Date(pending.expires_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {ROLE_COPY[pending.role].label}
                </span>
                {canManage ? (
                  <Button
                    onClick={() => resendInvite(pending)}
                    size="xs"
                    title="Sends a fresh email with a new link. The previous link stops working."
                    type="button"
                    variant="secondary"
                  >
                    Resend
                  </Button>
                ) : null}
                {canManage ? (
                  <button
                    aria-label={`Revoke invite for ${pending.email}`}
                    className="flex size-7 cursor-pointer items-center justify-center rounded-lg text-muted-foreground/0 outline-none transition-colors hover:bg-destructive/10 hover:text-destructive-foreground focus-visible:ring-2 focus-visible:ring-ring group-hover:text-muted-foreground"
                    onClick={() => revokeInvite(pending)}
                    type="button"
                  >
                    <DeleteIcon className="size-4" />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {notice ? (
        <p className="px-5 pb-1 pt-2 text-xs text-muted-foreground">
          {notice}
        </p>
      ) : null}
      </>
      )}
      </SkeletonReveal>

      {canManage ? (
        <div className="flex flex-col gap-2 border-t border-border p-5">
          <Button
            onClick={() => setInviting(true)}
            size="sm"
            variant="secondary"
          >
            <PlusIcon className="size-4" />
            Invite a teammate
          </Button>
          {/* An invitation is an email, and a fresh self-hosted install has
              nowhere to send one — which used to look like an invite that was
              sent and never arrived. Shown only to the operator, and only while
              nothing is stored: they are the one person who can fix it, and
              anyone else reading this would be told about a screen they cannot
              open. It stops short of claiming mail is broken, because the api
              cannot see the worker's relay. */}
          {deploymentSettings?.editable === true &&
          deploymentSettings.email?.stored == null ? (
            <p className="text-xs leading-5 text-muted-foreground">
              An invitation is an email. If this deployment has no mail
              transport, it is queued and never delivered —{" "}
              <a
                className="underline underline-offset-2 hover:text-foreground"
                href="/dashboard/account?tab=deployment"
              >
                set one up and send yourself a test
              </a>
              .
            </p>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="px-5 pb-4 text-xs text-destructive-foreground">{error}</p>
      ) : null}

      <AnimatePresence>
        {inviting ? (
          <InviteFlow
            onClose={() => setInviting(false)}
            onInvite={performInvite}
          />
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {successorFor && SuccessorDialog ? (
          <SuccessorDialog
            candidates={memberRows.filter(
              (entry) => entry.user_id !== successorFor.user_id
            )}
            member={successorFor}
            onClose={() => setSuccessorFor(null)}
            onFailed={(message) => {
              setSuccessorFor(null);
              setError(message);
            }}
            onTransferred={(successorUserId) => {
              setSuccessorFor(null);
              if (!LIVE_API) {
                setLocalMembers(
                  memberRows
                    .filter((entry) => entry.user_id !== successorFor.user_id)
                    .map((entry) =>
                      entry.user_id === successorUserId
                        ? { ...entry, role: "owner" as SiteRole }
                        : entry
                    )
                );
                return;
              }
              members.reload();
            }}
            siteId={site.site_id}
          />
        ) : null}
      </AnimatePresence>
    </SettingsPanel>
  );
}

/**
 * Inviting a teammate, in the shared `FlowDialog` shell. One step — an
 * address and a role are one decision, so there is nothing to page
 * through and no counter pretending otherwise.
 */
function InviteFlow({
  onInvite,
  onClose,
}: {
  onInvite: (email: string, role: SiteRole) => Promise<void>;
  onClose: () => void;
}) {
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<SiteRole>("viewer");
  const [presented, setPresented] = React.useState<string | null>(null);

  const send = useAction(async () => {
    const trimmed = email.trim();
    if (!trimmed) return;
    setPresented(null);
    try {
      await onInvite(trimmed, role);
    } catch (raised) {
      // Two different 409s with two different remedies — branch on the
      // code, never on the status.
      const code = errorCodeOf(raised);
      setPresented(
        code === "IDEMPOTENCY_CONFLICT"
          ? "A live invitation already exists for that address. Revoke or resend it from the list."
          : code === "ALREADY_MEMBER"
            ? "That address is already on the team. There is nothing to send."
            : presentError(raised).body
      );
      return;
    }
    onClose();
  });

  return (
    <FlowDialog
      ariaLabel="Invite a teammate"
      dir={1}
      onClose={onClose}
      panelKey="invite"
      title="Invite a teammate"
      footer={
        <>
          <Button variant="ghost" size="xs" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="xs"
            disabled={email.trim().length === 0}
            loading={send.busy}
            onClick={() => send.run()}
          >
            Send invite
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 p-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Email
          </span>
          <input
            aria-label="Email to invite"
            autoFocus
            className="h-9 w-full rounded-xl border border-input bg-white px-3 text-sm outline-none transition-[box-shadow,border-color] focus-visible:border-ring focus-visible:[outline:2px_solid_var(--ring)] focus-visible:[outline-offset:-2px]"
            onChange={(event) => {
              setEmail(event.target.value);
              setPresented(null);
            }}
            placeholder="teammate@company.com"
            type="email"
            value={email}
          />
        </label>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Role
          </span>
          {/* One card per role, boundaries spelled out — a two-word toggle
              made the inviter guess what they were handing over. */}
          {ROLES.filter((entry) => entry !== "owner").map((entry) => {
            const selected = role === entry;
            const RoleIcon = INVITE_ROLE_ICON[entry];
            return (
              <button
                aria-pressed={selected}
                className={cn(
                  "flex cursor-pointer flex-col gap-1 rounded-xl border p-3 text-left transition-colors",
                  selected
                    ? "border-ring bg-secondary/40"
                    : "border-border hover:bg-secondary/30"
                )}
                key={entry}
                onClick={() => setRole(entry)}
                type="button"
              >
                <span className="flex items-center gap-1.5 text-xs font-medium">
                  {RoleIcon ? (
                    <RoleIcon className="size-3.5 text-muted-foreground" />
                  ) : null}
                  {ROLE_COPY[entry].label}
                </span>
                <span className="text-xs leading-5 text-muted-foreground">
                  {INVITE_ROLE_DETAIL[entry]}
                </span>
              </button>
            );
          })}
        </div>
        {presented ? (
          <p className="text-xs leading-5 text-destructive-foreground">
            {presented}
          </p>
        ) : null}
      </div>
    </FlowDialog>
  );
}
