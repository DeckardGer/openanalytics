# Security policy

## Reporting a vulnerability

Email **hey@getopen.so**. Please do not open a public issue for anything
security-sensitive.

Include what you can: affected endpoint or package, reproduction steps, and
impact as you understand it. You will get an acknowledgement within 72 hours
and a status update when the fix ships. We are happy to credit reporters in
release notes unless you prefer otherwise.

## Scope

- The code in this repository (all apps and packages).
- The hosted service at `getopen.so` — for that, coordinated disclosure via
  the same address; please no volumetric testing against production.

## Out of scope

- Vulnerabilities in third-party dependencies with no demonstrated impact
  here (report upstream first; tell us if it is reachable in this codebase).
- Self-hosted instances operated by third parties — report to their
  operators.

## Supported versions

The tip of `main`. There are no maintained release branches; fixes ship
forward, so the remedy for a vulnerability is always to move forward rather
than to wait for a backport.

A fix that matters to self-hosters lands here promptly whether it was found
here or against the hosted service — the two are developed separately now, and
security fixes are the one thing that crosses in both directions without
waiting for anything else.
