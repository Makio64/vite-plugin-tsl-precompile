# v0.1 Ship Readiness

Snapshot of release blockers vs ready, as of 2026-05-14. Owner column: **claude** = automatable in-repo work, **user** = requires human action (auth, social, judgement).

## Done

| Item | Owner | Evidence |
|---|---|---|
| Phase 1–5 (Node harness, .precompile, AOT codegen, build-time rewrite, coverage matrix) | claude | [ROADMAP.md](ROADMAP.md), [STATUS.md](STATUS.md) phase table |
| Phase 6 (206-example batch harness) | claude | `pnpm test:batch` green |
| Phase 7 (slim runtime bundle) | claude | `pnpm test:slim` green; tarball 1.48 MB |
| Tier-1 / 2 / 3 visual gates | claude | `pnpm test:e2e:tiers` — see [STATUS.md](STATUS.md) |
| Adopter-friendly preview pipeline | claude | ocean demo: zero `import.meta.env.DEV` guards; Inspector loads in `vite preview` via `attachInspectorExtensionsShim` middleware |
| `pnpm pack:dry` for all three packages | claude | `/tmp/{vite-plugin-tsl-precompile,tsl-precompile-runtime,tsl-precompile-contract}-0.1.0.tgz` |
| `pnpm verify` | claude | 48 artifact files validated |
| Migration guide | claude | [BYO.md](BYO.md) covers install → mark → capture → ship → day-2 workflow |
| Release runbook | claude | [RELEASING.md](RELEASING.md) covers pre-flight, publish order, post-publish smoke |

## Pending — user action

| Item | Owner | Notes |
|---|---|---|
| `pnpm publish` to npm | **user** | Needs npm auth (`npm whoami` returns your handle, `npm token`, or `NPM_TOKEN` env). Run `pnpm release:check` last, then the `pnpm -r ... publish --access public` block from [RELEASING.md](RELEASING.md). |
| `git tag v0.1.0 && git push --tags` | **user** | Post-publish |
| Scratch-dir smoke test post-publish | **user** | The `mkdir /tmp/tslp-smoke && pnpm add -D vite vite-plugin-tsl-precompile ...` block in [RELEASING.md](RELEASING.md) |
| One external adopter | **user** | ROADMAP Phase 8 gate. Open a GitHub Discussion / share on three.js Discord. Track in [ADOPTERS.md](ADOPTERS.md). Cannot be automated. |
| Hosted-CI stability watch | **user** | `tier1`, `tier2`, `tier3`, and `preview-smoke-ocean` are PR-blocking locally. Watch for hosted-CI flake before expanding into broader gates. |

## Pending — automatable follow-ups

| Item | Severity | Notes |
|---|---|---|
| `tier-excluded-runtime-errors` (4 real bugs) | P2 | SMAA shader compile, afterimage Proxy(Function), FSR1 texture NodeError, rendertarget_2d-array_3d harness serialization. See [BACKLOG.md](BACKLOG.md) for the full list. |
| `pmrem-cubemap-bg` reflection routing | P1 | `webgpu_reflection.html` (16 dB), `_roughness` (17 dB) — tree mesh missing in replay. See [BACKLOG.md](BACKLOG.md). |
| `transmission-viewport-texture` refraction | P1 | `webgpu_refraction.html` (14 dB). Bind-group caching suspected. |
| Demo `pbr-shadows` artifact capture | P3 | `pbr-shadows` demo build fails without a prior `pnpm dev` capture. Either (a) document prominently in `pbr-shadows/README.md` or (b) commit artifacts to git (override `packages/examples/**/artifacts/` gitignore). |
| Broad postprocess pass-chain (outline / SSR / godrays / DOF / SSGI) | P2 | Pixel-gate currently disabled for these. Each needs a slim PassNode investigation. |
| Custom `uniform.live` closures freeze | P2 | Build warning now distinguishes static vs alarming; fail-or-fix policy for genuine closures still TODO. |
| AOT compute / storage buffers | P3 | Experimental; out of v0.1 scope. |

## Verification commands

```sh
pnpm release:check         # build + test + verify + pack:dry — gate-of-all-gates
pnpm test:e2e:tiers        # all three visual tier gates
pnpm pack:dry              # tarballs in /tmp/ — inspect contents
pnpm --filter examples-ocean build && pnpm --filter examples-ocean preview
pnpm --filter examples-getting-started build
# pnpm --filter examples-pbr-shadows build  # needs `pnpm dev:pbr-shadows` first to capture artifacts
```
