import type * as React from "react";
import type { SiteMember, SiteSummary } from "@/lib/api";
import type { SitePage } from "@/lib/site-pages";

/**
 * The extension seam, product side.
 *
 * `apps/web` serves two deployments from one tree: the hosted product, which
 * sells plans, and a self-hosted install, which does not. The backend draws
 * that line with a `cloud/` directory and an alternate entry point
 * (`main.cloud.ts`); a Next.js app has one entry point, so the line is drawn
 * here instead — every place the hosted build adds something is a **named
 * optional export** on this module, and the product renders it only when it is
 * there.
 *
 * Which module you get is decided by whether the hosted one exists on disk.
 * `tsconfig.json` maps the `@seam/slots` specifier to two candidates in order:
 *
 * ```
 * "@seam/*": ["./components/cloud/*.tsx", "./lib/seam/*.tsx"]
 * ```
 *
 * In this repository the first resolves, so `@seam/slots` is the hosted module and
 * this file is only the type contract it satisfies. In the public export the
 * `cloud/` and `(marketing)` directories are cut, the first candidate stops
 * existing, and every `@seam/slots` import lands here — on a module where each slot
 * is `undefined` and every consumer's `slot ? <Slot/> : null` renders nothing.
 * No flag, no dead branch behind an env var, and nothing to keep in sync: the
 * presence of the directory *is* the configuration.
 *
 * Rules for adding one:
 *
 * - Declare the type here and export the `undefined` beside it. A slot that
 *   exists only in the hosted module type-checks in this repository and breaks
 *   the export, which is the one failure this seam is meant to make impossible.
 * - Product code imports `@seam/slots` — never `@/components/cloud/…` directly.
 *   `scripts/check-boundaries.mjs` enforces that; this module is the one door.
 * - A slot is a *component or a value*, never a behavioural flag. `if (isCloud)`
 *   in product code is the thing this replaces.
 */

/* Account ------------------------------------------------------------------ */

/**
 * One extra section in the Account screen's left menu (`account-board.tsx`).
 * The hosted build contributes Billing; the product ships Profile,
 * Preferences, Connected apps and Usage on its own.
 */
export type AccountTabSlot = {
  /** Also the `?tab=` deep-link value, so hosted return URLs keep working. */
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** The one-line description under the section heading. */
  description: string;
  Panel: React.ComponentType;
};

export const accountTabs: readonly AccountTabSlot[] = [];

/**
 * The account-wide usage panel. Quota is a hosted concept — the meter reads
 * `GET /v1/billing/usage`, an endpoint a self-hosted install does not mount —
 * so the *panel* is a slot while the tab that holds it stays product.
 */
export const AccountUsagePanel: React.ComponentType | undefined = undefined;

/** The same, for one site's Usage tab in its settings screen. */
export const SiteUsagePanel:
  | React.ComponentType<{ siteId: string; isBillingOwner: boolean }>
  | undefined = undefined;

/**
 * The account menu's quota block, and the read behind it.
 *
 * Two slots rather than one because of where each has to run: the header
 * starts the read so the numbers are there the moment the menu opens, and the
 * menu draws them. The hook has a no-op default for the same reason the
 * transfer-offer one does — it is called unconditionally, and only *what* it
 * calls is decided at module scope.
 */
export function useAccountUsage(): unknown {
  return null;
}

export const UserMenuUsage:
  | React.ComponentType<{ usage: unknown }>
  | undefined = undefined;

/* Dashboard chrome --------------------------------------------------------- */

/**
 * Rendered under the dashboard header on every screen. The hosted build puts
 * the failed-renewal warning here; nothing else has ever wanted the spot.
 */
export const DashboardBanner: React.ComponentType | undefined = undefined;

/**
 * The screen a suspended site shows instead of its analytics. The product
 * knows the *state* — `suspended` is a product status with a product 403
 * behind it — but not why an operator suspended it, so the sentence that
 * explains the cause and offers a way out belongs to whoever set it.
 */
export const SuspendedSiteScreen:
  | React.ComponentType<{
      name: string;
      slug: string;
      suspendedAt: string | null;
      ingestGraceUntil: string | null;
      retentionDeadline: string | null;
    }>
  | undefined = undefined;

/* Onboarding and the getting-started checklist ----------------------------- */

/**
 * An extra step in the first-run flow, between "install the tracker" and
 * "connect your site". The hosted build makes it plan selection, which is why
 * verification comes last there: nothing is collected until a plan lands.
 *
 * `onDone` advances to the verify step; the step owns whatever it must watch
 * to decide when that is (the hosted one polls its own billing read).
 */
export type OnboardingStepSlot = {
  title: string;
  Body: React.ComponentType<{ onDone: () => void }>;
  /** Footer buttons beside Back. `onSkip` leaves onboarding for good. */
  Footer: React.ComponentType<{ onSkip: () => void }>;
};

export const onboardingStep: OnboardingStepSlot | undefined = undefined;

/**
 * An extra row in the getting-started checklist. `done` is derived by the
 * slot from its own reads, so the product never asks about a plan it has no
 * endpoint for.
 */
export type ChecklistStepSlot = {
  id: string;
  label: string;
  href: string;
  isDone: () => Promise<boolean>;
};

export const checklistSteps: readonly ChecklistStepSlot[] = [];

/* Team --------------------------------------------------------------------- */

/**
 * The successor flow (D-011). Demoting or removing the member who *funds* a
 * site is refused until someone else takes the funding over — a refusal only
 * a deployment that funds sites can raise, so both the dialog and the call
 * behind it live with it.
 */
export const SuccessorDialog:
  | React.ComponentType<{
      siteId: string;
      member: SiteMember;
      /** Everyone except the member being removed. */
      candidates: SiteMember[];
      onClose: () => void;
      onTransferred: (successorUserId: string) => void;
      onFailed: (message: string) => void;
    }>
  | undefined = undefined;

/** Whether an error means "pick a successor first" rather than a plain refusal. */
export const isSuccessorRequired: ((error: unknown) => boolean) | undefined =
  undefined;

/* Site settings ------------------------------------------------------------ */

/**
 * The hand-over offer on a site's General settings — giving the funding away
 * without leaving the team. Hosted only for the same reason as the dialog
 * above.
 *
 * These three are the one group of slots with a *default* rather than an
 * `undefined`, and the reason is React's rules: the settings screen starts
 * both of its General-tab reads together so they share one reveal moment, so
 * the hook has to be called unconditionally. A no-op hook keeps that call
 * unconditional; whether it reads anything is decided once, at module scope.
 *
 * The state carries exactly one field the product reads — `phase`, the shared
 * reveal gate the whole tab waits on. Everything else in it is the hosted
 * side's business and crosses back as `unknown` (see `loaded` below).
 */
export type TransferOfferState = {
  phase: "loading" | "ready" | "error";
};

export function useTransferOffer(_siteId: string): TransferOfferState {
  // Nothing to wait for, so the tab's shared gate is never held open by it.
  return { phase: "ready" };
}

export function TransferOfferSkeleton(): React.ReactElement | null {
  return null;
}

export function TransferOfferSection(_props: {
  loaded: TransferOfferState;
  revealed: boolean;
  site: SiteSummary;
}): React.ReactElement | null {
  return null;
}

/* Documentation and the public surface ------------------------------------- */

/**
 * The header and footer around the documentation. Docs are product — a
 * self-hosted install ships the same pages — but the marketing chrome that
 * bookends them on the hosted site is not, so the shell is a slot and the
 * product falls back to its own plain one (`components/docs/docs-chrome.tsx`).
 */
export const DocsChrome:
  | React.ComponentType<{ children: React.ReactNode }>
  | undefined = undefined;

/** Extra documentation pages the hosted deployment adds to the sidebar. */
export const docsPages: readonly {
  slug: string;
  title: string;
  nav: string;
  summary: string;
  section: string;
}[] = [];

/**
 * Marketing pages, for `sitemap.xml`. The product contributes its docs; the
 * hosted build adds the landing, the comparisons and the legal pages.
 */
export const marketingSitePages: readonly SitePage[] = [];

/* Forms -------------------------------------------------------------------- */

/**
 * `POST /v1/notify` — the one mail door (ADR-0041), and a hosted route: it
 * needs a configured recipient and a transactional sender, neither of which a
 * self-hosted install has. Product surfaces that offer to send something (the
 * tab bar's feedback face) fall back to a link when it is absent.
 */
export const submitNotifyForm:
  | ((form: string, fields: Record<string, string>) => Promise<unknown>)
  | undefined = undefined;
