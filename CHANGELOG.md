# Changelog

All notable changes to `vite-plugin-tsl-precompile` and `@tsl-precompile/runtime` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until the first npm publish lands, the v0.1.0 entry below is the rolling release-candidate.

## [Unreleased] — v0.1.0 release candidate

### Added
- **Vite plugin** (`vite-plugin-tsl-precompile`) — AOT pipeline for three.js TSL materials marked with `.precompile('name')`. Dev capture endpoint, build-time Babel rewrite to `__applyPrecompiled(...)`, virtual-module resolution per artifact name, WGSL string deduplication and minification.
- **Runtime** (`@tsl-precompile/runtime`) — dev marker, dev-renderer wiring, artifact loader, hydrator, UBO writers, `PrecompiledMaterial`, aux registry (background/PMREM/postprocessing), live-scene index, PMREM support, material variants.
- **One-call setup** — `setupPrecompile({ three, renderer })` composes the marker install, dev-renderer registration, and optional aux capture, removing the init()-ordering footgun.
- **`slim` mode** — `tslPrecompile({ slim: true })` aliases `three/webgpu` to a node-builder-stripped bundle (~239 KB gzip) and stubs `three/tsl` with loud errors for any un-precompiled path.
- **`autoMark` mode** — `tslPrecompile({ autoMark: true })` chains `.precompile('auto-<n>')` onto every `new *NodeMaterial(...)` in source, useful for trying the pipeline on existing projects without source edits.
- **Inspector panel** (`@tsl-precompile/inspector-panel`) — dev-time three.js Inspector tab showing live captures + WGSL sizes + supported-kind status.
- **TypeScript declarations** — `.d.ts` files for both `vite-plugin-tsl-precompile` and `@tsl-precompile/runtime`, with module augmentation that adds `Material.precompile(name)` to the `three` type surface.
- **Option validation** — plugin throws at vite startup on unknown keys, invalid `fail` enum values, and wrong types, with named-option errors that list the known keys.
- **Troubleshooting docs** — README has a Requirements compatibility block (WebGPU-only, three.js ≥0.184, Vite ≥5, Node ≥20.19) and a Troubleshooting section for the common errors.
- **CI bootstrap path** — passing `fail: 'warn'` in plugin options lets `vite build` succeed on a fresh checkout before any artifacts are captured.
- **E2E harness** — `pnpm test:e2e` runs stock-three → capture → slim replay across the three.js webgpu examples with a default 30 dB PSNR visual gate; `pnpm test:batch` runs the extractor/codegen sweep; `pnpm verify` validates artifact/manifest integrity.

### Status

The v0.1 beta target is ordinary PBR application rendering (`Mesh{Standard,Physical}NodeMaterial`, texture maps, env maps / PMREM, direct lights, shadows, material uniforms). Compute/storage is experimental; broad postprocessing/MRT beyond focused bloom stays outside the beta target. Live visual coverage at [packages/examples/batch/results/coverage-summary.md](packages/examples/batch/results/coverage-summary.md).

### Notes

- Both packages are scoped under the same `0.0.x` lockstep policy until v0.1.0 ships to npm. Pin to a tested three.js patch — see [MIGRATION.md](MIGRATION.md) for the re-capture workflow when bumping three.js.
- Captured artifacts (`./artifacts/*.json`) should be committed to git; CI must be able to build without re-running dev capture. See the Troubleshooting section of the README.
