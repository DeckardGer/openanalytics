import { CliError } from './client.ts'
import {
  createCredentialStore,
  login,
  logout,
  parseScopes,
  sites,
  stats,
  type CommandContext,
} from './commands.ts'
import { credentialPath } from './credentials.ts'
import { EXIT_CODES, type ExitCode } from './exit-codes.ts'
import { runInit, type InitTty } from './init/init.ts'

/**
 * Argument parsing and dispatch, with **no process-level side effects** — every
 * stream and every exit is a value this function returns or a callback it was
 * handed.
 *
 * That shape is the reason the exit-code table can be tested at all: a `run` that
 * called `process.exit` would be testable only by spawning a child process per
 * case, and the table would end up pinned by a handful of the cheap cases rather
 * than by all of them.
 */

export const USAGE = `oa — Open Analytics from the command line

Start here
  oa init    [--key oa_pk_…] [--framework <name>] [--yes]
             add the tracking snippet to the project in this folder
  oa login   [--scope "site:read analytics:read"]
             connect this terminal to your account

Read
  oa sites
  oa stats   --site <slug|id> [--from <iso>] [--to <iso>]
  oa logout

Options
  --json           machine-readable output (every read command)
  --api <url>      the API base URL (or $OA_API_URL); required by every
                   command that talks to a deployment
  --help           this text

Exit codes
  0 ok            3 not logged in    6 rate limited / over budget
  1 failed        4 forbidden        7 range too large
  2 usage         5 not found        8 unavailable`

export interface RunOptions {
  readonly argv: readonly string[]
  readonly env: Record<string, string | undefined>
  readonly out: (line: string) => void
  readonly err: (line: string) => void
  readonly fetchImpl?: typeof fetch
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
  readonly credentialFile?: string
  /** `init`'s interactive channel (stdin + the stream its UI draws on).
   * Absent (no terminal) means the flags must answer everything, and `init`
   * says so rather than hanging on a read. */
  readonly tty?: InitTty
  /** Whether person-facing output may use ANSI colour. */
  readonly color?: boolean
  readonly cwd?: string
}

/** `--flag value` and `--flag=value`, plus bare `--flag` booleans. */
function parseFlags(argv: readonly string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === undefined || !token.startsWith('--')) continue
    const eq = token.indexOf('=')
    if (eq !== -1) {
      flags[token.slice(2, eq)] = token.slice(eq + 1)
      continue
    }
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[token.slice(2)] = next
      i += 1
    } else {
      flags[token.slice(2)] = true
    }
  }
  return flags
}

function str(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** The default range when `stats` is not given one: the last seven days. */
function defaultRange(now: number): { from: string; to: string } {
  const to = new Date(now)
  const from = new Date(now - 7 * 24 * 60 * 60 * 1000)
  return { from: from.toISOString(), to: to.toISOString() }
}

export async function run(options: RunOptions): Promise<ExitCode> {
  const [command, ...rest] = options.argv
  const flags = parseFlags(rest)

  if (command === undefined || command === '--help' || flags['help'] === true) {
    options.out(USAGE)
    // `--help` is a successful command, not a usage error. A script asking for
    // help and getting `2` would read it as failure.
    return command === undefined && flags['help'] !== true ? EXIT_CODES.usage : EXIT_CODES.ok
  }

  const json = flags['json'] === true
  /**
   * Which deployment this invocation talks to.
   *
   * No default, deliberately. It used to fall back to our own hosted api, which
   * made every other install's CLI a client of ours by omission — a `oa sites`
   * typed against a self-hosted deployment with `OA_API_URL` unset would
   * authenticate, or fail to, somewhere the operator never named. `init` is the
   * one command exempt, because it makes no request at all: it edits the folder
   * it is run in.
   */
  const baseUrl = str(flags['api']) ?? options.env['OA_API_URL']
  const store = createCredentialStore(options.credentialFile ?? credentialPath(options.env))

  const ctx: CommandContext = {
    // Resolved above; every command that reads it is behind the check below.
    baseUrl: baseUrl ?? '',
    json,
    store,
    out: options.out,
    err: options.err,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.now ? { now: options.now } : {}),
  }

  try {
    switch (command) {
      case 'init':
        // No session, no API call: init edits the folder it is run in, which
        // is why it is the one command that works before an account exists on
        // this machine.
        return await runInit({
          cwd: options.cwd ?? process.cwd(),
          env: options.env,
          out: options.out,
          err: options.err,
          tty: options.tty,
          color: options.color ?? false,
          key: str(flags['key']),
          framework: str(flags['framework']),
          yes: flags['yes'] === true,
        })
      default:
        break
    }

    if (baseUrl === undefined) {
      throw new CliError(
        `${command} needs the API base URL: pass --api <url> or set OA_API_URL`,
        EXIT_CODES.usage,
      )
    }

    switch (command) {
      case 'login': {
        const result = await login(ctx, { scopes: parseScopes(str(flags['scope'])) })
        return result.exitCode
      }
      case 'logout':
        return logout(ctx).exitCode
      case 'sites':
        return (await sites(ctx)).exitCode
      case 'stats': {
        const site = str(flags['site'])
        if (site === undefined) {
          throw new CliError('stats needs --site <slug|id>', EXIT_CODES.usage)
        }
        const now = (options.now ?? (() => Date.now()))()
        const range = defaultRange(now)
        const result = await stats(ctx, {
          site,
          from: str(flags['from']) ?? range.from,
          to: str(flags['to']) ?? range.to,
        })
        return result.exitCode
      }
      default:
        options.err(`Unknown command: ${command}`)
        options.err(USAGE)
        return EXIT_CODES.usage
    }
  } catch (error) {
    if (error instanceof CliError) {
      // The error goes to the same channel the caller asked for. A `--json`
      // consumer parsing stdout must be able to parse a failure too, rather
      // than getting prose where it expected an object.
      if (json) {
        options.out(
          JSON.stringify({ error: { message: error.message, ...(error.detail ?? {}) } }, null, 2),
        )
      } else {
        options.err(error.message)
        const retryAfter = error.detail?.['retry_after_seconds']
        if (typeof retryAfter === 'number' && Number.isFinite(retryAfter)) {
          options.err(`Try again in ${String(retryAfter)}s.`)
        }
      }
      return error.exitCode
    }
    options.err(error instanceof Error ? error.message : String(error))
    return EXIT_CODES.failure
  }
}
