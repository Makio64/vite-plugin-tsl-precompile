/**
 * Rollup config for `three.webgpu.slim.js` — the slim three.js bundle that
 * ships in `@tsl-precompile/runtime/build/`.
 *
 * Inputs come from the three.js fork's slim entry (`Three.WebGPU.Precompiled.js`).
 * The fork strips the TSL builder via its own rollup alias plugin; we mirror
 * the same approach here so the produced bundle has no `src/nodes/**`.
 *
 * Phase 7 expectation: ≤ 300 KB gz. To reproduce the fork's strip:
 *   - alias `src/nodes/index.js` → `_stubs/PrecompiledStubs.js`
 *   - drop `src/nodes/precompile/PrecompiledHydrator.js` (replaced by AOT updaters)
 *
 * Status: skeleton. Run `pnpm --filter @tsl-precompile/runtime build` once
 * the alias plugin lands. Today, the script logs a TODO and exits 0.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = path.dirname( fileURLToPath( import.meta.url ) );

// The fork lives at ../../../three.js relative to this package's root in dev.
// In CI we'd vendor it via a git submodule or a pnpm tarball ref.
const THREE_FORK = process.env.TSL_PRECOMPILE_THREE_FORK
	|| path.resolve( SELF, '..', '..', '..', 'three.js' );

export default {
	input: path.join( THREE_FORK, 'src/Three.WebGPU.Precompiled.js' ),
	output: {
		file: path.join( SELF, 'build/three.webgpu.slim.js' ),
		format: 'esm',
		sourcemap: false,
	},
	external: [ 'three', 'three/tsl' ],
	// TODO Phase 7: alias plugin to redirect node-graph imports to stubs.
	// See three.js fork's `Three.WebGPU.Precompiled.js` rollup config.
	plugins: [],
};
