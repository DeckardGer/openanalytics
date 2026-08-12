import { Activity01Icon } from "hugeicons-react";
import { CustomEventsCard } from "@/components/dashboard/custom-events-card";
import { DeviceCards } from "@/components/dashboard/device-cards";
import { IntervalProvider } from "@/components/dashboard/interval-context";
import { IntervalSelect } from "@/components/dashboard/interval-select";
import { LocationsCard } from "@/components/dashboard/locations-card";
import { OverviewChart } from "@/components/dashboard/overview-chart";
import { OverviewStats } from "@/components/dashboard/overview-stats";
import { RealtimeCard } from "@/components/dashboard/realtime-card";
import { RevenueCard } from "@/components/dashboard/revenue-card";
import { TopPagesCard } from "@/components/dashboard/top-pages-card";
import { TopSourcesCard } from "@/components/dashboard/top-sources-card";
import { WebVitalsCard } from "@/components/dashboard/web-vitals-card";
import {
  SquircleCard,
  SquircleSurface,
} from "@/components/ui/squircle-card";

export default async function OverviewPage({
  params,
}: {
  params: Promise<{ site: string }>;
}) {
  const { site } = await params;
  return (
    <IntervalProvider>
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-medium tracking-tight">Overview</h1>
        <IntervalSelect />
      </div>

      <OverviewStats />

      {/* traffic chart — headerless squircle: frame + inset panel only */}
      <SquircleSurface
        render={<section />}
        className="flex flex-col border border-border p-1 shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
      >
        <SquircleSurface className="overflow-hidden rounded-[22px] border border-border bg-[#f6f6f6] shadow-[0_1px_2px_rgba(0,0,0,0.06)] [--card-clip-radius:12px] sm:rounded-[44px] sm:[--card-clip-radius:17px]">
          {/* vertical padding only — the plot itself hugs the side edges */}
          <div className="py-3">
            <OverviewChart />
          </div>
        </SquircleSurface>
      </SquircleSurface>

      {/* breakdown lists — 3x3; uniform h-60 panels sized for five rows.
          Every card brings its own SquircleCard now: "See all" opens the
          shared vertical modal with the full ranking, which needs card
          state a server component cannot hold. */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        <TopPagesCard />

        {/* brings its own SquircleCard: the header carries the dimension
            picker (Referrers / Campaigns / UTM), which needs the card state */}
        <TopSourcesCard />

        {/* brings its own SquircleCard: `revenue:read` is owner-only, so the
            card decides whether it exists at all rather than rendering a frame
            an admin would only ever see an error inside */}
        <RevenueCard />

        {/* brings its own SquircleCard: the header carries the cut picker
            (Countries / Cities), which needs the card state */}
        <LocationsCard />

        <DeviceCards />

        {/* realtime has a whole page — its "See all" is a door, not a modal */}
        <SquircleCard
          title="Realtime"
          icon={<Activity01Icon aria-hidden="true" />}
          seeAllHref={`/dashboard/${site}/realtime`}
        >
          <RealtimeCard />
        </SquircleCard>

        <WebVitalsCard />

        {/* brings its own SquircleCard: "See all" opens the event builder
            modal (M13), so the header needs a click handler, not a href */}
        <CustomEventsCard />
      </div>
    </div>
    </IntervalProvider>
  );
}
