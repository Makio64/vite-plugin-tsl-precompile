# batch (example harness)

Runs the plugin and slim runtime against the checked 254-case catalogue:
209 official Three r185 WebGPU examples plus 45 local routes in six projects.

## Target

Keep the extractor/codegen and slim-bundle load-smoke harnesses green enough to
catch crashes, then use the independent E2E pixel and semantic gates for
correctness. Pass counts are evidence-snapshot data rather than documentation;
`packages/examples/batch/results/coverage-summary.md` carries the generated
table for its manifest-bound run.

For the E2E harness, start with focused filters in an isolated output root. It
automates the real loop for stock examples: clean stock full-three reference,
capture pass for auto-marked NodeMaterial artifacts, then slim replay with
captured user and aux artifacts. A pass requires artifact coverage, no blocking
browser/runtime error, a non-empty replay, a valid passing semantic evidence
gate, and the PSNR threshold (30 dB by default) unless the checked configuration
marks that one image comparison diagnostic. Use `--no-pixel-gate` only for
isolated diagnostics when the goal is to inspect load/runtime failures
separately from visual correctness.

Canonical pixel-gate exceptions live in `coverage-config.json` and retain every
non-pixel gate. There is exactly one: the `volatileCompute` entry
`webgpu_storage_buffer.html`. In three.js r185 it dispatches 32 invocations in a
default 64-thread workgroup, reads the reversed index before bounds protection,
and orders storage writes with only `workgroupBarrier()`. Its image comparison
is therefore diagnostic rather than a product-correctness signal. Every other
canonical row remains pixel-gated.

The independent `tslp-e2e-semantic-evidence-gate@3` prevents a matching image
from hiding an incomplete execution. Stock, capture, and replay must each be
observed and explicitly report `freezeCompleted: true`; a missing phase,
incomplete freeze, or timeout blocks the row. Every unexpected browser/runtime
or GPU error and every `[tslp*]` or `[tsl-precompile*]` warning is blocking.
Each phase must also prove
that the GPU hook saw a device, installed both error observers, and completed a
submitted-work fence on every observed queue.

Operation evidence is bound to a complete
`tslp-e2e-operation-registry@1`. The policy permits the known required replay
operations for material compute, direct `NodeMaterial` replacement,
`RenderPipeline` pass rendering, and Bloom rendering. Missing outcomes, unknown
operations, duplicate outcomes, and attempts to downgrade requiredness fail
closed. Only `capture/auxiliary-capture/*` outcomes may be declared
`required: false`; optional auxiliary failures remain visible but do not turn
an otherwise valid product row red.

A required failure is non-blocking only when every ordered failure record is
rebound to the exact operation, selector-failure class, and effect, with a
distinct later render and presentation for that failure. The accepted paths are
`render-pipeline-pass/render-pass-node` for `FSR1Node` with successful full-pass
and presentation counters and no downstream failure, or
`bloom/render-bloom-chain` for `BloomNode` with successful render and
presentation counters. Coverage aggregation validates the stored gate again;
it does not trust `status: "pass"` or pixels alone.

Schema-2 evidence is run-scoped. A cohort manifest at
`<output-root>/evidence-manifest.json` binds its completed report, configuration,
source/toolchain provenance, artifact dumps, and paired PNGs below
`<output-root>/evidence/<runId>/`. Loose reports or screenshots are not graded.
Canonical output fails closed unless it is the exact fresh corpus; filters,
tiers, replay reuse, custom timing/thresholds, and local suites must use an
isolated `--output-root`.

The manifest also binds the repository-source snapshot and harness-source
fingerprint. Editing any fingerprinted source invalidates the prior campaign,
even when its PNGs still look correct. Regenerate a fresh exact campaign before
publishing coverage after such a change; never relabel or combine a stale run
as current evidence. Local cohorts additionally bind the exact discovery
manifest bytes, manifest options, discovered HTML inventory, route bytes, and
repository paths. Aggregation and publication rediscover that catalogue from
the current checkout and reject a stale or incomplete local snapshot.

Canonical runs also record a self-contained proof for every served Three file:
path, bytes, SHA-256, Git blob, mode, object format, and the official r185
commit/tree. The proof count is nonzero and exact, and its aggregate digest is
recomputed from the per-file records. In visual evidence, that list must match
`manifest.sources.three` exactly, including its `fileCount`, JSON fingerprint,
and `threeCheckout.sourceFingerprint`; the stock report validates the same
self-contained list without relying on a visual manifest. The stock report also
binds its recursively resolved harness imports, workspace lock/package inputs,
actual browser/WebGPU environment fingerprint, and positive per-route GPU
device/observer/queue-fence proof.

Artifact evidence is verified as stored bytes, not merely as parsed JSON. Each
descriptor is checked for run identity and path containment, then its stored
size and SHA-256 are verified before bounded gzip decompression, strict UTF-8
decoding, and schema validation. The descriptor must also agree on
`contentEncoding: "gzip"` and the exact uncompressed byte count. This repository
has changed its fingerprinted v2 harness sources; do not claim a final
254-route result until a fresh exact campaign completes and its manifest,
report, artifacts, and screenshots pass these checks together.

For runtime-only diagnostics, pass both roots explicitly. `--input-root` selects
the manifest-bound saved cohort; `--output-root` receives a new run ID, report,
artifact dumps, and screenshot pair. `--replay-only` reuses the saved capture
and artifacts; `--reuse-reference-shot` reuses only the capture and recaptures
artifacts. Neither mode mutates or promotes the canonical campaign.

```sh
node packages/examples/batch/run-e2e-with-coverage.mjs \
  --filter=webgpu_clearcoat.html \
  --input-root=packages/examples/batch/results \
  --output-root=/tmp/tslp-clearcoat \
  --replay-only
```

Use `--timings` while tuning slow examples. The harness now caps the unreliable pre-screenshot WebGPU brightness poll and uses shorter fixed settle windows; if a specific example needs the old conservative behavior, override with `--bright-poll-ms=12000 --asset-settle-ms=1500 --present-settle-ms=1000 --settle-frames=30`.

The E2E runner prints concise per-example progress by default and writes full
details to the selected output root. It honors `--filter`, `--limit`, and
`--offset`; every partial sweep needs an isolated output root.

For a narrow diagnostic, set `TSLP_E2E_OUT` or pass
`--output-root=<absolute-path>`. Reports, run-scoped screenshots, artifact dumps,
and the optional coverage summary all stay under that root. Saved inputs default
to canonical `results/`, but `TSLP_E2E_INPUT` or `--input-root` should be explicit
in reusable commands and must point to the owning cohort root for local cases.

```sh
TSLP_E2E_OUT=/tmp/tslp-backdrop-canary pnpm --filter examples-batch run:e2e:raw -- --filter=webgpu_backdrop.html --reuse-reference-shot --no-save-shots --report=backdrop.json
```

To test a freshly built slim bundle without replacing the checked
`packages/runtime/build/three.webgpu.slim.js`, pass
`--slim-bundle=<absolute-or-relative-path>` or set
`TSLP_E2E_SLIM_BUNDLE` (or the general `TSLP_SLIM_BUNDLE` alias). Both runners
use the same precedence: CLI, `TSLP_E2E_SLIM_BUNDLE`, `TSLP_SLIM_BUNDLE`, then
the checked default. `run-slim.mjs` forwards the resolved override to its
pixel-gate child runs. Relative paths resolve from the harness process working
directory. Every E2E/slim report records the resolved absolute path and full
SHA-256; the startup log prints the path and a short hash so visual evidence
can be tied to the exact bundle bytes.

```sh
TSLP_E2E_OUT=/tmp/tslp-backdrop-canary pnpm --filter examples-batch run:e2e:raw -- --filter=webgpu_backdrop.html --slim-bundle=/tmp/three.webgpu.slim.js --reuse-reference-shot --no-save-shots
```

Selector failures in the JSON report include the replay-active selector hash/topology, every captured candidate hash/topology, and ranked field-level differences. Artifact summaries label selectors by root artifact or variant source; exact selection still fails closed when no captured topology matches.

The runner recycles Chromium every two examples by default to avoid long WebGPU process lifetimes. Override with `--max-runs-per-browser=<n>` / `TSLP_E2E_MAX_RUNS_PER_BROWSER` and `TSLP_E2E_BROWSER_RESPAWN_DELAY_MS` only when investigating harness performance or browser behavior; those overrides force diagnostic/noncanonical evidence and are rejected by canonical and official-source runs. Pass `--verbose` or set `TSLP_E2E_VERBOSE=1` to forward page warnings/logs while debugging harness internals.

The E2E server automatically falls forward to the next free port when the requested port is occupied. Use `--port=<n>` to choose the first port and `--port-retries=<n>` to cap the retry window.

Animated examples compare the first fully loaded settled frame by default (`--target-tick=0`) so async asset timing does not masquerade as a shader regression. Use `--target-tick=<n>` when intentionally auditing a later animation phase.

## Agent-friendly hard-scene checks

Use the checked hard-scene entrypoint when an agent needs one exact advanced
WebGPU case instead of inventing harness flags. `--plan` writes exactly one JSON
object to stdout and lists the accepted filenames, required inputs, fixed visual
gate, and executable next action:

```sh
node packages/examples/batch/run-hard-scene.mjs --plan
node packages/examples/batch/run-hard-scene.mjs \
  --plan \
  --case=webgpu_postprocessing_ssr_denoise.html \
  --three-repo=/path/to/clean-three-r185
```

Execute a case with the exact `.html` filename from the plan:

```sh
pnpm test:e2e:hard-scene -- \
  --case=webgpu_pmrem_cubemap.html \
  --three-repo=/path/to/clean-three-r185
```

The runner delegates to the existing capture/replay harness, keeps the 30 dB
PSNR gate enabled, and creates a new temporary evidence root by default. An
explicit `--output-root` must not already exist and cannot point into repository
results, so an agent cannot overwrite canonical or prior evidence. The checked
manifest covers PMREM/cubemaps, reflectors, SSR and temporal denoise, SSS, TAAU,
texture-gather render targets, progressive and VSM shadows, advanced light
types, and representative post-processing pipelines.

For machine execution, treat `--plan` as the authority:

- `case-selection-required` means select one exact `cases[].filename` by its
  declared `features` and request a new plan.
- `three-checkout-required` means resolve `threeRepo`; do not run the incomplete
  action.
- `ready` means spawn `nextAction.argv` directly from `nextAction.cwd`. Do not
  join the argv through a shell, lower the threshold, add `--no-pixel-gate`, or
  reuse an existing output root.

The execution command prints `[hard-scene] evidence <output-root>`. Grade the
single generated `<case-basename>-hard-scene-report.json` only when it has
`status: "completed"`, `total: 1`, `pass: 1`, `fail: 0`, and its sole
`details[]` record has `status: "pass"`,
`evidenceGate: { schema: "tslp-e2e-semantic-evidence-gate@3", pass: true }`,
and `pixelGate: { pass: true, threshold: 30 }`. Preserve the report,
`evidence-manifest.json`, and its run-scoped screenshots/artifacts together;
the report alone is not portable proof. A green upstream case validates the
plugin and selected slim bundle, not an unrelated consumer application's
route/topology coverage or production preview.

## Local results UI

Run `pnpm examples:ui` from the repo root to launch the local results interface.
It reads `coverage-evidence-set.json`, verifies each referenced cohort manifest
and completed report, and serves only their run-bound capture/replay
descriptors. It never scans or trusts loose historical files.

Each button launches a focused diagnostic below a dedicated generated temporary
directory and passes the owning canonical cohort separately as `--input-root`.
When the run finishes, that case is overlaid in the UI with a clear
`diagnostic pass` / `diagnostic fail` label; canonical totals and status remain
unchanged. Replay/reuse buttons stay disabled when exact canonical saved input
is unavailable.

Use `pnpm examples:ui -- --port=8788` to pick a different UI port, or `pnpm examples:ui -- --three-repo=/path/to/three.js` when the three.js checkout is not the default sibling directory.

Historical error buckets from the monolithic slim fork:

| Bucket | Cases | Plan-time disposition |
|---|---|---|
| "no node builder" | 70 | Should mostly dissolve — AOT runs the real builder, no stub holes. |
| `outputNode.context` | 12 | Needs `.precompile()` on outputNode passes (Phase 3 bloom demo). |
| `minFilter` | 10 | Seed material texture slots post-swap. |
| compute-node | 10 | Wrap computeAsync proxies in PrecompiledComputeNode. |
| `id` undefined | 8 | Hydrator weak-map keys. |
| `update` undefined | 5 | Per-frame update hooks. |

## Auto-mark mode

Source examples aren't written with `.precompile()` calls. The harness injects `material.precompile(exampleName + ':<materialId>')` on every material it discovers — proves the extractor's coverage on the broad TSL surface.

## Commands

Canonical public evidence has two independent browser inputs. The exact visual
campaign writes the 209 upstream plus 45 local capture/replay cohorts, but it
does not create the stock smoke report consumed by the site. Use fresh external
output roots for both runs, then pass both paths to the site data generator.
`pnpm coverage:site` only revalidates existing default inputs; it does not run
either browser campaign.

```sh
pnpm test:batch
pnpm test:slim
node packages/examples/batch/run.mjs \
  --three-repo=/path/to/clean-three-r185 \
  --output-root=/tmp/tslp-stock-209 \
  --canonical-evidence
pnpm --filter examples-batch run:evidence-campaign -- \
  --three-repo=/path/to/clean-three-r185 \
  --output-root=/tmp/tslp-evidence-254
TSLP_E2E_OUT=/tmp/tslp-evidence-254 \
TSLP_STOCK_REPORT=/tmp/tslp-stock-209/report.json \
pnpm --filter @tsl-precompile/site data
pnpm test:e2e -- --filter=webgpu_lights_custom --output-root=/tmp/tslp-lights-custom
pnpm test:e2e -- --limit=12 --output-root=/tmp/tslp-first-12
pnpm test:e2e -- --filter=webgpu_clearcoat.html --timings --output-root=/tmp/tslp-clearcoat-timing
pnpm test:e2e:replay -- --filter=webgpu_lights_custom --input-root=packages/examples/batch/results --output-root=/tmp/tslp-lights-replay
pnpm examples:ui
pnpm coverage:site
node packages/examples/batch/run.mjs --three-repo=/path/to/three.js --filter=webgpu_backdrop
node packages/examples/batch/run-slim.mjs --three-repo=/path/to/three.js --filter=webgpu_backdrop
node packages/examples/batch/run-e2e.mjs --three-repo=/path/to/three.js --filter=webgpu_lights_custom --output-root=/tmp/tslp-lights-custom
node packages/examples/batch/run-e2e.mjs --filter=webgpu_backdrop --output-root=/tmp/tslp-backdrop
node packages/examples/batch/run-e2e.mjs --local-examples-root=/path/to/local/pages --filter=directional --output-root=/tmp/tslp-local-directional
```

`/tmp/tslp-evidence-254` must be new or empty; the campaign runner rejects a
non-empty or symbolic-link output root rather than mixing evidence generations.

By default the scripts look for a sibling `../three.js` checkout from the repo root. Use `--local-examples-root=/path/to/pages` with an isolated `--output-root` when you want the E2E harness to serve a small local `.html` corpus instead of upstream three.js examples. External roots remain byte-snapshotted diagnostic evidence; canonical coverage and site publication accept only the checked repository cohorts.
