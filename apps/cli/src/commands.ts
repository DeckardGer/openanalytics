import { READ_SCOPES, type ReadScope } from '@openanalytics/domain'
import {
  ApiClient,
  CliError,
  pollForDeviceToken,
  refreshAccessToken,
  requestDeviceAuthorization,
} from './client.ts'
import { createCredentialStore, describeProtection, type CredentialStore } from './credentials.ts'
import { EXIT_CODES, type ExitCode } from './exit-codes.ts'

/**
 * The four commands §20 lists as the CLI's first set: `login`, `logout`,
 * `sites`, `stats`.
 *
 * §20's other groups — event definitions, import/export status, key management —
 * are explicitly "added in stages" and are not this milestone's. The
 * client can reach only `/v1/read/*`, so adding one is a decision rather than a
 * convenience.
 *
 * **Every command answers `--json`**, and that is contract (§20: "Machine-readable
 * JSON output"). The human form is a rendering of the same object, never a
 * separate query — so a script and a person always see the same numbers.
 */

/** The client id the device flow registers under (`packages/auth`). */
export const CLI_CLIENT_ID = 'oa-cli'

export interface CommandContext {
  readonly baseUrl: string
  readonly json: boolean
  readonly store: CredentialStore
  readonly out: (line: string) => void
  readonly err: (line: string) => void
  /** Injected so tests drive the flow without a network or a clock. */
  readonly fetchImpl?: typeof fetch
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
}

export interface CommandResult {
  readonly exitCode: ExitCode
  /** What `--json` prints. Always the whole answer, never a summary of it. */
  readonly data: unknown
}

function emit(ctx: CommandContext, data: unknown, human: string[]): CommandResult {
  if (ctx.json) ctx.out(JSON.stringify(data, null, 2))
  else for (const line of human) ctx.out(line)
  return { exitCode: EXIT_CODES.ok, data }
}

/**
 * An OSC 8 terminal hyperlink whose visible text is the URL itself. Terminals
 * without OSC 8 support ignore the escape sequences and render the plain URL,
 * so the fallback is the content.
 */
function osc8Link(url: string): string {
  return `\u001B]8;;${url}\u0007${url}\u001B]8;;\u0007`
}

/**
 * A live access token, refreshed if the stored one has aged out.
 *
 * The refresh is silent and the failure is not: a person whose refresh token has
 * also expired is told to run `oa login`, with the exit code that says so, rather
 * than seeing a `401` from whatever command they actually ran.
 */
async function authorize(ctx: CommandContext): Promise<{ token: string; siteless: boolean }> {
  const stored = ctx.store.read()
  if (!stored) {
    throw new CliError('Not logged in. Run `oa login`.', EXIT_CODES.unauthenticated)
  }
  const now = (ctx.now ?? (() => Date.now()))()
  const expiresAt = Date.parse(stored.expiresAt)
  // A minute of slack, so a token that expires mid-flight is renewed before the
  // request rather than after it fails.
  if (Number.isFinite(expiresAt) && expiresAt - 60_000 > now) {
    return { token: stored.accessToken, siteless: false }
  }

  const renewed = await refreshAccessToken({
    baseUrl: stored.apiBaseUrl,
    clientId: CLI_CLIENT_ID,
    refreshToken: stored.refreshToken,
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
  })
  ctx.store.write({
    accessToken: renewed.accessToken,
    refreshToken: renewed.refreshToken,
    expiresAt: new Date(now + renewed.expiresInSeconds * 1000).toISOString(),
    apiBaseUrl: stored.apiBaseUrl,
    scope: renewed.scope,
  })
  return { token: renewed.accessToken, siteless: false }
}

export async function login(
  ctx: CommandContext,
  options: { readonly scopes: readonly ReadScope[] },
): Promise<CommandResult> {
  const scope = options.scopes.join(' ')
  const authorization = await requestDeviceAuthorization({
    baseUrl: ctx.baseUrl,
    clientId: CLI_CLIENT_ID,
    scope,
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
  })

  // Printed before the poll starts, and to stderr, so a person sees the code
  // immediately and `--json` piped to a file still carries only the result.
  // The URL stands on its own line, wrapped in an OSC 8 hyperlink: terminals
  // that support it (iTerm2, VS Code, kitty, Ghostty) make it clickable, and
  // the ones that do not ignore the escape sequence and show the plain URL.
  const verificationUrl = authorization.verificationUriComplete ?? authorization.verificationUri
  ctx.err('Open this link to approve the sign-in:')
  ctx.err('')
  ctx.err(`  ${osc8Link(verificationUrl)}`)
  ctx.err('')
  ctx.err(`Code: ${authorization.userCode}`)
  ctx.err(`Requesting: ${scope}`)

  const token = await pollForDeviceToken({
    baseUrl: ctx.baseUrl,
    clientId: CLI_CLIENT_ID,
    authorization,
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
    ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
    ...(ctx.now ? { now: ctx.now } : {}),
  })

  const now = (ctx.now ?? (() => Date.now()))()
  const protection = ctx.store.write({
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: new Date(now + token.expiresInSeconds * 1000).toISOString(),
    apiBaseUrl: ctx.baseUrl,
    scope: token.scope,
  })

  // D10's condition, met literally: the CLI says where the token is and what is
  // actually protecting it — including when the answer is "nothing".
  return emit(
    ctx,
    {
      logged_in: true,
      scope: token.scope,
      credential_path: ctx.store.path,
      protection: protection.kind,
      protection_detail: describeProtection(protection),
    },
    [
      `Logged in. Granted: ${token.scope}`,
      `Token stored at ${ctx.store.path}`,
      `  ${describeProtection(protection)}`,
    ],
  )
}

export function logout(ctx: CommandContext): CommandResult {
  const removed = ctx.store.clear()
  return emit(ctx, { logged_out: true, removed, credential_path: ctx.store.path }, [
    removed ? `Logged out. Removed ${ctx.store.path}` : 'Not logged in; nothing to remove.',
  ])
}

interface SelectableSite {
  readonly site_id: string
  readonly slug: string
  readonly name: string
  readonly status: string
  readonly role: string | null
}

export async function sites(ctx: CommandContext): Promise<CommandResult> {
  const { token } = await authorize(ctx)
  const stored = ctx.store.read()
  const client = new ApiClient({
    baseUrl: stored?.apiBaseUrl ?? ctx.baseUrl,
    accessToken: token,
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
  })
  // No `X-OA-Site`: this route answers "which sites may you select", which is
  // the question you ask *before* you can select one.
  const body = await client.get<{ items: SelectableSite[] }>('/v1/read/sites')
  return emit(
    ctx,
    body,
    body.items.length === 0
      ? ['No sites.']
      : body.items.map(
          (site) =>
            `${site.slug}\t${site.name}\t${site.status}\t${site.role ?? '-'}\t${site.site_id}`,
        ),
  )
}

/**
 * Turn `--site` into a site id.
 *
 * A person types a slug and the API takes an id, so something has to resolve it —
 * and `GET /v1/read/sites` is that something, which is why D3 gave the route to
 * both credential kinds. An id passed straight through is accepted unresolved:
 * a script that already has one should not pay a round trip to be told so.
 */
async function resolveSite(ctx: CommandContext, token: string, selector: string): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(selector)) {
    return selector
  }
  const stored = ctx.store.read()
  const client = new ApiClient({
    baseUrl: stored?.apiBaseUrl ?? ctx.baseUrl,
    accessToken: token,
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
  })
  const body = await client.get<{ items: SelectableSite[] }>('/v1/read/sites')
  const match = body.items.find((site) => site.slug === selector)
  if (!match) {
    throw new CliError(
      `No site called "${selector}". Run \`oa sites\` to see what you can read.`,
      EXIT_CODES.notFound,
    )
  }
  return match.site_id
}

export async function stats(
  ctx: CommandContext,
  options: { readonly site: string; readonly from: string; readonly to: string },
): Promise<CommandResult> {
  const { token } = await authorize(ctx)
  const siteId = await resolveSite(ctx, token, options.site)
  const stored = ctx.store.read()
  const client = new ApiClient({
    baseUrl: stored?.apiBaseUrl ?? ctx.baseUrl,
    accessToken: token,
    siteId,
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
  })
  const body = await client.get<{ totals?: Record<string, number> }>(
    '/v1/read/analytics/overview',
    { from: options.from, to: options.to, timezone: 'UTC' },
  )
  const totals = body.totals ?? {}
  return emit(
    ctx,
    body,
    Object.entries(totals).map(([metric, value]) => `${metric}\t${String(value)}`),
  )
}

/** The scopes `oa login` asks for when `--scope` is not given. */
export const DEFAULT_LOGIN_SCOPES: readonly ReadScope[] = ['site:read', 'analytics:read']

export function parseScopes(raw: string | undefined): readonly ReadScope[] {
  if (raw === undefined) return DEFAULT_LOGIN_SCOPES
  const named = raw
    .split(/[\s,]+/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  const unknown = named.filter((scope) => !(READ_SCOPES as readonly string[]).includes(scope))
  if (unknown.length > 0) {
    throw new CliError(
      `Unknown scope: ${unknown.join(', ')}. Known: ${READ_SCOPES.join(', ')}`,
      EXIT_CODES.usage,
    )
  }
  // `site:read` is folded in for the same reason the server folds it in: a
  // credential that can read analytics but not the site those numbers belong to
  // is one nobody meant to ask for.
  return [...new Set<ReadScope>(['site:read', ...(named as ReadScope[])])]
}

export { createCredentialStore }
