"use client";

import { Tick02Icon as Check, Copy01Icon as Copy } from "hugeicons-react";
import { AnimatePresence, motion } from "motion/react";
import * as React from "react";
import { CopyButton } from "@/components/ui/copy-button";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The install step's two roads, shared by the add-site dialog and the
 * onboarding flow: the CLI first (it does the work), the snippet second
 * (for pasting by hand — or for handing to a coding agent).
 *
 * The CLI pane must show the tracking key even though the command carries no
 * arguments — `npx getopen init` asks for the key interactively, and this
 * panel is where the person is standing when it asks. The key is public by
 * design (write-only, an ingest identifier; docs snapshot 01 §3.2), so
 * copying it around is the intended use.
 *
 * Deliberately terse: both hosts are small panels, so each pane is one short
 * sentence and its copy rows, nothing more.
 */

const CLI_COMMAND = "npx getopen init";

/**
 * What "copy for a coding agent" actually copies: the snippet plus the
 * placement rules per framework — the same knowledge `oa init`'s injectors
 * encode, written as instructions. The agent sees the project; the prompt
 * only has to tell it where the tag belongs and to never double-install.
 */
function agentPrompt(snippet: string): string {
  return [
    "Install the Open Analytics tracking snippet in this project.",
    "",
    "The snippet:",
    snippet,
    "",
    "Rules:",
    "- If any file in the project already references /oa.js, it is already installed: change nothing and say so.",
    "- Keep the attributes exactly as given. The data-key is public by design (write-only ingest identifier).",
    "- Place it where this project's framework wants it:",
    "  - Plain HTML, React (Vite/CRA), Vue: index.html, inside <head>.",
    '  - Next.js App Router: the root app/layout, as <Script> from "next/script" with strategy="afterInteractive" and the same src/data attributes.',
    "  - Next.js Pages Router: pages/_app, with the same <Script>.",
    "  - Nuxt: nuxt.config, as an app.head.script entry with the same attributes.",
    "  - SvelteKit: src/routes/+layout.svelte, inside <svelte:head>.",
    "  - Remix: app/root, in the <head> beside <Links />.",
    "  - Astro: the shared layout's <head>.",
    "  - Gatsby: gatsby-ssr, via onRenderBody and setHeadComponents.",
    "  - WordPress theme: functions.php, printed on the wp_head action.",
    "",
    "When done, tell me which file you changed.",
  ].join("\n");
}

type Road = "cli" | "snippet";

export function InstallOptions({
  snippet,
  publicToken,
  host,
}: {
  snippet: string;
  publicToken: string;
  /** The site's domain, already cleaned — or a "your site" stand-in. */
  host: string;
}) {
  const [road, setRoad] = React.useState<Road>("cli");
  // Which way the pane slides: towards the tab the person just picked.
  const [dir, setDir] = React.useState(1);

  const pick = (next: Road) => {
    if (next === road) return;
    setDir(next === "snippet" ? 1 : -1);
    setRoad(next);
  };

  return (
    <div className="flex flex-col gap-3">
      {/* the billing screen's own mini toggle, repurposed as the two roads */}
      <div className="flex items-center gap-2">
        <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-secondary/60 p-0.5">
          {(
            [
              ["cli", "CLI"],
              ["snippet", "Snippet"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => pick(value)}
              className={cn(
                "cursor-pointer rounded-md px-2.5 py-0.5 text-[11px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
                road === value
                  ? "bg-card text-foreground/80 shadow-xs"
                  : "text-muted-foreground hover:text-foreground/70"
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="text-[11px] text-muted-foreground/70">
          {road === "cli"
            ? "Recommended: it finds your framework itself."
            : "For pasting by hand."}
        </span>
      </div>

      {/* the panes cross-fade with a small directional drift — the dialog's
          own step language, scaled down to a tab switch */}
      <AnimatePresence initial={false} mode="popLayout" custom={dir}>
        <motion.div
          animate={{ opacity: 1, x: 0 }}
          className="flex flex-col gap-3"
          custom={dir}
          exit={{ opacity: 0, x: dir * -12, transition: { duration: 0.1 } }}
          initial={{ opacity: 0, x: dir * 12 }}
          key={road}
          transition={{ duration: 0.16, ease: "easeOut" }}
        >
          {road === "cli" ? (
            <>
          <p className="text-xs leading-5 text-muted-foreground">
            1. Run this in your project folder.
          </p>
          <div className="flex items-center gap-1 rounded-xl bg-secondary/60 py-1.5 pl-3 pr-1">
            <pre className="min-w-0 flex-1 overflow-x-auto font-mono text-[11px] leading-6 text-muted-foreground">
              <code>
                <span className="select-none text-muted-foreground/50">$ </span>
                {CLI_COMMAND}
              </code>
            </pre>
            <CopyButton label="Copy command" text={CLI_COMMAND} />
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            2. When terminal prompts for the tracking key, paste this one. It will detect your framework and install the snippet automatically.
          </p>
           
          <div className="flex items-center gap-1 rounded-xl bg-secondary/60 py-1.5 pl-3 pr-1">
            <span className="shrink-0 select-none text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
              key
            </span>
            <pre className="min-w-0 flex-1 overflow-x-auto pl-2 font-mono text-[11px] leading-6 text-muted-foreground">
              <code>{publicToken}</code>
            </pre>
            <CopyButton label="Copy tracking key" text={publicToken} />
          </div>
        </>
      ) : (
        <>
          <p className="text-xs leading-5 text-muted-foreground">
            Paste this into the{" "}
            <code className="rounded bg-secondary px-1 py-0.5 text-[11px]">
              &lt;head&gt;
            </code>{" "}
            of every page on{" "}
            <span className="font-medium text-foreground/80">{host}</span>. A
            single-page app needs it once.
          </p>
          <div className="flex items-start gap-1 rounded-xl bg-secondary/60 py-2 pl-3 pr-1">
            <pre className="min-w-0 flex-1 overflow-x-auto font-mono text-[11px] leading-4 text-muted-foreground">
              <code>{snippet}</code>
            </pre>
            <CopyButton label="Copy snippet" text={snippet} />
          </div>
          <AgentPromptButton prompt={agentPrompt(snippet)} />
            </>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/**
 * "Copy install prompt for coding agents" — a labeled copy control.
 *
 * On copy the whole button shrinks to a short "Copied" and springs back a
 * moment later — the SaveButton's ghost-twin trick, but animated instead of
 * pinned: two invisible twins are the rulers, and the real button's width
 * glides between their measurements while the labels slide through it.
 */
function AgentPromptButton({ prompt }: { prompt: string }) {
  const [copied, setCopied] = React.useState(false);
  const timeout = React.useRef<ReturnType<typeof setTimeout>>(undefined);

  React.useEffect(() => () => clearTimeout(timeout.current), []);

  // Ghost twins — one per state — render at natural size; the real button
  // animates between their widths. Observed rather than measured once,
  // because the font can settle after mount.
  const [widths, setWidths] = React.useState<{
    idle: number;
    copied: number;
  } | null>(null);
  const ghostsRef = React.useCallback((node: HTMLSpanElement | null) => {
    if (!node) return;
    const update = () => {
      const [idle, done] = Array.from(node.children).map(
        (child) => child.getBoundingClientRect().width
      );
      if (idle !== undefined && done !== undefined && idle > 0 && done > 0) {
        setWidths({ idle, copied: done });
      }
    };
    const observer = new ResizeObserver(update);
    for (const child of Array.from(node.children)) observer.observe(child);
    update();
    return () => observer.disconnect();
  }, []);

  const idleLabel = (
    <>
      <Copy aria-hidden="true" className="size-3.5 shrink-0" />
      Copy install prompt
    </>
  );
  const copiedLabel = (
    <>
      <Check
        aria-hidden="true"
        className="size-3.5 shrink-0 text-success-foreground"
      />
      Copied
    </>
  );

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
    } catch {
      return; // Clipboard unavailable — stay put.
    }
    setCopied(true);
    clearTimeout(timeout.current);
    timeout.current = setTimeout(() => setCopied(false), 1600);
  };

  return (
    <span className="relative inline-flex self-start">
      {/* ghost twins — invisible, non-interactive, purely rulers */}
      <span
        aria-hidden="true"
        className="pointer-events-none invisible absolute left-0 top-0 inline-flex whitespace-nowrap"
        ref={ghostsRef}
      >
        <span className="inline-flex">
          <Button className="gap-1.5" disabled size="xs" tabIndex={-1} variant="secondary">
            {idleLabel}
          </Button>
        </span>
        <span className="inline-flex">
          <Button className="gap-1.5" disabled size="xs" tabIndex={-1} variant="secondary">
            {copiedLabel}
          </Button>
        </span>
      </span>

      <Button
        // overflow-hidden: during the swap frame both labels exist and would
        // paint past the animating width as a momentary bulge
        className="overflow-hidden whitespace-nowrap transition-[width] duration-300 ease-out"
        onClick={onCopy}
        size="xs"
        style={
          widths !== null
            ? { width: copied ? widths.copied : widths.idle }
            : undefined
        }
        variant="secondary"
      >
        {/* the icon holds its ground and only crossfades (the CopyButton
            gesture); the words alone travel vertically — so the return trip
            never drags the icon in from the side */}
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="relative size-3.5 shrink-0">
            <AnimatePresence initial={false} mode="wait">
              <motion.span
                animate={{ opacity: 1, scale: 1 }}
                className="absolute inset-0 flex items-center justify-center"
                exit={{ opacity: 0, scale: 0.6 }}
                initial={{ opacity: 0, scale: 0.6 }}
                key={copied ? "tick" : "copy"}
                transition={{ duration: 0.12, ease: "easeOut" }}
              >
                {copied ? (
                  <Check className="size-3.5 text-success-foreground" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </motion.span>
            </AnimatePresence>
          </span>
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span
              animate={{ opacity: 1, y: 0 }}
              className="whitespace-nowrap"
              exit={{ opacity: 0, y: -9, transition: { duration: 0.1 } }}
              initial={{ opacity: 0, y: 9 }}
              key={copied ? "copied" : "idle"}
              transition={{ type: "spring", stiffness: 550, damping: 40 }}
            >
              {copied ? "Copied" : "Copy install prompt"}
            </motion.span>
          </AnimatePresence>
        </span>
      </Button>
    </span>
  );
}
