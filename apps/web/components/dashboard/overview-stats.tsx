"use client";

import { InformationCircleIcon } from "hugeicons-react";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useParams } from "next/navigation";
import * as React from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { SkeletonReveal } from "@/components/ui/skeleton-reveal";
import { ApiErrorPanel } from "@/components/dashboard/api-error";
import {
  dataStateOf,
  DataStatePanel,
  ProvenanceChips,
} from "@/components/dashboard/data-state";
import { useAnalyticsInterval } from "@/components/dashboard/interval-context";
import { SquircleSurface } from "@/components/ui/squircle-card";
import { useApiResource } from "@/hooks/use-api-resource";
import { useSiteAnalytics } from "@/components/dashboard/analytics-card";
import {
  getAnalyticsOverview,
  getAnalyticsSessions,
  LIVE_API,
  resolveSiteSlugCached,
  revenue,
  type AnalyticsOverviewResponse,
  type AnalyticsSessionsResponse,
} from "@/lib/api";
import { formatMoney } from "@/lib/currencies";
import {
  MOCK_OVERVIEW,
  MOCK_REVENUE_SUMMARY,
  MOCK_SESSIONS,
} from "@/lib/mock";

/**
 * The overview stat row — `GET .../analytics/overview` for the counts, and
 * `GET .../analytics/sessions` for bounce rate and average visit duration.
 *
 * The `[site]` route segment is the public **slug**; it is resolved to the
 * internal `site_id` with `GET /v1/sites/resolve?slug=` rather than by matching
 * against `GET /v1/sites`. That endpoint exists for exactly this, it is one
 * request instead of pulling the whole list, it works on a deep link where no
 * list has been fetched, and a slug the caller cannot see comes back as
 * `404 SITE_NOT_FOUND` — which is the honest answer, and the same one a
 * non-member gets.
 *
 * The session numbers ride their own request on purpose: they carry the
 * `layering` block — everything after `layering.finalized_through` can still
 * change (an open session finalizes later), so those two cards say "still
 * settling" while the tail is provisional — and a failed sessions read must
 * not take the four counts down with it: the row degrades to four cards.
 */

/** `display: null` means the number's read is still in flight. */
export type Stat = { label: string; display: string | null; info: string };

/** "1m 42s" — an average duration in words a human reads at a glance. */
export function durationLabel(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function OverviewStats() {
  const params = useParams<{ site: string }>();
  const slug = params.site ? decodeURIComponent(params.site) : "";
  const { range, rangePending } = useAnalyticsInterval();

  const load = React.useCallback(
    async (signal: AbortSignal): Promise<AnalyticsOverviewResponse> => {
      if (!LIVE_API) return MOCK_OVERVIEW;
      // All-time's anchor is still on its way — hold, don't double-fetch.
      if (rangePending) {
        return new Promise<AnalyticsOverviewResponse>(() => {});
      }
      const { site_id } = await resolveSiteSlugCached(slug);
      return getAnalyticsOverview(site_id, range, { signal });
    },
    [slug, range, rangePending]
  );

  const overview = useApiResource(load);

  const loadSessions = React.useCallback(
    async (signal: AbortSignal): Promise<AnalyticsSessionsResponse> => {
      if (!LIVE_API) return MOCK_SESSIONS;
      if (rangePending) {
        return new Promise<AnalyticsSessionsResponse>(() => {});
      }
      const { site_id } = await resolveSiteSlugCached(slug);
      return getAnalyticsSessions(site_id, range, { signal });
    },
    [slug, range, rangePending]
  );

  const sessions = useApiResource(loadSessions);

  if (LIVE_API && overview.status === "error") {
    return (
      <SquircleSurface className="border border-border shadow-[0_1px_2px_rgba(0,0,0,0.06)]">
        <ApiErrorPanel error={overview.error} onRetry={overview.retry} />
      </SquircleSurface>
    );
  }

  const data = !LIVE_API
    ? MOCK_OVERVIEW
    : overview.status === "ready"
      ? overview.data
      : null;

  // The cardinal rule cuts one way only: a pipeline that is behind or
  // unverifiable must never be mistaken for a site with no traffic — that
  // case keeps the warning panel. A *true* empty (fresh pipeline, nothing
  // recorded) is honest zeros on the normal cards.
  if (data) {
    const isEmpty = data.totals.events === 0;
    const state = dataStateOf(data.meta, isEmpty);
    if ((state.kind === "stale" || state.kind === "degraded") && isEmpty) {
      return (
        <SquircleSurface className="border border-border shadow-[0_1px_2px_rgba(0,0,0,0.06)]">
          <DataStatePanel
            className="py-14"
            emptyBody="Nothing has been rolled up for this range yet. Install the snippet, or widen the range."
            state={state}
          />
        </SquircleSurface>
      );
    }
  }

  // Session numbers ride their own read; `null` display = still in flight.
  const sessionData = !LIVE_API
    ? MOCK_SESSIONS
    : sessions.status === "ready"
      ? sessions.data
      : null;
  // An error is settled: those two cards show an honest em-dash rather than
  // pulsing forever, and the four counts stay up.
  const sessionsSettled = !LIVE_API || sessions.status !== "loading";

  // The frames and their labels never wait: all five cards are knowable
  // before any request answers, so the chrome is static and only the numbers
  // come into focus — each when its own read lands. The row's height is
  // constant either way, so the chart underneath never moves by a pixel.
  const stats: Stat[] = [
    {
      label: "Visitors",
      display: data ? data.totals.visitors.toLocaleString("en-US") : null,
      info: "Unique people in this range. A visitor is counted once, no matter how many pages they open.",
    },
    {
      label: "Pageviews",
      display: data ? data.totals.pageviews.toLocaleString("en-US") : null,
      info: "Every page load. One visitor browsing five pages counts five times.",
    },
    {
      label: "Bounce rate",
      display: sessionData
        ? `${Math.round(sessionData.totals.bounce_rate * 100)}%`
        : sessionsSettled
          ? "—"
          : null,
      info: BOUNCE_INFO,
    },
    {
      label: "Avg. visit",
      display: sessionData
        ? durationLabel(sessionData.totals.avg_session_duration_ms)
        : sessionsSettled
          ? "—"
          : null,
      info: AVG_VISIT_INFO,
    },
  ];

  return (
    <div className="flex flex-col gap-2">
      <StatGrid>
        {stats.map((stat) => (
          <StatCard key={stat.label} stat={stat} />
        ))}
        <RevenueCard slug={slug} />
      </StatGrid>
      {/* Where these five numbers came from, per response. The overview is
          the first thing read on the screen, so an imported range says so
          here rather than only on the cards below. */}
      {data ? <ProvenanceChips className="self-end" meta={data.meta} /> : null}
    </div>
  );
}

/**
 * Revenue on the stat row: one figure, or the door to connecting a provider.
 *
 * It reads the same `revenue/summary` the overview panel does — one request
 * serves both, because the browser dedupes an identical in-flight GET — and
 * it takes the same rule the panel takes: a provider that is not connected
 * gets a link, never a `0`. Anything richer than the net figure (the identity
 * parts, the unconverted remainder, the degraded warning) lives on the panel,
 * which has the room for it.
 *
 * No owner gate here: this row is rendered by `OverviewStats`, which an admin
 * sees, and the summary read would 403 for them. A 403 lands in `error` and
 * the card falls back to the connect door, which is the honest thing to show
 * someone who cannot read the number — the alternative is an error tile in
 * the middle of a working dashboard.
 */
function RevenueCard({ slug }: { slug: string }) {
  const summary = useSiteAnalytics(revenue.summary, MOCK_REVENUE_SUMMARY);
  // Settled covers error too: a 403 (admin, `revenue:read` is owner-only)
  // resolves to the connect door, not to a pulse that never ends.
  const settled = summary.status !== "loading";
  const totals = summary.status === "ready" ? summary.data.totals : null;
  const status =
    summary.status === "ready"
      ? (summary.data.meta.revenue?.connection_status ?? "not_connected")
      : null;
  const connected = totals !== null && status !== "not_connected";
  return (
    <SquircleSurface className="flex flex-col rounded-[24px] border border-border p-1 shadow-[0_1px_2px_rgba(0,0,0,0.06)] [--card-clip-radius:13px] sm:rounded-[30px] sm:[--card-clip-handle:2.5px] sm:[--card-clip-radius:17px]">
      <p className="flex items-center gap-1.5 pb-1.5 pl-3.5 pr-3 pt-1">
        <span className="text-sm font-medium text-foreground/80">Revenue</span>
        <InfoTip text="Money attributed to visits, straight from your payment provider." />
      </p>
      <SquircleSurface className="flex-1 rounded-[20px] border border-border bg-[#f6f6f6] px-4 py-3 shadow-[0_1px_2px_rgba(0,0,0,0.06)] [--card-clip-radius:11px] sm:rounded-[26px] sm:[--card-clip-handle:2.5px] sm:[--card-clip-radius:14px]">
        <SkeletonReveal
          ready={settled}
          skeleton={
            <p className="flex h-7 items-center sm:h-8">
              <span className="h-5 w-16 rounded bg-muted-foreground/15 sm:h-6" />
            </p>
          }
        >
          {!settled ? null : connected && totals ? (
            <p className="text-xl font-medium tabular-nums tracking-tight sm:text-2xl">
              {formatMoney(totals.net_minor, totals.currency)}
            </p>
          ) : (
            <Button
              render={
                <Link
                  href={`/dashboard/${encodeURIComponent(slug)}/settings?tab=integrations`}
                >
                  Connect
                </Link>
              }
              size="xs"
              variant="link"
            />
          )}
        </SkeletonReveal>
      </SquircleSurface>
    </SquircleSurface>
  );
}

export const BOUNCE_INFO =
  "The share of visits that left after a single page. Lower usually means the page delivered.";
export const AVG_VISIT_INFO =
  "How long a visit lasts on average, from first page to last activity.";

function StatGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">{children}</div>
  );
}

const emptySubscribe = () => () => {};

/**
 * The little ⓘ beside a card's title: hover (or keyboard focus) pops a short
 * plain-words explanation in the house tooltip language — the dark pill the
 * tab bar uses. Portalled to <body> and opened *upward*: rendered in place
 * it would be trapped inside the card's squircle clip.
 */
function InfoTip({ text }: { text: string }) {
  const mounted = React.useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );
  const iconRef = React.useRef<HTMLSpanElement>(null);
  const [anchor, setAnchor] = React.useState<{ x: number; y: number } | null>(
    null
  );
  const open = () => {
    const rect = iconRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ x: rect.left + rect.width / 2, y: rect.top - 8 });
  };
  const close = () => setAnchor(null);

  return (
    <span
      ref={iconRef}
      className="inline-flex"
      onBlur={close}
      onFocus={open}
      onMouseEnter={open}
      onMouseLeave={close}
      tabIndex={0}
    >
      <InformationCircleIcon
        aria-hidden="true"
        className="size-3.5 text-muted-foreground/50 transition-colors hover:text-muted-foreground"
      />
      <span className="sr-only">{text}</span>
      {mounted
        ? createPortal(
            <AnimatePresence>
              {anchor ? (
                <span
                  className="pointer-events-none fixed z-[70]"
                  style={{
                    left: anchor.x,
                    top: anchor.y,
                    transform: "translate(-50%, -100%)",
                  }}
                >
                  <motion.span
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    className="block w-52 rounded-[12px] bg-[#1c1c1f] px-3 py-2 text-[12px] font-normal leading-4.5 text-white shadow-[0_1px_1px_rgba(0,0,0,0.3),0_8px_24px_rgba(0,0,0,0.35)] ring-1 ring-white/10"
                    exit={{
                      opacity: 0,
                      y: 4,
                      scale: 0.95,
                      transition: { duration: 0.1 },
                    }}
                    initial={{ opacity: 0, y: 6, scale: 0.9 }}
                    role="tooltip"
                    transition={{ type: "spring", stiffness: 550, damping: 40 }}
                  >
                    {text}
                  </motion.span>
                </span>
              ) : null}
            </AnimatePresence>,
            document.body
          )
        : null}
    </span>
  );
}

/**
 * Same anatomy as the mini cards: label in the frame's top strip, value on the
 * inset panel. With no `compare=true` there is no previous period, so the
 * delta chip the mock carried has no honest value to show and is gone.
 *
 * The frame and the label are chrome — real from the first frame, like a
 * settings panel's title. Only the number waits on the network, so only the
 * number gets a stand-in and the blur: the card never reads as a new card
 * arriving, just as its figure coming into focus.
 *
 * Exported for the public share board, which renders the same cards over the
 * public overview read — one anatomy, two audiences.
 */
export function StatCard({ stat }: { stat: Stat }) {
  return (
    <SquircleSurface className="flex flex-col rounded-[24px] border border-border p-1 shadow-[0_1px_2px_rgba(0,0,0,0.06)] [--card-clip-radius:13px] sm:rounded-[30px] sm:[--card-clip-handle:2.5px] sm:[--card-clip-radius:17px]">
      <p className="flex items-center gap-1.5 pb-1.5 pl-3.5 pr-3 pt-1">
        <span className="text-sm font-medium text-foreground/80">
          {stat.label}
        </span>
        <InfoTip text={stat.info} />
      </p>
      <SquircleSurface className="flex-1 rounded-[20px] border border-border bg-[#f6f6f6] px-4 py-3 shadow-[0_1px_2px_rgba(0,0,0,0.06)] [--card-clip-radius:11px] sm:rounded-[26px] sm:[--card-clip-handle:2.5px] sm:[--card-clip-radius:14px]">
        <SkeletonReveal
          ready={stat.display !== null}
          skeleton={
            // Exactly the number line's height (text-xl 28px / sm:text-2xl
            // 32px): a taller skeleton loads the chart a few px low, then
            // snaps it up when the real number lands.
            <p className="flex h-7 items-center sm:h-8">
              <span className="h-5 w-16 rounded bg-muted-foreground/15 sm:h-6" />
            </p>
          }
        >
          {stat.display === null ? null : (
            <p className="text-xl font-medium tabular-nums tracking-tight sm:text-2xl">
              {stat.display}
            </p>
          )}
        </SkeletonReveal>
      </SquircleSurface>
    </SquircleSurface>
  );
}
