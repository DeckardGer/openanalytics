import Link from "next/link";
import { CopyButton } from "@/components/ui/copy-button";
import { docHref, docPage, type DocPage } from "@/lib/docs";

/**
 * The documentation's prose voice, as components.
 *
 * The same rhythm the legal pages set (`components/landing/legal.tsx`):
 * medium headings in ink, 15px/7 body in grey, and every specialized block
 * (code, table, note) drawn in the house's panel language. Pages compose
 * these instead of carrying their own classNames, so the docs cannot drift
 * into twenty typographies.
 */

export function DocArticle({
  page,
  children,
}: {
  page: DocPage;
  children: React.ReactNode;
}) {
  return (
    <article className="min-w-0 flex-1">
      <h1 className="text-3xl font-medium tracking-tight text-[#454545]">
        {page.title}
      </h1>
      <p className="mt-2.5 max-w-xl text-[15px] leading-7 text-muted-foreground">
        {page.summary}
      </p>
      <div className="mt-4 flex flex-col">{children}</div>
    </article>
  );
}

export function DocSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8">
      <h2 className="text-base font-medium tracking-tight text-foreground/90">
        {title}
      </h2>
      <div className="mt-2.5 flex flex-col gap-3 text-[15px] leading-7 text-muted-foreground">
        {children}
      </div>
    </section>
  );
}

export function DocList({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="flex list-disc flex-col gap-1.5 pl-5">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}

/** Inline code, in running text. */
export function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded-md bg-black/5 px-1.5 py-0.5 font-mono text-[13px] text-foreground/80">
      {children}
    </code>
  );
}

/**
 * A code block with an optional file caption and a copy button. The copy
 * target is the code verbatim, so what lands in a clipboard is exactly what
 * the page shows.
 */
export function DocCode({
  caption,
  children,
}: {
  caption?: string;
  children: string;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-white">
      <div className="flex items-center justify-between gap-2 border-b border-border py-1 pl-4 pr-1.5">
        <span className="font-mono text-[11px] text-muted-foreground">
          {caption ?? " "}
        </span>
        <CopyButton label="Copy code" text={children} />
      </div>
      <pre className="overflow-x-auto px-4 py-3 font-mono text-xs leading-6 text-foreground/90">
        <code>{children}</code>
      </pre>
    </div>
  );
}

/** A quiet aside: worth knowing, not part of the main path. */
export function DocNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-secondary/40 px-4 py-3 text-sm leading-6 text-muted-foreground">
      {children}
    </div>
  );
}

export function DocTable({
  head,
  rows,
}: {
  head: string[];
  rows: React.ReactNode[][];
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-[#f6f6f6] text-left">
            {head.map((cell) => (
              <th
                className="px-4 py-2.5 font-medium text-foreground/80"
                key={cell}
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr className="border-b border-border last:border-b-0" key={index}>
              {row.map((cell, cellIndex) => (
                <td
                  className="px-4 py-2.5 align-top text-muted-foreground"
                  key={cellIndex}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** An in-docs link, styled like the legal pages' links. */
export function DocLink({
  slug,
  href,
  children,
}: {
  /** A docs slug ("custom-events"); or pass `href` for external/site URLs. */
  slug?: string;
  href?: string;
  children: React.ReactNode;
}) {
  const target = slug !== undefined ? docHref(docPage(slug).slug) : (href ?? "/docs");
  return (
    <Link
      className="text-foreground underline underline-offset-2 hover:no-underline"
      href={target}
    >
      {children}
    </Link>
  );
}
