import { SiteLifecycleGate } from "@/components/dashboard/site-lifecycle-gate";
import { TabBar } from "@/components/dashboard/tab-bar";

/**
 * No `generateStaticParams`: the segment is a real site slug now, and the only
 * list of them is behind the session cookie, which the build has no way to
 * hold. Prerendering the mock domains would have produced static shells at
 * URLs no site answers to.
 */

export default function SiteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      {/* one step wider than the sites picker (5xl); the gate swaps the
          screens for the blocked/deleting lifecycle states (§15/§17) */}
      <div className="mx-auto w-full max-w-6xl">
        <SiteLifecycleGate>{children}</SiteLifecycleGate>
      </div>
      <TabBar />
    </>
  );
}
