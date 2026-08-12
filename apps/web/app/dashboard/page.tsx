import type { Metadata } from "next";
import { SitesGrid } from "@/components/dashboard/sites-grid";

export const metadata: Metadata = {
  title: "Your sites | Open Analytics",
};

/**
 * The list itself lives in a Client Component: it needs the session cookie,
 * which is host-only on the api origin and therefore unreachable from a Server
 * Component (auth_integration.md §"Why a Server Component cannot read the
 * session"). This shell exists only to own the route's metadata.
 */
export default function SitesPage() {
  return <SitesGrid />;
}
