# Announcement — maintainer draft

> **Audience: maintainers only.** This file is a draft of the release-day
> messaging for v0.1.0. It is checked into the repo so the wording is
> review-able alongside code, but it is **not** consumer documentation.
> External users should start with [README.md](README.md), [BYO.md](BYO.md),
> and [CHANGELOG.md](CHANGELOG.md).

To be published when the project hits its v0.1 beta release gate:
- [x] representative PSNR coverage for the beta support slice (163 / 226 graded; shadows 8/8, lights 8/12, focused bloom green)
- [x] npm dry-runs for contract / plugin / runtime (now via `pnpm pack:dry`, which rewrites `workspace:*` correctly)
- [x] productized slim+fallback policy decision (P1.6 — slim is primary, full renderer is opt-in fallback)
- [x] adopter-facing BYO guide
- [ ] at least one external adopter reports success

## Tweet / BlueSky

> Shipped: `vite-plugin-tsl-precompile`, an AOT compiler for three.js TSL materials.
>
> Add `material.precompile('name')` once. The Vite plugin captures + bakes it. Slim runtime ships static WGSL + a generated UBO updater per material — no node builder at runtime.
>
> Inspired by Unreal's Material Compiler. Demo: <ocean-demo-url>
>
> https://github.com/Makio64/vite-plugin-tsl-precompile

## three.js Discord post

> Hey 👋
>
> Sharing an experiment that grew out of the `tsl-precompile` branch. The fork's runtime hydrator (~900 lines, IR interpreter) was structurally fighting both bundle size and per-frame CPU. New approach:
>
> - **Author marker**: add `material.precompile('name')` to any material.
> - **Vite plugin**: in dev, captures the artifact + hashes it. In prod, rewrites the call to `__applyPrecompiled(...)` and inlines the artifact import.
> - **Slim runtime**: AOT-generated `update(frame, material, view, byteOffset)` writes UBO bytes directly. No switch, no closures, JIT-inlineable.
>
> Same model Unreal's Material Compiler uses (offline shader compilation + generated `FMaterialUniformExpressionSet`), translated to JS / Vite.
>
> Status: v0.1 beta. Current target: ordinary PBR materials (`MeshStandardNodeMaterial` / `MeshPhysicalNodeMaterial`), texture maps, env maps / PMREM, direct lights, shadows, material uniforms, focused bloom, and artifact invalidation. Compute/storage and broad postprocessing remain experimental — for hard cases the runtime supports an opt-in full-renderer fallback on the shared GPU device.
>
> 5-minute "Bring Your Own Project" guide: <BYO.md-url>
> Repo: https://github.com/Makio64/vite-plugin-tsl-precompile
> Demos: <demo-urls>
> Architecture write-up: <ARCHITECTURE.md-url>
>
> Looking for one or two early adopters who'd be willing to try this on a real three.js + Vite + WebGPU app and report what breaks. I'll respond fast to issues.

## Blog post (outline)

1. **Why this exists** — the per-frame CPU + bundle-size walls of runtime IR interpretation; the AAA precedent (Unreal Material Compiler, Unity Shader Graph + SRP Batcher).
2. **The author surface** — `.precompile('name')`. Why explicit markers beat AST inference (loud failure, source-visible omissions, dynamic materials).
3. **What the plugin does** — dev capture, build rewrite, virtual modules, AOT updater codegen.
4. **The five staleness gates** — content hash, dev hot re-extract, build hash check, runtime hash assertion, CI verify.
5. **The slim + full-renderer fallback policy** — slim is the primary renderer; the hard 5% (shadows, compute, dynamic passes, PMREM) borrow a full `WebGPURenderer` on the shared `GPUDevice`. Opt-in via `createSlimSceneSupport({ fullRendererFallback: true })`.
6. **Extension hooks** — `registerKind()` for custom TSL nodes; `registerMaterial()` for subclassed materials whose class name might be minified across builds.
7. **Numbers** — bundle size before/after, per-frame CPU before/after, PSNR coverage for the beta slice, full-suite visual coverage.
8. **What's not done yet** — broad postprocessing (outline / SSGI / godrays still below the gate); AOT compute/storage; bundler abstraction (Vite only for now); custom subclass identity in minified prod (handled via `registerMaterial`).
9. **Try it** — `pnpm add -D vite-plugin-tsl-precompile @tsl-precompile/runtime` + the 10-line config from README. See [BYO.md](BYO.md) for the 5-minute walkthrough.

## What to NOT say

- Don't oversell. v0.1 beta means "credible for the stated PBR support slice." It is not a drop-in replacement for arbitrary three.js codebases yet.
- Don't claim "works on all three.js projects" — the audit calls out six architectural ceilings (closed KINDS registry, three.js patch-version hash coupling, Vite-only capture, slim Node coverage, addon support, harness-vs-runtime split). Several are addressable via the `registerKind` / `registerMaterial` extension APIs; the rest are roadmapped.
- Don't promise upstream three.js adoption — the plan is "permanent external", and changing that is a separate decision.
- Don't compare against Sunag's work — credit the `tsl-precompile` fork as the foundation; this is a different architectural choice on the same problem.

## Outreach checklist (post-publish)

- [ ] `git tag v0.1.0 && git push --tags`
- [ ] `pnpm publish --filter @tsl-precompile/contract --filter @tsl-precompile/runtime --filter vite-plugin-tsl-precompile` (pnpm rewrites `workspace:*` automatically on publish; do NOT use `npm publish` directly)
- [ ] Post tweet/bluesky
- [ ] Post three.js Discord
- [ ] Open a GitHub Discussion "v0.1 beta — looking for first adopters"
- [ ] Add the first adopter to [ADOPTERS.md](ADOPTERS.md) once they confirm a working build
