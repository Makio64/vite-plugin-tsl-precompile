/**
 * Slim runtime bundle.
 *
 * Rolls up three.js's ESM source (`three/src/**`) minus `src/nodes/**` plus
 * our precompile layer, producing `build/three.webgpu.slim.js`. The Vite
 * plugin, when `slim: true`, aliases `three/webgpu` to this bundle so the
 * user's `import { WebGPURenderer } from 'three/webgpu'` continues to work
 * without shipping the node builder.
 *
 * Phase 7 gate: ≤ 250 KB gzip — enforced by
 * `packages/plugin/test/unit/slim-bundle.test.js` (meaningful gate: ≤ 145 KB
 * to beat stock three.webgpu.min.js). Reaching the latter requires the
 * three-rewrite transform below (Milestone D) to eliminate the node-builder
 * imports three.js itself drags into the renderer modules.
 * `TSLP_ANALYZE=1` prints the per-module size breakdown.
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
			threeVersion: process.env.TSL_PRECOMPILE_THREE_VERSION || '0.184.0',
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

/**
 * Sever the WebGL fallback backend from the slim bundle.
 *
 * `WebGPURenderer.js` statically imports `WebGLBackend`, which transitively
 * drags in the entire `renderers/webgl-fallback/**` subtree — a second
 * (GLSL) shader compiler `GLSLNodeBuilder`, every `WebGL*Utils`, and the
 * legacy GLSL ShaderChunk strings. slim is WebGPU-only and never instantiates
 * that backend (it is referenced only under `forceWebGL` / the WebGPU-
 * unavailable fallback closure). Redirecting the single import entry point to
 * a throwing stub removes the whole subtree. Must run before `nodeResolve`.
 */
const webglFallbackStub = {
	name: 'tsl-precompile:stub-webgl-fallback',
	resolveId( id ) {

		if ( /webgl-fallback\/WebGLBackend\.js$/.test( id ) ) {

			return resolve( __dirname, 'src/slim-stub-webgl-backend.js' );

		}
		return null;

	},
};

/**
 * Sever Three's runtime PMREM compiler path from the slim bundle.
 *
 * PMREMGenerator constructs four internal NodeMaterials and compiles them on
 * demand. A precompiled-only renderer cannot execute that path; real users
 * run PMREM on the lazily loaded full renderer through slim-support. Keep a
 * small API-compatible shell so application wrappers can still construct or
 * subclass PMREMGenerator, while removing the unreachable materials/compiler
 * subtree from the shipped bundle. Must run before nodeResolve.
 */
const pmremGeneratorStub = {
	name: 'tsl-precompile:stub-pmrem-generator',
	resolveId( id ) {

		if ( /renderers\/common\/extras\/PMREMGenerator\.js$/.test( id ) ) {

			return resolve( __dirname, 'src/slim-stub-pmrem-generator.js' );

		}
		return null;

	},
};

/**
 * Redirect bare `three` imports to three's tree-shakeable source barrel.
 *
 * Several runtime modules (`hydrate/*.js`, `precompiled-compute-node.js`)
 * import small core symbols (`Vector3`, `Matrix4`, `EventDispatcher`, …) from
 * bare `'three'`. Under nodeResolve that resolves to three's package main —
 * the PREBUILT `three.module.js` (the classic WebGL build, ~623 KB) which
 * pulls `three.core.js` (~1.4 MB) — bundled a SECOND time on top of the
 * `three/src/**` source the slim entry already includes. Routing bare `three`
 * to `three/src/Three.Core.js` makes those imports resolve to the same source
 * modules, so Rollup dedupes them and the ~2 MB of duplicate prebuilt three
 * disappears. Must run before `nodeResolve`.
 */
const threeBareAlias = {
	name: 'tsl-precompile:three-bare-source-alias',
	resolveId( id, importer, options ) {

		if ( id === 'three' ) {

			return this.resolve( 'three/src/Three.Core.js', importer, { skipSelf: true, ...options } );

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
		// Single-file bundle: three/src has a few dynamic imports (e.g. lazy
		// codecs) that would otherwise split into sibling chunks. The slim
		// runtime ships as one file, so inline them.
		inlineDynamicImports: true,
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
		( process.env.TSLP_ANALYZE ? {
			name: 'tslp-analyze',
			generateBundle( _o, bundle ) {

				for ( const chunk of Object.values( bundle ) ) {

					if ( ! chunk.modules ) continue;
					const rows = Object.entries( chunk.modules )
						.map( ( [ id, m ] ) => [ id.replace( /.*\/three\/src\//, 'three/src/' ).replace( /.*\/packages\/runtime\//, 'runtime/' ), m.renderedLength ] )
						.filter( ( r ) => r[ 1 ] > 0 )
						.sort( ( a, b ) => b[ 1 ] - a[ 1 ] );
					let total = 0; for ( const r of rows ) total += r[ 1 ];
					console.error( `\n=== ${ rows.length } modules, ${ ( total / 1024 ).toFixed( 0 ) } KB rendered ===` );
					for ( const [ id, len ] of rows.slice( 0, 35 ) ) console.error( `  ${ ( len / 1024 ).toFixed( 1 ).padStart( 7 ) } KB  ${ id }` );
					// group by top-level three/src subdir
					const groups = {};
					for ( const [ id, len ] of rows ) {

						const g = id.startsWith( 'three/src/' ) ? id.split( '/' ).slice( 0, 4 ).join( '/' ) : id.split( '/' ).slice( 0, 2 ).join( '/' );
						groups[ g ] = ( groups[ g ] || 0 ) + len;

					}
					console.error( '\n--- by subtree ---' );
					for ( const [ g, len ] of Object.entries( groups ).sort( ( a, b ) => b[ 1 ] - a[ 1 ] ).slice( 0, 25 ) ) console.error( `  ${ ( len / 1024 ).toFixed( 1 ).padStart( 7 ) } KB  ${ g }` );

				}

			},
		} : null ),
		runtimeAliasPlugin,
		auxVirtualStub,
		webglFallbackStub,
		pmremGeneratorStub,
		threeBareAlias,
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
