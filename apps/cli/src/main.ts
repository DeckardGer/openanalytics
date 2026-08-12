#!/usr/bin/env node
import { run } from './cli.ts'

/**
 * The executable wrapper, and nothing else.
 *
 * Every decision lives in `run`, which takes its streams and its clock as
 * arguments and returns an exit code rather than calling `process.exit`. This
 * file is the only place that touches the process, which is what lets the
 * exit-code table — contract, per docs snapshot 02 §20 — be pinned by ordinary
 * tests instead of by spawning a child per case.
 */

// The interactive channel `init` asks its questions on, present only when
// stdin is a terminal — a piped `oa init` gets "pass --key" instead of a
// silent hang. Its UI draws on stderr for the same reason every other
// person-facing line goes there: stdout stays the answer.
const tty =
  process.stdin.isTTY === true ? { input: process.stdin, output: process.stderr } : undefined

const exitCode = await run({
  argv: process.argv.slice(2),
  env: process.env,
  // stdout carries the answer, stderr carries everything a person reads while
  // waiting. `oa sites --json > sites.json` must produce a parseable file even
  // though the login prompt and the progress lines went somewhere.
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  ...(tty ? { tty } : {}),
  // The convention colour-aware CLIs share: paint only a terminal, and let
  // NO_COLOR (https://no-color.org) switch it off without an argument.
  color: process.stderr.isTTY === true && process.env['NO_COLOR'] === undefined,
})

process.exitCode = exitCode
