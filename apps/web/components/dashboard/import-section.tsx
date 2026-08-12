"use client";

import { AnimatePresence } from "motion/react";
import * as React from "react";
import { CircleDashedIcon } from "@/components/icons/hugeicons";
import { Badge } from "@/components/ui/badge";
import { ApiErrorPanel } from "@/components/dashboard/api-error";
import { FlowDialog } from "@/components/dashboard/flow-dialog";
import {
  ProviderMark,
  ProviderRowsSkeleton,
} from "@/components/dashboard/provider-card";
import {
  SectionHeading,
  SettingsPanel,
} from "@/components/dashboard/settings-panel";
import { Button } from "@/components/ui/button";
import { SkeletonBar, SkeletonReveal } from "@/components/ui/skeleton-reveal";
import {
  dataExports,
  errorCodeOf,
  imports,
  LIVE_API,
  presentError,
  uploadImportArchive,
  UploadFailed,
  validationIssueFor,
  type ErrorPresentation,
  type ExportDownloadFile,
  type ExportRun,
  type ImportProvider,
  type ImportRun,
  type ImportRunPhase,
  type ImportUploadTarget,
  type SiteSummary,
} from "@/lib/api";
import {
  MOCK_EXPORTS,
  MOCK_IMPORT_PROVIDERS,
  MOCK_IMPORT_RUNS,
} from "@/lib/mock";
import { cn } from "@/lib/utils";

/**
 * Import / export, wired to the real endpoints (M11, ADR-0032;
 * frontend_tasks §21).
 *
 * Two doors on one screen. A site's history comes **in** from another
 * analytics provider, and the site's own raw events go **out**. Both are long
 * background jobs, so nothing here is a request the browser waits on: the
 * screen creates work, then polls.
 *
 * Three rules from the contract shape everything below.
 *
 * - **The catalog is the feature probe.** `GET /v1/imports/providers` is
 *   mounted unconditionally; the site-scoped routes exist only where object
 *   storage is configured and answer `404` where it is not. So a `404` here
 *   means "this deployment cannot import", never a wrong site id — and the
 *   provider list still renders, because "supported later" and "not offered by
 *   this deployment" are different sentences.
 * - **The list is the catalog's, not ours.** Local artwork and one line of
 *   copy are keyed by provider `id`; an id we have no artwork for renders with
 *   its `display_name` alone rather than disappearing. `available: false` rows
 *   stay on the list in the coming-soon treatment: filtering them out could
 *   only ever say "we do not do this", which is the wrong answer.
 * - **`phase` drives the words, `status` drives terminal behaviour.** They are
 *   two fields on purpose and neither is derived from the other here — the
 *   table below is transcribed from the contract, including the two entries
 *   that catch people: `ready_for_review` is `running` (the customer still has
 *   to decide) and `superseded` is `succeeded` (it did what it was asked to).
 */

/* Provider presentation ---------------------------------------------------- */

type Artwork = { logo: string; inset?: boolean; brings: string };

/**
 * Artwork and one line of copy, keyed by the catalog's `id`. Nothing here
 * decides *whether* a provider is listed — that is the catalog's job — so an
 * id with no entry is a missing picture, not a missing row.
 */
const ARTWORK: Record<string, Artwork> = {
  plausible: {
    logo: "/images/plausible.avif",
    inset: true,
    brings: "Pageviews, sources, pages and countries by day.",
  },
  fathom: {
    logo: "/images/fathom.avif",
    brings: "Pageviews, unique visitors, referrers and top pages by day.",
  },
  simple_analytics: {
    logo: "/images/simple.avif",
    brings: "Pageviews, referrers, countries and UTM parameters.",
  },
  "simple-analytics": {
    logo: "/images/simple.avif",
    brings: "Pageviews, referrers, countries and UTM parameters.",
  },
  seline: {
    logo: "/images/seline.svg",
    inset: true,
    brings: "Pageviews, custom events and their properties.",
  },
  datafast: {
    logo: "/images/datafast.avif",
    brings: "Pageviews, goals and revenue attribution by day.",
  },
  rybbit: {
    logo: "/images/rybbit.avif",
    brings: "Pageviews, sessions, custom events and their properties.",
  },
};

/**
 * How many rows the catalog's skeleton draws.
 *
 * The catalog is a server list, so its length is the one thing this screen
 * cannot know before it answers. Counting the artwork above is the closest
 * honest guess and it maintains itself: a logo is added when a provider is,
 * so the number moves with the catalog instead of ageing into a constant
 * nobody revisits. Deduplicated by file because a few ids are spelling
 * variants of one provider.
 */
const CATALOG_ROWS = new Set(Object.values(ARTWORK).map((art) => art.logo)).size;

/** What the provider's own export carries — the provider's fact, not ours. */
const CAPABILITY_COPY: Record<ImportProvider["capability"], string> = {
  aggregate_only: "Daily totals, with no visitor-level rows.",
  event_level: "Event-level rows.",
};

/* Phase presentation ------------------------------------------------------- */

/** Transcribed from the contract's derivation table; see the header comment. */
const PHASE_COPY: Record<ImportRunPhase, { label: string; note: string }> = {
  uploading: {
    label: "Waiting for the file",
    note: "The archive has not arrived yet.",
  },
  uploaded: {
    label: "Queued for validation",
    note: "The archive is in. Waiting for a worker.",
  },
  validating: {
    label: "Checking the archive",
    note: "Reading the files and their shape.",
  },
  processing: {
    label: "Staging rows",
    note: "Nothing is on the dashboard yet.",
  },
  ready_for_review: {
    label: "Waiting for you",
    note: "Preparation finished. Nothing reaches the dashboard until you publish.",
  },
  publishing: {
    label: "Publishing",
    note: "Swapping this site over to the imported history.",
  },
  published: {
    label: "Live on the dashboard",
    note: "Imported history is being served.",
  },
  superseded: {
    label: "Replaced by a later import",
    note: "Kept so the newer import can be rolled back to it.",
  },
  failed: { label: "Failed", note: "Nothing was published." },
  discarded: { label: "Discarded", note: "The archive was thrown away." },
  rolled_back: { label: "Rolled back", note: "This import is no longer served." },
};

/** Phases that hold the site's one import slot. */
const ACTIVE_PHASES = new Set<ImportRunPhase>([
  "uploading",
  "uploaded",
  "validating",
  "processing",
  "ready_for_review",
  "publishing",
]);

/**
 * The bounded categories a failed run reports. The list is open by contract,
 * so an unmapped code falls back to its own key rather than to silence.
 */
const FAILURE_COPY: Record<string, string> = {
  zip_bomb: "The archive expands far beyond its size, so we stopped reading it.",
  too_many_entries: "The archive holds more files than an export should.",
  entry_too_large: "One file inside the archive is too large to read.",
  row_too_long: "A row in the archive is longer than any row we can read.",
  unexpected_entry: "The archive holds a file this import does not recognise.",
  nested_archive: "The archive contains another archive.",
  malformed_archive: "The file is not a readable ZIP archive.",
  malformed_csv: "A CSV inside the archive could not be parsed.",
  empty_archive: "The archive held nothing to import.",
  adapter_unavailable:
    "This provider's adapter is not available on this deployment.",
  upload_changed: "The uploaded file is not the one this import was created for.",
  upload_unverifiable:
    "The upload could not be verified against what was declared.",
  upload_expired: "The upload window closed before the file arrived.",
  prepare_abandoned: "Preparation was abandoned before it finished.",
};

/** The losses a provider export carries, in the customer's words. */
const WARNING_COPY: Record<string, string> = {
  city_dropped:
    "Cities were dropped; the provider ships an id nothing here can resolve.",
  report_not_staged: "The archive carried a report this build does not read.",
  rows_at_or_after_cutover:
    "Rows on or after the cutover, which will never be displayed.",
  dimension_truncated: "Over-long values were truncated.",
  unknown_columns: "Columns no report reads were ignored.",
  rows_outside_declared_range:
    "Rows dated outside their file's declared range, kept because the measurements are real.",
};

/** Report keys, in the order the review screen lists them. */
const REPORT_ORDER = [
  "metrics",
  "pages",
  "sources",
  "geography",
  "devices",
  "browsers",
  "os",
  "custom_events",
] as const;

const REPORT_LABEL: Record<string, string> = {
  metrics: "Daily totals",
  pages: "Pages",
  sources: "Sources",
  geography: "Countries",
  devices: "Devices",
  browsers: "Browsers",
  os: "Operating systems",
  custom_events: "Custom events",
};

/* Formatting --------------------------------------------------------------- */

const dateFmt = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

const instantFmt = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

function formatDate(value: string | null): string {
  if (!value) return "—";
  const parsed = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  return Number.isNaN(parsed) ? value : dateFmt.format(parsed);
}

function formatInstant(value: string | null): string {
  if (!value) return "—";
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : instantFmt.format(parsed);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

const count = (rows: number) => rows.toLocaleString("en-US");

/** The calendar day after an instant, as `YYYY-MM-DD` — the cutover ceiling. */
function dayAfter(instant: string): string | undefined {
  const parsed = Date.parse(instant);
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed + 86_400_000).toISOString().slice(0, 10);
}

/** One key per attempt, reused by every retry of that attempt. */
const newIdempotencyKey = () => crypto.randomUUID();

/* Loading a site-scoped list ----------------------------------------------- */

type ListState<T> =
  | { status: "loading" }
  | { status: "ready"; items: T[] }
  /** The deployment has no object storage, so these routes are not mounted. */
  | { status: "unsupported" }
  | { status: "error"; error: ErrorPresentation; retry: () => void };

/**
 * A site-scoped list that may legitimately not exist. `404` is the deployment
 * answering "not configured here" — a state to render, not an error panel.
 */
function useSiteList<T>(
  load: () => Promise<{ items: T[] }>,
  mock: T[],
  key: string
): { state: ListState<T>; set: (items: T[]) => void; reload: () => void } {
  const [attempt, setAttempt] = React.useState(0);
  const [state, setState] = React.useState<ListState<T>>({ status: "loading" });
  const retry = React.useCallback(() => setAttempt((value) => value + 1), []);
  const token = `${key}#${attempt}`;

  // `token` is the full identity of a request, so the effect depends on it
  // rather than on the loader closure — which would refetch every render.
  const loadRef = React.useRef(load);
  React.useEffect(() => {
    loadRef.current = load;
  });

  React.useEffect(() => {
    let cancelled = false;
    // Even the mock path resolves through a promise, so nothing writes state
    // synchronously in an effect body.
    (LIVE_API ? loadRef.current() : Promise.resolve({ items: mock })).then(
      ({ items }) => {
        if (!cancelled) setState({ status: "ready", items });
      },
      (error: unknown) => {
        if (cancelled) return;
        if (errorCodeOf(error) === "NOT_FOUND") {
          setState({ status: "unsupported" });
          return;
        }
        setState({ status: "error", error: presentError(error), retry });
      }
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const set = React.useCallback((items: T[]) => {
    setState({ status: "ready", items });
  }, []);

  // A stable trio, not a spread union: `state` keeps its identity between
  // renders, which is what lets the callers memoise off it. A fresh object per
  // render would hand the polling effect a new callback every time and the
  // interval would reset before it ever fired.
  return { state, set, reload: retry };
}

/** Replaces a row by id, or prepends it when it is new. */
function upsert<T extends { id: string }>(items: T[], next: T): T[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index === -1) return [next, ...items];
  const copy = items.slice();
  copy[index] = next;
  return copy;
}

/**
 * The archive, held for the length of the transfer.
 *
 * A `File` cannot survive a reload and nothing renders from it, so it lives
 * outside React — and the recovery for a run whose file is gone is to ask for
 * it again rather than to pretend we still have it.
 */
const FILES = new Map<string, File>();

/* The screen --------------------------------------------------------------- */

export function ImportSection({ site }: { site: SiteSummary }) {
  return (
    <>
      <SectionHeading
        description={`Bring ${site.name}'s history over from another analytics tool, or take everything it holds with you.`}
        title="Import & export"
      />
      <ImportPanel site={site} />
      <ExportPanel site={site} />
    </>
  );
}

/* Import ------------------------------------------------------------------- */

function ImportPanel({ site }: { site: SiteSummary }) {
  const siteId = site.site_id;
  /** `site:settings` — owner and admin. Every member may read the screen. */
  const canWrite = site.role === "owner" || site.role === "admin";

  const { state: catalog } = useSiteList<ImportProvider>(
    React.useCallback(() => imports.providers(), []),
    MOCK_IMPORT_PROVIDERS,
    "providers"
  );
  const { state: runs, set, reload } = useSiteList<ImportRun>(
    React.useCallback(() => imports.list(siteId), [siteId]),
    MOCK_IMPORT_RUNS,
    siteId
  );

  // Memoised off the settled state: `patch` and `drop` close over this list,
  // and a fresh array every render would reset the polling interval before it
  // ever fired.
  const rows = React.useMemo(
    () => (runs.status === "ready" ? runs.items : []),
    [runs]
  );
  const active = rows.find((run) => ACTIVE_PHASES.has(run.phase)) ?? null;
  const published = rows.find((run) => run.phase === "published") ?? null;
  const history = rows.filter((run) => run !== active && run !== published);

  const patch = React.useCallback(
    (run: ImportRun) => set(upsert(rows, run)),
    [set, rows]
  );
  const drop = React.useCallback(
    (runId: string) => set(rows.filter((run) => run.id !== runId)),
    [set, rows]
  );

  // Poll only a run the api is still working on. `ready_for_review` is
  // excluded on purpose: it waits for a human and can sit there for days, so
  // polling it would be a request every few seconds for the length of a
  // review. `uploading` is excluded because the browser, not the api, is the
  // one making progress.
  const pollId =
    active && active.phase !== "ready_for_review" && active.phase !== "uploading"
      ? active.id
      : null;
  React.useEffect(() => {
    if (!LIVE_API || !pollId) return;
    const timer = setInterval(() => {
      imports.get(siteId, pollId).then(patch, () => {
        // A failed poll is not a failed import; the next tick tries again.
      });
    }, 2500);
    return () => clearInterval(timer);
  }, [siteId, pollId, patch]);

  const providers = catalog.status === "ready" ? catalog.items : [];
  // The catalog is mounted everywhere; the site routes are not. A `404` on the
  // list is this deployment saying it has no object storage.
  const unsupported = runs.status === "unsupported";

  // Two reads, one gate: the catalog and this site's runs land at their own
  // pace, and content that swapped twice would blur twice. An error counts as
  // settled — it renders as the panel's content.
  const ready = catalog.status !== "loading" && runs.status !== "loading";

  /**
   * The content as it stands almost every time: no run in flight, so the
   * catalog with its footer note. Nothing here can know whether a run is
   * active — that is the second read — so the skeleton draws the answer that
   * is true for a site that is not mid-import, which is all of them, most of
   * the time. The chrome above it never waits at all.
   */
  const skeleton = (
    <>
      <ProviderRowsSkeleton
        action={<SkeletonBar className="h-7 w-16 shrink-0 rounded-full" />}
        rows={CATALOG_ROWS}
      />
      {/* The footer note, at its two `leading-5` lines. */}
      <div className="border-t border-border px-5 py-3">
        <span className="flex h-5 items-center">
          <SkeletonBar className="h-3 w-full" />
        </span>
        <span className="flex h-5 items-center">
          <SkeletonBar className="h-3 w-2/3" />
        </span>
      </div>
    </>
  );

  return (
    <SettingsPanel
      action={
        active ? (
          <Badge size="sm" variant="progress">
            {PHASE_COPY[active.phase].label}
          </Badge>
        ) : null
      }
      title="From another analytics tool"
    >
      <SkeletonReveal ready={ready} skeleton={skeleton}>
        {!ready ? null : catalog.status === "error" ? (
          <ApiErrorPanel error={catalog.error} onRetry={catalog.retry} />
        ) : runs.status === "error" ? (
          <ApiErrorPanel error={runs.error} onRetry={runs.retry} />
        ) : (
          <>
            {active ? (
              <ActiveRun
                canWrite={canWrite}
                firstEventAt={site.first_event_at}
                onDiscarded={drop}
                onUpdate={patch}
                run={active}
                siteId={siteId}
              />
            ) : (
              <ProviderList
                canWrite={canWrite && !unsupported}
                onBlocked={reload}
                onStarted={patch}
                providers={providers}
                siteId={siteId}
                unsupported={unsupported}
              />
            )}

            {published ? (
              <PublishedRun
                canWrite={canWrite}
                onUpdate={patch}
                run={published}
                siteId={siteId}
              />
            ) : null}

            {history.length > 0 ? <RunHistory runs={history} /> : null}
          </>
        )}
      </SkeletonReveal>
    </SettingsPanel>
  );
}

/**
 * The catalog, plus the one control that starts a transfer.
 *
 * Only ever mounted with the catalog in hand — the panel above holds the whole
 * screen back until both of its reads have settled — so there is no loading
 * branch here to design.
 */
function ProviderList({
  providers,
  siteId,
  canWrite,
  unsupported,
  onStarted,
  onBlocked,
}: {
  providers: ImportProvider[];
  siteId: string;
  canWrite: boolean;
  unsupported: boolean;
  onStarted: (run: ImportRun) => void;
  /** Re-read the list so the run standing in the way becomes visible. */
  onBlocked: () => void;
}) {
  const [starting, setStarting] = React.useState<ImportProvider | null>(null);

  return (
    <>
      {unsupported ? (
        <p className="border-b border-border px-5 py-3 text-xs leading-5 text-muted-foreground">
          This deployment has no object storage configured, so importing is off
          here. The providers below are the ones this build supports.
        </p>
      ) : null}

      <ul className="divide-y divide-border">
        {providers.map((provider) => {
          const art = ARTWORK[provider.id];
          const available = provider.available && !unsupported;
          return (
            <li className="flex items-center gap-3 px-5 py-3" key={provider.id}>
              {art ? (
                <ProviderMark alt="" inset={art.inset} src={art.logo} />
              ) : (
                // No artwork for this id — the row is still the catalog's
                // to show, so it renders with its initial.
                <ProviderMark bg="#f1f1f1">
                  <span className="text-sm font-medium text-muted-foreground">
                    {provider.display_name.charAt(0)}
                  </span>
                </ProviderMark>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {provider.display_name}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {art?.brings ?? CAPABILITY_COPY[provider.capability]}
                </span>
              </span>
              {available ? (
                canWrite ? (
                  <Button
                    onClick={() => setStarting(provider)}
                    size="xs"
                    variant="secondary"
                  >
                    Import
                  </Button>
                ) : null
              ) : (
                <Badge icon={<CircleDashedIcon />} size="sm" variant="secondary">
                  Coming soon
                </Badge>
              )}
            </li>
          );
        })}
      </ul>

      {providers.length > 0 && !unsupported ? (
        <p className="border-t border-border px-5 py-3 text-xs leading-5 text-muted-foreground">
          Upload the provider&apos;s own export, as one ZIP archive. Nothing
          reaches the dashboard until you have reviewed what it contains.
        </p>
      ) : null}

      <AnimatePresence>
        {starting ? (
          <ImportStartFlow
            onBlocked={onBlocked}
            onClose={() => setStarting(null)}
            onStarted={(run) => {
              setStarting(null);
              onStarted(run);
            }}
            provider={starting}
            siteId={siteId}
          />
        ) : null}
      </AnimatePresence>
    </>
  );
}

/**
 * Starting an import, in the shared `FlowDialog` shell. Step one is what to
 * go get — the provider's own export, as one ZIP; step two is handing it
 * over. There is no separate submit: `File.size` is bound into the upload
 * signature, so the run can only start once a real file is in hand, and
 * picking the file is the act that starts it.
 */
function ImportStartFlow({
  provider,
  siteId,
  onStarted,
  onBlocked,
  onClose,
}: {
  provider: ImportProvider;
  siteId: string;
  onStarted: (run: ImportRun) => void;
  /** Re-read the list so the run standing in the way becomes visible. */
  onBlocked: () => void;
  onClose: () => void;
}) {
  const [step, setStep] = React.useState<1 | 2>(1);
  const [dir, setDir] = React.useState(1);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  /** Chosen, shown, and not yet sent — Import is the act, not the pick. */
  const [file, setFile] = React.useState<File | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const goTo = (next: 1 | 2) => {
    setDir(next > step ? 1 : -1);
    setStep(next);
  };

  const start = async () => {
    if (file === null) return;
    setBusy(true);
    setError(null);
    try {
      // `size_bytes` is `File.size` exactly: it is bound into the upload
      // signature, so a rounded value produces an upload storage refuses.
      const created = await imports.create(
        siteId,
        { provider: provider.id, size_bytes: file.size },
        newIdempotencyKey()
      );
      FILES.set(created.run.id, file);
      // The create response's `run.upload` is always null — the signed target
      // is the response's own top-level `upload`, so that a list read can
      // never hand out credentials. Merging them here gives the upload step
      // the same shape `GET .../imports/{run_id}` answers while a run is
      // still `uploading`.
      onStarted({ ...created.run, upload: created.upload });
    } catch (raised: unknown) {
      const code = errorCodeOf(raised);
      if (code === "NOT_FOUND") {
        setError(
          "This deployment cannot import; it has no object storage configured."
        );
      } else if (code === "IMPORT_IN_PROGRESS") {
        // A race: the catalog this modal opened over predates a run somebody
        // else started. Re-reading brings that run onto the screen behind
        // this dialog, where the remedy lives — publish or discard it.
        setError(
          "Another import is already running for this site. Publish or discard it first."
        );
        onBlocked();
      } else if (code === "VALIDATION_FAILED") {
        // The limit comes off the refusal, never from a constant here.
        const issue = validationIssueFor(raised, "size_bytes");
        setError(
          issue?.code === "too_large" && issue.limit
            ? `That archive is ${formatBytes(file.size)}. The limit is ${formatBytes(issue.limit)}.`
            : presentError(raised).body
        );
      } else {
        setError(presentError(raised).body);
      }
    } finally {
      setBusy(false);
    }
  };

  const art = ARTWORK[provider.id];
  const stepTitles = {
    1: `Import from ${provider.display_name}`,
    2: "Upload the archive",
  } as const;

  // Who the modal is about, on every step: the catalog row's own identity,
  // so the dialog never reads as a generic uploader.
  const identity = (
    <div className="flex items-center gap-3">
      {art ? (
        <ProviderMark alt="" inset={art.inset} src={art.logo} />
      ) : (
        <ProviderMark bg="#f1f1f1">
          <span className="text-sm font-medium text-muted-foreground">
            {provider.display_name.charAt(0)}
          </span>
        </ProviderMark>
      )}
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">
          {provider.display_name}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {art?.brings ?? CAPABILITY_COPY[provider.capability]}
        </span>
      </span>
    </div>
  );

  return (
    <FlowDialog
      ariaLabel={stepTitles[1]}
      counter={`${step} / 2`}
      dir={dir}
      onClose={onClose}
      panelKey={step}
      title={stepTitles[step]}
      footer={
        step === 1 ? (
          <>
            <Button variant="ghost" size="xs" onClick={onClose}>
              Cancel
            </Button>
            <Button size="xs" onClick={() => goTo(2)}>
              Continue
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="xs" onClick={() => goTo(1)}>
              Back
            </Button>
            <Button
              size="xs"
              disabled={file === null}
              loading={busy}
              onClick={() => void start()}
            >
              Import
            </Button>
          </>
        )
      }
    >
      {step === 1 ? (
        <div className="flex flex-col gap-3 p-4">
          {identity}
          <p className="text-xs leading-5 text-muted-foreground">
            In {provider.display_name}, export your site&apos;s data and keep
            the download exactly as it arrives: one ZIP archive, unmodified.
            The next step hands it over.
          </p>
          <p className="text-xs leading-5 text-muted-foreground">
            Nothing reaches the dashboard until you have reviewed what it
            contains; publishing stays in your hands.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3 p-4">
          {identity}
          <input
            accept=".zip,application/zip"
            className="hidden"
            onChange={(event) => {
              const picked = event.target.files?.[0];
              // Clearing the value lets the same file be chosen twice in a row.
              event.target.value = "";
              if (picked) {
                setFile(picked);
                setError(null);
              }
            }}
            ref={inputRef}
            type="file"
          />
          {/* The upload section proper: one large target that is both the
              click path and the drop path. Picking only *chooses* — the
              pick is shown back, and the footer's Import is what sends it,
              so nobody ships a 2 GB archive off a misclick. */}
          <button
            className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-input bg-secondary/30 px-4 py-8 text-center outline-none transition-colors hover:bg-secondary/50 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-secondary/30"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const dropped = event.dataTransfer.files?.[0];
              if (dropped && !busy) {
                setFile(dropped);
                setError(null);
              }
            }}
            type="button"
          >
            {file === null ? (
              <>
                <span className="text-sm font-medium">
                  Choose the ZIP archive
                </span>
                <span className="text-xs text-muted-foreground">
                  or drop it here: the export exactly as it arrived
                </span>
              </>
            ) : (
              <>
                <span className="max-w-full truncate font-mono text-sm font-medium">
                  {file.name}
                </span>
                <span className="text-xs text-muted-foreground">
                  {formatBytes(file.size)} · choose a different file
                </span>
              </>
            )}
          </button>
          {busy ? (
            <p className="text-xs text-muted-foreground">
              Starting the import: signing the upload with storage…
            </p>
          ) : null}
          {error ? (
            <p className="text-xs leading-5 text-destructive-foreground">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </FlowDialog>
  );
}

/** The run the site is currently working on, in whatever phase it is in. */
function ActiveRun({
  run,
  siteId,
  canWrite,
  firstEventAt,
  onUpdate,
  onDiscarded,
}: {
  run: ImportRun;
  siteId: string;
  canWrite: boolean;
  firstEventAt: string | null;
  onUpdate: (run: ImportRun) => void;
  onDiscarded: (runId: string) => void;
}) {
  const copy = PHASE_COPY[run.phase];

  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {run.provider} · {copy.label}
          </p>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {copy.note}
          </p>
        </div>
        {/* The difference between "this is working" and "this keeps failing
            and will be tried again" — the whole reason a support conversation
            resolves in one message. */}
        {run.status === "failed_retryable" ? (
          <Badge className="shrink-0" size="sm" variant="warning">
            Retrying
          </Badge>
        ) : null}
      </div>

      {run.phase === "uploading" ? (
        <UploadStep
          canWrite={canWrite}
          onDiscarded={onDiscarded}
          onUpdate={onUpdate}
          run={run}
          siteId={siteId}
        />
      ) : null}

      {run.phase === "ready_for_review" ? (
        <ReviewStep
          canWrite={canWrite}
          firstEventAt={firstEventAt}
          onDiscarded={onDiscarded}
          onUpdate={onUpdate}
          run={run}
          siteId={siteId}
        />
      ) : null}
    </div>
  );
}

/**
 * The transfer: one PUT straight to storage, then `complete`.
 *
 * The api sees nothing between the two, so progress can only come from the
 * browser's own upload stream. When a signature expires mid-transfer the first
 * offer is **retry**, not discard: re-reading the run mints a fresh upload
 * block bound to the same declared size, and discarding would throw away the
 * bytes already sent.
 */
function UploadStep({
  run,
  siteId,
  canWrite,
  onUpdate,
  onDiscarded,
}: {
  run: ImportRun;
  siteId: string;
  canWrite: boolean;
  onUpdate: (run: ImportRun) => void;
  onDiscarded: (runId: string) => void;
}) {
  const [progress, setProgress] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const autoStarted = React.useRef(false);

  const transfer = React.useCallback(
    async (file: File, target: ImportUploadTarget | null) => {
      setError(null);
      setBusy(true);
      try {
        let upload = target;
        if (!upload) {
          // Only `GET .../imports/{run_id}` mints one, and only while the run
          // is still `uploading` — this is the expiry recovery.
          const fresh = await imports.get(siteId, run.id);
          onUpdate(fresh);
          upload = fresh.upload;
        }
        if (!upload) {
          setError("This import has moved on; its upload window is closed.");
          return;
        }
        setProgress(0);
        await uploadImportArchive(upload, file, {
          onProgress: setProgress,
        });
        FILES.set(run.id, file);
        // A repeat of `complete` on an `uploaded` run answers 202, so the
        // retry after a lost response needs nothing special.
        onUpdate(await imports.complete(siteId, run.id));
      } catch (raised: unknown) {
        setProgress(null);
        if (raised instanceof UploadFailed) {
          setError(
            raised.status === 403
              ? "The upload link expired. Retry, and a fresh one is minted on the spot."
              : "The file did not reach storage. Retry the upload."
          );
          return;
        }
        if (errorCodeOf(raised) === "IMPORT_UPLOAD_MISSING") {
          setError("Storage has no archive for this import yet. Upload it again.");
          return;
        }
        setError(presentError(raised).body);
      } finally {
        setBusy(false);
      }
    },
    [onUpdate, run.id, siteId]
  );

  // The create call handed us both the file and the first upload target, so
  // the transfer starts by itself — once. A run restored from the list has no
  // file here and must never auto-start.
  React.useEffect(() => {
    if (autoStarted.current) return;
    const file = FILES.get(run.id);
    const upload = run.upload;
    if (!file || !upload) return;
    autoStarted.current = true;
    // Off the effect body on a timer: `transfer` writes state on its first
    // line, and the repo lints against a synchronous setState in an effect.
    const timer = setTimeout(() => void transfer(file, upload), 0);
    return () => clearTimeout(timer);
  }, [run.id, run.upload, transfer]);

  const discard = async () => {
    setBusy(true);
    try {
      await imports.discard(siteId, run.id);
      FILES.delete(run.id);
      onDiscarded(run.id);
    } catch (raised: unknown) {
      setError(presentError(raised).body);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {progress !== null ? (
        <div className="flex flex-col gap-1.5">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/8">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-200"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
          <p className="text-xs tabular-nums text-muted-foreground">
            {progress >= 1
              ? "Telling the api the file landed…"
              : `Uploading: ${Math.round(progress * 100)}%`}
          </p>
        </div>
      ) : (
        <p className="text-xs leading-5 text-muted-foreground">
          This import holds the site&apos;s import slot until the archive
          arrives, or until it is discarded.
        </p>
      )}

      {error ? (
        <p className="text-xs leading-5 text-destructive-foreground">{error}</p>
      ) : null}

      {canWrite ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            accept=".zip,application/zip"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void transfer(file, null);
            }}
            ref={inputRef}
            type="file"
          />
          <Button
            disabled={busy}
            onClick={() => {
              const file = FILES.get(run.id);
              // A retry needs the bytes. After a reload we no longer have
              // them, so the honest offer is to choose the file again.
              if (file) void transfer(file, null);
              else inputRef.current?.click();
            }}
            size="xs"
            variant="secondary"
          >
            {progress === null ? "Upload the archive" : "Retry upload"}
          </Button>
          <Button
            disabled={busy}
            onClick={() => void discard()}
            size="xs"
            variant="ghost"
          >
            Discard
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The review — the screen the customer decides on.
 *
 * `warnings` is the point of it: they are the difference between what the
 * provider had and what this dashboard will show. The cutover picker defaults
 * to the server's proposal and is bounded at the day after the site's first
 * live event, which is exactly where the server would refuse it — so the
 * refusal never fires.
 */
function ReviewStep({
  run,
  siteId,
  canWrite,
  firstEventAt,
  onUpdate,
  onDiscarded,
}: {
  run: ImportRun;
  siteId: string;
  canWrite: boolean;
  firstEventAt: string | null;
  onUpdate: (run: ImportRun) => void;
  onDiscarded: (runId: string) => void;
}) {
  const summary = run.summary;
  const [cutover, setCutover] = React.useState(
    summary?.proposed_cutover_date ?? ""
  );
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  if (!summary) return null;

  // `proposed_cutover_date` is null exactly when nothing was staged, and such
  // a run cannot be published at all (422).
  const staged = summary.proposed_cutover_date !== null;
  const maxCutover = firstEventAt ? dayAfter(firstEventAt) : undefined;

  const publish = async () => {
    setBusy(true);
    setError(null);
    try {
      onUpdate(
        await imports.publish(siteId, run.id, cutover || null, newIdempotencyKey())
      );
    } catch (raised: unknown) {
      const issue = validationIssueFor(raised, "cutover_date");
      setError(
        issue?.code === "too_late"
          ? "The cutover cannot be later than the day after this site's first live event."
          : presentError(raised).body
      );
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    setBusy(true);
    setError(null);
    try {
      await imports.discard(siteId, run.id);
      onDiscarded(run.id);
    } catch (raised: unknown) {
      setError(presentError(raised).body);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Figure
          label="Covers"
          value={
            summary.date_range
              ? `${formatDate(summary.date_range.from)} – ${formatDate(summary.date_range.to)}`
              : "Nothing staged"
          }
        />
        <Figure label="Rows staged" value={count(summary.total_rows)} />
      </div>

      <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
        {REPORT_ORDER.map((key) => {
          const report = summary.reports[key];
          return (
            <li
              className="flex items-baseline justify-between gap-3 text-xs"
              key={key}
            >
              <span className="text-muted-foreground">
                {REPORT_LABEL[key] ?? key}
              </span>
              <span
                className={cn(
                  "tabular-nums",
                  report === undefined && "text-muted-foreground/60"
                )}
              >
                {/* Absent and empty are different statements: one report was
                    not in the archive at all, the other was there and carried
                    no rows. */}
                {report === undefined
                  ? "not in the archive"
                  : report.rows === 0
                    ? "empty"
                    : count(report.rows)}
              </span>
            </li>
          );
        })}
      </ul>

      {summary.warnings.length > 0 ? (
        <div className="rounded-xl border border-border bg-card p-3">
          <p className="text-xs font-medium">What the import could not carry</p>
          <ul className="mt-1.5 flex flex-col gap-1">
            {summary.warnings.map((warning) => (
              <li
                className="flex items-baseline justify-between gap-3 text-xs leading-5 text-muted-foreground"
                key={warning.code}
              >
                {/* An unrecognised code is a displayable key, not an error. */}
                <span>{WARNING_COPY[warning.code] ?? warning.code}</span>
                {warning.count > 0 ? (
                  <span className="shrink-0 tabular-nums">
                    {count(warning.count)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {staged ? (
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium" htmlFor="cutover">
            Imported history stops on
          </label>
          <input
            className="h-9 w-full max-w-56 rounded-lg border border-border bg-card px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            id="cutover"
            max={maxCutover}
            onChange={(event) => setCutover(event.target.value)}
            type="date"
            value={cutover}
          />
          <p className="text-xs leading-5 text-muted-foreground">
            Imported numbers are shown before this day and live numbers from it
            onwards, so the two can never overlap.
            {maxCutover
              ? " It cannot be later than the day after this site's first live event."
              : " This site has no live events yet, so there is no upper bound."}
          </p>
        </div>
      ) : (
        <p className="text-xs leading-5 text-warning-foreground">
          Nothing was staged from this archive, so there is nothing to publish.
          Discard it and try another export.
        </p>
      )}

      {error ? (
        <p className="text-xs leading-5 text-destructive-foreground">{error}</p>
      ) : null}

      {canWrite ? (
        <div className="flex flex-wrap items-center gap-2">
          {staged ? (
            <Button disabled={busy} onClick={() => void publish()} size="sm">
              {busy ? "Publishing…" : "Publish to the dashboard"}
            </Button>
          ) : null}
          <Button
            disabled={busy}
            onClick={() => void discard()}
            size="sm"
            variant="ghost"
          >
            Discard
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2">
      <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground/70">
        {label}
      </p>
      <p className="mt-0.5 text-sm font-medium tabular-nums">{value}</p>
    </div>
  );
}

/**
 * The published import, and the one control that can undo it.
 *
 * Exactly one generation is kept, and the copy says so: rolling back a site's
 * first import leaves it with no imported history at all. On
 * `IMPORT_ROLLBACK_UNAVAILABLE` the predecessor is already gone and retrying
 * can never work, so the button is removed rather than re-offered.
 */
function PublishedRun({
  run,
  siteId,
  canWrite,
  onUpdate,
}: {
  run: ImportRun;
  siteId: string;
  canWrite: boolean;
  onUpdate: (run: ImportRun) => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const [unavailable, setUnavailable] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const rollback = async () => {
    setBusy(true);
    setError(null);
    try {
      onUpdate(await imports.rollback(siteId, run.id));
    } catch (raised: unknown) {
      if (errorCodeOf(raised) === "IMPORT_ROLLBACK_UNAVAILABLE") {
        setUnavailable(true);
        setError(
          "The previous import has already been cleaned up, so this one can no longer be undone."
        );
        return;
      }
      setError(presentError(raised).body);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-t border-border p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {run.provider} · live on the dashboard
          </p>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            Imported history is served before {formatDate(run.cutover_date)} ·
            published {formatInstant(run.finished_at ?? run.created_at)}
          </p>
        </div>
        {canWrite && !unavailable ? (
          <Button
            disabled={busy}
            onClick={() => void rollback()}
            size="xs"
            variant="ghost"
          >
            {busy ? "Rolling back…" : "Roll back"}
          </Button>
        ) : null}
      </div>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        Exactly one generation is kept. Rolling this back restores the import
        before it. If there was none, the site is left with no imported
        history.
      </p>
      {error ? (
        <p className="mt-2 text-xs leading-5 text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Everything that already finished, in the order the api listed it. */
function RunHistory({ runs }: { runs: ImportRun[] }) {
  return (
    <div className="border-t border-border">
      <p className="px-5 pb-1 pt-3 text-[11px] uppercase tracking-[0.14em] text-muted-foreground/70">
        Earlier imports
      </p>
      <ul className="divide-y divide-border">
        {runs.map((run) => (
          <li className="flex items-baseline gap-3 px-5 py-2.5" key={run.id}>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium">
                {run.provider} · {PHASE_COPY[run.phase].label}
              </span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {run.phase === "failed" && run.error_code
                  ? (FAILURE_COPY[run.error_code] ?? run.error_code)
                  : PHASE_COPY[run.phase].note}
              </span>
            </span>
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
              {formatInstant(run.finished_at ?? run.created_at)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* Export ------------------------------------------------------------------- */

const EXPORT_PHASE_COPY: Record<ExportRun["phase"], string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Ready",
  expired: "Expired",
  failed: "Failed",
};

/**
 * Export: request → poll → download.
 *
 * `export:raw` is owner-only, but the **list stays visible to every member**:
 * that an export happened is audit-relevant, and hiding the panel from an
 * admin would hide the fact rather than the capability.
 */
function ExportPanel({ site }: { site: SiteSummary }) {
  const siteId = site.site_id;
  const isOwner = site.role === "owner";

  const { state: list, set } = useSiteList<ExportRun>(
    React.useCallback(() => dataExports.list(siteId), [siteId]),
    MOCK_EXPORTS,
    siteId
  );
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const rows = React.useMemo(
    () => (list.status === "ready" ? list.items : []),
    [list]
  );
  const patch = React.useCallback(
    (next: ExportRun) => set(upsert(rows, next)),
    [set, rows]
  );

  const runningId =
    rows.find((row) => row.phase === "queued" || row.phase === "running")?.id ??
    null;
  React.useEffect(() => {
    if (!LIVE_API || !runningId) return;
    const timer = setInterval(() => {
      // The status read mints nothing; the download call is the audited one
      // and a poll must never touch it.
      dataExports.get(siteId, runningId).then(patch, () => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [siteId, runningId, patch]);

  const request = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await dataExports.create(siteId, newIdempotencyKey());
      patch(created.export);
    } catch (raised: unknown) {
      setError(presentError(raised).body);
    } finally {
      setBusy(false);
    }
  };

  const settled = list.status !== "loading";
  const unsupported = list.status === "unsupported";

  /**
   * The intro line and one empty-list line — the shape a site that has never
   * exported lands on, which is almost every site and always the shortest of
   * the possible answers. Exports are the last thing on the screen, so a list
   * that does arrive grows downwards into nothing. Only the contents: the
   * chrome never waits.
   */
  const skeleton = (
    <>
      <div className="border-b border-border px-5 py-3">
        <span className="flex h-5 items-center">
          <SkeletonBar className="h-3 w-full" />
        </span>
        <span className="flex h-5 items-center">
          <SkeletonBar className="h-3 w-1/2" />
        </span>
      </div>
      <div className="px-5 py-4">
        <span className="flex h-5 items-center">
          <SkeletonBar className="h-3 w-28" />
        </span>
      </div>
    </>
  );

  return (
    <SettingsPanel
      action={
        // Only an owner gets the button, and `isOwner` is knowable before the
        // read answers — so only an owner gets the stand-in, and nobody
        // watches a bar settle into nothing. The rare unsupported answer
        // takes the button away with the list it would have fed.
        !isOwner ? null : !settled ? (
          <SkeletonBar className="h-7 w-28 animate-pulse rounded-full" />
        ) : unsupported ? null : (
          <Button
            disabled={busy || runningId !== null}
            onClick={() => void request()}
            size="xs"
            variant="secondary"
          >
            {busy ? "Requesting…" : "Export raw events"}
          </Button>
        )
      }
      title="Export"
    >
      <SkeletonReveal ready={settled} skeleton={skeleton}>
        {!settled ? null : unsupported ? (
          <p className="p-5 text-xs leading-5 text-muted-foreground">
            This deployment has no object storage configured, so exports are
            off here.
          </p>
        ) : list.status === "error" ? (
          <ApiErrorPanel error={list.error} onRetry={list.retry} />
        ) : (
          <>
            <p className="border-b border-border px-5 py-3 text-xs leading-5 text-muted-foreground">
              Everything this site holds: one row per event, gzipped NDJSON,
              with a manifest and a digest per file.{" "}
              {isOwner
                ? "Files are kept for seven days."
                : "Only the site's owner can request one or take delivery of it."}
            </p>

            {error ? (
              <p className="border-b border-border px-5 py-3 text-xs leading-5 text-destructive-foreground">
                {error}
              </p>
            ) : null}

            {rows.length === 0 ? (
              <p className="px-5 py-4 text-xs leading-5 text-muted-foreground">
                No exports yet.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {rows.map((row) => (
                  <ExportRowItem
                    isOwner={isOwner}
                    key={row.id}
                    onUpdate={patch}
                    row={row}
                    siteId={siteId}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </SkeletonReveal>
    </SettingsPanel>
  );
}

function ExportRowItem({
  row,
  siteId,
  isOwner,
  onUpdate,
}: {
  row: ExportRun;
  siteId: string;
  isOwner: boolean;
  onUpdate: (row: ExportRun) => void;
}) {
  const [files, setFiles] = React.useState<{
    items: ExportDownloadFile[];
    expiresAt: string;
  } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const fetchLinks = async () => {
    setBusy(true);
    setError(null);
    try {
      const download = await dataExports.download(siteId, row.id);
      setFiles({ items: download.files, expiresAt: download.expires_at });
    } catch (raised: unknown) {
      if (errorCodeOf(raised) === "EXPORT_EXPIRED") {
        // The row flips lazily, at the first download attempt past the
        // deadline — this `410` is what settles it.
        onUpdate({ ...row, phase: "expired" });
        setFiles(null);
        setError(
          "These files are gone. Request a new export to download it again."
        );
        return;
      }
      setError(presentError(raised).body);
    } finally {
      setBusy(false);
    }
  };

  // `phase`, not `status`: an expired export reports `status: 'succeeded'`,
  // because the operation did succeed and what ran out is the life of its
  // bytes.
  const downloadable = row.phase === "succeeded";

  return (
    <li className="flex flex-col gap-2 px-5 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {EXPORT_PHASE_COPY[row.phase]}
            {row.status === "failed_retryable" ? " · retrying" : ""}
          </p>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {/* `cutoff` is what makes the file reproducible, and the answer to
                "does this include today?". */}
            Everything accepted up to {formatInstant(row.cutoff)}
            {row.manifest
              ? ` · ${count(row.manifest.rows)} rows · ${row.manifest.chunks} files · ${formatBytes(row.manifest.bytes)}`
              : ""}
          </p>
          {row.phase === "succeeded" && row.expires_at ? (
            <p className="mt-0.5 text-xs text-muted-foreground/70">
              {/* Server-computed. A client-side "+7 days" would invent a
                  deadline and keep offering a download after the objects were
                  deleted. */}
              Files available until {formatInstant(row.expires_at)}
            </p>
          ) : null}
          {row.phase === "failed" && row.error_code ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {row.error_code}
            </p>
          ) : null}
        </div>

        {isOwner && downloadable ? (
          <Button
            disabled={busy}
            onClick={() => void fetchLinks()}
            size="xs"
            variant="secondary"
          >
            {busy ? "Preparing…" : files ? "Fresh links" : "Download"}
          </Button>
        ) : null}
      </div>

      {error ? (
        <p className="text-xs leading-5 text-destructive-foreground">{error}</p>
      ) : null}

      {files ? (
        <div className="rounded-xl border border-border bg-card p-3">
          <p className="text-xs leading-5 text-muted-foreground">
            {/* Fifteen minutes, and asking again is an ordinary flow — each
                call is one audit row, which is why nothing caches these. */}
            Links expire at {formatInstant(files.expiresAt)}. Ask again for a
            fresh set.
          </p>
          <ul className="mt-2 flex flex-col gap-1">
            {files.items.map((file) => (
              <li
                className="flex items-baseline justify-between gap-3 text-xs"
                key={file.filename}
              >
                <a
                  className="truncate font-mono text-primary hover:underline"
                  download={file.filename}
                  href={file.url}
                  rel="noreferrer"
                >
                  {file.filename}
                </a>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {file.bytes === null ? "manifest" : formatBytes(file.bytes)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </li>
  );
}
