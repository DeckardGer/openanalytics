import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The seams between the self-host package and the release pipeline.
 *
 * None of this is logic. All of it is one file agreeing with another file, in
 * places where a disagreement is silent and expensive:
 *
 *  - The release workflow publishes a list of images. The compose file consumes
 *    a list of images. Nothing at build time compares them, so a service added
 *    to compose without a matrix entry produces a release whose install fails on
 *    `docker compose pull` with `manifest unknown` — for one image, after the
 *    other seven succeeded. The count itself has already been got wrong once in
 *    writing: seven is what you get by not noticing that `migrate` has its own
 *    tag.
 *
 *  - `generate-secrets.sh --with-geoip` enables GeoIP by uncommenting one exact
 *    line in `env/collector.env`. Reword that line in the template and the flag
 *    downloads 60 MB and changes nothing.
 *
 *  - The dashboard image is built against placeholder origins and substitutes
 *    the real ones at start. The placeholders are written in two files. If they
 *    stop matching, the build stashes nothing useful and the container refuses
 *    to start — safe, but only discovered by running it.
 *
 * These are checks a reader can also perform by eye. The point is that nobody
 * has to remember to.
 */

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8')

const COMPOSE = read('infra/selfhost/docker-compose.yml')
const RELEASE_WORKFLOW = read('.github/workflows/release.yml')

/**
 * Every image this repository builds, as the compose file names them. Written
 * out rather than derived so that a change to either side has to be a deliberate
 * change to this list as well.
 */
const EXPECTED_IMAGES = [
  'api',
  // Upstream's server plus the config drop-in and the entrypoint that renders
  // its four users. Ours since 2026-08-14, because the bind mounts that used to
  // deliver them work in a checkout and nowhere else.
  'clickhouse',
  'collector',
  'migrate',
  'query-gateway',
  'realtime',
  'tracker-build',
  // One image, both policy files, the role chosen by `OA_VALKEY_CONF`.
  'valkey',
  'web',
  'worker',
]

/** `image: ${OA_IMAGE_REPO:-openanalytics}/api:${OA_IMAGE_TAG:-local}` */
const COMPOSE_IMAGE =
  /^\s*image:\s*\$\{OA_IMAGE_REPO:-openanalytics\}\/([a-z-]+):\$\{OA_IMAGE_TAG:-local\}\s*$/gm

/** A matrix entry in the release workflow: `- image: api` */
const MATRIX_IMAGE = /^\s*-\s*image:\s*([a-z-]+)\s*$/gm

function matchAll(source: string, pattern: RegExp): string[] {
  // `flatMap` rather than `map`: a match whose group did not participate would
  // otherwise become an `undefined` in a list of image names, and the assertion
  // that failed would be about the wrong thing.
  return [...source.matchAll(pattern)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  )
}

describe('the images a release publishes', () => {
  it('is the set the compose file runs, ten of them', () => {
    const composeImages = [...new Set(matchAll(COMPOSE, COMPOSE_IMAGE))].sort()

    // Twelve references, ten names. `migrate` twice: the migration one-shot and
    // `create-admin`, which reuses it deliberately rather than being its own
    // image. `valkey` twice: the queue and the realtime cache are the same
    // server under different policy, and which one is chosen by an env var
    // rather than by a second image of identical bytes.
    expect(matchAll(COMPOSE, COMPOSE_IMAGE)).toHaveLength(12)
    expect(composeImages).toEqual(EXPECTED_IMAGES)
    expect(composeImages).toHaveLength(10)
  })

  it('is the set the release workflow builds', () => {
    expect([...new Set(matchAll(RELEASE_WORKFLOW, MATRIX_IMAGE))].sort()).toEqual(EXPECTED_IMAGES)
  })

  it('is the set the workflow summarises, so the run log cannot understate what shipped', () => {
    const listed = /for image in ([a-z -]+); do/.exec(RELEASE_WORKFLOW)?.[1]
    expect(listed).toBeDefined()
    expect(listed!.trim().split(/\s+/).sort()).toEqual(EXPECTED_IMAGES)
  })

  it('leaves no service pinned to an unversioned name of ours', () => {
    // A bare `openanalytics/api` would ignore both OA_IMAGE_REPO and
    // OA_IMAGE_TAG, so it would keep building locally however the release is
    // configured — and it would do it quietly.
    const bare = COMPOSE.match(/^\s*image:\s*openanalytics\//gm)
    expect(bare).toBeNull()
  })
})

describe('the GeoIP line generate-secrets.sh uncomments', () => {
  const ANCHOR = '# GEOIP_DB_PATH=/geoip/dbip-city-lite.mmdb'

  it('is in the collector template, exactly as the generator greps for it', () => {
    const template = read('infra/selfhost/env/collector.env.example')
    expect(template.split('\n')).toContain(ANCHOR)
  })

  it('is the string the generator actually looks for', () => {
    const generator = read('infra/selfhost/generate-secrets.sh')
    expect(generator).toContain("GEOIP_LINE='GEOIP_DB_PATH=/geoip/dbip-city-lite.mmdb'")
    expect(generator).toContain('grep -qxF "# ${GEOIP_LINE}" env/collector.env')
  })

  it('is the path the compose file mounts the database at', () => {
    expect(COMPOSE).toContain('./geoip:/geoip:ro')
  })
})

describe('the dashboard placeholder origins', () => {
  const dockerfile = read('infra/selfhost/web.Dockerfile')
  const entrypoint = read('apps/web/docker-entrypoint.sh')

  const VARIABLES = ['NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_REALTIME_URL', 'NEXT_PUBLIC_COLLECTOR_URL']

  /** `ARG NEXT_PUBLIC_API_URL=https://api.oa-runtime-url.invalid` */
  function fromDockerfile(name: string): string | undefined {
    return new RegExp(`^ARG ${name}=(\\S+)$`, 'm').exec(dockerfile)?.[1]
  }

  /**
   * The entrypoint composes them — `echo "https://api.$SENTINEL_HOST"` — so this
   * reads the host out of its one definition and rebuilds the same three
   * strings. Comparing composed values rather than literals is the point: the
   * two files have to agree about what `sed` will look for, not about how it is
   * spelled.
   */
  function fromEntrypoint(name: string): string | undefined {
    const host = /^SENTINEL_HOST='([^']+)'$/m.exec(entrypoint)?.[1]
    const template = new RegExp(`${name}\\) echo "([^"]+)" ;;`).exec(entrypoint)?.[1]
    if (host === undefined || template === undefined) return undefined
    return template.replace('$SENTINEL_HOST', host)
  }

  it('are the same three in the build and in the entrypoint', () => {
    for (const name of VARIABLES) {
      const built = fromDockerfile(name)
      expect(built, `web.Dockerfile has no ARG ${name}`).toBeDefined()
      expect(built).toMatch(/^https:\/\/[a-z]+\.oa-runtime-url\.invalid$/)
      expect(fromEntrypoint(name), `docker-entrypoint.sh disagrees about ${name}`).toBe(built)
    }
  })

  it('are three distinct origins, so one cannot be substituted for another', () => {
    const values = VARIABLES.map((name) => fromDockerfile(name))
    expect(new Set(values).size).toBe(3)
  })

  it('are what the build searches the output for', () => {
    // The build fails if no built file contains one; this is the string it
    // searches for, and all three share it.
    expect(dockerfile).toContain("grep -rl 'oa-runtime-url.invalid' .next")
    expect(entrypoint).toContain("SENTINEL_HOST='oa-runtime-url.invalid'")
  })

  it('reach the browser through env/web.env rather than a build argument', () => {
    // The three used to be `${OA_PUBLIC_*:?}` build args on the web service. If
    // they come back, an operator can set them in `.env` and have them silently
    // ignored — the image reads the env file now.
    expect(COMPOSE).not.toContain('NEXT_PUBLIC_API_URL:')
    const template = read('infra/selfhost/env/web.env.example')
    for (const name of [
      'NEXT_PUBLIC_API_URL',
      'NEXT_PUBLIC_REALTIME_URL',
      'NEXT_PUBLIC_COLLECTOR_URL',
    ]) {
      expect(template).toContain(`${name}=`)
    }
  })
})

describe('the upgrade path', () => {
  it('is written down where the compose defaults are', () => {
    const example = read('infra/selfhost/.env.example')
    expect(example).toMatch(/^OA_IMAGE_REPO=openanalytics$/m)
    expect(example).toMatch(/^OA_IMAGE_TAG=local$/m)
  })

  it('names the same two variables in the scripts that rewrite them', () => {
    for (const script of ['upgrade.sh', 'rollback.sh']) {
      const source = read(`infra/selfhost/${script}`)
      expect(source, `${script} does not set OA_IMAGE_REPO`).toContain('set_env OA_IMAGE_REPO')
      expect(source, `${script} does not set OA_IMAGE_TAG`).toContain('set_env OA_IMAGE_TAG')
    }
  })
})

/**
 * The generator picks the two image variables from the checkout it is standing
 * in, rather than writing build defaults and leaving the operator a step the
 * README has to remember to spell out. Getting this wrong is silent in exactly
 * the way that matters: a release install that pasted the quickstart fails at
 * `docker compose pull` looking for `openanalytics/migrate:local`, an image no
 * registry has ever served.
 *
 * Text checks, because the decision lives in shell. What they pin is that both
 * branches exist, that the tag branch uses the same `--exact-match` idiom as
 * `upgrade.sh` — a checkout merely NEAR a tag is not that tag, and its images do
 * not exist — and that the registry is spelled the same in both scripts.
 */
describe('the images generate-secrets.sh writes into a fresh .env', () => {
  const generator = read('infra/selfhost/generate-secrets.sh')
  const upgrade = read('infra/selfhost/upgrade.sh')

  it('come from the registry when HEAD is standing on a release tag', () => {
    expect(generator).toContain('git -C ../.. describe --tags --exact-match HEAD')
    expect(generator).toMatch(/RELEASE_REPO="ghcr\.io\/openlabs-so\/openanalytics"/)
    expect(generator).toMatch(/IMAGE_REPO="\$RELEASE_REPO"/)
    expect(generator).toMatch(/IMAGE_TAG="\$HEAD_TAG"/)
  })

  it('are built here on a branch, on main, or with no git at all', () => {
    expect(generator).toMatch(/IMAGE_REPO="openanalytics"/)
    expect(generator).toMatch(/IMAGE_TAG="local"/)
  })

  it('only call a v-prefixed tag a release, as upgrade.sh does', () => {
    // Without the guard, a checkout on some other annotated tag — `nightly`,
    // a fork's own — would point .env at images that were never published.
    expect(generator).toMatch(/^\s*v\[0-9\]\*\)$/m)
    expect(upgrade).toMatch(/^\s*v\[0-9\]\*\)/m)
  })

  it('spell the registry the same as the script that upgrades between releases', () => {
    const spelling = /ghcr\.io\/openlabs-so\/openanalytics/
    expect(spelling.exec(generator)?.[0]).toBe(spelling.exec(upgrade)?.[0])
  })

  it('reach .env through the chosen values, not a hard-coded pair', () => {
    // The heredoc used to write `OA_IMAGE_REPO=openanalytics` literally. If it
    // does again, every branch above is dead code that still passes its test.
    expect(generator).toContain('OA_IMAGE_REPO=${IMAGE_REPO}')
    expect(generator).toContain('OA_IMAGE_TAG=${IMAGE_TAG}')
    expect(generator).not.toMatch(/^OA_IMAGE_REPO=openanalytics$/m)
    expect(generator).not.toMatch(/^OA_IMAGE_TAG=local$/m)
  })

  it('say which of the two it chose, and why, when it runs', () => {
    expect(generator).toMatch(/IMAGE_MODE=/)
    expect(generator).toMatch(/echo "images: \$\{IMAGE_MODE\}"/)
  })
})

/**
 * The build context has to contain what the Dockerfiles copy out of it.
 *
 * `.dockerignore` excludes `infra/` wholesale, which was right while every
 * image was built from `apps/` and `packages/`. `clickhouse.Dockerfile` and
 * `valkey.Dockerfile` copy five files out of `infra/selfhost/`, so without an
 * exception the release fails on those two images with
 * `"/infra/selfhost/clickhouse/oa-entrypoint.sh": not found`, a message that
 * names the Dockerfile and says nothing about the ignore file that caused it.
 *
 * It got out once, on the v0.3.0 tag, because the images were proven by
 * building them from a hand-made tarball that had no `.dockerignore` in it. A
 * build is only as faithful as its context.
 */
describe('what the self-host Dockerfiles copy', () => {
  const DOCKERIGNORE = read('.dockerignore')

  /** `COPY infra/selfhost/valkey/valkey-queue.conf /usr/local/etc/...` */
  const COPY_SOURCE = /^COPY\s+(?:--\S+\s+)*(\S+)\s/gm

  const sourcesOf = (dockerfile: string) =>
    matchAll(read(`infra/selfhost/${dockerfile}`), COPY_SOURCE).filter((source) =>
      source.startsWith('infra/'),
    )

  /**
   * The negations, with their `/**` suffix removed so a directory rule can be
   * compared against a file path by prefix.
   */
  const negations = DOCKERIGNORE.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('!'))
    .map((line) =>
      line
        .slice(1)
        .replace(/\/\*\*$/, '')
        .replace(/\/$/, ''),
    )

  for (const dockerfile of ['clickhouse.Dockerfile', 'valkey.Dockerfile']) {
    it(`is in the context: ${dockerfile}`, () => {
      const sources = sourcesOf(dockerfile)
      expect(sources.length).toBeGreaterThan(0)

      for (const source of sources) {
        // On disk at all. A COPY of a path nobody wrote fails the same way and
        // would otherwise be blamed on the ignore file.
        expect(() => read(source)).not.toThrow()

        // And reachable: some `!` line covers it, either exactly or as a parent
        // directory of it.
        const covered = negations.some(
          (allowed) => source === allowed || source.startsWith(`${allowed}/`),
        )
        expect(covered, `${source} is excluded from the build context`).toBe(true)
      }
    })
  }

  it('re-includes the directory as well as its contents', () => {
    // An excluded directory is not descended into, so `!infra/selfhost/valkey/**`
    // on its own matches nothing. Both lines are load-bearing.
    for (const directory of ['infra/selfhost/clickhouse', 'infra/selfhost/valkey']) {
      expect(negations).toContain(directory)
    }
  })
})

/**
 * The Coolify variant declares inline what the stock compose file reads from
 * `env/*.env`, so the two can disagree silently.
 *
 * Both ways it went wrong on the first live deploy, and neither was visible in
 * a file anyone read twice:
 *
 *  - `CLICKHOUSE_DATABASE` was `openanalytics`. Every grant in
 *    `clickhouse/oa-entrypoint.sh` is written against `analytics.<table>` by
 *    name, so the stack came up green and would have failed on the first read
 *    with a permission error naming a table nobody had renamed.
 *  - `PRODUCT_NAME` was `OpenAnalytics`, which is the repository, not the
 *    product. It reaches customers, in mail.
 *
 * Keys the templates comment out are not required: a commented `GEOIP_DB_PATH`
 * is a feature that is off, and this variant is entitled to leave it off.
 */
describe('the Coolify variant against the env templates', () => {
  const COOLIFY = read('infra/selfhost/docker-compose.coolify.yml')

  /** `  api:` at two-space indent starts a service; anything less ends one. */
  function environmentOf(service: string): Map<string, string> {
    const block = new RegExp(
      `\\n  ${service}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z0-9-]*:\\n|\\n[a-z]+:\\n|$)`,
    )
    const body = block.exec(COOLIFY)?.[1] ?? ''
    const env = /\n {4}environment:\n([\s\S]*?)(?=\n {4}[a-z]|\n {2}[a-z]|$)/.exec(body)?.[1] ?? ''
    const found = new Map<string, string>()
    for (const line of env.split('\n')) {
      const match = /^\s+([A-Z][A-Z0-9_]*):\s?(.*)$/.exec(line)
      if (match?.[1] !== undefined) found.set(match[1], (match[2] ?? '').trim())
    }
    return found
  }

  /** The uncommented `KEY=value` lines of a template. */
  function templateOf(service: string): Map<string, string> {
    const found = new Map<string, string>()
    for (const line of read(`infra/selfhost/env/${service}.env.example`).split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue
      const at = trimmed.indexOf('=')
      if (at > 0) found.set(trimmed.slice(0, at), trimmed.slice(at + 1))
    }
    return found
  }

  for (const service of ['api', 'collector', 'worker', 'realtime', 'gateway', 'migrate', 'web']) {
    it(`declares everything ${service}.env.example does`, () => {
      const declared = environmentOf(service)
      const wanted = templateOf(service)
      expect(wanted.size).toBeGreaterThan(0)

      for (const [key, value] of wanted) {
        // `X_FILE` satisfies `X`. ADR-0065 D1 makes a path another way to supply
        // any declared variable, and D4 makes supplying both an error, so the
        // two spellings are alternatives, and a check that demanded the inline
        // one would force the wrong fix on a value the platform cannot express.
        // The keyring is exactly that case: it wants 32 bytes and Coolify's
        // generators produce 24, 48 or 96.
        const byPath = declared.has(`${key}_FILE`)
        expect(declared.has(key) || byPath, `${service} is missing ${key}`).toBe(true)
        if (byPath) continue

        // Only literals are comparable. A template placeholder and a
        // `${SERVICE_PASSWORD_*}` are the same intent spelled for two different
        // machines, and neither is a value.
        const mine = declared.get(key) ?? ''
        if (!value.includes('{{') && !mine.includes('$')) {
          expect(mine, `${service}.${key} disagrees with its template`).toBe(value)
        }
      }
    })
  }
})

/**
 * An empty default is not a default.
 *
 * `EMAIL_FROM: ${OA_EMAIL_FROM:-}` shipped in the Coolify variant and made a
 * first deploy impossible: the schema wants at least three characters, so the
 * worker refused to start, restarted, and refused again, over a variable nothing
 * told the operator was required. The stock `env/worker.env.example` had a
 * placeholder there the whole time.
 *
 * Every `${VAR:-}` in that file is the same trap, so none of them is allowed.
 * A variable the platform fills in (`SERVICE_PASSWORD_*`, `SERVICE_FQDN_*`) is
 * written without a default at all, which is the honest spelling: it is not
 * optional, and the platform supplies it.
 */
describe('the Coolify variant has no empty defaults', () => {
  it('never writes ${VAR:-}', () => {
    const file = read('infra/selfhost/docker-compose.coolify.yml')
    const empty = [...file.matchAll(/\$\{([A-Z0-9_]+):-\}/g)].map((m) => m[1])
    expect(empty, `these would boot as an empty string: ${empty.join(', ')}`).toEqual([])
  })
})

/**
 * The browser bundle ships inside the images.
 *
 * It did not, from v0.3.0 to v0.3.2, and the shape of the failure is why this
 * is four assertions rather than one. `tracker-build` is this Dockerfile's
 * `build` stage; that stage did not carry `scripts/`; and `pnpm run
 * tracker:build` is `node scripts/build-tracker.mjs`. The stock compose hid it
 * by bind-mounting the directory from a checkout and passing an explicit
 * command. A one-click platform install has neither, so the container inherited
 * the stage's bare `node`, read EOF from a closed stdin, **exited 0**, and left
 * the shared volume empty — a one-shot reporting success. Every Coolify install
 * then served `404` for the one file a customer pastes.
 *
 * Three files name one path, which is the drift this pins: the build script
 * writes it, the Dockerfile checks it, and the collector reads it.
 */
describe('the tracker bundle the images carry', () => {
  const DOCKERFILE = read('infra/docker/node-app.Dockerfile')
  const BUNDLE_PATH = 'apps/tracker/bundle/oa.js'

  it('is built in the build stage, from the scripts the build stage now has', () => {
    expect(DOCKERFILE).toMatch(/^COPY scripts \.\/scripts$/m)
    expect(DOCKERFILE).toMatch(/^RUN pnpm run tracker:build$/m)
  })

  it('is asserted where the image is built, not where it is served', () => {
    // A budget failure already exits non-zero and esbuild fails on a missing
    // entry. This is the third case: a run that succeeded and wrote nothing.
    expect(DOCKERFILE).toContain(`RUN test -s ${BUNDLE_PATH}`)
  })

  it('is built after the compile step, so scripts/ does not invalidate that layer', () => {
    expect(DOCKERFILE.indexOf('RUN pnpm run build')).toBeLessThan(
      DOCKERFILE.indexOf('COPY scripts ./scripts'),
    )
  })

  it('is in the build context: scripts/ is not excluded', () => {
    // The lesson of the v0.3.0 tag, applied to a second directory: a COPY of a
    // source `.dockerignore` hides fails with a message that names the
    // Dockerfile and says nothing about the ignore file that caused it.
    const excluded = read('.dockerignore')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('!'))

    for (const rule of ['scripts', 'scripts/', '**/scripts', '**/scripts/']) {
      expect(excluded, `${rule} would hide the tracker build script`).not.toContain(rule)
    }
  })

  it('is written, checked and read at the same path', () => {
    // The build script joins the segments, so it is matched segment by segment.
    const builder = read('scripts/build-tracker.mjs')
    expect(builder).toContain("join(ROOT, 'apps', 'tracker', 'bundle')")
    expect(builder).toContain("join(OUT_DIR, 'oa.js')")

    // The collector resolves it relative to its own module, and `src` and `dist`
    // sit at the same depth, so one literal is right in both.
    expect(read('apps/collector/src/tracker-script.ts')).toContain(
      "new URL('../../tracker/bundle/oa.js', import.meta.url)",
    )
  })
})
