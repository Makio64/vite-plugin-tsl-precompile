# Contributing

Thanks for picking this up. Read [ARCHITECTURE.md](./ARCHITECTURE.md) first — the design rationale matters more than the code.

## Setup

```sh
git clone https://github.com/Makio64/vite-plugin-tsl-precompile.git
cd vite-plugin-tsl-precompile
pnpm install
pnpm test                # fast package checks for normal iteration
pnpm test:generation     # extractor and artifact-generation tests
pnpm test:full           # complete Node package/tooling suites (release has other gates)
pnpm test:coverage       # coverage-matrix fixtures
pnpm test:slim           # slim-bundle load-smoke, requires ../three.js
pnpm dev:ocean           # open the ocean demo
```

## Fast feedback

Run the affected files while editing, then the required gate once before handoff:

```sh
pnpm test -- --scope=runtime --match=hydrate-storage-buffer
pnpm test:full -- --scope=plugin --match=aux-capture
pnpm test:batch:unit -- --match=psnr
pnpm test:batch:unit -- --match=capture --match=network --low-memory
pnpm test:low-memory     # one ordinary file worker when RAM is tight
pnpm test:full -- --scope=site --match=examples-evidence-contract
pnpm test:full -- --list  # inspect the selected files without executing them
```

Scopes are `contract`, `plugin`, `runtime`, `inspector`, `site`, `tooling`, and
`batch`. `--match` is a literal substring of a test file path, not a test-name
filter; repeat it to select several groups of files. All cases in each selected
file run. No match is an error. A focused
run does not substitute for required cross-package or browser gates.

The shared runner prints failures, counts, slow files, and a temporary log directory.
The full spec logs include successful tests and captured stdout/stderr. Use
`--verbose` to stream them. Normal tests use two isolated file workers by default;
`--workers=4` or `TSLP_TEST_CONCURRENCY=4` overrides that budget. `--low-memory`
uses one worker. Compiler/rewrite/pack fixtures remain serial. `--fail-fast` stops
at the first failed group. A five-minute group watchdog stops stalled workers and
their child processes; `--timeout=600000` allows ten minutes, and `--timeout=0`
disables it. Full suites include the quick checks, so do not run both repeatedly.
The full-campaign site fixture belongs to `test:full`; quick runs retain the smaller
site contracts. CI still executes every campaign assertion in the full suite.

During browser capture work, select one affected example before running a tier:

```sh
TSLP_E2E_OUT=/tmp/tslp-capture-check pnpm test:e2e -- --local-examples-root=../compute-debug --filter=uniform.html --timings --no-coverage
```

This writes isolated evidence outside the working tree and runs stock, capture,
and replay for that example. Local diagnostics use the installed matching Three
package unless an explicit checkout is selected. Upstream tiers and canonical
campaigns still require the matching official checkout. Keep GPU visits serial.
For long campaigns on a machine with limited RAM,
`TSLP_E2E_MAX_RUNS_PER_BROWSER=1` restarts Chromium after each case; this trades
additional browser startup time for earlier release of browser/GPU resources.
A complete tier or campaign
remains the required visual gate for changes that affect rendering.

`pnpm verify` checks stored artifacts without a browser. Use generation fixtures for
extractor changes, batch/site Node contracts for evidence logic, and the tier-1
visual gate for rendering changes. See [AGENTS.md](AGENTS.md) for the gate matrix.
Keep historical investigations in [evolution-archive.md](evolution-archive.md);
the active architecture and roadmap should remain short enough to read first.

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
| 6 — 272-case batch harness | Exact corpus: 224 official Three r186 WebGPU examples + 48 local routes; capture/replay evidence campaign exists |
| 7 — Slim runtime bundle | Slim load-smoke exists |
| 8 — Launch | Docs/site exist; needs external adoption |

## Code style

- Tabs (matches the vendored three.js source).
- One blank line between top-level declarations.
- No trailing whitespace.
- Comments explain *why*, not *what*. Default to no comment.
- Test names: `describe what the cell asserts in present tense`.

## Pull request checklist

- [ ] Behavior changes have relevant regression coverage
- [ ] `pnpm test` passes while iterating
- [ ] `pnpm test:full` passes before release
- [ ] `pnpm test:coverage` passes for codegen/kind/extractor changes (already included in full)
- [ ] If touching `emit-updater.js`, the matrix is still 100% covered or documented-blocked
- [ ] If vendored files changed, `VENDORING.md` updated
