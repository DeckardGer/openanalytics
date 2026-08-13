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
  'collector',
  'migrate',
  'query-gateway',
  'realtime',
  'tracker-build',
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
  it('is the set the compose file runs — eight of them', () => {
    const composeImages = [...new Set(matchAll(COMPOSE, COMPOSE_IMAGE))].sort()

    // `migrate` twice: the migration one-shot and `create-admin`, which reuses
    // it deliberately rather than being a ninth image.
    expect(matchAll(COMPOSE, COMPOSE_IMAGE)).toHaveLength(9)
    expect(composeImages).toEqual(EXPECTED_IMAGES)
    expect(composeImages).toHaveLength(8)
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
