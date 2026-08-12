"use client";

import { Globe02Icon } from "hugeicons-react";
import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A site's own mark — its favicon — for every place a site is named: the
 * sites grid, the switcher, the usage split. One definition so a site looks
 * the same everywhere it appears.
 *
 * Goes through our own route rather than straight to Google, and that is
 * load-bearing: `faviconV2` answers a missing favicon with **404 plus a
 * generic globe in the body**, browsers draw the body of a 404 image
 * response, and gstatic sends no CORS headers — so from the browser there is
 * no way to tell "no favicon" from "here is one" and every unknown domain
 * rendered Google's grey globe. `/api/favicon` reads the status server-side
 * and answers a bodyless 404, which is what makes the fallbacks below
 * possible.
 */
export const faviconUrl = (domain: string) =>
  `/api/favicon?domain=${encodeURIComponent(domain)}`;

/** Favicon that falls back to a globe while empty/unresolvable.
 *  Render with `key={domain}` so the failed flag resets on a new domain. */
export function Favicon({
  domain,
  className,
}: {
  domain: string;
  className?: string;
}) {
  const [failed, setFailed] = React.useState(false);

  if (!domain.trim() || failed) {
    return <Globe02Icon className={cn("text-muted-foreground/60", className)} />;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- tiny external favicon, not worth the image pipeline
    <img
      alt=""
      className={cn("rounded", className)}
      onError={() => setFailed(true)}
      src={faviconUrl(domain)}
    />
  );
}

/**
 * The favicon as the site's tile: a rounded square the icon fills edge to
 * edge, rather than a small glyph floating on a disc — a site's mark is its
 * own artwork, and giving it the whole tile is what makes a row scannable.
 * The radius is `xl` at the default size; small callers pass a proportional
 * one, since a 12px radius on a 20px box is just a circle again.
 *
 * A site with no origin allowlist has no domain to ask about, and that is a
 * normal state (an empty allowlist means "accept any origin"), so the
 * fallback is the site's own initial rather than a globe that would read as
 * "broken". Same for a favicon that fails to load — a letter still
 * identifies the row.
 */
export function SiteMark({
  domain,
  name,
  className,
  tone = "light",
  style,
}: {
  domain: string | null | undefined;
  name: string;
  className?: string;
  /** `dark` is the switcher's menu — the light tile vanishes on #26262a. */
  tone?: "light" | "dark";
  /** For callers that colour the tile's ring (the usage split legend). */
  style?: React.CSSProperties;
}) {
  const [failed, setFailed] = React.useState(false);
  const trimmed = domain?.trim() ?? "";
  const initial = name.trim().charAt(0).toUpperCase() || "?";

  return (
    <span
      aria-hidden="true"
      className={cn(
        // The ring is the tile's edge: plenty of favicons are black artwork
        // on a transparent background, and without an outline (and, on the
        // dark menu, a light tile to sit on) they disappear into the panel.
        // The letter inherits this size, so a caller that grows the tile
        // grows the monogram with it by passing a text class.
        "flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-md text-[10px] ring-1",
        tone === "dark"
          ? "bg-white/90 ring-white/20"
          : "bg-black/4 ring-black/8",
        className
      )}
      style={style}
    >
      {trimmed && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element -- tiny external favicon, not worth the image pipeline
        <img
          alt=""
          // Fills the tile. faviconV2 is asked for 64px, so every size here
          // is a downscale rather than a blur.
          className="size-full object-cover"
          // A new domain must clear a previous failure.
          key={trimmed}
          onError={() => setFailed(true)}
          src={faviconUrl(trimmed)}
        />
      ) : (
        // Our own mark, not Google's: faviconV2 answers 404 when a domain
        // has no favicon (it never serves a generic globe), so this is what
        // renders — the site's initial, which at least identifies the row.
        <span
          className={cn(
            "font-medium",
            // The dark tile is light, so its letter has to be dark too.
            tone === "dark" ? "text-[#26262a]/60" : "text-muted-foreground"
          )}
        >
          {initial}
        </span>
      )}
    </span>
  );
}
