# Contributing

Thanks for picking this up. Read [ARCHITECTURE.md](./ARCHITECTURE.md) and [ROADMAP.md](./ROADMAP.md) first — the design rationale matters more than the code.

## Setup

```sh
git clone https://github.com/Makio64/vite-plugin-tsl-precompile.git
cd vite-plugin-tsl-precompile
pnpm install
pnpm test                # 17 unit tests
pnpm test:coverage       # 17 coverage-matrix cells
pnpm dev:ocean           # open the ocean demo
```

## How to add a `source.kind`

The AOT codegen lives in [packages/plugin/src/emit-updater.js](packages/plugin/src/emit-updater.js). Every TSL primitive that produces a uniform slot has a `kind` (e.g. `camera.projectionMatrix`, `material.color`).

1. Add a `case '<kind>':` branch in `emitSlotWrite()` returning a writer call.
2. Add a fixture in `packages/plugin/test/coverage/<axis>-kinds.test.js` so the cell is gated by CI.
3. Run `pnpm test:coverage` — the new cell must pass.

Unsupported kinds emit `throw new Error(...)` AND log to `__unsupportedKinds`. Don't silently fall through — loud failure is the whole point of this architecture.

## How to upgrade the vendored three.js files

See [packages/plugin/src/vendor/VENDORING.md](packages/plugin/src/vendor/VENDORING.md). The procedure is:

1. `pnpm verify` to snapshot current artifact hashes.
2. Copy newer source from the fork, re-apply import rewrites.
3. `pnpm test:coverage` — every covered cell must still pass.
4. `pnpm verify` after — hashes WILL change (three version is in the hash). Update the version table in `VENDORING.md`.

## Phase status

| Phase | Status |
|---|---|
| 1 — Node harness | Done (skeleton) |
| 2 — `.precompile(name)` + dev capture | Done |
| 3 — AOT codegen | Done (camera/object/material/time/uniform.constant/uniform.live) |
| 4 — Build-time rewrite | Done |
| 5 — Coverage matrix | 17 cells; expand toward full TSL surface |
| 6 — 206-example batch harness | Skeleton; needs Vite + Playwright orchestration |
| 7 — Slim runtime bundle | Rollup config; needs alias plugin |
| 8 — Launch | Docs done; needs demo deployments + adoption |

## Code style

- Tabs (matches the vendored three.js source).
- One blank line between top-level declarations.
- No trailing whitespace.
- Comments explain *why*, not *what*. Default to no comment.
- Test names: `describe what the cell asserts in present tense`.

## Pull request checklist

- [ ] Tests added or updated
- [ ] `pnpm test` passes
- [ ] `pnpm test:coverage` passes
- [ ] If touching `emit-updater.js`, the matrix is still 100% covered or documented-blocked
- [ ] If vendored files changed, `VENDORING.md` updated
