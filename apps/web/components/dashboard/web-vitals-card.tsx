"use client";

import { WEB_VITAL_METRICS } from "@openanalytics/contracts";
import { Pulse01Icon } from "hugeicons-react";
import { AnimatePresence } from "motion/react";
import * as React from "react";
import {
  AnalyticsCardBody,
  useSiteAnalytics,
} from "@/components/dashboard/analytics-card";
import { HoverList, HoverRow } from "@/components/dashboard/hover-list";
import {
  SeeAllModal,
  SeeAllSkeleton,
  useIntervalLabel,
} from "@/components/dashboard/see-all-modal";
import {
  SquircleCard,
  SquircleCardScroll,
} from "@/components/ui/squircle-card";
import { getAnalyticsPerformance, type PerformanceRow } from "@/lib/api";
import { MOCK_PERFORMANCE } from "@/lib/mock";

/**
 * Web vitals, from `GET /v1/sites/{site_id}/analytics/performance`. The
 * contract row is metric × device type, and it stays that granular here:
 * percentiles cannot be merged across device types client-side (a p75 of
 * two p75s is not a p75), so each row shows its own p75 plus the share of
 * samples Google's thresholds rate as good — both taken straight from the
 * merged t-digest, nothing recomputed.
 *
 * Brings its own SquircleCard: "See all" opens the vertical modal with the
 * full percentile spread per row, so the header needs a click handler.
 */

const METRIC_ORDER = new Map(
  WEB_VITAL_METRICS.map((metric, index) => [metric as string, index])
);
const DEVICE_ORDER = new Map([
  ["desktop", 0],
  ["mobile", 1],
  ["tablet", 2],
  ["unknown", 3],
]);

function sortRows(items: PerformanceRow[]): PerformanceRow[] {
  return [...items].sort((a, b) => {
    const metric =
      (METRIC_ORDER.get(a.metric) ?? 99) - (METRIC_ORDER.get(b.metric) ?? 99);
    if (metric !== 0) return metric;
    return (
      (DEVICE_ORDER.get(a.device_type) ?? 9) -
      (DEVICE_ORDER.get(b.device_type) ?? 9)
    );
  });
}

/** CLS is unitless; everything else arrives in milliseconds. */
function formatValue(metric: string, value: number): string {
  if (metric === "CLS") return value.toFixed(2);
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
  return `${Math.round(value)}ms`;
}

function goodShare(row: PerformanceRow): number {
  return row.samples > 0 ? row.good_samples / row.samples : 0;
}

export function WebVitalsCard() {
  const resource = useSiteAnalytics(getAnalyticsPerformance, MOCK_PERFORMANCE);
  const [open, setOpen] = React.useState(false);

  return (
    <>
    <SquircleCard
      title="Web vitals"
      icon={<Pulse01Icon aria-hidden="true" />}
      onSeeAll={() => setOpen(true)}
    >
    <AnalyticsCardBody
      emptyBody="No web-vital samples in this range yet. The tracker reports them automatically."
      isEmpty={(data) => data.items.length === 0}
      resource={resource}
    >
      {(data) => (
        <SquircleCardScroll>
          <HoverList>
            {sortRows(data.items).map((row) => {
              const share = Math.round(goodShare(row) * 100);
              return (
                <HoverRow key={`${row.metric}-${row.device_type}`}>
                  <div className="flex items-center justify-between gap-4 px-5 py-1.5">
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {row.metric}
                      <span className="text-muted-foreground/70">
                        {" · "}
                        {row.device_type}
                      </span>
                    </span>
                    <span
                      className="text-sm tabular-nums text-muted-foreground"
                      title="75th percentile"
                    >
                      {formatValue(row.metric, row.p75)}
                    </span>
                    <span
                      className={
                        "w-20 text-right text-xs tabular-nums " +
                        (share >= 75
                          ? "text-success-foreground"
                          : "text-amber-600")
                      }
                      title={`${row.good_samples.toLocaleString("en-US")} of ${row.samples.toLocaleString("en-US")} samples rated good`}
                    >
                      {share}% good
                    </span>
                  </div>
                </HoverRow>
              );
            })}
          </HoverList>
        </SquircleCardScroll>
      )}
    </AnalyticsCardBody>
    </SquircleCard>

    <AnimatePresence>
      {open && (
        <WebVitalsModal
          items={resource.status === "ready" ? resource.data.items : null}
          onClose={() => setOpen(false)}
        />
      )}
    </AnimatePresence>
    </>
  );
}

/**
 * Every metric × device row with its wider spread: p50 through p99 beside
 * the headline p75, and the sample count the judgement rests on.
 */
function WebVitalsModal({
  items,
  onClose,
}: {
  items: PerformanceRow[] | null;
  onClose: () => void;
}) {
  const intervalLabel = useIntervalLabel();
  return (
    <SeeAllModal
      title="Web vitals"
      subtitle={`Field performance, per metric and device · ${intervalLabel}`}
      onClose={onClose}
    >
      {items === null ? (
        <SeeAllSkeleton />
      ) : (
        <div className="flex flex-col gap-1">
          {sortRows(items).map((row) => {
            const share = Math.round(goodShare(row) * 100);
            return (
              <div
                className="rounded-[10px] px-3 py-2 transition-colors hover:bg-white/70"
                key={`${row.metric}-${row.device_type}`}
              >
                <div className="flex items-baseline justify-between gap-4">
                  <span className="min-w-0 truncate text-sm font-medium">
                    {row.metric}
                    <span className="font-normal text-muted-foreground/70">
                      {" · "}
                      {row.device_type}
                    </span>
                  </span>
                  <span
                    className={
                      "text-xs tabular-nums " +
                      (share >= 75
                        ? "text-success-foreground"
                        : "text-amber-600")
                    }
                  >
                    {share}% good
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                  {(
                    [
                      ["p50", row.p50],
                      ["p75", row.p75],
                      ["p90", row.p90],
                      ["p95", row.p95],
                      ["p99", row.p99],
                    ] as const
                  ).map(([label, value]) => (
                    <span key={label}>
                      {label}{" "}
                      <span
                        className={
                          "tabular-nums " +
                          (label === "p75"
                            ? "font-medium text-foreground"
                            : "text-foreground/70")
                        }
                      >
                        {formatValue(row.metric, value)}
                      </span>
                    </span>
                  ))}
                  <span>
                    samples{" "}
                    <span className="tabular-nums text-foreground/70">
                      {row.samples.toLocaleString("en-US")}
                    </span>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SeeAllModal>
  );
}
