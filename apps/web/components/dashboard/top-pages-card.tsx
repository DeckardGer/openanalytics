"use client";

import { File01Icon } from "hugeicons-react";
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
import { getAnalyticsPages, type PageRow } from "@/lib/api";
import { MOCK_PAGES } from "@/lib/mock";

/**
 * Top pages, from `GET /v1/sites/{site_id}/analytics/pages`. Rows arrive
 * ranked by views; the number shown is unique visitors per path, which is
 * exact — the rollup carries a visitor sketch per path.
 *
 * Brings its own SquircleCard: "See all" opens the vertical modal with the
 * whole ranking, so the header needs a click handler, not a href.
 */
export function TopPagesCard() {
  const resource = useSiteAnalytics(getAnalyticsPages, MOCK_PAGES);
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <SquircleCard
        title="Top pages"
        icon={<File01Icon aria-hidden="true" />}
        onSeeAll={() => setOpen(true)}
      >
        <AnalyticsCardBody
          emptyBody="No pageviews in this range yet."
          isEmpty={(data) => data.items.length === 0}
          resource={resource}
        >
          {(data) => (
            <SquircleCardScroll>
              <HoverList>
                {data.items.map((page) => (
                  <HoverRow key={page.page_path}>
                    <div className="flex items-center justify-between gap-4 px-5 py-1.5">
                      <span
                        aria-hidden="true"
                        className="size-2 shrink-0 rounded-full bg-primary/50 transition-colors group-hover:bg-primary"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">
                          {page.page_path}
                        </span>
                      </span>
                      <span className="text-sm tabular-nums text-muted-foreground">
                        {page.visitors.toLocaleString("en-US")}
                      </span>
                    </div>
                  </HoverRow>
                ))}
              </HoverList>
            </SquircleCardScroll>
          )}
        </AnalyticsCardBody>
      </SquircleCard>

      <AnimatePresence>
        {open && (
          <TopPagesModal
            pages={resource.status === "ready" ? resource.data.items : null}
            onClose={() => setOpen(false)}
          />
        )}
      </AnimatePresence>
    </>
  );
}

function TopPagesModal({
  pages,
  onClose,
}: {
  pages: PageRow[] | null;
  onClose: () => void;
}) {
  const intervalLabel = useIntervalLabel();
  return (
    <SeeAllModal
      title="Top pages"
      subtitle={`Every page your visitors opened · ${intervalLabel}`}
      onClose={onClose}
    >
      {pages === null ? (
        <SeeAllSkeleton />
      ) : (
        <div>
          <div className="flex items-center justify-between gap-4 px-3 pb-1.5">
            <span className="text-xs font-medium text-muted-foreground/70">
              Page
            </span>
            <span className="flex items-baseline gap-2">
              <span className="w-14 text-right text-xs font-medium text-muted-foreground/70">
                Views
              </span>
              <span className="w-14 text-right text-xs font-medium text-muted-foreground/70">
                Visitors
              </span>
            </span>
          </div>
          {/* the shared white glide, rounded for the grey band */}
          <HoverList className="[&>li>span]:rounded-[10px]">
            {pages.map((page) => (
              <HoverRow key={page.page_path}>
                <div className="flex items-center justify-between gap-4 px-3 py-2">
                  <span
                    aria-hidden="true"
                    className="size-2 shrink-0 rounded-full bg-primary/50 transition-colors group-hover:bg-primary"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">
                      {page.page_path}
                    </span>
                  </span>
                  <span className="flex items-baseline gap-2">
                    <span className="w-14 text-right text-sm tabular-nums text-muted-foreground">
                      {page.views.toLocaleString("en-US")}
                    </span>
                    <span className="w-14 text-right text-sm tabular-nums text-muted-foreground/70">
                      {page.visitors.toLocaleString("en-US")}
                    </span>
                  </span>
                </div>
              </HoverRow>
            ))}
          </HoverList>
        </div>
      )}
    </SeeAllModal>
  );
}
