# @tsl-precompile/site

Landing site and generated compatibility browser for [`vite-plugin-tsl-precompile`](../plugin/).

Vanilla Vite + HTML/CSS/JS. The overview and explainer intentionally use CSS-only product visuals, so the marketing shell does not download Three.js for decoration. The evidence page loads stock Three.js only when a visitor explicitly runs its WebGPU cold-path explorer.

## Develop

```sh
pnpm dev:site           # from repo root
pnpm --filter @tsl-precompile/site dev   # or directly
```

Local development serves the last checked capture/replay snapshots immediately.
It does not rebuild the compiler-free live examples on startup, so stale capture
artifacts cannot prevent the documentation server from opening. Refresh those
optional routes explicitly with `pnpm --filter @tsl-precompile/site live` after
recapturing their source projects.

## Build

```sh
pnpm build:site
```

Production output goes to `packages/site/dist/`. GitHub Actions ([.github/workflows/deploy-site.yml](../../.github/workflows/deploy-site.yml)) builds and deploys it to GitHub Pages on every push to `main`.

The production build consumes already-generated public evidence; it does not
run the `data` script. After a new campaign or stock run, regenerate the selected
public output first and then build with the same evidence selectors.

The build also runs a content guard that checks the multi-page output, GitHub Pages-safe navigation, working quickstart, generated evidence fallbacks, social metadata, and the overview's no-Three.js dependency boundary. It fails closed when the public evidence is stale, lacks a passing semantic gate, or no longer matches its selected campaign.

After building, run the static browser proof against the production output:

```sh
pnpm --filter @tsl-precompile/site test:static
```

The proof opens the landing and examples pages in full Chromium, fails on page,
console, request, or HTTP errors, decodes the featured, gallery, and comparison
images, and writes screenshots plus `report.json` to
`packages/site/results/static-site-browser`. Set `TSLP_SITE_BROWSER_OUT` (or
pass `--output-dir`) to keep the output in a runner-temporary directory.

## Rebuild the evidence

The default selectors are:

- campaign root: `packages/examples/batch/results`
- stock report: `packages/examples/batch/results/report.json`
- public output: `packages/site/public`

For an isolated verified campaign that does not mutate the checked
`packages/site/public`, select both inputs and an external public output
explicitly:

```sh
TSLP_E2E_OUT=/absolute/path/to/campaign \
TSLP_STOCK_REPORT=/absolute/path/to/stock-report.json \
TSLP_SITE_PUBLIC_OUT=/absolute/path/to/generated-public \
pnpm --filter @tsl-precompile/site data

TSLP_E2E_OUT=/absolute/path/to/campaign \
TSLP_STOCK_REPORT=/absolute/path/to/stock-report.json \
TSLP_SITE_PUBLIC_OUT=/absolute/path/to/generated-public \
pnpm build:site
```

Equivalent data-script options are `--evidence-root`, `--stock-report`, and
`--public-root`. The generator only accepts a canonical schema-2 campaign from
the exact catalogue and current slim bundle. Every row must carry a valid
passing `tslp-e2e-semantic-evidence-gate@3`: all three freeze phases are
complete, every phase has positive GPU device/observer/fence proof, unexpected
errors and `[tslp*]` or `[tsl-precompile*]` warnings are absent, and the complete operation registry
agrees with its policy-bound outcomes and ordered per-failure recovery proof.
The generator publishes `examples.json`, `coverage-summary.json`, and
`coverage-evidence-set.json` together; their campaign IDs, artifact byte
descriptors, and SHA-256 bindings are rechecked during the build. Use
`TSLP_SITE_PUBLIC_OUT` or `--public-root` for an isolated output outside the
repository.

Publication also revalidates the exact official Three source proof for every
cohort. The nonempty per-file proof list (path, bytes, SHA-256, Git blob/mode,
object format, commit, and tree) must reproduce its aggregate digest and match
`manifest.sources.three`, its exact file count and fingerprint, and
`threeCheckout.sourceFingerprint`. The independently generated stock report is
held to the same self-contained per-file proof contract, recursively binds its
harness/package/lock inputs, records the browser/WebGPU environment, and
requires positive GPU device/observer/fence proof with zero GPU errors for
every route. Local cohorts are also rediscovered from the current checkout so
stale manifest options, route bytes, or HTML inventory cannot be published.

Omitting `TSLP_SITE_PUBLIC_OUT` intentionally writes generated evidence and
thumbnails into the default `packages/site/public`. Use that form when
refreshing the checked publish inputs, and still run `data` before `build:site`;
the build never regenerates evidence implicitly.

Do not publish or quote a final 254-route result from older checked data after a
fingerprinted source change. Generate the site from a fresh exact v2 campaign,
then let the build revalidate the selected stock report, manifest, screenshots,
and stored artifact bytes as one evidence set.
