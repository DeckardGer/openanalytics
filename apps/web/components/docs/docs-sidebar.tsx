"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DOC_SECTIONS, docHref } from "@/lib/docs";
import { cn } from "@/lib/utils";

/**
 * The docs' left rail: a plain list menu, grouped under small labels, the
 * whole tree always visible. Deliberately not a collapsing tree and not a
 * component-library sidebar; documentation is a map, and a map you have to
 * unfold is a worse map.
 *
 * Client component only for `usePathname`, which is what lights the row of
 * the page being read.
 */
export function DocsSidebar({ className }: { className?: string }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Documentation" className={cn("text-sm", className)}>
      <div className="flex flex-col gap-6">
        {DOC_SECTIONS.map((section) => (
          <div key={section.label}>
            <p className="px-2.5 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground/70">
              {section.label}
            </p>
            <ul className="mt-1.5 flex flex-col gap-px">
              {section.items.map((item) => {
                const href = docHref(item.slug);
                const active = pathname === href;
                return (
                  <li key={item.slug}>
                    <Link
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "block rounded-lg px-2.5 py-1.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
                        active
                          ? "bg-accent/70 font-medium text-foreground"
                          : "text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                      )}
                      href={href}
                    >
                      {item.nav}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}
