import { firstPartyClients, type Auth } from '@openanalytics/auth'
import {
  DEVICE_CODE_GRANT_TYPE,
  READ_SCOPE_DESCRIPTIONS,
  grantScopeDescription,
  grantScopesFromGrant,
  readScopesFromGrant,
  readScopesToGrant,
  type ServiceEnv,
} from '@openanalytics/domain'
import type { Logger } from '@openanalytics/observability'
import type { RequestContextVariables } from '@openanalytics/observability/hono'
import {
  claimApprovedDeviceCode,
  findDeviceAuthorization,
  findOAuthApplicationName,
  issueOAuthAccessToken,
  listSitesForUser,
  type Database,
} from '@openanalytics/postgres'
import { Hono } from 'hono'
import type { RateLimiter } from './rate-limit.ts'

/**
 * The two browser pages an OAuth flow needs, and the one token exchange Better
 * Auth does not provide (ADR-0043 D13 and D14).
 *
 * **These pages are the api's, as minimal HTML, and that is a deliberate
 * reversal of D9.** D9 said the consent screen was `apps/web`'s and named it the
 * one place M16 needs the frontend. That was reversed on 2026-08-06 so the
 * milestone finishes and is proven in production without waiting on a frontend
 * deploy; the reversal is dated in D9's own text, in the form ADR-0039 decision 1
 * established. A designed frontend replaces these later, and *then* they are
 * deprecated — not now.
 *
 * They are plain on purpose: no external stylesheet, no script, no image. A
 * consent screen that cannot render without a CDN is a consent screen that fails
 * closed at the worst moment, and inline-only HTML means the strictest
 * `Content-Security-Policy` a deployment might add still leaves it working.
 *
 * The security properties that are not cosmetic:
 *
 * - **Both POSTs are same-origin only.** The session cookie is `SameSite=Lax` in
 *   production, which would already stop a cross-site form post — but the
 *   pre-launch localhost window sets it to `none`
 *   (`docs/dev/localhost-live-testing.md`), and a device-flow approval screen is
 *   exactly what an attacker wants a logged-in victim to submit: they start a
 *   device authorization, then trick the victim into approving *their* code. The
 *   origin check does not depend on a cookie attribute that is temporarily off.
 * - **Neither page is cached**, and neither carries a code in a place a proxy
 *   logs. The device page takes `user_code` in the query because RFC 8628's
 *   `verification_uri_complete` puts it there and that is the point of it; the
 *   consent page takes `consent_code` the same way because Better Auth's
 *   redirect does.
 * - **Nothing is echoed unescaped.** Client ids, scopes and codes all arrive
 *   from a request.
 */

type Env = { Variables: RequestContextVariables }

export interface OAuthPagesDeps {
  readonly db: Database
  readonly auth: Auth
  readonly env: ServiceEnv<'api'>
  /** Trusted browser origins — the same list the CORS boundary uses. */
  readonly trustedOrigins: readonly string[]
  /** The api's own public origin, which is always an acceptable form origin. */
  readonly selfOrigin: string
  /** `apps/web`'s login page, where a session-less visitor is sent. */
  readonly loginPage: string
  /**
   * The device token endpoint's budget (ADR-0043 D6), charged under two key
   * prefixes on this one object: `device:<device code>` and
   * `device-ip:<address>`. See `createDeviceTokenRoutes` for why there are two
   * and why neither of them is the client id.
   */
  readonly deviceTokenRateLimiter: RateLimiter
  readonly accessTokenExpiresInSeconds: number
  readonly refreshTokenExpiresInSeconds: number
  readonly logger?: Logger
}

/**
 * The three plugin endpoints this file calls, named.
 *
 * `Auth` is `ReturnType<typeof betterAuth>` over a `BetterAuthOptions` whose
 * `plugins` array is the widened library type, so TypeScript cannot see which
 * plugins are configured and `auth.api` carries only the core endpoints.
 * `getSession` typechecks; `deviceApprove` does not.
 *
 * Declaring the shape we depend on — rather than casting each call site to
 * `any` — keeps the coupling visible: if a library upgrade renames one of these,
 * this interface is the one place to change, and a reader can see exactly which
 * three of the plugin's endpoints we reach for.
 */
interface PluginApi {
  /**
   * The plugin's own `/device` status endpoint — and, more importantly, the
   * **claim**: it binds a pending, unclaimed device code to the current
   * session's user.
   *
   * That is not a detail, and it is not optional. `deviceApprove` and
   * `deviceDeny` both refuse a code whose `userId` is null
   * (`DEVICE_CODE_NOT_CLAIMED`) and then refuse one whose `userId` is somebody
   * else's — which together are what stop one signed-in person from answering
   * another's device. Reading the row ourselves and calling approve directly
   * skipped the claim and failed every approval; the fix is to let the library
   * own the ownership rule instead of re-deriving it here.
   */
  deviceVerify(input: {
    query: { user_code: string }
    headers: Headers
  }): Promise<{ user_code: string; status: string }>
  deviceApprove(input: { body: { userCode: string }; headers: Headers }): Promise<unknown>
  deviceDeny(input: { body: { userCode: string }; headers: Headers }): Promise<unknown>
  oAuthConsent(input: {
    body: { accept: boolean; consent_code?: string }
    headers: Headers
  }): Promise<{ redirectURI?: string }>
}

function pluginApi(auth: Auth): PluginApi {
  return auth.api as unknown as PluginApi
}

/** HTML-escape. Every interpolation below goes through it. */
function esc(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;')
}

/**
 * The brand mark, inline. The same geometry `apps/web`'s `Logo` draws (bands
 * clipped to the ring, source of truth: the 2026-08 mark) — inlined rather
 * than imported because this file may not reach across the workspace for a
 * React component, and an `<img>` would be the network request these pages
 * promise not to make. One logo per page, so a static clip id is safe.
 */
const LOGO_MARK = `<svg class="mark" viewBox="0 0 512 512" width="34" height="34" aria-hidden="true"><clipPath id="oa-ring"><path fill-rule="evenodd" clip-rule="evenodd" d="M256 4a252 252 0 1 0 0 504 252 252 0 1 0 0-504Zm0 109a141 141 0 1 1 0 282 141 141 0 1 1 0-282Z"/></clipPath><g clip-path="url(#oa-ring)" fill="#305dde">${[
  4, 36, 68, 100, 132, 164, 196, 228, 260, 292,
]
  .map((y) => `<rect x="0" y="${y}" width="512" height="20"/>`)
  .join('')}<rect x="0" y="324" width="512" height="188"/></g></svg>`

/**
 * The shared page chrome, in the product's own language (redesigned
 * 2026-08-07): the dashboard's grey paper, one white card with the soft
 * radius and hairline the settings panels wear, the brand mark on top, and
 * the brand blue on the one button that says yes.
 *
 * One function so the two screens cannot drift into looking like two
 * products. Light only, deliberately — the product these pages hand a
 * credential to has no dark theme, and an approval screen should look like
 * the thing it unlocks. `system-ui` and nothing else: a webfont would be a
 * network request this page has just promised not to make.
 */
function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<style>
:root { color-scheme: light; --fg: #1f1f1f; --muted: #6d6d6d; --line: #e9e9e9;
  --bg: #f6f6f6; --card: #fff; --primary: #305dde; --secondary: #e9e9e9;
  --ink: #292929; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100svh; display: flex; align-items: center;
  justify-content: center; padding: 1.25rem; background: var(--bg); color: var(--fg);
  font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased; }
main { width: 100%; max-width: 30rem; background: var(--card);
  border: 1px solid var(--line); border-radius: 24px; padding: 1.75rem;
  box-shadow: 0 1px 2px rgba(0,0,0,.06); }
.mark { display: block; margin: 0 0 1.15rem; }
h1 { font-size: 1.2rem; font-weight: 600; letter-spacing: -.01em; margin: 0 0 .4rem; }
p { margin: 0 0 1.1rem; color: var(--muted); text-wrap: pretty; }
ul { margin: 0 0 1.25rem; padding: .3rem; list-style: none; background: var(--bg);
  border-radius: 14px; }
li { padding: .55rem .75rem; font-size: .925rem; }
li + li { border-top: 1px solid #ececec; }
.sub { font-size: .75rem; font-weight: 500; letter-spacing: .05em; text-transform: uppercase;
  color: var(--muted); margin: 0 0 .45rem; }
ul.sites li { display: flex; align-items: baseline; justify-content: space-between; gap: .75rem; }
.dim { color: var(--muted); font-size: .85em; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .95em;
  letter-spacing: .08em; background: var(--bg); padding: .1em .4em; border-radius: 7px;
  color: var(--fg); }
form { display: flex; gap: .5rem; flex-wrap: wrap; }
input { font: inherit; }
input[type=text] { width: 100%; padding: .55rem .75rem; border: 1px solid var(--line);
  border-radius: 12px; background: var(--card); color: var(--fg); margin-bottom: .9rem;
  text-transform: uppercase; letter-spacing: .12em; outline: none; }
input[type=text]:focus { border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(48,93,222,.15); }
input[type=text]::placeholder { text-transform: none; letter-spacing: normal;
  color: #a3a3a3; }
/* The web app's ui/button, transcribed to plain CSS so these pages wear
   the real components: the pill silhouette, the default variant's
   #3a3480-mixed fills and inset bevel on the yes, the secondary greys on
   the no, and the press that dips and shrinks a hair. */
button { font: inherit; font-size: .875rem; font-weight: 500; height: 2.25rem;
  display: inline-flex; align-items: center; justify-content: center;
  padding: 0 .9rem; min-width: 4.5rem; border-radius: 9999px; cursor: pointer;
  border: 1px solid color-mix(in srgb, var(--primary) 80%, #3a3480);
  background: color-mix(in srgb, var(--primary) 90%, #3a3480); color: #fff;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.22), inset 0 -1px 0 rgba(58,52,128,.30);
  transition: background-color .15s, border-color .15s, box-shadow .15s, transform .15s; }
button:hover { background: var(--primary);
  border-color: color-mix(in srgb, var(--primary) 70%, #3a3480); }
button:active { transform: translateY(1px) scale(.98);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.14), inset 0 -1px 0 rgba(58,52,128,.26); }
button:focus-visible { outline: none;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 50%, transparent); }
button[value=deny] { background: var(--secondary); color: var(--ink);
  border-color: transparent; box-shadow: none; }
button[value=deny]:hover { background: color-mix(in srgb, var(--secondary) 95%, var(--ink));
  border-color: transparent; }
button[value=deny]:active { box-shadow: none; }
button[value=deny]:focus-visible { box-shadow: 0 0 0 3px color-mix(in srgb, var(--ink) 25%, transparent); }
.note { font-size: .85rem; margin: 1.15rem 0 0; }
</style>
</head><body><main>${LOGO_MARK}${body}</main></body></html>`
}

/**
 * The device page's scope list, in the words a person can act on (one
 * dictionary, D14). Deliberately the **read** narrowing: the device exchange
 * grants nothing outside `READ_SCOPES` (ADR-0048 D1), so the approval page
 * must not display a scope the exchange would silently drop.
 */
function scopeList(grant: string | null): string {
  const scopes = readScopesFromGrant(grant)
  const items = scopes
    .map((scope) => `<li>${esc(READ_SCOPE_DESCRIPTIONS[scope] ?? scope)}</li>`)
    .join('')
  return `<ul>${items}</ul>`
}

/**
 * The consent page's scope list — the **full** grant vocabulary (ADR-0048 D1),
 * because the authorization-code flow is the one place the OAuth-only scopes
 * can be granted, and the whole point of their names is to be read here.
 * Nothing is folded in: the human approves what the client asked for, not the
 * read arm's implied minimum. A request naming only OIDC scopes still renders
 * an honest sentence rather than an empty box.
 */
function grantScopeList(grant: string | null): string {
  const scopes = grantScopesFromGrant(grant)
  if (scopes.length === 0) {
    return `<ul><li>Confirm who you are — no access to your sites’ data</li></ul>`
  }
  const items = scopes.map((scope) => `<li>${esc(grantScopeDescription(scope))}</li>`).join('')
  return `<ul>${items}</ul>`
}

/**
 * The sites the approval would cover, by name — the concrete version of the
 * scope list's abstract sentence, so a person approves something they can
 * picture rather than a category.
 *
 * **Display, not selection.** The grant is deliberately not site-bound
 * (ADR-0043 D2/D3): every read re-checks live membership, so this list is a
 * photograph of the memberships at approval time and the note under the
 * buttons says how it moves. A per-site checkbox here would promise a
 * restriction the token model does not enforce; if site-scoped grants ever
 * land, they are a token-model decision first and a checkbox second.
 */
function siteList(memberSites: readonly { name: string; slug: string }[]): string {
  if (memberSites.length === 0) {
    return `<p class="sub">You are not a member of any site yet, so there is nothing for it to read today.</p>`
  }
  const items = memberSites
    .map((site) => `<li>${esc(site.name)}<span class="dim">${esc(site.slug)}</span></li>`)
    .join('')
  return `<p class="sub">On these sites</p><ul class="sites">${items}</ul>`
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // These pages carry a code and a session. Framing one is how a clickjack
      // turns an approval button into an invisible overlay.
      'x-frame-options': 'DENY',
      // `same-origin`, not `no-referrer`: the codes these pages carry in their
      // query must not leak cross-site, and same-origin referrers never leave
      // this host — while `no-referrer` made WebKit strip the `Origin` header
      // off the page's own form POST, refusing every genuine Safari approval
      // (production, 2026-08-07; see `isSameSiteForm`).
      'referrer-policy': 'same-origin',
    },
  })
}

/**
 * Is this form post from the page we served?
 *
 * `Origin` is sent on every cross-origin POST by every browser that matters and
 * cannot be forged by page script, which is what makes it the check rather than
 * `Referer` (strippable by referrer policy, and absent often enough to have to be
 * tolerated — tolerating it is what makes it useless as a boundary). A POST with
 * no `Origin` at all is refused rather than allowed: the only clients that omit
 * it are not browsers, and no browser flow reaches these two endpoints without
 * one.
 *
 * **Compared against the request's own URL, not against configuration.** These
 * forms are served by this api and post back to it, so same-origin is a
 * structural fact rather than a setting — and a setting is a thing that can be
 * wrong. The first shape of this compared against `AUTH_BASE_URL` plus the CORS
 * allowlist, and a deployment whose `AUTH_BASE_URL` was unset or trailing-slashed
 * would have refused every genuine approval while still being perfectly
 * functional everywhere else. The configured trusted origins are still accepted,
 * so a future frontend-hosted consent screen posting here keeps working.
 */
function isSameSiteForm(
  request: Request,
  origin: string | undefined,
  alsoAllowed: readonly string[],
): boolean {
  // WebKit, observed in production on 2026-08-07: with `Referrer-Policy:
  // no-referrer` Safari submitted this page's own same-origin POST with
  // `Origin: null`, so every genuine approval was refused. The policy header
  // is now `same-origin` (see `html`), which stops the stripping — and this
  // fallback covers any engine that still withholds the header:
  // `Sec-Fetch-Site` is browser-set and unforgeable by page script, and
  // `same-origin` there is precisely the fact this check exists to establish.
  // A cross-site form post arrives as `cross-site`, never `same-origin`, so
  // the device-flow phishing case stays refused.
  if (!origin || origin.toLowerCase() === 'null') {
    return request.headers.get('sec-fetch-site')?.toLowerCase() === 'same-origin'
  }
  const normalized = origin.toLowerCase()
  if (new URL(request.url).origin.toLowerCase() === normalized) return true
  return alsoAllowed.some((candidate) => candidate.toLowerCase() === normalized)
}

export function createOAuthPageRoutes(deps: OAuthPagesDeps): Hono<Env> {
  const app = new Hono<Env>()
  // Accepted *in addition to* the request's own origin, which is the real
  // check. `selfOrigin` stays in the list because a deployment behind a proxy
  // that rewrites the Host would otherwise see its own page as foreign.
  const alsoAllowed = [deps.selfOrigin, ...deps.trustedOrigins]

  const sessionUser = async (request: Request): Promise<{ id: string; email: string } | null> => {
    const result = await deps.auth.api.getSession({ headers: request.headers })
    return result?.user ? { id: result.user.id, email: result.user.email } : null
  }

  /**
   * Send a session-less visitor to the login page, and back here afterwards.
   *
   * The return URL is rebuilt on `selfOrigin` rather than passed through from
   * `c.req.url`. Behind Caddy the api is reached over plain HTTP, so the request
   * URL's origin is `http://api.getopen.so` — and a `next` pointing at `http://`
   * both leaks the internal scheme and hands the browser a URL that only works
   * because a redirect catches it. Observed in production on the first deploy of
   * this page; the path and query are the request's, the origin is the
   * deployment's own.
   */
  const toLogin = (request: Request): Response => {
    const incoming = new URL(request.url)
    const target = new URL(deps.loginPage)
    target.searchParams.set('next', `${deps.selfOrigin}${incoming.pathname}${incoming.search}`)
    return new Response(null, { status: 302, headers: { location: target.toString() } })
  }

  const refuse = (title: string, message: string, status: number): Response =>
    html(page(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p>`), status)

  /**
   * The device verification page (RFC 8628 §3.3).
   *
   * `user_code` is optional: `verification_uri_complete` supplies it and
   * `verification_uri` does not, and a person who typed the bare URL needs
   * somewhere to type the code.
   */
  app.get('/oauth/device', async (c) => {
    const user = await sessionUser(c.req.raw)
    if (!user) return toLogin(c.req.raw)

    const userCode = c.req.query('user_code')
    if (!userCode) {
      return html(
        page(
          'Connect a device',
          `<h1>Connect a device</h1>
           <p>Enter the code shown in your terminal.</p>
           <form method="get" action="/oauth/device">
             <input type="text" name="user_code" autocomplete="off" autocapitalize="characters"
                    spellcheck="false" required placeholder="XXXX-XXXX" aria-label="Device code">
             <button type="submit">Continue</button>
           </form>`,
        ),
      )
    }

    const device = await findDeviceAuthorization(deps.db, userCode)
    if (!device) {
      return refuse('Unknown code', 'That code is not one we are waiting for.', 404)
    }
    if (device.expiresAt.getTime() <= Date.now()) {
      return refuse('Code expired', 'That code has expired. Start again in your terminal.', 410)
    }
    if (device.status !== 'pending') {
      return refuse(
        'Already answered',
        `That code was already ${device.status === 'approved' ? 'approved' : 'denied'}.`,
        409,
      )
    }

    // Claim it for this session before rendering. The library's ownership rule
    // starts here: a code claimed by one signed-in person cannot be answered by
    // another, and `deviceApprove` refuses an unclaimed one outright.
    try {
      await pluginApi(deps.auth).deviceVerify({
        query: { user_code: device.userCode },
        headers: c.req.raw.headers,
      })
    } catch (error) {
      deps.logger?.warn('oauth_device_claim_failed', { err: error, retryable: false })
      return refuse('Already claimed', 'That code is being answered somewhere else.', 409)
    }

    const memberSites = await listSitesForUser(deps.db, user.id)
    return html(
      page(
        'Connect a device',
        `<h1>Connect a device</h1>
         <p>Signed in as ${esc(user.email)}. A device using the code
            <code>${esc(device.userCode)}</code> is asking to:</p>
         ${scopeList(device.scope)}
         ${siteList(memberSites)}
         <form method="post" action="/oauth/device">
           <input type="hidden" name="user_code" value="${esc(device.userCode)}">
           <button type="submit" name="decision" value="approve">Approve</button>
           <button type="submit" name="decision" value="deny">Deny</button>
         </form>
         <p class="note">The list follows your membership as it changes: a site
            you join later is included, and a site you leave stops being
            readable the moment you leave it.</p>`,
      ),
    )
  })

  app.post('/oauth/device', async (c) => {
    if (!isSameSiteForm(c.req.raw, c.req.header('origin'), alsoAllowed)) {
      // The device-flow phishing case, named: an attacker starts an
      // authorization, then gets a logged-in victim to submit the approval.
      return refuse('Refused', 'This form was submitted from somewhere else.', 403)
    }
    const user = await sessionUser(c.req.raw)
    if (!user) return toLogin(c.req.raw)

    const form = await c.req.parseBody()
    const userCode = typeof form['user_code'] === 'string' ? form['user_code'] : ''
    const decision = form['decision']

    /**
     * **Approve on `approve`, deny on `deny`, and decide nothing otherwise.**
     *
     * The code-entry form is a GET, not a POST, so the only page that posts here
     * is the one that showed the scope list — but "same-origin" is a claim about
     * where a post came from, not about which button made it. Testing only for
     * `deny` and approving everything else meant a post with the field missing,
     * misspelled or carrying any third value granted a device access to somebody
     * else's data, and the origin check cannot see the difference. Anything
     * unrecognized is refused *before* the claim, so the code is left exactly as
     * it was — pending, for the human who was actually asked — rather than
     * denied on their behalf.
     *
     * (The first shape of this used a POST for the code-entry form too and told
     * the two apart by sniffing `Referer`, a header this file's own comment
     * calls unusable as a boundary. That is why the values are read from a
     * button and not from the request's provenance.)
     */
    if (decision !== 'approve' && decision !== 'deny') {
      return refuse(
        'Nothing was decided',
        'That form did not say approve or deny. Open the link from your terminal again.',
        400,
      )
    }

    const device = await findDeviceAuthorization(deps.db, userCode)
    if (!device) return refuse('Unknown code', 'That code is not one we are waiting for.', 404)

    try {
      // Idempotent when this session already claimed it on the GET above, and
      // necessary when it did not: both `deviceApprove` and `deviceDeny` refuse
      // an unclaimed code. It also re-checks expiry and status, so a code that
      // aged out between rendering and submitting is refused here rather than
      // approved.
      await pluginApi(deps.auth).deviceVerify({
        query: { user_code: device.userCode },
        headers: c.req.raw.headers,
      })
      if (decision === 'deny') {
        await pluginApi(deps.auth).deviceDeny({
          body: { userCode: device.userCode },
          headers: c.req.raw.headers,
        })
        return html(page('Denied', `<h1>Denied</h1><p>The device was not given access.</p>`))
      }
      await pluginApi(deps.auth).deviceApprove({
        body: { userCode: device.userCode },
        headers: c.req.raw.headers,
      })
      return html(
        page(
          'Connected',
          `<h1>Connected</h1><p>You can close this page and return to your terminal.</p>`,
        ),
      )
    } catch (error) {
      deps.logger?.warn('oauth_device_decision_failed', { err: error, retryable: false })
      return refuse('Could not complete', 'That code could no longer be answered.', 409)
    }
  })

  /**
   * The consent page, which Better Auth redirects to with `consent_code`,
   * `client_id` and `scope` (the `consentPage` option).
   */
  app.get('/oauth/consent', async (c) => {
    const user = await sessionUser(c.req.raw)
    if (!user) return toLogin(c.req.raw)

    const consentCode = c.req.query('consent_code')
    const clientId = c.req.query('client_id')
    const scope = c.req.query('scope') ?? null
    if (!consentCode) {
      return refuse('Nothing to approve', 'This page was opened without a request.', 400)
    }

    /**
     * The heading names the client, not its id (ADR-0047 D8). A first-party id
     * resolves from configuration; a `dcr_…` id resolves to the name it
     * registered under. The name is registration-supplied and escaped like
     * everything else here — a label for a human decision, not a trust signal;
     * the scope and site lists below stay the substance of what is approved.
     */
    const clientName =
      clientId === undefined
        ? 'An application'
        : (firstPartyClients(deps.env.PRODUCT_NAME).find((client) => client.clientId === clientId)
            ?.name ??
          (await findOAuthApplicationName(deps.db, clientId)) ??
          'An application')

    const memberSites = await listSitesForUser(deps.db, user.id)
    return html(
      page(
        'Authorize',
        `<h1>Authorize ${esc(clientName)}</h1>
         <p>Signed in as ${esc(user.email)}. It is asking to:</p>
         ${grantScopeList(scope)}
         ${siteList(memberSites)}
         <form method="post" action="/oauth/consent">
           <input type="hidden" name="consent_code" value="${esc(consentCode)}">
           <button type="submit" name="decision" value="approve">Allow</button>
           <button type="submit" name="decision" value="deny">Deny</button>
         </form>
         <p class="note">The list follows your membership as it changes: a site
            you join later is included, and a site you leave stops being
            readable the moment you leave it.</p>`,
      ),
    )
  })

  app.post('/oauth/consent', async (c) => {
    if (!isSameSiteForm(c.req.raw, c.req.header('origin'), alsoAllowed)) {
      return refuse('Refused', 'This form was submitted from somewhere else.', 403)
    }
    if (!(await sessionUser(c.req.raw))) {
      return refuse('Signed out', 'Your session ended. Start the authorization again.', 401)
    }

    const form = await c.req.parseBody()
    const consentCode = typeof form['consent_code'] === 'string' ? form['consent_code'] : ''
    const accept = form['decision'] === 'approve'

    try {
      const result = await pluginApi(deps.auth).oAuthConsent({
        body: { accept, consent_code: consentCode },
        headers: c.req.raw.headers,
      })

      // Better Auth answers with where the browser goes next — the client's
      // redirect URI carrying the code, or the same URI carrying
      // `error=access_denied`. Both are the client's to handle.
      if (result.redirectURI) {
        return new Response(null, { status: 303, headers: { location: result.redirectURI } })
      }
      return refuse('Could not complete', 'The authorization could not be completed.', 400)
    } catch (error) {
      deps.logger?.warn('oauth_consent_failed', { err: error, retryable: false })
      return refuse('Could not complete', 'That request has expired. Start again.', 400)
    }
  })

  return app
}

/**
 * The shape a device code can have, judged before any state is touched.
 *
 * The plugin mints 40 alphanumerics (`defaultGenerateDeviceCode`); the range and
 * the alphabet here are the same permissive base64url shape `read-key.ts` uses
 * for an access token, so a `generateDeviceCode` override does not have to come
 * back and edit this. Its job is not to validate — the database does that — but
 * to make an arbitrary-string flood cost neither a query nor a limiter window.
 */
const DEVICE_CODE_SHAPE = /^[A-Za-z0-9_-]{16,128}$/u

/**
 * Best-effort client address, for the ceiling an unresolved caller draws on.
 *
 * **`X-Real-IP` first, which is the other way round from the anonymous budgets
 * in `read-key.ts`, `public-dashboard.ts` and `realtime.ts`** — and the reason is
 * this endpoint's, not a disagreement with theirs. The reverse proxy in front of
 * the api asserts `X-Real-IP` from the connection and strips the platform
 * headers beside it, so it is the one address on this request a caller cannot
 * choose. A key a caller can choose
 * is not a bound at all: a sprayer would prepend a fresh `X-Forwarded-For` entry
 * per request and get a fresh bucket every time, which is precisely what this
 * ceiling exists to deny. The `X-Forwarded-For` fallback keeps a deployment that
 * is not behind that proxy working, read left-most as everywhere else here.
 */
export function clientAddress(request: Request): string {
  const header = request.headers.get('x-real-ip') ?? request.headers.get('x-forwarded-for')
  if (!header) return 'unknown'
  return header.split(',')[0]?.trim() || 'unknown'
}

/**
 * `POST /v1/oauth/device/token` — the one exchange (ADR-0043 D13).
 *
 * Answers RFC 8628's shape, not our `ApiError` envelope: this is an OAuth token
 * endpoint, and a client written against the RFC must be able to read
 * `{ error, error_description }` and branch on `authorization_pending` versus
 * `slow_down`. It sits beside Better Auth's own endpoints, which make the same
 * exception.
 *
 * Unauthenticated by construction — the device code *is* the credential — so it
 * mounts before the business subtree's session guard, for the same reason the
 * read-key surface and the billing webhook do.
 *
 * **Two budgets, one limiter object, and neither of them is the client id.**
 * The first shape of this charged `device:<client id>`, which for the CLI is the
 * constant `oa-cli` — so every device on earth polled one bucket, and at twelve
 * polls a minute each (the RFC interval) about eight simultaneous logins spent
 * it. One person's retry storm answered `slow_down` to everybody else's login,
 * for as long as it lasted. What is charged instead:
 *
 * 1. **`device:<device code>` — the polling budget.** The thing being paced is
 *    one device's poll loop, and the device code is what identifies it: two real
 *    logins can no longer collide, whatever client they claim to be. The code is
 *    itself the credential, so an adversary able to spend its bucket already
 *    holds it and would simply exchange it instead.
 * 2. **`device-ip:<address>` — a ceiling, not a budget.** A per-code key alone
 *    bounds nothing against invented codes: every made-up code is a fresh
 *    bucket. The address is what those requests share, so it is what stops them,
 *    and it is checked *before* the claim so the flood costs no query once the
 *    ceiling is met. It is set well above what any plausible number of genuine
 *    devices behind one NAT can reach (`defaultDeviceTokenLimiter`), because an
 *    address is not a caller — charging real polls to it is only acceptable
 *    while it cannot be the thing that refuses them.
 *
 * Shape is checked before either, so the cheapest flood — arbitrary strings —
 * costs no query *and* no window: the same shape-first ordering `readKeyAuth`
 * uses. Both refusals are RFC 8628's `slow_down` with `Retry-After`, because
 * from the device's side they are the same instruction.
 */
export function createDeviceTokenRoutes(deps: OAuthPagesDeps): Hono<Env> {
  const app = new Hono<Env>()

  const fail = (
    error: string,
    description: string,
    status: number,
    retryAfterSeconds?: number,
  ): Response =>
    new Response(JSON.stringify({ error, error_description: description }), {
      status,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        pragma: 'no-cache',
        ...(retryAfterSeconds === undefined ? {} : { 'retry-after': String(retryAfterSeconds) }),
      },
    })

  app.post('/oauth/device/token', async (c) => {
    const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
    const grantType = body['grant_type']
    const deviceCode = body['device_code']
    const clientId = body['client_id']

    // Everything a request can be judged on without state: the client id, the
    // grant type, and the device code's shape. All three refuse without charging
    // a window and without a query.
    if (typeof clientId !== 'string' || clientId.length === 0) {
      return fail('invalid_request', 'client_id is required', 400)
    }
    if (grantType !== DEVICE_CODE_GRANT_TYPE) {
      return fail('invalid_request', `grant_type must be ${DEVICE_CODE_GRANT_TYPE}`, 400)
    }
    if (typeof deviceCode !== 'string' || deviceCode.length === 0) {
      return fail('invalid_request', 'device_code is required', 400)
    }
    if (!DEVICE_CODE_SHAPE.test(deviceCode)) {
      // Deliberately the answer an unknown code gets, not a shape complaint: a
      // caller must not be able to tell "we would never have issued that" from
      // "we did not issue that", and the device's recovery is the same sentence.
      return fail('invalid_grant', 'Unknown device code', 400)
    }

    // The polling budget, per device code. A device polls every five seconds by
    // design, so this is the plugin's interval expressed as a ceiling rather
    // than a new policy — and it is now that device's ceiling alone.
    const perCode = deps.deviceTokenRateLimiter.check(`device:${deviceCode}`)
    if (!perCode.allowed) {
      return fail('slow_down', 'Polling too frequently', 429, perCode.retryAfterSeconds)
    }

    // The address ceiling, which is what an invented code meets: it gets a fresh
    // per-code window every request and this one is the only key it repeats.
    // Charged before the claim, so a spray stops costing queries.
    const perAddress = deps.deviceTokenRateLimiter.check(`device-ip:${clientAddress(c.req.raw)}`)
    if (!perAddress.allowed) {
      return fail('slow_down', 'Polling too frequently', 429, perAddress.retryAfterSeconds)
    }

    const claim = await claimApprovedDeviceCode(deps.db, { deviceCode, clientId })
    if (!claim.ok) {
      // RFC 8628 §3.5: every one of these is a 400 with a typed body. The device
      // reads the body, not the status — `authorization_pending` is the normal
      // case and arrives hundreds of times per successful login.
      return fail(claim.error, claim.description, 400)
    }

    // The grant is narrowed on the way out, not trusted as stored. A device code
    // carrying a scope this build cannot name — or a scope somebody added to the
    // row directly — becomes the minimum rather than becoming authority.
    const granted = readScopesToGrant(readScopesFromGrant(claim.scope))
    const issued = await issueOAuthAccessToken(deps.db, {
      userId: claim.userId,
      clientId,
      scope: granted,
      accessTokenExpiresInSeconds: deps.accessTokenExpiresInSeconds,
      refreshTokenExpiresInSeconds: deps.refreshTokenExpiresInSeconds,
    })

    deps.logger?.info('oauth_device_token_issued', { client_id: clientId, scope: granted })

    return new Response(
      JSON.stringify({
        access_token: issued.accessToken,
        token_type: 'Bearer',
        expires_in: issued.expiresInSeconds,
        refresh_token: issued.refreshToken,
        scope: issued.scope,
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          pragma: 'no-cache',
        },
      },
    )
  })

  return app
}
