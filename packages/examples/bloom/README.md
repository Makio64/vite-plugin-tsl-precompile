# Bloom example

Runnable bloom post-processing example. This package is a thin entry wrapper
over the canonical `../postprocessing-debug/src/bloom.js` implementation.

The Vite config deliberately resolves marker ownership and generated inputs
against `../postprocessing-debug`, so development capture and production builds
reuse `../postprocessing-debug/artifacts`. Do not create or copy an artifact
directory into this wrapper.

The production build uses the compiler-free slim source runtime and validates
the same material, render-output, and bloom auxiliary artifacts as the debug
suite.

```sh
pnpm dev:bloom
pnpm --filter examples-bloom build
pnpm --filter examples-bloom preview
```
