"use client";

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import * as React from "react";
import { ArrowRightIcon, SearchIcon } from "@/components/icons/hugeicons";

/**
 * The 404.
 *
 * An analytics tool is the product that *measures* 404s, so ours is aware of
 * itself: the glyphs are made of the same dither texture as the sign-in
 * backdrop, the count is the number of times this path has been requested,
 * and the way out is a search. Hero, context, exit — in that order, because a
 * dead end's real job is to end.
 *
 * Deliberately not in a card: this is the whole page, and framing it would
 * make the dither a widget instead of the thing you landed in.
 */

const SPRING = { type: "spring", stiffness: 550, damping: 38 } as const;

/** Where people usually meant to go. */
const DESTINATIONS = [
  { href: "/dashboard", label: "Dashboard", hint: "Your sites" },
  {
    href: "/dashboard/account?tab=billing",
    label: "Billing",
    hint: "Plan and usage",
  },
  { href: "/login", label: "Sign in", hint: "Magic link or a provider" },
  { href: "/", label: "Home", hint: "Back to the start" },
];

/* ------------------------------------------------------------------ */
/* The dithered glyphs                                                 */
/* ------------------------------------------------------------------ */

type Dot = { x: number; y: number; homeX: number; homeY: number };

/**
 * Rasterises "404" once, samples it onto a grid, and lets the cursor push the
 * dots off their marks. They spring home, so the page is never left broken.
 */
function DitherGlyphs() {
  const mount = React.useCallback((canvas: HTMLCanvasElement | null) => {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const pointer = { x: -9999, y: -9999 };
    let dots: Dot[] = [];
    let built = false;
    let width = 0;
    let height = 0;

    const build = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w <= 0 || h <= 0) return false;

      width = w;
      height = h;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Draw the glyphs to an offscreen canvas, then keep only the pixels that
      // landed inside them.
      const off = document.createElement("canvas");
      off.width = w;
      off.height = h;
      const octx = off.getContext("2d", { willReadFrequently: true });
      if (!octx) return false;

      // The family is read off the DOM rather than written out here. Canvas
      // takes CSS font shorthand but not `var()`, and `next/font` registers
      // the face under a generated name — so both `var(--font-sans)` and a
      // literal "Inter Tight" fail to match. An unmatched or invalid font
      // string is ignored silently, leaving the 10px default behind and
      // sampling almost no pixels.
      const family =
        getComputedStyle(canvas).fontFamily || "system-ui, sans-serif";
      const size = Math.min(w * 0.32, h * 0.92);
      octx.fillStyle = "#000";
      octx.font = `600 ${Math.round(size)}px ${family}`;
      octx.textAlign = "center";
      octx.textBaseline = "middle";

      // Centre on the *ink*, not the text box. `textAlign: center` centres the
      // advance width, which carries each glyph's side bearings — for "404"
      // those are uneven, so the drawn shape lands a few pixels off-centre.
      // The same applies vertically: `middle` is a font metric, not the middle
      // of the marks. Measuring the bounding box and correcting for it is what
      // makes the two sides symmetrical.
      // The grid is built around whole-pixel centres so that mirrored cells are
      // exactly equidistant. Drawing the glyphs on those same centres is what
      // lets the two halves sample identically.
      const centreX = Math.round(w / 2);
      const centreY = Math.round(h / 2);

      const metrics = octx.measureText("404");
      const inkX = (metrics.actualBoundingBoxRight - metrics.actualBoundingBoxLeft) / 2;
      const inkY = (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2;

      // The +0.5 is the whole game. In canvas coordinates an integer x is the
      // *boundary* between pixel centreX-1 and pixel centreX, so a shape
      // centred there mirrors as (centreX-1-k) ↔ (centreX+k) — while the grid
      // below reads pixels at centreX±k. That one-pixel disagreement is what
      // kept the "0" lopsided. Centring on the middle of the pixel makes the
      // sampled pairs true mirrors.
      octx.fillText("404", centreX + 0.5 - inkX, centreY + 0.5 + inkY);

      const alpha = octx.getImageData(0, 0, w, h).data;
      const step = 6;
      const reach = Math.floor(step / 2);

      /**
       * Coverage of one cell, not the colour of one pixel.
       *
       * Point-sampling a glyph is why the halves kept disagreeing: the edges
       * are antialiased, so whether a single pixel clears the threshold turns
       * on sub-pixel coverage that differs between the left and right of a
       * shape. Averaging the cell integrates that away.
       */
      const coverage = (cx: number, cy: number) => {
        let total = 0;
        let samples = 0;
        for (let y = cy - reach; y <= cy + reach; y++) {
          if (y < 0 || y >= h) continue;
          for (let x = cx - reach; x <= cx + reach; x++) {
            if (x < 0 || x >= w) continue;
            total += alpha[(y * w + x) * 4 + 3];
            samples += 1;
          }
        }
        return samples === 0 ? 0 : total / samples;
      };

      // Cells are indexed outward from the centre, so cell -n and cell +n are
      // exactly mirrored integers.
      const columns = Math.ceil(w / (2 * step));
      const rows = Math.ceil(h / (2 * step));
      const next: Dot[] = [];
      for (let row = -rows; row <= rows; row++) {
        const cy = centreY + row * step;
        if (cy < 0 || cy >= h) continue;
        for (let column = -columns; column <= columns; column++) {
          const cx = centreX + column * step;
          if (cx < 0 || cx >= w) continue;
          if (coverage(cx, cy) > 120) {
            next.push({ x: cx, y: cy, homeX: cx, homeY: cy });
          }
        }
      }
      if (next.length === 0) return false;
      dots = next;
      return true;
    };

    const onMove = (event: PointerEvent) => {
      const box = canvas.getBoundingClientRect();
      pointer.x = event.clientX - box.left;
      pointer.y = event.clientY - box.top;
    };
    const onLeave = () => {
      pointer.x = -9999;
      pointer.y = -9999;
    };
    // Listening on the window keeps the interaction alive across the copy that
    // sits over the canvas, instead of dying whenever the cursor crosses text.
    window.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);

    const observer = new ResizeObserver(() => {
      built = false;
    });
    observer.observe(canvas);

    // Wait for the webfont, otherwise the glyphs get sampled in a fallback
    // face and the shape changes under the reader a moment later.
    let fontsReady = false;
    document.fonts.ready.then(() => {
      fontsReady = true;
    });

    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      if (!fontsReady) return;
      if (!built) {
        built = build();
        if (!built) return;
      }

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "#296FF0";

      for (const dot of dots) {
        if (!reduced.matches) {
          const dx = dot.x - pointer.x;
          const dy = dot.y - pointer.y;
          const distance = Math.hypot(dx, dy);
          if (distance < 110) {
            const push = ((110 - distance) / 110) ** 2;
            dot.x += (dx / (distance || 1)) * push * 14;
            dot.y += (dy / (distance || 1)) * push * 14;
          }
          dot.x += (dot.homeX - dot.x) * 0.09;
          dot.y += (dot.homeY - dot.y) * 0.09;
        }
        ctx.fillRect(dot.x - 1.1, dot.y - 1.1, 2.2, 2.2);
      }
    };
    draw();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  return (
    <canvas
      aria-label="404"
      className="absolute inset-0 size-full touch-none"
      ref={mount}
      role="img"
    />
  );
}

/* ------------------------------------------------------------------ */
/* The count                                                           */
/* ------------------------------------------------------------------ */

/**
 * An odometer, so the number reads as something still being measured.
 *
 * Each slot keeps an invisible copy of its digit in normal flow. That copy is
 * what sets the slot's width and, more importantly, its baseline: the clipping
 * layer has to be `overflow: hidden`, and an inline box with hidden overflow
 * takes its baseline from its bottom edge — which drops the whole counter
 * below the sentence it sits in. Clipping only the absolute layer keeps the
 * digits on the text's baseline.
 */
function Odometer({ value }: { value: number }) {
  const digits = value.toLocaleString("en-US").split("");
  return (
    <span className="inline-flex tabular-nums">
      {digits.map((digit, index) => (
        <span
          className="relative inline-block"
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed odometer slot
          key={index}
        >
          <span aria-hidden="true" className="invisible">
            {digit}
          </span>
          <span className="absolute inset-0 overflow-hidden">
            <AnimatePresence initial={false} mode="popLayout">
              <motion.span
                animate={{ y: 0, opacity: 1 }}
                className="absolute inset-0 flex items-center justify-center"
                exit={{ y: "-100%", opacity: 0 }}
                initial={{ y: "100%", opacity: 0 }}
                key={`${digit}-${index}`}
                transition={SPRING}
              >
                {digit}
              </motion.span>
            </AnimatePresence>
          </span>
        </span>
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------ */

export function NotFoundBoard() {
  const [query, setQuery] = React.useState("");
  const [count, setCount] = React.useState(47);

  // Ticks while you read — the point being that this is measured, not static.
  const tick = React.useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const id = window.setInterval(() => setCount((n) => n + 1), 16400);
    return () => window.clearInterval(id);
  }, []);

  const matches = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return DESTINATIONS;
    return DESTINATIONS.filter(
      (entry) =>
        entry.label.toLowerCase().includes(needle) ||
        entry.href.toLowerCase().includes(needle) ||
        entry.hint.toLowerCase().includes(needle)
    );
  }, [query]);

  return (
    <div className="flex w-full max-w-md flex-col items-center" ref={tick}>
      {/* hero — the glyphs run full width, unframed */}
      <div className="relative h-44 w-full sm:h-56">
        <DitherGlyphs />
      </div>

      <h1 className="mt-2 text-center text-xl font-medium tracking-tight">
        Don&apos;t panic, you are not the first.
      </h1>

      <p className="mt-1.5 flex flex-wrap items-center justify-center gap-x-1 text-center text-sm text-muted-foreground">
        This page has been requested
        <span className="font-medium text-foreground">
          <Odometer value={count} />
        </span>
        times
      </p>

      <div className="mt-7 flex w-full items-center gap-2 rounded-xl border border-input bg-white px-3">
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
        <input
          aria-label="Search for a page"
          className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Where were you headed?"
          value={query}
        />
      </div>

      {/* Reserves the full list's height. Filtering shrinks the results, and
          on a vertically centred page that would drag everything upward while
          you type — the search field would slide out from under the cursor.
          Row = py-2 (1rem) + text-sm (1.25rem) + text-xs (1rem); the gaps
          between them have to be counted too, or it still drifts by a few px. */}
      <ul
        className="mt-1 flex w-full flex-col gap-0.5"
        style={{
          minHeight: `calc(${DESTINATIONS.length} * 3.25rem + ${DESTINATIONS.length - 1} * 0.125rem)`,
        }}
      >
        <AnimatePresence initial={false} mode="popLayout">
          {matches.map((entry) => (
            <motion.li
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              initial={{ opacity: 0, y: 4 }}
              key={entry.href}
              layout
              transition={SPRING}
            >
              <Link
                className="group flex items-center gap-3 rounded-lg px-2.5 py-2 outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
                href={entry.href}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {entry.label}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {entry.hint}
                  </span>
                </span>
                <ArrowRightIcon className="size-4 shrink-0 text-muted-foreground/0 transition-all duration-200 group-hover:translate-x-0.5 group-hover:text-muted-foreground/70" />
              </Link>
            </motion.li>
          ))}
        </AnimatePresence>
        {matches.length === 0 ? (
          <li className="px-2.5 py-2 text-sm text-muted-foreground">
            Nothing matches “{query.trim()}”.
          </li>
        ) : null}
      </ul>
    </div>
  );
}
