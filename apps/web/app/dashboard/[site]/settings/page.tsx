import type { Metadata } from "next";
import { SettingsBoard } from "@/components/dashboard/settings-board";

export const metadata: Metadata = {
  title: "Settings | Open Analytics",
};

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ site: string }>;
}) {
  const { site } = await params;
  // URLs carry the public slug; every api call carries the opaque site_id the
  // board resolves client-side (the session cookie never reaches this server).
  const slug = decodeURIComponent(site);

  // Two panes: the section list on the left, the selected section on the
  // right. The title lives inside the board's left column, so title + menu
  // pin together as one block while the sections scroll.
  return <SettingsBoard slug={slug} />;
}
