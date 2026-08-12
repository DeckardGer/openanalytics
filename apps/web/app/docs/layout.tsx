import { DocsChrome as DeploymentChrome } from "@seam/slots";
import { DocsChrome } from "@/components/docs/docs-chrome";
import { DocsSidebar } from "@/components/docs/docs-sidebar";

/**
 * The documentation shell: a two-column spread, a plain list menu on the left
 * and the page on the right, inside whatever chrome this deployment wears. On
 * small screens the whole menu moves into a disclosure above the content
 * instead of a drawer; the map stays one tap away and the page keeps the
 * width.
 *
 * The header and footer are a slot because they are the one part of a docs
 * page that is not product: the hosted site puts its own around them (and
 * needs to — that footer is the only path a crawler has to several of its
 * pages), while an install with no marketing site gets the plain shell.
 */
export default function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const Chrome = DeploymentChrome ?? DocsChrome;

  return (
    <Chrome>
      <div className="mx-auto flex w-full max-w-6xl flex-1 gap-10 px-4 pb-24 pt-8 sm:px-6">
        <aside className="hidden w-52 shrink-0 lg:block">
          <div className="sticky top-24 max-h-[calc(100svh-8rem)] overflow-y-auto overscroll-contain pb-8 pr-1">
            <DocsSidebar />
          </div>
        </aside>

        <div className="min-w-0 flex-1">
          <details className="group mb-6 rounded-xl border border-border bg-card lg:hidden">
            <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-medium text-foreground/80">
              Documentation menu
            </summary>
            <div className="border-t border-border p-3">
              <DocsSidebar />
            </div>
          </details>
          {children}
        </div>
      </div>
    </Chrome>
  );
}
