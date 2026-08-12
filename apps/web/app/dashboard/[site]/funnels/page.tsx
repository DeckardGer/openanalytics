import type { Metadata } from "next";
import { FunnelsBoard } from "@/components/dashboard/funnels-board";

export const metadata: Metadata = {
  title: "Funnels | Open Analytics",
};

/**
 * Saved funnels over the funnel CRUD (`/v1/sites/{site_id}/funnels`) and the
 * compute read (`GET .../analytics/funnel`). The list is any member's;
 * defining and archiving need `site:settings`.
 */
export default function FunnelsPage() {
  return (
    <div className="flex flex-col gap-6">
      <div className="mx-auto w-full max-w-2xl">
        <h1 className="text-xl font-medium tracking-tight">Funnels</h1>
      </div>
      <FunnelsBoard />
    </div>
  );
}
