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
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { transformSource } from './babel-transform.js';
import { autoMarkSource } from './auto-mark.js';
import { emitArtifactModule } from './emit-manifest.js';
import { createWgslStringPool, emitOptimizedJsonExpression, getExternalWgslRefIdentifiers } from './wgsl-optimize.js';
import { attachDevCapture } from './dev-capture-server.js';
import { rewriteThreeSource } from './three-rewrite.js';
import { VIRTUAL_MODULE_PREFIX, VIRTUAL_AUX_MODULE_ID, VIRTUAL_WGSL_POOL_MODULE_ID, PLUGIN_VERSION } from './_shared/constants.js';

const VIRTUAL_RESOLVE_PREFIX = '\0' + VIRTUAL_MODULE_PREFIX;

// Absolute path to this file's directory — used to alias the runtime's
// bare-specifier dynamic imports (`vite-plugin-tsl-precompile/src/...`) to
// the plugin's own source. Without this, Vite resolves those specifiers
// from the runtime package's location, where pnpm has not created a symlink
// (runtime doesn't declare the plugin as a dep), and resolution fails.
const PLUGIN_SRC_DIR = dirname( fileURLToPath( import.meta.url ) );

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

	for ( const key of [ 'autoMark', 'slim', 'minifyWgsl', 'dedupeWgsl' ] ) {

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
 * @param {boolean} [userOpts.slim=false] - Alias `three/webgpu` to the slim bundle (no TSL builder).
 * @param {string}  [userOpts.threeVersion] - Override the auto-detected three.js version used in artifact hashes.
 * @param {boolean} [userOpts.minifyWgsl=true] - Compact WGSL in emitted virtual modules; captured JSON stays untouched.
 * @param {boolean} [userOpts.dedupeWgsl=true] - Hoist repeated WGSL strings inside emitted virtual modules.
 * @returns {import('vite').Plugin}
 */
export default function tslPrecompile( userOpts = {} ) {

	validateOptions( userOpts );

	const opts = {
		artifactsDir: userOpts.artifactsDir || './artifacts',
		fail: userOpts.fail || 'error',
		autoMark: !! userOpts.autoMark,
		autoMarkPrefix: userOpts.autoMarkPrefix || 'auto',
		slim: !! userOpts.slim,
		threeVersion: userOpts.threeVersion || null,
		minifyWgsl: userOpts.minifyWgsl !== false,
		dedupeWgsl: userOpts.dedupeWgsl !== false,
	};

	let root = process.cwd();
	let isBuild = false;
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
		return entry ? { hash: entry.hash } : null;

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

	return {
		name: 'vite-plugin-tsl-precompile',
		enforce: 'pre',

		config( _userConfig, env ) {

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

			// Alias `three/webgpu` → slim bundle when the plugin is active in
			// `slim: true` mode. Users' `import { WebGPURenderer } from 'three/webgpu'`
			// resolves to our 239 KB-gzip bundle instead of the 800 KB-gzip
			// full build with node-builder. The slim bundle exports the same
			// symbol surface minus *NodeMaterial / TSL / Nodes; any code path
			// that touched those must have been precompiled away.
			if ( opts.slim ) {

				alias.push(
					{ find: /^three\/webgpu$/, replacement: '@tsl-precompile/runtime/slim' },
					{ find: /^three\/tsl$/, replacement: '@tsl-precompile/runtime/slim-stubs' },
				);

			}

			return { resolve: { alias } };

		},

		async configResolved( config ) {

			root = config.root;
			isBuild = config.command === 'build';
			if ( ! opts.threeVersion ) opts.threeVersion = await detectThreeVersion( root );
			await loadManifest();

		},

		async configureServer( server ) {

			attachDevCapture( server, { artifactsDir: resolve( root, opts.artifactsDir ) } );

			// Re-read manifest when capture files change on disk.
			server.watcher.on( 'add', () => loadManifest() );
			server.watcher.on( 'change', () => loadManifest() );

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

						this.warn( rewritten.warning );
						// Fall through to the un-transformed source.

					} else if ( rewritten.code ) {

						return { code: rewritten.code, map: rewritten.map };

					}

				}
				// Not a target OR handler bailed out — let Vite bundle the
				// original source.
				return null;

			}

			if ( ! isTransformable( id ) ) return null;

			// Auto-mark pass: in both dev AND build, when `autoMark` is on,
			// rewrite every `new *NodeMaterial(...)` to chain
			// `.precompile('auto-<slug>-<n>')`. The batch harness uses this to
			// drive unmodified three.js examples through the precompile path.
			if ( opts.autoMark ) {

				const marked = autoMarkSource( code, { filename: id, namePrefix: opts.autoMarkPrefix } );
				if ( marked.injectedNames.length > 0 ) {

					code = marked.code;

				}

			}

			// Dev mode: leave `.precompile()` calls in place so the runtime
			// marker fires and POSTs to the capture endpoint. Build mode:
			// rewrite to `__applyPrecompiled`.
			if ( ! isBuild ) {

				// In dev, return the auto-marked source if we touched it; else
				// fall through so Vite handles the file itself.
				return opts.autoMark ? { code, map: null } : null;

			}

			try {

				const result = transformSource( code, {
					filename: id,
					resolveArtifact,
				} );

				let outputCode = result.code;
				let touched = result.touchedNames.length > 0;
				if ( opts.slim ) {

					const injected = injectSlimAuxImport( outputCode );
					outputCode = injected.code;
					touched = touched || injected.touched;

				}

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

		resolveId( id ) {

			if ( id.startsWith( VIRTUAL_MODULE_PREFIX ) ) {

				return '\0' + id;

			}
			return null;

		},

		async load( id ) {

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
					return { shape: e.shape, configHash: e.configHash, name, artifact };

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
				const runtimeModule = opts.slim ? '@tsl-precompile/runtime/slim' : '@tsl-precompile/runtime';
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

				this.warn( `[tsl-precompile] artifact "${ name }" has ${ blocked.length } not-yet-animated kind(s) (${ blocked.map( ( b ) => b.kind ).join( ', ' ) }). The updater ships a frozen-snapshot fallback — frame-0 visual is correct, but values from these kinds won't animate over time. Track support at packages/examples/batch/results/coverage-summary.md.` );

			}

			return source;

		},

	};

}

function isTransformable( id ) {

	if ( id.startsWith( '\0' ) ) return false;
	if ( id.includes( '/node_modules/' ) ) return false;
	return /\.(m?[jt]sx?)$/.test( id );

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

/**
 * `slim: true` carve-out. Allows three.js's renderer sources to flow
 * through our transform pipeline even though they live under `node_modules`.
 * Limited to the files with registered rewrite handlers so no other
 * node_modules content gets processed.
 */
function isThreeRewriteTarget( id ) {

	if ( id.startsWith( '\0' ) ) return false;
	// Common renderer modules we know how to rewrite.
	if ( /\/node_modules\/.*\/three\/src\/renderers\/common\/(?:.*\/)?(?:CubeRenderTarget|Renderer|Background|PostProcessing|RenderPipeline|PMREMGenerator)\.js$/.test( id ) ) return true;
	// Node manager — inject the precompile bypass in getForRender.
	// (Nodes.js in 0.175; renamed NodeManager.js in 0.184+.)
	if ( /\/node_modules\/.*\/three\/src\/renderers\/common\/nodes\/Nodes\.js$/.test( id ) ) return true;
	if ( /\/node_modules\/.*\/three\/src\/renderers\/common\/nodes\/NodeManager\.js$/.test( id ) ) return true;
	// WebGPU-specific surgical patches.
	if ( /\/node_modules\/.*\/three\/src\/renderers\/webgpu\/WebGPURenderer\.js$/.test( id ) ) return true;
	if ( /\/node_modules\/.*\/three\/src\/renderers\/webgpu\/WebGPUBackend\.js$/.test( id ) ) return true;
	if ( /\/node_modules\/.*\/three\/src\/renderers\/webgpu\/utils\/WebGPUPipelineUtils\.js$/.test( id ) ) return true;
	if ( /\/node_modules\/.*\/three\/src\/renderers\/webgl-fallback\/WebGLBackend\.js$/.test( id ) ) return true;
	return false;

}

async function detectThreeVersion( root ) {

	const candidates = [
		resolve( root, 'node_modules/three/package.json' ),
		resolve( process.cwd(), 'node_modules/three/package.json' ),
	];
	for ( const file of candidates ) {

		try {

			const pkg = JSON.parse( await readFile( file, 'utf8' ) );
			if ( typeof pkg.version === 'string' && pkg.version.length > 0 ) {

				const m = pkg.version.match( /^0\.(\d+)\./ );
				if ( ! m ) {

					throw new Error( `detectThreeVersion: unrecognised three.js version ${ JSON.stringify( pkg.version ) } in ${ file }` );

				}
				const minor = parseInt( m[ 1 ], 10 );
				if ( minor < 184 ) {

					throw new Error( `detectThreeVersion: three.js ${ pkg.version } is below the supported minimum (>= r184)` );

				}
				return String( minor );

			}

		} catch ( err ) {

			if ( err && err.message && err.message.startsWith( 'detectThreeVersion:' ) ) throw err;
			// Try the next likely workspace location.

		}

	}
	throw new Error( `detectThreeVersion: could not locate three/package.json under ${ candidates.join( ' or ' ) }` );

}
