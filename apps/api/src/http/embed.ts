import { isWidgetOrigin, WIDGET_ORIGIN_WILDCARD } from '@openanalytics/domain'
import { resolvePublicWidget, type Database } from '@openanalytics/postgres'
import type { RequestContextVariables } from '@openanalytics/observability/hono'
import { Hono } from 'hono'
import type { RateLimiter } from './rate-limit.ts'
import { widgetBudgetKey } from './widget-public.ts'

/**
 * The embed vehicle: `GET /embed/{widget_id}` (ADR-0045, CP3).
 *
 * The document CP2's JSON read is drawn into. It renders nothing server-side —
 * it ships a widget id, fetches `/v1/widget/{id}` same-origin on load, and draws
 * whatever comes back — so the only thing this module decides is the *policy*
 * around that document.
 *
 * **Why the api serves it, rather than `app.getopen.so`.** D13 states this as
 * forced rather than preferred: D4 requires the document to answer
 * `Content-Security-Policy: frame-ancestors` from the widget's own
 * `allowed_origins`, and that list lives only on the widget row — it is
 * deliberately absent from the public read, so a frontend-served page could
 * never emit the header without a second, wider disclosure. Serving the document
 * where the row is follows ADR-0043 D14's precedent (the consent and device pages
 * are the api's own minimal self-contained HTML), and it buys a structural
 * simplification: the document and the JSON read are **the same origin**, so the
 * iframe path needs no CORS at all. D4's `Access-Control-Allow-Origin` answer
 * exists for the later script vehicle and for server-side renderers, not for this.
 *
 * It sits at the api root beside `/oauth/*`. An HTML document does not belong
 * under the `/v1` JSON surface, and the ADR pins the path because it is baked
 * into `embed_url` and into every snippet a customer has already pasted.
 *
 * **The document now wears the frontend's design** (the "Ledger" language,
 * 2026-08-08) — docs snapshot 02 §20 makes visual types the frontend's, and
 * this is that ownership exercised: the design changed in place, and the id,
 * the JSON read, the CSP and the snippet did not move (D6). What the backend
 * still owes is unchanged: a working, self-contained, policy-bearing frame.
 */

type Env = { Variables: RequestContextVariables }

export interface WidgetEmbedDeps {
  readonly db: Database
  /**
   * **The JSON read's own limiter object**, not a second one (ADR-0045, D5 as
   * amended 2026-08-07).
   *
   * This door is anonymous and performs a Postgres read per request, and no
   * other public route on this api is unlimited — §20 puts a rate limit on the
   * widget *endpoints*, plural. Charging the same instance through the same
   * `widgetBudgetKey` means there is no second budget to reason about and no
   * second number to configure: a full first paint costs **two** tokens of the
   * 120/minute (IP, widget id) budget — this document, and the one JSON read it
   * makes — and the realtime poll loop afterwards touches only the JSON, so
   * D5's ~30-simultaneous-tab arithmetic is unchanged in steady state.
   */
  readonly rateLimiter: RateLimiter
  /**
   * `Cache-Control: public, max-age=…` on the document — the **same**
   * `WIDGET_READ_CACHE_MAX_AGE_SECONDS` the JSON read uses on its seven
   * historical surfaces, realtime widgets included.
   *
   * One number, one story (D12). The document's CSP *is* a projection of
   * `allowed_origins`, so a document that outlived the answer it frames would
   * mean an owner who removed an origin is told 60 seconds and gets longer. A
   * realtime widget is no different here: the data's ten-second bound is the
   * JSON's concern, and this document is static whatever it ends up drawing.
   */
  readonly cacheMaxAgeSeconds: number
  /**
   * Where the footer watermark points (`WIDGET_WATERMARK_URL`).
   *
   * A hardcoded `https://getopen.so/?utm_source=widget` until the open-core
   * split, which is the one place an embedded document named its host
   * deployment. Absent, the footer renders the same line with no link at all —
   * the honest degradation, because a self-hosted install has no marketing page
   * this file could know about, and a link back to the dashboard would send a
   * customer's readers somewhere they cannot go.
   */
  readonly watermarkUrl?: string
}

/**
 * The contract's `WidgetId` pattern, mirrored (as `widget.ts` mirrors
 * `WidgetOrigin`).
 *
 * Belt and braces: the route parameter has already matched by the time this
 * runs, but the id is the one caller-supplied string in this document and it
 * lands inside a JavaScript string literal. A pattern of `a-z0-9` only —
 * checked *here*, immediately before interpolation, rather than trusted from
 * three frames up — is what makes that literal unescapable rather than escaped.
 * It also means a malformed id is refused **without a database read**: an
 * unauthenticated path that queries on any string a stranger types is a path
 * that can be made to query.
 */
const WIDGET_ID_PATTERN = /^w[a-z0-9]{10,31}$/u

/**
 * The four directives that say what this document may do, independent of who may
 * frame it. Each one is a promise the document below actually keeps:
 *
 * - `default-src 'none'` — nothing loads unless a directive below says so. This
 *   is the whole self-containment claim in one word.
 * - `script-src 'unsafe-inline'` — the one inline `<script>` and nothing else.
 *   No `'unsafe-eval'`, no host, no `src`: there is no second script to load and
 *   no origin it could come from. (`'unsafe-inline'` rather than a nonce or a
 *   hash because the document is byte-identical across requests and therefore
 *   cacheable for `max-age` seconds — a per-response nonce is exactly the thing
 *   a shared cache must not reuse, and D12 chose the cache.)
 * - `style-src 'unsafe-inline'` — the one inline `<style>`, for the same reason.
 * - `connect-src 'self'` — the one `fetch`, to our own `/v1/widget/{id}`. Not a
 *   host list: 'self' is the document's origin, which is the api's, which is
 *   where the JSON read is. A document that could talk to nothing else cannot be
 *   turned into an exfiltration channel by anything it renders.
 *
 * Deliberately absent: `img-src`, `font-src`, `form-action`, `base-uri`. The
 * first two are already `'none'` by `default-src` and naming them would suggest
 * a loosening; the last two guard against markup this document does not contain
 * — but `default-src` does not cover `base-uri` or `form-action`, so they are
 * mentioned here rather than silently assumed. There is no `<base>`, no `<form>`,
 * and no injection point that could add one: the body is a constant.
 */
const SELF_CONTAINED_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'"

/**
 * `frame-ancestors`, in CSP source-list syntax: sources separated by **spaces**,
 * inside one directive (the semicolon separates directives, not sources).
 *
 * Three shapes, one per shape an allowlist can take (D4):
 *
 * - **empty → `'none'`**, quoted, because `'none'` is a CSP keyword and an
 *   unquoted `none` would be read as a host named "none". An empty list renders
 *   nowhere: an embed is made for a page the owner is looking at, and the
 *   direction an omission must fail in is closed.
 * - **`["*"]` → `*`**, unquoted, because the wildcard is not a keyword. It is
 *   accepted only alone (the write path enforces that), and it is a sentence the
 *   owner had to write.
 * - **otherwise → the origins themselves**, each a `scheme://host[:port]`
 *   host-source, which is exactly what the stored entries are. No port means
 *   *the default port only* in CSP, which matches how a browser serializes
 *   `Origin` — the same reason `isWidgetOrigin` refuses `https://x:443` at the
 *   write.
 *
 * **Every entry is re-validated here**, and one that is not an origin is dropped
 * rather than emitted. The write path already refuses such a row, so this cannot
 * fire today; it is here because a CSP is a *header*, and a stored
 * `evil.example.com; script-src *` would not name a bad ancestor — it would
 * append a directive and undo everything above it. If a list drops to empty, it
 * becomes `'none'`: the failure of a policy is not the absence of one.
 */
function frameAncestors(allowedOrigins: readonly string[]): string {
  if (allowedOrigins.length === 1 && allowedOrigins[0] === WIDGET_ORIGIN_WILDCARD) {
    return '*'
  }
  const sources = allowedOrigins.filter((origin) => isWidgetOrigin(origin))
  return sources.length > 0 ? sources.join(' ') : "'none'"
}

/**
 * The two refusals, in HTML.
 *
 * **`404`** is D7's, one minimal document **byte-identical for every cause**: an
 * invented id, a malformed one, a widget that was deleted, `enabled: false`, and
 * a site that is `suspended`, `deleting` or `deleted`. A widget id sits in
 * the HTML of a page anyone can view, so a distinguishable "this site stopped
 * paying" would publish a customer's billing state to their own readers — the
 * JSON read's argument, one vehicle up.
 *
 * **`429`** is the shared budget's (D5, as amended). It exists as a *page* rather
 * than as the JSON envelope the other door answers for one reason: this response
 * lands in an `<iframe>`, and a browser asked to render `{"error":{"code":…}}`
 * paints raw JSON on somebody else's page. `Retry-After` is the same value and
 * the same decision the JSON door sets.
 *
 * What both deliberately do *not* do:
 *
 * - **No `frame-ancestors`.** Not because there is nothing to protect (there
 *   isn't — both pages are constants), but because the only list they could
 *   project is the refused widget's, which would turn a refusal into an oracle
 *   for "this origin is on some widget's list" — and the `429` is answered
 *   *before* the row is read, so there is no list to project in the first place.
 *   A constant policy for a constant page. The consequence is deliberate and
 *   mild: a reader of a page carrying a just-disabled widget sees our quiet box
 *   rather than a browser's framing error, which is the better of the two on
 *   somebody else's page.
 * - **No caching.** `no-store`, where the JSON read simply omits the header.
 *   HTML gets the stronger form because a document with no freshness information
 *   is *heuristically* cacheable, and a refusal cached in a reader's tab would
 *   shadow the widget its owner has just re-enabled — or outlive a rate-limit
 *   window that resets in seconds. A refusal is not an answer.
 * - **No script and no fetch**, so the CSP is `default-src 'none'` plus the one
 *   inline `<style>` — narrower than the document's, and the narrowest either
 *   page can be given while still looking like a page.
 */
const REFUSAL_CSP = "default-src 'none'; style-src 'unsafe-inline'"

const REFUSAL_STYLE = `<style>
/* No color-scheme declaration, deliberately: when an embedded document's used
   color-scheme differs from the host's iframe element, the browser paints an
   opaque canvas behind the page — a white box leaking past our rounded border
   on every host that declares nothing. "normal" on both sides keeps the iframe
   truly transparent; the dark palette rides prefers-color-scheme regardless. */
:root { --fg: #111; --bg: #fff; --muted: #6b6b6b; --edge: #e5e5e5; }
@media (prefers-color-scheme: dark) { :root { --fg: #f2f2f2; --bg: #121212; --muted: #9a9a9a; --edge: #2e2e2e; } }
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; overflow: hidden; }
html { background: transparent; }
body { display: grid; place-items: center; background: var(--bg); color: var(--muted);
  border: 1px solid var(--edge); border-radius: 12px;
  font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
</style>`

function refusalPage(message: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${message}</title>
${REFUSAL_STYLE}
</head><body><p>${message}</p></body></html>`
}

const NOT_FOUND_PAGE = refusalPage('Not found')
const RATE_LIMITED_PAGE = refusalPage('Too many requests')

function refusal(
  body: string,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': REFUSAL_CSP,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...extraHeaders,
    },
  })
}

function notFound(): Response {
  return refusal(NOT_FOUND_PAGE, 404)
}

/**
 * The two palettes, hoisted out of the stylesheet so a theme can choose one
 * without a media query standing over it.
 */
const LIGHT_PALETTE =
  '--bg: #fbfbf9; --fg: #3a3a35; --muted: #8b8b83; --faint: #a1a19a; --hair: #dddcd4; --leader: #d5d4cb; --rank: #b8b8b0; --wm: #b5b5b5; --ring: #305dde; --bar: rgba(58, 58, 53, .75); --live: #2f9e63; --edge: #e3e3de;'
const DARK_PALETTE =
  '--bg: #1b1b19; --fg: #d8d8d0; --muted: #8f8f88; --faint: #7c7c75; --hair: #34342f; --leader: #3c3c36; --rank: #57574f; --wm: #6a6a63; --ring: #6b8ef0; --bar: rgba(216, 216, 208, .72); --live: #3fb573; --edge: #34342f;'

/**
 * `?theme=` — which palette the embed wears.
 *
 * `auto` is the default and is exactly what the widget did before this
 * existed: the light palette, with the dark one riding
 * `prefers-color-scheme`. That is right when the host page follows the
 * visitor's system too, and wrong the moment it does not — a site that is
 * light for everybody hands a dark-mode visitor a dark card, and the host
 * cannot correct it, because CSS does not cross an origin. Neither does
 * `color-scheme` on the iframe element: it changes what the browser paints
 * *behind* the frame, not what `prefers-color-scheme` matches inside it, so
 * the one lever a host appears to have does nothing here (measured on the
 * marketing site, 2026-08-11).
 *
 * Hence a parameter, which is what every badge of this kind carries.
 * Unknown values fall back to `auto` rather than failing: a typo in a
 * customer's HTML should leave the widget looking like it always did.
 */
export type WidgetTheme = 'auto' | 'light' | 'dark'

function themeFrom(value: string | undefined): WidgetTheme {
  return value === 'light' || value === 'dark' ? value : 'auto'
}

function paletteRules(theme: WidgetTheme): string {
  if (theme === 'light') return `:root { ${LIGHT_PALETTE} }`
  if (theme === 'dark') return `:root { ${DARK_PALETTE} }`
  return `:root { ${LIGHT_PALETTE} }
@media (prefers-color-scheme: dark) { :root { ${DARK_PALETTE} } }`
}

/**
 * `?frame=` — whether the card draws its own surface.
 *
 * `card` is the default and the shape the design was drawn in. `none` drops
 * the background, the hairline and the corners, leaving type and rules on a
 * transparent page, for a host that would rather the numbers sat in its own
 * layout than in a box. It is a second rule rather than a rewritten one so
 * the default path emits byte-for-byte what it always did.
 */
export type WidgetFrame = 'card' | 'none'

function frameFrom(value: string | undefined): WidgetFrame {
  return value === 'none' ? 'none' : 'card'
}

function frameRules(frame: WidgetFrame): string {
  if (frame === 'card') return ''
  return '\nbody { background: transparent; border: 0; border-radius: 0; }'
}

/**
 * The widget document.
 *
 * Everything below the `<script>` is a **constant**: the only interpolations in
 * the whole page are the widget id, checked against `WIDGET_ID_PATTERN`
 * immediately above, the watermark URL, which is operator configuration
 * validated as a URL by the environment schema, and the two presentation
 * switches below, each of which is narrowed to a fixed set of literals before
 * it arrives. Nothing the owner typed and nothing a visitor caused — the
 * title, page paths, referrer domains, city names — is in the markup at all.
 * They arrive in the JSON and are written with `textContent`, which is the
 * one escaping rule a later edit cannot get wrong: a `<script>` in a page
 * title is a page title that reads `<script>`.
 *
 * `system-ui` and nothing else, `320px` and nothing taller: the snippet fixes
 * `height="320"` and there is no auto-height handshake in v1, so the layout is
 * built to fit that box and to clip rather than scroll what does not.
 */
function document(
  widgetId: string,
  watermarkUrl: string,
  theme: WidgetTheme = 'auto',
  frame: WidgetFrame = 'card',
): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Analytics</title>
<style>
/* The Ledger language (the frontend's chosen design, 2026-08-08): quiet
   sentence-case header, dashed rules, mono numerals with dotted leaders,
   the watermark at the foot. Light and dark are both this design.

   No color-scheme declaration, deliberately: when an embedded document's used
   color-scheme differs from the host's iframe element, the browser paints an
   opaque canvas behind the page — a white box leaking past our rounded border
   on every host that declares nothing. "normal" on both sides keeps the iframe
   truly transparent; which palette is worn is the ?theme= switch, above. */
${paletteRules(theme)}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; overflow: hidden; }
/* The card owns its own frame: hairline edge, 12px corners, and a
   transparent page behind it so the host's background shows through the
   rounding instead of our rectangle poking out of it. */
html { background: transparent; }
body { background: var(--bg); color: var(--fg); border: 1px solid var(--edge); border-radius: 12px; font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }${frameRules(frame)}
main { height: 100%; padding: 16px 18px; display: flex; flex-direction: column; overflow: hidden; }
.mono, .stat b, .rows li, .big, .total, .axis { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
.head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
h1 { font-size: 13px; font-weight: 500; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.interval { flex-shrink: 0; font-size: 12px; color: var(--faint); }
.rule { border-top: 1px dashed var(--hair); margin-top: 10px; }
.body { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; padding-top: 10px; }
.foot { display: flex; align-items: center; gap: 6px; margin: 0; padding-top: 8px; font-size: 11px; color: var(--wm); text-decoration: none; width: fit-content; }
.foot:hover { color: var(--muted); }
.foot svg { color: var(--ring); }
.muted { color: var(--muted); margin: 0; }
.center { flex: 1; display: grid; place-items: center; }
.stats { flex: 1; min-height: 0; display: flex; flex-direction: column; justify-content: center; }
.stat { display: flex; align-items: baseline; gap: 10px; padding: 8px 0; font-size: 13px; }
.stat span { color: var(--muted); white-space: nowrap; }
.stat i { flex: 1; border-bottom: 1px dotted var(--leader); margin: 0 4px; }
.stat b { font-size: 15px; font-weight: 400; }
.big { font-size: 64px; font-weight: 400; line-height: 1; }
.live { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; }
.livelabel { display: flex; align-items: center; gap: 8px; font-size: 11px; text-transform: uppercase; letter-spacing: .18em; color: var(--muted); }
.dot { width: 8px; height: 8px; background: var(--live); animation: pulse 2s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
.rows { list-style: none; margin: 0; padding: 0; overflow: hidden; flex: 1; min-height: 0; display: flex; flex-direction: column; justify-content: center; }
.rows li { display: flex; align-items: baseline; gap: 10px; padding: 6px 0; font-size: 12.5px; }
.rows li b { color: var(--rank); font-weight: 400; }
.rows li span:first-of-type { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.rows li i { flex: 1; border-bottom: 1px dotted var(--leader); margin: 0 4px; }
.rows li span:last-child { color: var(--muted); }
.chartwrap { flex: 1; min-height: 0; display: flex; flex-direction: column; justify-content: flex-end; gap: 8px; }
.total { font-size: 22px; }
.total span { font: 11px system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--muted); margin-left: 6px; }
.chart { height: 118px; width: 100%; border-bottom: 1px solid var(--leader); }
.axis { display: flex; justify-content: space-between; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--faint); }
</style>
</head><body>
<main id="oa"><p class="muted center">…</p></main>
<script>
(function () {
  // The whole credential, and the whole request: the read takes no parameters,
  // because everything it needs is stored configuration (ADR-0045, D10).
  var ID = '${widgetId}';
  // Where the footer mark points, or '' for a footer that is not a link
  // (WIDGET_WATERMARK_URL). Deliberately not derived from the api's own origin:
  // the mark names the product, and which page that is belongs to whoever runs
  // this deployment.
  var WATERMARK_URL = '${watermarkUrl}';
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var root = window.document.getElementById('oa');
  var surface = null;

  // Every element in this document is built here, and every string goes in as
  // textContent. No markup-parsing assignment appears anywhere in this script,
  // and a test asserts that by name: paths, referrer domains and city names are
  // visitor-supplied strings, and a title is owner-supplied.
  function el(tag, cls, text) {
    var node = window.document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function num(value) {
    var n = Number(value);
    return isFinite(n) ? n.toLocaleString() : '0';
  }

  function duration(ms) {
    var total = Math.round((Number(ms) || 0) / 1000);
    var minutes = Math.floor(total / 60);
    var seconds = total % 60;
    return minutes > 0 ? minutes + 'm ' + seconds + 's' : seconds + 's';
  }

  function percent(fraction) {
    return Math.round((Number(fraction) || 0) * 100) + '%';
  }

  // The window as the owner's dashboard names it — same keys, same words.
  var RANGE_LABEL = {
    today: 'Today', yesterday: 'Yesterday', '24h': 'Last 24 hours',
    '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days',
    '6mo': 'Last 6 months', '12mo': 'Last 12 months', all: 'All time'
  };

  // "Jul 09" — in the zone the data was cut in, never the reader's.
  function axisDate(iso, timezone) {
    try {
      return new Intl.DateTimeFormat('en-US', {
        month: 'short', day: '2-digit', timeZone: timezone
      }).format(new Date(iso));
    } catch (error) {
      return '';
    }
  }

  var regionNames;
  function countryName(code) {
    try {
      regionNames = regionNames || new Intl.DisplayNames(['en'], { type: 'region' });
      return regionNames.of(code) || code;
    } catch (error) {
      return code;
    }
  }

  function show(children) {
    while (root.firstChild) root.removeChild(root.firstChild);
    for (var i = 0; i < children.length; i++) root.appendChild(children[i]);
  }

  // Every non-200 lands here — a revoked widget, a blocked site, the
  // RESOLUTION_NOT_AVAILABLE an 'all' range answers on a site with no events yet
  // (ADR-0045 D10's correction), a network failure. A reader of somebody else's
  // page gets a quiet blank, never a status code and never an error dump.
  function empty() {
    show([el('p', 'muted center', 'No data')]);
  }

  // A leader row: label, a dotted line, the value in mono. The label is the
  // only <span> and the value the only <b>, which is what keeps "what does a
  // reader see" assertable by tag.
  function stat(label, value) {
    var box = el('div', 'stat');
    box.appendChild(el('span', null, label));
    box.appendChild(el('i'));
    box.appendChild(el('b', null, value));
    return box;
  }

  function stats(pairs) {
    var wrap = el('div', 'stats');
    for (var i = 0; i < pairs.length; i++) wrap.appendChild(stat(pairs[i][0], pairs[i][1]));
    return wrap;
  }

  // A ranked row: the rank is a <b> on purpose, so the row's first <span> is
  // still the visitor-supplied name.
  function rows(items, label, value) {
    var list = el('ul', 'rows');
    for (var i = 0; i < items.length; i++) {
      var li = window.document.createElement('li');
      li.appendChild(el('b', null, (i + 1 < 10 ? '0' : '') + (i + 1)));
      li.appendChild(el('span', null, label(items[i])));
      li.appendChild(el('i'));
      li.appendChild(el('span', null, num(value(items[i]))));
      list.appendChild(li);
    }
    return list;
  }

  // A bar per bucket, scaled to the tallest. Page views on purpose: buckets
  // add, so the headline sum above the bars describes the same metric —
  // summing per-bucket *visitors* would overcount uniques. The namespace
  // string above is an identifier, not a URL this document ever requests.
  function chart(series) {
    var svg = window.document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'chart');
    svg.setAttribute('viewBox', '0 0 100 40');
    svg.setAttribute('preserveAspectRatio', 'none');
    var max = 0;
    for (var i = 0; i < series.length; i++) max = Math.max(max, Number(series[i].pageviews) || 0);
    if (max === 0) max = 1;
    var step = 100 / series.length;
    for (var j = 0; j < series.length; j++) {
      var height = (Number(series[j].pageviews) || 0) / max * 40;
      var bar = window.document.createElementNS(SVG_NS, 'rect');
      bar.setAttribute('x', String(j * step + step * 0.15));
      bar.setAttribute('y', String(40 - height));
      bar.setAttribute('width', String(Math.max(step * 0.7, 0.4)));
      bar.setAttribute('height', String(height));
      bar.setAttribute('fill', 'var(--bar)');
      svg.appendChild(bar);
    }
    return svg;
  }

  function timeseries(data) {
    if (!data.series.length) return el('p', 'muted center', 'No data');
    var wrap = el('div', 'chartwrap');
    var sum = 0;
    for (var i = 0; i < data.series.length; i++) sum += Number(data.series[i].pageviews) || 0;
    var total = el('p', 'total', num(sum));
    total.appendChild(el('span', null, 'page views'));
    wrap.appendChild(total);
    wrap.appendChild(chart(data.series));
    var meta = data.meta || {};
    var range = meta.effective_range || {};
    var axis = el('div', 'axis');
    axis.appendChild(el('span', null, axisDate(range.from, meta.timezone)));
    axis.appendChild(el('span', null, axisDate(range.to, meta.timezone)));
    wrap.appendChild(axis);
    return wrap;
  }

  function draw(widget, data) {
    if (!data) return el('p', 'muted center', 'No data');
    switch (widget.surface) {
      case 'overview':
        return stats([
          ['Visitors', num(data.totals.visitors)],
          ['Pageviews', num(data.totals.pageviews)],
          ['Events', num(data.totals.events)]
        ]);
      case 'sessions':
        return stats([
          ['Sessions', num(data.totals.sessions)],
          ['Engaged', num(data.totals.engaged_sessions)],
          ['Avg. duration', duration(data.totals.avg_session_duration_ms)],
          ['Bounce rate', percent(data.totals.bounce_rate)]
        ]);
      case 'timeseries':
        return timeseries(data);
      case 'realtime':
        var live = el('div', 'live');
        live.appendChild(el('div', 'big', num(data.active_visitors)));
        var label = el('p', 'livelabel');
        label.appendChild(el('i', 'dot'));
        label.appendChild(el('span', null, 'visitors on site'));
        live.appendChild(label);
        return live;
      case 'pages':
        return rows(data.items, function (r) { return r.page_path; }, function (r) { return r.visitors; });
      case 'sources':
        return rows(data.items, function (r) { return r.referrer_domain || 'Direct'; }, function (r) { return r.visitors; });
      case 'devices':
        return rows(data.items, function (r) { return r.browser || r.device_type || 'Unknown'; }, function (r) { return r.visitors; });
      case 'geography':
        return rows(data.items, function (r) { return r.city || countryName(r.country) || 'Unknown'; }, function (r) { return r.visitors; });
      default:
        // A surface this build has never heard of renders nothing rather than a
        // half-drawn guess.
        return el('p', 'muted center', 'No data');
    }
  }

  // The Ledger frame's constant parts: the dashed rule and the watermark.
  // The watermark names the instrument without naming whose site this is — the
  // owner's identity stays opt-in (ADR-0044) and their title remains the only
  // owner-authored label. Where it points is the deployment's, not this file's:
  // WATERMARK_URL is interpolated from WIDGET_WATERMARK_URL, and unset it is the
  // empty string, which renders the same line as text with no link at all.
  function rule() {
    return el('div', 'rule');
  }

  function foot() {
    var mark = el(WATERMARK_URL ? 'a' : 'div', 'foot');
    if (WATERMARK_URL) {
      mark.setAttribute('href', WATERMARK_URL);
      mark.setAttribute('target', '_blank');
      mark.setAttribute('rel', 'noopener');
    }
    var ring = window.document.createElementNS(SVG_NS, 'svg');
    ring.setAttribute('width', '10');
    ring.setAttribute('height', '10');
    ring.setAttribute('viewBox', '0 0 12 12');
    ring.setAttribute('fill', 'none');
    ring.setAttribute('aria-hidden', 'true');
    var circle = window.document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('cx', '6');
    circle.setAttribute('cy', '6');
    circle.setAttribute('r', '4.25');
    circle.setAttribute('stroke', 'currentColor');
    circle.setAttribute('stroke-width', '2.5');
    ring.appendChild(circle);
    // The share page footer's own line, word for word: "Powered by ○ Open
    // Analytics", mark between the words, everything on one baseline.
    mark.appendChild(el('span', null, 'Powered by'));
    mark.appendChild(ring);
    mark.appendChild(el('span', null, 'Open Analytics'));
    return mark;
  }

  function render(payload) {
    var widget = payload && payload.widget ? payload.widget : {};
    surface = widget.surface;
    // The head row: the owner's title (the only label this document ever
    // shows — no site name, no domain, no link home: identity is opt-in
    // (ADR-0044) and a widget's opt-in is its title) and the window, in the
    // dashboard's own words. No title leaves a spacer so the window keeps
    // its edge.
    var head = el('div', 'head');
    head.appendChild(widget.title ? el('h1', null, widget.title) : el('span'));
    head.appendChild(el('span', 'interval',
      widget.surface === 'realtime' ? 'Live' : (RANGE_LABEL[widget.range] || '')));
    var body = el('div', 'body');
    body.appendChild(draw(widget, payload.data));
    show([head, rule(), body, rule(), foot()]);
  }

  function load() {
    window
      .fetch('/v1/widget/' + ID, { credentials: 'omit' })
      .then(function (response) {
        if (!response.ok) throw new Error('unavailable');
        return response.json();
      })
      .then(render)
      .catch(empty);
  }

  load();
  // A badge that changes once a minute, polled every 15 s: four requests a
  // minute against the JSON's own 10-second max-age (ADR-0045, D5 and D12).
  // Historical surfaces are not re-polled at all — their document is cached for
  // as long as their answer is.
  window.setInterval(function () {
    if (surface === 'realtime') load();
  }, 15000);
})();
</script>
</body></html>`
}

export function createWidgetEmbedRoutes(deps: WidgetEmbedDeps): Hono<Env> {
  const app = new Hono<Env>()

  /**
   * The budget, charged before any other work — **in exactly the order the JSON
   * read charges it** (D5, as amended).
   *
   * That order is the point, not an accident of where the middleware sits. CP2
   * charges before its handler knows anything about the id; two doors onto one
   * budget that validated in different orders would make the same spray cost
   * different amounts depending on which one an attacker picked, and which door
   * is cheaper is not a choice worth handing anybody. So a malformed id spends a
   * token here too — it just never reaches the database.
   *
   * A middleware rather than a line in the handler, again mirroring CP2: the
   * charge must not be skippable by an early return added later.
   */
  app.use('/embed/:widget_id', async (c, next) => {
    const decision = deps.rateLimiter.check(
      widgetBudgetKey(
        c.req.param('widget_id'),
        c.req.header('x-forwarded-for'),
        c.req.header('x-real-ip'),
      ),
    )
    if (!decision.allowed) {
      // The JSON door throws `ApiError('RATE_LIMITED')` and lets the error
      // handler envelope it. This one cannot: the response lands in an iframe,
      // and a browser handed a JSON envelope paints it on somebody else's page.
      // Same status, same `Retry-After`, a page instead of a body.
      return refusal(RATE_LIMITED_PAGE, 429, {
        'retry-after': String(decision.retryAfterSeconds),
      })
    }
    await next()
    // `credentialedCors`'s idiom: one branch answers, the other annotates
    // nothing and hands the response back untouched.
    return undefined
  })

  app.get('/embed/:widget_id', async (c) => {
    const widgetId = c.req.param('widget_id')
    // Before the database, deliberately: a malformed id is not a lookup that
    // misses, it is a string that was never an id.
    if (!WIDGET_ID_PATTERN.test(widgetId)) return notFound()

    // The same gate the JSON read applies, through the same repository function
    // (D7 and D11): the widget's own switch and the site's lifecycle, and no
    // board flag — a widget is its own act of publication. One resolution, one
    // answer; there is no config cache in front of the row, so a disable takes
    // effect on the next request that reaches us (D12).
    const widget = await resolvePublicWidget(deps.db, widgetId)
    if (!widget || !widget.enabled || widget.siteStatus !== 'active') return notFound()

    // Presentation only, and narrowed to literals before it reaches the
    // template: neither switch touches the read, the budget or the policy
    // above, so an unknown value is a default rather than a refusal. Both ride
    // the query string, which browsers and CDNs already key their caches on,
    // so two themes of one widget cache separately for free.
    return new Response(
      document(
        widgetId,
        deps.watermarkUrl ?? '',
        themeFrom(c.req.query('theme')),
        frameFrom(c.req.query('frame')),
      ),
      {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': `${SELF_CONTAINED_CSP}; frame-ancestors ${frameAncestors(widget.allowedOrigins)}`,
          // The document is static; what makes it stale is the policy it carries,
          // which is why this is the JSON read's own number rather than a second
          // one (D12).
          'cache-control': `public, max-age=${deps.cacheMaxAgeSeconds}`,
          'x-content-type-options': 'nosniff',
          // A widget id in a `Referer` would hand the owner's other pages — and
          // anyone the reader navigates to — a working credential.
          'referrer-policy': 'no-referrer',
        },
      },
    )
  })

  return app
}
