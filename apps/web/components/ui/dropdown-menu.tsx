"use client";

import { AnimatePresence, motion } from "motion/react";
import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/**
 * Our dropdown: the dark panel the user menu and the site switcher use.
 *
 * Spring scale/fade in from the corner it is anchored to, and a hover highlight
 * that glides between rows rather than blinking on and off. Distinct from
 * `components/ui/menu.tsx`, which wraps Base UI for light-surface menus — this
 * one is the dashboard's own language.
 *
 * The panel is portalled to the body and positioned from the trigger's rect.
 * It has to be: our squircle cards carry a `clip-path`, which clips every
 * descendant no matter its z-index or position, so a panel rendered in place
 * gets sliced off at the card's edge.
 */

const SPRING = { type: "spring", stiffness: 550, damping: 38 } as const;
/** Snappy glide for the hover highlight — near-instant, no lag. */
const HOVER_TRANSITION = { duration: 0.04, ease: "easeOut" } as const;

const itemClass =
  "group relative flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-3 py-2 text-left text-sm text-white/90 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-white/40";

type MenuContextValue = {
  hovered: string | null;
  setHovered: (id: string | null) => void;
  close: () => void;
  /** Unique per open menu, so highlights never glide between two of them. */
  highlightId: string;
};

/** Never fires: `useSyncExternalStore` only needs it to read the snapshot. */
const subscribeNever = () => () => {};

const MenuContext = React.createContext<MenuContextValue | null>(null);

function useMenu(): MenuContextValue {
  const context = React.useContext(MenuContext);
  if (!context) {
    throw new Error("DropdownMenu parts must be used inside <DropdownMenu>");
  }
  return context;
}

export function DropdownMenu({
  trigger,
  align = "end",
  className,
  children,
}: {
  /** Your own button. It gets the open/close handler and the aria wiring. */
  trigger: React.ReactElement<React.ComponentProps<"button">>;
  align?: "start" | "end";
  className?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const [hovered, setHovered] = React.useState<string | null>(null);
  /** Viewport coordinates of the trigger, taken when the menu opens. */
  const [anchor, setAnchor] = React.useState<Anchor | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const highlightId = React.useId();

  const close = React.useCallback(() => {
    setOpen(false);
    setHovered(null);
  }, []);

  React.useEffect(() => {
    if (!open) return;
    const reanchor = () => setAnchor(measureAnchor(triggerRef.current));
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", reanchor);
    // Capture, so the panel follows a scroll in any container, not just the page.
    window.addEventListener("scroll", reanchor, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", reanchor);
      window.removeEventListener("scroll", reanchor, true);
    };
  }, [open, close]);

  const value = React.useMemo(
    () => ({ hovered, setHovered, close, highlightId }),
    [hovered, close, highlightId]
  );

  // A client component still renders once on the server, where there is no
  // `document` to portal into. Every caller until now mounted this behind a
  // loading state, so the branch never ran during prerender; the landing page
  // renders a menu straight into the first HTML, and hit it. The subscription
  // is a no-op on purpose — this is a "has the client taken over" flag, not a
  // store.
  const mounted = React.useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false
  );

  return (
    <MenuContext.Provider value={value}>
      {React.cloneElement(trigger, {
        "aria-expanded": open,
        "aria-haspopup": "menu",
        onClick: () => {
          if (open) {
            close();
            return;
          }
          // Measured here rather than in an effect: by the time the click
          // handler runs the trigger is laid out, and no extra render passes.
          setAnchor(measureAnchor(triggerRef.current));
          setOpen(true);
        },
        ref: triggerRef,
      })}

      {mounted
        ? createPortal(
            <AnimatePresence>
              {open && anchor ? (
                <motion.div
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  className={cn(
                    "fixed z-[70] w-52 rounded-2xl bg-[#26262a] p-1.5 shadow-[0_1px_1px_rgba(0,0,0,0.2),0_16px_40px_rgba(0,0,0,0.28)] ring-1 ring-white/8",
                    align === "end" ? "origin-top-right" : "origin-top-left",
                    className
                  )}
                  exit={{
                    opacity: 0,
                    scale: 0.96,
                    y: -4,
                    transition: { duration: 0.12 },
                  }}
                  initial={{ opacity: 0, scale: 0.94, y: -6 }}
                  onMouseLeave={() => setHovered(null)}
                  ref={panelRef}
                  role="menu"
                  style={
                    align === "end"
                      ? { top: anchor.bottom + 8, right: anchor.right }
                      : { top: anchor.bottom + 8, left: anchor.left }
                  }
                  transition={SPRING}
                >
                  {children}
                </motion.div>
              ) : null}
            </AnimatePresence>,
            document.body
          )
        : null}
    </MenuContext.Provider>
  );
}

type Anchor = { bottom: number; left: number; right: number };

function measureAnchor(node: HTMLButtonElement | null): Anchor | null {
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  return {
    bottom: rect.bottom,
    left: rect.left,
    // Distance from the viewport's right edge, so `right` anchoring holds.
    right: window.innerWidth - rect.right,
  };
}

export function DropdownMenuItem({
  variant = "default",
  disabled,
  icon,
  onClick,
  children,
}: {
  variant?: "default" | "destructive";
  disabled?: boolean;
  /** Trailing glyph, as in the user menu. */
  icon?: React.ReactNode;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  const { hovered, setHovered, close, highlightId } = useMenu();
  const id = React.useId();
  const destructive = variant === "destructive";

  return (
    <button
      className={cn(
        itemClass,
        destructive && "text-red-400",
        disabled && "pointer-events-none opacity-40"
      )}
      disabled={disabled}
      onClick={() => {
        close();
        onClick?.();
      }}
      onMouseEnter={() => setHovered(id)}
      role="menuitem"
      type="button"
    >
      {hovered === id ? (
        <motion.span
          aria-hidden="true"
          className="absolute inset-0 rounded-[10px] bg-white/10"
          layoutId={highlightId}
          transition={HOVER_TRANSITION}
        />
      ) : null}
      <span className="relative flex-1 font-medium">{children}</span>
      {/* The glyph inherits its colour from here, as in the user menu: muted
          against the dark panel, and the item's own red when destructive. */}
      {icon ? (
        <span
          className={cn(
            "relative",
            destructive ? "text-red-400" : "text-white/50"
          )}
        >
          {icon}
        </span>
      ) : null}
    </button>
  );
}

export function DropdownMenuSeparator() {
  return <div aria-hidden="true" className="my-1 h-px bg-white/8" />;
}

export function DropdownMenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-3 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-white/40">
      {children}
    </p>
  );
}
