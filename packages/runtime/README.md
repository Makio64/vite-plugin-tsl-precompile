# @tsl-precompile/runtime

Runtime helpers for [`vite-plugin-tsl-precompile`](https://www.npmjs.com/package/vite-plugin-tsl-precompile). Installs the `material.precompile(name)` marker on the three.js `Material` prototype, ships the generated UBO writers, and provides the `__applyPrecompiled` helper that the build-time transform calls into. Also exports `PrecompiledMaterial` and an artifact registry so the slim three.js bundle can render baked WGSL without the TSL node builder.

## Status

Experimental — see [STATUS.md](https://github.com/Makio64/vite-plugin-tsl-precompile/blob/main/STATUS.md) for the current support snapshot and [BACKLOG.md](https://github.com/Makio64/vite-plugin-tsl-precompile/blob/main/BACKLOG.md) for known limitations.

## Install

```sh
pnpm add -D @tsl-precompile/runtime
```

Peer dep: `three >= 0.184.0`.

## Usage

In dev, install the marker once and hand it the active `WebGPURenderer` so `.precompile(name)` calls can run the extractor against your real renderer:

```js
// main.js (dev entry)
import * as THREE from 'three/webgpu';
import { installPrecompileMarker, setDevRenderer } from '@tsl-precompile/runtime';

installPrecompileMarker(THREE, {
  devEndpoint: 'http://localhost:5173/__tsl-precompile/capture',
});

const renderer = new THREE.WebGPURenderer({ antialias: true });
await renderer.init();
setDevRenderer(renderer);

// Now any `material.precompile('name')` call captures + POSTs the artifact
// to the Vite dev server, which writes it to ./artifacts/.
```

In a production build, the Vite plugin rewrites every `.precompile(name)` call into `__applyPrecompiled(material, virtualArtifactModule, hash)` — `installPrecompileMarker` is still called but the marker method itself never runs.

## Exports

```js
import {
  installPrecompileMarker,
  setDevRenderer,
  clearDevRenderer,
  __applyPrecompiled,
  PrecompiledMaterial,
  registerArtifact,
  getArtifact,
  registerPrecompiledArtifact,
  registerPrecompiledArtifacts,
  unregisterPrecompiledArtifacts,
} from '@tsl-precompile/runtime';
```

Subpath entries: `@tsl-precompile/runtime/writers`, `/marker`, `/apply`, `/loader`.

## More

Full project story, architecture, and roadmap: [monorepo README](https://github.com/Makio64/vite-plugin-tsl-precompile#readme).

## License

[MIT](https://github.com/Makio64/vite-plugin-tsl-precompile/blob/main/LICENSE)
