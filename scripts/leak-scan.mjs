#!/usr/bin/env node
/**
 * Credential scan over the tracked tree (ADR-0062 § c).
 *
 * ## Why this exists
 *
 * Until 2026-08-12 nothing reached this repository except through an export
 * script in the private one, whose verify half grepped the tree for credential
 * shapes before anything was published. (That script is not here and never was
 * — it is the thing this replaces.) ADR-0062 ends the export, so that net
 * disappears from the only path that had one: after it, code reaches this
 * repository by being merged here.
 *
 * This is the same net, moved to where the traffic now goes — a pre-merge check
 * on this repository, which is why it lives in the tree a contributor can read
 * and run, and why it has no dependencies and needs no install.
 *
 * ## What it does and does not carry over
 *
 * Only the credential shapes: patterns with zero legitimate occurrences in any
 * tree, ours or a contributor's. The export script's other checks — the
 * hosted-domain counter, the operator-identity words, the internal IP literals —
 * guard an export boundary between two trees, and after ADR-0062 there is no
 * such boundary to guard. Keeping them here would fail a stranger's honest pull
 * request for saying a word.
 *
 * The redaction fixtures (`sk_live_…` and friends) are deliberately absent for
 * the same reason they are absent there: the test suite contains synthetic ones
 * on purpose.
 *
 * ## What it cannot do
 *
 * It scans the tree at the ref it runs on, not the history behind it. A secret
 * that was committed and then removed in a later commit of the same branch is
 * invisible to this and still public once pushed. That is not a gap this can
 * close: in this model a leak is already public by the time anything runs, and
 * the remedy is a force-push and a key rotation. This exists to stop the
 * ordinary case — a key pasted into a config while debugging — from being
 * merged.
 *
 * ## Why this repository's own CI does not run it
 *
 * It is red here, on purpose and by three known hits: an `oa_pk_` site key in
 * `docs/frontend/frontend_tasks.md` and one in each of the two `scripts/m12-*`
 * proof drivers. All three are in files ADR-0061 § (c) excludes from the public
 * tree, and a publishable key is not a secret — but it is the shape that
 * reached an export once already, so the scan keeps flagging it and this
 * repository keeps not running the scan. Wiring it in here means cleaning those
 * three first; it is not a reason to loosen the pattern.
 *
 *   node scripts/leak-scan.mjs
 *
 * Exits 0 with a one-line summary, or 1 with the findings as JSON.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'

const ROOT = resolve(import.meta.dirname, '..')

/**
 * Credential shapes. Each is a provider's published key format, so a match is a
 * real key or a deliberate imitation of one — never an accident of prose.
 */
const PATTERNS = {
  resend_api_key: /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}\b/g,
  aws_access_key_id: /\b(AKIA|ASIA|AIDA|AROA)[0-9A-Z]{16}\b/g,
  private_key_block: /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
  github_token: /\b(gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{36,})\b/g,
  anthropic_key: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  openai_key: /\bsk-(proj-)?[A-Za-z0-9_-]{40,}\b/g,
  slack_token: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  telegram_bot_token: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g,
  s3_secret_assignment:
    /\b\w*(S3|OBJECT_STORAGE|BACKUP)\w*SECRET\w*\s*[:=]\s*['"]?[A-Za-z0-9+/]{20,}={0,2}['"]?/g,
  ed25519_b64_seed: /^[A-Za-z0-9+/]{43}=$/gm,
  ssh_pubkey: /\bssh-(rsa|ed25519) AAAA[A-Za-z0-9+/=]+/g,
}

/**
 * This product's own keys, which are `base64url(randomBytes(n))` and not hex —
 * a detail that mattered: both patterns asked for hex until 2026-08-11, so
 * neither had ever matched a key this software minted, and a live tracking key
 * sat in an exported component with the gate green.
 *
 * The allowlist is exact values, each read at its fixture. Extend it the same
 * way; never by loosening the pattern.
 */
const OA_KEY = /\boa_(pk|sk)_[A-Za-z0-9_-]{16,}/g
const SYNTHETIC_OA_KEYS = new Set([
  'oa_pk_7f3a91c25be84d0fa1c6d2e5b8074391',
  'oa_sk_ZmFrZS10ZXN0LWtleQ',
  'oa_sk_this-key-was-never-issued-abcdefgh',
])

/**
 * `sk-` prefixed keys are the one shape with a synthetic population: the
 * assistant's tests and docs need something key-shaped to pass around. Same
 * rule as above — exact values, not a relaxed pattern.
 */
const SYNTHETIC_SK_KEYS = new Set(['sk-test-key-for-unit-tests-only-not-a-real-credential'])

const files = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
  .split('\0')
  .filter(Boolean)

const findings = []
let scanned = 0

for (const rel of files) {
  let buf
  try {
    buf = readFileSync(join(ROOT, rel))
  } catch {
    continue // a path in the index with nothing on disk (submodule, sparse checkout)
  }
  if (buf.subarray(0, 8192).includes(0)) continue // binary
  const text = buf.toString('utf8')
  scanned++

  for (const [check, re] of Object.entries(PATTERNS)) {
    re.lastIndex = 0
    for (const match of text.match(re) ?? []) {
      if (check === 'openai_key' && SYNTHETIC_SK_KEYS.has(match)) continue
      findings.push({ check, file: rel, sample: `${match.slice(0, 12)}…`, chars: match.length })
    }
  }
  for (const key of text.match(OA_KEY) ?? []) {
    if (SYNTHETIC_OA_KEYS.has(key)) continue
    findings.push({ check: 'openanalytics_key', file: rel, sample: `${key.slice(0, 12)}…` })
  }
}

if (findings.length > 0) {
  // The sample is truncated on purpose: a CI log is a public artefact, and a
  // scanner that prints the secret it found has published it a second time.
  console.error(JSON.stringify(findings, null, 2))
  console.error(
    `\nleak-scan: ${findings.length} credential-shaped hit(s) in ${scanned} files.\n` +
      'If one is a real key: it is compromised — rotate it, then remove it.\n' +
      'If one is a fixture: add the exact value to the allowlist in this script.',
  )
  process.exit(1)
}

console.log(
  `leak-scan: clean — ${scanned} text files, ${Object.keys(PATTERNS).length + 1} credential checks`,
)
