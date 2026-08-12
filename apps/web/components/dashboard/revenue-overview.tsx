"use client";

import * as React from "react";
import { Area, AreaChart } from "@/components/charts/area-chart";
import { Background } from "@/components/charts/background";
import { useAnalyticsInterval } from "@/components/dashboard/interval-context";
import { SquircleSurface } from "@/components/ui/squircle-card";
import {
  revenue,
  type RevenueSummaryResponse,
  type RevenueTimeseriesResponse,
  type RevenueTotals,
} from "@/lib/api";
import { formatMoney } from "@/lib/currencies";
import { cn } from "@/lib/utils";

/**
 * The money, before the list of it (frontend_tasks §23).
 *
 * The page reads top to bottom as an argument: what you took, how it moved
 * over the range, and then every line behind those two. A transaction list on
 * its own is a ledger — true, and no help in answering "was this month good".
 *
 * **The header shows the identity, not just net.** `net = gross − refunds −
 * disputes withheld + disputes reinstated − fees`, and each part is printed
 * because net alone hides the shape of a month: a flat figure is quiet trading
 * or heavy refunds, and only the parts say which.
 *
 * **The chart plots gross and net together on purpose.** The gap between the
 * two lines *is* refunds, disputes and fees — the one visual that makes the
 * cost of doing business legible without a second chart.
 */

type Point = { date: Date; gross: number; net: number; incomplete: boolean };

/** The house money colours: brand blue for what you kept, grey for gross. */
const NET = "#296FF0";
const GROSS = "#94a3b8";

export function RevenueOverview({ siteId }: { siteId: string }) {
  const { range, rangePending } = useAnalyticsInterval();
  const [summary, setSummary] = React.useState<RevenueSummaryResponse | null>(
    null
  );
  const [series, setSeries] = React.useState<RevenueTimeseriesResponse | null>(
    null
  );

  React.useEffect(() => {
    let cancelled = false;
    // All-time's anchor is still on its way — hold, don't double-fetch.
    if (rangePending) return;
    Promise.all([
      // `compare` is what fills the delta beside the headline. The revenue
      // grain picker is hour/day only — never the traffic chart's — so the
      // resolution is left to the server rather than borrowed from it.
      revenue.summary(siteId, range, { compare: true }),
      revenue.timeseries(siteId, range),
    ]).then(
      ([summaryResponse, seriesResponse]) => {
        if (cancelled) return;
        setSummary(summaryResponse);
        setSeries(seriesResponse);
      },
      () => {
        /* The list below reports the failure; two panels shouting is noise. */
      }
    );
    return () => {
      cancelled = true;
    };
  }, [siteId, range, rangePending]);

  const points: Point[] = React.useMemo(
    () =>
      (series?.series ?? []).map((bucket) => ({
        date: new Date(bucket.bucket),
        gross: bucket.charge_gross_minor,
        // A bucket holding an unconverted transaction is an understatement by
        // a knowable amount. It is marked rather than quietly plotted low.
        incomplete: bucket.unconverted_count > 0,
        net: bucket.net_minor,
      })),
    [series]
  );

  const totals = summary?.totals ?? null;
  const previous = summary?.comparison?.totals ?? null;
  const incompleteBuckets = points.filter((point) => point.incomplete).length;

  return (
    <div className="flex flex-col gap-6">
      <SquircleSurface
        className="flex flex-col border border-border p-1 shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
        render={<section />}
      >
        <SquircleSurface className="overflow-hidden rounded-[22px] border border-border bg-[#f6f6f6] shadow-[0_1px_2px_rgba(0,0,0,0.06)] [--card-clip-radius:12px] sm:rounded-[44px] sm:[--card-clip-radius:17px]">
          <div className="flex flex-col gap-5 px-5 py-4 sm:px-7 sm:py-5">
            <Headline previous={previous} totals={totals} />
            {totals ? <IdentityRow totals={totals} /> : null}
          </div>

          {points.length > 0 ? (
            <div className="px-1 pb-1">
              <AreaChart
                animationDuration={0}
                aspectRatio="auto"
                className="h-56 sm:h-64"
                data={points}
                margin={{ bottom: 24, left: 0, right: 0, top: 12 }}
                status="ready"
                xLabelFormat={(date) =>
                  date.toLocaleDateString("en-US", {
                    day: "numeric",
                    month: "short",
                  })
                }
              >
                <Background opacity={0.4} pattern="dots" />
                {/* Gross first so net draws over it — the filled gap between
                    them is what the eye should land on. */}
                <Area
                  dataKey="gross"
                  fadeEdges
                  fill={GROSS}
                  fillOpacity={0.08}
                  strokeOpacity={0.45}
                  strokeWidth={1.5}
                />
                <Area
                  dataKey="net"
                  fadeEdges
                  fill={NET}
                  fillOpacity={0.14}
                  strokeOpacity={0.4}
                  strokeWidth={2}
                />
              </AreaChart>
            </div>
          ) : null}
        </SquircleSurface>
      </SquircleSurface>

      {/* Never silent, and never a loss: an understatement by a knowable
          amount, printed with the amount. */}
      {totals && totals.unconverted_count > 0 && summary ? (
        <p className="-mt-3 px-1 text-xs leading-5 text-muted-foreground">
          Plus{" "}
          {summary.unconverted
            .map((entry) =>
              formatMoney(entry.charge_gross_minor, entry.currency)
            )
            .join(", ")}{" "}
          across {totals.unconverted_count} transactions we could not convert to{" "}
          {totals.currency}
          {incompleteBuckets > 0
            ? `; ${incompleteBuckets} ${incompleteBuckets === 1 ? "day is" : "days are"} understated in the chart above.`
            : "."}
        </p>
      ) : null}
    </div>
  );
}

function Headline({
  totals,
  previous,
}: {
  totals: RevenueTotals | null;
  previous: RevenueTotals | null;
}) {
  if (!totals) {
    return (
      <div className="flex flex-col gap-2">
        <span className="h-8 w-40 animate-pulse rounded-md bg-black/6" />
        <span className="h-3 w-28 animate-pulse rounded-md bg-black/6" />
      </div>
    );
  }

  // A percentage against a zero base is not a number, so the delta simply does
  // not render rather than printing an infinity or a misleading 100%.
  const delta =
    previous && previous.net_minor !== 0
      ? (totals.net_minor - previous.net_minor) / Math.abs(previous.net_minor)
      : null;

  const average =
    totals.charge_count > 0
      ? formatMoney(
          Math.round(totals.charge_gross_minor / totals.charge_count),
          totals.currency
        )
      : null;

  return (
    <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
      <div>
        <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
          Net revenue
        </p>
        <p className="mt-1.5 flex items-baseline gap-2.5">
          <span className="text-3xl font-medium tabular-nums tracking-tight sm:text-4xl">
            {formatMoney(totals.net_minor, totals.currency)}
          </span>
          {delta !== null ? (
            <span
              className={cn(
                "text-sm font-medium tabular-nums",
                delta >= 0 ? "text-success-foreground" : "text-destructive-foreground"
              )}
            >
              {delta >= 0 ? "+" : "−"}
              {Math.abs(Math.round(delta * 100))}%
            </span>
          ) : null}
        </p>
        {previous ? (
          <p className="mt-1 text-xs text-muted-foreground">
            versus {formatMoney(previous.net_minor, previous.currency)} the
            period before
          </p>
        ) : null}
      </div>

      <dl className="flex items-end gap-8">
        <div>
          <dt className="text-xs text-muted-foreground">Payments</dt>
          <dd className="mt-1 text-lg font-medium tabular-nums tracking-tight">
            {totals.charge_count}
          </dd>
        </div>
        {average ? (
          <div>
            <dt className="text-xs text-muted-foreground">Average</dt>
            <dd className="mt-1 text-lg font-medium tabular-nums tracking-tight">
              {average}
            </dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

/**
 * The identity, as a row of parts.
 *
 * Two traps live here and both are handled by what is *not* subtracted: a
 * refunded charge keeps its full gross (the refund carries the negative in its
 * own column, so deducting on both sides would remove the money twice), and a
 * dispute the site won appears in both dispute columns — so the figure shown
 * is the difference, and a fully-won month reads as nothing held rather than
 * as a loss.
 */
function IdentityRow({ totals }: { totals: RevenueTotals }) {
  const money = (minor: number) => formatMoney(minor, totals.currency);
  const heldDisputes =
    totals.dispute_withdrawn_minor - totals.dispute_reinstated_minor;

  const parts: Array<{ label: string; value: string; muted?: boolean }> = [
    { label: "Gross", value: money(totals.charge_gross_minor) },
    {
      label: `Refunds · ${totals.refund_count}`,
      muted: true,
      value: `−${money(totals.refund_minor)}`,
    },
  ];
  if (totals.dispute_count > 0) {
    parts.push({
      label:
        heldDisputes === 0
          ? `Disputes · ${totals.dispute_count} raised, none held`
          : `Disputes · ${totals.dispute_count}`,
      muted: true,
      value: heldDisputes === 0 ? money(0) : `−${money(heldDisputes)}`,
    });
  }
  parts.push({ label: "Fees", muted: true, value: `−${money(totals.fee_minor)}` });

  return (
    <dl className="flex flex-wrap items-baseline gap-x-7 gap-y-2 border-t border-border pt-4">
      {parts.map((part) => (
        <div className="flex items-baseline gap-2" key={part.label}>
          <dt className="text-xs text-muted-foreground">{part.label}</dt>
          <dd
            className={cn(
              "text-sm tabular-nums",
              part.muted ? "text-foreground/80" : "font-medium"
            )}
          >
            {part.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
