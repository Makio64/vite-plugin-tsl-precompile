/**
 * Slim runtime bundle.
 *
 * Rolls up three.js's ESM source (`three/src/**`) with compiler-only modules
 * excluded plus our precompile layer, producing
 * `build/three.webgpu.slim.js`. Some Node/TSL runtime carriers still remain
 * until renderer-owned auxiliaries move behind slim adapters. The Vite
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
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getSlimRewriteRuntimeModuleRule, rewriteThreeSource } from '../plugin/src/three-rewrite.js';
import {
	SLIM_BUNDLE_FILE_NAME,
	SLIM_BUNDLE_METADATA_FILE_NAME,
	computeSlimBundleSourceFingerprint,
	createSlimBundleMetadata,
	createSlimBundleSourceInputs,
	createSlimBundleVersionIdentity,
	formatSlimBundleStamp,
	serializeSlimBundleMetadata,
} from '@tsl-precompile/contract/slim-bundle-provenance-node';
import {
	SLIM_THREE_COMPILER_MODULES,
	SLIM_THREE_PACKAGE_VERSION,
	SLIM_THREE_POLICY_VERSION,
	SLIM_THREE_REPLAY_ADAPTER_MODULES,
	getSlimThreeCompilerModule,
	getSlimThreeReplayAdapterModule,
	getSlimThreeRewriteTarget,
} from '@tsl-precompile/contract/slim-three-policy';
import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';

const __dirname = dirname( fileURLToPath( import.meta.url ) );
const requireFromRuntime = createRequire( import.meta.url );
const threePackageRoot = dirname( dirname( requireFromRuntime.resolve( 'three/src/constants.js' ) ) );
const contractPackageRoot = dirname( dirname( requireFromRuntime.resolve( '@tsl-precompile/contract/slim-three-policy' ) ) );
const pluginPackageRoot = resolve( __dirname, '../plugin' );

export const SLIM_BUNDLE_VERSIONS = createSlimBundleVersionIdentity( {
	threeVersion: SLIM_THREE_PACKAGE_VERSION,
	policyVersion: SLIM_THREE_POLICY_VERSION,
	artifactToolchainVersion: ARTIFACT_TOOLCHAIN_VERSION,
} );

export const SLIM_BUNDLE_SOURCE_INPUTS = createSlimBundleSourceInputs( {
	threePackageRoot,
	runtimePackageRoot: __dirname,
	contractPackageRoot,
	pluginPackageRoot,
} );

/**
 * Modules that belong to runtime shader compilation rather than replay.
 * Hydrated replay state is runtime-owned; Three's NodeBuilderState is guarded
 * separately as stock-manager residue below.
 */
export const SLIM_COMPILER_MODULE_RULES = SLIM_THREE_COMPILER_MODULES;
export const SLIM_REPLAY_ADAPTER_RULES = SLIM_THREE_REPLAY_ADAPTER_MODULES;

export function findRenderedSlimCompilerModules( bundle ) {

	const found = new Map();
	for ( const chunk of Object.values( bundle || {} ) ) {

		for ( const [ id, module ] of Object.entries( chunk && chunk.modules || {} ) ) {

			if ( ! module || module.renderedLength <= 0 ) continue;
			const normalized = id.replace( /\\/g, '/' );
			const rule = getSlimThreeCompilerModule( normalized );
			if ( rule ) found.set( normalized, { id: normalized, label: rule.label, renderedLength: module.renderedLength } );

		}

	}
	return [ ...found.values() ].sort( ( a, b ) => b.renderedLength - a.renderedLength || a.id.localeCompare( b.id ) );

}

export function findRenderedSlimStockAdapterModules( bundle ) {

	const found = [];
	for ( const chunk of Object.values( bundle || {} ) ) {

		for ( const [ id, module ] of Object.entries( chunk && chunk.modules || {} ) ) {

			if ( ! module || module.renderedLength <= 0 ) continue;
			const normalized = id.replace( /\\/g, '/' );
			const rule = getSlimThreeReplayAdapterModule( normalized );
			if ( rule ) found.push( { id: normalized, label: rule.label, renderedLength: module.renderedLength } );

		}

	}
	return found.sort( ( a, b ) => b.renderedLength - a.renderedLength || a.id.localeCompare( b.id ) );

}

const compilerResidueGuard = {
	name: 'tsl-precompile:compiler-residue-guard',
	generateBundle( _options, bundle ) {

		const residue = findRenderedSlimCompilerModules( bundle );
		if ( residue.length === 0 ) return;
		const detail = residue.map( ( item ) => `${ item.label } (${ item.renderedLength } B): ${ item.id }` ).join( '\n  ' );
		this.error( `Slim bundle retained runtime compiler modules:\n  ${ detail }` );

	},
};

const stockAdapterResidueGuard = {
	name: 'tsl-precompile:stock-adapter-residue-guard',
	generateBundle( _options, bundle ) {

		const residue = findRenderedSlimStockAdapterModules( bundle );
		if ( residue.length === 0 ) return;
		const detail = residue.map( ( item ) => `${ item.label } (${ item.renderedLength } B): ${ item.id }` ).join( '\n  ' );
		this.error( `Slim bundle retained stock modules replaced by replay adapters:\n  ${ detail }` );

	},
};

/**
 * Rollup plugin that routes specific three.js source files through our
 * Milestone D AST rewriter. A checked prebuilt must never fall back to stock
 * source after shape drift: doing so would mint valid provenance around a
 * renderer that no longer satisfies the replay policy.
 */
export const threeRewritePlugin = {
	name: 'tsl-precompile:three-rewrite',
	transform( code, id ) {

		const r = rewriteThreeSource( code, id, {
			threeVersion: SLIM_THREE_PACKAGE_VERSION,
		} );
		if ( ! r ) return null;
		if ( r.warning ) {

			this.error( r.warning );
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

/** Resolve rewrite-only virtual imports directly to their runtime owners. */
const slimRewriteRuntimeModules = {
	name: 'tsl-precompile:slim-rewrite-runtime-modules',
	resolveId( id ) {

		const rule = getSlimRewriteRuntimeModuleRule( id );
		return rule ? resolve( __dirname, 'src', rule.runtimeFile ) : null;

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
	resolveId( id, importer ) {

		if ( getSlimThreeRewriteTarget( id, importer )?.id === 'webgl-backend' ) {

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
	resolveId( id, importer ) {

		if ( getSlimThreeCompilerModule( id, importer )?.id === 'pmrem-generator' ) {

			return resolve( __dirname, 'src/slim-stub-pmrem-generator.js' );

		}
		return null;

	},
};

/** Replace Three's graph-building Lighting/LightsNode pair with replay state. */
const replayLightingAdapter = {
	name: 'tsl-precompile:replay-lighting',
	resolveId( id, importer ) {

		if ( getSlimThreeReplayAdapterModule( id, importer )?.id === 'lighting' ) {

			return resolve( __dirname, 'src/slim-replay-lighting.js' );

		}
		return null;

	},
};

/** Hydrate captured state directly instead of retaining Three's builder manager. */
const replayNodeManagerAdapter = {
	name: 'tsl-precompile:replay-node-manager',
	resolveId( id, importer ) {

		if ( getSlimThreeReplayAdapterModule( id, importer )?.id === 'node-manager' ) {

			return resolve( __dirname, 'src/slim-replay-node-manager.js' );

		}
		return null;

	},
};

/** Keep Renderer XR state inert without retaining Three's unusable WebGL-only XR closure. */
const replayXRManagerAdapter = {
	name: 'tsl-precompile:replay-xr-manager',
	resolveId( id, importer ) {

		if ( getSlimThreeReplayAdapterModule( id, importer )?.id === 'xr-manager' ) {

			return resolve( __dirname, 'src/slim-replay-xr-manager.js' );

		}
		return null;

	},
};

/** Replay captured background passes without retaining Three's sky TSL graph. */
const replayBackgroundAdapter = {
	name: 'tsl-precompile:replay-background',
	resolveId( id, importer ) {

		if ( getSlimThreeReplayAdapterModule( id, importer )?.id === 'background' ) {

			return resolve( __dirname, 'src/slim-replay-background.js' );

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

/**
 * Add a source-input stamp after minification, then emit the SHA-256 of that
 * final stamped chunk in an adjacent sidecar. The final hash cannot be
 * embedded in the chunk without becoming self-referential, so the stamp and
 * sidecar cross-check the shared source fingerprint instead.
 *
 * `source` is injectable for focused in-memory Rollup tests. Production builds
 * lazily hash the exact shared input scope above and never write intermediate
 * provenance state to disk.
 */
export function createSlimBundleProvenancePlugin( {
	source = null,
	sourceInputs = SLIM_BUNDLE_SOURCE_INPUTS,
	versions = SLIM_BUNDLE_VERSIONS,
	bundleFile = SLIM_BUNDLE_FILE_NAME,
	metadataFile = SLIM_BUNDLE_METADATA_FILE_NAME,
} = {} ) {

	let sourcePromise = null;
	const getSource = () => {

		if ( ! sourcePromise ) sourcePromise = source
			? Promise.resolve( source )
			: computeSlimBundleSourceFingerprint( sourceInputs, versions );
		return sourcePromise;

	};

	return {
		name: 'tsl-precompile:slim-bundle-provenance',
		buildStart() {

			return getSource();

		},
		renderChunk: {
			order: 'post',
			async handler( code, chunk ) {

				if ( ! chunk.isEntry ) return null;
				const sourceDescriptor = await getSource();
				const stamp = formatSlimBundleStamp( {
					sourceFingerprint: sourceDescriptor.fingerprint,
					versions,
				} );
				return { code: `${ stamp }\n${ code }`, map: null };

			},
		},
		generateBundle: {
			order: 'post',
			async handler( _options, bundle ) {

				const entries = Object.values( bundle ).filter( ( output ) => output.type === 'chunk' && output.isEntry );
				if ( entries.length !== 1 ) {

					this.error( `Slim provenance expected exactly one entry chunk, found ${ entries.length }.` );

				}
				const entry = entries[ 0 ];
				if ( entry.fileName !== bundleFile ) {

					this.error( `Slim provenance expected entry ${ JSON.stringify( bundleFile ) }, received ${ JSON.stringify( entry.fileName ) }.` );

				}
				if ( bundle[ metadataFile ] ) {

					this.error( `Slim provenance sidecar ${ JSON.stringify( metadataFile ) } already exists.` );

				}

				const sourceDescriptor = await getSource();
				const metadata = createSlimBundleMetadata( {
					bundleSource: entry.code,
					bundleFile,
					source: sourceDescriptor,
					versions,
				} );
				this.emitFile( {
					type: 'asset',
					fileName: metadataFile,
					source: serializeSlimBundleMetadata( metadata ),
				} );

			},
		},
	};

}

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

					const nodeRuntime = rows.filter( ( [ id ] ) => id.startsWith( 'three/src/nodes/' ) || id.startsWith( 'three/src/materials/nodes/' ) );
					const nodeRuntimeBytes = nodeRuntime.reduce( ( total, row ) => total + row[ 1 ], 0 );
					const compilerResidue = findRenderedSlimCompilerModules( bundle );
					console.error( `\n--- compiler boundary ---` );
					console.error( `  compiler-only modules: ${ compilerResidue.length } (zero enforced)` );
					console.error( `  retained Node/TSL runtime: ${ nodeRuntime.length } modules, ${ ( nodeRuntimeBytes / 1024 ).toFixed( 1 ) } KB rendered` );

				}

			},
		} : null ),
		compilerResidueGuard,
		stockAdapterResidueGuard,
		runtimeAliasPlugin,
		slimRewriteRuntimeModules,
		auxVirtualStub,
		webglFallbackStub,
		pmremGeneratorStub,
		replayBackgroundAdapter,
		replayLightingAdapter,
		replayNodeManagerAdapter,
		replayXRManagerAdapter,
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
		createSlimBundleProvenancePlugin(),
	],
	// Silence noisy warnings from three.js's circular imports within its
	// own core — they're intentional and harmless.
	onwarn( warning, defaultHandler ) {

		if ( warning.code === 'CIRCULAR_DEPENDENCY' ) return;
		if ( warning.code === 'THIS_IS_UNDEFINED' ) return;
		defaultHandler( warning );

	},
};
