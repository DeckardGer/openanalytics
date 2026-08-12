import type { Readable, Writable } from 'node:stream'
import * as clack from '@clack/prompts'
import { EXIT_CODES, type ExitCode } from '../exit-codes.ts'
import { detectFramework, FRAMEWORKS, frameworkById, type Framework } from './detect.ts'
import { inject, InjectError, type InjectResult } from './injectors.ts'
import { collectorUrl, NO_COLLECTOR_MESSAGE } from './snippet.ts'

/**
 * `oa init` — the guided install, and deliberately the opposite register from
 * the read commands.
 *
 * `sites` and `stats` answer scripts; `init` talks to a person standing in
 * their project folder with a key in their clipboard. The interactive face is
 * Clack (the household style of `create astro` and friends), pointed at
 * **stderr** so the one machine-readable line — which file changed — still
 * owns stdout, the same discipline every other command keeps.
 *
 * The flags (`--key`, `--framework`, `--yes`) answer every question in
 * advance, and they are the whole interface when there is no terminal to ask
 * on — a CI job gets plain lines and the same exit codes, never a hung prompt.
 */

export interface InitTty {
  readonly input: Readable
  readonly output: Writable
}

export interface InitOptions {
  readonly cwd: string
  readonly env: Record<string, string | undefined>
  readonly out: (line: string) => void
  readonly err: (line: string) => void
  /** Absent when stdin is not a terminal — then the flags must carry the answers. */
  readonly tty?: InitTty | undefined
  readonly color?: boolean
  readonly key?: string | undefined
  readonly framework?: string | undefined
  readonly yes?: boolean
}

/** The tracking key's shape, from docs snapshot 01 §3.2. */
const KEY_PATTERN = /^oa_pk_/

const KEY_HINT =
  'You can get your tracking key from your dashboard: your site → Settings → API keys.'

interface Palette {
  readonly blue: (text: string) => string
  readonly dim: (text: string) => string
  readonly green: (text: string) => string
  readonly red: (text: string) => string
  readonly bold: (text: string) => string
}

/** ANSI when the stream is a terminal, identity when it is a file. */
function palette(color: boolean): Palette {
  const wrap =
    (open: string, close = '\u001b[39m') =>
    (text: string) =>
      color ? `${open}${text}${close}` : text
  return {
    // 256-colour 69, the closest a terminal gets to --primary (#296FF0).
    blue: wrap('\u001b[38;5;69m'),
    dim: wrap('\u001b[2m', '\u001b[22m'),
    green: wrap('\u001b[32m'),
    red: wrap('\u001b[31m'),
    bold: wrap('\u001b[1m', '\u001b[22m'),
  }
}

/** #296FF0 → #4ade80 across the wordmark, gradient-string style. */
function gradientWordmark(text: string, color: boolean): string {
  if (!color) return text
  const from = { r: 0x29, g: 0x6f, b: 0xf0 }
  const to = { r: 0x4a, g: 0xde, b: 0x80 }
  const last = Math.max(text.length - 1, 1)
  let output = '\u001b[1m'
  for (let i = 0; i < text.length; i += 1) {
    const t = i / last
    const r = Math.round(from.r + (to.r - from.r) * t)
    const g = Math.round(from.g + (to.g - from.g) * t)
    const b = Math.round(from.b + (to.b - from.b) * t)
    output += `\u001b[38;2;${String(r)};${String(g)};${String(b)}m${text[i] ?? ''}`
  }
  return `${output}\u001b[39m\u001b[22m`
}

const stripAnsi = (text: string): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/\u001b\[[0-9;]*m/g, '')

/** The Installed box: green frame, the changed file inside. */
function installedBox(lines: readonly string[], paint: Palette): string[] {
  const width = Math.max(...lines.map((line) => stripAnsi(line).length)) + 4
  const top = paint.green(`╭${'─'.repeat(width)}╮`)
  const bottom = paint.green(`╰${'─'.repeat(width)}╯`)
  const edge = paint.green('│')
  const body = lines.map((line) => {
    const padding = ' '.repeat(width - 2 - stripAnsi(line).length)
    return `${edge}  ${line}${padding}${edge}`
  })
  return [top, ...body, bottom]
}

/**
 * The closing words, shared by both faces. The deploy sentence is part of the
 * install itself — nothing has happened until the site ships — so it stands
 * bright and unnumbered; the numbered steps below are genuinely optional.
 *
 * The global install leads the list because the person most likely ran this
 * through `npx`, which leaves nothing on the PATH — `oa login` would be
 * "command not found" until step 1 has happened.
 */
function closingLines(paint: Palette): string[] {
  return [
    'Deploy your project and click around your site. The first events',
    'will show up in your Open Analytics dashboard.',
    '',
    `${paint.bold('Next steps')} ${paint.dim('(optional)')}`,
    `${paint.dim('  1.')} ${paint.blue('oa login --api <your-api-url>')}  ${paint.dim('connect this terminal')}`,
    `${paint.dim('  2.')} ${paint.blue('oa stats --site <your-site>')}`,
  ]
}

function validateKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? ''
  if (trimmed === '') return 'A site key is required.'
  if (!KEY_PATTERN.test(trimmed))
    return 'Tracking keys start with oa_pk_ — copy it from the dashboard.'
  return undefined
}

function namedFramework(id: string): Framework | { error: string } {
  const named = frameworkById(id)
  if (named) return named
  const ids = FRAMEWORKS.map((framework) => framework.id).join(', ')
  return { error: `Unknown framework "${id}". One of: ${ids}` }
}

/* ── the interactive face ──────────────────────────────────────────────── */

async function runInteractive(
  options: InitOptions,
  tty: InitTty,
  paint: Palette,
): Promise<ExitCode> {
  const io = { input: tty.input, output: tty.output }
  const say = (line: string) => options.err(line)

  // A3: the wordmark, then straight into the flow.
  say('')
  say(`  ${gradientWordmark('OPEN ANALYTICS', options.color === true)}`)
  say(`  ${paint.dim('privacy-first web analytics')}`)
  say('')

  let key = options.key?.trim()
  if (key !== undefined && key !== '') {
    const issue = validateKey(key)
    if (issue !== undefined) {
      clack.log.error(issue, io)
      return EXIT_CODES.usage
    }
  } else {
    clack.log.message(KEY_HINT, io)
    const answer = await clack.text({
      message: 'Site key',
      placeholder: 'oa_pk_…',
      validate: validateKey,
      ...io,
    })
    if (clack.isCancel(answer)) {
      clack.cancel('Cancelled. Nothing was written.', io)
      return EXIT_CODES.failure
    }
    key = answer.trim()
  }

  let framework: Framework
  if (options.framework !== undefined) {
    const named = namedFramework(options.framework)
    if ('error' in named) {
      clack.log.error(named.error, io)
      return EXIT_CODES.usage
    }
    framework = named
  } else {
    const detected = detectFramework(options.cwd)
    let confirmed: Framework | null = null
    if (detected) {
      if (options.yes === true) {
        confirmed = detected
      } else {
        const useIt = await clack.confirm({
          message: `Detected ${paint.blue(detected.name)}. Use it?`,
          ...io,
        })
        if (clack.isCancel(useIt)) {
          clack.cancel('Cancelled. Nothing was written.', io)
          return EXIT_CODES.failure
        }
        if (useIt) confirmed = detected
      }
    }
    if (confirmed) {
      framework = confirmed
    } else {
      const picked = await clack.select({
        message: 'Which framework?',
        options: FRAMEWORKS.map((entry) => ({ value: entry.id, label: entry.name })),
        ...io,
      })
      if (clack.isCancel(picked)) {
        clack.cancel('Cancelled. Nothing was written.', io)
        return EXIT_CODES.failure
      }
      framework = frameworkById(picked) ?? FRAMEWORKS[0]!
    }
  }

  const collector = collectorUrl(options.env)
  if (collector === undefined) {
    clack.cancel(NO_COLLECTOR_MESSAGE, io)
    return EXIT_CODES.usage
  }

  const progress = clack.spinner(io)
  progress.start('Writing the snippet')
  let result: InjectResult
  try {
    result = inject(framework.id, {
      cwd: options.cwd,
      key,
      collector,
    })
  } catch (error) {
    if (error instanceof InjectError) {
      progress.error(error.message)
      return EXIT_CODES.failure
    }
    progress.error('Failed.')
    throw error
  }

  if (result.alreadyInstalled) {
    progress.stop(`Already installed ${paint.dim(`(found in ${result.file})`)}`)
    say('')
    return EXIT_CODES.ok
  }
  progress.stop('Snippet written')

  // The one machine-readable line, alone on stdout.
  options.out(`modified: ${result.file}`)

  say('')
  for (const line of installedBox(
    [`${paint.green('✓')} ${paint.bold('Installed')}`, `${paint.dim('modified:')} ${result.file}`],
    paint,
  )) {
    say(line)
  }
  say('')
  for (const line of closingLines(paint)) say(`  ${line}`)
  say('')
  return EXIT_CODES.ok
}

/* ── the flag-driven face (CI, pipes) ──────────────────────────────────── */

function runPlain(options: InitOptions, paint: Palette): ExitCode {
  const key = options.key?.trim()
  if (key === undefined || key === '') {
    options.err('No terminal to ask on. Pass --key oa_pk_… (and optionally --framework).')
    return EXIT_CODES.usage
  }
  const keyIssue = validateKey(key)
  if (keyIssue !== undefined) {
    options.err(keyIssue)
    return EXIT_CODES.usage
  }

  let framework: Framework
  if (options.framework !== undefined) {
    const named = namedFramework(options.framework)
    if ('error' in named) {
      options.err(named.error)
      return EXIT_CODES.usage
    }
    framework = named
  } else {
    const detected = detectFramework(options.cwd)
    if (!detected) {
      options.err('Could not detect a framework here. Pass --framework <name>.')
      return EXIT_CODES.usage
    }
    framework = detected
  }

  const collector = collectorUrl(options.env)
  if (collector === undefined) {
    options.err(NO_COLLECTOR_MESSAGE)
    return EXIT_CODES.usage
  }

  try {
    const result = inject(framework.id, {
      cwd: options.cwd,
      key,
      collector,
    })
    if (result.alreadyInstalled) {
      options.err(`Already installed (found in ${result.file}).`)
      return EXIT_CODES.ok
    }
    options.out(`modified: ${result.file}`)
    options.err('Installed.')
    for (const line of closingLines(paint)) options.err(line)
    return EXIT_CODES.ok
  } catch (error) {
    if (error instanceof InjectError) {
      options.err(error.message)
      return EXIT_CODES.failure
    }
    throw error
  }
}

export async function runInit(options: InitOptions): Promise<ExitCode> {
  const paint = palette(options.color === true)
  if (options.tty) return runInteractive(options, options.tty, paint)
  return runPlain(options, paint)
}
