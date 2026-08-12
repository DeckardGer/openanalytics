"use client";

import {
  ArrowDown01Icon,
  DashboardSquare01Icon,
  PencilEdit02Icon,
  PlusSignIcon,
  ViewIcon,
} from "hugeicons-react";
import { ChartAnalysisIcon } from "@/components/icons/hugeicons";
import { AnimatePresence } from "motion/react";
import * as React from "react";
import { FlowDialog } from "@/components/dashboard/flow-dialog";
import { SettingsPanel } from "@/components/dashboard/settings-panel";
import { WidgetPreview } from "@/components/dashboard/widget-preview";
import { CopyButton } from "@/components/ui/copy-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SaveButton } from "@/components/ui/save-button";
import { SkeletonBar, SkeletonReveal } from "@/components/ui/skeleton-reveal";
import { Switch } from "@/components/ui/switch";
import { TimezoneSelect } from "@/components/ui/timezone-select";
import { INTERVALS } from "@/components/dashboard/interval-context";
import {
  API_BASE_URL,
  LIVE_API,
  presentError,
  sites,
  widgets as widgetsApi,
  type SiteSummary,
  type Widget,
  type WidgetRange,
  type WidgetSurface,
} from "@/lib/api";
import { useAction, useApi } from "@/lib/use-api";
import { cn } from "@/lib/utils";

/**
 * Widgets (M15, ADR-0045; §35) — a list of saved definitions describing what
 * this site publishes as embeds, beside the other `site:settings` screens.
 *
 * **Every widget is created with `allowed_origins: ["*"]` — render anywhere —
 * and the form offers no origin choice.** A product decision over the
 * contract's fail-closed default (ADR-0045 D4 kept `[]` meaning "nowhere"):
 * the origin list is a browser rendering policy and never a lock — whoever
 * holds the id can read the JSON from any machine — so restricting it
 * protects nothing while the exact-origin rules (www vs apex, scheme, ports)
 * are the number-one way an embed silently shows nothing. Creating a widget
 * IS the decision to publish that number; the form says so in one line
 * instead of asking questions. Widgets created before this decision keep
 * their stored list untouched until their owner presses "Render anywhere
 * instead" — an unrelated edit never silently widens one.
 *
 * The other rules this screen holds, because each looks like a bug when
 * forgotten:
 *
 * - **The list computes nothing.** No sparkline: a widget's answer is read
 *   anonymously, and polling it from here would spend the widget's public
 *   rate budget (120/min per IP and id, shared with real readers). The
 *   preview modal is the deliberate exception — one user-initiated open
 *   costs two tokens of the owner's own IP budget, which is what a preview
 *   is for.
 * - **The snippet is pasted verbatim.** `embed_snippet` comes from the
 *   server; assembling an iframe client-side would be a second place where
 *   a supported embed's attributes get decided.
 * - **`surface` is immutable after create** and is not even a field of the
 *   update body — the edit form renders it as static text with the reason.
 * - **Disable is honest about its bound**: revocation is immediate at the
 *   origin and honoured within up to 60 seconds anywhere a cache holds a
 *   copy (`max-age=60`; 10 on `realtime`). The copy says "up to 60
 *   seconds", never "immediately".
 * - **DELETE is not idempotent** — it revokes a public credential, so a
 *   failed delete is answered by re-reading the list, never a blind retry.
 */

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

const SURFACES: Array<{
  key: WidgetSurface;
  label: string;
  hint: string;
}> = [
  {
    key: "overview",
    label: "Overview",
    hint: "Visitors, views and session stats, as stat blocks.",
  },
  {
    key: "timeseries",
    label: "Timeseries",
    hint: "A small bar chart of visitors over the window.",
  },
  {
    key: "sessions",
    label: "Sessions",
    hint: "Session counts and duration.",
  },
  { key: "pages", label: "Top pages", hint: "The most viewed pages." },
  {
    key: "sources",
    label: "Top sources",
    hint: "Where visitors arrive from.",
  },
  {
    key: "devices",
    label: "Devices",
    hint: "Browsers and operating systems.",
  },
  {
    key: "geography",
    label: "Geography",
    hint: "Countries, by visitors.",
  },
  {
    key: "realtime",
    label: "Realtime",
    hint: "One number: who is on the site right now. The embed refreshes it every 15 seconds.",
  },
];

/** The four surfaces a row cap applies to; anywhere else `limit` is a 400. */
const BREAKDOWNS: ReadonlySet<WidgetSurface> = new Set([
  "pages",
  "sources",
  "devices",
  "geography",
]);

const surfaceLabel = (key: WidgetSurface) =>
  SURFACES.find((surface) => surface.key === key)?.label ?? key;

/** The dashboard's own interval labels, verbatim — same keys, same windows. */
const rangeLabel = (key: WidgetRange) =>
  INTERVALS.find((interval) => interval.key === key)?.label ?? key;

const WIDGET_CAP = 50;

/** A widget that renders on any page — the only state new widgets get. */
const rendersAnywhere = (origins: string[]) => origins[0] === "*";

/* ------------------------------------------------------------------ */
/* Mock rows — the fixture's shape, three states the screen must hold  */
/* ------------------------------------------------------------------ */

const MOCK_WIDGETS: Widget[] = [
  {
    id: "w3f9xk21qm70c4bd",
    surface: "pages",
    title: "Most read this week",
    range: "7d",
    limit: 5,
    // A pre-"render anywhere" widget: its stored list stays until its owner
    // widens it, and the edit form is where that affordance lives.
    allowed_origins: ["https://shop.example.com"],
    enabled: true,
    embed_url: `${API_BASE_URL}/embed/w3f9xk21qm70c4bd`,
    embed_snippet: `<iframe src="${API_BASE_URL}/embed/w3f9xk21qm70c4bd" title="Most read this week" width="100%" height="320" loading="lazy" style="border:0;color-scheme:normal"></iframe>`,
    created_by_user_id: null,
    created_at: "2026-08-07T09:12:00.000Z",
    updated_at: "2026-08-07T09:12:00.000Z",
  },
  {
    id: "w8a2mnp54rs91d7e",
    surface: "realtime",
    title: "Online now",
    range: null,
    limit: null,
    allowed_origins: ["*"],
    enabled: true,
    embed_url: `${API_BASE_URL}/embed/w8a2mnp54rs91d7e`,
    embed_snippet: `<iframe src="${API_BASE_URL}/embed/w8a2mnp54rs91d7e" title="Online now" width="100%" height="320" loading="lazy" style="border:0;color-scheme:normal"></iframe>`,
    created_by_user_id: null,
    created_at: "2026-08-05T14:03:00.000Z",
    updated_at: "2026-08-05T14:03:00.000Z",
  },
  {
    id: "w5c7qrt98uv32f1g",
    surface: "overview",
    title: null,
    range: "30d",
    limit: null,
    allowed_origins: ["*"],
    enabled: false,
    embed_url: `${API_BASE_URL}/embed/w5c7qrt98uv32f1g`,
    embed_snippet: `<iframe src="${API_BASE_URL}/embed/w5c7qrt98uv32f1g" width="100%" height="320" loading="lazy" style="border:0;color-scheme:normal"></iframe>`,
    created_by_user_id: null,
    created_at: "2026-08-01T08:40:00.000Z",
    updated_at: "2026-08-06T10:15:00.000Z",
  },
];

/* ------------------------------------------------------------------ */
/* The section — list, preview, editor, snippet handover               */
/* ------------------------------------------------------------------ */

export function WidgetsSection({ site }: { site: SiteSummary }) {
  const canManage = site.role !== "viewer";

  /**
   * The site's reporting timezone lives on this tab because this tab is who
   * needs it: a widget's windows are cut in this zone server-side, with no
   * timezone parameter on the public door. Held here, above both panels, so
   * a save in the panel below is what the widget editor's hint reads.
   */
  const [reportingZone, setReportingZone] = React.useState(
    site.reporting_timezone
  );

  const list = useApi(
    () => widgetsApi.list(site.site_id).then((page) => page.items),
    () => MOCK_WIDGETS,
    site.site_id
  );
  /** Mock-mode rows live here so create/edit/delete stay visible offline. */
  const [localRows, setLocalRows] = React.useState<Widget[] | null>(null);
  const rows = localRows ?? list.data ?? [];

  const [editing, setEditing] = React.useState<Widget | "new" | null>(null);
  const [previewing, setPreviewing] = React.useState<Widget | null>(null);

  /** A confirmed mutation, both modes: live re-reads, mock overlays. */
  const commit = (kind: "saved" | "deleted", next: Widget) => {
    if (LIVE_API) {
      list.reload();
      return;
    }
    setLocalRows((current) => {
      const base = current ?? rows;
      if (kind === "deleted") {
        return base.filter((entry) => entry.id !== next.id);
      }
      return base.some((entry) => entry.id === next.id)
        ? base.map((entry) => (entry.id === next.id ? next : entry))
        : [...base, next];
    });
  };

  const listReady = list.phase !== "loading";

  return (
    <>
    <SettingsPanel
      action={
        <span className="flex items-center gap-3">
          {listReady ? (
            <span className="text-xs tabular-nums text-muted-foreground">
              {/* The cap bounds a settings screen, not a price — it appears
                  once it is close, and never with an upgrade link. */}
              {rows.length >= WIDGET_CAP - 10
                ? `${rows.length} of ${WIDGET_CAP}`
                : `${rows.length} ${rows.length === 1 ? "widget" : "widgets"}`}
            </span>
          ) : (
            <SkeletonBar className="h-3.5 w-14 animate-pulse" />
          )}
          {canManage ? (
            <Button
              onClick={() => setEditing("new")}
              size="xs"
              variant="secondary"
            >
              <PlusSignIcon className="size-4" />
              New widget
            </Button>
          ) : null}
        </span>
      }
      title="Widgets"
    >
      {/* The Public dashboard panel's own anatomy: a fixed intro strip
          inside the inset, real from the first frame. It also keeps the
          inset above twice its 44px corner radius with a single row, where
          a bare ~60px list would have its corners clamped into a pill. */}
      <p className="border-b border-border px-5 py-3 text-sm text-muted-foreground">
        Each widget has its own snippet: copy it, paste it into your
        page&apos;s HTML, and it renders live for anyone.
      </p>
      <SkeletonReveal
        ready={listReady}
        skeleton={
          // Pixel-matched to a widget row: surface tile, title + meta lines,
          // the action slots.
          <ul className="divide-y divide-border">
            {[0, 1].map((index) => (
              <li className="flex items-center gap-3 px-5 py-3" key={index}>
                <SkeletonBar className="size-8 shrink-0 rounded-lg" />
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <SkeletonBar className="h-3.5 w-32" />
                  <SkeletonBar className="h-3 w-52 max-w-full" />
                </div>
                <SkeletonBar className="size-7 rounded-lg" />
              </li>
            ))}
          </ul>
        }
      >
        {!listReady ? null : list.phase === "error" ? (
          <div className="flex flex-col items-center gap-2 px-5 py-10 text-center">
            <p className="text-sm font-medium">{list.error.title}</p>
            <p className="text-sm text-muted-foreground">{list.error.body}</p>
            {list.error.retryable ? (
              <Button onClick={list.reload} size="sm" variant="secondary">
                Try again
              </Button>
            ) : null}
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-5 py-10 text-center">
            <p className="text-sm font-medium">No widgets yet</p>
            <p className="max-w-sm text-sm leading-6 text-muted-foreground">
              A widget publishes one of this site&apos;s numbers as an iframe
              you can paste into any page — no account needed to view it.
            </p>
            {canManage ? (
              <Button
                className="mt-1"
                onClick={() => setEditing("new")}
                size="sm"
              >
                <PlusSignIcon className="size-4" />
                New widget
              </Button>
            ) : null}
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((widget) => (
              <li
                className="group flex items-center gap-3 px-5 py-3"
                key={widget.id}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex size-8 shrink-0 items-center justify-center rounded-lg",
                    widget.enabled
                      ? "bg-primary/10 text-primary"
                      : "bg-secondary text-muted-foreground"
                  )}
                >
                  <DashboardSquare01Icon className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {widget.title ?? "Untitled widget"}
                    </span>
                    <Badge
                      icon={<ChartAnalysisIcon />}
                      size="sm"
                      variant="secondary"
                    >
                      {surfaceLabel(widget.surface)}
                    </Badge>
                    {widget.enabled ? null : (
                      <Badge size="sm" variant="warning">
                        Disabled
                      </Badge>
                    )}
                  </span>
                  <span
                    className={cn(
                      "block truncate text-xs",
                      widget.allowed_origins.length === 0
                        ? "text-amber-700"
                        : "text-muted-foreground"
                    )}
                  >
                    {widget.range === null
                      ? "Live"
                      : rangeLabel(widget.range)}
                    {widget.limit !== null ? ` · top ${widget.limit}` : ""}
                    {/* Anywhere is the norm and says nothing; only a stored
                        restriction from before is worth a word. */}
                    {rendersAnywhere(widget.allowed_origins)
                      ? ""
                      : widget.allowed_origins.length === 0
                        ? " · not visible on any page"
                        : ` · only on ${
                            widget.allowed_origins.length === 1
                              ? widget.allowed_origins[0]
                              : `${widget.allowed_origins.length} origins`
                          }`}
                  </span>
                </span>
                <button
                  aria-label={`Preview ${widget.title ?? "widget"}`}
                  className="flex size-7 cursor-pointer items-center justify-center rounded-lg text-muted-foreground/0 outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring group-hover:text-muted-foreground"
                  onClick={() => setPreviewing(widget)}
                  type="button"
                >
                  <ViewIcon className="size-4" />
                </button>
                <CopyButton
                  label={`Copy embed snippet for ${widget.title ?? "widget"}`}
                  text={widget.embed_snippet}
                />
                {canManage ? (
                  <button
                    aria-label={`Edit ${widget.title ?? "widget"}`}
                    className="flex size-7 cursor-pointer items-center justify-center rounded-lg text-muted-foreground/0 outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring group-hover:text-muted-foreground"
                    onClick={() => setEditing(widget)}
                    type="button"
                  >
                    <PencilEdit02Icon className="size-4" />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </SkeletonReveal>

      <AnimatePresence>
        {previewing !== null ? (
          <WidgetPreviewDialog
            key={previewing.id}
            onClose={() => setPreviewing(null)}
            widget={previewing}
          />
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {editing !== null ? (
          <WidgetEditor
            key={editing === "new" ? "new" : editing.id}
            def={editing === "new" ? null : editing}
            onClose={() => setEditing(null)}
            onCommitted={commit}
            reportingZone={reportingZone}
            site={site}
          />
        ) : null}
      </AnimatePresence>
    </SettingsPanel>

    <ReportingTimezonePanel
      canEdit={canManage}
      onSaved={setReportingZone}
      site={site}
      zone={reportingZone}
    />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Reporting timezone — the widgets' clock, so it lives on their tab   */
/* ------------------------------------------------------------------ */

/**
 * `reporting_timezone` (ADR-0044) on `PATCH /v1/sites/{site_id}` — its own
 * panel and its own save, because it moved out of General: every widget's
 * window is cut in this zone server-side (there is no timezone parameter on
 * the public widget door), and the public dashboard opens in it by default.
 * The dashboard's own charts keep following each member's clock (ADR-0026).
 */
function ReportingTimezonePanel({
  site,
  zone,
  canEdit,
  onSaved,
}: {
  site: SiteSummary;
  zone: string | null;
  canEdit: boolean;
  onSaved: (next: string | null) => void;
}) {
  const [selected, setSelected] = React.useState(zone);
  const [saved, setSaved] = React.useState(false);
  const timeout = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  React.useEffect(() => () => clearTimeout(timeout.current), []);

  const save = useAction(async () => {
    setSaved(false);
    if (LIVE_API) {
      // Read the answer back rather than trusting what was sent.
      const next = await sites.update(site.site_id, {
        reporting_timezone: selected,
      });
      setSelected(next.reporting_timezone);
      onSaved(next.reporting_timezone);
    } else {
      onSaved(selected);
    }
    setSaved(true);
    clearTimeout(timeout.current);
    timeout.current = setTimeout(() => setSaved(false), 2000);
  });

  return (
    <SettingsPanel title="Reporting timezone">
      <div className="flex flex-col gap-3 p-5">
        <TimezoneSelect
          ariaLabel="Reporting timezone"
          disabled={!canEdit}
          nullLabel="Not set: widgets report in UTC"
          onPick={setSelected}
          value={selected}
          variant="field"
        />
        <p className="text-xs leading-5 text-muted-foreground">
          The clock your widgets cut their windows in: &quot;Today&quot;,
          &quot;Last 7 days&quot; and every other window start and end on this
          zone&apos;s calendar. Not set, they resolve in UTC — a
          &quot;Today&quot; widget then reports UTC&apos;s today.
        </p>
        <div className="flex items-center gap-3">
          <SaveButton
            disabled={!canEdit}
            onClick={() => save.run()}
            size="sm"
            state={save.busy ? "saving" : saved ? "saved" : "idle"}
          >
            Save changes
          </SaveButton>
          {save.error ? (
            <span className="text-xs text-destructive-foreground">
              {save.error.body}
            </span>
          ) : null}
        </div>
      </div>
    </SettingsPanel>
  );
}

/* ------------------------------------------------------------------ */
/* Preview dialog — the live embed where it can render, a facsimile    */
/* where it cannot                                                     */
/* ------------------------------------------------------------------ */

/**
 * The live document, in the same 320px frame the snippet ships. Only
 * mounted where it will actually paint: an enabled, render-anywhere widget.
 * A restricted origin list would CSP-block this very dashboard, and a
 * disabled widget's document is the same 404 every reader gets — the
 * facsimile shows those states instead of a browser error page.
 *
 * `theme` rides the iframe's `color-scheme`: the embedder's used scheme is
 * what the embedded document's `prefers-color-scheme` answers, so the
 * toggle flips the real document between its two palettes. (Browsers that
 * have not shipped that propagation fall back to the reader's OS scheme —
 * a degraded toggle, never a broken one.)
 */
function LiveEmbed({ widget, theme }: { widget: Widget; theme: "light" | "dark" }) {
  return (
    // The document draws its own card since 2026-08-08 (hairline edge, 12px
    // corners, transparent page behind), so the frame here stays bare: a
    // background or border of its own would double the document's.
    <iframe
      className="h-80 w-full"
      loading="lazy"
      src={widget.embed_url}
      style={{ border: 0, colorScheme: theme }}
      title={widget.title ?? "Widget preview"}
    />
  );
}

/**
 * Light / dark, for the previews only: a reader's machine picks either
 * scheme, so the owner gets to check both before publishing. The house
 * segmented pill (the funnel editor's count-by toggle).
 */
function ThemeToggle({
  value,
  onChange,
}: {
  value: "light" | "dark";
  onChange: (next: "light" | "dark") => void;
}) {
  return (
    <div className="flex h-7 w-fit items-center gap-0.5 rounded-lg bg-secondary/60 p-0.5">
      {(["light", "dark"] as const).map((entry) => (
        <button
          className={cn(
            "h-full cursor-pointer rounded-[7px] px-2.5 text-xs font-medium transition-colors",
            value === entry
              ? "bg-white text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
              : "text-muted-foreground hover:text-foreground"
          )}
          key={entry}
          onClick={() => onChange(entry)}
          type="button"
        >
          {entry === "light" ? "Light" : "Dark"}
        </button>
      ))}
    </div>
  );
}

function WidgetPreviewDialog({
  widget,
  onClose,
}: {
  widget: Widget;
  onClose: () => void;
}) {
  // One deliberate open = two tokens of the owner's own (IP, widget) budget:
  // the document, then the one JSON read it makes. That is what previews are
  // for; what stays forbidden is the list polling these unprompted.
  const live = widget.enabled && rendersAnywhere(widget.allowed_origins);
  // Light first, whatever this machine prefers: the dashboard is a light
  // surface, and the toggle exists precisely so the owner checks both.
  const [theme, setTheme] = React.useState<"light" | "dark">("light");
  return (
    <FlowDialog
      ariaLabel={`Preview ${widget.title ?? "widget"}`}
      dir={1}
      footer={
        <>
          <ThemeToggle onChange={setTheme} value={theme} />
          <Button onClick={onClose} size="xs">
            Done
          </Button>
        </>
      }
      onClose={onClose}
      panelKey="preview"
      title={widget.title ?? "Untitled widget"}
    >
      <div className="flex flex-col gap-3 p-4">
        {live ? (
          <LiveEmbed theme={theme} widget={widget} />
        ) : (
          <WidgetPreview
            enabled={widget.enabled}
            intervalLabel={
              widget.range === null ? "Live" : rangeLabel(widget.range)
            }
            limit={widget.limit}
            surface={widget.surface}
            theme={theme}
            title={widget.title}
          />
        )}
        <p className="text-xs leading-5 text-muted-foreground">
          {live ? (
            <>
              The live embed, exactly as readers see it: a 320px-tall frame
              that fills its container&apos;s width and follows the
              reader&apos;s light or dark mode.
            </>
          ) : !widget.enabled ? (
            // Faithful on purpose: a disabled widget answers every reader
            // with this quiet empty state, so the preview shows it too.
            <>
              This widget is turned off, and this is exactly what every reader
              sees while it is: no error, no explanation, just no data. Turn
              it back on under Edit.
            </>
          ) : (
            <>
              Sample numbers, real layout. This widget still carries an
              origin restriction from before, which blocks it here too — on
              its listed pages the embed shows live data.
            </>
          )}
        </p>
      </div>
    </FlowDialog>
  );
}

/* ------------------------------------------------------------------ */
/* Editor — create, edit, disable, delete, and the snippet handover    */
/* ------------------------------------------------------------------ */

const inputClass =
  "h-9 w-full rounded-xl border border-input bg-white px-3 text-sm outline-none transition-[box-shadow,border-color] focus-visible:border-ring focus-visible:[outline:2px_solid_var(--ring)] focus-visible:[outline-offset:-2px]";

/** The editor's stations. `confirm-delete` and `paste` are terminal asides. */
type EditorStep = "form" | "confirm-delete" | "paste";

function WidgetEditor({
  def,
  site,
  reportingZone,
  onClose,
  onCommitted,
}: {
  /** `null` creates a new widget. */
  def: Widget | null;
  site: SiteSummary;
  /** The saved reporting zone — the panel under the list is where it is set. */
  reportingZone: string | null;
  onClose: () => void;
  onCommitted: (kind: "saved" | "deleted", next: Widget) => void;
}) {
  const [surface, setSurface] = React.useState<WidgetSurface>(
    def?.surface ?? "overview"
  );
  const [range, setRange] = React.useState<WidgetRange>(def?.range ?? "7d");
  const [limit, setLimit] = React.useState(String(def?.limit ?? 10));
  const [title, setTitle] = React.useState(def?.title ?? "");
  // New widgets render anywhere, no questions asked; an existing widget's
  // stored list is kept until its owner explicitly widens it below.
  const [origins, setOrigins] = React.useState<string[]>(
    def?.allowed_origins ?? ["*"]
  );
  const [enabled, setEnabled] = React.useState(def?.enabled ?? true);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [step, setStep] = React.useState<EditorStep>("form");
  const [dir, setDir] = React.useState(1);
  /** The create response — the snippet the paste step exists to hand over. */
  const [created, setCreated] = React.useState<Widget | null>(null);
  /** The paste step's preview scheme — light first, both one click away. */
  const [previewTheme, setPreviewTheme] = React.useState<"light" | "dark">(
    "light"
  );

  const goTo = (next: EditorStep) => {
    setDir(next === "form" ? -1 : 1);
    setStep(next);
  };

  const isRealtime = surface === "realtime";
  const isBreakdown = BREAKDOWNS.has(surface);
  const limitNumber = Number(limit);
  const limitValid =
    !isBreakdown ||
    (Number.isInteger(limitNumber) && limitNumber >= 1 && limitNumber <= 50);

  /** The zone every window of this widget is cut in — never the reader's. */
  const zone = reportingZone ?? "UTC";

  const save = () => {
    if (!limitValid) {
      setError("Rows must be a whole number from 1 to 50.");
      return;
    }
    setError(null);
    const trimmedTitle = title.trim();

    if (def === null) {
      const body = {
        surface,
        title: trimmedTitle === "" ? null : trimmedTitle,
        // `realtime` takes neither a range nor a limit — omitted entirely,
        // because sending either is a 400, not an ignored field.
        ...(isRealtime ? {} : { range }),
        ...(isBreakdown ? { limit: limitNumber } : {}),
        allowed_origins: origins,
      };
      if (!LIVE_API) {
        const id = crypto.randomUUID().replaceAll("-", "").slice(0, 19);
        const row: Widget = {
          id,
          surface,
          title: body.title,
          range: isRealtime ? null : range,
          limit: isBreakdown ? limitNumber : null,
          allowed_origins: origins,
          enabled: true,
          embed_url: `${API_BASE_URL}/embed/${id}`,
          // Mock preview only — the live path always pastes the server's
          // snippet verbatim and never assembles one.
          embed_snippet: `<iframe src="${API_BASE_URL}/embed/${id}"${body.title ? ` title="${body.title}"` : ""} width="100%" height="320" loading="lazy" style="border:0;color-scheme:normal"></iframe>`,
          created_by_user_id: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        onCommitted("saved", row);
        setCreated(row);
        goTo("paste");
        return;
      }
      setBusy(true);
      widgetsApi.create(site.site_id, body).then(
        (saved) => {
          setBusy(false);
          onCommitted("saved", saved);
          setCreated(saved);
          goTo("paste");
        },
        (raised: unknown) => {
          setBusy(false);
          setError(presentError(raised).body);
        }
      );
      return;
    }

    // Partial on purpose: only what changed goes on the wire, and a PATCH
    // with an empty body is refused — nothing changed means nothing sent.
    const nextTitle = trimmedTitle === "" ? null : trimmedTitle;
    const patch: Parameters<typeof widgetsApi.update>[2] = {
      ...(nextTitle !== def.title ? { title: nextTitle } : {}),
      ...(!isRealtime && range !== def.range ? { range } : {}),
      ...(isBreakdown && limitNumber !== def.limit
        ? { limit: limitNumber }
        : {}),
      ...(origins.join("\n") !== def.allowed_origins.join("\n")
        ? { allowed_origins: origins }
        : {}),
      ...(enabled !== def.enabled ? { enabled } : {}),
    };
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    if (!LIVE_API) {
      onCommitted("saved", {
        ...def,
        title: nextTitle,
        range: isRealtime ? null : range,
        limit: isBreakdown ? limitNumber : def.limit,
        allowed_origins: origins,
        enabled,
        updated_at: new Date().toISOString(),
      });
      onClose();
      return;
    }
    setBusy(true);
    widgetsApi.update(site.site_id, def.id, patch).then(
      (saved) => {
        setBusy(false);
        onCommitted("saved", saved);
        onClose();
      },
      (raised: unknown) => {
        setBusy(false);
        setError(presentError(raised).body);
      }
    );
  };

  const destroy = () => {
    if (def === null) return;
    if (!LIVE_API) {
      onCommitted("deleted", def);
      onClose();
      return;
    }
    setBusy(true);
    widgetsApi.remove(site.site_id, def.id).then(
      () => {
        setBusy(false);
        onCommitted("deleted", def);
        onClose();
      },
      (raised: unknown) => {
        setBusy(false);
        // Not retried on purpose: DELETE is not idempotent (a second one is
        // a 404), so the honest recovery is re-reading the list.
        setError(presentError(raised).body);
        goTo("form");
      }
    );
  };

  const stepTitles: Record<EditorStep, string> = {
    form: def === null ? "New widget" : "Edit widget",
    "confirm-delete": "Delete widget",
    paste: "Paste it into your page",
  };

  const footer =
    step === "form" ? (
      <>
        {def !== null ? (
          <Button
            disabled={busy}
            onClick={() => goTo("confirm-delete")}
            size="xs"
            type="button"
            variant="ghost"
          >
            Delete
          </Button>
        ) : null}
        <Button onClick={onClose} size="xs" variant="ghost">
          Cancel
        </Button>
        <Button disabled={!limitValid} loading={busy} onClick={save} size="xs">
          {def === null ? "Create widget" : "Save changes"}
        </Button>
      </>
    ) : step === "confirm-delete" ? (
      <>
        <Button onClick={() => goTo("form")} size="xs" variant="ghost">
          Keep it
        </Button>
        <Button
          loading={busy}
          onClick={destroy}
          size="xs"
          variant="destructive"
        >
          Delete widget
        </Button>
      </>
    ) : (
      <>
        <ThemeToggle onChange={setPreviewTheme} value={previewTheme} />
        <Button onClick={onClose} size="xs">
          Done
        </Button>
      </>
    );

  return (
    <FlowDialog
      ariaLabel={def === null ? "New widget" : `Edit ${def.title ?? "widget"}`}
      dir={dir}
      footer={footer}
      onClose={onClose}
      panelKey={step}
      title={stepTitles[step]}
    >
      {step === "form" ? (
        <div className="flex flex-col gap-3 p-4">
          {def === null ? (
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                What it shows
              </span>
              <span className="relative">
                <select
                  className={cn(
                    inputClass,
                    "cursor-pointer appearance-none pr-8"
                  )}
                  onChange={(event) =>
                    setSurface(event.target.value as WidgetSurface)
                  }
                  value={surface}
                >
                  {SURFACES.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <ArrowDown01Icon
                  aria-hidden="true"
                  className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/70"
                />
              </span>
              <span className="text-xs leading-5 text-muted-foreground">
                {SURFACES.find((option) => option.key === surface)?.hint}
              </span>
            </label>
          ) : (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                What it shows
              </span>
              <p className="rounded-xl bg-[#f6f6f6] px-3 py-2 text-sm">
                {surfaceLabel(def.surface)}
              </p>
              {/* Immutable by contract (ADR-0045, D2): an embed already on
                  somebody's page must never silently start publishing a
                  different class of data. */}
              <span className="text-xs leading-5 text-muted-foreground">
                The surface is fixed once created — an embed already pasted
                into a page would otherwise start publishing different data.
                To show something else, delete this widget and create a new
                one.
              </span>
            </div>
          )}

          {isRealtime ? null : (
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Window
              </span>
              <span className="relative">
                <select
                  className={cn(
                    inputClass,
                    "cursor-pointer appearance-none pr-8"
                  )}
                  onChange={(event) =>
                    setRange(event.target.value as WidgetRange)
                  }
                  value={range}
                >
                  {INTERVALS.map((interval) => (
                    <option key={interval.key} value={interval.key}>
                      {interval.label}
                    </option>
                  ))}
                </select>
                <ArrowDown01Icon
                  aria-hidden="true"
                  className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/70"
                />
              </span>
              <span className="text-xs leading-5 text-muted-foreground">
                A widget has no viewer whose clock could be asked, so days are
                cut in <span className="font-medium">{zone}</span>
                {reportingZone === null ? (
                  <>
                    {" "}
                    — the site has no reporting timezone yet. Set one right
                    below the widget list so &quot;Today&quot; means your
                    today.
                  </>
                ) : (
                  <>, the site&apos;s reporting timezone.</>
                )}
              </span>
            </label>
          )}

          {isBreakdown ? (
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Rows
              </span>
              <input
                className={inputClass}
                inputMode="numeric"
                onChange={(event) => setLimit(event.target.value)}
                value={limit}
              />
              <span
                className={cn(
                  "text-xs leading-5",
                  limitValid
                    ? "text-muted-foreground"
                    : "text-destructive-foreground"
                )}
              >
                How many rows the embed lists: 1 to 50.
              </span>
            </label>
          ) : null}

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Title
            </span>
            <input
              className={inputClass}
              maxLength={80}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="No heading"
              value={title}
            />
            <span className="text-xs leading-5 text-muted-foreground">
              The only label the embed shows — it never carries your
              site&apos;s name or a link back. Leave it empty for no heading.
            </span>
          </label>

          {def !== null ? (
            <label className="flex items-center justify-between gap-4 rounded-xl bg-[#f6f6f6] px-3 py-2.5">
              <span className="min-w-0">
                <span className="block text-sm">Enabled</span>
                <span className="block text-xs leading-5 text-muted-foreground">
                  {/* The honest bound: max-age=60 (10 on realtime) means a
                      cached copy can outlive the flip by up to a minute. */}
                  Turned off, every embed goes dark within up to 60 seconds.
                  You can turn it back on any time.
                </span>
              </span>
              <Switch
                aria-label="Widget enabled"
                checked={enabled}
                onCheckedChange={setEnabled}
              />
            </label>
          ) : null}

          {def !== null && !rendersAnywhere(origins) ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Where it renders
              </span>
              <p className="rounded-xl bg-[#f6f6f6] px-3 py-2 text-xs leading-5 text-muted-foreground">
                {origins.length === 0
                  ? "This widget carries an empty origin list from before, so browsers render it nowhere."
                  : `This widget carries an origin restriction from before and renders only on: ${origins.join(", ")}.`}{" "}
                New widgets render on any page.
              </p>
              <span>
                <Button
                  onClick={() => setOrigins(["*"])}
                  size="xs"
                  type="button"
                  variant="outline"
                >
                  Render anywhere instead
                </Button>
              </span>
            </div>
          ) : null}

          {def === null ? (
            // The one line that replaces the origin questionnaire: creating
            // a widget is choosing to publish this number, said plainly.
            <p className="rounded-lg bg-[#f6f6f6] px-2.5 py-2 text-xs leading-5 text-muted-foreground">
              This widget renders on any page it is pasted into, and anyone
              with its address can view or embed it. Creating it is choosing
              to publish this number — nothing else about your site comes
              with it.
            </p>
          ) : null}

          {error ? (
            <p className="text-xs text-destructive-foreground">{error}</p>
          ) : null}
        </div>
      ) : step === "confirm-delete" ? (
        <div className="flex flex-col gap-2 p-4">
          <p className="text-sm leading-6">
            Delete {def?.title ? `"${def.title}"` : "this widget"} for good?
          </p>
          <p className="text-sm leading-6 text-muted-foreground">
            Every page carrying its snippet goes blank, and the widget&apos;s
            address is never reissued — there is no way to bring it back. To
            stop it showing while keeping the option to return, turn it off
            instead.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3 p-4">
          {created !== null ? (
            <>
              {LIVE_API ? (
                <LiveEmbed theme={previewTheme} widget={created} />
              ) : (
                <WidgetPreview
                  intervalLabel={
                    created.range === null ? "Live" : rangeLabel(created.range)
                  }
                  limit={created.limit}
                  surface={created.surface}
                  theme={previewTheme}
                  title={created.title}
                />
              )}
              <p className="text-xs leading-5 text-muted-foreground">
                {LIVE_API
                  ? "The live embed, exactly as it will look on your page. A brand-new site can show no data until its first events land."
                  : "Sample numbers, real layout — on your page it shows live data."}
              </p>
            </>
          ) : null}
          <div className="flex items-start justify-between gap-2 overflow-hidden rounded-xl border border-border bg-[#f6f6f6]">
            <pre className="overflow-x-auto px-3 py-2.5 font-mono text-xs leading-5">
              <code>{created?.embed_snippet}</code>
            </pre>
            <span className="p-1">
              <CopyButton
                label="Copy embed snippet"
                text={created?.embed_snippet ?? ""}
              />
            </span>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            Paste it into your page where the numbers should appear. You can
            copy this snippet again any time from the list.
          </p>
        </div>
      )}
    </FlowDialog>
  );
}
