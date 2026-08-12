import Link from "next/link";
import { Logo } from "@/components/ui/logo";

/**
 * The plain shell around the documentation.
 *
 * Docs are product: the same pages ship with a self-hosted install, and they
 * are the only public surface such an install has. What bookends them on the
 * hosted site is not — that header carries a pricing anchor and that footer is
 * the site's whole link graph — so the marketing chrome arrives through
 * `@slots` and this stands in when there is none.
 *
 * Deliberately thin: a mark that goes home, a way into the app, and a rule
 * under the page. Anything more would be a second design language for a
 * deployment that only has one screen behind it.
 */
export function DocsChrome({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="sticky top-0 z-50 w-full border-b border-border bg-white/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link className="flex items-center gap-2" href="/docs">
            <Logo className="size-4 text-primary" />
            <span className="text-sm font-medium tracking-tight">
              Open Analytics
            </span>
            <span className="text-sm text-muted-foreground">docs</span>
          </Link>
          <Link
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            href="/dashboard"
          >
            Dashboard
          </Link>
        </div>
      </header>
      {children}
      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-1 px-4 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p>Open Analytics — open-source, privacy-first web analytics.</p>
          <p>AGPL-3.0. Documentation for this install.</p>
        </div>
      </footer>
    </>
  );
}
