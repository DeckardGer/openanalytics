"use client";

import * as React from "react";
import type { WidgetSurface } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * A design-time facsimile of the embed document, with sample numbers — in
 * the embed's own design language (Ledger: mono numerals, dotted leaders,
 * dashed rules), so what this promises is what the page gets. `theme` mirrors
 * the document's two `prefers-color-scheme` palettes, because a reader's
 * machine picks either and the owner should get to see both.
 *
 * Deliberately NOT a live preview, for two contract reasons (§35): the real
 * embed answers `frame-ancestors` from the widget's own origin list, so an
 * iframe here would be browser-blocked unless the dashboard's origin is on
 * that list — and reading `GET /v1/widget/{id}` from the dashboard would
 * spend the widget's public rate budget (120/min per IP and id), shared with
 * its real readers. So this renders the embed's layout from constants and
 * says so.
 *
 * Faithful to what the document actually draws: a 320px frame that clips
 * rather than scrolls, system font, the title as the only owner label,
 * leader rows for `overview` and `sessions`, a bar chart for `timeseries`,
 * a ranked list for the four breakdowns, one big number for `realtime` —
 * and the quiet "No data" state, which is also what every reader of a
 * disabled widget sees.
 */

/* Sample rows, one believable set per breakdown surface. */
const SAMPLE_ROWS: Record<string, Array<[string, number]>> = {
  pages: [
    ["/", 1840],
    ["/pricing", 1213],
    ["/blog/launch-week", 964],
    ["/docs", 731],
    ["/changelog", 512],
    ["/about", 340],
    ["/blog/hiring", 221],
    ["/contact", 148],
  ],
  sources: [
    ["Direct", 1624],
    ["google.com", 1387],
    ["x.com", 842],
    ["github.com", 611],
    ["reddit.com", 402],
    ["linkedin.com", 274],
    ["producthunt.com", 189],
    ["bing.com", 97],
  ],
  devices: [
    ["Chrome · Windows", 2210],
    ["Safari · macOS", 1465],
    ["Safari · iOS", 927],
    ["Firefox · Linux", 604],
    ["Edge · Windows", 371],
    ["Chrome · Android", 152],
  ],
  geography: [
    ["United States", 1712],
    ["Germany", 934],
    ["United Kingdom", 786],
    ["Turkey", 651],
    ["France", 447],
    ["Netherlands", 329],
    ["India", 273],
    ["Canada", 190],
  ],
};

/** The timeseries bars — fixed heights, so the preview never flickers. */
const SAMPLE_BARS = [34, 52, 41, 63, 48, 70, 58, 82, 66, 90, 74, 60, 84, 72, 95, 80];

/** Leader-row samples: overview carries the public read's three totals. */
const SAMPLE_STATS: Record<"overview" | "sessions", Array<[string, string]>> = {
  overview: [
    ["Visitors", "12,438"],
    ["Pageviews", "28,940"],
    ["Events", "31,180"],
  ],
  sessions: [
    ["Sessions", "15,204"],
    ["Engaged", "9,860"],
    ["Avg. duration", "2m 14s"],
    ["Bounce rate", "42%"],
  ],
};

/** The document's two palettes, as Tailwind class fragments. */
const PALETTES = {
  light: {
    frame: "border-[#e3e3de] bg-[#fbfbf9]",
    fg: "text-[#3a3a35]",
    muted: "text-[#8b8b83]",
    faint: "text-[#a1a19a]",
    hair: "border-[#dddcd4]",
    leader: "border-[#d5d4cb]",
    rank: "text-[#b8b8b0]",
    wm: "text-[#b5b5b5]",
    ring: "text-[#305dde]",
    bar: "bg-[#3a3a35]/75",
    live: "bg-[#2f9e63]",
  },
  dark: {
    frame: "border-[#34342f] bg-[#1b1b19]",
    fg: "text-[#d8d8d0]",
    muted: "text-[#8f8f88]",
    faint: "text-[#7c7c75]",
    hair: "border-[#34342f]",
    leader: "border-[#3c3c36]",
    rank: "text-[#57574f]",
    wm: "text-[#6a6a63]",
    ring: "text-[#6b8ef0]",
    bar: "bg-[#d8d8d0]/70",
    live: "bg-[#3fb573]",
  },
} as const;

/** The embed's inline ring mark, at watermark size. */
function Ring({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 12 12">
      <circle cx="6" cy="6" r="4.25" stroke="currentColor" strokeWidth="2.5" />
    </svg>
  );
}

export function WidgetPreview({
  surface,
  title,
  limit,
  intervalLabel,
  theme = "light",
  enabled = true,
  className,
}: {
  surface: WidgetSurface;
  title: string | null;
  limit: number | null;
  /** The window as the embed prints it: "Last 7 days", or "Live". */
  intervalLabel: string;
  /** Which of the document's two prefers-color-scheme palettes to show. */
  theme?: "light" | "dark";
  /** `false` renders what a reader of a disabled widget sees: "No data". */
  enabled?: boolean;
  className?: string;
}) {
  const c = PALETTES[theme];
  // The empty string is legal and means the same as null here: no heading.
  const heading = title !== null && title.trim() !== "" ? title.trim() : null;
  const rows = (SAMPLE_ROWS[surface] ?? []).slice(0, limit ?? 10);

  return (
    <div
      aria-label="Widget preview with sample numbers"
      className={cn(
        // h-80 = the embed's fixed 320px, and it clips exactly as the
        // document does — there is no auto-height handshake to imitate.
        "flex h-80 w-full flex-col overflow-hidden rounded-xl border p-5 [font-family:system-ui]",
        c.frame,
        className
      )}
      role="img"
    >
      {!enabled ? (
        <div className="flex flex-1 items-center justify-center">
          <p className={cn("text-[13px]", c.muted)}>No data</p>
        </div>
      ) : (
        <>
          <div className="flex items-baseline justify-between gap-3">
            <p className={cn("truncate text-sm font-medium", c.fg)}>
              {heading}
            </p>
            <p className={cn("shrink-0 text-xs", c.faint)}>{intervalLabel}</p>
          </div>
          <div className={cn("mt-3 border-t border-dashed", c.hair)} />

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden pt-3">
            {surface === "overview" || surface === "sessions" ? (
              <div className="flex flex-1 flex-col justify-center">
                {SAMPLE_STATS[surface].map(([label, value]) => (
                  <div
                    className="flex items-baseline gap-2.5 py-[9px] text-[13px]"
                    key={label}
                  >
                    <span className={cn("whitespace-nowrap", c.muted)}>
                      {label}
                    </span>
                    <span
                      className={cn("mx-1 flex-1 border-b border-dotted", c.leader)}
                    />
                    <span
                      className={cn("font-mono text-[15px] tabular-nums", c.fg)}
                    >
                      {value}
                    </span>
                  </div>
                ))}
              </div>
            ) : surface === "timeseries" ? (
              <div className="flex flex-1 flex-col justify-end gap-2">
                <p className={cn("font-mono text-[24px] tabular-nums", c.fg)}>
                  28,940{" "}
                  <span className={cn("font-sans text-[11px]", c.muted)}>
                    page views
                  </span>
                </p>
                <div
                  className={cn(
                    "flex h-32 items-end gap-[3px] border-b",
                    c.leader
                  )}
                >
                  {SAMPLE_BARS.map((height, index) => (
                    <span
                      className={cn("flex-1", c.bar)}
                      key={index}
                      style={{ height: `${height}%` }}
                    />
                  ))}
                </div>
                <div
                  className={cn(
                    "flex justify-between font-mono text-[10px] uppercase",
                    c.faint
                  )}
                >
                  <span>Jul 09</span>
                  <span>Aug 07</span>
                </div>
              </div>
            ) : surface === "realtime" ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3">
                <p
                  className={cn(
                    "font-mono text-[72px] leading-none tabular-nums",
                    c.fg
                  )}
                >
                  14
                </p>
                <p
                  className={cn(
                    "flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em]",
                    c.muted
                  )}
                >
                  <span
                    className={cn("inline-block size-2 animate-pulse", c.live)}
                  />
                  visitors on site
                </p>
              </div>
            ) : (
              <ol className="flex min-h-0 flex-1 flex-col justify-center overflow-hidden">
                {rows.map(([name, count], index) => (
                  <li
                    className="flex items-baseline gap-2.5 py-[7px] font-mono text-[12.5px]"
                    key={name}
                  >
                    <span className={c.rank}>
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className={cn("min-w-0 truncate", c.fg)}>{name}</span>
                    <span
                      className={cn("mx-1 flex-1 border-b border-dotted", c.leader)}
                    />
                    <span className={cn("tabular-nums", c.muted)}>
                      {count.toLocaleString("en-US")}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>

          <div className={cn("mb-2.5 border-b border-dashed", c.hair)} />
          <p className={cn("flex items-center gap-1.5 text-[11px]", c.wm)}>
            Powered by
            <Ring className={cn("size-2.5", c.ring)} />
            Open Analytics
          </p>
        </>
      )}
    </div>
  );
}
