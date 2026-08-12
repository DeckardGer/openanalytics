"use client";

import {
  BookOpen01Icon,
  CreditCardIcon,
  Logout01Icon,
  Settings02Icon,
} from "hugeicons-react";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import * as React from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { UserAvatar as GeneratedAvatar } from "@/components/ui/user-avatar";
import { UserMenuUsage } from "@seam/slots";
import { cn } from "@/lib/utils";

/**
 * Account menu: identity from the Better Auth session, plus whatever block
 * this deployment puts under it (the hosted build shows the quota meter).
 *
 * Both come in as props because the header owns the session and the read; this
 * component only decides what they look like. It renders nothing it was not
 * given — no placeholder name while the session loads, no plan name when
 */

const SPRING = { type: "spring", stiffness: 550, damping: 38 } as const;
/** Snappy glide for the hover highlight — near-instant, no lag. */
const HOVER_TRANSITION = { duration: 0.04, ease: "easeOut" } as const;

const itemClass =
  "group relative flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-3 py-2 text-left text-sm text-white/90 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-white/40";

/** Sliding hover highlight shared per panel via layoutId. */
function Highlight() {
  return (
    <motion.span
      layoutId="user-menu-hover"
      transition={HOVER_TRANSITION}
      aria-hidden="true"
      className="absolute inset-0 rounded-[10px] bg-white/10"
    />
  );
}

/** The subset of the session's `user` this menu needs. */
export type MenuUser = {
  /** Seeds the generated avatar when there is no image — the same seed the
   * Account profile draws with, so the two faces always match. */
  id: string;
  name: string;
  email: string;
  /** The avatar URL; null for password-only users (auth_integration.md). */
  image: string | null;
};

export interface UserMenuProps {
  /** `null` while the session is still resolving — never a placeholder. */
  user: MenuUser | null;
  /** Whatever `useAccountUsage` returned, passed straight to its own block. */
  usage: unknown;
  /** Calls `authClient.signOut()` and routes to /login. */
  onSignOut: () => void;
  signingOut: boolean;
  /** Shown in the menu when sign-out itself failed; the session is still live. */
  signOutError: string | null;
}

/** Up to two letters, from the name if there is one, else the email. */
function initialsOf(user: MenuUser): string {
  const source = user.name.trim() || user.email;
  const words = source.split(/\s+/).filter(Boolean);
  const letters =
    words.length > 1
      ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`
      : (words[0] ?? "").slice(0, 2);
  return letters.toUpperCase();
}

export function UserMenu({
  user,
  usage,
  onSignOut,
  signingOut,
  signOutError,
}: UserMenuProps) {
  const [open, setOpen] = React.useState(false);
  const [hovered, setHovered] = React.useState<string | null>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);

  const close = React.useCallback(() => {
    setOpen(false);
    setHovered(null);
  }, []);

  // Close on outside click or Escape
  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        className="flex cursor-pointer items-center rounded-full outline-none transition-transform focus-visible:ring-2 focus-visible:ring-ring active:scale-95"
      >
        {user ? (
          <UserAvatar
            className="size-8"
            fallbackClassName="bg-primary/10 text-xs font-medium text-primary"
            size={32}
            user={user}
          />
        ) : (
          <span
            aria-hidden="true"
            className="size-8 animate-pulse rounded-full bg-muted-foreground/15"
          />
        )}
        <span className="sr-only">Account menu</span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            key="user-menu"
            role="menu"
            initial={{ opacity: 0, scale: 0.94, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -4, transition: { duration: 0.12 } }}
            transition={SPRING}
            onMouseLeave={() => setHovered(null)}
            className="absolute right-0 top-full mt-3 w-56 origin-top-right rounded-2xl bg-[#26262a] p-1.5 shadow-[0_1px_1px_rgba(0,0,0,0.2),0_16px_40px_rgba(0,0,0,0.28)] ring-1 ring-white/8"
          >
            {/* identity — avatar + name + email, straight off the session */}
            <div className="flex items-center gap-2.5 px-2 pb-2 pt-1.5">
              {user ? (
                <>
                  <UserAvatar
                    className="size-9"
                    fallbackClassName="bg-white/10 text-xs font-medium text-white/80"
                    size={36}
                    user={user}
                  />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-white">
                      {user.name}
                    </p>
                    <p className="truncate text-xs text-white/50">
                      {user.email}
                    </p>
                  </div>
                </>
              ) : (
                <div aria-busy="true" className="flex items-center gap-2.5">
                  <span className="size-9 animate-pulse rounded-full bg-white/10" />
                  <div className="flex flex-col gap-1.5">
                    <span className="block h-3 w-24 animate-pulse rounded bg-white/10" />
                    <span className="block h-2.5 w-32 animate-pulse rounded bg-white/8" />
                  </div>
                  <span className="sr-only">Loading your account…</span>
                </div>
              )}
            </div>

            {UserMenuUsage ? <UserMenuUsage usage={usage} /> : null}

            <div className="my-1 h-px bg-white/8" />

            <Link
              href="/dashboard/account"
              role="menuitem"
              onClick={close}
              onMouseEnter={() => setHovered("account")}
              className={itemClass}
            >
              {hovered === "account" && <Highlight />}
              <span className="relative flex-1 font-medium">Account</span>
              <Settings02Icon className="relative size-4 text-white/50" />
            </Link>

            <Link
              href="/dashboard/account?tab=billing"
              role="menuitem"
              onClick={close}
              onMouseEnter={() => setHovered("billing")}
              className={itemClass}
            >
              {hovered === "billing" && <Highlight />}
              <span className="relative flex-1 font-medium">Billing</span>
              <CreditCardIcon className="relative size-4 text-white/50" />
            </Link>

            {/* Contact left the menu (2026-08-09): the tab bar's Feedback face
                and the landing's contact page cover it. Docs ships with the
                launch — this link goes live with that page. */}
            <a
              href="/docs"
              role="menuitem"
              onClick={close}
              onMouseEnter={() => setHovered("docs")}
              className={itemClass}
            >
              {hovered === "docs" && <Highlight />}
              <span className="relative flex-1 font-medium">Docs</span>
              <BookOpen01Icon className="relative size-4 text-white/50" />
            </a>

            <div className="my-1 h-px bg-white/8" />

            {/* Not a link: the session cookie has to be revoked on the api
                before we leave, so this posts and then routes. */}
            <button
              type="button"
              role="menuitem"
              disabled={signingOut}
              onClick={onSignOut}
              onMouseEnter={() => setHovered("logout")}
              className={cn(itemClass, "text-red-400 disabled:cursor-wait")}
            >
              {hovered === "logout" && <Highlight />}
              <span className="relative flex-1 font-medium">
                {signingOut ? "Signing out…" : "Log out"}
              </span>
              <Logout01Icon className="relative size-4 text-red-400" />
            </button>

            {signOutError ? (
              <p
                className="px-3 pb-1.5 pt-0.5 text-[11px] leading-4 text-red-400"
                role="alert"
              >
                {signOutError}
              </p>
            ) : null}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * `image` is null for password-only users, and that case wears the Account
 * profile's generated avatar (seeded by the user id, so the face here and
 * the face there are the same person). Initials remain only as the fallback
 * *behind an image that fails to load* — never the resting state.
 */
function UserAvatar({
  user,
  className,
  fallbackClassName,
  size,
}: {
  user: MenuUser;
  className: string;
  fallbackClassName: string;
  /** The generated avatar draws at a pixel size, not a class. */
  size: number;
}) {
  if (!user.image) {
    return <GeneratedAvatar seed={user.id} size={size} />;
  }
  return (
    <Avatar className={className}>
      <AvatarImage alt="" src={user.image} />
      <AvatarFallback className={fallbackClassName}>
        {initialsOf(user)}
      </AvatarFallback>
    </Avatar>
  );
}
