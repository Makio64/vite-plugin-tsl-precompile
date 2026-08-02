# Contributing

Thanks for picking this up. Read [ARCHITECTURE.md](./ARCHITECTURE.md) first — the design rationale matters more than the code.

## Setup

```sh
git clone https://github.com/Makio64/vite-plugin-tsl-precompile.git
cd vite-plugin-tsl-precompile
pnpm install
pnpm test                # fast package checks for normal iteration
pnpm test:generation     # extractor and artifact-generation tests
pnpm test:full           # complete release suite
pnpm test:coverage       # coverage-matrix fixtures
pnpm test:slim           # slim-bundle load-smoke, requires ../three.js
pnpm dev:ocean           # open the ocean demo
```

## How to add a `source.kind`

Every TSL primitive that produces a binding descriptor has a cross-package
`source.kind` (for example `camera.projectionMatrix` or `material.color`).
Executable kinds are a closed contract: the public registry can document a
custom kind as intentionally blocked, but it cannot install codegen/runtime
handlers.

1. Add the vocabulary and status in
   [`packages/contract/src/kinds.js`](packages/contract/src/kinds.js), including
   its declaration and contract/drift tests.
2. Update the extractor so it emits the kind from real captured state.
3. Add the codegen handling in
   [`packages/plugin/src/emit-updater.js`](packages/plugin/src/emit-updater.js).
4. Add the corresponding runtime writer/hydration behavior.
5. Add coverage fixtures that prove extraction, generated code, and runtime
   behavior agree, then run `pnpm test:generation`, `pnpm test:coverage`, and
   the focused runtime tests.

Land those pieces together. Unsupported or incomplete kinds must remain
explicitly blocked with a recovery reason; never make contract validation
accept vocabulary that codegen/runtime cannot execute.

## How to upgrade the vendored three.js files

See [packages/plugin/src/vendor/VENDORING.md](packages/plugin/src/vendor/VENDORING.md). The procedure is:

1. `pnpm verify` to check committed artifact and manifest integrity.
2. Copy newer source from the fork, re-apply import rewrites.
3. `pnpm test:coverage` — every covered cell must still pass.
4. `pnpm verify` after — artifact metadata must still be valid. Hashes can change because the three.js version is part of the hash.

## Phase status

| Phase | Status |
|---|---|
| 1 — Node harness | Done (skeleton) |
| 2 — `.precompile(name)` + dev capture | Done |
| 3 — AOT codegen | Done (camera/object/material/time/uniform.constant/uniform.live) |
| 4 — Build-time rewrite | Done |
| 5 — Coverage matrix | Fixture coverage exists; expand toward full TSL surface |
| 6 — 254-case batch harness | Exact corpus: 209 official Three r185 WebGPU examples + 45 local routes; capture/replay evidence campaign exists |
| 7 — Slim runtime bundle | Slim load-smoke exists |
| 8 — Launch | Docs/site exist; needs external adoption |

## Code style

- Tabs (matches the vendored three.js source).
- One blank line between top-level declarations.
- No trailing whitespace.
- Comments explain *why*, not *what*. Default to no comment.
- Test names: `describe what the cell asserts in present tense`.

## Pull request checklist

- [ ] Tests added or updated
- [ ] `pnpm test` passes while iterating
- [ ] `pnpm test:full` passes before release
- [ ] `pnpm test:coverage` passes
- [ ] If touching `emit-updater.js`, the matrix is still 100% covered or documented-blocked
- [ ] If vendored files changed, `VENDORING.md` updated
