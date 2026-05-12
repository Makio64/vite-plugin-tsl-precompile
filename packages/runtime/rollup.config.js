/**
 * Slim runtime bundle.
 *
 * Rolls up three.js's ESM source (`three/src/**`) minus `src/nodes/**` plus
 * our precompile layer, producing `build/three.webgpu.slim.js`. The Vite
 * plugin, when `slim: true`, aliases `three/webgpu` to this bundle so the
 * user's `import { WebGPURenderer } from 'three/webgpu'` continues to work
 * without shipping the node builder.
 *
 * Phase 7 gate: ≤ 300 KB gzip (meaningful gate: ≤ 145 KB to beat stock
 * three.webgpu.min.js). Reaching the latter requires the three-rewrite
 * transform below (Milestone D) to eliminate the node-builder imports
 * three.js itself drags into the renderer modules.
 */

import { nodeResolve } from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { rewriteThreeSource } from '../plugin/src/three-rewrite.js';

const __dirname = dirname( fileURLToPath( import.meta.url ) );

/**
 * Rollup plugin that routes specific three.js source files through our
 * Milestone D AST rewriter. On shape-drift the handler throws; we emit a
 * Rollup warning and return null so the untransformed source bundles.
 */
const threeRewritePlugin = {
	name: 'tsl-precompile:three-rewrite',
	transform( code, id ) {

		const r = rewriteThreeSource( code, id, {
			threeVersion: process.env.TSL_PRECOMPILE_THREE_VERSION || '184',
			pluginVersion: '0.0.0',
		} );
		if ( ! r ) return null;
		if ( r.warning ) {

			if ( process.env.CI === 'true' || process.env.TSLP_FAIL_ON_REWRITE_WARNING === '1' ) {

				this.error( r.warning );

			}
			this.warn( r.warning );
			return null;

		}
		return { code: r.code, map: r.map };

	},
};

/**
 * Resolve `@tsl-precompile/runtime` to this workspace package's own
 * `src/index.js`. Without this alias, rollup's nodeResolve follows the
 * symlink in the pnpm hoisted store which points to the PARENT repo's
 * `packages/runtime` — a different directory from the worktree. That
 * causes rollup to include aux-loader.js TWICE (once from the worktree
 * source path, once from the main-repo resolved path), producing two
 * separate REGISTRY Maps and breaking `registerAuxArtifacts` / `loadAux`
 * pairing at runtime.
 */
const runtimeAliasPlugin = {
	name: 'tsl-precompile:runtime-alias',
	resolveId( id ) {

		if ( id === '@tsl-precompile/runtime' ) {

			return resolve( __dirname, 'src/index.js' );

		}
		return null;

	},
};

/**
 * Stand-alone rollup resolver for the aux virtual module. In a Vite pipeline
 * this resolves to the generated registration script; here in the
 * stand-alone slim build we have no captured artifacts — emit an empty
 * side-effect module so `loadAux` just throws loud-and-clear if called
 * without a registration chain.
 */
const auxVirtualStub = {
	name: 'tsl-precompile:aux-virtual-stub',
	resolveId( id ) {

		if ( id === 'virtual:tsl-precompile/__aux' ) return '\0' + id;
		return null;

	},
	load( id ) {

		if ( id === '\0virtual:tsl-precompile/__aux' ) {

			return '// slim build has no captured aux artifacts; runtime loadAux() will throw if called\nexport default [];\n';

		}
		return null;

	},
};

export default {
	input: 'src/slim-entry.js',
	output: {
		file: 'build/three.webgpu.slim.js',
		format: 'esm',
		sourcemap: false,
		generatedCode: { constBindings: true, objectShorthand: true },
	},
	// Dev-only dynamic imports (guarded by `/* @vite-ignore */`) that the
	// runtime never reaches in a slim bundle. Marking external keeps Rollup
	// from trying to resolve them statically.
	external: [ /^@tsl-precompile\/plugin\// ],
	// Tell Rollup three's modules are side-effect-free — they're pure class
	// definitions + named exports. Enables tree-shaking through
	// `export *` statements in slim-entry.
	treeshake: {
		moduleSideEffects: ( id ) => {

			if ( /\/three\/src\//.test( id ) ) return false;
			return true;

		},
	},
	plugins: [
		runtimeAliasPlugin,
		auxVirtualStub,
		nodeResolve( {
			browser: true,
			preferBuiltins: false,
			extensions: [ '.js', '.mjs' ],
		} ),
		threeRewritePlugin,
		terser( {
			ecma: 2020,
			compress: { passes: 2, pure_getters: true },
			mangle: true,
			format: { comments: false },
		} ),
	],
	// Silence noisy warnings from three.js's circular imports within its
	// own core — they're intentional and harmless.
	onwarn( warning, defaultHandler ) {

		if ( warning.code === 'CIRCULAR_DEPENDENCY' ) return;
		if ( warning.code === 'THIS_IS_UNDEFINED' ) return;
		defaultHandler( warning );

	},
};
