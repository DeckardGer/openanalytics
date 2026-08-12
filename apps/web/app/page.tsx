import type { Metadata } from "next";
import { HomeGate } from "@/components/auth/home-gate";

export const metadata: Metadata = {
  title: "Open Analytics",
};

/**
 * `/` on every non-marketing host (the app host, localhost, previews): the
 * way in, not a pitch — signed in → `/dashboard`, otherwise → `/login`.
 *
 * On a configured marketing host this component never renders: `middleware.ts`
 * rewrites that apex root to `/home`, the marketing homepage. One project,
 * two front doors, and the host decides which one this is. With no marketing
 * host configured there is only this one.
 */
export default function Home() {
  return <HomeGate />;
}
