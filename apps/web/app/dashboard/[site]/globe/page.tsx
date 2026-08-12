import type { Metadata } from "next";
import { GlobeMap } from "@/components/dashboard/globe-map";

export const metadata: Metadata = {
  title: "Globe | Open Analytics",
};

/**
 * Pure stage: no title, no badge — the planet and its visitors are the whole
 * screen. Details live behind the avatar markers (the tab bar presents them).
 */
export default async function GlobePage({
  params,
}: {
  params: Promise<{ site: string }>;
}) {
  const { site } = await params;
  const domain = decodeURIComponent(site);
  return (
    // Full-bleed from the very top: the map must run UNDER the fixed header
    // (z-40) for the header's backdrop-blur to have map to blur — starting
    // at top-14 left white body behind the bar, which no blur recipe could
    // ever make look like anything but a white band. The floating tab bar
    // (z-50) rides above.
    <div className="fixed inset-0 z-0">
      <GlobeMap slug={domain} />
    </div>
  );
}
