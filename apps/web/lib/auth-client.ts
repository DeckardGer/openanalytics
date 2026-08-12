"use client";

import { magicLinkClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import * as React from "react";
import { API_BASE_URL } from "./api";
import { forgetSession, rememberSession } from "./session-hint";

/**
 * The Better Auth client (docs/frontend/auth_integration.md).
 *
 * `better-auth` is an ordinary npm dependency pinned to 1.6.23 — the exact
 * version the api runs — so route names and payloads cannot drift. It is *not*
 * a workspace import: `apps/web` may import only `@openanalytics/contracts`
 * from this repo (D-218), and `@openanalytics/auth` is a server package with no
 * client export.
 *
 * The session cookie is HttpOnly and host-only on the api origin, so there is
 * no server-side session: a Next Server Component's request never carries the
 * cookie. Everything that needs identity is a Client Component using
 * `useSession()`.
 */
export const authClient = createAuthClient({
  // No basePath — the client appends "/api/auth" to this itself.
  baseURL: API_BASE_URL,
  // The login card's email path is `/sign-in/magic-link`; the server half is
  // the `magicLink` plugin in packages/auth. Both halves are pinned to the
  // same better-auth version, so the route and payload cannot drift.
  plugins: [magicLinkClient()],
});

/**
 * `signUp` is deliberately not re-exported. There is no sign-up screen and
 * there will not be one (product decision, 2026-07-26) — the providers create
 * the account on their first callback. The api still exposes
 * `/sign-up/email`; what is gone is the way in from this app.
 */
export const { signIn } = authClient;

/**
 * `authClient.useSession`, plus the one side effect the app needs: keeping
 * the session hint in step with the answer, so `/login` can act on it before
 * it paints (`lib/session-hint.ts`). Every screen that asks about the session
 * therefore keeps the hint honest, without a single caller having to know it
 * exists.
 *
 * Only a *confirmed* answer moves the hint. A thrown fetch, a 5xx or a
 * refused preflight is the api being unreachable, not a signed-out user, and
 * clearing on those would let one api hiccup reintroduce the flash the hint
 * exists to remove. Same distinction `SessionGate` draws before it bounces.
 */
export function useSession(): ReturnType<typeof authClient.useSession> {
  const result = authClient.useSession();
  const signedIn = result.data !== null && result.data !== undefined;
  const status = (result.error as { status?: number } | null)?.status;
  const confirmedSignedOut =
    !signedIn && (result.error === null || status === 401);

  React.useEffect(() => {
    if (result.isPending) return;
    if (signedIn) rememberSession();
    else if (confirmedSignedOut) forgetSession();
  }, [result.isPending, signedIn, confirmedSignedOut]);

  return result;
}

/**
 * `authClient.signOut`, with the hint dropped first.
 *
 * The ordering is load-bearing: every sign-out handler routes to `/login` the
 * moment this resolves, and a hint still sitting in storage would bounce the
 * user straight back to the dashboard they just left.
 */
export async function signOut(
  ...args: Parameters<typeof authClient.signOut>
) {
  forgetSession();
  return authClient.signOut(...args);
}

/* Errors ------------------------------------------------------------------ */

/**
 * `/api/auth/*` answers with Better Auth's own body — `{ code, message }` — not
 * the `/v1` `ErrorEnvelope`. There is no `request_id` and these codes are not in
 * the contract catalog, so branch on `code` and never on `message`.
 */
export const AUTH_ERROR_CODES = {
  INVALID_EMAIL_OR_PASSWORD: "INVALID_EMAIL_OR_PASSWORD",
  EMAIL_NOT_VERIFIED: "EMAIL_NOT_VERIFIED",
  INVALID_ORIGIN: "INVALID_ORIGIN",
  RESET_PASSWORD_DISABLED: "RESET_PASSWORD_DISABLED",
} as const;

/** The Better Auth failure envelope, narrowed from `unknown`. */
export type AuthErrorBody = {
  code?: string | undefined;
  message?: string | undefined;
  status?: number | undefined;
};

export type AuthFailure = {
  /** `null` when the call never reached the api (network / blocked CORS). */
  code: string | null;
  /** What to put in front of the user. */
  message: string;
  /** True only for `EMAIL_NOT_VERIFIED`, the one branch with a self-service fix. */
  canResendVerification: boolean;
};

function unreachable(): AuthFailure {
  return {
    code: null,
    message:
      `Could not reach the API at ${API_BASE_URL}. It may be down, or this ` +
      `origin may be missing from AUTH_TRUSTED_ORIGINS. A blocked CORS ` +
      `preflight looks exactly like being offline from the browser.`,
    canResendVerification: false,
  };
}

/** Turns a Better Auth `{ code, message, status }` into what the user sees. */
export function presentAuthError(error: AuthErrorBody | null | undefined): AuthFailure {
  if (!error) return unreachable();

  // A response arrived but carried no code — an edge or proxy answered before
  // Better Auth did. Say so; do not guess at a domain reason.
  if (!error.code) {
    return {
      code: null,
      message:
        error.status === undefined
          ? "Sign-in failed. Try again in a moment."
          : `The api answered ${error.status} with no error code. Try again in a moment.`,
      canResendVerification: false,
    };
  }

  switch (error.code) {
    case AUTH_ERROR_CODES.INVALID_EMAIL_OR_PASSWORD:
      // The same code whether the email is unknown or the password is wrong.
      // Do not reword it into "no such account" — that leaks account existence.
      return {
        code: error.code,
        message: "That email and password do not match.",
        canResendVerification: false,
      };
    case AUTH_ERROR_CODES.EMAIL_NOT_VERIFIED:
      // `sendOnSignIn` is off, so the api does not silently resend.
      return {
        code: error.code,
        message:
          "This email is not verified yet. Open the link we sent you, or send a new one.",
        canResendVerification: true,
      };
    case AUTH_ERROR_CODES.INVALID_ORIGIN:
      return {
        code: error.code,
        message:
          "The api rejected this browser origin. Add it to AUTH_TRUSTED_ORIGINS " +
          "on the api host; that one variable drives both the origin check and CORS.",
        canResendVerification: false,
      };
    default:
      return {
        code: error.code,
        message: `Sign-in failed (${error.code}).`,
        canResendVerification: false,
      };
  }
}

/* Social sign-in ---------------------------------------------------------- */

/**
 * A failed provider sign-in never answers with JSON: the OAuth callback
 * redirects the browser to `errorCallbackURL?error=<code>` (plus an optional
 * `error_description`), so the code arrives as a query parameter.
 *
 * Those codes are `lower_snake_case` and are a different vocabulary from the
 * `SCREAMING_SNAKE` ones a JSON call returns — hence a separate map rather than
 * more branches in `presentAuthError`. A plain string comes back, not an
 * `AuthFailure`: `canResendVerification` belongs to the password path, and no
 * provider failure is ever fixed by resending a verification email.
 *
 * Two are worth knowing about:
 *
 * - `access_denied` is sent by the provider, not by us — it is what Google and
 *   GitHub return when the person presses Cancel. Nothing failed, and it must
 *   not be worded as though something did.
 * - `account_not_linked` should not occur on this deployment (linking is
 *   enabled and the local account is email-verified), but it is the one case
 *   whose answer is not "try again".
 */
export function presentOAuthError(
  code: string,
  description?: string | null
): string {
  switch (code) {
    case "access_denied":
      return "Sign-in cancelled. Nothing was changed.";
    case "account_not_linked":
      return (
        "There is already an account for this email, created a different way, " +
        "and this provider is not linked to it yet."
      );
    case "account_already_linked_to_different_user":
      return "This provider account is already linked to a different Open Analytics account.";
    case "email_not_found":
      return (
        "Your provider did not share an email address, and one is required. " +
        "Make your provider email visible, or use the other provider."
      );
    case "unable_to_link_account":
    case "unable_to_get_user_info":
      return "The provider did not return enough to sign you in. Try again, or use the other one.";
    case "oauth_provider_not_found":
      return "This provider is not configured on the api. Its client id and secret are missing.";
    case "no_code":
    case "invalid_code":
    case "no_callback_url":
    case "invalid_callback_request":
      return "That sign-in attempt came back incomplete. Start again.";
    case "state_mismatch":
    case "state_invalid":
      // Almost always the cross-site cookie rule rather than an attack: the
      // api's `SameSite=Lax` state cookie is refused when the app is on a
      // different registrable domain from the api (a localhost dev server, a
      // *.vercel.app preview). Same-site deployments never see this.
      return (
        "Your browser did not keep the sign-in cookie, so we could not finish. " +
        "This happens when the app is served from a different domain than the API."
      );
    case "internal_server_error":
      return "Something went wrong on our side. Try again in a moment.";
    default:
      // An unmapped code is still shown, with whatever the provider explained —
      // silence would leave the person on a login screen that just did nothing.
      return description
        ? `Sign-in failed (${code}): ${description}`
        : `Sign-in failed (${code}).`;
  }
}

/**
 * Narrows a caught `unknown` to the same shape. The client only throws when the
 * request never completed — DNS, a refused connection, or a CORS preflight the
 * browser rejected — so the fallback is the "cannot reach the api" message,
 * which is what those three actually mean from inside a browser.
 */
export function authErrorFromThrown(thrown: unknown): AuthFailure {
  if (typeof thrown === "object" && thrown !== null) {
    const shell = thrown as AuthErrorBody & { error?: AuthErrorBody };
    const body = typeof shell.code === "string" ? shell : shell.error;
    if (body && typeof body.code === "string") {
      return presentAuthError({
        code: body.code,
        message: body.message,
        status: body.status ?? shell.status,
      });
    }
  }
  return unreachable();
}
