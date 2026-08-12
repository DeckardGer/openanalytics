"use client";

import { AnimatePresence } from "motion/react";
import * as React from "react";
import { CopyButton } from "@/components/ui/copy-button";
import { ViewIcon } from "hugeicons-react";
import {
  DeleteIcon,
  LockIcon,
  PlusIcon,
  PulseIcon,
} from "@/components/icons/hugeicons";
import { FlowDialog } from "@/components/dashboard/flow-dialog";
import { SettingsPanel } from "@/components/dashboard/settings-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  SkeletonBar,
  SkeletonReveal,
} from "@/components/ui/skeleton-reveal";
import {
  keys as apiKeys,
  LIVE_API,
  type ApiKeySummary,
  type ApiKeyType,
} from "@/lib/api";
import { MOCK_KEYS } from "@/lib/mock";
import { useAction, useApi } from "@/lib/use-api";
import { cn } from "@/lib/utils";

/**
 * API keys — `GET/POST /v1/sites/{site_id}/keys`, `DELETE .../keys/{key_id}`.
 *
 * The contract's hard rule: `raw_token` is in the create response exactly once
 * and is never retrievable again, so creation renders a copy-once panel. A
 * `tracking_write` key is public and keeps showing its `public_token`; a
 * `private_read` key only ever shows its `key_prefix` afterwards.
 */

const TYPE_COPY: Record<ApiKeyType, { label: string; hint: string }> = {
  tracking_write: {
    label: "Tracking",
    hint: "Write-only, safe to ship in the browser. Never accepted by a read endpoint.",
  },
  private_read: {
    label: "Read",
    hint: "Secret bearer key for the read API.",
  },
};

/**
 * What one read key can actually do — per key, off its own scopes, because
 * two read keys are not the same credential (§20): one reads the business's
 * numbers and one reads a name and a domain list.
 */
function readKeyHint(scopes: readonly string[] | null): string {
  return scopes?.includes("analytics:read")
    ? "Secret. Reads site metadata and the historical analytics: overview, timeseries, pages, sources, devices, geography, sessions."
    : "Secret. Reads site metadata only — this key was minted without the analytics scope.";
}

/**
 * The create dialog's long answers. The list rows keep one line; someone
 * deciding which key to mint deserves the whole story.
 */
const TYPE_DETAIL: Record<ApiKeyType, string> = {
  tracking_write:
    "Goes into the snippet on your site and writes traffic in: pageviews, sessions, custom events. Write-only by construction: no endpoint ever answers it with data, which is why it is public and safe to ship in the browser. You can copy it again any time from the list.",
  private_read:
    "A secret bearer key for reading the API from your own code: site metadata, and (with the analytics scope) the historical numbers. Realtime and revenue never open to keys. Shown in full exactly once, at creation.",
};

/** The card's glyph: tracking writes a pulse in, a read key is eyes only. */
const TYPE_ICON: Record<ApiKeyType, React.ComponentType<{ className?: string }>> = {
  tracking_write: PulseIcon,
  private_read: ViewIcon,
};

const dateFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

export function ApiKeysSection({ siteId }: { siteId: string }) {
  const list = useApi(
    () => apiKeys.list(siteId).then((page) => page.items),
    () => MOCK_KEYS,
    siteId
  );
  /** Mock-mode rows live here so create/revoke stay visible without an api. */
  const [localKeys, setLocalKeys] = React.useState<ApiKeySummary[] | null>(
    null
  );
  const keys = localKeys ?? list.data ?? [];

  const [creating, setCreating] = React.useState(false);

  /**
   * The one mint, both modes. Returns the create response's secret so the
   * flow can show it — exactly once, per the contract — as its second step.
   */
  const mint = async (
    rawName: string,
    type: ApiKeyType,
    withAnalytics: boolean
  ): Promise<{ type: ApiKeyType; raw_token: string }> => {
    const trimmed = rawName.trim();
    if (LIVE_API) {
      const created = await apiKeys.create(siteId, {
        type,
        ...(trimmed ? { name: trimmed } : {}),
        // Off sends NOTHING: omitted mints the minimum (["site:read"]), and
        // an empty array is a 400, not a default (§20).
        ...(type === "private_read" && withAnalytics
          ? { scopes: ["site:read", "analytics:read"] as const }
          : {}),
      });
      list.reload();
      return { type: created.type, raw_token: created.raw_token };
    }
    const isPublic = type === "tracking_write";
    const raw = isPublic
      ? `oa_pk_${crypto.randomUUID().replaceAll("-", "").slice(0, 32)}`
      : `oa_sk_${crypto.randomUUID().replaceAll("-", "").slice(0, 40)}`;
    const row: ApiKeySummary = {
      id: crypto.randomUUID(),
      type,
      name: trimmed || null,
      key_prefix: raw.slice(0, isPublic ? 10 : 12),
      public_token: isPublic ? raw : null,
      // Offline preview mirrors the API: null for a tracking key, the
      // choice (or the minimum) for a private one (ADR-0042, D3).
      scopes: isPublic
        ? null
        : withAnalytics
          ? ["site:read", "analytics:read"]
          : ["site:read"],
      // A create that says nothing minted a key its creator kept (ADR-0043
      // D8's default), and a fresh key has no unresolved departure behind it.
      held_by: "user",
      rotation_required_at: null,
      created_at: new Date().toISOString(),
      last_used_at: null,
      revoked_at: null,
      expires_at: null,
    };
    setLocalKeys([...keys, row]);
    return { type, raw_token: raw };
  };

  const revokeAction = useAction(async (key: ApiKeySummary) => {
    if (LIVE_API) {
      await apiKeys.revoke(siteId, key.id);
      list.reload();
      return;
    }
    setLocalKeys(keys.filter((entry) => entry.id !== key.id));
  });

  const listReady = list.phase !== "loading";

  return (
    <SettingsPanel
      action={
        <span className="flex items-center gap-3">
          {listReady ? (
            <span className="text-xs text-muted-foreground">
              {keys.length} {keys.length === 1 ? "key" : "keys"}
            </span>
          ) : (
            <SkeletonBar className="h-3.5 w-12 animate-pulse" />
          )}
          <Button
            onClick={() => setCreating(true)}
            size="xs"
            variant="secondary"
          >
            <PlusIcon className="size-4" />
            Create key
          </Button>
        </span>
      }
      title="API keys"
    >
      {/* the rows swap with the house blur reveal; the create form below
          is static chrome and stays put through it */}
      <SkeletonReveal
        ready={listReady}
        skeleton={
          // Pixel-matched to a key row: type tile, name + token lines, the
          // date column.
          <ul className="divide-y divide-border">
            {[0, 1].map((index) => (
              <li className="flex items-center gap-3 px-5 py-3" key={index}>
                <SkeletonBar className="size-8 shrink-0 rounded-lg" />
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <SkeletonBar className="h-3.5 w-28" />
                  <SkeletonBar className="h-3 w-44 max-w-full" />
                </div>
                <SkeletonBar className="hidden h-3 w-16 sm:block" />
              </li>
            ))}
          </ul>
        }
      >
      <ul className="divide-y divide-border">
        {keys.map((key) => (
          <li key={key.id} className="group flex items-center gap-3 px-5 py-3">
            <span
              aria-hidden="true"
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-lg",
                key.type === "private_read"
                  ? "bg-secondary text-muted-foreground"
                  : "bg-primary/10 text-primary"
              )}
            >
              <LockIcon className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">
                  {key.name ?? "Untitled key"}
                </span>
                <Badge
                  icon={
                    key.type === "private_read" ? <ViewIcon /> : <PulseIcon />
                  }
                  size="sm"
                  variant={key.type === "private_read" ? "secondary" : "info"}
                >
                  {TYPE_COPY[key.type].label}
                </Badge>
                {/* The scopes, in the open (§20): the difference between a
                    credential that can read the business's numbers and one
                    that cannot is not a details-panel fact. A tracking key
                    carries none and shows none. */}
                {key.scopes?.map((scope) => (
                  <Badge
                    icon={<LockIcon />}
                    key={scope}
                    size="sm"
                    variant="outline"
                  >
                    <span className="font-mono">{scope}</span>
                  </Badge>
                ))}
              </span>
              <span
                className="block truncate font-mono text-xs text-muted-foreground"
                title={
                  key.type === "private_read"
                    ? readKeyHint(key.scopes)
                    : TYPE_COPY[key.type].hint
                }
              >
                {key.public_token ?? `${key.key_prefix}••••••••`}
              </span>
            </span>
            {/* `last_used_at` is real since M14 (minute granularity), so
                "revoke the ones nobody is using" is answerable from here. */}
            <span className="hidden flex-col items-end text-xs tabular-nums text-muted-foreground sm:flex">
              <span>{dateFmt.format(Date.parse(key.created_at))}</span>
              <span className="text-muted-foreground/70">
                {key.last_used_at
                  ? `used ${dateFmt.format(Date.parse(key.last_used_at))}`
                  : "never used"}
              </span>
            </span>
            {key.public_token ? (
              <CopyButton label="Copy key" text={key.public_token} />
            ) : null}
            <button
              aria-label={`Revoke ${key.name ?? "key"}`}
              className="flex size-7 cursor-pointer items-center justify-center rounded-lg text-muted-foreground/0 outline-none transition-colors hover:bg-destructive/10 hover:text-destructive-foreground focus-visible:ring-2 focus-visible:ring-ring group-hover:text-muted-foreground"
              onClick={() => revokeAction.run(key)}
              type="button"
            >
              <DeleteIcon className="size-4" />
            </button>
          </li>
        ))}
      </ul>
      </SkeletonReveal>

      {/* Existing keys did not widen when scopes arrived (§20): a key minted
          before reads as site:read only, forever. Said here so a customer
          mints a new key instead of filing the 403 as a bug. */}
      {listReady &&
      keys.some(
        (key) =>
          key.type === "private_read" &&
          key.scopes !== null &&
          !key.scopes.includes("analytics:read")
      ) ? (
        <p className="border-t border-border px-5 py-3 text-xs leading-5 text-muted-foreground">
          A key without the <span className="font-mono">analytics:read</span>{" "}
          badge reads site metadata only, and analytics access is never added
          to an existing key. To read your numbers from the API, create a new
          key with the analytics scope and move your integration to it.
        </p>
      ) : null}

      {revokeAction.error ? (
        <p className="px-5 pb-4 text-xs text-destructive-foreground">
          {revokeAction.error.body}
        </p>
      ) : null}

      <AnimatePresence>
        {creating ? (
          <CreateKeyFlow onClose={() => setCreating(false)} onCreate={mint} />
        ) : null}
      </AnimatePresence>
    </SettingsPanel>
  );
}

/**
 * Creating a key, in the shared `FlowDialog` shell. Step one is the ask —
 * a name and the key's type; step two is the secret, on screen exactly
 * once. The step says so plainly and its only exit is acknowledging it —
 * there is no "show again" affordance because the server cannot serve one.
 */
function CreateKeyFlow({
  onCreate,
  onClose,
}: {
  onCreate: (
    name: string,
    type: ApiKeyType,
    withAnalytics: boolean
  ) => Promise<{ type: ApiKeyType; raw_token: string }>;
  onClose: () => void;
}) {
  const [step, setStep] = React.useState<1 | 2>(1);
  const [name, setName] = React.useState("");
  const [type, setType] = React.useState<ApiKeyType>("tracking_write");
  /**
   * Whether the read key also gets `analytics:read`. On by default: someone
   * minting a read key almost always wants the numbers, and the minimum-only
   * key is the deliberate narrower choice, not the accident.
   */
  const [withAnalytics, setWithAnalytics] = React.useState(true);
  /** The create response's secret — held only while the dialog lives. */
  const [minted, setMinted] = React.useState<{
    type: ApiKeyType;
    raw_token: string;
  } | null>(null);

  const create = useAction(async () => {
    const secret = await onCreate(name, type, withAnalytics);
    setMinted(secret);
    setStep(2);
  });

  const isSecret = minted?.type === "private_read";
  const stepTitles = {
    1: "Create an API key",
    2: isSecret ? "Copy this key now" : "Your tracking key",
  } as const;

  return (
    <FlowDialog
      ariaLabel={stepTitles[1]}
      counter={`${step} / 2`}
      // The flow only ever moves forward: the secret cannot be re-minted,
      // so there is no Back from step two.
      dir={1}
      onClose={onClose}
      panelKey={step}
      title={stepTitles[step]}
      footer={
        step === 1 ? (
          <>
            <Button variant="ghost" size="xs" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="xs"
              loading={create.busy}
              onClick={() => create.run()}
            >
              Create
            </Button>
          </>
        ) : (
          <Button size="xs" onClick={onClose}>
            {isSecret ? "I saved it" : "Done"}
          </Button>
        )
      }
    >
      {step === 1 ? (
        <div className="flex flex-col gap-3 p-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Name
            </span>
            <input
              aria-label="Key name"
              autoFocus
              className="h-9 w-full rounded-xl border border-input bg-white px-3 text-sm outline-none transition-[box-shadow,border-color] focus-visible:border-ring focus-visible:[outline:2px_solid_var(--ring)] focus-visible:[outline-offset:-2px]"
              onChange={(event) => setName(event.target.value)}
              placeholder="What is this key for?"
              value={name}
            />
          </label>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Type
            </span>
            {/* One card per type, each carrying its whole story — the person
                deciding here has not met these keys before, and a two-word
                toggle made them guess. */}
            {/* The "Soon" lock is gone: M14 built key-authenticated
                analytics reads and M16 (ADR-0043) settled the model, so the
                Read option finally makes the promise it was always making
                (§20, reversed 2026-08-05). */}
            {(["tracking_write", "private_read"] as ApiKeyType[]).map(
              (entry) => {
                const selected = type === entry;
                const TypeIcon = TYPE_ICON[entry];
                return (
                  <button
                    aria-pressed={selected}
                    className={cn(
                      "flex flex-col gap-1 rounded-xl border p-3 text-left transition-colors",
                      selected
                        ? "cursor-pointer border-ring bg-secondary/40"
                        : "cursor-pointer border-border hover:bg-secondary/30"
                    )}
                    key={entry}
                    onClick={() => setType(entry)}
                    type="button"
                  >
                    <span className="flex items-center gap-1.5 text-xs font-medium">
                      <TypeIcon className="size-3.5 text-muted-foreground" />
                      {TYPE_COPY[entry].label}
                    </span>
                    <span className="text-xs leading-5 text-muted-foreground">
                      {TYPE_DETAIL[entry]}
                    </span>
                  </button>
                );
              }
            )}
          </div>

          {/* The scope choice, read keys only. A checkbox that is off sends
              nothing — omitted mints ["site:read"], and an empty array is a
              400 (§20). */}
          {type === "private_read" ? (
            <label className="flex cursor-pointer items-start justify-between gap-4 rounded-xl bg-[#f6f6f6] px-3 py-2.5">
              <span className="min-w-0">
                <span className="block text-sm">Read analytics</span>
                <span className="block text-xs leading-5 text-muted-foreground">
                  Overview, timeseries, pages, sources, devices, geography
                  and sessions. Off, the key reads site metadata only.
                  Realtime and revenue are never open to keys.
                </span>
              </span>
              <Switch
                aria-label="Include the analytics scope"
                checked={withAnalytics}
                onCheckedChange={setWithAnalytics}
              />
            </label>
          ) : null}
          {create.error ? (
            <p className="text-xs leading-5 text-destructive-foreground">
              {create.error.body}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-3 p-4">
          <p className="text-xs leading-5 text-muted-foreground">
            {isSecret
              ? "This is the only time the full key is shown. Store it somewhere safe; it cannot be retrieved again."
              : "This key is public and safe to ship in the browser. You can copy it again later from the list."}
          </p>
          <div className="flex items-center gap-2 rounded-xl border border-border bg-secondary/50 p-3">
            <code className="min-w-0 flex-1 break-all font-mono text-xs">
              {minted?.raw_token}
            </code>
            {minted ? (
              <CopyButton label="Copy key" text={minted.raw_token} />
            ) : null}
          </div>
        </div>
      )}
    </FlowDialog>
  );
}
