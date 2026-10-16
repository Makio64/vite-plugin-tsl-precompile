# Changelog

All notable changes to `vite-plugin-tsl-precompile`, `@tsl-precompile/runtime`,
and `@tsl-precompile/contract` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- The experimental r187dev profile now pins three dev `ec2b7458ea` (2026-10-15) installed as the vendored
  `three@0.187.0-dev.ec2b745` tarball (was `3995acf`, nominal `0.186.0`); the plugin/runtime peer range is
  `0.186.1 || 0.187.0-dev.ec2b745`. The published prebuilt slim bundle stays r186.
- r187dev slim `compileAsync` replay keeps three's own parallel pipeline window and time-budgeted
  `CompileScheduler` (#34816) and only swaps graph construction for synchronous hydration; the async
  pipeline error-scope and ShadowFilterNode rewrites accept the `ec2b745` sources unchanged.

### Fixed
- r187dev development capture: automatic renderer-output capture keyed its observed topology without the
  development revision/commit and never matched its own capture.
- Node harness captures (`extractMaterial`, `extract*Artifact`) verify an installed r187dev package by source
  fingerprint and use its identity when no explicit identity is passed.
- The r187dev NodeManager rewrite drops the uncalled `_reportBuildError` so the `nodes/Nodes.js` barrel import goes.
- `recapture-all` and the support-plan verifier require the cube PMREM stages when r187dev is installed.
- r187dev spot/point lights keep live `light.viewPosition` uniforms: `lightViewPosition()` became a `.once()`
  Fn call, and the extractor froze it as a snapshot (unlit spot-light floors).
- Artifact variant fingerprints normalize r187dev compact-Fn names (`fn<N>`), so materials that define Fns
  inside their node builders (SkyMesh clouds) merge across captures instead of failing as divergent variants.
- Build tooling (`TSLP_THREE_SOURCE_ROOT` + `TSLP_THREE_SOURCE_COMMIT`) accepts a Git checkout of the pinned
  r187dev commit, whose package.json still says `0.186.0`, on the same source fingerprint as the tarball once
  its stale `build/` is rebuilt (`npm ci --ignore-scripts && npm run build`; the compatibility workflow does so).
- r187dev slim `compileAsync` restores the material's side and the precompile scope when replay hydration
  throws (three's own `ec2b745` loop leaves the queued side applied).
- `verify` rejects every version-only development signature (`0.187.0-dev.ec2b745` as well as `0.186.0`), and
  the batch three-checkout check reports prerelease versions as rejected development REVISIONs.

## [0.1.0-alpha.0] - 2026-07-30

### Added
- **Vite plugin** (`vite-plugin-tsl-precompile`) — AOT pipeline for three.js TSL materials marked with `.precompile('name')`. Dev capture endpoint, build-time Babel rewrite to `__applyPrecompiled(...)`, virtual-module resolution per artifact name, WGSL string deduplication and minification.
- **Runtime** (`@tsl-precompile/runtime`) — dev marker, dev-renderer wiring, artifact loader, hydrator, UBO writers, `PrecompiledMaterial`, aux registry (background/PMREM/postprocessing), live-scene index, PMREM support, material variants.
- **One-call setup** — `setupPrecompile({ three, renderer })` composes the marker install, dev-renderer registration, and optional aux capture, removing the init()-ordering footgun.
- **`slim` mode** — `tslPrecompile({ slim: true })` aliases `three/webgpu` to a node-builder-stripped bundle and stubs `three/tsl` with loud errors for any un-precompiled path. Removes the TSL→WGSL compiler from production runtime (predictable cold start, lower per-frame CPU); gzip bundle size is roughly equivalent to stock three.js TSL on simple scenes.
- **Automatic material detection** — `tslPrecompile()` chains `.precompile('auto-<n>')` onto every direct `new *NodeMaterial(...)` in application source by default. Explicit markers take precedence; pass `autoMark: false` to opt out.
- **Inspector panel** (`@tsl-precompile/inspector-panel`) — dev-time three.js Inspector tab showing live captures + WGSL sizes + supported-kind status.
- **TypeScript declarations** — `.d.ts` files for both `vite-plugin-tsl-precompile` and `@tsl-precompile/runtime`, with module augmentation that adds `Material.precompile(name)` to the `three` type surface.
- **Option validation** — plugin throws at vite startup on unknown keys, invalid `fail` enum values, and wrong types, with named-option errors that list the known keys.
- **Troubleshooting docs** — README has a Requirements compatibility block (WebGPU-only, exactly three.js 0.185.1 for this alpha, Vite ≥6.4.3 and <9, Node ≥20.19) and a Troubleshooting section for the common errors.
- **CI bootstrap path** — passing `fail: 'warn'` in plugin options lets `vite build` succeed on a fresh checkout before any artifacts are captured.
- **E2E harness** — `pnpm test:e2e` runs stock-three → capture → slim replay across the three.js webgpu examples with a default 30 dB PSNR visual gate; `pnpm test:batch` runs the extractor/codegen sweep; `pnpm verify` validates artifact/manifest integrity.
- **Fail-closed release workflow** — publication requires a clean, live-remote
  `main` commit; lockstep package versions; an annotated/signed exact-commit
  tag present on the remote; deterministic tracked slim/skill outputs; current
  and minimum packed-consumer smokes; exact private tarball integrity; and
  authenticated, version-safe npm publication with post-write byte checks.
- **Signed capture requirement** — production loading and `tsl-precompile-verify` now reject unsigned legacy material artifacts. Re-run development capture (or `tsl-precompile-recapture`) with the current plugin across every reachable render route and commit the generated JSON; do not hand-edit old artifacts.

### Status

The v0.1 alpha target is ordinary PBR application rendering (`Mesh{Standard,Physical}NodeMaterial`, texture maps, env maps / PMREM, direct lights, shadows, material uniforms). Compute/storage is experimental; broad postprocessing/MRT beyond focused bloom stays outside the alpha target. Live visual coverage at [packages/examples/batch/results/coverage-summary.md](packages/examples/batch/results/coverage-summary.md).

### Notes

- The plugin, runtime, and contract packages always share one lockstep version, including prerelease identifiers. The first npm candidate is `0.1.0-alpha.0` across all three packages. Pin to a tested three.js patch — see [MIGRATION.md](MIGRATION.md) for the re-capture workflow when bumping three.js.
- The alpha plugin and runtime peer dependencies require exactly `three@0.185.1`; the strict rewrite, runtime replay, artifact re-capture, and visual compatibility gates are version-locked to that patch.
- TypeScript consumers need TypeScript 5.6 or newer; CI validates packed declarations with exact TypeScript 5.6.3 and 5.9.3 in strict NodeNext mode.
- Captured artifacts (`./artifacts/*.json`) should be committed to git; CI must be able to build without re-running dev capture. See the Troubleshooting section of the README.
