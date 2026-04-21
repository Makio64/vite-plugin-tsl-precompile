# Announcement (template — fill in once Phase 6 lands)

Use this when the project hits its v0.1 release gate (≥ 120 / 199 batch passing + at least one external adopter).

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
> Status: v0.1, batch passes <N> / 199 webgpu_*.html examples (baseline 68 / 199).
>
> Repo: https://github.com/Makio64/vite-plugin-tsl-precompile
> Demos: <demo-urls>
> Architecture write-up: <ARCHITECTURE.md-url>

## Blog post (outline)

1. **Why this exists** — the per-frame CPU + bundle-size walls of runtime IR interpretation; the AAA precedent (Unreal Material Compiler, Unity Shader Graph + SRP Batcher).
2. **The author surface** — `.precompile('name')`. Why explicit markers beat AST inference (loud failure, source-visible omissions, dynamic materials).
3. **What the plugin does** — dev capture, build rewrite, virtual modules, AOT updater codegen.
4. **The five staleness gates** — content hash, dev hot re-extract, build hash check, runtime hash assertion, CI verify.
5. **Numbers** — bundle size before/after, per-frame CPU before/after, batch pass rate.
6. **What's not done yet** — coverage matrix gaps, post-FX TSL, scene-state variant matrix.
7. **Try it** — `pnpm add -D vite-plugin-tsl-precompile @tsl-precompile/runtime` + the 10-line config from README.

## What to NOT say

- Don't oversell. v0.1 means "works on the flagship demos + survives the batch threshold." It's not a drop-in replacement for arbitrary three.js codebases yet.
- Don't promise upstream three.js adoption — the plan is "permanent external", and changing that is a separate decision.
- Don't compare against Sunag's work — credit the `tsl-precompile` fork as the foundation; this is a different architectural choice on the same problem.
