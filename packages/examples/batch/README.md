# batch (example harness)

Runs the plugin and slim runtime against the 206 `webgpu_*.html` examples from a local three.js repo. Phase 6/7 gate.

## Target

Keep the extractor/codegen and slim-bundle load-smoke harnesses green enough to catch crashes, then use E2E PSNR for visual correctness. Current pass counts move quickly; use [STATUS.md](../../STATUS.md) for the latest curated snapshot and `packages/examples/batch/results/coverage-summary.md` for a generated visual table.

For the E2E harness, start with focused filters. It automates the real loop for stock examples: clean stock full-three reference, capture pass for auto-marked NodeMaterial artifacts, then slim replay with captured user and aux artifacts. A pass means replay reached a non-empty frame without unexpected browser errors and meets the PSNR pixel-diff threshold (30 dB by default). Use `--no-pixel-gate` for diagnostics when the goal is to inspect load/runtime failures separately from visual correctness. Many examples are expected to fail today; v0.1 beta should prioritize the PBR slice first: shadows, PMREM/environment/reflections, then transmission/viewport/reflector texture paths. Compute/storage remains experimental. Focused bloom/PassNode replay is green, but MRT and broad postprocessing are still not the beta target.

The default E2E scripts save paired capture/replay PNGs to `packages/examples/batch/results/shots/` and refresh `packages/examples/batch/results/coverage-summary.md` after each run. Pass `--no-save-shots` or `--no-coverage` only for throwaway diagnostics; the raw harness script is still available as `run:e2e:raw`.

For runtime-only screenshot refreshes, use `pnpm test:e2e:replay -- --filter=<example>`. It skips the stock/reference and artifact-capture visits, loads `results/shots/<example>.capture.png` plus `results/artifacts/<example>.{user,aux}.json`, and regenerates only the slim replay PNG/report. If the plugin/extractor or captured artifact format changed, run a normal `pnpm test:e2e -- --filter=<example>` instead. `--reuse-reference-shot` is the middle path: reuse the saved stock PNG but still recapture fresh artifacts.

Use `--timings` while tuning slow examples. The harness now caps the unreliable pre-screenshot WebGPU brightness poll and uses shorter fixed settle windows; if a specific example needs the old conservative behavior, override with `--bright-poll-ms=12000 --asset-settle-ms=1500 --present-settle-ms=1000 --settle-frames=30`.

The E2E runner prints concise per-example progress by default and writes full details to `packages/examples/batch/results/e2e-report.json`. It honors `--filter`, `--limit`, and `--offset`, so `pnpm test:e2e -- --limit=12` is a quick partial visual sweep.

The runner recycles Chromium every two examples by default to avoid long WebGPU process lifetimes. Override with `--max-runs-per-browser=<n>` / `TSLP_E2E_MAX_RUNS_PER_BROWSER` and `TSLP_E2E_BROWSER_RESPAWN_DELAY_MS` only when investigating harness performance or browser behavior. Pass `--verbose` or set `TSLP_E2E_VERBOSE=1` to forward page warnings/logs while debugging harness internals.

The E2E server automatically falls forward to the next free port when the requested port is occupied. Use `--port=<n>` to choose the first port and `--port-retries=<n>` to cap the retry window.

Animated examples compare the first fully loaded settled frame by default (`--target-tick=0`) so async asset timing does not masquerade as a shader regression. Use `--target-tick=<n>` when intentionally auditing a later animation phase.

## Local results UI

Run `pnpm examples:ui` from the repo root to launch a local interface over `results/shots/`. It shows every saved live-three.js capture beside the slim replay, with PSNR/status metadata from `coverage-summary.md`. Each example has buttons to regenerate the full capture+replay, regenerate replay only, or reuse the saved capture and refresh the artifacts/replay.

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

```sh
pnpm test:batch
pnpm test:slim
pnpm test:e2e -- --filter=webgpu_lights_custom
pnpm test:e2e -- --limit=12
pnpm test:e2e -- --filter=webgpu_clearcoat.html --timings
pnpm test:e2e:replay -- --filter=webgpu_lights_custom
pnpm examples:ui
pnpm coverage:site
node packages/examples/batch/run.mjs --three-repo=/path/to/three.js --filter=webgpu_backdrop
node packages/examples/batch/run-slim.mjs --three-repo=/path/to/three.js --filter=webgpu_backdrop
node packages/examples/batch/run-e2e.mjs --three-repo=/path/to/three.js --filter=webgpu_lights_custom
node packages/examples/batch/run-e2e.mjs --local-examples-root=/path/to/local/pages --filter=directional
```

By default the scripts look for a sibling `../three.js` checkout from the repo root. Use `--local-examples-root=/path/to/pages` when you want the E2E harness to serve a small local `.html` corpus instead of upstream three.js examples.
