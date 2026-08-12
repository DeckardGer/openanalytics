/**
 * A hint that this browser had a session, so `/login` can get out of the way
 * before it paints.
 *
 * The session cookie is HttpOnly and host-only on the api origin, so nothing
 * on this host can read it: not middleware, not a Server Component, not this
 * script. The only way to know is to ask the api, and that is a round trip.
 * Until it answered, `/login` rendered its card, which is why a signed-in
 * visitor saw the form flash before the redirect landed.
 *
 * This is that missing knowledge, kept somewhere the app host can read
 * synchronously. It is a *hint* and never authorization: it says "this
 * browser signed in at some point", and the api still decides. A stale hint
 * costs one bounce through `/dashboard`, which checks properly and sends the
 * visitor back with the hint cleared.
 *
 * Deliberately not a cookie: a cookie readable here would have to be set on
 * the parent domain by the api, which is a real change to the auth surface
 * for a cosmetic win. localStorage is the app's own, and being unavailable
 * (private mode) costs the flash back, nothing more.
 */

/** Set while a confirmed session exists; cleared on a confirmed sign-out. */
export const SESSION_HINT_KEY = "oa:session-hint:v1";

/**
 * Per-tab guard: the pre-paint redirect fires at most once per tab, so a
 * hint that outlives its session can never become a `/login` ↔ `/dashboard`
 * loop. Cleared whenever a real session is confirmed, so signing back in
 * inside the same tab re-arms it.
 */
export const SESSION_HINT_TRIED_KEY = "oa:session-hint:tried";

export function rememberSession(): void {
  try {
    localStorage.setItem(SESSION_HINT_KEY, "1");
    sessionStorage.removeItem(SESSION_HINT_TRIED_KEY);
  } catch {
    /* Private mode has no storage. The hint is an optimisation, never a
       requirement, so failing to write it is not an error worth raising. */
  }
}

export function forgetSession(): void {
  try {
    localStorage.removeItem(SESSION_HINT_KEY);
    sessionStorage.removeItem(SESSION_HINT_TRIED_KEY);
  } catch {
    /* as above */
  }
}

/**
 * Whether this browser remembers a session, for the render that has to decide
 * what to draw before the api has answered.
 *
 * Returns `false` wherever storage is unavailable, which is the same answer
 * as "no hint" and the same answer the server gives — a private-mode browser
 * simply sees what it saw before any of this existed.
 */
export function hasSessionHint(): boolean {
  try {
    return localStorage.getItem(SESSION_HINT_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * The hint, read before anything paints: sends a returning visitor from
 * `/login` to `/dashboard` while the login card is still a plan rather than
 * pixels.
 *
 * An inline script rather than an effect, because an effect runs after the
 * first paint and the paint is the whole problem. It ships from the **root
 * layout**, which is the only place a document-level script belongs in this
 * router: `beforeInteractive` is documented as root-layout-only, and a
 * `<script>` rendered inside a page is inserted by React on a client-side
 * navigation and never executed — the browser only runs what the HTML parser
 * meets. Hence the path check inside the script; the layout cannot do it,
 * because reading the path on the server would make every page dynamic.
 *
 * Four guards keep a wrong memory cheap: it acts on `/login` and nowhere
 * else; a failed callback (`?error=`) is never skipped past, since that
 * visitor is here to read the error; the redirect fires once per tab; and
 * `/dashboard` checks the session properly and clears the hint on its way
 * back, so a stale hint costs one bounce and then stops being stale.
 */
export const SESSION_HINT_SCRIPT = `(function(){try{
if(location.pathname!=="/login")return;
if(location.search.indexOf("error")!==-1)return;
if(!localStorage.getItem(${JSON.stringify(SESSION_HINT_KEY)}))return;
if(sessionStorage.getItem(${JSON.stringify(SESSION_HINT_TRIED_KEY)}))return;
sessionStorage.setItem(${JSON.stringify(SESSION_HINT_TRIED_KEY)},"1");
location.replace("/dashboard");
}catch(e){}})();`;
