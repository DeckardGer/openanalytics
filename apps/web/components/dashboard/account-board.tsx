"use client";

import {
  Analytics01Icon,
  PlugSocketIcon,
  ServerStack01Icon,
  Settings02Icon,
  UserCircleIcon,
} from "hugeicons-react";
import { AnimatePresence, motion } from "motion/react";
import * as React from "react";
import { accountTabs, AccountUsagePanel } from "@seam/slots";
import { ConnectedAppsSection } from "@/components/dashboard/connected-apps-section";
import { DeleteAccountSection } from "@/components/dashboard/delete-account-section";
import {
  DeploymentSection,
  useDeploymentSettings,
} from "@/components/dashboard/deployment-section";
import {
  SectionHeading,
  SettingsPanel,
} from "@/components/dashboard/settings-panel";
import { TimezonePanel } from "@/components/dashboard/timezone-panel";
import {
  SkeletonBar,
  SkeletonCircle,
  SkeletonReveal,
} from "@/components/ui/skeleton-reveal";
import { UserAvatar } from "@/components/ui/user-avatar";
import { LIVE_API } from "@/lib/api";
import { useSession } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

/**
 * Account — everything that belongs to the *person*, not to a site, in the
 * settings screen's own two-pane language. The split is deliberate: a site's
 * settings hold what configures that site (name, domains, keys, team); this
 * screen holds what travels with the user across every site — identity,
 * the timezone preference, the OAuth clients they have connected (a grant
 * is account-scoped, ADR-0048), and the usage quota, which is an account
 * number by construction (the ledger has no site dimension, ADR-0019).
 *
 * Profile is read-only: there is no account-settings API (no profile edit,
 * no change-email), so this shows what the Better Auth session already
 * carries — a form with no endpoint behind it would lie.
 */

const SPRING = { type: "spring", stiffness: 550, damping: 38 } as const;

type Tab = {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
};

/**
 * Four sections the product always has, plus whatever the deployment adds —
 * the hosted build contributes Billing, which is why its `?tab=billing` deep
 * links (Stripe's return URLs among them) keep working while a self-hosted
 * install has no such tab and no dead row pretending otherwise.
 */
const TABS: Tab[] = [
  { id: "profile", label: "Profile", icon: UserCircleIcon },
  { id: "preferences", label: "Preferences", icon: Settings02Icon },
  { id: "connections", label: "Connected apps", icon: PlugSocketIcon },
  { id: "usage", label: "Usage", icon: Analytics01Icon },
  ...accountTabs.map((tab) => ({
    id: tab.id,
    label: tab.label,
    icon: tab.icon,
  })),
];

/**
 * Deployment sits beside them, and only for the one account that may use it.
 *
 * It is not an account setting at all — it configures the whole install — but
 * this is where the person who runs a self-hosted install already comes to
 * change things about it, and a second board for one operator would be a second
 * navigation for a screen most deployments never show. The read decides: a
 * member who is not the operator, and every account on a deployment configured
 * from its environment, sees no tab rather than a tab that refuses them.
 */
const DEPLOYMENT_TAB: Tab = {
  id: "deployment",
  label: "Deployment",
  icon: ServerStack01Icon,
};

export function AccountBoard() {
  const [active, setActive] = React.useState<string>("profile");
  const deploymentState = useDeploymentSettings();
  const showDeployment = deploymentState.settings?.editable === true;
  const tabs = React.useMemo(
    () => (showDeployment ? [...TABS, DEPLOYMENT_TAB] : TABS),
    [showDeployment]
  );

  const isTabId = React.useCallback(
    (value: unknown): boolean => tabs.some((tab) => tab.id === value),
    [tabs]
  );

  // Deep links land on a named tab (`?tab=billing`) — the old /dashboard/
  // billing address redirects here with it, and Stripe's return URLs ride
  // along untouched for the BillingBoard to read. Microtask hop so the
  // server render and hydration agree on the default first.
  // Re-run once the deployment read lands: `?tab=deployment` is a real deep
  // link (SELF-HOSTING points at it), and on the first pass that tab does not
  // exist yet.
  React.useEffect(() => {
    void Promise.resolve().then(() => {
      const requested = new URLSearchParams(window.location.search).get("tab");
      if (requested !== null && isTabId(requested)) setActive(requested);
    });
  }, [isTabId]);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 lg:flex-row lg:items-start lg:gap-8">
      {/* title + sections pin together as one block — lg:sticky needs the
          parent's items-start: a stretched flex child is as tall as the row
          and has nowhere to stick. top-22 = the column's natural offset
          (56px header + 32px main padding), so it pins without first
          drifting up to meet a lower threshold. */}
      <div className="lg:sticky lg:top-22 lg:w-52 lg:shrink-0">
        <h1 className="px-2.5 pb-4 text-xl font-medium tracking-tight">
          Account
        </h1>
        {/* the sections — same row language as the settings screen */}
        <nav
          aria-label="Account sections"
          className="-mx-2.5 flex gap-0.5 overflow-x-auto px-2.5 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0"
        >
        {tabs.map((tab) => {
          const selected = tab.id === active;
          return (
            <button
              aria-current={selected ? "page" : undefined}
              className={cn(
                "group relative flex shrink-0 cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                selected
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
              key={tab.id}
              onClick={() => setActive(tab.id)}
              type="button"
            >
              {/* the highlight glides between rows rather than blinking */}
              {selected ? (
                <motion.span
                  aria-hidden="true"
                  className="absolute inset-0 rounded-[10px] bg-accent"
                  layoutId="account-highlight"
                  transition={SPRING}
                />
              ) : null}
              <tab.icon
                className={cn(
                  "relative size-4 shrink-0 transition-colors",
                  selected ? "text-foreground" : "text-muted-foreground/70"
                )}
              />
              <span className="relative whitespace-nowrap font-medium">
                {tab.label}
              </span>
            </button>
          );
        })}
        </nav>
      </div>

      {/* the selected section — lg:pt-11 matches the title block's height
          (28px line + 16px gap) so the panels start level with the menu */}
      <div className="min-w-0 flex-1 lg:pt-11">
        <AnimatePresence initial={false} mode="wait">
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col gap-6"
            exit={{ opacity: 0, y: -6, transition: { duration: 0.12 } }}
            initial={{ opacity: 0, y: 8 }}
            key={active}
            transition={SPRING}
          >
            {active === "profile" ? (
              <>
                <SectionHeading
                  description="Who you are to us, read straight from how you sign in."
                  title="Profile"
                />
                <ProfilePanel />
                <DeleteAccountSection />
              </>
            ) : null}
            {active === "preferences" ? (
              <>
                <SectionHeading
                  description="Settings that travel with you, on every site you can see."
                  title="Preferences"
                />
                <TimezonePanel />
              </>
            ) : null}
            {active === "connections" ? (
              <>
                <SectionHeading
                  description="Apps you have let use your account, what each one may do, and the switch that shuts it off."
                  title="Connected apps"
                />
                <ConnectedAppsSection />
              </>
            ) : null}
            {active === "usage" ? (
              <>
                <SectionHeading
                  description="What this account has sent this month, across every site it covers."
                  title="Usage"
                />
                {AccountUsagePanel ? (
                  <AccountUsagePanel />
                ) : (
                  <UnmeteredNotice />
                )}
              </>
            ) : null}
            {active === "deployment" && showDeployment ? (
              <>
                <SectionHeading
                  description="What this install needs from somewhere else — a mail relay, a model provider — so you don’t have to edit a file on the host and restart."
                  title="Deployment"
                />
                <DeploymentSection state={deploymentState} />
              </>
            ) : null}
            {accountTabs.map((tab) =>
              active === tab.id ? (
                <React.Fragment key={tab.id}>
                  <SectionHeading
                    description={tab.description}
                    title={tab.label}
                  />
                  <tab.Panel />
                </React.Fragment>
              ) : null
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

/**
 * What the Usage tab says with no meter behind it.
 *
 * The tab stays — "what is this install receiving" is a fair question on any
 * deployment — but the answer it used to give came from `GET /v1/billing/usage`,
 * a hosted endpoint, and there is no product read that replaces it: usage is
 * billed at `accepted_at` while analytics is bucketed at `occurred_at`, so
 * deriving a count from the dashboard's own numbers would be a different
 * number wearing this one's name.
 */
function UnmeteredNotice() {
  return (
    <SettingsPanel title="Usage">
      <p className="p-5 text-sm leading-6 text-muted-foreground">
        This install has no quota: every event it receives is stored. There is
        no meter to show and nothing to run out of.
      </p>
    </SettingsPanel>
  );
}

function ProfilePanel() {
  const { data: session, isPending } = useSession();
  const user = session?.user;
  const name = LIVE_API ? (user?.name ?? null) : "Design Mode";
  const email = LIVE_API ? (user?.email ?? null) : "design@example.com";
  const seed = LIVE_API ? (user?.id ?? "account") : "mock-user";

  // The house model: the chrome — frame, title, the note below, all words we
  // already have — is real from the first frame; the identity row waits on
  // the session and comes into focus. The avatar is content too: its artwork
  // is seeded by the user id, so drawn early it would draw wrong and swap.
  const revealed = !LIVE_API || !isPending;

  return (
    <SettingsPanel title="Profile">
      <SkeletonReveal
        ready={revealed}
        skeleton={
          <div className="flex items-center gap-4 p-5">
            <SkeletonCircle className="size-12" />
            <div className="min-w-0 flex-1">
              <span className="flex h-5 items-center">
                <SkeletonBar className="h-3.5 w-32" />
              </span>
              <span className="flex h-4 items-center">
                <SkeletonBar className="h-3 w-44 max-w-full" />
              </span>
            </div>
          </div>
        }
      >
        {!revealed ? null : (
          <div className="flex items-center gap-4 p-5">
            <UserAvatar seed={seed} size={48} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {name ?? "Unnamed account"}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {email ?? "—"}
              </p>
            </div>
          </div>
        )}
      </SkeletonReveal>
      <p className="border-t border-border px-5 py-3 text-xs leading-5 text-muted-foreground">
        Your name and email come from how you sign in. Profile editing
        isn&apos;t available yet.
      </p>
    </SettingsPanel>
  );
}
