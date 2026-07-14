/**
 * `vite-plugin-tsl-precompile` — the Vite plugin entry point.
 *
 * Three jobs:
 *   1. Dev mode: attach the capture endpoint so `.precompile(name)` calls
 *      from the runtime marker write artifacts to disk.
 *   2. Build mode: rewrite `.precompile('name')` call sites into
 *      `__applyPrecompiled(...)` with an injected virtual-module import.
 *   3. Virtual modules: resolve and load `virtual:tsl-precompile/<name>` to
 *      the emitted artifact module per name.
 *
 * Config:
 *
 *   tslPrecompile({
 *     artifactsDir: './artifacts',   // where captured artifacts live on disk
 *     fail: 'error' | 'warn',        // what to do when a named artifact is missing in build (default: 'error')
 *     minifyWgsl: true,              // compact WGSL in emitted virtual modules
 *     dedupeWgsl: true,              // hoist repeated WGSL strings into a tree-shakeable shared pool
 *   })
 *
 * @module ViteTslPrecompilePlugin
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { annotateDevMarkerSources, instrumentLiveContextDependencies, transformSource } from './babel-transform.js';
import { autoMarkSource } from './auto-mark.js';
import { emitArtifactModule } from './emit-manifest.js';
import { createWgslStringPool, emitOptimizedJsonExpression, getExternalWgslRefIdentifiers } from './wgsl-optimize.js';
import { attachDevCapture } from './dev-capture-server.js';
import { getSlimRewriteRuntimeModuleRule, isThreeRewriteTarget, rewriteThreeSource } from './three-rewrite.js';
import { computeArtifactContentHash } from './hash.js';
import {
	findRenderedSlimSourceResidue,
	normalizeSlimMode,
	resolveSlimRewriteRuntimeModule,
	resolveSlimSourceAdapter,
	slimRuntimeEntryForMode,
} from './slim-source.js';
import { verifySlimPrebuiltBundle } from './slim-prebuilt-provenance.js';
import { VIRTUAL_MODULE_PREFIX, VIRTUAL_AUX_MODULE_ID, VIRTUAL_WGSL_POOL_MODULE_ID, PLUGIN_VERSION } from './_shared/constants.js';
import { VIRTUAL_FULL_THREE_MODULE_ID } from '@tsl-precompile/contract/virtual-modules';
import { ARTIFACT_CONTENT_HASH_VERSION } from '@tsl-precompile/contract/artifact-content';
import {
	SLIM_THREE_PACKAGE_VERSION,
	SLIM_THREE_POLICY_VERSION,
	SLIM_THREE_RUNTIME_ENTRIES,
	SLIM_THREE_SOURCE_GUARD_MODULE_ID,
} from '@tsl-precompile/contract/slim-three-policy';

const VIRTUAL_RESOLVE_PREFIX = '\0' + VIRTUAL_MODULE_PREFIX;

// The checked-in @tsl-precompile/runtime/slim bundle is built from this exact
// three.js package. It is not safe to combine renderer internals from one
// patch with core classes from another, even when both report the same
// integer REVISION. Bump this only together with a strict slim rebuild and
// its rewrite/compatibility tests.
const THREE_PACKAGE_VERSION_GLOBAL = 'globalThis.__TSLP_THREE_PACKAGE_VERSION__';
const AUTO_CAPTURE_RENDER_OUTPUT_GLOBAL = 'globalThis.__TSLP_AUTO_CAPTURE_RENDER_OUTPUT__';

// Absolute path to this file's directory — used to alias the runtime's
// bare-specifier dynamic imports (`vite-plugin-tsl-precompile/src/...`) to
// the plugin's own source. Without this, Vite resolves those specifiers
// from the runtime package's location, where pnpm has not created a symlink
// (runtime doesn't declare the plugin as a dep), and resolution fails.
const PLUGIN_SRC_DIR = dirname( fileURLToPath( import.meta.url ) );

// Bare specifiers the runtime imports dynamically. Vite 8's import-analysis
// statically resolves string-literal dynamic-import specifiers even with
// `/* @vite-ignore */`, and the `resolve.alias` set up in `config()` does
// not always reach this path — explicit `resolveId` short-circuits it.
const PLUGIN_BARE_SOURCES = {
	'vite-plugin-tsl-precompile/src/vendor/compileTSL.js': resolve( PLUGIN_SRC_DIR, 'vendor/compileTSL.js' ),
	'vite-plugin-tsl-precompile/src/emit-updater.js': resolve( PLUGIN_SRC_DIR, 'emit-updater.js' ),
};

const KNOWN_OPTION_KEYS = new Set( [
	'artifactsDir',
	'fail',
	'autoMark',
	'autoMarkPrefix',
	'slim',
	'threeVersion',
	'minifyWgsl',
	'dedupeWgsl',
] );

const FAIL_MODES = new Set( [ 'error', 'warn' ] );

function isPlainObject( value ) {

	if ( ! value || typeof value !== 'object' || Array.isArray( value ) ) return false;
	const proto = Object.getPrototypeOf( value );
	return proto === Object.prototype || proto === null;

}

function validateOptions( userOpts ) {

	if ( ! isPlainObject( userOpts ) ) {

		throw new TypeError( `[tsl-precompile] options must be a plain object, received ${ Array.isArray( userOpts ) ? 'array' : typeof userOpts }.` );

	}

	const unknown = Object.keys( userOpts ).filter( ( k ) => ! KNOWN_OPTION_KEYS.has( k ) );
	if ( unknown.length > 0 ) {

		throw new Error( `[tsl-precompile] unknown plugin option(s): ${ unknown.map( ( k ) => `"${ k }"` ).join( ', ' ) }. Known options: ${ [ ...KNOWN_OPTION_KEYS ].map( ( k ) => `"${ k }"` ).join( ', ' ) }.` );

	}

	if ( userOpts.fail !== undefined && ! FAIL_MODES.has( userOpts.fail ) ) {

		throw new Error( `[tsl-precompile] invalid \`fail\` option: ${ JSON.stringify( userOpts.fail ) }. Expected 'error' or 'warn'.` );

	}

	if ( userOpts.artifactsDir !== undefined && typeof userOpts.artifactsDir !== 'string' ) {

		throw new TypeError( `[tsl-precompile] \`artifactsDir\` must be a string, received ${ typeof userOpts.artifactsDir }.` );

	}

	if ( userOpts.autoMarkPrefix !== undefined && typeof userOpts.autoMarkPrefix !== 'string' ) {

		throw new TypeError( `[tsl-precompile] \`autoMarkPrefix\` must be a string, received ${ typeof userOpts.autoMarkPrefix }.` );

	}

	if ( userOpts.threeVersion !== undefined && userOpts.threeVersion !== null && typeof userOpts.threeVersion !== 'string' ) {

		throw new TypeError( `[tsl-precompile] \`threeVersion\` must be a string when set, received ${ typeof userOpts.threeVersion }.` );

	}

	if ( userOpts.slim !== undefined && typeof userOpts.slim !== 'boolean' && userOpts.slim !== 'source' ) {

		throw new TypeError( `[tsl-precompile] \`slim\` must be a boolean or 'source', received ${ JSON.stringify( userOpts.slim ) }.` );

	}

	for ( const key of [ 'autoMark', 'minifyWgsl', 'dedupeWgsl' ] ) {

		if ( userOpts[ key ] !== undefined && typeof userOpts[ key ] !== 'boolean' ) {

			throw new TypeError( `[tsl-precompile] \`${ key }\` must be a boolean, received ${ typeof userOpts[ key ] }.` );

		}

	}

}

/**
 * @param {Object} [userOpts]
 * @param {string} [userOpts.artifactsDir='./artifacts']
 * @param {'error' | 'warn'} [userOpts.fail='error']
 * @param {boolean} [userOpts.autoMark=false] - Auto-mark every `new *NodeMaterial(...)` with `.precompile('<prefix>-<slug>-<n>')` so unmodified three.js demos flow through the AOT pipeline.
 * @param {string}  [userOpts.autoMarkPrefix='auto'] - Prefix used by auto-mark names.
 * @param {boolean | 'source'} [userOpts.slim=false] - Alias `three/webgpu` to the checked prebuilt slim bundle, or use `'source'` for the guarded tree-shaken entry. Dev/serve keeps full three for capture.
 * @param {string}  [userOpts.threeVersion] - Override the auto-detected exact three.js package version used in artifact hashes.
 * @param {boolean} [userOpts.minifyWgsl=true] - Compact WGSL in emitted virtual modules; captured JSON stays untouched.
 * @param {boolean} [userOpts.dedupeWgsl=true] - Hoist repeated WGSL strings inside emitted virtual modules.
 * @returns {import('vite').Plugin}
 */
export default function tslPrecompile( userOpts = {} ) {

	validateOptions( userOpts );
	const hasThreeVersionOverride = userOpts.threeVersion !== undefined && userOpts.threeVersion !== null;

	const opts = {
		artifactsDir: userOpts.artifactsDir || './artifacts',
		fail: userOpts.fail || 'error',
		autoMark: !! userOpts.autoMark,
		autoMarkPrefix: userOpts.autoMarkPrefix || 'auto',
		slim: normalizeSlimMode( userOpts.slim ),
		threeVersion: userOpts.threeVersion || null,
		minifyWgsl: userOpts.minifyWgsl !== false,
		dedupeWgsl: userOpts.dedupeWgsl !== false,
	};

	let root = process.cwd();
	let isBuild = false;
	let installedThree = null; // { version, packageRoot, webgpuEntry }
	let slimSourceRuntime = null; // { entry, sourceDir }
	let manifest = null;   // { [name]: { file, hash, entry, mtime } }
	let auxManifest = null; // { [`<shape>:<configHash>`]: { file, hash, entry, mtime } }
	let wgslPool = null;    // { strings: string[], refs: Map<string, string> }

	async function loadManifest() {

		const artifactsDir = resolve( root, opts.artifactsDir );
		manifest = {};
		auxManifest = {};
		wgslPool = null;

		if ( ! existsSync( artifactsDir ) ) return manifest;

		const files = await readdir( artifactsDir );
		for ( const file of files ) {

			if ( ! file.endsWith( '.json' ) ) continue;
			if ( file === 'manifest.json' ) continue;

			try {

				const raw = await readFile( join( artifactsDir, file ), 'utf8' );
				const parsed = JSON.parse( raw );
				const st = await stat( join( artifactsDir, file ) );

				// Aux artifact: carries `__materialShape` + `__configHash`.
				if ( parsed.__materialShape && parsed.__configHash ) {

					const key = `${ parsed.__materialShape }:${ parsed.__configHash }`;
					const prev = auxManifest[ key ];
					if ( prev && prev.mtime > st.mtimeMs ) continue;
					auxManifest[ key ] = {
						file,
						shape: parsed.__materialShape,
						configHash: parsed.__configHash,
						hash: parsed.__hash,
						entry: parsed,
						mtime: st.mtimeMs,
					};
					continue;

				}

				const name = parsed.__name;
				if ( ! name ) continue;

				const prev = manifest[ name ];
				if ( prev && prev.mtime > st.mtimeMs ) continue;

				manifest[ name ] = {
					file,
					hash: parsed.__hash,
					entry: parsed,
					mtime: st.mtimeMs,
				};

			} catch ( _ ) {

				// Skip unreadable files silently — loud errors belong to the capture endpoint.

			}

		}

		return manifest;

	}

	function resolveArtifact( name ) {

		if ( ! manifest ) return null;
		const entry = manifest[ name ];
		if ( entry ) assertManifestEntryCompatibility( name, entry );
		return entry ? {
			hash: entry.hash,
			sourceOwners: Array.isArray( entry.entry && entry.entry.__sourceOwners )
				? entry.entry.__sourceOwners
				: null,
		} : null;

	}

	function assertManifestEntryCompatibility( name, manifestEntry ) {

		if ( manifestEntry.validatedThreeVersion === opts.threeVersion ) return;
		assertCapturedArtifactCompatibility( name, manifestEntry.entry, opts.threeVersion );
		manifestEntry.validatedThreeVersion = opts.threeVersion;

	}

	function buildWgslPool() {

		if ( wgslPool ) return wgslPool;
		const values = [];
		for ( const entry of Object.values( manifest || {} ) ) {

			values.push( entry.entry && entry.entry.artifact ? entry.entry.artifact : entry.entry );

		}
		for ( const entry of Object.values( auxManifest || {} ) ) {

			values.push( entry.entry && entry.entry.artifact ? entry.entry.artifact : entry.entry );

		}
		wgslPool = createWgslStringPool( values, {
			minifyWgsl: opts.minifyWgsl,
			dedupeWgsl: opts.dedupeWgsl,
			refPrefix: '__tslp_wgslPool',
		} );
		return wgslPool;

	}

	async function configureThreeInstallation( configRoot, command ) {

		const detected = await detectThreeInstallation( configRoot );
		installedThree = detected;

		if ( hasThreeVersionOverride ) {

			assertExactThreePackageVersion( opts.threeVersion, '`threeVersion` option' );
			if ( opts.threeVersion !== detected.version ) {

				throw new Error( `[tsl-precompile] \`threeVersion\` is ${ JSON.stringify( opts.threeVersion ) }, but this project resolves three ${ JSON.stringify( detected.version ) } from ${ detected.packageRoot }. Hashing against a version other than the installed WGSL emitter is unsafe; remove the override or make it match exactly.` );

			}

		} else {

			opts.threeVersion = detected.version;

		}

		if ( opts.slim === 'prebuilt' && command === 'build' && detected.version !== SLIM_THREE_PACKAGE_VERSION ) {

			throw new Error( `[tsl-precompile] slim build refused: this release's checked-in slim bundle was built against three ${ SLIM_THREE_PACKAGE_VERSION }, but the project resolves three ${ detected.version } from ${ detected.packageRoot }. Pin \"three\": \"${ SLIM_THREE_PACKAGE_VERSION }\" or rebuild/publish a matching @tsl-precompile/runtime slim bundle before enabling \`slim: true\`.` );

		}

		if ( opts.slim === 'source' && command === 'build' ) {

			slimSourceRuntime = detectSlimSourceRuntime( configRoot );

		} else {

			slimSourceRuntime = null;

		}

		return detected;

	}

	async function verifyConfiguredSlimPrebuilt( configRoot, detected ) {

		// Vite invokes `config` once in normal builds. Reverify on every explicit
		// hook call as well so programmatic reuse cannot retain a fulfilled
		// promise after the bundle, sidecar, or installed sources change.
		return verifySlimPrebuiltBundle( { root: configRoot, threeInstallation: detected } );

	}

	return {
		name: 'vite-plugin-tsl-precompile',
		enforce: 'pre',

		async config( userConfig = {}, env ) {

			const configRoot = resolve( process.cwd(), userConfig.root || '.' );
			const detected = await configureThreeInstallation( configRoot, env.command );
			// Vite always runs `config` before resolving aliases. Verify here so a
			// missing, modified, or stale checked bundle fails before it can enter
			// the module graph. `configResolved` still supports direct hook tests,
			// but does not repeat this filesystem-wide fingerprint.
			if ( opts.slim === 'prebuilt' && env.command === 'build' ) {

				await verifyConfiguredSlimPrebuilt( configRoot, detected );

			}
			isBuild = env.command === 'build';

			// The runtime's dev-mode `.precompile()` and aux-capture paths do
			// `await import('vite-plugin-tsl-precompile/src/...')` from inside
			// `@tsl-precompile/runtime`. The runtime package does not declare
			// the plugin as a dep, so Vite's bare-specifier resolution starting
			// from the runtime source can't find it. Alias those two paths to
			// this plugin's actual source files, regardless of mode.
			const alias = [
				{ find: 'vite-plugin-tsl-precompile/src/vendor/compileTSL.js', replacement: resolve( PLUGIN_SRC_DIR, 'vendor/compileTSL.js' ) },
				{ find: 'vite-plugin-tsl-precompile/src/emit-updater.js', replacement: resolve( PLUGIN_SRC_DIR, 'emit-updater.js' ) },
			];

			// Alias `three/webgpu` → the selected slim entry only for production builds.
			// Dev must retain full three.js because `.precompile()` capture needs
			// the live node builder. Production can use the checked single-file
			// runtime or expose the same compiler-free source surface to the app
			// bundler. Any removed NodeMaterial/TSL path must be precompiled.
			if ( opts.slim && env.command === 'build' ) {

				alias.push(
					{ find: /^three\/webgpu$/, replacement: slimRuntimeEntryForMode( opts.slim ) },
					{ find: /^three\/tsl$/, replacement: SLIM_THREE_RUNTIME_ENTRIES.STUBS },
				);
				if ( opts.slim === 'source' ) {

					const threeCoreSource = resolve( detected.packageRoot, 'src/Three.Core.js' );
					if ( ! existsSync( threeCoreSource ) ) {

						throw new Error( `[tsl-precompile] slim source build requires ${ threeCoreSource } so bare "three" and "three/webgpu" share one constructor graph.` );

					}
					// Source mode exposes Three's private source graph to the consumer
					// bundler. Route the exact bare entry into that same graph as well;
					// otherwise Three's package main adds build/three.module.js beside
					// three/src/** and identical classes fail instanceof/identity checks.
					alias.push( { find: /^three$/, replacement: threeCoreSource } );

				}

			}

			return {
				resolve: { alias },
				// Runtime capture cannot recover an npm patch version from
				// THREE.REVISION (both 0.184.0 and a hypothetical 0.184.1 report
				// "184"). Expose the exact resolved package identity at compile
				// time so marker/setup code can use the same hash input as build.
				define: {
					[ THREE_PACKAGE_VERSION_GLOBAL ]: JSON.stringify( detected.version ),
					// Dev keeps full Three even for slim builds. Tell the conditional
					// setup entry to capture mandatory renderer-output topologies after
					// successful real renders, without enabling a broad aux sweep or
					// burdening non-slim apps with an unused artifact.
					[ AUTO_CAPTURE_RENDER_OUTPUT_GLOBAL ]: JSON.stringify( Boolean( opts.slim ) ),
				},
			};

		},

		async configResolved( config ) {

			root = config.root;
			isBuild = config.command === 'build';
			await configureThreeInstallation( root, config.command );
			await warnIfThreeDependencyIsRanged( root, config );
			await loadManifest();

		},

		async configureServer( server ) {

			const artifactsRoot = resolve( root, opts.artifactsDir );
			attachDevCapture( server, { artifactsDir: artifactsRoot } );
			attachInspectorExtensionsShim( server );

			// Re-read manifest when capture files change on disk. The watcher fires
			// for every file in the project, so gate on artifact JSON paths — without
			// this every save anywhere re-reads and re-parses all artifacts.
			const isArtifactJson = ( file ) =>
				typeof file === 'string' && file.endsWith( '.json' ) && ( file === artifactsRoot || file.startsWith( artifactsRoot + sep ) );
			server.watcher.on( 'add', ( file ) => { if ( isArtifactJson( file ) ) loadManifest(); } );
			server.watcher.on( 'change', ( file ) => { if ( isArtifactJson( file ) ) loadManifest(); } );

		},

		// `vite preview` uses a separate server lifecycle; the dev capture
		// endpoint is intentionally not mounted here (preview should never
		// re-capture), but the Inspector extensions.json shim is needed so
		// production builds that ship Inspector don't 404 → SPA-fallback HTML
		// → JSON.parse throw.
		async configurePreviewServer( server ) {

			attachInspectorExtensionsShim( server );

		},

		async transform( code, id ) {

			// three.js source rewrite (slim: true, build only). Runs before
			// the general `isTransformable` check so we can pull in files
			// from `node_modules` — the carve-out is scoped to the specific
			// files our handlers know how to rewrite.
			if ( opts.slim && isBuild && isThreeRewriteTarget( id ) ) {

				const rewritten = rewriteThreeSource( code, id, {
					threeVersion: opts.threeVersion,
					pluginVersion: PLUGIN_VERSION,
				} );
				if ( rewritten ) {

					if ( rewritten.warning ) {

						// A warning means a registered rewrite target changed shape. In
						// slim production the original source would re-introduce live
						// node-builder paths (or ship subtly incompatible renderer code),
						// so there is no safe fallback.
						this.error( `${ rewritten.warning }\n[tsl-precompile] Slim production builds fail closed on three.js rewrite drift. Pin the supported three version or update the rewrite before rebuilding the slim runtime.` );
						return null;

					} else if ( rewritten.code ) {

						return { code: rewritten.code, map: rewritten.map };

					}

				}
				this.error( `[tsl-precompile] ${ id }: registered slim rewrite target produced no transformed source. Refusing to bundle the original three.js module into a slim production build.` );
				return null;

			}

			if ( ! isTransformable( id ) ) return null;

			// Auto-mark pass: in both dev AND build, when `autoMark` is on,
			// rewrite every `new *NodeMaterial(...)` to chain
			// `.precompile('auto-<slug>-<n>')`. The batch harness uses this to
			// drive unmodified three.js examples through the precompile path.
			let autoMarked = false;
			if ( opts.autoMark ) {

				const marked = autoMarkSource( code, { filename: id, root, namePrefix: opts.autoMarkPrefix } );
				if ( marked.injectedNames.length > 0 ) {

					code = marked.code;
					autoMarked = true;

				}

			}

			const contextDependencies = instrumentLiveContextDependencies( code, { filename: id } );
			if ( contextDependencies.touched ) code = contextDependencies.code;

			// Dev mode: leave `.precompile()` calls in place so the runtime
			// marker fires and POSTs to the capture endpoint. Build mode:
			// rewrite to `__applyPrecompiled`.
			if ( ! isBuild ) {

				const annotated = annotateDevMarkerSources( code, { filename: id, root } );
				if ( annotated.touched ) return { code: annotated.code, map: annotated.map };
				return autoMarked || contextDependencies.touched ? { code, map: contextDependencies.map } : null;

			}

			try {

					const result = transformSource( code, {
						filename: id,
						root,
						resolveArtifact,
					} );

				let outputCode = result.code;
				let touched = result.touchedNames.length > 0 || contextDependencies.touched;
				// Inject the aux-artifact registry virtual module in any production build,
				// not just slim mode. Without this, captured background / PMREM / post-process
				// artifacts on disk are never registered in the bundle, and the precompiled
				// RenderPipeline / scene background fall through to live three.js compilation
				// paths that may not produce a valid frame.
				const injected = injectSlimAuxImport( outputCode );
				outputCode = injected.code;
				touched = touched || injected.touched;

				if ( ! touched ) return null;

				return { code: outputCode, map: result.map };

			} catch ( err ) {

				if ( opts.fail === 'warn' ) {

					this.warn( err.message );
					return null;

				}
				this.error( err.message );

			}

		},

		resolveId( id, importer ) {

			if ( PLUGIN_BARE_SOURCES[ id ] ) return PLUGIN_BARE_SOURCES[ id ];
			if ( id === SLIM_THREE_SOURCE_GUARD_MODULE_ID ) {

				if ( opts.slim !== 'source' || ! isBuild ) {

					throw new Error( `[tsl-precompile] ${ SLIM_THREE_RUNTIME_ENTRIES.SOURCE } is a build-only entry and requires tslPrecompile({ slim: 'source' }).` );

				}
				return '\0' + id;

			}
			if ( opts.slim === 'source' && isBuild && slimSourceRuntime ) {

				const rewriteRuntime = resolveSlimRewriteRuntimeModule( id, slimSourceRuntime.sourceDir );
				if ( rewriteRuntime ) return rewriteRuntime;
				const adapter = resolveSlimSourceAdapter( id, importer, slimSourceRuntime.sourceDir );
				if ( adapter ) return adapter;

			}
			if ( getSlimRewriteRuntimeModuleRule( id ) ) {

				throw new Error(
					`[tsl-precompile] private Three source rewrite helper ${ JSON.stringify( id ) } cannot be resolved in the prebuilt slim build. ` +
					'Import the renderer from "three/webgpu", or use tslPrecompile({ slim: \'source\' }) when directly importing three/src renderer internals. ' +
					'Mixing prebuilt and source Three internals would split constructor identity.'
				);

			}
			if ( id === VIRTUAL_FULL_THREE_MODULE_ID ) {

				if ( ! installedThree || ! installedThree.webgpuEntry ) {

					throw new Error( `[tsl-precompile] ${ VIRTUAL_FULL_THREE_MODULE_ID } was resolved before the consumer three/webgpu entry was detected.` );

				}
				// Return the physical consumer entry directly. This deliberately
				// bypasses the build-only `three/webgpu` → runtime/slim alias.
				return installedThree.webgpuEntry;

			}

			if ( id.startsWith( VIRTUAL_MODULE_PREFIX ) ) {

				return '\0' + id;

			}
			return null;

		},

		async load( id ) {

			if ( id === '\0' + SLIM_THREE_SOURCE_GUARD_MODULE_ID ) {

				return `export const slimThreePolicyVersion = ${ JSON.stringify( SLIM_THREE_POLICY_VERSION ) };\n`;

			}
			if ( ! id.startsWith( VIRTUAL_RESOLVE_PREFIX ) ) return null;

			const name = id.slice( VIRTUAL_RESOLVE_PREFIX.length );

			if ( ! manifest ) await loadManifest();

			if ( '\0' + VIRTUAL_WGSL_POOL_MODULE_ID === id ) {

				const pool = buildWgslPool();
				return [
					...pool.strings.map( ( string, index ) => `export const __tslp_wgslPool${ index } = ${ JSON.stringify( string ) };` ),
					`export default { ${ pool.strings.map( ( _string, index ) => `__tslp_wgslPool${ index }` ).join( ', ' ) } };`,
					'',
				].join( '\n' );

			}

			// Aux registry virtual module: `virtual:tsl-precompile/__aux`.
			// Emits a side-effect-only module that registers every captured
			// aux artifact at app-load time.
			if ( '\0' + VIRTUAL_AUX_MODULE_ID === id ) {

				const entries = Object.values( auxManifest || {} );
				if ( entries.length === 0 ) {

					return `// [tsl-precompile] no aux artifacts captured yet.\nexport default [];\n`;

				}
				const auxEntries = entries.map( ( e ) => {

					const artifact = e.entry && e.entry.artifact ? e.entry.artifact : e.entry;
					const name = e.entry && ( e.entry.__name || e.entry.name ) || artifact && ( artifact.__name || artifact.name ) || null;
					return {
						shape: e.shape,
						configHash: e.configHash,
						name,
						threeVersion: opts.threeVersion,
						pluginVersion: PLUGIN_VERSION,
						artifact,
					};

				} );
				const {
					declarations: wgslDeclarations,
					expression: auxEntriesLiteral,
				} = emitOptimizedJsonExpression( auxEntries, {
					...opts,
					externalWgslRefs: buildWgslPool().refs,
				} );
				const usedWgslPoolRefs = getExternalWgslRefIdentifiers( auxEntriesLiteral );
				const lines = [];
				const runtimeModule = slimRuntimeEntryForMode( opts.slim );
				lines.push( `import { registerAuxArtifacts } from ${ JSON.stringify( runtimeModule ) };` );
				if ( usedWgslPoolRefs.length > 0 ) lines.push( `import { ${ usedWgslPoolRefs.join( ', ' ) } } from ${ JSON.stringify( VIRTUAL_WGSL_POOL_MODULE_ID ) };` );
				lines.push( '' );
				for ( const declaration of wgslDeclarations ) lines.push( declaration );
				if ( wgslDeclarations.length > 0 ) lines.push( '' );
				lines.push( `const __auxEntries = ${ auxEntriesLiteral };` );
				lines.push( '' );
				lines.push( `registerAuxArtifacts( __auxEntries );` );
				lines.push( `export default __auxEntries;` );
				return lines.join( '\n' );

			}

			const entry = manifest[ name ];
			if ( ! entry ) {

				this.error( `[tsl-precompile] no artifact for "${ name }". Run dev mode once to capture it.` );
				return null;

			}
			assertManifestEntryCompatibility( name, entry );
			const { source, unsupportedKinds } = emitArtifactModule( entry, entry.entry, {
				...opts,
				externalWgslRefs: buildWgslPool().refs,
			} );

			// Build gate:
			//   severity: 'unknown'  → fail (the codegen has no case for a
			//     kind the extractor produced; runtime would throw).
			//   severity: 'blocked'  → warn (deferred-by-design; the updater
			//     emits a snapshot fallback that won't animate).
			const unknowns = unsupportedKinds.filter( ( u ) => u.severity === 'unknown' );
			const blocked = unsupportedKinds.filter( ( u ) => u.severity === 'blocked' );

			if ( unknowns.length > 0 ) {

				const summary = unknowns.map( ( u ) => `${ u.kind } @ byteOffset ${ u.byteOffset } — ${ u.reason }` ).join( '\n    ' );
				const msg = `[tsl-precompile] artifact "${ name }" has ${ unknowns.length } unknown kind(s) with no codegen case:\n    ${ summary }\nAdd a case to packages/plugin/src/emit-updater.js or document-block the kind.`;
				if ( opts.fail === 'warn' ) {

					this.warn( msg );

				} else {

					this.error( msg );
					return null;

				}

			}

			if ( blocked.length > 0 ) {

				const staticBlocked = blocked.filter( ( b ) => b.isStaticSnapshot );
				const liveBlocked = blocked.filter( ( b ) => ! b.isStaticSnapshot );

				if ( staticBlocked.length > 0 ) {

					this.warn( `[tsl-precompile] artifact "${ name }" has ${ staticBlocked.length } static-snapshot uniform slot(s) (${ staticBlocked.map( ( b ) => b.kind ).join( ', ' ) }) — these are provably-static values like identity texture-sampler matrices that don't animate by design. Safe to ignore.` );

				}
				if ( liveBlocked.length > 0 ) {

					this.warn( `[tsl-precompile] artifact "${ name }" has ${ liveBlocked.length } not-yet-animated kind(s) (${ liveBlocked.map( ( b ) => b.kind ).join( ', ' ) }). The updater ships a frozen-snapshot fallback — frame-0 visual is correct, but values from these kinds won't animate over time. Track support at packages/examples/batch/results/coverage-summary.md.` );

				}

			}

			return source;

		},

		generateBundle( _outputOptions, bundle ) {

			if ( opts.slim !== 'source' || ! isBuild ) return;
			const residue = findRenderedSlimSourceResidue( bundle );
			const found = [
				...residue.compiler.map( ( item ) => `compiler ${ item.label } (${ item.renderedLength } B): ${ item.id }` ),
				...residue.stockAdapters.map( ( item ) => `stock adapter ${ item.label } (${ item.renderedLength } B): ${ item.id }` ),
				...residue.retainedNodeRuntime.map( ( item ) => `retained Node/TSL runtime (${ item.renderedLength } B): ${ item.id }` ),
				...residue.bareThreeIdentity.map( ( item ) => `split bare Three identity (${ item.renderedLength } B): ${ item.id }` ),
			];
			if ( found.length > 0 ) {

				this.error( `[tsl-precompile] slim source build retained forbidden Three modules:\n  ${ found.join( '\n  ' ) }` );

			}

		},

	};

}

function assertCapturedArtifactCompatibility( name, entry, currentThreeVersion ) {

	const nested = entry && entry.artifact && typeof entry.artifact === 'object' ? entry.artifact : null;
	const metadata = nested && [ 'sourceGraphHash', 'sourceHashVersion', 'sourceThreeVersion', 'renderContextSignature' ]
		.some( ( key ) => nested[ key ] !== undefined ) ? nested : entry;
	const hasSourceMetadata = metadata && [ 'sourceGraphHash', 'sourceHashVersion', 'sourceThreeVersion', 'renderContextSignature' ]
		.some( ( key ) => metadata[ key ] !== undefined );
	if ( ! hasSourceMetadata ) return; // Legacy artifacts retain the module-hash gate.

	if ( typeof metadata.sourceGraphHash !== 'string' || ! /^[a-f0-9]{64}$/i.test( metadata.sourceGraphHash ) ) {

		throw new Error( `[tsl-precompile] artifact ${ JSON.stringify( name ) } has incomplete source-hash metadata. Recapture it with the current plugin.` );

	}
	if ( metadata.sourceHashVersion !== PLUGIN_VERSION ) {

		throw new Error( `[tsl-precompile] artifact ${ JSON.stringify( name ) } uses source-hash/toolchain version ${ metadata.sourceHashVersion || '<missing>' }, but this build requires ${ PLUGIN_VERSION }. Recapture it.` );

	}
	if ( typeof metadata.sourceThreeVersion !== 'string' || metadata.sourceThreeVersion.length === 0 ) {

		throw new Error( `[tsl-precompile] artifact ${ JSON.stringify( name ) } is missing sourceThreeVersion. Recapture it with the current plugin.` );

	}
	if ( currentThreeVersion && metadata.sourceThreeVersion !== currentThreeVersion ) {

		throw new Error( `[tsl-precompile] artifact ${ JSON.stringify( name ) } was captured with three ${ metadata.sourceThreeVersion }, but this build resolves three ${ currentThreeVersion }. Recapture it before building.` );

	}
	if ( nested && nested.artifactContentHashVersion !== undefined ) {

		if ( nested.artifactContentHashVersion !== ARTIFACT_CONTENT_HASH_VERSION ) {

			throw new Error( `[tsl-precompile] artifact ${ JSON.stringify( name ) } uses unsupported content-hash version ${ nested.artifactContentHashVersion }. Recapture it.` );

		}
		const computed = computeArtifactContentHash( nested, {
			shape: `material:${ name }`,
			threeVersion: metadata.sourceThreeVersion,
			pluginVersion: metadata.sourceHashVersion,
		} );
		if ( entry.__hash !== computed ) {

			throw new Error( `[tsl-precompile] artifact ${ JSON.stringify( name ) } content does not match its stored __hash. The artifact file is corrupt or was edited; recapture it.` );

		}

	}

}

function isTransformable( id ) {

	if ( typeof id !== 'string' || id.length === 0 ) return false;

	// Vite and framework plugins use both NUL-prefixed and URL-shaped virtual
	// module ids. None of those are application source owned by this plugin.
	if ( /^(?:\0|virtual:|vite:)/.test( id ) ) return false;

	const queryStart = id.indexOf( '?' );
	const hashStart = id.indexOf( '#', queryStart === - 1 ? 0 : queryStart );
	const pathEnd = queryStart === - 1
		? ( hashStart === - 1 ? id.length : hashStart )
		: queryStart;
	const pathname = id.slice( 0, pathEnd );
	const normalizedPathname = pathname.replace( /\\/g, '/' );

	if ( normalizedPathname.startsWith( '/@id/' ) || normalizedPathname.startsWith( '/@vite/' ) ) return false;
	if ( /(?:^|\/)node_modules(?:\/|$)/.test( normalizedPathname ) ) return false;

	const rawQuery = queryStart === - 1
		? ''
		: id.slice( queryStart + 1, hashStart === - 1 ? id.length : hashStart );
	const query = new URLSearchParams( rawQuery );

	// Match Vite's special asset requests. Although their pathname can end in
	// .js/.ts, the transform input is a URL/raw/worker wrapper rather than the
	// application module itself.
	for ( const assetQuery of [ 'raw', 'url', 'worker', 'sharedworker' ] ) {

		if ( query.has( assetQuery ) ) return false;

	}

	if ( /\.(?:[cm]?[jt]s|[jt]sx)$/i.test( pathname ) ) return true;

	// Vue and Astro expose script blocks as explicit Vite subrequests. Their
	// load hooks return JavaScript/TypeScript before transform hooks run, so
	// these are safe to parse. Raw SFC files and template/style subrequests are
	// deliberately excluded. Svelte currently compiles the raw .svelte id in a
	// transform hook and has no equivalent script subrequest, so an enforce:pre
	// plugin cannot safely parse it here.
	if ( /\.vue$/i.test( pathname ) ) return query.has( 'vue' ) && query.get( 'type' ) === 'script';
	if ( /\.astro$/i.test( pathname ) ) return query.has( 'astro' ) && query.get( 'type' ) === 'script';

	return false;

}

// Inspector (`three/addons/inspector/tabs/Settings.js`) does
// `await fetch( new URL( '../extensions/extensions.json', import.meta.url ) ).then( r => r.json() )`.
// In production builds the URL resolves under the assets dir where no
// `extensions.json` exists, so Vite preview's SPA fallback returns
// index.html and `JSON.parse` throws "Unexpected token '<'", blocking
// render init. Intercept the request and return an empty extension list.
function attachInspectorExtensionsShim( server ) {

	server.middlewares.use( ( req, res, next ) => {

		if ( req.url && /\/extensions\/extensions\.json(\?|$)/.test( req.url ) ) {

			res.setHeader( 'content-type', 'application/json' );
			res.end( '[]' );
			return;

		}
		next();

	} );

}

function injectSlimAuxImport( code ) {

	if ( code.includes( VIRTUAL_AUX_MODULE_ID ) ) return { code, touched: false };

	const importLine = `import ${ JSON.stringify( VIRTUAL_AUX_MODULE_ID ) };\n`;
	if ( code.startsWith( '#!' ) ) {

		const newline = code.indexOf( '\n' );
		if ( newline !== - 1 ) {

			return {
				code: `${ code.slice( 0, newline + 1 ) }${ importLine }${ code.slice( newline + 1 ) }`,
				touched: true,
			};

		}

	}

	return { code: importLine + code, touched: true };

}

function detectSlimSourceRuntime( root ) {

	const attempted = [];
	for ( const requireFrom of [
		createRequire( resolve( root, 'package.json' ) ),
		createRequire( import.meta.url ),
	] ) {

		try {

			const entry = requireFrom.resolve( SLIM_THREE_RUNTIME_ENTRIES.SOURCE );
			return { entry, sourceDir: dirname( entry ) };

		} catch ( error ) {

			attempted.push( error && error.message ? error.message : String( error ) );

		}

	}

	throw new Error( `[tsl-precompile] slim source build could not resolve ${ JSON.stringify( SLIM_THREE_RUNTIME_ENTRIES.SOURCE ) } from ${ root }. Install a matching @tsl-precompile/runtime release before enabling \`slim: 'source'\`. Resolver details: ${ attempted.join( ' | ' ) }` );

}

async function detectThreeInstallation( root ) {

	const directPackage = resolve( root, 'node_modules/three/package.json' );
	const direct = await readThreeInstallation( directPackage );
	if ( direct ) return direct;

	// Workspaces and non-hoisted package managers may not place the peer at
	// `<vite root>/node_modules/three`. Resolve from the consumer first, then
	// from the installed plugin (whose peer must resolve to the consumer's
	// three in a valid installation).
	const resolvers = [
		createRequire( resolve( root, 'package.json' ) ),
		createRequire( import.meta.url ),
	];
	const attempted = [ directPackage ];
	for ( const requireFrom of resolvers ) {

		let webgpuEntry;
		try {

			webgpuEntry = requireFrom.resolve( 'three/webgpu' );

		} catch ( _ ) {

			continue;

		}
		const packageFile = await findPackageJson( dirname( webgpuEntry ), 'three' );
		if ( ! packageFile ) continue;
		attempted.push( packageFile );
		const installation = await readThreeInstallation( packageFile, webgpuEntry );
		if ( installation ) return installation;

	}

	throw new Error( `[tsl-precompile] could not locate the consumer three/package.json or resolve three/webgpu from ${ root }. Install three >= 0.184.0 as a project dependency. Checked: ${ attempted.join( ', ' ) }.` );

}

async function readThreeInstallation( packageFile, resolvedWebgpuEntry = null ) {

	let pkg;
	try {

		pkg = JSON.parse( await readFile( packageFile, 'utf8' ) );

	} catch ( _ ) {

		return null;

	}
	if ( pkg.name !== 'three' || typeof pkg.version !== 'string' ) return null;
	assertExactThreePackageVersion( pkg.version, packageFile );

	const packageRoot = dirname( packageFile );
	let webgpuEntry = resolvedWebgpuEntry;
	if ( ! webgpuEntry ) {

		const exportTarget = resolvePackageExportTarget( pkg.exports && pkg.exports[ './webgpu' ] );
		if ( exportTarget && exportTarget.startsWith( './' ) ) {

			webgpuEntry = resolve( packageRoot, exportTarget );

		}

	}
	if ( ! webgpuEntry || ! existsSync( webgpuEntry ) ) {

		throw new Error( `[tsl-precompile] three ${ pkg.version } at ${ packageRoot } does not expose a resolvable \"three/webgpu\" entry.` );

	}

	return { version: pkg.version, packageRoot, webgpuEntry };

}

function resolvePackageExportTarget( value ) {

	if ( typeof value === 'string' ) return value;
	if ( ! value || typeof value !== 'object' ) return null;
	for ( const condition of [ 'import', 'browser', 'default', 'require' ] ) {

		const target = resolvePackageExportTarget( value[ condition ] );
		if ( target ) return target;

	}
	return null;

}

async function findPackageJson( startDir, expectedName ) {

	let current = startDir;
	while ( true ) {

		const file = join( current, 'package.json' );
		try {

			const pkg = JSON.parse( await readFile( file, 'utf8' ) );
			if ( pkg && pkg.name === expectedName ) return file;

		} catch ( _ ) {}
		const parent = dirname( current );
		if ( parent === current ) return null;
		current = parent;

	}

}

function assertExactThreePackageVersion( version, source ) {

	const match = typeof version === 'string' && version.match( /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/ );
	if ( ! match ) {

		throw new Error( `[tsl-precompile] expected an exact three.js package version such as \"0.184.0\" from ${ source }, received ${ JSON.stringify( version ) }.` );

	}
	const major = Number.parseInt( match[ 1 ], 10 );
	const minor = Number.parseInt( match[ 2 ], 10 );
	if ( major === 0 && minor < 184 ) {

		throw new Error( `[tsl-precompile] three.js ${ version } from ${ source } is below the supported minimum (>= 0.184.0).` );

	}

}

async function warnIfThreeDependencyIsRanged( root, config ) {

	const pkgPath = resolve( root, 'package.json' );
	if ( ! existsSync( pkgPath ) ) return;

	let pkg = null;
	try {

		pkg = JSON.parse( await readFile( pkgPath, 'utf8' ) );

	} catch ( _ ) {

		return;

	}

	const fieldNames = [ 'dependencies', 'devDependencies', 'optionalDependencies' ];
	for ( const fieldName of fieldNames ) {

		const deps = pkg && pkg[ fieldName ];
		const spec = deps && deps.three;
		if ( typeof spec !== 'string' || isExactThreeVersionSpec( spec ) ) continue;

		const message = `[tsl-precompile] package.json ${ fieldName }.three is ${ JSON.stringify( spec ) }. Captured artifacts are hashed against the installed three.js WGSL emitter; pin three to an exact patch version such as "${ SLIM_THREE_PACKAGE_VERSION }" and recapture artifacts when bumping.`;
		if ( config && config.logger && typeof config.logger.warn === 'function' ) {

			config.logger.warn( message );

		} else {

			console.warn( message );

		}
		return;

	}

}

function isExactThreeVersionSpec( spec ) {

	if ( typeof spec !== 'string' ) return false;
	if ( spec.startsWith( 'npm:three@' ) ) return isExactThreeVersionSpec( spec.slice( 'npm:three@'.length ) );
	if ( /^(?:file|link|portal|workspace):/.test( spec ) ) return true;
	return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test( spec );

}
