import {
  CloudSlowWindIcon,
  DatabaseImportIcon,
  DatabaseSync01Icon,
  InboxIcon,
  TriangleAlertIcon,
} from "@/components/icons/hugeicons";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { AnalyticsMeta, FreshnessState } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * The cardinal rule (frontend docs, analytics_metrics §meta): an empty series
 * whose `freshness.state` is not `ok` is NOT "no traffic". Every screen has to
 * tell true empty (`no_data`) apart from a lagging pipeline (`stale`) or an
 * unknown one (`degraded`), and must never render either as zeros.
 */

export type DataState =
  | { kind: "ok" }
  | { kind: "empty" }
  | { kind: "stale"; watermark: string | null }
  | { kind: "degraded" };

/**
 * Reads `meta` once so screens branch on one value instead of three fields.
 *
 * `freshness` is optional because the public metas do not carry it at all
 * (D-213 — its watermark told a stranger when the site last had a visitor).
 * Its absence is "nothing to caveat", never an error: empty stays empty and
 * ok stays ok; only the private surface can say stale or degraded.
 */
export function dataStateOf(
  // `accuracy` is never read here — it exists so the public metas, which
  // carry no `freshness` member at all, still share a property with this
  // shape. An all-optional parameter type with zero overlap is rejected by
  // TypeScript's weak-type check, and rightly: it would accept anything.
  meta:
    | {
        freshness?: AnalyticsMeta["freshness"];
        accuracy?: AnalyticsMeta["accuracy"];
      }
    | null
    | undefined,
  isEmpty: boolean
): DataState {
  const state: FreshnessState | undefined = meta?.freshness?.state;
  if (state === "stale") {
    return { kind: "stale", watermark: meta?.freshness?.watermark ?? null };
  }
  if (state === "degraded") return { kind: "degraded" };
  if (state === "no_data" || isEmpty) return { kind: "empty" };
  return { kind: "ok" };
}

/**
 * Age of an instant, for the stale panel's "latest data …" footnote. The
 * watermark is the site's newest data instant — the age of the last visit,
 * NOT a processing delay (ADR-0025) — so wording around this value must
 * never claim the pipeline is that far behind. `state` is the only source
 * allowed to speak about the pipeline.
 */
export function relativeTime(instant: string | null): string | null {
  if (!instant) return null;
  const then = Date.parse(instant);
  if (Number.isNaN(then)) return null;
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

const COPY: Record<
  Exclude<DataState["kind"], "ok">,
  { icon: typeof InboxIcon; title: string; body: string; tone: string }
> = {
  empty: {
    icon: InboxIcon,
    title: "No data yet",
    body: "Once visits come in, they show up here.",
    tone: "text-muted-foreground",
  },
  stale: {
    icon: DatabaseSync01Icon,
    title: "Catching up",
    body: "The pipeline is behind, so these numbers are not current.",
    tone: "text-warning-foreground",
  },
  degraded: {
    icon: CloudSlowWindIcon,
    title: "Freshness unknown",
    body: "We cannot confirm how current these numbers are.",
    tone: "text-warning-foreground",
  },
};

/**
 * Fills a card body when there is nothing trustworthy to plot. Deliberately
 * never shows a zero — a lagging pipeline and an empty site look different.
 */
export function DataStatePanel({
  state,
  emptyBody,
  className,
}: {
  state: Exclude<DataState, { kind: "ok" }>;
  /** Screen-specific wording for the true-empty case. A node rather than a
   * string so an empty card can offer the way out of being empty. */
  emptyBody?: React.ReactNode;
  className?: string;
}) {
  const copy = COPY[state.kind];
  const Icon = copy.icon;
  const updated =
    state.kind === "stale" ? relativeTime(state.watermark) : null;

  return (
    <div
      className={cn(
        "flex h-full flex-1 flex-col items-center justify-center gap-2 px-8 text-center",
        className
      )}
    >
      <Icon aria-hidden="true" className={cn("size-5", copy.tone)} />
      <p className="text-sm font-medium">{copy.title}</p>
      <p className="max-w-56 text-sm leading-6 text-muted-foreground">
        {state.kind === "empty" ? (emptyBody ?? copy.body) : copy.body}
      </p>
      {updated ? (
        <p className="text-xs tabular-nums text-muted-foreground/70">
          Latest data {updated}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A quiet inline marker for panels that still have numbers worth showing but
 * whose numbers are behind. Sits beside the card's title — `SquircleCard`'s
 * header slot is where `AnalyticsCardBody` places it — never over the data.
 *
 * The explanation is a real tooltip, not a `title` attribute: the chip is two
 * words, the tooltip is the only place those words are explained, and the
 * native delay (~1 s, browser-styled) read as "no tooltip" to anyone who did
 * not linger. `delay={100}` is the point, not a flourish.
 */
export function FreshnessChip({
  state,
  className,
}: {
  state: DataState;
  className?: string;
}) {
  if (state.kind === "ok" || state.kind === "empty") return null;
  const latest = state.kind === "stale" ? relativeTime(state.watermark) : null;
  return (
    <Tooltip>
      <TooltipTrigger
        delay={100}
        render={
          <Badge
            className={className}
            icon={
              state.kind === "stale" ? (
                <CloudSlowWindIcon />
              ) : (
                <TriangleAlertIcon />
              )
            }
            size="sm"
            variant="warning"
          >
            {state.kind === "stale" ? "Catching up" : "Unverified"}
          </Badge>
        }
      />
      {/* The same sentences the full-panel state uses (`COPY`), so the chip
          and the panel can never explain the same state two ways. */}
      <TooltipPopup className="max-w-60">
        {COPY[state.kind].body}
        {latest ? ` Latest data ${latest}.` : null}
      </TooltipPopup>
    </Tooltip>
  );
}

/* Provenance — where the numbers came from, and how exact they are ---------- */

/**
 * Whether this **response** blended in imported history (ADR-0032 D5,
 * frontend_tasks §22).
 *
 * Read per response and never from the site's import state: the same site
 * answers `['live']` for a range after the cutover and `['live','imported']`
 * for one that crosses it, so "does this site have an import" is the wrong
 * question to ask.
 */
export function includesImported(
  meta: Pick<AnalyticsMeta, "data_sources"> | null | undefined
): boolean {
  return meta?.data_sources.includes("imported") ?? false;
}

/**
 * The three accuracy values, and the three different things they mean.
 *
 * `provider_defined` is **not** a degraded reading — it is the provider's own
 * figure, unmodified, which is the most faithful answer the system can give
 * for a fully imported day. It is worded as provenance for that reason, while
 * `estimated` is the one that warns.
 */
const ACCURACY_COPY: Record<
  Exclude<AnalyticsMeta["accuracy"], "exact">,
  { label: string; title: string }
> = {
  provider_defined: {
    label: "Provider's own numbers",
    title:
      "Every number here is a row from the import, unmodified, not a figure we recomputed.",
  },
  estimated: {
    label: "Estimated",
    title:
      "This range blends imported days with live data, crosses the import cutover, or aggregates across provider days. The totals are close, not exact.",
  },
};

/**
 * The provenance markers a panel carries: whether imported history is in the
 * answer, and how exact the answer is. Sits next to a card title, never over
 * the data — the same placement rule `FreshnessChip` follows.
 *
 * With `compare=true` the api already reports the union of the two ranges and
 * the worse of the two accuracies, so one set of markers covers a whole card.
 */
export function ProvenanceChips({
  meta,
  className,
}: {
  meta: Pick<AnalyticsMeta, "data_sources" | "accuracy"> | null | undefined;
  className?: string;
}) {
  if (!meta) return null;
  const imported = includesImported(meta);
  const accuracy = meta.accuracy === "exact" ? null : ACCURACY_COPY[meta.accuracy];
  if (!imported && !accuracy) return null;

  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      {imported ? (
        <Badge
          icon={<DatabaseImportIcon />}
          size="sm"
          title="This range reaches back past the import cutover, so it includes history brought over from your previous analytics tool."
          variant="secondary"
        >
          Includes imported data
        </Badge>
      ) : null}
      {accuracy ? (
        <Badge
          size="sm"
          title={accuracy.title}
          variant={meta.accuracy === "estimated" ? "warning" : "secondary"}
        >
          {accuracy.label}
        </Badge>
      ) : null}
    </span>
  );
}

/**
 * The losses an aggregate-only import carries, worded rather than papered
 * over. Both are permanent properties of the provider's export, not gaps that
 * fill in later, so they read as notes and not as warnings.
 */
export function ImportedGapNote({
  meta,
  kind,
  className,
}: {
  meta: Pick<AnalyticsMeta, "data_sources"> | null | undefined;
  /** `city` — imported geography has none. `devices` — only types merge. */
  kind: "city" | "devices";
  className?: string;
}) {
  if (!includesImported(meta)) return null;
  return (
    <p className={cn("text-xs leading-5 text-muted-foreground", className)}>
      {kind === "city"
        ? "Imported history has no cities, so city rows cover live traffic only; imported countries land on the “city unknown” row."
        : "Only imported device types merge here. Imported browsers and operating systems are read separately and are not in this report."}
    </p>
  );
}

/**
 * Sessions carry a second layer: everything after `finalized_through` may
 * still be revised (a late pageview can undo a bounce). The tail is rendered
 * hatched so a number that can still move never looks settled.
 */
export function ProvisionalNote({
  finalizedThrough,
  className,
}: {
  finalizedThrough: string | null;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "flex items-center gap-1.5 text-xs text-muted-foreground",
        className
      )}
    >
      <span
        aria-hidden="true"
        className="size-2.5 rounded-[3px] border border-border bg-[repeating-linear-gradient(45deg,transparent,transparent_2px,var(--color-border)_2px,var(--color-border)_3px)]"
      />
      {finalizedThrough
        ? "Hatched values are still settling and may change."
        : "All values are provisional and may change."}
    </p>
  );
}
