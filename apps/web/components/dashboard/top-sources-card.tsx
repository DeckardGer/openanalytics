"use client";

import {
  ArrowDown01Icon,
  ArrowRight02Icon,
  Globe02Icon,
  Target02Icon,
} from "hugeicons-react";
import { AnimatePresence, motion } from "motion/react";
import * as React from "react";
import { Favicon } from "@/components/dashboard/site-favicon";
import {
  AnalyticsCardBody,
  BreakdownRow,
  useSiteAnalytics,
} from "@/components/dashboard/analytics-card";
import { HoverList } from "@/components/dashboard/hover-list";
import {
  SeeAllModal,
  SeeAllSkeleton,
  useIntervalLabel,
} from "@/components/dashboard/see-all-modal";
import {
  DropdownMenu,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  SquircleCard,
  SquircleCardScroll,
} from "@/components/ui/squircle-card";
import { getAnalyticsSources, type SourceRow } from "@/lib/api";
import { MOCK_SOURCES } from "@/lib/mock";
import { resolveReferrer } from "@/lib/referrers";

/**
 * Acquisition, from `GET /v1/sites/{site_id}/analytics/sources`. The contract
 * row is the full tuple (referrer domain × utm source/medium/campaign); one
 * card shows one *dimension* of it at a time, picked in the header —
 * referrers by default, then the utm cuts. Mixing the dimensions into one
 * list conflated `utm_source=chatgpt.com` with the chatgpt.com referrer,
 * which are different statements about the same visit.
 *
 * Folding sums visitor counts across tuples, so a visitor who arrived under
 * two campaigns of one source counts twice in that row — a small, deliberate
 * over-count; the views ranking underneath is exact.
 */

const SPRING = { type: "spring", stiffness: 550, damping: 38 } as const;

type SourceView = "referrers" | "utm_campaign" | "utm_source" | "utm_medium";

const VIEWS: { id: SourceView; label: string; empty: string }[] = [
  {
    id: "referrers",
    label: "Referrers",
    empty: "No referrers in this range yet.",
  },
  {
    id: "utm_campaign",
    label: "Campaigns",
    empty: "No campaign-tagged visits in this range.",
  },
  {
    id: "utm_source",
    label: "UTM sources",
    empty: "No utm_source-tagged visits in this range.",
  },
  {
    id: "utm_medium",
    label: "UTM medium",
    empty: "No utm_medium-tagged visits in this range.",
  },
];

export type FoldedRow = {
  label: string;
  /** Canonical domain for the favicon — referrers view only. */
  domain: string | null;
  direct: boolean;
  views: number;
  visitors: number;
};

/** The referrer dimension: every row's domain, "" folding into Direct. */
export function foldReferrers(items: SourceRow[]): FoldedRow[] {
  const byLabel = new Map<string, FoldedRow>();
  for (const row of items) {
    const source = row.referrer_domain
      ? resolveReferrer(row.referrer_domain)
      : null;
    const label = source?.name ?? "Direct / none";
    const bucket = byLabel.get(label) ?? {
      label,
      domain: source?.domain ?? null,
      direct: source === null,
      views: 0,
      visitors: 0,
    };
    bucket.views += row.views;
    bucket.visitors += row.visitors;
    byLabel.set(label, bucket);
  }
  return [...byLabel.values()].sort((a, b) => b.views - a.views);
}

/** One utm dimension: tagged rows only — untagged traffic is not "(none)",
 *  it simply is not part of this cut. */
function foldUtm(
  items: SourceRow[],
  key: "utm_source" | "utm_medium" | "utm_campaign"
): FoldedRow[] {
  const byLabel = new Map<string, FoldedRow>();
  for (const row of items) {
    const value = row[key].trim();
    if (value === "") continue;
    const bucket = byLabel.get(value) ?? {
      label: value,
      domain: null,
      direct: false,
      views: 0,
      visitors: 0,
    };
    bucket.views += row.views;
    bucket.visitors += row.visitors;
    byLabel.set(value, bucket);
  }
  return [...byLabel.values()].sort((a, b) => b.views - a.views);
}

/** Favicon for a real referrer, the arrow for Direct, a target for utm. */
export function sourceMark(row: FoldedRow): React.ReactNode {
  if (row.domain !== null) {
    return (
      <Favicon
        key={row.domain}
        domain={row.domain}
        className="size-4 rounded-full border border-border/60 object-cover"
      />
    );
  }
  if (row.direct) {
    return <ArrowRight02Icon className="size-3.5 text-muted-foreground/70" />;
  }
  return <Target02Icon className="size-3.5 text-muted-foreground/70" />;
}

export function TopSourcesCard() {
  const resource = useSiteAnalytics(getAnalyticsSources, MOCK_SOURCES);
  const [view, setView] = React.useState<SourceView>("referrers");
  const [open, setOpen] = React.useState(false);
  const current = VIEWS.find((entry) => entry.id === view) ?? VIEWS[0];

  return (
    <>
    <SquircleCard
      onSeeAll={() => setOpen(true)}
      icon={<Globe02Icon aria-hidden="true" />}
      title={
        <DropdownMenu
          align="start"
          className="w-44"
          trigger={
            <button
              className="flex cursor-pointer items-center gap-1 rounded-lg py-0.5 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              type="button"
            >
              {/* the house label swap — the title glides when the cut changes */}
              <AnimatePresence initial={false} mode="popLayout">
                <motion.span
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ y: -9, opacity: 0, transition: { duration: 0.1 } }}
                  initial={{ y: 9, opacity: 0 }}
                  key={current.id}
                  transition={SPRING}
                >
                  {current.label}
                </motion.span>
              </AnimatePresence>
              <ArrowDown01Icon
                aria-hidden="true"
                className="!size-3.5 text-muted-foreground/70"
              />
            </button>
          }
        >
          {VIEWS.map((entry) => (
            <DropdownMenuItem key={entry.id} onClick={() => setView(entry.id)}>
              {entry.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenu>
      }
    >
      <AnalyticsCardBody
        emptyBody="No referrers in this range yet."
        isEmpty={(data) => data.items.length === 0}
        resource={resource}
      >
        {(data) => {
          const rows =
            view === "referrers"
              ? foldReferrers(data.items)
              : foldUtm(data.items, view);
          const max = Math.max(...rows.map((row) => row.visitors), 1);
          return (
            <AnimatePresence initial={false} mode="wait">
              <motion.div
                animate={{ opacity: 1, y: 0 }}
                className="h-full"
                exit={{ opacity: 0, y: -6, transition: { duration: 0.1 } }}
                initial={{ opacity: 0, y: 8 }}
                key={view}
                transition={SPRING}
              >
                {rows.length === 0 ? (
                  <p className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
                    {current.empty}
                  </p>
                ) : (
                  <SquircleCardScroll>
                    <HoverList>
                      {rows.map((row) => (
                        <BreakdownRow
                          icon={sourceMark(row)}
                          key={row.label}
                          name={row.label}
                          pct={Math.round((row.visitors / max) * 100)}
                          value={row.visitors.toLocaleString("en-US")}
                        />
                      ))}
                    </HoverList>
                  </SquircleCardScroll>
                )}
              </motion.div>
            </AnimatePresence>
          );
        }}
      </AnalyticsCardBody>
    </SquircleCard>

    <AnimatePresence>
      {open && (
        <SourcesModal
          items={resource.status === "ready" ? resource.data.items : null}
          view={view}
          onClose={() => setOpen(false)}
        />
      )}
    </AnimatePresence>
    </>
  );
}

/** The whole ranking of the cut the card is on, in the vertical shell. */
function SourcesModal({
  items,
  view,
  onClose,
}: {
  items: SourceRow[] | null;
  view: SourceView;
  onClose: () => void;
}) {
  const intervalLabel = useIntervalLabel();
  const current = VIEWS.find((entry) => entry.id === view) ?? VIEWS[0];
  const rows =
    items === null
      ? null
      : view === "referrers"
        ? foldReferrers(items)
        : foldUtm(items, view);
  const max =
    rows === null ? 1 : Math.max(...rows.map((row) => row.visitors), 1);

  return (
    <SeeAllModal
      title={current.label}
      subtitle={`Where every visit came from · ${intervalLabel}`}
      onClose={onClose}
    >
      {rows === null ? (
        <SeeAllSkeleton />
      ) : rows.length === 0 ? (
        <p className="px-6 py-14 text-center text-sm text-muted-foreground">
          {current.empty}
        </p>
      ) : (
        // the shared white glide, rounded for the grey band
        <HoverList className="[&>li>span]:rounded-[10px]">
          {rows.map((row) => (
            <BreakdownRow
              icon={sourceMark(row)}
              key={row.label}
              name={row.label}
              pct={Math.round((row.visitors / max) * 100)}
              value={row.visitors.toLocaleString("en-US")}
            />
          ))}
        </HoverList>
      )}
    </SeeAllModal>
  );
}
