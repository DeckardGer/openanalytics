<!--
Four short answers. They are the ones a reviewer would otherwise ask for, and
asking costs a round trip across time zones.
-->

**What this changes, and why**

<!-- The behaviour before and after, in a sentence or two. If it fixes an
issue, link it. -->

**How you know it works**

<!-- The test you added, or what you ran. `pnpm run verify` is what CI runs;
a change to the api or a package should have a test pinning the new behaviour,
because a behaviour with no test is a behaviour the next refactor may drop. -->

**Anything a reviewer should look at twice**

<!-- A trade-off you were unsure about, a place you copied an existing pattern
rather than inventing one, something you could not test locally. Saying so is
faster than being asked. -->

---

- [ ] `pnpm run verify` passes locally
- [ ] API surface changes start in `packages/contracts/openapi/openapi.yaml`
      and `pnpm run contracts:generate` was re-run
- [ ] Tracker changes still fit the byte budget (`pnpm run tracker:build`)

<!-- First pull request? A CLA bot will ask you to sign once. There is no DCO
sign-off on top of it. -->
