# Compute particles example

Runnable storage-buffer particle example. This package is a thin entry wrapper
over the canonical `../compute-debug/src/particles.js` implementation.

The Vite config deliberately resolves marker ownership and generated inputs
against `../compute-debug`, so development capture and production builds reuse
`../compute-debug/artifacts`. Do not create or copy an artifact directory into
this wrapper.

The route exercises the captured particle material plus its initialization and
per-frame compute kernels through the compiler-free slim source runtime.

```sh
pnpm dev:compute
pnpm --filter examples-compute build
pnpm --filter examples-compute preview
```
