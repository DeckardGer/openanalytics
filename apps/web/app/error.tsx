"use client";

import Link from "next/link";
import { Logo } from "@/components/ui/logo";
import { Button } from "@/components/ui/button";
import { SITE_EMAIL } from "@/lib/site";

/**
 * The route-level error boundary: a render or data crash inside a page lands
 * here instead of on Next's bare screen. Reset re-renders the segment — for
 * a transient fault (a dropped connection mid-navigation) that is usually
 * the whole fix.
 */
export default function RouteError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-24 text-center">
      <Logo className="size-9 text-primary" />
      <h1 className="text-xl font-medium tracking-tight">
        Something went sideways
      </h1>
      <p className="max-w-sm text-sm leading-6 text-muted-foreground">
        The page hit an error it couldn&apos;t recover from. Trying again
        usually fixes it
        {SITE_EMAIL
          ? `; if it keeps happening, we'd like to know: ${SITE_EMAIL}.`
          : "."}
      </p>
      <div className="mt-2 flex items-center gap-2">
        <Button onClick={reset} size="sm">
          Try again
        </Button>
        <Button render={<Link href="/" />} size="sm" variant="ghost">
          Go home
        </Button>
      </div>
    </main>
  );
}
