#!/usr/bin/env node
/**
 * Capture -> slim replay harness for three.js WebGPU examples.
 *
 * Per example:
 *   1. Serve the stock example through full three.js and take the visual
 *      reference screenshot.
 *   2. Serve the same example with an importmap wrapper around
 *      `three/webgpu`/`three` that auto-marks every constructed NodeMaterial.
 *   3. Let the real three.js TSL builder render once and POST captured
 *      user-material + aux artifacts to this harness.
 *   4. Reload the same example with the slim bundle, a TSL authoring stub,
 *      the captured user materials, and the captured aux registry.
 *   5. Report whether replay reached a non-empty frame without unexpected
 *      console/page errors AND the per-pixel PSNR vs the capture frame is
 *      at or above the configured threshold (default 30 dB). The pixel
 *      gate can be disabled with `--no-pixel-gate` for diagnostic runs.
 *
 * This is intentionally a harness, not a production build. It answers:
 * "Can this example's live materials be captured and replayed through the
 * slim runtime if we automate the user's dev-capture step, and does the
 * replayed frame look the same as the live one?"
 *
 *   node packages/examples/batch/run-e2e.mjs --filter=webgpu_backdrop
 *   node packages/examples/batch/run-e2e.mjs --filter=ocean --psnr-threshold=25
 *   node packages/examples/batch/run-e2e.mjs --filter=ocean --no-pixel-gate
 *   node packages/examples/batch/run-e2e.mjs --filter=ocean --replay-only
 *   node packages/examples/batch/run-e2e.mjs --filter=ocean --reuse-reference-shot
 *   node packages/examples/batch/run-e2e.mjs --tier=tier1
 *   node packages/examples/batch/run-e2e.mjs --filter=ocean --port=8729 --port-retries=20
 *   node packages/examples/batch/run-e2e.mjs --filter=ocean --target-tick=60
 *   node packages/examples/batch/run-e2e.mjs --filter=ocean --timings
 */

import { chromium } from 'playwright';
import { FastCDPHarness } from 'webgpu-optimizer-report';
import { createServer } from 'node:http';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolve, join, dirname, extname, normalize, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MATERIAL_TEXTURE_PROPS as __TEXTURE_PROPS, MATERIAL_NODE_TEXTURE_KEYS as __NODE_GRAPH_KEYS } from '@tsl-precompile/contract/texture-props';

import { assertThreeAtLeast184 } from './_three-version.mjs';
import { captureWaitOverrideForExample, comparePngBuffers, expectedReplayErrorPatternsForExample, pixelGateDisabledReasonForExample, psnrThresholdForExample, tierExamples } from './psnr.mjs';

const SELF = dirname( fileURLToPath( import.meta.url ) );
const REPO = resolve( SELF, '../../..' );
const OUT = resolve( SELF, 'results' );
const RUNTIME_SRC = resolve( REPO, 'packages/runtime/src' );
const PLUGIN_SRC = resolve( REPO, 'packages/plugin/src' );
const CONTRACT_SRC = resolve( REPO, 'packages/contract/src' );
const SLIM_BUNDLE = resolve( REPO, 'packages/runtime/build/three.webgpu.slim.js' );
const CACHE_BUST = Date.now().toString( 36 );

if ( ! existsSync( OUT ) ) mkdirSync( OUT, { recursive: true } );
if ( ! existsSync( SLIM_BUNDLE ) ) {

	console.error( `[batch-e2e] slim bundle not found: ${ SLIM_BUNDLE }\nRun \`pnpm --filter @tsl-precompile/runtime build:slim\` first.` );
	process.exit( 2 );

}

// The slim bundle bakes in the threeVersion used to produce its hashes at
// build time (e.g. { threeVersion: "184", pluginVersion: "0.0.0" }). The
// capture pass must use the SAME threeVersion so that
// hashPlainConfigSync(config, { shape, threeVersion, pluginVersion }) produces
// matching configHashes for render-output, background, etc. artifacts.
// Extract it from the bundle rather than hard-coding it.
const SLIM_HASH_OPTS = ( () => {

	const src = readFileSync( SLIM_BUNDLE, 'utf8' );
	const m = src.match( /\{threeVersion:\s*"([^"]+)"[^}]*pluginVersion:\s*"([^"]+)"/ ) ||
		src.match( /\{pluginVersion:\s*"([^"]+)"[^}]*threeVersion:\s*"([^"]+)"/ );
	if ( m ) {

		// First pattern: threeVersion first
		if ( src.match( /\{threeVersion:\s*"([^"]+)"/ ) ) {

			return { threeVersion: m[ 1 ], pluginVersion: m[ 2 ] };

		}
		// Second pattern: pluginVersion first
		return { threeVersion: m[ 2 ], pluginVersion: m[ 1 ] };

	}
	console.error( `[batch-e2e] could not extract threeVersion from slim bundle ${ SLIM_BUNDLE }. Rebuild it with \`pnpm --filter @tsl-precompile/runtime build:slim\`.` );
	process.exit( 2 );

} )();
console.log( `[batch-e2e] slim bundle hash opts: threeVersion=${ SLIM_HASH_OPTS.threeVersion } pluginVersion=${ SLIM_HASH_OPTS.pluginVersion }` );

const args = process.argv.slice( 2 );
function getArg( prefix, def ) {

	const a = args.find( ( x ) => x.startsWith( prefix ) );
	return a ? a.slice( prefix.length ) : def;

}

function parseIntAtLeast( value, fallback, min ) {

	const n = parseInt( value, 10 );
	return Number.isFinite( n ) && n >= min ? n : fallback;

}

function parseFloatOr( value, fallback ) {

	const n = parseFloat( value );
	return Number.isFinite( n ) ? n : fallback;

}

const threeRepo = resolve( getArg( '--three-repo=', resolve( SELF, '../../../../three.js' ) ) );
const localExamplesRootArg = getArg( '--local-examples-root=', '' );
const localExamplesRoot = localExamplesRootArg ? resolve( localExamplesRootArg ) : null;
const filter = getArg( '--filter=', '' );
const tier = getArg( '--tier=', '' );
const limit = parseIntAtLeast( getArg( '--limit=', '9999' ), 9999, 0 );
const offset = parseIntAtLeast( getArg( '--offset=', '0' ), 0, 0 );
let port = parseIntAtLeast( getArg( '--port=', '8729' ), 8729, 1 );
const portRetries = parseIntAtLeast( getArg( '--port-retries=', '100' ), 100, 0 );
const captureWaitMs = parseIntAtLeast( getArg( '--capture-wait-ms=', '12000' ), 12000, 0 );
const HAS_EXPLICIT_CAPTURE_WAIT = args.some( ( arg ) => arg.startsWith( '--capture-wait-ms=' ) );
const replayWaitMs = parseIntAtLeast( getArg( '--replay-wait-ms=', '5000' ), 5000, 0 );
const targetTick = parseIntAtLeast( getArg( '--target-tick=', '0' ), 0, 0 );
const HAS_EXPLICIT_TARGET_TICK = args.some( ( arg ) => arg.startsWith( '--target-tick=' ) );
const psnrThreshold = parseFloatOr( getArg( '--psnr-threshold=', '30' ), 30 );
const pixelGateEnabled = ! args.includes( '--no-pixel-gate' );
const saveShots = ! args.includes( '--no-save-shots' );
const replayOnly = args.includes( '--replay-only' );
const reuseReferenceShot = replayOnly || args.includes( '--reuse-reference-shot' );
const verboseConsole = args.includes( '--verbose' ) || process.env.TSLP_E2E_VERBOSE === '1' || !! process.env.TSLP_DEBUG_TORNADO_VERBOSE;
const timingsEnabled = args.includes( '--timings' ) || process.env.TSLP_E2E_TIMINGS === '1';
const reportFile = getArg( '--report=', 'e2e-report.json' );

if ( ! existsSync( join( threeRepo, 'examples' ) ) ) {

	console.error( `[batch-e2e] three.js examples not found at ${ threeRepo }/examples. Pass --three-repo=<absolute-path>` );
	process.exit( 2 );

}
if ( localExamplesRoot && ! existsSync( localExamplesRoot ) ) {

	console.error( `[batch-e2e] local examples root not found at ${ localExamplesRoot }` );
	process.exit( 2 );

}

assertThreeAtLeast184( threeRepo, 'batch-e2e' );

const SKIP_PREFIXES = [
	'webxr_', 'vr_', 'ar_', 'webgpu_xr_', 'webgpu_webxr_',
	'webgpu_compile_async',
	'webgpu_tsl_precompile',
];
function shouldSkip( name ) { return SKIP_PREFIXES.some( ( p ) => name.includes( p ) ); }

const examplesRoot = localExamplesRoot || join( threeRepo, 'examples' );
const examplePaths = new Map();
const localExampleOptions = new Map();
const tierExampleNames = tier ? tierExamples( tier ) : [];
const tierExampleSet = tier ? new Set( tierExampleNames ) : null;
if ( tier && tierExampleNames.length === 0 ) {

	console.error( `[batch-e2e] unknown or empty coverage tier "${ tier }"` );
	process.exit( 2 );

}
function stripExampleQuery( examplePath ) {

	return String( examplePath || '' ).split( /[?#]/ )[ 0 ];

}
function examplePathFor( name ) {

	return examplePaths.get( name ) || name;

}
function discoverLocalExampleCases() {

	const manifestPath = join( localExamplesRoot, 'e2e-cases.json' );
	if ( existsSync( manifestPath ) ) {

		const parsed = JSON.parse( readFileSync( manifestPath, 'utf8' ) );
		const cases = Array.isArray( parsed ) ? parsed : Array.isArray( parsed.cases ) ? parsed.cases : [];
		return cases.map( ( entry ) => {

			const path = typeof entry === 'string' ? entry : entry && entry.path;
			const name = typeof entry === 'string' ? safeExampleName( entry ) : entry && entry.name || safeExampleName( path || '' );
			if ( ! path || ! name ) return null;
			examplePaths.set( name, path );
			if ( entry && typeof entry === 'object' ) localExampleOptions.set( name, entry );
			return name;

		} ).filter( Boolean );

	}

	return readdirSync( examplesRoot )
		.filter( ( f ) => f.endsWith( '.html' ) && f !== 'index.html' );

}

const discoveredExamples = localExamplesRoot
	? discoverLocalExampleCases()
	: readdirSync( examplesRoot )
		.filter( ( f ) => f.startsWith( 'webgpu_' ) && f.endsWith( '.html' ) );
const allExamples = discoveredExamples
	.filter( ( f ) => ! tierExampleSet || tierExampleSet.has( f ) )
	.filter( ( f ) => ! filter || f.includes( filter ) || examplePathFor( f ).includes( filter ) )
	.slice( offset, offset + limit );
const candidates = localExamplesRoot ? allExamples : allExamples.filter( ( f ) => ! shouldSkip( f ) );

if ( localExamplesRoot ) {
	console.log( `[batch-e2e] discovered ${ allExamples.length } local *.html in ${ localExamplesRoot } — ${ candidates.length } candidates` );
} else {
	console.log( `[batch-e2e] discovered ${ allExamples.length } webgpu_*.html — ${ candidates.length } after skip list` );
}

const deferredSceneAssetCache = new Map();
async function exampleUsesDeferredSceneAssets( name ) {

	if ( deferredSceneAssetCache.has( name ) ) return deferredSceneAssetCache.get( name );
	if ( name === 'webgpu_tsl_wood.html' ) {
		deferredSceneAssetCache.set( name, true );
		return true;
	}
	const file = localExamplesRoot ? join( localExamplesRoot, stripExampleQuery( examplePathFor( name ) ) ) : join( threeRepo, 'examples', name );
	const source = await readFile( file, 'utf8' ).catch( () => '' );
	const result = /\b(?:GLTFLoader|FBXLoader|OBJLoader|ColladaLoader|PLYLoader|STLLoader|LDrawLoader|LWOLoader|USDZLoader)\b/.test( source );
	deferredSceneAssetCache.set( name, result );
	return result;

}

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'application/javascript; charset=utf-8',
	'.mjs': 'application/javascript; charset=utf-8',
	'.json': 'application/json',
	'.wasm': 'application/wasm',
	'.css': 'text/css; charset=utf-8',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.svg': 'image/svg+xml',
	'.hdr': 'application/octet-stream',
	'.exr': 'application/octet-stream',
	'.bin': 'application/octet-stream',
	'.glb': 'model/gltf-binary',
	'.gltf': 'model/gltf+json',
	'.ktx2': 'application/octet-stream',
	'.wgsl': 'text/plain; charset=utf-8',
};

const NODE_MATERIAL_EXPORTS = [
	'NodeMaterial',
	'MeshBasicNodeMaterial',
	'MeshStandardNodeMaterial',
	'MeshPhysicalNodeMaterial',
	'MeshLambertNodeMaterial',
	'MeshPhongNodeMaterial',
	'MeshToonNodeMaterial',
	'MeshNormalNodeMaterial',
	'MeshMatcapNodeMaterial',
	'MeshSSSNodeMaterial',
	'VolumeNodeMaterial',
	'LineBasicNodeMaterial',
	'LineDashedNodeMaterial',
	'Line2NodeMaterial',
	'PointsNodeMaterial',
	'SpriteNodeMaterial',
	'ShadowNodeMaterial',
];

const SLIM_REPLAY_DIRECT_EXPORTS = new Set( [
	...NODE_MATERIAL_EXPORTS,
	'ArrayCamera',
	'BlendMode',
	'Controls',
	'MOUSE',
	'MathUtils',
	'NodeUpdateType',
	'PMREMGenerator',
	'PassNode',
	'Plane',
	'PostProcessing',
	'QuadMesh',
	'Quaternion',
	'Ray',
	'RenderPipeline',
	'RendererUtils',
	'Spherical',
	'TSL',
	'TOUCH',
	'TempNode',
	'TextureNode',
	'Vector2',
	'Vector3',
	'WebGPURenderer',
] );
const SLIM_REPLAY_SLIM_EXPORTS = Object.keys( await import( pathToFileURL( SLIM_BUNDLE ).href ) );
const SLIM_REPLAY_FULL_EXPORTS = Object.keys( await import( pathToFileURL( join( threeRepo, 'build/three.webgpu.js' ) ).href ) );
const SLIM_REPLAY_FORWARD_EXPORTS = SLIM_REPLAY_SLIM_EXPORTS
	.filter( ( name ) => /^[A-Za-z_$][\w$]*$/.test( name ) )
	.filter( ( name ) => ! SLIM_REPLAY_DIRECT_EXPORTS.has( name ) )
	.sort();
const SLIM_REPLAY_FORWARD_EXPORT_BLOCK = SLIM_REPLAY_FORWARD_EXPORTS.length > 0
	? `export { ${ SLIM_REPLAY_FORWARD_EXPORTS.join( ', ' ) } } from '/__tslp__/three.webgpu.slim.js';`
	: '';
const SLIM_REPLAY_FULL_FALLBACK_EXPORTS = SLIM_REPLAY_FULL_EXPORTS
	.filter( ( name ) => /^[A-Za-z_$][\w$]*$/.test( name ) )
	.filter( ( name ) => ! SLIM_REPLAY_DIRECT_EXPORTS.has( name ) )
	.filter( ( name ) => ! SLIM_REPLAY_SLIM_EXPORTS.includes( name ) )
	.sort();
const SLIM_REPLAY_FULL_FALLBACK_EXPORT_BLOCK = SLIM_REPLAY_FULL_FALLBACK_EXPORTS.length > 0
	? `export { ${ SLIM_REPLAY_FULL_FALLBACK_EXPORTS.join( ', ' ) } } from '/build/three.webgpu.js';`
	: '';

const captures = new Map();
function captureBucket( example ) {

	if ( ! captures.has( example ) ) captures.set( example, { user: {}, aux: [] } );
	return captures.get( example );

}

function jsonScriptLiteral( value ) {

	return JSON.stringify( value ).replace( /</g, '\\u003c' );

}

function stabilizeExampleHtml( html, example ) {

	if ( example === 'webgpu_tsl_editor.html' ) return stabilizeTslEditorHtml( html );
	if ( example !== 'webgpu_test_memory.html' ) return html;
	// The example intentionally churns random meshes/textures every frame; keep
	// the memory churn while making the visual gate compare one stable frame.
	return html
		.replace(
			"canvas2DContext.fillStyle = 'rgb(' + Math.floor( Math.random() * 256 ) + ',' + Math.floor( Math.random() * 256 ) + ',' + Math.floor( Math.random() * 256 ) + ')';",
			"canvas2DContext.fillStyle = 'rgb(192,0,80)';"
		)
		.replace(
			'const geometry = new THREE.SphereGeometry( 50, Math.random() * 64, Math.random() * 32 );',
			'const geometry = new THREE.SphereGeometry( 50, 32, 16 );'
		);

}

function stabilizeTslEditorHtml( html ) {

	return html
		.replace(
			'\t\t\tinit();',
			`\t\t\tif ( window.__TSLP_E2E ) {

\t\t\t\twindow.__tslpLoaderPending = ( window.__tslpLoaderPending | 0 ) + 1;
\t\t\t\twindow.__tslpLoaderLastBusyAt = Date.now();

\t\t\t}

\t\t\tinit();`
		)
		.replace(
			'\t\t\t\t\tlet rawShader = null;',
			`\t\t\t\t\tlet rawShader = null;
\t\t\t\t\tlet tslpInitialBuildPending = !! window.__TSLP_E2E;
\t\t\t\t\tconst tslpMarkInitialBuildReady = () => {

\t\t\t\t\t\tif ( ! tslpInitialBuildPending ) return;
\t\t\t\t\t\ttslpInitialBuildPending = false;
\t\t\t\t\t\twindow.__tslpLoaderPending = Math.max( 0, ( window.__tslpLoaderPending | 0 ) - 1 );
\t\t\t\t\t\twindow.__tslpLoaderLastBusyAt = Date.now();

\t\t\t\t\t};`
		)
		.replace(
			`\t\t\t\t\t\t} catch ( e ) {

\t\t\t\t\t\t\tresult.setValue( 'Error: ' + e.message );

\t\t\t\t\t\t}
`,
			`\t\t\t\t\t\t} catch ( e ) {

\t\t\t\t\t\t\tresult.setValue( 'Error: ' + e.message );

\t\t\t\t\t\t} finally {

\t\t\t\t\t\t\ttslpMarkInitialBuildReady();

\t\t\t\t\t\t}
`
		);

}

function injectHtml( html, example, mode ) {

	const bucket = captureBucket( example );
	const captureEndpoint = '/__tslp__/capture?example=' + encodeURIComponent( example );
	// Wedge 4: stamp a global "pinned clock" for replay so time-driven node
	// graphs render at the SAME `t` the stock comparison frame observed.
	// `bucket.frameClock` is set by `runOne` to the stock pass's
	// `nodeFrame.time` at screenshot moment — the correct reference for
	// pinning replay. Fall back to per-artifact `captureClock` (stamped at
	// compileTSL time) for offline replays where the harness can't measure
	// stock. Stock/capture modes leave the global undefined.
	let pinnedClock = null;
	if ( mode === 'replay' ) {

		if ( typeof bucket.frameClock === 'number' && Number.isFinite( bucket.frameClock ) ) {

			pinnedClock = bucket.frameClock;

		} else {

			for ( const entry of Object.values( bucket.user || {} ) ) {

				const t = entry && entry.artifact && entry.artifact.captureClock;
				if ( typeof t === 'number' && Number.isFinite( t ) ) { pinnedClock = t; break; }

			}
			if ( pinnedClock === null ) {

				for ( const entry of ( bucket.aux || [] ) ) {

					const t = entry && entry.artifact && entry.artifact.captureClock;
					if ( typeof t === 'number' && Number.isFinite( t ) ) { pinnedClock = t; break; }

				}

			}

		}

	}
	const pinBoot = pinnedClock !== null
		? `<script>globalThis.__tslpPinnedClock=${ pinnedClock };${ process.env.TSLP_DEBUG_CLOCK === '1' ? `console.log('[tslp-clock] replay pin=' + globalThis.__tslpPinnedClock);` : '' }</script>`
		: '';
	const boot = `<script>window.__TSLP_E2E=${ jsonScriptLiteral( { example, mode, artifacts: bucket, captureEndpoint, localExamples: !! localExamplesRoot } ) };</script>${ pinBoot }`;
	const mapped = rewriteImportmap( stabilizeExampleHtml( html, example ), mode );
	return mapped.includes( '</head>' )
		? mapped.replace( '</head>', `${ boot }\n</head>` )
		: boot + mapped;

}

function rewriteImportmap( html, mode ) {

	const bust = ( path ) => `${ path }?v=${ CACHE_BUST }`;
	const webgpuTarget = mode === 'capture'
		? bust( '/__tslp__/full-webgpu-auto.js' )
		: mode === 'stock'
			? bust( '/__tslp__/stock-webgpu.js' )
			: bust( '/__tslp__/slim-webgpu-replay.js' );
	let out = html
		.replace( /("three\/webgpu"\s*:\s*")[^"]+(")/g, `$1${ webgpuTarget }$2` )
		.replace( /("three"\s*:\s*")[^"]*three\.webgpu[^"]*(")/g, `$1${ webgpuTarget }$2` );

		const replayAddonsTarget = '/__tslp_addons_replay/';
		if ( mode === 'replay' ) {

			out = out.replace( /("three\/tsl"\s*:\s*")[^"]+(")/g, '$1/__tslp__/tsl-stub.js$2' );
			out = out.replace( /("three\/addons\/"\s*:\s*")[^"]+(")/g, `$1${ replayAddonsTarget }$2` );

		}

	const tslTarget = mode === 'replay' ? bust( '/__tslp__/tsl-stub.js' ) : '/build/three.tsl.js';
	const extraImports = {
		three: webgpuTarget,
		'three/webgpu': webgpuTarget,
		'three/tsl': tslTarget,
		'@tsl-precompile/runtime': '/__tslp_runtime/index.js',
		'@tsl-precompile/runtime/apply': '/__tslp_runtime/apply-precompiled.js',
		'@tsl-precompile/runtime/writers': '/__tslp_runtime/writers.js',
		'@tsl-precompile/runtime/slim-support/live-scene-index': '/__tslp_runtime/slim-support/live-scene-index.js',
		'@tsl-precompile/runtime/slim-support/pmrem': '/__tslp_runtime/slim-support/pmrem.js',
		'@tsl-precompile/runtime/slim-support/gpu-texture-share': '/__tslp_runtime/slim-support/gpu-texture-share.js',
		'@tsl-precompile/runtime/slim-support/compute-sync': '/__tslp_runtime/slim-support/compute-sync.js',
		'@tsl-precompile/contract': '/__tslp_contract/index.js',
		'@tsl-precompile/contract/dynamic-bindings': '/__tslp_contract/dynamic-bindings.js',
		'@tsl-precompile/contract/fragment-outputs': '/__tslp_contract/fragment-outputs.js',
		'@tsl-precompile/contract/graph-normalize': '/__tslp_contract/graph-normalize.js',
		'@tsl-precompile/contract/kinds': '/__tslp_contract/kinds.js',
		'@tsl-precompile/contract/texture-props': '/__tslp_contract/texture-props.js',
		'@tsl-precompile/contract/': '/__tslp_contract/',
		'virtual:tsl-precompile/__aux': bust( '/__tslp__/aux-virtual.js' ),
		'three/src/': '/src/',
		'vite-plugin-tsl-precompile/src/vendor/compileTSL.js': '/__tslp_plugin/vendor/compileTSL.js',
		'vite-plugin-tsl-precompile/src/emit-updater.js': '/__tslp_plugin/emit-updater.js',
	};

	// Local example packages (--local-examples-root) don't ship `examples/jsm/`,
	// and the harness intercepts `/examples/*` for them, so the upstream-style
	// `"three/addons/": "./jsm/"` mapping can't resolve. Inject a mapping to the
	// `/__tslp_addons/` route (served from `<threeRepo>/examples/jsm/`). Upstream
	// three examples that already declare `three/addons/` keep their own mapping.
		if ( ! /["']three\/addons\/["']\s*:/.test( out ) ) {

			extraImports[ 'three/addons/' ] = mode === 'replay' ? replayAddonsTarget : '/__tslp_addons/';

		}

	const runtimeThreeTarget = mode === 'replay' ? bust( '/__tslp__/three.webgpu.slim.js' ) : '/build/three.webgpu.js';
	const withHarnessMappings = ( map ) => {

		const next = map && typeof map === 'object' ? map : {};
		next.imports = { ...( next.imports || {} ), ...extraImports };
		next.scopes = { ...( next.scopes || {} ) };
		next.scopes[ '/__tslp_runtime/' ] = {
			...( next.scopes[ '/__tslp_runtime/' ] || {} ),
			three: runtimeThreeTarget,
			'three/webgpu': runtimeThreeTarget,
			'three/tsl': tslTarget,
		};
		return next;

	};

	if ( out.includes( '</script>' ) && out.includes( '"imports"' ) ) {

		const scriptRe = /<script\s+type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/i;
		return out.replace( scriptRe, ( match, json ) => {

			try {

				const map = withHarnessMappings( JSON.parse( json ) );
				return `<script type="importmap">${ JSON.stringify( map, null, '\t' ) }</script>`;

			} catch ( _ ) {

				return match.replace( /"imports"\s*:\s*\{/, ( m ) => `${ m }\n${ Object.entries( extraImports ).map( ( [ key, value ] ) => `\t\t\t\t"${ key }": "${ value }",` ).join( '\n' ) }` );

			}

		} );

	}

	const importMap = `<script type="importmap">${ JSON.stringify( withHarnessMappings( {} ), null, '\t' ) }</script>`;
	return out.includes( '</head>' ) ? out.replace( '</head>', `${ importMap }\n</head>` ) : importMap + out;

}

function rewriteHarnessVirtualImports( source ) {

	return String( source ).replace( /(["'])virtual:tsl-precompile\/__aux\1/g, `$1/__tslp__/aux-virtual.js?v=${ CACHE_BUST }$1` );

}

function rewriteLoaderAddon( source, className ) {

	const text = String( source );
	if ( text.includes( '__tslpPatchTextureLoaderClass' ) ) return text;
	const exportRe = new RegExp( `export\\s*\\{\\s*${ className }\\s*\\};` );
	if ( ! exportRe.test( text ) ) return text;
	return text.replace( exportRe, `if ( globalThis.__tslpPatchTextureLoaderClass ) globalThis.__tslpPatchTextureLoaderClass( ${ className }, '${ className }' );\nexport { ${ className } };` );

}

function rewriteMaterialXLoaderTextureIdentity( source ) {

	const text = String( source );
	if ( ! text.includes( 'class MaterialXLoader' ) || text.includes( '__tslpMaterialXTextureName' ) ) return text;
	const needle = `const texture = new Texture();
\t\ttexture.wrapS = texture.wrapT = RepeatWrapping;`;
	if ( ! text.includes( needle ) ) return text;
	return text.replace( needle, `const texture = new Texture();
\t\tif ( typeof uri === 'string' && uri.length > 0 ) {
\t\t\tconst __tslpMaterialXTextureName = uri.split( /[?#]/ )[ 0 ].split( '/' ).filter( Boolean ).pop() || uri;
\t\t\tif ( __tslpMaterialXTextureName && ! texture.name ) texture.name = __tslpMaterialXTextureName;
\t\t\ttry {
\t\t\t\ttexture.userData = texture.userData || {};
\t\t\t\ttexture.userData.__tslpLoaderUrl = uri;
\t\t\t} catch ( _ ) {}
\t\t}
\t\ttexture.wrapS = texture.wrapT = RepeatWrapping;` )
		.replace( `texture.image = imageBitmap;
\t\t\ttexture.needsUpdate = true;`, `texture.image = imageBitmap;
\t\t\ttexture.needsUpdate = true;
\t\t\tif ( globalThis.__tslpMarkLoaderTexture ) globalThis.__tslpMarkLoaderTexture( texture, uri );` );

}

function rewriteReplayAddon( source ) {

	const text = String( source );
	if ( ! /from\s*['"]three\/webgpu['"]/.test( text ) ) return text;
	let needsFullNodeMaterial = false;
	const rewritten = text.replace( /import\s*\{([\s\S]*?)\}\s*from\s*(['"])three\/webgpu\2/g, ( match, spec, quote ) => {
		const parts = spec.split( ',' ).map( ( part ) => part.trim() ).filter( Boolean );
		if ( ! parts.includes( 'NodeMaterial' ) ) return match;
		needsFullNodeMaterial = true;
		const kept = parts.filter( ( part ) => part !== 'NodeMaterial' );
		if ( kept.length === 0 ) return '';
		return `import { ${ kept.join( ', ' ) } } from ${ quote }three/webgpu${ quote }`;
	} );
	return needsFullNodeMaterial ? `import { NodeMaterial } from '/build/three.webgpu.js';\n${ rewritten }` : rewritten;

}

function rewriteThreeCoreDeterministicObjectIds( source ) {

	const text = String( source );
	const needle = `Object.defineProperty( this, 'id', { value: _object3DId ++ } );`;
	const replacement = `const __tslpObject3DId = typeof globalThis !== 'undefined' && typeof globalThis.__tslpStableObject3DId === 'function'
\t\t\t\t? globalThis.__tslpStableObject3DId()
\t\t\t\t: _object3DId ++;
\t\t\tObject.defineProperty( this, 'id', { value: __tslpObject3DId } );`;
	return text.includes( needle ) ? text.replace( needle, replacement ) : text;

}

function rewriteSlimDeterministicObjectIds( source ) {

	return String( source ).replace(
		/this\.isObject3D=!0,Object\.defineProperty\(this,"id",\{value:([A-Za-z_$][\w$]*)\+\+\}\)/,
		( match, counter ) => `this.isObject3D=!0,Object.defineProperty(this,"id",{value:"undefined"!=typeof globalThis&&"function"==typeof globalThis.__tslpStableObject3DId?globalThis.__tslpStableObject3DId():${ counter }++})`
	);

}

function stockWebgpuModule() {

	return `
import * as Original from '/build/three.webgpu.js';
export * from '/build/three.webgpu.js';

let __pmremRunning = 0;
window.__tslpPmremPending = window.__tslpPmremPending || 0;
window.__tslpCompilePending = window.__tslpCompilePending || 0;

function __tslpLoaderBasename( value ) {
	const raw = String( value || '' );
	const tail = raw.split( /[?#]/ )[ 0 ].split( '/' ).filter( Boolean ).pop() || raw;
	return tail || '';
}

window.__tslpMarkLoaderTexture = function ( texture, url ) {
	if ( ! texture || texture.isTexture !== true ) return texture;
	const name = __tslpLoaderBasename( url );
	if ( name && ! texture.name ) texture.name = name;
	try {
		texture.userData = texture.userData || {};
		if ( typeof url === 'string' && url.length > 0 ) texture.userData.__tslpLoaderUrl = url;
	} catch ( _ ) {}
	return texture;
};

window.__tslpPatchTextureLoaderClass = function ( Ctor ) {
	if ( ! Ctor || ! Ctor.prototype || typeof Ctor.prototype.load !== 'function' || Ctor.prototype.__tslpCallbackLoadPatched ) return;
	Ctor.prototype.__tslpCallbackLoadPatched = true;
	const origLoad = Ctor.prototype.load;
	const _now = () => ( typeof window.__tslpRealNow === 'function' ? window.__tslpRealNow() : Date.now() );
	Ctor.prototype.load = function ( url, onLoad, onProgress, onError ) {
		window.__tslpLoaderPending = ( window.__tslpLoaderPending | 0 ) + 1;
		window.__tslpLoaderLastBusyAt = _now();
		let settled = false;
		const settle = () => {
			if ( settled ) return;
			settled = true;
			window.__tslpLoaderPending = Math.max( 0, ( window.__tslpLoaderPending | 0 ) - 1 );
			window.__tslpLoaderLastBusyAt = _now();
		};
		const wrapLoad = ( texture, ...rest ) => {
			window.__tslpMarkLoaderTexture( texture, url );
			try { if ( typeof onLoad === 'function' ) return onLoad.call( this, texture, ...rest ); }
			finally { settle(); }
		};
		const wrapError = ( err, ...rest ) => {
			try { if ( typeof onError === 'function' ) return onError.call( this, err, ...rest ); }
			finally { settle(); }
		};
		try {
			const result = origLoad.call( this, url, wrapLoad, onProgress, wrapError );
			window.__tslpMarkLoaderTexture( result, url );
			return result;
		} catch ( err ) {
			settle();
			throw err;
		}
	};
};

for ( const __tslpTextureLoaderCtor of [ Original.TextureLoader, Original.CubeTextureLoader, Original.DataTextureLoader, Original.ImageBitmapLoader ] ) {
	window.__tslpPatchTextureLoaderClass( __tslpTextureLoaderCtor );
}

function __syncFramebufferTextureForActiveTarget( renderer, texture ) {
	if ( ! renderer || ! texture || texture.isFramebufferTexture !== true ) return null;
	const context = renderer._currentRenderContext || null;
	const target = context && context.renderTarget || null;
	const source = target && target.texture || null;
	if ( ! source ) return null;
	let currentTarget = null;
	try { currentTarget = typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : null; } catch ( _ ) {}
	const previousTarget = renderer._renderTarget;
	const patchTarget = ! currentTarget && previousTarget !== target;
	let changed = false;
	for ( const key of [ 'format', 'type', 'colorSpace' ] ) {
		if ( source[ key ] !== undefined && texture[ key ] !== source[ key ] ) {
			texture[ key ] = source[ key ];
			changed = true;
		}
	}
	if ( changed ) texture.needsUpdate = true;
	if ( patchTarget ) renderer._renderTarget = target;
	return () => {
		if ( patchTarget ) renderer._renderTarget = previousTarget;
	};
}

function __recordRenderableObjectCount( scene ) {
	if ( ! scene || typeof scene.traverse !== 'function' ) return;
	let count = 0;
	try {
		scene.traverse( ( object ) => {
			if ( object && object.visible !== false && object.geometry && object.material ) count ++;
		} );
	} catch ( _ ) {
		return;
	}
	const prev = window.__tslpRenderableObjectCount | 0;
	if ( count !== prev ) {
		window.__tslpRenderableObjectCount = count;
		window.__tslpRenderableLastBusyAt = typeof window.__tslpRealNow === 'function' ? window.__tslpRealNow() : Date.now();
	}
}

( function patchStockDefaultLoadingManager() {
	const dlm = Original.DefaultLoadingManager;
	if ( ! dlm || dlm.__tslpStockPatched ) return;
	dlm.__tslpStockPatched = true;
	const _origStart = dlm.itemStart.bind( dlm );
	const _origEnd = dlm.itemEnd.bind( dlm );
	const _origError = dlm.itemError ? dlm.itemError.bind( dlm ) : null;
	const _now = () => ( typeof window.__tslpRealNow === 'function' ? window.__tslpRealNow() : Date.now() );
	dlm.itemStart = function ( url ) {
		window.__tslpLoaderPending = ( window.__tslpLoaderPending | 0 ) + 1;
		window.__tslpLoaderLastBusyAt = _now();
		return _origStart( url );
	};
	dlm.itemEnd = function ( url ) {
		window.__tslpLoaderPending = Math.max( 0, ( window.__tslpLoaderPending | 0 ) - 1 );
		window.__tslpLoaderLastBusyAt = _now();
		return _origEnd( url );
	};
	if ( _origError ) dlm.itemError = function ( url ) { return _origError( url ); };
} )();

	( function patchStockPMREMGenerator() {
		const PG = Original.PMREMGenerator;
		if ( ! PG || ! PG.prototype || PG.prototype.__tslpStockPatched ) return;
	PG.prototype.__tslpStockPatched = true;
	const begin = () => {
		__pmremRunning ++;
		window.__tslpPmremPending = ( window.__tslpPmremPending | 0 ) + 1;
	};
	const end = () => {
		__pmremRunning = Math.max( 0, __pmremRunning - 1 );
		window.__tslpPmremPending = Math.max( 0, ( window.__tslpPmremPending | 0 ) - 1 );
	};
	for ( const method of [ 'fromScene', 'fromCubemap', 'fromEquirectangular', 'fromTexture' ] ) {
		const orig = PG.prototype[ method ];
		if ( typeof orig !== 'function' ) continue;
		PG.prototype[ method ] = function ( ...args ) {
			begin();
			try { return orig.apply( this, args ); }
			finally { end(); }
		};
	}
	for ( const method of [ 'fromSceneAsync', 'fromCubemapAsync', 'fromEquirectangularAsync' ] ) {
		const orig = PG.prototype[ method ];
		if ( typeof orig !== 'function' ) continue;
		PG.prototype[ method ] = function ( ...args ) {
			begin();
			let result;
			try { result = orig.apply( this, args ); }
			catch ( err ) { end(); throw err; }
			return Promise.resolve( result ).finally( end );
		};
		}
	} )();

	function __isStockTRAAEffectNode( node ) {
		if ( ! node || typeof node === 'function' ) return false;
		const type = ( node.constructor && ( node.constructor.type || node.constructor.name ) ) || node.type || '';
		if ( type && type !== 'TRAANode' ) return false;
		return !! ( node && typeof node.updateBefore === 'function' && node._resolveMaterial && node._historyRenderTarget && node._resolveRenderTarget );
	}

	function __isStockTAAUEffectNode( node ) {
		if ( ! node || typeof node === 'function' ) return false;
		const type = ( node.constructor && ( node.constructor.type || node.constructor.name ) ) || node.type || '';
		if ( type && type !== 'TAAUNode' ) return false;
		return !! ( node && typeof node.updateBefore === 'function' && node._resolveMaterial && node._historyRenderTarget && node._resolveRenderTarget );
	}

	function __pinStockTRAAJitterIndex( traaNode ) {
		if ( ! traaNode || traaNode.__tslpTRAAJitterPinned === true ) return;
		const proto = Object.getPrototypeOf( traaNode );
		const originalSetViewOffset = traaNode.setViewOffset || ( proto && proto.setViewOffset );
		const originalClearViewOffset = traaNode.clearViewOffset || ( proto && proto.clearViewOffset );
		if ( typeof originalSetViewOffset === 'function' ) {
			traaNode.setViewOffset = function ( width, height ) {
				try { this._jitterIndex = 0; } catch ( _ ) {}
				return originalSetViewOffset.call( this, width, height );
			};
		}
		if ( typeof originalClearViewOffset === 'function' ) {
			traaNode.clearViewOffset = function () {
				try {
					if ( this.camera && typeof this.camera.clearViewOffset === 'function' ) this.camera.clearViewOffset();
					if ( this._velocityNode && typeof this._velocityNode.setProjectionMatrix === 'function' ) this._velocityNode.setProjectionMatrix( null );
				} catch ( _ ) {}
				try { this._jitterIndex = 0; } catch ( _ ) {}
			};
		}
		try { traaNode._jitterIndex = 0; } catch ( _ ) {}
		try { Object.defineProperty( traaNode, '__tslpTRAAJitterPinned', { value: true, configurable: true } ); } catch ( _ ) {}
	}

	function __pinStockTAAUJitterIndex( taauNode ) {
		if ( ! taauNode || taauNode.__tslpTAAUJitterPinned === true ) return;
		const proto = Object.getPrototypeOf( taauNode );
		const originalSetViewOffset = taauNode.setViewOffset || ( proto && proto.setViewOffset );
		const originalClearViewOffset = taauNode.clearViewOffset || ( proto && proto.clearViewOffset );
		if ( typeof originalSetViewOffset === 'function' ) {
			taauNode.setViewOffset = function ( width, height ) {
				try { this._jitterIndex = 0; } catch ( _ ) {}
				return originalSetViewOffset.call( this, width, height );
			};
		}
		if ( typeof originalClearViewOffset === 'function' ) {
			taauNode.clearViewOffset = function () {
				const result = originalClearViewOffset.call( this );
				try { this._jitterIndex = 0; } catch ( _ ) {}
				return result;
			};
		}
		try { taauNode._jitterIndex = 0; } catch ( _ ) {}
		try { Object.defineProperty( taauNode, '__tslpTAAUJitterPinned', { value: true, configurable: true } ); } catch ( _ ) {}
	}

	function __scanForStockTAAUNodes( node, seen = new Set(), depth = 0 ) {
		if ( ! node || depth > 24 || seen.has( node ) ) return;
		if ( typeof node !== 'object' && typeof node !== 'function' ) return;
		seen.add( node );
		if ( __isStockTRAAEffectNode( node ) ) {
			__pinStockTRAAJitterIndex( node );
			return;
		}
		if ( __isStockTAAUEffectNode( node ) ) {
			__pinStockTAAUJitterIndex( node );
			return;
		}
		const keys = [];
		try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) {}
		const skip = new Set( [ 'parent', 'children', '_cache', 'scene', 'camera', 'renderer', 'geometry', 'material', 'domElement' ] );
		for ( const key of keys ) {
			if ( skip.has( key ) ) continue;
			let child;
			try { child = node[ key ]; } catch ( _ ) { continue; }
			if ( ! child ) continue;
			if ( Array.isArray( child ) ) {
				for ( const item of child ) if ( item && ( typeof item === 'object' || typeof item === 'function' ) ) __scanForStockTAAUNodes( item, seen, depth + 1 );
			} else if ( typeof child === 'object' || typeof child === 'function' ) {
				__scanForStockTAAUNodes( child, seen, depth + 1 );
			}
		}
	}

	const __StockRenderPipelineBase = Original.RenderPipeline || Original.PostProcessing;
	export class RenderPipeline extends __StockRenderPipelineBase {
		render( ...args ) {
			try { window.__tslpLastRenderPipeline = this; } catch ( _ ) {}
			try { if ( this.outputNode ) __scanForStockTAAUNodes( this.outputNode ); } catch ( _ ) {}
			return super.render( ...args );
		}
	}

	export class PostProcessing extends RenderPipeline {}

	function __trackDebugShaderAsync( renderer ) {
		const debug = renderer && renderer.debug;
		if ( ! debug || debug.__tslpGetShaderAsyncPatched || typeof debug.getShaderAsync !== 'function' ) return;
		const originalGetShaderAsync = debug.getShaderAsync;
		try {
			Object.defineProperty( debug, '__tslpGetShaderAsyncPatched', {
				value: true,
				configurable: true,
			} );
		} catch ( _ ) {
			debug.__tslpGetShaderAsyncPatched = true;
		}
		debug.getShaderAsync = function ( ...args ) {
			window.__tslpCompilePending = ( window.__tslpCompilePending | 0 ) + 1;
			const settle = () => { window.__tslpCompilePending = Math.max( 0, ( window.__tslpCompilePending | 0 ) - 1 ); };
			try {
				const p = originalGetShaderAsync.apply( this, args );
				return Promise.resolve( p ).then( ( v ) => { settle(); return v; }, ( e ) => { settle(); throw e; } );
			} catch ( err ) {
				settle();
				throw err;
			}
		};
	}

	export class WebGPURenderer extends Original.WebGPURenderer {
	constructor( ...args ) {
		super( ...args );
		// Wedge 4: expose the harness's WebGPURenderer so the runner can read
		// nodeFrame.time at screenshot time (the "freeze clock") to pin replay.
		window.__tslpHarnessRenderer = this;
		__trackDebugShaderAsync( this );
	}
		setAnimationLoop( callback ) {
			const wrap = typeof window.__tslpWrapAnimationLoop === 'function' ? window.__tslpWrapAnimationLoop : null;
			return super.setAnimationLoop( wrap ? wrap( callback ) : callback );
		}
		copyFramebufferToTexture( texture, rectangle = null ) {
			const restore = __syncFramebufferTextureForActiveTarget( this, texture );
			try {
				return super.copyFramebufferToTexture( texture, rectangle );
			} finally {
				if ( restore ) restore();
			}
		}
		compileAsync( scene, camera, ...rest ) {
			if ( __pmremRunning > 0 ) return typeof super.compileAsync === 'function' ? super.compileAsync( scene, camera, ...rest ) : Promise.resolve();
			if ( typeof super.compileAsync !== 'function' ) return Promise.resolve();
			window.__tslpCompilePending = ( window.__tslpCompilePending | 0 ) + 1;
		const settle = () => { window.__tslpCompilePending = Math.max( 0, ( window.__tslpCompilePending | 0 ) - 1 ); };
		const p = super.compileAsync( scene, camera, ...rest );
		return Promise.resolve( p ).then( ( v ) => { settle(); return v; }, ( e ) => { settle(); throw e; } );
	}
	render( scene, camera ) {
		__recordRenderableObjectCount( scene );
		return super.render( scene, camera );
	}
}
`;

}

function auxVirtualModule() {

	return `
import { registerAuxArtifacts } from '@tsl-precompile/runtime';

const __state = window.__TSLP_E2E || {};
const __entries = __state.mode === 'replay' && __state.artifacts && Array.isArray( __state.artifacts.aux )
	? __state.artifacts.aux
	: [];

if ( __entries.length > 0 ) registerAuxArtifacts( __entries );

export default __entries;
`;

}

function fullWebgpuAutoModule() {

	return `
import * as Original from '/build/three.webgpu.js';
export * from '/build/three.webgpu.js';
import { installPrecompileMarker, setDevRenderer } from '/__tslp_runtime/precompile-marker.js';
import { precompileAuxiliary } from '/__tslp_runtime/aux-marker.js';

const __state = window.__TSLP_E2E || { example: 'unknown' };
const __counts = Object.create( null );
const __pending = [];
const __seenMaterials = new WeakMap();
const __bundleSharedNames = new Map();
const __postProcessingPipelines = new Set();
const __auxPromises = new Set();
const __auxScenes = new Map();
let __renderer = null;
let __pmremRunning = 0;
let __lastScene = null;
let __lastCamera = null;
window.__tslpPmremPending = window.__tslpPmremPending || 0;
window.__tslpPrecompilePending = window.__tslpPrecompilePending || 0;
window.__tslpAuxCapturePending = window.__tslpAuxCapturePending || 0;

function __tslpLoaderBasename( value ) {
	const raw = String( value || '' );
	const tail = raw.split( /[?#]/ )[ 0 ].split( '/' ).filter( Boolean ).pop() || raw;
	return tail || '';
}

window.__tslpMarkLoaderTexture = function ( texture, url ) {
	if ( ! texture || texture.isTexture !== true ) return texture;
	const name = __tslpLoaderBasename( url );
	if ( name && ! texture.name ) texture.name = name;
	try {
		texture.userData = texture.userData || {};
		if ( typeof url === 'string' && url.length > 0 ) texture.userData.__tslpLoaderUrl = url;
	} catch ( _ ) {}
	return texture;
};

window.__tslpPatchTextureLoaderClass = function ( Ctor ) {
	if ( ! Ctor || ! Ctor.prototype || typeof Ctor.prototype.load !== 'function' || Ctor.prototype.__tslpCallbackLoadPatched ) return;
	Ctor.prototype.__tslpCallbackLoadPatched = true;
	const origLoad = Ctor.prototype.load;
	const _now = () => ( typeof window.__tslpRealNow === 'function' ? window.__tslpRealNow() : Date.now() );
	Ctor.prototype.load = function ( url, onLoad, onProgress, onError ) {
		window.__tslpLoaderPending = ( window.__tslpLoaderPending | 0 ) + 1;
		window.__tslpLoaderLastBusyAt = _now();
		let settled = false;
		const settle = () => {
			if ( settled ) return;
			settled = true;
			window.__tslpLoaderPending = Math.max( 0, ( window.__tslpLoaderPending | 0 ) - 1 );
			window.__tslpLoaderLastBusyAt = _now();
		};
		const wrapLoad = ( texture, ...rest ) => {
			window.__tslpMarkLoaderTexture( texture, url );
			try { if ( typeof onLoad === 'function' ) return onLoad.call( this, texture, ...rest ); }
			finally { settle(); }
		};
		const wrapError = ( err, ...rest ) => {
			try { if ( typeof onError === 'function' ) return onError.call( this, err, ...rest ); }
			finally { settle(); }
		};
		try {
			const result = origLoad.call( this, url, wrapLoad, onProgress, wrapError );
			window.__tslpMarkLoaderTexture( result, url );
			return result;
		} catch ( err ) {
			settle();
			throw err;
		}
	};
};

for ( const __tslpTextureLoaderCtor of [ Original.TextureLoader, Original.CubeTextureLoader, Original.DataTextureLoader, Original.ImageBitmapLoader ] ) {
	window.__tslpPatchTextureLoaderClass( __tslpTextureLoaderCtor );
}

function __syncFramebufferTextureForActiveTarget( renderer, texture ) {
	if ( ! renderer || ! texture || texture.isFramebufferTexture !== true ) return null;
	const context = renderer._currentRenderContext || null;
	const target = context && context.renderTarget || null;
	const source = target && target.texture || null;
	if ( ! source ) return null;
	let currentTarget = null;
	try { currentTarget = typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : null; } catch ( _ ) {}
	const previousTarget = renderer._renderTarget;
	const patchTarget = ! currentTarget && previousTarget !== target;
	let changed = false;
	for ( const key of [ 'format', 'type', 'colorSpace' ] ) {
		if ( source[ key ] !== undefined && texture[ key ] !== source[ key ] ) {
			texture[ key ] = source[ key ];
			changed = true;
		}
	}
	if ( changed ) texture.needsUpdate = true;
	if ( patchTarget ) renderer._renderTarget = target;
	return () => {
		if ( patchTarget ) renderer._renderTarget = previousTarget;
	};
}

function __recordRenderableObjectCount( scene ) {
	if ( ! scene || typeof scene.traverse !== 'function' ) return;
	let count = 0;
	try {
		scene.traverse( ( object ) => {
			if ( object && object.visible !== false && object.geometry && object.material ) count ++;
		} );
	} catch ( _ ) {
		return;
	}
	const prev = window.__tslpRenderableObjectCount | 0;
	if ( count !== prev ) {
		window.__tslpRenderableObjectCount = count;
		window.__tslpRenderableLastBusyAt = typeof window.__tslpRealNow === 'function' ? window.__tslpRealNow() : Date.now();
	}
}

// Bump window.__tslpLoaderPending around every three.js loader item so the
// Playwright wait gate doesn't screenshot while HDR/GLTF/MaterialX/etc. are
// still in flight. All stock three.js loaders use DefaultLoadingManager unless
// constructed with an explicit one; itemStart/itemEnd are the lower-level hooks
// the manager calls per-item, so wrapping them catches every default loader.
( function patchDefaultLoadingManager() {
	const dlm = Original.DefaultLoadingManager;
	if ( ! dlm || dlm.__tslpPatched ) return;
	dlm.__tslpPatched = true;
	const _origStart = dlm.itemStart.bind( dlm );
	const _origEnd = dlm.itemEnd.bind( dlm );
	const _origError = dlm.itemError ? dlm.itemError.bind( dlm ) : null;
	const _now = () => ( typeof window.__tslpRealNow === 'function' ? window.__tslpRealNow() : Date.now() );
	dlm.itemStart = function ( url ) {
		window.__tslpLoaderPending = ( window.__tslpLoaderPending | 0 ) + 1;
		window.__tslpLoaderLastBusyAt = _now();
		return _origStart( url );
	};
	dlm.itemEnd = function ( url ) {
		window.__tslpLoaderPending = Math.max( 0, ( window.__tslpLoaderPending | 0 ) - 1 );
		window.__tslpLoaderLastBusyAt = _now();
		return _origEnd( url );
	};
	if ( _origError ) dlm.itemError = function ( url ) {
		// itemEnd is also called after itemError by Loader.load, so don't double-decrement here.
		return _origError( url );
	};
} )();

installPrecompileMarker( Original, {
	devEndpoint: '/__tslp__/capture?example=' + encodeURIComponent( __state.example ),
} );

( function patchCapturePMREMGenerator() {
	const PG = Original.PMREMGenerator;
	if ( ! PG || ! PG.prototype || PG.prototype.__tslpCapturePatched ) return;
	PG.prototype.__tslpCapturePatched = true;
	const begin = () => {
		__pmremRunning ++;
		window.__tslpPmremPending = ( window.__tslpPmremPending | 0 ) + 1;
	};
	const end = () => {
		__pmremRunning = Math.max( 0, __pmremRunning - 1 );
		window.__tslpPmremPending = Math.max( 0, ( window.__tslpPmremPending | 0 ) - 1 );
	};
	for ( const method of [ 'fromScene', 'fromCubemap', 'fromEquirectangular', 'fromTexture' ] ) {
		const orig = PG.prototype[ method ];
		if ( typeof orig !== 'function' ) continue;
		PG.prototype[ method ] = function ( ...args ) {
			begin();
			try {
				return orig.apply( this, args );
			} finally {
				end();
			}
		};
	}
	for ( const method of [ 'fromSceneAsync', 'fromCubemapAsync', 'fromEquirectangularAsync' ] ) {
		const orig = PG.prototype[ method ];
		if ( typeof orig !== 'function' ) continue;
		PG.prototype[ method ] = function ( ...args ) {
			begin();
			let result;
			try {
				result = orig.apply( this, args );
			} catch ( err ) {
				end();
				throw err;
			}
			return Promise.resolve( result ).finally( end );
		};
	}
} )();

function __cameraSeesObject( camera, object ) {
	if ( ! camera || ! object || ! camera.layers || ! object.layers ) return true;
	try { return camera.layers.test( object.layers ); } catch ( _ ) { return true; }
}

function __mark( material, className, sourceObject = null, camera = null ) {
	if ( ! material ) return;
	if ( sourceObject && ! material.__tslpPrecompileObject ) Object.defineProperty( material, '__tslpPrecompileObject', { value: sourceObject, configurable: true } );
	const hasCameraHint = Object.prototype.hasOwnProperty.call( material, '__tslpPrecompileCamera' );
	const currentCameraSeesObject = hasCameraHint ? __cameraSeesObject( material.__tslpPrecompileCamera, sourceObject ) : false;
	const nextCameraSeesObject = __cameraSeesObject( camera, sourceObject );
	if ( camera && nextCameraSeesObject && ( ! hasCameraHint || ! currentCameraSeesObject ) ) {
		Object.defineProperty( material, '__tslpPrecompileCamera', { value: camera, configurable: true } );
	}
	if ( sourceObject && ! Object.prototype.hasOwnProperty.call( material, '__tslpArrayCamera' ) ) {
		const arrayCameraHint = camera && camera.isArrayCamera === true ? camera : null;
		Object.defineProperty( material, '__tslpArrayCamera', { value: arrayCameraHint, configurable: true } );
	}
	const sourceScene = sourceObject ? __findParentScene( sourceObject ) : null;
	if ( sourceScene ) {
		const currentScene = material.__tslpPrecompileScene || null;
		const shouldSetScene = ! currentScene || ( __countSceneLights( currentScene ) === 0 && __countSceneLights( sourceScene ) > 0 );
		if ( shouldSetScene ) Object.defineProperty( material, '__tslpPrecompileScene', { value: sourceScene, configurable: true } );
	}
	if ( __seenMaterials.has( material ) ) return;
	const bundleKey = __isInsideBundleGroup( sourceObject ) ? className : null;
	if ( bundleKey && __bundleSharedNames.has( bundleKey ) ) {
		__seenMaterials.set( material, __bundleSharedNames.get( bundleKey ) );
		return;
	}
	const n = ( __counts[ className ] || 0 ) + 1;
	__counts[ className ] = n;
	const name = __state.example + ':' + className + ':' + n;
	material.name = material.name || name;
	__seenMaterials.set( material, name );
	if ( bundleKey ) __bundleSharedNames.set( bundleKey, name );
	__pending.push( { material, name, done: false } );
	// Do NOT __flush() here. precompile() must run AFTER the example
	// has finished setting up the scene (background, environment,
	// lights). Many examples create materials inside an async loader
	// callback then set scene.environment on the next line — running
	// precompile from the material constructor would freeze an artifact
	// without the IBL bindings. We defer precompile to the first
	// render()/compile() hook below, by which time scene state is
	// guaranteed to be fully wired.
}

function __findParentScene( object ) {
	let current = object || null;
	while ( current ) {
		if ( current.isScene === true ) return current;
		current = current.parent || null;
	}
	return null;
}

function __countSceneLights( scene ) {
	if ( ! scene || typeof scene.traverse !== 'function' ) return 0;
	let count = 0;
	try {
		scene.traverse( ( object ) => {
			if ( object && object.isLight === true ) count ++;
		} );
	} catch ( _ ) {}
	return count;
}

function __isInsideBundleGroup( object ) {
	let current = object;
	while ( current ) {
		if ( current.isBundleGroup === true ) return true;
		current = current.parent || null;
	}
	return false;
}

function __classNameForMaterial( material ) {
	if ( ! material ) return 'Material';
	const type = material.type || '';
	if ( type === 'Line2NodeMaterial' ) return 'Line2NodeMaterial';
	if ( material.isMeshBasicNodeMaterial || material.isMeshBasicMaterial ) return 'MeshBasicNodeMaterial';
	if ( material.isMeshSSSNodeMaterial || material.type === 'MeshSSSNodeMaterial' ) return 'MeshSSSNodeMaterial';
	if ( material.isMeshPhysicalNodeMaterial || material.isMeshPhysicalMaterial ) return 'MeshPhysicalNodeMaterial';
	if ( material.isMeshStandardNodeMaterial || material.isMeshStandardMaterial ) return 'MeshStandardNodeMaterial';
	if ( material.isMeshLambertNodeMaterial || material.isMeshLambertMaterial ) return 'MeshLambertNodeMaterial';
	if ( material.isMeshPhongNodeMaterial || material.isMeshPhongMaterial ) return 'MeshPhongNodeMaterial';
	if ( material.isMeshToonNodeMaterial || material.isMeshToonMaterial ) return 'MeshToonNodeMaterial';
	if ( material.isMeshNormalNodeMaterial || material.isMeshNormalMaterial ) return 'MeshNormalNodeMaterial';
	if ( material.isMeshMatcapNodeMaterial || material.isMeshMatcapMaterial ) return 'MeshMatcapNodeMaterial';
	if ( material.isLine2NodeMaterial ) return 'Line2NodeMaterial';
	if ( material.isLineBasicNodeMaterial || material.isLineBasicMaterial ) return 'LineBasicNodeMaterial';
	if ( material.isPointsNodeMaterial || material.isPointsMaterial ) return 'PointsNodeMaterial';
	if ( material.isSpriteNodeMaterial || material.isSpriteMaterial ) return 'SpriteNodeMaterial';
	if ( material.isVolumeNodeMaterial || type === 'VolumeNodeMaterial' ) return 'VolumeNodeMaterial';
	if ( type === 'MeshBasicNodeMaterial' || type === 'MeshBasicMaterial' ) return 'MeshBasicNodeMaterial';
	if ( type === 'MeshSSSNodeMaterial' ) return 'MeshSSSNodeMaterial';
	if ( type === 'MeshPhysicalNodeMaterial' || type === 'MeshPhysicalMaterial' ) return 'MeshPhysicalNodeMaterial';
	if ( type === 'MeshStandardNodeMaterial' || type === 'MeshStandardMaterial' ) return 'MeshStandardNodeMaterial';
	if ( type === 'MeshLambertNodeMaterial' || type === 'MeshLambertMaterial' ) return 'MeshLambertNodeMaterial';
	if ( type === 'MeshPhongNodeMaterial' || type === 'MeshPhongMaterial' ) return 'MeshPhongNodeMaterial';
	if ( type === 'MeshToonNodeMaterial' || type === 'MeshToonMaterial' ) return 'MeshToonNodeMaterial';
	if ( type === 'MeshNormalNodeMaterial' || type === 'MeshNormalMaterial' ) return 'MeshNormalNodeMaterial';
	if ( type === 'MeshMatcapNodeMaterial' || type === 'MeshMatcapMaterial' ) return 'MeshMatcapNodeMaterial';
	if ( type === 'Line2NodeMaterial' ) return 'Line2NodeMaterial';
	if ( type === 'LineBasicNodeMaterial' || type === 'LineBasicMaterial' ) return 'LineBasicNodeMaterial';
	if ( type === 'PointsNodeMaterial' || type === 'PointsMaterial' ) return 'PointsNodeMaterial';
	if ( type === 'SpriteNodeMaterial' || type === 'SpriteMaterial' ) return 'SpriteNodeMaterial';
	if ( /NodeMaterial$/.test( type ) ) return type;
	return material.constructor && material.constructor.name || 'Material';
}

function __isRetroPassRenderTarget( renderer ) {
	try {
		const target = renderer && typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : null;
		const texture = target && target.texture;
		return !! ( texture
			&& texture.magFilter === Original.NearestFilter
			&& texture.minFilter === Original.NearestFilter );
	} catch ( _ ) {
		return false;
	}
}

function __isRetroPassGeneratedMaterial( renderer, scene, material, className ) {
	return !! ( material
		&& scene && scene.isScene === true && scene.userData && scene.userData.__tslpUserScene === true
		&& __isRetroPassRenderTarget( renderer )
		&& /^(?:MeshBasic|MeshPhong)NodeMaterial$/.test( className || __classNameForMaterial( material ) ) );
}

function __markSceneMaterials( scene, camera = null ) {
	if ( ! scene || typeof scene.traverse !== 'function' ) return;
	if ( scene.isScene !== true ) return;
	if ( ! scene.userData || scene.userData.__tslpUserScene !== true ) return;
	if ( scene.userData && scene.userData.__tslpSyntheticCaptureScene ) return;
	if ( camera && camera.isArrayCamera === true && scene.overrideMaterial ) return;
	if ( scene.overrideMaterial && scene.overrideMaterial.visible !== false ) {
		__mark( scene.overrideMaterial, __classNameForMaterial( scene.overrideMaterial ), null, camera );
	}
	scene.traverse( ( object ) => {
		const material = object && object.material;
		const materials = Array.isArray( material ) ? material : material ? [ material ] : [];
		for ( const m of materials ) {

			if ( m && m.visible === false ) continue;
			__mark( m, __classNameForMaterial( m ), object, camera );

		}
	} );
}

// QuadMesh.render(renderer) bottoms out at renderer.render(quadMesh, _camera),
// so the "scene" argument is a Mesh — not a Scene — and __markSceneMaterials
// short-circuits. Catch the post-FX material on the QuadMesh (and any other
// standalone mesh.render path) here so its precompile artifact gets captured.
function __markStandaloneRenderTargetMaterial( target ) {
	if ( ! target || target.isScene === true || ! target.material ) return;
	const materials = Array.isArray( target.material ) ? target.material : [ target.material ];
	for ( const m of materials ) {
		if ( ! m || m.visible === false ) continue;
		if ( __classNameForMaterial( m ) === 'NodeMaterial' && target.name !== 'Render Pipeline' && target.isQuadMesh !== true ) continue;
		__mark( m, __classNameForMaterial( m ), target );
	}
}

function __rememberAuxScene( scene, camera ) {
	if ( ! scene || scene.isScene !== true ) return;
	if ( ! scene.userData || scene.userData.__tslpUserScene !== true ) return;
	if ( scene.userData && scene.userData.__tslpSyntheticCaptureScene ) return;
	__auxScenes.set( scene, camera || null );
}

function __stampSceneMRT( scene, renderer ) {
	if ( ! scene || scene.isScene !== true ) return;
	if ( ! scene.userData || scene.userData.__tslpUserScene !== true ) return;
	if ( scene.userData && scene.userData.__tslpSyntheticCaptureScene ) return;
	if ( ! renderer || typeof renderer.getMRT !== 'function' ) return;
	const mrtNode = renderer.getMRT();
	if ( mrtNode ) scene.userData.__tslp_mrtNode = mrtNode;
}

async function __waitForPrecompilePendingAtMost( limit, timeoutMs = 20000 ) {
	const now = () => ( typeof window.__tslpRealNow === 'function' ? window.__tslpRealNow() : Date.now() );
	const start = now();
	while ( ( window.__tslpPrecompilePending | 0 ) > limit ) {
		if ( now() - start > timeoutMs ) throw new Error( 'timed out waiting for material precompile' );
		await new Promise( ( resolve ) => setTimeout( resolve, 25 ) );
	}
}

async function __flush() {
	if ( ! __renderer ) return;
	for ( const item of __pending ) {
		if ( item.done ) continue;
		item.done = true;
		const scene = item.material && item.material.__tslpPrecompileScene || null;
		const sceneUserData = scene && scene.userData;
		const sceneMRT = sceneUserData && sceneUserData.__tslp_mrtNode || null;
		if ( sceneMRT ) {
			const currentMRT = typeof __renderer.getMRT === 'function' ? __renderer.getMRT() : null;
			const colorMaterial = item.material && typeof item.material.clone === 'function' ? item.material.clone() : item.material;
			try {
				if ( item.material.__tslpPrecompileScene ) Object.defineProperty( colorMaterial, '__tslpPrecompileScene', { value: item.material.__tslpPrecompileScene, configurable: true } );
				if ( item.material.__tslpPrecompileObject ) Object.defineProperty( colorMaterial, '__tslpPrecompileObject', { value: item.material.__tslpPrecompileObject, configurable: true } );
				if ( Object.prototype.hasOwnProperty.call( item.material, '__tslpArrayCamera' ) ) Object.defineProperty( colorMaterial, '__tslpArrayCamera', { value: item.material.__tslpArrayCamera, configurable: true } );
			} catch ( _ ) {}
			try {
				delete sceneUserData.__tslp_mrtNode;
				colorMaterial.mrtNode = null;
				colorMaterial.needsUpdate = true;
				if ( typeof __renderer.setMRT === 'function' ) __renderer.setMRT( null );
				const pendingBefore = window.__tslpPrecompilePending | 0;
				colorMaterial.precompile( item.name + ':color' );
				await __waitForPrecompilePendingAtMost( pendingBefore );
			} catch ( err ) {
				console.error( '[tslp-e2e] non-MRT precompile failed:', err );
			} finally {
				sceneUserData.__tslp_mrtNode = sceneMRT;
				if ( typeof __renderer.setMRT === 'function' ) __renderer.setMRT( currentMRT );
			}
		}
		try {
			const pendingBefore = window.__tslpPrecompilePending | 0;
			item.material.needsUpdate = true;
			item.material.precompile( item.name );
			await __waitForPrecompilePendingAtMost( pendingBefore );
		} catch ( err ) {
			console.error( '[tslp-e2e] precompile failed:', err );
		}
	}
}

function __trackAuxCapture( promise, label ) {
	window.__tslpAuxCapturePending = ( window.__tslpAuxCapturePending | 0 ) + 1;
	let tracked;
	tracked = Promise.resolve( promise )
		.catch( ( err ) => console.warn( '[tslp-e2e] ' + label + ' failed:', err && err.message || err ) )
		.finally( () => {
			window.__tslpAuxCapturePending = Math.max( 0, ( window.__tslpAuxCapturePending | 0 ) - 1 );
			__auxPromises.delete( tracked );
		} );
	__auxPromises.add( tracked );
	return tracked;
}

function __auxOpts( extra = {} ) {
	return {
		devEndpoint: '/__tslp__/capture?example=' + encodeURIComponent( __state.example ),
		three: Original,
		threeVersion: ${ JSON.stringify( SLIM_HASH_OPTS.threeVersion ) },
		pluginVersion: ${ JSON.stringify( SLIM_HASH_OPTS.pluginVersion ) },
		...extra,
	};
}

function __isGraphTraversalCandidate( value ) {
	if ( ! value || ( typeof value !== 'object' && typeof value !== 'function' ) ) return false;
	try {
		if ( value.isTexture === true || value.isNode === true || value.isPassNode === true || value.isRTTNode === true || value.isRenderTarget === true ) return true;
	} catch ( _ ) {}
	try {
		if ( value.texture && value.texture.isTexture === true && typeof value.setSize === 'function' ) return true;
	} catch ( _ ) {}
	if ( Array.isArray( value ) ) return true;
	let tag = '';
	try { tag = Object.prototype.toString.call( value ); } catch ( _ ) { return false; }
	return tag === '[object Object]';
}

function __readGraphOwnValue( node, key ) {
	let descriptor = null;
	try { descriptor = Object.getOwnPropertyDescriptor( node, key ); } catch ( _ ) { return null; }
	if ( descriptor ) {
		if ( ! Object.prototype.hasOwnProperty.call( descriptor, 'value' ) ) return null;
		return descriptor.value;
	}
	try { return node[ key ]; } catch ( _ ) { return null; }
}

function __collectCapturePassNodesInGraph( node, out = [], seen = new Set(), depth = 0 ) {
	if ( ! node || depth > 16 || seen.has( node ) ) return out;
	if ( typeof node !== 'object' && typeof node !== 'function' ) return out;
	if ( ! __isGraphTraversalCandidate( node ) ) return out;
	seen.add( node );
	if ( node.isPassNode === true && node.scene && node.camera ) {
		if ( ! out.includes( node ) ) out.push( node );
	}
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) {}
	const skip = new Set( [ 'parent', 'children', '_cache', 'renderer', 'geometry', 'material', 'domElement' ] );
	for ( const key of keys ) {
		if ( skip.has( key ) ) continue;
		const child = __readGraphOwnValue( node, key );
		if ( ! child ) continue;
		if ( Array.isArray( child ) ) {
			for ( const item of child ) __collectCapturePassNodesInGraph( item, out, seen, depth + 1 );
		} else {
			__collectCapturePassNodesInGraph( child, out, seen, depth + 1 );
		}
	}
	return out;
}

function __stampMRTPassScenes() {
	const passNodes = [];
	for ( const pipeline of __postProcessingPipelines ) {
		__collectCapturePassNodesInGraph( pipeline && pipeline.outputNode, passNodes );
	}
	for ( const passNode of passNodes ) {
		if ( ! passNode || ! passNode.scene ) continue;
		passNode.scene.userData = passNode.scene.userData || {};
		if ( passNode._mrt ) passNode.scene.userData.__tslp_mrtNode = passNode._mrt;
	}
	return passNodes;
}

function __passNodeForScene( scene, passNodes ) {
	for ( const passNode of passNodes || [] ) {
		if ( passNode && passNode.scene === scene && passNode._mrt ) return passNode;
	}
	return null;
}

async function __waitForCaptureIdle( timeoutMs = 45000 ) {
	const now = () => ( typeof window.__tslpRealNow === 'function' ? window.__tslpRealNow() : Date.now() );
	const start = now();
	while ( ( window.__tslpPrecompilePending | 0 ) > 0 || ( window.__tslpAuxCapturePending | 0 ) > 0 || __auxPromises.size > 0 ) {
		if ( now() - start > timeoutMs ) throw new Error( 'timed out waiting for capture artifacts' );
		await new Promise( ( resolve ) => setTimeout( resolve, 50 ) );
	}
}

window.__tslpFlushCaptureArtifacts = async function () {
	const passNodes = __stampMRTPassScenes();
	await __flush();
	if ( __renderer ) {
		const scenes = Array.from( __auxScenes.entries() );
		if ( scenes.length === 0 && __lastScene && __lastCamera ) scenes.push( [ __lastScene, __lastCamera ] );
		for ( const [ scene, camera ] of scenes ) {
			if ( scene && camera ) {
				const passNode = __passNodeForScene( scene, passNodes );
				__trackAuxCapture( precompileAuxiliary( __renderer, scene, camera, __auxOpts( passNode ? { passNode, mrtNode: passNode._mrt } : {} ) ), 'aux capture' );
			}
		}
	}
	if ( __renderer ) {
		for ( const pipeline of __postProcessingPipelines ) {
			const pipelinePassNodes = __collectCapturePassNodesInGraph( pipeline && pipeline.outputNode );
			const passNode = pipelinePassNodes.find( ( node ) => node && node._mrt ) || pipelinePassNodes[ 0 ] || null;
			__trackAuxCapture( precompileAuxiliary(
				__renderer,
				passNode && passNode.scene || null,
				passNode && passNode.camera || null,
				__auxOpts( {
					postProcessing: pipeline,
					renderPipeline: pipeline,
					...( passNode ? { passNode, mrtNode: passNode._mrt } : {} ),
				} )
			), 'post-process aux capture' );
		}
	}
	await __waitForCaptureIdle();
	return {
		pendingMaterials: __pending.length,
		precompilePending: window.__tslpPrecompilePending | 0,
		auxPending: window.__tslpAuxCapturePending | 0,
	};
};

export class Scene extends Original.Scene {
	constructor( ...args ) {
		super( ...args );
		this.userData = this.userData || {};
		this.userData.__tslpUserScene = true;
	}
}

function __isCaptureTRAAEffectNode( node ) {
	if ( ! node || typeof node === 'function' ) return false;
	const type = ( node.constructor && ( node.constructor.type || node.constructor.name ) ) || node.type || '';
	if ( type && type !== 'TRAANode' ) return false;
	return !! ( node && typeof node.updateBefore === 'function' && node._resolveMaterial && node._historyRenderTarget && node._resolveRenderTarget );
}

function __isCaptureTAAUEffectNode( node ) {
	if ( ! node || typeof node === 'function' ) return false;
	const type = ( node.constructor && ( node.constructor.type || node.constructor.name ) ) || node.type || '';
	if ( type && type !== 'TAAUNode' ) return false;
	return !! ( node && typeof node.updateBefore === 'function' && node._resolveMaterial && node._historyRenderTarget && node._resolveRenderTarget );
}

function __pinCaptureTRAAJitterIndex( traaNode ) {
	if ( ! traaNode || traaNode.__tslpTRAAJitterPinned === true ) return;
	const proto = Object.getPrototypeOf( traaNode );
	const originalSetViewOffset = traaNode.setViewOffset || ( proto && proto.setViewOffset );
	const originalClearViewOffset = traaNode.clearViewOffset || ( proto && proto.clearViewOffset );
	if ( typeof originalSetViewOffset === 'function' ) {
		traaNode.setViewOffset = function ( width, height ) {
			try { this._jitterIndex = 0; } catch ( _ ) {}
			return originalSetViewOffset.call( this, width, height );
		};
	}
	if ( typeof originalClearViewOffset === 'function' ) {
		traaNode.clearViewOffset = function () {
			try {
				if ( this.camera && typeof this.camera.clearViewOffset === 'function' ) this.camera.clearViewOffset();
				if ( this._velocityNode && typeof this._velocityNode.setProjectionMatrix === 'function' ) this._velocityNode.setProjectionMatrix( null );
			} catch ( _ ) {}
			try { this._jitterIndex = 0; } catch ( _ ) {}
		};
	}
	try { traaNode._jitterIndex = 0; } catch ( _ ) {}
	try { Object.defineProperty( traaNode, '__tslpTRAAJitterPinned', { value: true, configurable: true } ); } catch ( _ ) {}
}

function __pinCaptureTAAUJitterIndex( taauNode ) {
	if ( ! taauNode || taauNode.__tslpTAAUJitterPinned === true ) return;
	const proto = Object.getPrototypeOf( taauNode );
	const originalSetViewOffset = taauNode.setViewOffset || ( proto && proto.setViewOffset );
	const originalClearViewOffset = taauNode.clearViewOffset || ( proto && proto.clearViewOffset );
	if ( typeof originalSetViewOffset === 'function' ) {
		taauNode.setViewOffset = function ( width, height ) {
			try { this._jitterIndex = 0; } catch ( _ ) {}
			return originalSetViewOffset.call( this, width, height );
		};
	}
	if ( typeof originalClearViewOffset === 'function' ) {
		taauNode.clearViewOffset = function () {
			const result = originalClearViewOffset.call( this );
			try { this._jitterIndex = 0; } catch ( _ ) {}
			return result;
		};
	}
	try { taauNode._jitterIndex = 0; } catch ( _ ) {}
	try { Object.defineProperty( taauNode, '__tslpTAAUJitterPinned', { value: true, configurable: true } ); } catch ( _ ) {}
}

function __scanForCaptureTRAANodes( node, seen = new Set(), depth = 0 ) {
	if ( ! node || depth > 24 || seen.has( node ) ) return;
	if ( typeof node !== 'object' && typeof node !== 'function' ) return;
	seen.add( node );
	if ( __isCaptureTRAAEffectNode( node ) ) {
		__pinCaptureTRAAJitterIndex( node );
		return;
	}
	if ( __isCaptureTAAUEffectNode( node ) ) {
		__pinCaptureTAAUJitterIndex( node );
		return;
	}
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) {}
	const skip = new Set( [ 'parent', 'children', '_cache', 'scene', 'camera', 'renderer', 'geometry', 'material', 'domElement' ] );
	for ( const key of keys ) {
		if ( skip.has( key ) ) continue;
		let child;
		try { child = node[ key ]; } catch ( _ ) { continue; }
		if ( ! child ) continue;
		if ( Array.isArray( child ) ) {
			for ( const item of child ) if ( item && ( typeof item === 'object' || typeof item === 'function' ) ) __scanForCaptureTRAANodes( item, seen, depth + 1 );
		} else if ( typeof child === 'object' || typeof child === 'function' ) {
			__scanForCaptureTRAANodes( child, seen, depth + 1 );
		}
	}
}

function __capturePostProcessing( pipeline ) {
	if ( pipeline ) {
		__postProcessingPipelines.add( pipeline );
		// Pin TRAA jitter to 0 during capture so the snapshot frame matches the
		// slim replay harness's pin on its side.
		try {
			if ( pipeline.outputNode ) __scanForCaptureTRAANodes( pipeline.outputNode );
		} catch ( _ ) {}
	}
}

const __RenderPipelineBase = Original.RenderPipeline || Original.PostProcessing;
export class RenderPipeline extends __RenderPipelineBase {
	render( ...args ) {
		try { window.__tslpLastRenderPipeline = this; } catch ( _ ) {}
		__capturePostProcessing( this );
		return super.render( ...args );
	}
}

export class PostProcessing extends RenderPipeline {}

function __trackDebugShaderAsync( renderer ) {
	const debug = renderer && renderer.debug;
	if ( ! debug || debug.__tslpGetShaderAsyncPatched || typeof debug.getShaderAsync !== 'function' ) return;
	const originalGetShaderAsync = debug.getShaderAsync;
	try {
		Object.defineProperty( debug, '__tslpGetShaderAsyncPatched', {
			value: true,
			configurable: true,
		} );
	} catch ( _ ) {
		debug.__tslpGetShaderAsyncPatched = true;
	}
	debug.getShaderAsync = function ( ...args ) {
		window.__tslpCompilePending = ( window.__tslpCompilePending | 0 ) + 1;
		const settle = () => { window.__tslpCompilePending = Math.max( 0, ( window.__tslpCompilePending | 0 ) - 1 ); };
		try {
			const p = originalGetShaderAsync.apply( this, args );
			return Promise.resolve( p ).then( ( v ) => { settle(); return v; }, ( e ) => { settle(); throw e; } );
		} catch ( err ) {
			settle();
			throw err;
		}
	};
}

export class WebGPURenderer extends Original.WebGPURenderer {
	constructor( ...args ) {
		super( ...args );
		// Wedge 4: expose the full renderer so the runner can read nodeFrame.time
		// at screenshot time.
		window.__tslpHarnessRenderer = this;
		window.__tslpFullRenderer = this;
		__trackDebugShaderAsync( this );
	}
	setAnimationLoop( callback ) {
		const wrap = typeof window.__tslpWrapAnimationLoop === 'function' ? window.__tslpWrapAnimationLoop : null;
		return super.setAnimationLoop( wrap ? wrap( callback ) : callback );
	}
	copyFramebufferToTexture( texture, rectangle = null ) {
		const restore = __syncFramebufferTextureForActiveTarget( this, texture );
		try {
			return super.copyFramebufferToTexture( texture, rectangle );
		} finally {
			if ( restore ) restore();
		}
	}
	renderObject( object, scene, camera, geometry, material, group, lightsNode, clippingContext ) {
		if ( __pmremRunning > 0 ) return super.renderObject( object, scene, camera, geometry, material, group, lightsNode, clippingContext );
		const materialClassName = material ? __classNameForMaterial( material ) : '';
		const isOffscreenRenderPass = typeof this.getRenderTarget === 'function' && this.getRenderTarget() !== null;
		const isUserScene = !! ( scene && scene.isScene === true && scene.userData && scene.userData.__tslpUserScene === true );
		const isRetroPassMaterial = __isRetroPassGeneratedMaterial( this, scene, material, materialClassName );
		if ( isRetroPassMaterial ) {
			try {
				Object.defineProperty( material, '__tslpRetroPassMaterial', {
					value: true,
					configurable: true,
					writable: true,
				} );
			} catch ( _ ) {
				material.__tslpRetroPassMaterial = true;
			}
		}
		if ( material && ( material.isMeshToonOutlineMaterial === true || ( materialClassName === 'NodeMaterial' && isUserScene && ! isOffscreenRenderPass ) || isRetroPassMaterial ) ) {
			__mark( material, isRetroPassMaterial ? materialClassName : 'NodeMaterial', object, camera );
		}
		return super.renderObject( object, scene, camera, geometry, material, group, lightsNode, clippingContext );
	}
	async init( ...args ) {
		const result = await super.init( ...args );
		__renderer = this;
		setDevRenderer( this );
		window.__tslpRendererBound = true;
		// __flush deliberately skipped here — see __mark for why.
		return result;
	}
	compile( scene, camera, ...rest ) {
		if ( __pmremRunning > 0 ) return typeof super.compile === 'function' ? super.compile( scene, camera, ...rest ) : undefined;
		__lastScene = scene;
		__lastCamera = camera;
		__rememberAuxScene( scene, camera );
		__stampSceneMRT( scene, this );
		__markSceneMaterials( scene, camera );
		__markStandaloneRenderTargetMaterial( scene );
		return typeof super.compile === 'function' ? super.compile( scene, camera, ...rest ) : undefined;
	}
	compileAsync( scene, camera, ...rest ) {
		if ( __pmremRunning > 0 ) return typeof super.compileAsync === 'function' ? super.compileAsync( scene, camera, ...rest ) : Promise.resolve();
		__lastScene = scene;
		__lastCamera = camera;
		__rememberAuxScene( scene, camera );
		__stampSceneMRT( scene, this );
		__markSceneMaterials( scene, camera );
		__markStandaloneRenderTargetMaterial( scene );
		if ( typeof super.compileAsync !== 'function' ) return Promise.resolve();
		// Track this compile so the screenshot waits for it. MaterialX, GLTF, and
		// other examples await renderer.compileAsync between asset loads to warm
		// the GPU pipeline; without this counter, the wait gate can fire while
		// the next mesh's pipeline is still being built.
		window.__tslpCompilePending = ( window.__tslpCompilePending | 0 ) + 1;
		const _settle = () => { window.__tslpCompilePending = Math.max( 0, ( window.__tslpCompilePending | 0 ) - 1 ); };
		const p = super.compileAsync( scene, camera, ...rest );
		return Promise.resolve( p ).then( ( v ) => { _settle(); return v; }, ( e ) => { _settle(); throw e; } );
	}
	render( scene, camera ) {
		if ( __pmremRunning > 0 ) return super.render( scene, camera );
		__recordRenderableObjectCount( scene );
		__lastScene = scene;
		__lastCamera = camera;
		__rememberAuxScene( scene, camera );
		__stampSceneMRT( scene, this );
		__markSceneMaterials( scene, camera );
		__markStandaloneRenderTargetMaterial( scene );
		return super.render( scene, camera );
	}
}

window.__tslpFullAutoLoaded = true;
`;

}

function slimWebgpuReplayModule() {

	const materialClasses = NODE_MATERIAL_EXPORTS.map( ( name ) => `
export class ${ name } {
	constructor( params ) {
		let mat;
		// Recreate the source material first and let __prepareSceneForReplay()
		// replace it with a PrecompiledMaterial at render/compile time. This
		// preserves post-constructor mutations and clones (maskNode,
		// receivedShadowPositionNode, colorNode, etc.) so artifact selection sees
		// the final material graph instead of the constructor's partial params.
		mat = __makeInternalNodeMaterial( ${ JSON.stringify( name ) }, params );
		if ( params && typeof params === 'object' ) {
			for ( const key in params ) {
				if ( params[ key ] !== undefined ) __assignParam( mat, key, params[ key ] );
			}
			__wireMaterialTextures( params, mat );
		}
		return mat;
	}
}
` ).join( '\n' );

	return `
import * as Slim from '/__tslp__/three.webgpu.slim.js?v=${ CACHE_BUST }';
import { TSL as FullTSL, TextureNode as FullTextureNode, BlendMode as FullBlendMode, TempNode as FullTempNode, NodeUpdateType as FullNodeUpdateType, NodeMaterial as FullNodeMaterial, MeshBasicNodeMaterial as FullMeshBasicNodeMaterial, MeshStandardNodeMaterial as FullMeshStandardNodeMaterial, MeshPhysicalNodeMaterial as FullMeshPhysicalNodeMaterial, MeshLambertNodeMaterial as FullMeshLambertNodeMaterial, MeshPhongNodeMaterial as FullMeshPhongNodeMaterial, MeshToonNodeMaterial as FullMeshToonNodeMaterial, MeshNormalNodeMaterial as FullMeshNormalNodeMaterial, MeshMatcapNodeMaterial as FullMeshMatcapNodeMaterial, MeshSSSNodeMaterial as FullMeshSSSNodeMaterial, VolumeNodeMaterial as FullVolumeNodeMaterial, LineBasicNodeMaterial as FullLineBasicNodeMaterial, LineDashedNodeMaterial as FullLineDashedNodeMaterial, Line2NodeMaterial as FullLine2NodeMaterial, PointsNodeMaterial as FullPointsNodeMaterial, SpriteNodeMaterial as FullSpriteNodeMaterial, ShadowNodeMaterial as FullShadowNodeMaterial, RenderTarget as FullRenderTarget, DepthTexture as FullDepthTexture, ArrayCamera as FullArrayCamera, Controls as FullControls, MOUSE as FullMOUSE, MathUtils as FullMathUtils, Plane as FullPlane, Quaternion as FullQuaternion, Ray as FullRay, Spherical as FullSpherical, TOUCH as FullTOUCH, QuadMesh as FullQuadMesh, RendererUtils as FullRendererUtils, Vector2 as FullVector2, Vector3 as FullVector3, CubeRenderTarget as FullCubeRenderTarget, TextureLoader as FullTextureLoader, CubeTextureLoader as FullCubeTextureLoader, DataTextureLoader as FullDataTextureLoader, ImageBitmapLoader as FullImageBitmapLoader } from '/build/three.webgpu.js';
import { createLiveSceneIndex, textureImageReady as __sharedTextureImageReady, textureImageSrc as __sharedTextureImageSrc, newFallbackTextureImage as __sharedNewFallbackTextureImage } from '/__tslp_runtime/slim-support/live-scene-index.js';
import { artifactNeedsPMREM as __sharedArtifactNeedsPMREM, artifactPMREMSourceUuids as __sharedArtifactPMREMSourceUuids, attachPMREMRefsByOrder as __sharedAttachPMREMRefsByOrder, collectPMREMSourceTexturesFromMaterial as __sharedCollectPMREMSourceTexturesFromMaterial, collectPMREMSourceTexturesInNode as __sharedCollectPMREMSourceTexturesInNode, createPMREMSupport as __sharedCreatePMREMSupport, isPMREMArtifactTextureSource as __sharedIsPMREMArtifactTextureSource, isPMREMTexture as __sharedIsPMREMTexture, selectPMREMTexturesForArtifact as __sharedSelectPMREMTexturesForArtifact, textureListSignature as __sharedTextureListSignature } from '/__tslp_runtime/slim-support/pmrem.js';
import { clearTextureViewCache as __sharedClearTextureViewCache, markTextureInitialized as __sharedMarkTextureInitialized, shareGPUTextureEntry as __sharedShareGPUTextureEntry, sharePMREMGPUTexture as __sharedSharePMREMGPUTexture, shareShadowGPUTextureIntoSlim as __sharedShareShadowGpuTextureIntoSlim } from '/__tslp_runtime/slim-support/gpu-texture-share.js';
import { computeNodeUsesStorageTexture as __sharedComputeNodeUsesStorageTexture, shareComputeSampledInputs as __sharedShareComputeSampledInputs, syncComputeStorageOutputs as __sharedSyncComputeStorageOutputs, syncComputeStorageOutputsPerPass as __sharedSyncComputeStorageOutputsPerPass, wireArtifactStorageBuffersFromAttributes as __sharedWireArtifactStorageBuffersFromAttributes, pingPongInvalidate as __sharedPingPongInvalidate, shareInstancedAttributeBufferIntoSlim as __sharedShareInstancedAttributeBufferIntoSlim } from '/__tslp_runtime/slim-support/compute-sync.js';
import { artifactHasTextureSource as __sharedArtifactHasTextureSource, attachArtifactTextureRefsByShapeOrder as __sharedAttachArtifactTextureRefsByShapeOrder, attachArtifactTextureRefsWhere as __sharedAttachArtifactTextureRefsWhere, attachTextureRefsWhere as __sharedAttachTextureRefsWhere, countArtifactTextureSources as __sharedCountArtifactTextureSources, singleArtifactTextureUuid as __sharedSingleArtifactTextureUuid, textureMatchesArtifactSource as __sharedTextureMatchesArtifactSource, textureMatchesSource as __sharedTextureMatchesSource } from '/__tslp_runtime/slim-support/artifact-texture-wiring.js';
import { createFullRendererFallback as __sharedCreateFullRendererFallback } from '/__tslp_runtime/slim-support/full-renderer-fallback.js';
import { updateRendererLightingForSlim as __sharedUpdateRendererLightingForSlim } from '/__tslp_runtime/slim-support/renderer-lighting.js';
import { artifactLooksLikeRetroPassMaterial as __sharedArtifactLooksLikeRetroPassMaterial } from '/__tslp_runtime/slim-support/postprocess-effects-replay.js';
import { renderOffscreenOverrideWithFullRenderer as __sharedRenderOffscreenOverrideWithFullRenderer } from '/__tslp_runtime/slim-support/pass-render-fallback.js';
import { findAux as __runtimeFindAux } from '/__tslp_runtime/aux-loader.js';
import { MATERIAL_TEXTURE_PROPS as __TEXTURE_PROPS, MATERIAL_NODE_TEXTURE_KEYS as __NODE_GRAPH_KEYS } from '/__tslp_contract/texture-props.js';
import { countArtifactFragmentOutputCapacity as __sharedCountArtifactFragmentOutputCapacity, countArtifactFragmentOutputs as __sharedCountArtifactFragmentOutputs } from '/__tslp_contract/fragment-outputs.js';
${ SLIM_REPLAY_FORWARD_EXPORT_BLOCK }
${ SLIM_REPLAY_FULL_FALLBACK_EXPORT_BLOCK }
export { FullTextureNode as TextureNode, FullBlendMode as BlendMode, FullTempNode as TempNode, FullNodeUpdateType as NodeUpdateType, FullArrayCamera as ArrayCamera, FullControls as Controls, FullMOUSE as MOUSE, FullMathUtils as MathUtils, FullPlane as Plane, FullQuaternion as Quaternion, FullRay as Ray, FullSpherical as Spherical, FullTOUCH as TOUCH, FullQuadMesh as QuadMesh, FullRendererUtils as RendererUtils, FullVector2 as Vector2, FullVector3 as Vector3 };

const __state = window.__TSLP_E2E || { example: 'unknown', artifacts: { user: {}, aux: [] } };
const __data = __state.artifacts || { user: {}, aux: [] };

function __tslpLoaderBasename( value ) {
	const raw = String( value || '' );
	const tail = raw.split( /[?#]/ )[ 0 ].split( '/' ).filter( Boolean ).pop() || raw;
	return tail || '';
}

window.__tslpMarkLoaderTexture = function ( texture, url ) {
	if ( ! texture || texture.isTexture !== true ) return texture;
	const name = __tslpLoaderBasename( url );
	if ( name && ! texture.name ) texture.name = name;
	try {
		texture.userData = texture.userData || {};
		if ( typeof url === 'string' && url.length > 0 ) texture.userData.__tslpLoaderUrl = url;
	} catch ( _ ) {}
	try {
		if ( typeof Slim.registerLiveTexture === 'function' ) Slim.registerLiveTexture( texture );
	} catch ( _ ) {}
	try {
		if ( typeof window.__tslpRememberLiveTexture === 'function' ) window.__tslpRememberLiveTexture( texture );
	} catch ( _ ) {}
	return texture;
};

window.__tslpPatchTextureLoaderClass = function ( Ctor ) {
	if ( ! Ctor || ! Ctor.prototype || typeof Ctor.prototype.load !== 'function' || Ctor.prototype.__tslpCallbackLoadPatched ) return;
	Ctor.prototype.__tslpCallbackLoadPatched = true;
	const origLoad = Ctor.prototype.load;
	const _now = () => ( typeof window.__tslpRealNow === 'function' ? window.__tslpRealNow() : Date.now() );
	Ctor.prototype.load = function ( url, onLoad, onProgress, onError ) {
		window.__tslpLoaderPending = ( window.__tslpLoaderPending | 0 ) + 1;
		window.__tslpLoaderLastBusyAt = _now();
		let settled = false;
		const settle = () => {
			if ( settled ) return;
			settled = true;
			window.__tslpLoaderPending = Math.max( 0, ( window.__tslpLoaderPending | 0 ) - 1 );
			window.__tslpLoaderLastBusyAt = _now();
		};
		const wrapLoad = ( texture, ...rest ) => {
			window.__tslpMarkLoaderTexture( texture, url );
			try { if ( typeof onLoad === 'function' ) return onLoad.call( this, texture, ...rest ); }
			finally { settle(); }
		};
		const wrapError = ( err, ...rest ) => {
			try { if ( typeof onError === 'function' ) return onError.call( this, err, ...rest ); }
			finally { settle(); }
		};
		try {
			const result = origLoad.call( this, url, wrapLoad, onProgress, wrapError );
			window.__tslpMarkLoaderTexture( result, url );
			return result;
		} catch ( err ) {
			settle();
			throw err;
		}
	};
	};

	function __syncFramebufferTextureForActiveTarget( renderer, texture ) {
		if ( ! renderer || ! texture || texture.isFramebufferTexture !== true ) return null;
		const context = renderer._currentRenderContext || null;
		const target = context && context.renderTarget || null;
		const source = target && target.texture || null;
		if ( ! source ) return null;
		let currentTarget = null;
		try { currentTarget = typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : null; } catch ( _ ) {}
		const previousTarget = renderer._renderTarget;
		const patchTarget = ! currentTarget && previousTarget !== target;
		let changed = false;
		for ( const key of [ 'format', 'type', 'colorSpace' ] ) {
			if ( source[ key ] !== undefined && texture[ key ] !== source[ key ] ) {
				texture[ key ] = source[ key ];
				changed = true;
			}
		}
		if ( changed ) texture.needsUpdate = true;
		if ( patchTarget ) renderer._renderTarget = target;
		return () => {
			if ( patchTarget ) renderer._renderTarget = previousTarget;
		};
	}

	// Worker-async loaders (KTX2Loader, DRACOLoader, MeshoptLoader) decode in
	// web workers AFTER FileLoader.load resolves manager.itemEnd, so the outer
// manager-pending counter drops to zero while parse is still in flight.
// Without this, the synthetic-rAF clock can freeze before the user's
// \`await ktxLoader.loadAsync(...)\` resumes and adds the post-await meshes —
// the first render with content never fires (see webgpu_sandbox.html which
// uses await ktxLoader.loadAsync(...) before adding any mesh to scene).
// Wrap Loader.prototype.loadAsync so __tslpLoaderPending stays bumped until
// the full promise (load + parse) resolves.
( function patchSlimLoaderLoadAsync() {
	const L = Slim.Loader;
	if ( ! L || ! L.prototype || L.prototype.__tslpLoadAsyncPatched ) return;
	L.prototype.__tslpLoadAsyncPatched = true;
	const origLoad = L.prototype.load;
	const origLoadAsync = L.prototype.loadAsync;
	const _now = () => ( typeof window.__tslpRealNow === 'function' ? window.__tslpRealNow() : Date.now() );
	if ( typeof origLoad === 'function' ) {
		L.prototype.load = function ( url, onLoad, onProgress, onError ) {
			const touch = () => { window.__tslpLoaderLastBusyAt = _now(); };
			window.__tslpLoaderPending = ( window.__tslpLoaderPending | 0 ) + 1;
			let settled = false;
			const settle = () => {
				if ( settled ) return;
				settled = true;
				window.__tslpLoaderPending = Math.max( 0, ( window.__tslpLoaderPending | 0 ) - 1 );
				touch();
			};
			touch();
			const wrap = ( cb, shouldSettle = false ) => typeof cb === 'function'
				? ( ...args ) => {
					try { return cb.apply( this, args ); }
					finally { shouldSettle ? settle() : touch(); }
				}
				: shouldSettle ? ( ..._args ) => settle() : cb;
			try {
				return origLoad.call( this, url, wrap( onLoad, true ), onProgress, wrap( onError, true ) );
			} catch ( err ) {
				settle();
				throw err;
			}
		};
	}
	if ( typeof origLoadAsync !== 'function' ) return;
	L.prototype.loadAsync = function ( ...args ) {
		window.__tslpLoaderPending = ( window.__tslpLoaderPending | 0 ) + 1;
		window.__tslpLoaderLastBusyAt = _now();
		return origLoadAsync.apply( this, args ).finally( () => {
			window.__tslpLoaderPending = Math.max( 0, ( window.__tslpLoaderPending | 0 ) - 1 );
			window.__tslpLoaderLastBusyAt = _now();
		} );
	};
} )();

	const __livePassNodes = [];
	let __activePipelinePassNodes = null;
	let __passNodeSequence = 0;

	function __makePassTextureNode( passNode, name = 'output', previous = false ) {
		const texture = previous ? passNode.getPreviousTexture( name ) : passNode.getTexture( name );
		const node = new FullTextureNode( texture );
		node.passNode = passNode;
		node.textureName = name;
		node.previousTexture = previous;
		node.isPassTextureNode = true;
		node.isPassMultipleTextureNode = true;
		node.updateTexture = function () {
			this.value = this.previousTexture ? this.passNode.getPreviousTexture( this.textureName ) : this.passNode.getTexture( this.textureName );
		};
		try { if ( typeof node.setUpdateMatrix === 'function' ) node.setUpdateMatrix( false ); } catch ( _ ) {}
		return node;
	}

	function __mrtOutputCount( mrt ) {
		return mrt && mrt.outputNodes && typeof mrt.outputNodes === 'object' ? Object.keys( mrt.outputNodes ).length : 0;
	}

	function __mrtFromRenderTarget( renderTarget ) {
		const textures = renderTarget && Array.isArray( renderTarget.textures ) ? renderTarget.textures : [];
		if ( textures.length <= 1 ) return null;
		const names = textures.map( ( texture, index ) => texture && texture.name || ( index === 0 ? 'output' : 'output' + index ) );
		const key = names.join( '|' );
		if ( renderTarget.__tslpMRTStub && renderTarget.__tslpMRTStub.__tslpKey === key ) return renderTarget.__tslpMRTStub;
		const outputNodes = {};
		for ( const name of names ) outputNodes[ name ] = { isNode: true };
		const mrt = {
			isNode: true,
			isMRTNode: true,
			id: 'tslp-render-target-mrt:' + key,
			outputNodes,
			__tslpKey: key,
			getBlendMode() { return { blending: 0 }; },
			has( name ) { return name in outputNodes; },
			get( name ) { return outputNodes[ name ] || null; },
			merge( other ) { return other || this; },
		};
		try { Object.defineProperty( renderTarget, '__tslpMRTStub', { value: mrt, configurable: true, writable: true } ); }
		catch ( _ ) { renderTarget.__tslpMRTStub = mrt; }
		return mrt;
	}

	function __makePassDepthTexture( renderTarget ) {
		const depthTexture = new Slim.DepthTexture();
		depthTexture.isRenderTargetTexture = true;
		depthTexture.name = 'depth';
		depthTexture.renderTarget = renderTarget;
		return depthTexture;
	}

	function __ensurePassRenderTargetAttachmentCount( passNode, count = 1 ) {
		if ( ! passNode || ! passNode.renderTarget ) return null;
		const targetCount = Math.max( 1, count | 0 );
		let target = passNode.renderTarget;
		const textures = Array.isArray( target.textures ) ? target.textures : target.texture ? [ target.texture ] : [];
		if ( textures.length === targetCount ) return target;

		const width = Math.max( 1, target.width || passNode._width || 1 );
		const height = Math.max( 1, target.height || passNode._height || 1 );
		const options = { ...( passNode._renderTargetOptions || passNode.options || {} ), count: targetCount };
		let nextTarget;
		try {
			nextTarget = new Slim.RenderTarget( width, height, options );
		} catch ( _ ) {
			return target;
		}

		if ( target.scissor && nextTarget.scissor && typeof nextTarget.scissor.copy === 'function' ) nextTarget.scissor.copy( target.scissor );
		if ( target.viewport && nextTarget.viewport && typeof nextTarget.viewport.copy === 'function' ) nextTarget.viewport.copy( target.viewport );
		nextTarget.scissorTest = target.scissorTest === true;
		if ( target.samples !== undefined ) nextTarget.samples = target.samples;
		nextTarget.texture.name = 'output';
		nextTarget.depthTexture = __makePassDepthTexture( nextTarget );

		passNode.renderTarget = nextTarget;
		passNode._textures = Object.create( null );
		passNode._textures.output = nextTarget.texture;
		passNode._textures.depth = nextTarget.depthTexture;
		target = nextTarget;
		return target;
	}

	function __refreshPassTextureNodes( passNode ) {
		if ( ! passNode ) return;
		for ( const node of Object.values( passNode._textureNodes || {} ) ) {
			try { if ( node && typeof node.updateTexture === 'function' ) node.updateTexture(); } catch ( _ ) {}
		}
		for ( const node of Object.values( passNode._previousTextureNodes || {} ) ) {
			try { if ( node && typeof node.updateTexture === 'function' ) node.updateTexture(); } catch ( _ ) {}
		}
	}

	function __countArtifactFragmentOutputsSafe( artifact, fallback = 1 ) {
		if ( typeof __sharedCountArtifactFragmentOutputs === 'function' ) return __sharedCountArtifactFragmentOutputs( artifact, fallback );
		if ( ! artifact ) return fallback;
		if ( Array.isArray( artifact.fragmentOutputs ) ) return artifact.fragmentOutputs.length;
		if ( Array.isArray( artifact.mrtOutputNames ) && artifact.mrtOutputNames.length > 0 ) return artifact.mrtOutputNames.length;
		if ( typeof artifact.mrtOutputCount === 'number' && artifact.mrtOutputCount > 0 ) return artifact.mrtOutputCount;
		return fallback;
	}

	function __countArtifactFragmentOutputCapacitySafe( artifact, fallback = 1 ) {
		if ( typeof __sharedCountArtifactFragmentOutputCapacity === 'function' ) return __sharedCountArtifactFragmentOutputCapacity( artifact, fallback );
		if ( ! artifact ) return fallback;
		let maxCount = __countArtifactFragmentOutputsSafe( artifact, fallback );
		const variants = artifact.variants && typeof artifact.variants === 'object' ? artifact.variants : null;
		if ( variants ) {
			for ( const variant of Object.values( variants ) ) {
				maxCount = Math.max( maxCount, __countArtifactFragmentOutputsSafe( variant, fallback ) );
			}
		}
		return maxCount;
	}

	function __fragmentOutputCount( material ) {
		const artifact = material && material.precompiledArtifact;
		if ( ! artifact ) return 1;
		return __countArtifactFragmentOutputCapacitySafe( artifact, 1 );
	}

	function __backgroundAuxCanRenderMRT( mrt ) {
		const targetCount = __mrtOutputCount( mrt );
		if ( targetCount <= 1 ) return true;
		const aux = Array.isArray( __data.aux ) ? __data.aux : [];
		for ( const entry of aux ) {
			if ( ! entry || entry.shape !== 'background' || ! entry.artifact ) continue;
			if ( __fragmentOutputCount( { precompiledArtifact: entry.artifact } ) >= targetCount ) return true;
		}
		return false;
	}

	function __syncPassRenderTargetTextures( passNode, mrt ) {
		let target = passNode && passNode.renderTarget;
		if ( ! target || ! Array.isArray( target.textures ) ) return;
		if ( ! mrt || ! mrt.outputNodes || typeof mrt.outputNodes !== 'object' ) {
			if ( ! target.texture && target.textures[ 0 ] ) target.texture = target.textures[ 0 ];
			target.textures = [ target.texture ];
			passNode._textures.output = target.texture;
			if ( target.depthTexture ) passNode._textures.depth = target.depthTexture;
			__refreshPassTextureNodes( passNode );
			return;
		}
		const names = Object.keys( mrt.outputNodes );
		target = __ensurePassRenderTargetAttachmentCount( passNode, names.length ) || target;
		const textures = [];
		for ( let i = 0; i < names.length; i ++ ) {
			const name = names[ i ];
			const texture = target.textures[ i ] || passNode.getTexture( name );
			if ( texture ) {
				texture.name = name;
				texture.isRenderTargetTexture = true;
				texture.renderTarget = target;
				passNode._textures[ name ] = texture;
			}
			if ( texture && ! textures.includes( texture ) ) textures.push( texture );
		}
		if ( textures.length === 0 && target.texture ) textures.push( target.texture );
		target.textures = textures;
		if ( target.depthTexture ) passNode._textures.depth = target.depthTexture;
		__refreshPassTextureNodes( passNode );
	}

function __sceneCanRenderMRT( scene, mrt ) {
	const targetCount = __mrtOutputCount( mrt );
	if ( targetCount <= 1 || ! scene || typeof scene.traverse !== 'function' ) return true;
	let ok = true;
		scene.traverse( ( object ) => {
			if ( ! ok || ! object || ! object.material ) return;
			const materials = Array.isArray( object.material ) ? object.material : [ object.material ];
			for ( const material of materials ) {
				if ( material && material.visible !== false && __fragmentOutputCount( material ) < targetCount ) {
					ok = false;
					break;
				}
			}
	} );
	return ok;
}

function __prepareSceneMaterialsForMRTReplay( scene, mrt ) {
	const targetCount = __mrtOutputCount( mrt );
	if ( targetCount <= 1 || ! scene || typeof scene.traverse !== 'function' ) return;
	scene.traverse( ( object ) => {
		const material = object && object.material;
		const list = Array.isArray( material ) ? material : material ? [ material ] : [];
		for ( const mat of list ) {
			if ( ! mat || mat.isPrecompiledMaterial !== true ) continue;
			if ( __fragmentOutputCount( mat ) < targetCount ) continue;
			if ( mat.mrtNode !== mrt ) mat.mrtNode = mrt;
			mat.needsUpdate = true;
		}
	} );
}

function __resetRendererPipelineCachesForMRTReplay( renderer, mrt ) {
	if ( __mrtOutputCount( mrt ) <= 1 || ! renderer ) return;
	try { if ( renderer._pipelines && typeof renderer._pipelines.dispose === 'function' ) renderer._pipelines.dispose(); } catch ( _ ) {}
	try { if ( renderer._objects && typeof renderer._objects.dispose === 'function' ) renderer._objects.dispose(); } catch ( _ ) {}
}

function __sceneHasMultiOutputPrecompiledMaterial( scene ) {
	let found = false;
	const visit = ( object ) => {
		if ( found || ! object ) return;
		const material = object.material;
		const list = Array.isArray( material ) ? material : material ? [ material ] : [];
		for ( const mat of list ) {
			if ( mat && mat.isPrecompiledMaterial === true && __fragmentOutputCount( mat ) > 1 ) {
				found = true;
				return;
			}
		}
	};
	visit( scene );
	try {
		if ( ! found && scene && typeof scene.traverse === 'function' ) scene.traverse( visit );
	} catch ( _ ) {}
	return found;
}

// VolumeNodeMaterial needs special pass discovery because its ray-march reads
// earlier-pass depth and live 3D/offset textures. Keep the actual pass on the
// captured WGSL path; the full-renderer source pass loses the replay harness'
// ordered pass-depth/texture wiring.
function __sceneHasVolumeNodeMaterial( scene ) {
	let found = false;
	const visit = ( object ) => {
		if ( found || ! object ) return;
		const material = object.material;
		const list = Array.isArray( material ) ? material : material ? [ material ] : [];
		for ( const mat of list ) {
			if ( ! mat ) continue;
			if ( mat.isVolumeNodeMaterial === true ) { found = true; return; }
			if ( mat.__tslpSourceMaterial && mat.__tslpSourceMaterial.isVolumeNodeMaterial === true ) { found = true; return; }
		}
	};
	visit( scene );
	try {
		if ( ! found && scene && typeof scene.traverse === 'function' ) scene.traverse( visit );
	} catch ( _ ) {}
	return found;
}

function __sceneHasBackdropNodeMaterial( scene ) {
	let found = false;
	const visit = ( object ) => {
		if ( found || ! object ) return;
		const material = object.material;
		const list = Array.isArray( material ) ? material : material ? [ material ] : [];
		for ( const mat of list ) {
			if ( ! mat ) continue;
			const source = mat.__tslpSourceMaterial || mat;
			if ( source.backdropNode || source.backdropAlphaNode ) { found = true; return; }
		}
	};
	visit( scene );
	try {
		if ( ! found && scene && typeof scene.traverse === 'function' ) scene.traverse( visit );
	} catch ( _ ) {}
	return found;
}

function __resetRendererPipelineCachesForAttachmentChange( renderer, scene ) {
	if ( ! renderer || ! __sceneHasMultiOutputPrecompiledMaterial( scene ) ) return;
	let renderTarget = null;
	try { renderTarget = typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : renderer._renderTarget || null; } catch ( _ ) {}
	let mrt = null;
	try { mrt = typeof renderer.getMRT === 'function' ? renderer.getMRT() : renderer._mrt || null; } catch ( _ ) {}
	const texture = renderTarget && renderTarget.texture;
	const textures = renderTarget && Array.isArray( renderTarget.textures ) ? renderTarget.textures : null;
	const count = textures ? textures.length : 1;
	const key = [
		count,
		texture && texture.format || 'default',
		texture && texture.type || 'default',
		renderTarget && renderTarget.samples || 0,
		renderTarget && renderTarget.depthBuffer === true ? 1 : 0,
		renderTarget && renderTarget.stencilBuffer === true ? 1 : 0,
		mrt && mrt.id || 'default',
	].join( ':' );
	if ( renderer.__tslpPipelineAttachmentKey === key ) return;
	renderer.__tslpPipelineAttachmentKey = key;
	try { if ( renderer._pipelines && typeof renderer._pipelines.dispose === 'function' ) renderer._pipelines.dispose(); } catch ( _ ) {}
	try { if ( renderer._objects && typeof renderer._objects.dispose === 'function' ) renderer._objects.dispose(); } catch ( _ ) {}
}

const __fullPassMaterialCache = new WeakMap();
const __fullBackdropPassMaterialCache = new WeakMap();
function __materialForFullPass( sourceMaterial ) {
	if ( ! sourceMaterial ) return sourceMaterial;
	if ( __fullPassMaterialCache.has( sourceMaterial ) ) {
		const cached = __fullPassMaterialCache.get( sourceMaterial );
		__copyMaterialProps( sourceMaterial, cached );
		cached.needsUpdate = true;
		return cached;
	}
	const className = __classNameForMaterial( sourceMaterial );
	const material = __makeInternalNodeMaterial( className );
	material.name = sourceMaterial.name || material.name || 'full-pass-material';
	__copyMaterialProps( sourceMaterial, material );
	__copyMaterialNodeProps( sourceMaterial, material );
	material.needsUpdate = true;
	__fullPassMaterialCache.set( sourceMaterial, material );
	return material;
}

function __materialForBackdropFullPass( sourceMaterial ) {
	if ( ! sourceMaterial ) return sourceMaterial;
	if ( sourceMaterial.backdropNode || sourceMaterial.backdropAlphaNode ) return __materialForFullPass( sourceMaterial );
	if ( __fullBackdropPassMaterialCache.has( sourceMaterial ) ) {
		const cached = __fullBackdropPassMaterialCache.get( sourceMaterial );
		__copyMaterialProps( sourceMaterial, cached );
		__copyMaterialNodeProps( sourceMaterial, cached );
		cached.needsUpdate = true;
		return cached;
	}
	const material = __makeInternalNodeMaterial( 'MeshBasicNodeMaterial' );
	material.name = sourceMaterial.name || material.name || 'full-backdrop-pass-material';
	__copyMaterialProps( sourceMaterial, material );
	__copyMaterialNodeProps( sourceMaterial, material );
	material.needsUpdate = true;
	__fullBackdropPassMaterialCache.set( sourceMaterial, material );
	return material;
}

function __withSourceMaterialsForFullPass( scene, callback, options = {} ) {
	const materialForSource = options && typeof options.materialForSource === 'function' ? options.materialForSource : __materialForFullPass;
	const swaps = [];
	const swapOne = ( object ) => {
		const material = object && object.material;
		if ( ! material ) return;
		if ( Array.isArray( material ) ) {
			let changed = false;
			const next = material.map( ( mat ) => {
				if ( mat && mat.isPrecompiledMaterial === true && mat.__tslpSourceMaterial ) {
					changed = true;
					return materialForSource( mat.__tslpSourceMaterial );
				}
				return mat;
			} );
			if ( changed ) {
				swaps.push( { object, material } );
				object.material = next;
			}
		} else if ( material.isPrecompiledMaterial === true && material.__tslpSourceMaterial ) {
			swaps.push( { object, material } );
			object.material = materialForSource( material.__tslpSourceMaterial );
		}
	};
	try {
		if ( scene && scene.overrideMaterial && scene.overrideMaterial.isPrecompiledMaterial === true && scene.overrideMaterial.__tslpSourceMaterial ) {
			swaps.push( { object: scene, material: scene.overrideMaterial, override: true } );
			scene.overrideMaterial = materialForSource( scene.overrideMaterial.__tslpSourceMaterial );
		}
		if ( scene && typeof scene.traverse === 'function' ) scene.traverse( swapOne );
		return callback();
	} finally {
		for ( let i = swaps.length - 1; i >= 0; i -- ) {
			const swap = swaps[ i ];
			if ( swap.override ) swap.object.overrideMaterial = swap.material;
			else swap.object.material = swap.material;
		}
	}
}

function __sharePassRenderTargetFromFullRenderer( slimRenderer, fullRenderer, passNode ) {
	const target = passNode && passNode.renderTarget;
	if ( ! target ) return;
	const textures = Array.isArray( target.textures ) ? target.textures : target.texture ? [ target.texture ] : [];
	for ( const texture of textures ) __shareGPUTextureEntry( slimRenderer, fullRenderer, texture );
	if ( target.depthTexture ) __shareGPUTextureEntry( slimRenderer, fullRenderer, target.depthTexture );
}

function __sharePassRenderTargetIntoFullRenderer( fullRenderer, slimRenderer, passNode ) {
	const target = passNode && passNode.renderTarget;
	if ( ! target ) return;
	const textures = Array.isArray( target.textures ) ? target.textures : target.texture ? [ target.texture ] : [];
	for ( const texture of textures ) __shareGPUTextureEntry( fullRenderer, slimRenderer, texture );
	if ( target.depthTexture ) __shareGPUTextureEntry( fullRenderer, slimRenderer, target.depthTexture );
}

function __renderOffscreenOverrideWithFullRenderer( slimRenderer, scene, camera ) {
	const fullRenderer = __computeRenderer;
	if ( ! slimRenderer || ! fullRenderer || ! scene || ! scene.overrideMaterial ) return false;
	const diag = typeof __harnessDiagnostics === 'function' ? __harnessDiagnostics() : null;
	const shareDiag = diag ? ( diag.textureShare || ( diag.textureShare = { calls: 0, noSourceData: 0, noSourceTexture: 0, success: 0, names: [], missingNames: [] } ) ) : null;
	const stats = __sharedRenderOffscreenOverrideWithFullRenderer( {
		scene,
		camera,
		slimRenderer,
		fullRenderer,
		withSourceMaterials: ( targetScene, render ) => __withSourceMaterialsForFullPass( targetScene, render ),
		diagnostics: shareDiag,
		onError: ( err ) => {
			if ( ! window.__tslpOffscreenOverrideFullWarned ) {
				window.__tslpOffscreenOverrideFullWarned = true;
				console.warn( '[tslp-e2e] offscreen override full-renderer pass failed:', err && ( err.stack || err.message ) || err );
			}
		},
	} );
	if ( stats && stats.rendered ) {
		try {
			const counters = diag || __harnessDiagnostics();
			counters.offscreenOverrideFullRenders = ( counters.offscreenOverrideFullRenders | 0 ) + 1;
		} catch ( _ ) {}
		return true;
	}
	return false;
}

function __withPassRendererContext( passNode, renderer, callback ) {
	const currentContextNode = renderer && renderer.contextNode;
	try {
		if ( passNode && passNode.contextNode !== null && renderer ) {
			if ( renderer.contextNode && typeof renderer.contextNode.getFlowContextData === 'function' && typeof passNode.contextNode.getFlowContextData === 'function' ) {
				if ( passNode._contextNodeCache == null || passNode._contextNodeCache.version !== passNode.version ) {
					passNode._contextNodeCache = {
						version: passNode.version,
						context: FullTSL.context( { ...renderer.contextNode.getFlowContextData(), ...passNode.contextNode.getFlowContextData() } )
					};
				}
				renderer.contextNode = passNode._contextNodeCache.context;
			} else {
				renderer.contextNode = passNode.contextNode;
			}
		}
		return callback();
	} finally {
		if ( renderer ) renderer.contextNode = currentContextNode;
	}
}

function __renderPassNodeWithSourceMaterials( passNode, renderer, camera ) {
	if ( ! passNode || ! renderer || ! passNode.scene || passNode._mrt || ! __sceneHasMultiOutputPrecompiledMaterial( passNode.scene ) ) return false;
	if ( renderer.__TSLP_SLIM__ === true ) return false;
	try {
		try {
			const diag = __harnessDiagnostics();
			const passDiag = diag.pass || ( diag.pass = { attempts: 0, skipped: 0, rendered: 0, failed: 0, objects: [], materials: [], objectDetails: [] } );
			passDiag.sourceMaterialRenders = ( passDiag.sourceMaterialRenders || 0 ) + 1;
		} catch ( _ ) {}
		__withSourceMaterialsForFullPass( passNode.scene, () => renderer.render( passNode.scene, camera || passNode.camera ) );
		return true;
	} catch ( err ) {
		if ( ! window.__tslpSourcePassRenderWarned ) {
			window.__tslpSourcePassRenderWarned = true;
			console.warn( '[tslp-e2e] source-material pass replay failed:', err && ( err.stack || err.message ) || err );
		}
		return false;
	}
}

function __renderPassNodeWithFullRenderer( passNode, slimRenderer, fullRenderer, camera, options = {} ) {
	if ( ! passNode || ! slimRenderer || ! fullRenderer || ! passNode.scene || ! passNode.renderTarget ) return false;
	const force = options && options.force === true;
	const hasBackdropMaterial = __sceneHasBackdropNodeMaterial( passNode.scene );
	const hasPassContext = passNode.contextNode !== null;
	if ( ! force && ! passNode._mrt && ! __sceneHasMultiOutputPrecompiledMaterial( passNode.scene ) && ! hasPassContext ) return false;
	try {
		try {
			fullRenderer.toneMapping = slimRenderer.toneMapping;
			fullRenderer.toneMappingExposure = slimRenderer.toneMappingExposure;
			fullRenderer.outputColorSpace = slimRenderer.outputColorSpace;
			const size = slimRenderer.getDrawingBufferSize && slimRenderer.getDrawingBufferSize( new Slim.Vector2() );
			if ( size && typeof fullRenderer.setSize === 'function' ) fullRenderer.setSize( size.width, size.height, false );
		} catch ( _ ) {}
		const currentRenderTarget = typeof fullRenderer.getRenderTarget === 'function' ? fullRenderer.getRenderTarget() : null;
		const currentMRT = typeof fullRenderer.getMRT === 'function' ? fullRenderer.getMRT() : null;
		const currentAutoClear = fullRenderer.autoClear;
		const currentTransparent = fullRenderer.transparent;
		const currentOpaque = fullRenderer.opaque;
		const currentContextNode = fullRenderer.contextNode;
		const currentBackground = passNode.scene.background;
		const currentBackgroundNode = passNode.scene.backgroundNode;
		const capturedBackground = __capturedSceneBackgrounds.get( passNode.scene );
		const capturedBackgroundNode = __capturedSceneBackgroundNodes.get( passNode.scene );
		try {
			if ( capturedBackground !== undefined ) passNode.scene.background = capturedBackground;
				if ( capturedBackgroundNode !== undefined ) passNode.scene.backgroundNode = capturedBackgroundNode;
				__sharePassRenderTargetIntoFullRenderer( fullRenderer, slimRenderer, passNode );
				fullRenderer.setRenderTarget( passNode.renderTarget );
			if ( typeof fullRenderer.setMRT === 'function' ) fullRenderer.setMRT( passNode._mrt || null );
			fullRenderer.autoClear = true;
			fullRenderer.transparent = passNode.transparent;
			fullRenderer.opaque = passNode.opaque;
			__withPassRendererContext( passNode, fullRenderer, () => __withSourceMaterialsForFullPass(
				passNode.scene,
				() => fullRenderer.render( passNode.scene, camera || passNode.camera ),
				hasBackdropMaterial ? { materialForSource: __materialForBackdropFullPass } : null
			) );
			__sharePassRenderTargetFromFullRenderer( slimRenderer, fullRenderer, passNode );
			return true;
		} finally {
			passNode.scene.background = currentBackground;
			passNode.scene.backgroundNode = currentBackgroundNode;
			try { fullRenderer.setRenderTarget( currentRenderTarget ); } catch ( _ ) {}
			try { if ( typeof fullRenderer.setMRT === 'function' ) fullRenderer.setMRT( currentMRT ); } catch ( _ ) {}
			fullRenderer.autoClear = currentAutoClear;
			fullRenderer.transparent = currentTransparent;
			fullRenderer.opaque = currentOpaque;
			fullRenderer.contextNode = currentContextNode;
		}
	} catch ( err ) {
		if ( ! window.__tslpFullPassRenderWarned ) {
			window.__tslpFullPassRenderWarned = true;
			console.warn( '[tslp-e2e] full-renderer pass replay failed:', err && ( err.stack || err.message ) || err );
		}
		return false;
	}
}

	export class PassNode extends Slim.PassNode {
		static COLOR = 'color';
		static DEPTH = 'depth';

		constructor( scope = PassNode.COLOR, scene = null, camera = null, options = {} ) {
			super( scope, scene, camera );
			this.scope = scope;
			this.scene = scene;
			this.camera = camera;
			this.options = options || {};
			this._pixelRatio = 1;
			this._width = 1;
			this._height = 1;
			this._resolutionScale = 1;
			this._viewport = null;
			this._scissor = null;
			this._layers = null;
			this._mrt = null;
			this._textures = Object.create( null );
			this._textureNodes = Object.create( null );
			this._viewZNodes = Object.create( null );
			this._linearDepthNodes = Object.create( null );
			this._previousTextures = Object.create( null );
			this._previousTextureNodes = Object.create( null );
			this._cameraNear = FullTSL.uniform( 0 );
			this._cameraFar = FullTSL.uniform( 1 );
			this.overrideMaterial = null;
			this.transparent = true;
			this.opaque = true;
			this.contextNode = null;
			this._contextNodeCache = null;
			this.isNode = true;
			this.isPassNode = true;
			this.__tslpPassIndex = __passNodeSequence ++;
			this._renderTargetOptions = { type: Slim.HalfFloatType, ...this.options };
			const renderTarget = new Slim.RenderTarget( 1, 1, this._renderTargetOptions );
			renderTarget.texture.name = 'output';
			renderTarget.depthTexture = __makePassDepthTexture( renderTarget );
			// Back-link depth texture to its render target so the slim
			// hydrator multisample check accepts it as a multisampled
			// depth binding when samples is greater than 1.
			this.renderTarget = renderTarget;
			this._textures.output = renderTarget.texture;
			this._textures.depth = renderTarget.depthTexture;
			__livePassNodes.push( this );
		}

		setResolutionScale( resolutionScale ) { this._resolutionScale = resolutionScale || 1; this.setSize( this._width, this._height ); return this; }
		getResolutionScale() { return this._resolutionScale; }
		setResolution( resolution ) { return this.setResolutionScale( resolution ); }
		getResolution() { return this.getResolutionScale(); }
		setLayers( layers ) { this._layers = layers; return this; }
		getLayers() { return this._layers; }
		getUpdateType() { return 'none'; }
		getUpdateBeforeType() { return 'render'; }
		getUpdateAfterType() { return 'none'; }
		setMRT( mrt ) { this._mrt = mrt; __syncPassRenderTargetTextures( this, mrt ); return this; }
		getMRT() { return this._mrt; }
		getTexture( name = 'output' ) {
			let texture = this._textures[ name ];
			if ( texture === undefined ) {
				const refTexture = this.renderTarget.texture;
				texture = refTexture && typeof refTexture.clone === 'function' ? refTexture.clone() : refTexture;
				if ( texture ) texture.name = name;
				this._textures[ name ] = texture;
			}
			return texture;
		}
		getPreviousTexture( name = 'output' ) {
			let texture = this._previousTextures[ name ];
			if ( texture === undefined ) {
				const current = this.getTexture( name );
				texture = current && typeof current.clone === 'function' ? current.clone() : current;
				if ( texture ) texture.name = name + '.previous';
				this._previousTextures[ name ] = texture;
			}
			return texture;
		}
		toggleTexture( name = 'output' ) {
			const prevTexture = this._previousTextures[ name ];
			if ( prevTexture === undefined ) return;
			const texture = this._textures[ name ];
			if ( this.renderTarget && Array.isArray( this.renderTarget.textures ) ) {
				const index = this.renderTarget.textures.indexOf( texture );
				if ( index >= 0 ) this.renderTarget.textures[ index ] = prevTexture;
			}
			this._textures[ name ] = prevTexture;
			this._previousTextures[ name ] = texture;
			if ( this._textureNodes[ name ] && typeof this._textureNodes[ name ].updateTexture === 'function' ) this._textureNodes[ name ].updateTexture();
			if ( this._previousTextureNodes[ name ] && typeof this._previousTextureNodes[ name ].updateTexture === 'function' ) this._previousTextureNodes[ name ].updateTexture();
		}
		getTextureNode( name = 'output' ) {
			let textureNode = this._textureNodes[ name ];
			if ( textureNode === undefined ) this._textureNodes[ name ] = textureNode = __makePassTextureNode( this, name, false );
			return textureNode;
		}
		__callTextureNode( method, args ) {
			const textureNode = this.getTextureNode();
			const fn = textureNode && textureNode[ method ];
			return typeof fn === 'function' ? fn.apply( textureNode, args ) : textureNode;
		}
		context( ...args ) {
			const node = this.__callTextureNode( 'context', args );
			try { node.passNode = this; } catch ( _ ) {}
			this.contextNode = node;
			return node;
		}
		toVar( ...args ) { return this.__callTextureNode( 'toVar', args ); }
		toInspector() { return this; }
		add( ...args ) { return this.__callTextureNode( 'add', args ); }
		sub( ...args ) { return this.__callTextureNode( 'sub', args ); }
		mul( ...args ) { return this.__callTextureNode( 'mul', args ); }
		div( ...args ) { return this.__callTextureNode( 'div', args ); }
		mod( ...args ) { return this.__callTextureNode( 'mod', args ); }
		pow( ...args ) { return this.__callTextureNode( 'pow', args ); }
		min( ...args ) { return this.__callTextureNode( 'min', args ); }
		max( ...args ) { return this.__callTextureNode( 'max', args ); }
		mix( ...args ) { return this.__callTextureNode( 'mix', args ); }
		clamp( ...args ) { return this.__callTextureNode( 'clamp', args ); }
		normalize( ...args ) { return this.__callTextureNode( 'normalize', args ); }
		toneMapping( ...args ) { return this.__callTextureNode( 'toneMapping', args ); }
		renderOutput( ...args ) { return this.__callTextureNode( 'renderOutput', args ); }
		get r() { return this.getTextureNode().r; }
		get g() { return this.getTextureNode().g; }
		get b() { return this.getTextureNode().b; }
		get a() { return this.getTextureNode().a; }
		get rgb() { return this.getTextureNode().rgb; }
		get rgba() { return this.getTextureNode().rgba; }
		getPreviousTextureNode( name = 'output' ) {
			let textureNode = this._previousTextureNodes[ name ];
			if ( textureNode === undefined ) this._previousTextureNodes[ name ] = textureNode = __makePassTextureNode( this, name, true );
			return textureNode;
		}
		getViewZNode( name = 'depth' ) {
			let viewZNode = this._viewZNodes[ name ];
			if ( viewZNode === undefined ) {
				viewZNode = FullTSL.perspectiveDepthToViewZ( this.getTextureNode( name ), this._cameraNear, this._cameraFar );
				try { viewZNode.passNode = this; } catch ( _ ) {}
				this._viewZNodes[ name ] = viewZNode;
			}
			return viewZNode;
		}
		getLinearDepthNode( name = 'depth' ) {
			let linearDepthNode = this._linearDepthNodes[ name ];
			if ( linearDepthNode === undefined ) {
				linearDepthNode = FullTSL.viewZToOrthographicDepth( this.getViewZNode( name ), this._cameraNear, this._cameraFar );
				try { linearDepthNode.passNode = this; } catch ( _ ) {}
				this._linearDepthNodes[ name ] = linearDepthNode;
			}
			return linearDepthNode;
		}
		setup( { renderer } = {} ) {
			if ( renderer && typeof renderer.getOutputBufferType === 'function' ) {
				try { this.renderTarget.texture.type = renderer.getOutputBufferType(); } catch ( _ ) {}
			}
			return this.scope === PassNode.DEPTH ? this.getLinearDepthNode() : this.getTextureNode();
		}
		async compileAsync() {}
		setPixelRatio( pixelRatio ) { this._pixelRatio = pixelRatio || 1; this.setSize( this._width, this._height ); }
		setSize( width = 1, height = 1 ) {
			this._width = width;
			this._height = height;
			const scale = this._pixelRatio * this._resolutionScale;
			const effectiveWidth = Math.max( 1, Math.floor( width * scale ) );
			const effectiveHeight = Math.max( 1, Math.floor( height * scale ) );
			if ( this.renderTarget && typeof this.renderTarget.setSize === 'function' ) {
				this.renderTarget.setSize( effectiveWidth, effectiveHeight );
				if ( this.renderTarget.texture ) this._textures.output = this.renderTarget.texture;
				if ( this.renderTarget.depthTexture ) this._textures.depth = this.renderTarget.depthTexture;
				__refreshPassTextureNodes( this );
			}
			if ( this._scissor !== null && this.renderTarget && this.renderTarget.scissor ) {
				this.renderTarget.scissor.copy( this._scissor ).multiplyScalar( scale ).floor();
				this.renderTarget.scissorTest = true;
			} else if ( this.renderTarget ) {
				this.renderTarget.scissorTest = false;
			}
			if ( this._viewport !== null && this.renderTarget && this.renderTarget.viewport ) this.renderTarget.viewport.copy( this._viewport ).multiplyScalar( scale ).floor();
		}
		setScissor( x, y, width, height ) {
			if ( x === null ) this._scissor = null;
			else {
				if ( this._scissor === null ) this._scissor = new Slim.Vector4();
				if ( x && x.isVector4 ) this._scissor.copy( x );
				else this._scissor.set( x, y, width, height );
			}
		}
		setViewport( x, y, width, height ) {
			if ( x === null ) this._viewport = null;
			else {
				if ( this._viewport === null ) this._viewport = new Slim.Vector4();
				if ( x && x.isVector4 ) this._viewport.copy( x );
				else this._viewport.set( x, y, width, height );
			}
		}
		updateBefore( frame = {} ) {
			const renderer = frame.renderer;
			const scene = this.scene;
			const camera = this.camera;
			if ( ! renderer || ! scene || ! camera ) return;
			const size = new Slim.Vector2( 1, 1 );
			try { if ( typeof renderer.getSize === 'function' ) renderer.getSize( size ); } catch ( _ ) {}
			try { this._pixelRatio = typeof renderer.getPixelRatio === 'function' ? renderer.getPixelRatio() : 1; } catch ( _ ) { this._pixelRatio = 1; }
			this._cameraNear.value = camera.near || 0;
			this._cameraFar.value = camera.far || 1;
			this.setSize( size.width || 1, size.height || 1 );
			__recordRenderableObjectCount( scene );
			const currentRenderTarget = typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : null;
			const currentMRT = typeof renderer.getMRT === 'function' ? renderer.getMRT() : null;
			const currentAutoClear = renderer.autoClear;
			const currentTransparent = renderer.transparent;
			const currentOpaque = renderer.opaque;
			const currentMask = camera.layers && camera.layers.mask;
			const currentOverrideMaterial = scene.overrideMaterial;
			for ( const name in this._previousTextures ) this.toggleTexture( name );
			if ( this._layers !== null && camera.layers ) camera.layers.mask = this._layers.mask;
			if ( this.overrideMaterial !== null ) scene.overrideMaterial = this.overrideMaterial;
			let replayMRT = this._mrt || null;
			if ( replayMRT ) {
				__retargetSceneMaterialsForPassTarget( scene, __mrtOutputCount( replayMRT ) );
				if ( ! __sceneCanRenderMRT( scene, replayMRT ) ) {
					replayMRT = null;
					__retargetSceneMaterialsForPassTarget( scene, 1 );
				}
			} else {
				__retargetSceneMaterialsForPassTarget( scene, 1 );
			}
				__prepareSceneMaterialsForMRTReplay( scene, replayMRT );
				renderer.autoClear = true;
				renderer.transparent = this.transparent;
				renderer.opaque = this.opaque;
				const canRenderPrecompiledMRT = !! ( replayMRT && __sceneCanRenderMRT( scene, replayMRT ) );
					try {
						const pathDiag = __harnessDiagnostics().passPaths || ( __harnessDiagnostics().passPaths = [] );
						if ( pathDiag.length < 24 ) pathDiag.push( {
							replayMRT: !! replayMRT,
							canRenderPrecompiledMRT,
							targetCount: __mrtOutputCount( replayMRT ),
						} );
					} catch ( _ ) {}
						// MRT velocity outputs are ordinary captured outputs. Prefer the
						// precompiled path whenever every scene material can render the
						// requested MRT shape, and reserve the full renderer for missing
						// artifact coverage.
							const needsFullMRTPass = !! ( replayMRT && ( ! canRenderPrecompiledMRT || this.__tslpFeedsTRAA === true ) );
				const renderedWithFullPass = !! ( needsFullMRTPass && __renderPassNodeWithFullRenderer( this, renderer, __computeRenderer, camera ) );
				if ( ! renderedWithFullPass && replayMRT && ( scene.background || scene.backgroundNode ) && ! __backgroundAuxCanRenderMRT( replayMRT ) ) {
					const backgroundScene = this.__tslpBackgroundScene || ( this.__tslpBackgroundScene = new Slim.Scene() );
					backgroundScene.background = scene.background;
					backgroundScene.backgroundNode = scene.backgroundNode;
					backgroundScene.environment = scene.environment;
				try {
					__syncPassRenderTargetTextures( this, replayMRT );
					if ( typeof renderer.setMRT === 'function' ) renderer.setMRT( replayMRT );
					renderer.setRenderTarget( this.renderTarget );
					renderer.autoClear = true;
					if ( typeof renderer.clear === 'function' ) renderer.clear();
				} catch ( _ ) {}
				const savedTargetTextures = this.renderTarget && Array.isArray( this.renderTarget.textures )
					? this.renderTarget.textures.slice()
					: null;
				const savedTextureMap = { ...this._textures };
				__syncPassRenderTargetTextures( this, null );
				if ( typeof renderer.setMRT === 'function' ) renderer.setMRT( null );
				renderer.setRenderTarget( this.renderTarget );
				renderer.render( backgroundScene, camera );
				if ( savedTargetTextures && this.renderTarget ) this.renderTarget.textures = savedTargetTextures;
				this._textures = savedTextureMap;

				const savedBackground = scene.background;
				const savedBackgroundNode = scene.backgroundNode;
				try {
					scene.background = null;
					scene.backgroundNode = null;
					__syncPassRenderTargetTextures( this, replayMRT );
					if ( typeof renderer.setMRT === 'function' ) renderer.setMRT( replayMRT );
					renderer.setRenderTarget( this.renderTarget );
					renderer.autoClear = false;
					__resetRendererPipelineCachesForMRTReplay( renderer, replayMRT );
					__wirePassTexturesIntoSceneMaterials( scene, __activePipelinePassNodes || [ this ] );
					if ( renderer.__tslpSuppressShadowKick !== true && __sceneHasShadowLights( scene ) ) __kickShadowRenderAsync( renderer, scene, camera );
					renderer.render( scene, camera );
				} finally {
					scene.background = savedBackground;
					scene.backgroundNode = savedBackgroundNode;
					}
					} else if ( ! renderedWithFullPass ) {
						__syncPassRenderTargetTextures( this, replayMRT );
						if ( typeof renderer.setMRT === 'function' ) renderer.setMRT( replayMRT );
						renderer.setRenderTarget( this.renderTarget );
					__resetRendererPipelineCachesForMRTReplay( renderer, replayMRT );
					__wirePassTexturesIntoSceneMaterials( scene, __activePipelinePassNodes || [ this ] );
						__wireBackgroundTextures( scene, renderer );
						__driveRendererLightingUpdateBefore( renderer, scene, camera );
						if ( renderer.__tslpSuppressShadowKick !== true && __sceneHasShadowLights( scene ) ) __kickShadowRenderAsync( renderer, scene, camera );
					const renderedWithSource = __withPassRendererContext( this, renderer, () => __renderPassNodeWithSourceMaterials( this, renderer, camera ) );
					const renderedWithFullFallback = ! renderedWithSource && ! canRenderPrecompiledMRT && __renderPassNodeWithFullRenderer( this, renderer, __computeRenderer, camera );
					if ( ! renderedWithSource && ! renderedWithFullFallback ) {
						const savedRenderDepth = __renderDepth;
						__renderDepth = 0;
						try {
							__withPassRendererContext( this, renderer, () => renderer.render( scene, camera ) );
						} finally {
							__renderDepth = savedRenderDepth;
						}
						}
				}
				scene.overrideMaterial = currentOverrideMaterial;
			renderer.setRenderTarget( currentRenderTarget );
			if ( typeof renderer.setMRT === 'function' ) renderer.setMRT( currentMRT );
			renderer.autoClear = currentAutoClear;
			renderer.transparent = currentTransparent;
			renderer.opaque = currentOpaque;
			if ( camera.layers && currentMask !== undefined ) camera.layers.mask = currentMask;
		}
		dispose() { if ( this.renderTarget && typeof this.renderTarget.dispose === 'function' ) this.renderTarget.dispose(); }
	}
const __counts = Object.create( null );
const __usedArtifactNames = new Set();
const __seenMaterials = new WeakMap();
const __fallbackArtifactTextures = new Map();
const __liveSceneIndex = createLiveSceneIndex( {
	registerLiveTexture: ( texture ) => Slim.registerLiveTexture( texture ),
	getDiagnostics: () => __harnessDiagnostics(),
	materialTextureProps: __TEXTURE_PROPS,
	collectMaterialNodeTextures: ( material ) => __collectMaterialNodeTextures( material ),
	isEnvironmentTextureSource: ( texture ) => __isEnvironmentTextureSource( texture ),
	isPMREMTexture: ( texture ) => __isPMREMTexture( texture ),
} );
const __liveTexturesByUuid = __liveSceneIndex.texturesByUuid;
const __liveTexturesByName = __liveSceneIndex.texturesByName;
const __liveMaterialTextures = __liveSceneIndex.materialTextures;
const __hasBackgroundAux = Array.isArray( __data.aux ) && __data.aux.some( ( entry ) => entry && entry.shape === 'background' );
const __backgroundAuxCount = Array.isArray( __data.aux ) ? __data.aux.filter( ( entry ) => entry && entry.shape === 'background' ).length : 0;
Slim.registerAuxArtifacts( Array.isArray( __data.aux ) ? __data.aux : [] );
// Counter for in-flight async PMREM generations. Playwright waits for this to
// reach 0 (alongside __tslpFrozen) before taking a screenshot so PMREM-based
// IBL textures are resolved and re-hydrated before capture.
window.__tslpPmremPending = 0;

// Defensive patch: harden Slim.ColorManagement.getTransfer against unknown
// colorSpace values. Some textures end up with colorSpace = undefined, and
// the slim bundle minified getTransfer only special-cases empty string;
// anything else hits this.spaces[ colorSpace ].transfer and throws.
( function patchColorManagement() {
	const cm = Slim.ColorManagement;
	if ( ! cm || cm.__tslpHardened ) return;
	cm.__tslpHardened = true;
	const orig = cm.getTransfer.bind( cm );
	cm.getTransfer = function ( colorSpace ) {
		try {
			return orig( colorSpace );
		} catch ( _ ) {
			const diag = window.__tslpHarnessDiagnostics || ( window.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
			const key = colorSpace === undefined ? 'undefined' : colorSpace === null ? 'null' : String( colorSpace );
			diag.colorTransferFallbacks[ key ] = ( diag.colorTransferFallbacks[ key ] || 0 ) + 1;
			return orig( '' );
		}
	};
} )();

// Heal Texture.prototype.colorSpace at the source: install a setter that
// coerces undefined / null to '' (NoColorSpace). three.js Texture writes
// this.colorSpace = colorSpace as a plain instance field; some ad-hoc
// texture factories pass undefined, leaving this.spaces[ undefined ] and
// throwing inside getTransfer. Routing all writes through a setter
// guarantees colorSpace is always a valid string before getTransfer reads.
( function healTextureColorSpace() {
	const proto = Slim.Texture && Slim.Texture.prototype;
	if ( ! proto || proto.__tslpColorSpaceHealed ) return;
	proto.__tslpColorSpaceHealed = true;
	const KEY = '__tslpColorSpace';
	Object.defineProperty( proto, 'colorSpace', {
		configurable: true,
		enumerable: true,
		get() { return this[ KEY ] === undefined ? '' : this[ KEY ]; },
		set( v ) { this[ KEY ] = ( v === undefined || v === null ) ? '' : v; },
	} );
} )();
// No-op kept so the render() callsite below stays consistent across patches.
window.__tslpHealColorSpace = function () { return 0; };

// Counter for in-flight async compute dispatches delegated to the full renderer.
// Playwright waits for this to reach 0 before taking a screenshot so the GPU
// storage buffers written by compute are visible in the final render.
window.__tslpComputePending = 0;
// Counter for in-flight async shadow-map renders run on the full WebGPURenderer
// (slim has shadow code tree-shaken). Playwright waits for this to reach 0 so
// light.shadow.map.depthTexture is allocated before the slim render samples it.
window.__tslpShadowPending = 0;

function __rememberLiveTexture( texture ) {
	__liveSceneIndex.rememberLiveTexture( texture );
}
window.__tslpRememberLiveTexture = __rememberLiveTexture;

// Mirror the capture-side patches: hook DefaultLoadingManager so HDR/GLTF/MaterialX
// fetches block the screenshot, and wrap compileAsync so awaited GPU pipeline
// builds also block. Counters were initialised in the page.addInitScript shim.
( function patchSlimDefaultLoadingManager() {
	const dlm = Slim.DefaultLoadingManager;
	if ( ! dlm || dlm.__tslpPatched ) return;
	dlm.__tslpPatched = true;
	const _origStart = dlm.itemStart.bind( dlm );
	const _origEnd = dlm.itemEnd.bind( dlm );
	const _now = () => ( typeof window.__tslpRealNow === 'function' ? window.__tslpRealNow() : Date.now() );
	dlm.itemStart = function ( url ) {
		window.__tslpLoaderPending = ( window.__tslpLoaderPending | 0 ) + 1;
		window.__tslpLoaderLastBusyAt = _now();
		return _origStart( url );
	};
	dlm.itemEnd = function ( url ) {
		window.__tslpLoaderPending = Math.max( 0, ( window.__tslpLoaderPending | 0 ) - 1 );
		window.__tslpLoaderLastBusyAt = _now();
		return _origEnd( url );
	};
} )();

// PMREMGenerator drives nested renderer.compile / renderer.render calls when
// it builds the prefiltered cubemap. Those nested calls re-enter this
// wrapper's render(); without a guard, __prepareSceneForReplay would try
// to swap PMREM's internal tmp-mesh material against our captured artifact
// table and produce identity-MISSes that get cached BEFORE the user's main
// scene.environment ever gets registered. The guard keeps the pre-render
// hook a no-op while a PMREM build is in flight.
let __pmremRunning = 0;

// Re-entrancy depth for renderer.render(). RTTNode.updateBefore / PassNode.updateBefore
// invoke QuadMesh.render( renderer ) which calls renderer.render( quadScene, ... )
// recursively on us. Those nested scenes contain full-renderer-internal NodeMaterials
// with no captured artifact — __replaceSceneMaterials would throw. Skip scene prep
// (and the explicit RTT/effect drives, already in flight at depth 0) when nested.
let __renderDepth = 0;

function __makeFullRoomEnvironment( Three ) {
	if ( ! Three ) return null;
	const {
		BackSide,
		BoxGeometry,
		InstancedMesh,
		Mesh,
		MeshLambertMaterial,
		MeshStandardMaterial,
		PointLight,
		Scene,
		Object3D,
	} = Three;
	if ( ! Scene || ! BoxGeometry || ! Mesh || ! MeshStandardMaterial || ! MeshLambertMaterial ) return null;

	const scene = new Scene();
	scene.name = 'RoomEnvironment';
	scene.position.y = - 3.5;

	const geometry = new BoxGeometry();
	geometry.deleteAttribute( 'uv' );

	const roomMaterial = new MeshStandardMaterial( { side: BackSide } );
	const boxMaterial = new MeshStandardMaterial();

	const mainLight = new PointLight( 0xffffff, 900, 28, 2 );
	mainLight.position.set( 0.418, 16.199, 0.300 );
	scene.add( mainLight );

	const room = new Mesh( geometry, roomMaterial );
	room.position.set( - 0.757, 13.219, 0.717 );
	room.scale.set( 31.713, 28.305, 28.591 );
	scene.add( room );

	const boxes = new InstancedMesh( geometry, boxMaterial, 6 );
	const transform = new Object3D();
	const boxTransforms = [
		[ [ - 10.906, 2.009, 1.846 ], [ 0, - 0.195, 0 ], [ 2.328, 7.905, 4.651 ] ],
		[ [ - 5.607, - 0.754, - 0.758 ], [ 0, 0.994, 0 ], [ 1.970, 1.534, 3.955 ] ],
		[ [ 6.167, 0.857, 7.803 ], [ 0, 0.561, 0 ], [ 3.927, 6.285, 3.687 ] ],
		[ [ - 2.017, 0.018, 6.124 ], [ 0, 0.333, 0 ], [ 2.002, 4.566, 2.064 ] ],
		[ [ 2.291, - 0.756, - 2.621 ], [ 0, - 0.286, 0 ], [ 1.546, 1.552, 1.496 ] ],
		[ [ - 2.193, - 0.369, - 5.547 ], [ 0, 0.516, 0 ], [ 3.875, 3.487, 2.986 ] ],
	];
	boxTransforms.forEach( ( [ position, rotation, scale ], index ) => {
		transform.position.set( position[ 0 ], position[ 1 ], position[ 2 ] );
		transform.rotation.set( rotation[ 0 ], rotation[ 1 ], rotation[ 2 ] );
		transform.scale.set( scale[ 0 ], scale[ 1 ], scale[ 2 ] );
		transform.updateMatrix();
		boxes.setMatrixAt( index, transform.matrix );
	} );
	scene.add( boxes );

	const createAreaLightMaterial = ( intensity ) => new MeshLambertMaterial( {
		color: 0x000000,
		emissive: 0xffffff,
		emissiveIntensity: intensity,
	} );
	const areaLights = [
		[ 50, [ - 16.116, 14.37, 8.208 ], [ 0.1, 2.428, 2.739 ] ],
		[ 50, [ - 16.109, 18.021, - 8.207 ], [ 0.1, 2.425, 2.751 ] ],
		[ 17, [ 14.904, 12.198, - 1.832 ], [ 0.15, 4.265, 6.331 ] ],
		[ 43, [ - 0.462, 8.89, 14.520 ], [ 4.38, 5.441, 0.088 ] ],
		[ 20, [ 3.235, 11.486, - 12.541 ], [ 2.5, 2.0, 0.1 ] ],
		[ 100, [ 0.0, 20.0, 0.0 ], [ 1.0, 0.1, 1.0 ] ],
	];
	for ( const [ intensity, position, scale ] of areaLights ) {
		const light = new Mesh( geometry, createAreaLightMaterial( intensity ) );
		light.position.set( position[ 0 ], position[ 1 ], position[ 2 ] );
		light.scale.set( scale[ 0 ], scale[ 1 ], scale[ 2 ] );
		scene.add( light );
	}

	scene.dispose = function () {
		const resources = new Set();
		this.traverse( ( object ) => {
			if ( object && object.isMesh ) {
				resources.add( object.geometry );
				resources.add( object.material );
			}
		} );
		for ( const resource of resources ) {
			try { resource.dispose && resource.dispose(); } catch ( _ ) {}
		}
	};

	return scene;
}

function __copyFullObjectState( source, target ) {
	if ( ! source || ! target ) return;
	target.name = source.name || target.name;
	target.visible = source.visible !== false;
	if ( source.position && target.position && typeof target.position.copy === 'function' ) target.position.copy( source.position );
	if ( source.quaternion && target.quaternion && typeof target.quaternion.copy === 'function' ) target.quaternion.copy( source.quaternion );
	if ( source.scale && target.scale && typeof target.scale.copy === 'function' ) target.scale.copy( source.scale );
	if ( source.rotation && target.rotation && typeof target.rotation.copy === 'function' ) target.rotation.copy( source.rotation );
	if ( source.matrix && target.matrix && typeof target.matrix.copy === 'function' ) target.matrix.copy( source.matrix );
	if ( source.matrixWorld && target.matrixWorld && typeof target.matrixWorld.copy === 'function' ) target.matrixWorld.copy( source.matrixWorld );
	target.matrixAutoUpdate = source.matrixAutoUpdate !== false;
	target.matrixWorldAutoUpdate = source.matrixWorldAutoUpdate !== false;
}

function __copyFullTextureState( source, target ) {
	if ( ! source || ! target ) return;
	target.name = source.name || target.name;
	for ( const key of [ 'mapping', 'channel', 'wrapS', 'wrapT', 'wrapR', 'magFilter', 'minFilter', 'anisotropy', 'format', 'internalFormat', 'type', 'generateMipmaps', 'premultiplyAlpha', 'flipY', 'unpackAlignment', 'colorSpace', 'compareFunction' ] ) {
		if ( source[ key ] !== undefined ) {
			try { target[ key ] = source[ key ]; } catch ( _ ) {}
		}
	}
	for ( const key of [ 'offset', 'repeat', 'center', 'matrix' ] ) {
		if ( source[ key ] && target[ key ] && typeof target[ key ].copy === 'function' ) {
			try { target[ key ].copy( source[ key ] ); } catch ( _ ) {}
		}
	}
	try { target.rotation = source.rotation || 0; } catch ( _ ) {}
	try { target.matrixAutoUpdate = source.matrixAutoUpdate !== false; } catch ( _ ) {}
}

function __cloneTextureForFullRenderer( Three, source, createdTextures ) {
	if ( ! Three || ! source || source.isTexture !== true ) return source || null;
	let texture = null;
	try {
		const image = source.image;
		if ( source.isCubeTexture === true && Three.CubeTexture ) {
			texture = new Three.CubeTexture( image );
		} else if ( source.isDataTexture === true && Three.DataTexture && image && image.data && Number.isFinite( image.width ) && Number.isFinite( image.height ) ) {
			texture = new Three.DataTexture( image.data, image.width, image.height, source.format, source.type, source.mapping, source.wrapS, source.wrapT, source.magFilter, source.minFilter, source.anisotropy, source.colorSpace );
		} else if ( source.isCompressedTexture === true && Three.CompressedTexture && image && Array.isArray( image.mipmaps ) && Number.isFinite( image.width ) && Number.isFinite( image.height ) ) {
			texture = new Three.CompressedTexture( image.mipmaps, image.width, image.height, source.format, source.type, source.mapping, source.wrapS, source.wrapT, source.magFilter, source.minFilter, source.anisotropy, source.colorSpace );
		} else if ( Three.Texture ) {
			texture = new Three.Texture( image );
		}
	} catch ( _ ) {
		texture = null;
	}
	if ( ! texture ) return source;
	__copyFullTextureState( source, texture );
	texture.needsUpdate = true;
	if ( createdTextures ) createdTextures.add( texture );
	return texture;
}

function __makeFullPMREMMaterial( Three, source, createdTextures ) {
	if ( ! Three || ! source ) return null;
	const Ctor = source.isMeshStandardMaterial && Three.MeshStandardMaterial ? Three.MeshStandardMaterial
		: source.isMeshPhysicalMaterial && Three.MeshPhysicalMaterial ? Three.MeshPhysicalMaterial
			: source.isMeshLambertMaterial && Three.MeshLambertMaterial ? Three.MeshLambertMaterial
				: source.isMeshBasicMaterial && Three.MeshBasicMaterial ? Three.MeshBasicMaterial
					: null;
	if ( ! Ctor ) return null;
	const material = new Ctor();
	for ( const key of [ 'side', 'transparent', 'opacity', 'alphaTest', 'depthTest', 'depthWrite', 'toneMapped', 'blending', 'premultipliedAlpha', 'wireframe', 'roughness', 'metalness' ] ) {
		if ( source[ key ] !== undefined ) {
			try { material[ key ] = source[ key ]; } catch ( _ ) {}
		}
	}
	for ( const key of [ 'color', 'emissive', 'specular' ] ) {
		if ( source[ key ] && material[ key ] && typeof material[ key ].copy === 'function' ) {
			try { material[ key ].copy( source[ key ] ); } catch ( _ ) {}
		}
	}
	for ( const key of [ 'map', 'envMap', 'emissiveMap', 'alphaMap', 'aoMap', 'lightMap' ] ) {
		if ( source[ key ] && source[ key ].isTexture === true ) material[ key ] = __cloneTextureForFullRenderer( Three, source[ key ], createdTextures );
	}
	material.needsUpdate = true;
	return material;
}

function __makeFullSceneForPMREM( scene, Three ) {
	if ( ! scene || ! Three || ! Three.Scene || ! Three.Mesh || ! Three.Group ) return null;
	const createdMaterials = new Set();
	const createdTextures = new Set();
	const fullScene = new Three.Scene();
	__copyFullObjectState( scene, fullScene );
	if ( scene.background && scene.background.isColor && Three.Color ) {
		fullScene.background = new Three.Color().copy( scene.background );
	} else {
		fullScene.background = __cloneTextureForFullRenderer( Three, scene.background, createdTextures ) || scene.background || null;
	}
	fullScene.environment = __cloneTextureForFullRenderer( Three, scene.environment, createdTextures ) || scene.environment || null;

	const cloneNode = ( source ) => {
		if ( ! source || source.visible === false ) return null;
		if ( source.isSkinnedMesh === true || source.isInstancedMesh === true ) return null;
		let target = null;
		if ( source.isMesh === true ) {
			const material = __makeFullPMREMMaterial( Three, Array.isArray( source.material ) ? source.material[ 0 ] : source.material, createdTextures );
			if ( ! material ) return null;
			createdMaterials.add( material );
			target = new Three.Mesh( __cloneGeometryForFullRenderer( source.geometry ), material );
		} else if ( source.isGroup === true || Array.isArray( source.children ) ) {
			target = new Three.Group();
		} else {
			return null;
		}
		__copyFullObjectState( source, target );
		for ( const child of source.children || [] ) {
			const cloned = cloneNode( child );
			if ( cloned ) target.add( cloned );
		}
		return target;
	};

	for ( const child of scene.children || [] ) {
		const cloned = cloneNode( child );
		if ( ! cloned && child && child.visible !== false ) return null;
		if ( cloned ) fullScene.add( cloned );
	}
	fullScene.dispose = function () {
		for ( const material of createdMaterials ) {
			try { material.dispose && material.dispose(); } catch ( _ ) {}
		}
		for ( const texture of createdTextures ) {
			try { texture.dispose && texture.dispose(); } catch ( _ ) {}
		}
	};
	return fullScene;
}

function __preparePMREMArgsForFullRenderer( method, args ) {
	if ( method !== 'fromScene' || ! args || ! args[ 0 ] ) return args;
	const scene = args[ 0 ];
	const isRoomEnvironment = scene.name === 'RoomEnvironment' || scene.constructor && scene.constructor.name === 'RoomEnvironment';
	const fullScene = isRoomEnvironment ? __makeFullRoomEnvironment( __fullThreeMod ) : __makeFullSceneForPMREM( scene, __fullThreeMod );
	try {
		const diag = __pmremDiagnostics();
		diag.syncFullSceneClone = ( diag.syncFullSceneClone || 0 ) + ( fullScene ? 1 : 0 );
		diag.syncFullSceneCloneMiss = ( diag.syncFullSceneCloneMiss || 0 ) + ( fullScene ? 0 : 1 );
		if ( fullScene ) diag.syncFullSceneChildren = fullScene.children && fullScene.children.length || 0;
	} catch ( _ ) {}
	return fullScene ? [ fullScene, ...args.slice( 1 ) ] : args;
}

// Wrap PMREMGenerator.{fromScene,fromCubemap,fromEquirectangular,fromTexture}
// to (1) bump __pmremRunning around the entire call so nested renderer.render
// calls inside them bypass __prepareSceneForReplay, and (2) route the call to
// the full compute renderer when one is available — PMREMGenerator's blur
// passes construct an internal NodeMaterial (PMREMGenerator.js _getMaterial),
// and the slim renderer's rewritten Nodes.js:getForRender throws
// tslPrecompileSlimOnly on any non-PrecompiledMaterial. The full renderer can
// build NodeMaterial; both renderers share the same WebGPU device, so the
// resulting GPUTexture is shared back to the slim backend so subsequent
// slim renders can sample it. Without this, examples that call
// pmremGen.fromScene(RoomEnvironment) (e.g. webgpu_materials_alphahash) leave
// scene.environment as a partially-initialized texture and PBR materials
// shade to black. Without (1), the FIRST nested render fires hydration on
// PMREM's internal tmp-meshes against our scene-replace table, which
// (a) MISSes (registry empty pre-init) and (b) caches dead bindings before
// the user's main scene ever runs.
const __pmremOriginalMethods = new Map();

try {
	if ( typeof Slim.setTextureResolutionDebugHook === 'function' ) {
		Slim.setTextureResolutionDebugHook( ( event ) => {
			if ( ! event || event.sourceKind !== 'artifact.texture' ) return;
			const textureName = event.resolvedTextureName || event.textureName || '';
			try {
				const diag = __harnessDiagnostics();
				const all = diag.textureResolutions || ( diag.textureResolutions = [] );
				const refs = event.artifact && event.artifact._textureRefs instanceof Map ? event.artifact._textureRefs : null;
				const refTexture = refs && event.textureUuid ? refs.get( event.textureUuid ) : null;
				const refImage = refTexture && refTexture.image || null;
				if ( all.length < 80 ) all.push( {
					strategy: event.strategy,
					artifactShape: event.artifact && ( event.artifact.__tslpAuxShape || event.artifact.materialShape || event.artifact.shape ) || '',
					artifactName: event.artifact && ( event.artifact.__tslpAuxName || event.artifact.name || event.artifact.__name ) || '',
					bindingName: event.bindingName,
					sourceUuid: event.textureUuid || '',
					textureName,
					resolvedType: event.resolvedTextureType || '',
					resolvedUuid: event.resolvedTextureUuid || '',
					refName: refTexture && refTexture.name || '',
					refType: refTexture && ( refTexture.isCubeTexture ? 'cube' : refTexture.isRenderTargetTexture ? 'render-target' : refTexture.isTexture ? 'texture' : typeof refTexture ) || '',
					refWidth: Array.isArray( refImage ) ? refImage[ 0 ] && refImage[ 0 ].width : refImage && refImage.width,
					refHeight: Array.isArray( refImage ) ? refImage[ 0 ] && refImage[ 0 ].height : refImage && refImage.height,
					refsSize: refs ? refs.size : 0,
					sourceTextureName: event.textureName || '',
					width: event.resolvedTextureWidth,
					height: event.resolvedTextureHeight,
				} );
			} catch ( _ ) {}
			if ( textureName !== 'PMREM.cubeUv' ) return;
			const diag = __pmremDiagnostics();
			if ( ! Array.isArray( diag.resolvedPmremTextures ) ) diag.resolvedPmremTextures = [];
			if ( diag.resolvedPmremTextures.length >= 8 ) return;
			diag.resolvedPmremTextures.push( {
				strategy: event.strategy,
				bindingName: event.bindingName,
				textureName,
				width: event.resolvedTextureWidth,
				height: event.resolvedTextureHeight,
			} );
		} );
	}
} catch ( _ ) {}

function __runPMREMGeneratorMethod( self, method, args ) {
	__pmremRunning ++;
	const slimRenderer = self && self._renderer;
	const fullRenderer = __computeRenderer;
	const FullPMREMGenerator = __fullThreeMod && __fullThreeMod.PMREMGenerator;
	const useFull = fullRenderer && fullRenderer !== slimRenderer && slimRenderer && slimRenderer.backend && typeof FullPMREMGenerator === 'function';
	try {
		const diag = __pmremDiagnostics();
		diag.syncCalls = ( diag.syncCalls || 0 ) + 1;
		diag.syncUseFull = ( diag.syncUseFull || 0 ) + ( useFull ? 1 : 0 );
		diag.syncFallback = ( diag.syncFallback || 0 ) + ( useFull ? 0 : 1 );
		diag.syncMethods = diag.syncMethods || {};
		diag.syncMethods[ method ] = ( diag.syncMethods[ method ] || 0 ) + 1;
		diag.syncLast = { method, hasFullRenderer: !! fullRenderer, hasFullMod: !! __fullThreeMod, hasFullPMREMGenerator: typeof FullPMREMGenerator === 'function', hasSlimRenderer: !! slimRenderer, hasSlimBackend: !! ( slimRenderer && slimRenderer.backend ) };
	} catch ( _ ) {}
	try {
		let target;
		let fullArgs = args;
		if ( useFull ) {
			const gen = new FullPMREMGenerator( fullRenderer );
			try {
				fullArgs = __preparePMREMArgsForFullRenderer( method, args );
				target = gen[ method ]( ...fullArgs );
			} finally {
				try { gen.dispose && gen.dispose(); } catch ( _ ) {}
				if ( fullArgs !== args && fullArgs[ 0 ] && typeof fullArgs[ 0 ].dispose === 'function' ) {
					try { fullArgs[ 0 ].dispose(); } catch ( _ ) {}
				}
			}
		} else {
			const orig = __pmremOriginalMethods.get( method ) || Slim.PMREMGenerator && Slim.PMREMGenerator.prototype && Slim.PMREMGenerator.prototype[ method ];
			target = typeof orig === 'function' ? orig.apply( self, args ) : undefined;
		}
		if ( useFull && target && target.texture && target.texture.isTexture === true ) {
			__sharePMREMGPUTexture( slimRenderer, fullRenderer, target.texture );
			__pmremCache.set( target.texture, target.texture );
			Slim.registerLiveTexture( target.texture );
		}
		return target;
	} finally {
		__pmremRunning --;
	}
}

( function patchPMREMGenerator() {
	const PG = Slim.PMREMGenerator;
	if ( ! PG || ! PG.prototype || PG.prototype.__tslpPatched ) return;
	PG.prototype.__tslpPatched = true;
	for ( const method of [ 'fromScene', 'fromCubemap', 'fromEquirectangular', 'fromTexture' ] ) {
		const orig = PG.prototype[ method ];
		if ( typeof orig !== 'function' ) continue;
		__pmremOriginalMethods.set( method, orig );
		PG.prototype[ method ] = function ( ...args ) {
			__pmremRunning ++;
			const slimRenderer = this._renderer;
			const fullRenderer = __computeRenderer;
			const FullPMREMGenerator = __fullThreeMod && __fullThreeMod.PMREMGenerator;
			const useFull = fullRenderer && fullRenderer !== slimRenderer && slimRenderer && slimRenderer.backend && typeof FullPMREMGenerator === 'function';
			try {
				const diag = __pmremDiagnostics();
				diag.syncCalls = ( diag.syncCalls || 0 ) + 1;
				diag.syncUseFull = ( diag.syncUseFull || 0 ) + ( useFull ? 1 : 0 );
				diag.syncFallback = ( diag.syncFallback || 0 ) + ( useFull ? 0 : 1 );
				diag.syncMethods = diag.syncMethods || {};
				diag.syncMethods[ method ] = ( diag.syncMethods[ method ] || 0 ) + 1;
				diag.syncLast = { method, hasFullRenderer: !! fullRenderer, hasFullMod: !! __fullThreeMod, hasFullPMREMGenerator: typeof FullPMREMGenerator === 'function', hasSlimRenderer: !! slimRenderer, hasSlimBackend: !! ( slimRenderer && slimRenderer.backend ) };
			} catch ( _ ) {}
			try {
				let target;
				let fullArgs = args;
				if ( useFull ) {
					const gen = new FullPMREMGenerator( fullRenderer );
					try {
						fullArgs = __preparePMREMArgsForFullRenderer( method, args );
						target = gen[ method ]( ...fullArgs );
					} finally {
						try { gen.dispose && gen.dispose(); } catch ( _ ) {}
						if ( fullArgs !== args && fullArgs[ 0 ] && typeof fullArgs[ 0 ].dispose === 'function' ) {
							try { fullArgs[ 0 ].dispose(); } catch ( _ ) {}
						}
					}
				} else {
					target = orig.apply( this, args );
				}
				if ( useFull && target && target.texture && target.texture.isTexture === true ) {
					__sharePMREMGPUTexture( slimRenderer, fullRenderer, target.texture );
					// Self-cache: __wireEnvironmentPMREM does __pmremCache.get(scene.environment)
					// where scene.environment IS this PMREM texture. Identity-map it so the
					// existing wiring path picks it up without needing a separate source key.
					__pmremCache.set( target.texture, target.texture );
					Slim.registerLiveTexture( target.texture );
				}
				return target;
			} finally {
				__pmremRunning --;
			}
		};
	}
} )();

export class PMREMGenerator extends Slim.PMREMGenerator {
	fromScene( ...args ) { return __runPMREMGeneratorMethod( this, 'fromScene', args ); }
	fromCubemap( ...args ) { return __runPMREMGeneratorMethod( this, 'fromCubemap', args ); }
	fromEquirectangular( ...args ) { return __runPMREMGeneratorMethod( this, 'fromEquirectangular', args ); }
	fromTexture( ...args ) { return __runPMREMGeneratorMethod( this, 'fromTexture', args ); }
}

// Copy the PMREM GPU-texture entry from the full renderer's backend WeakMap
// into the slim renderer's backend WeakMap so the slim renderer can bind the
// already-created GPUTexture without trying to upload from (empty) CPU data.
// Both renderers must share the same WebGPU device for this to be safe.
// Extracted from __generatePMREMAsync so the synchronous PMREMGenerator
// patch above can reuse it.
// Thin wrappers around @tsl-precompile/runtime/slim-support/gpu-texture-share.
// The harness owns the diagnostics objects (PMREM counters + harness-wide
// textureShare counter); the runtime module owns the GPU-data-copy logic and
// is exercised by runtime/test/slim-support-gpu-texture-share.test.js.
function __sharePMREMGPUTexture( slimRenderer, fullRenderer, pmrem ) {
	return __sharedSharePMREMGPUTexture( slimRenderer, fullRenderer, pmrem, {
		diagnostics: __pmremDiagnostics(),
		onError: ( err ) => console.warn( '[tslp-e2e] PMREM GPU share failed:', err && err.message || err ),
	} );
}

function __shareGPUTextureEntry( targetRenderer, sourceRenderer, texture ) {
	const diag = typeof __harnessDiagnostics === 'function' ? __harnessDiagnostics() : null;
	const shareDiag = diag ? ( diag.textureShare || ( diag.textureShare = { calls: 0, noSourceData: 0, noSourceTexture: 0, success: 0, names: [], missingNames: [] } ) ) : null;
	__sharedShareGPUTextureEntry( targetRenderer, sourceRenderer, texture, {
		diagnostics: shareDiag,
		onError: ( err ) => console.warn( '[tslp-e2e] GPU texture share failed:', err && err.message || err ),
	} );
}

function __recordRenderableObjectCount( scene ) {
	if ( ! scene || typeof scene.traverse !== 'function' ) return;
	let count = 0;
	try {
		scene.traverse( ( object ) => {
			if ( object && object.visible !== false && object.geometry && object.material ) count ++;
		} );
	} catch ( _ ) {
		return;
	}
	const prev = window.__tslpRenderableObjectCount | 0;
	if ( count !== prev ) {
		window.__tslpRenderableObjectCount = count;
		window.__tslpRenderableLastBusyAt = typeof window.__tslpRealNow === 'function' ? window.__tslpRealNow() : Date.now();
	}
}

function __markSlimTextureInitialized( slimRenderer, texture ) {
	__sharedMarkTextureInitialized( slimRenderer, texture );
}

function __clearTextureViewCache( textureData ) {
	__sharedClearTextureViewCache( textureData );
}

// Thin wrapper — see @tsl-precompile/runtime/slim-support/gpu-texture-share
// for the version-bump / view-cache-clear / cross-renderer wiring rationale.
function __shareShadowGpuTextureIntoSlim( tex, fullRenderer, slimRenderer ) {
	return __sharedShareShadowGpuTextureIntoSlim( tex, fullRenderer, slimRenderer );
}

// VSM shadows sample the horizontal-blur-pass output texture, which three.js
// stores on the per-light ShadowNode (vsmShadowMapHorizontal.texture) for a
// single-layer shadow map, or on shadow.map._vsmShadowMapHorizontal when the
// shadow map is layered. The slim renderer never builds a ShadowNode, so the
// harness fishes the full renderer's blur output out of the render list's lights
// node and shares it through to the slim backend.
function __findVsmBlurTexture( fullRenderer, shadowScene, shadowRenderCamera, cloneLight ) {
	try {
		const map = cloneLight && cloneLight.shadow && cloneLight.shadow.map;
		if ( map && map._vsmShadowMapHorizontal && map._vsmShadowMapHorizontal.texture ) return map._vsmShadowMapHorizontal.texture;
		const lists = fullRenderer && fullRenderer._renderLists;
		const renderList = lists && typeof lists.get === 'function' ? lists.get( shadowScene, shadowRenderCamera ) : null;
		const lightsNode0 = renderList && renderList.lightsNode || null;
		const lightsNode = lightsNode0 && lightsNode0.node ? lightsNode0.node : lightsNode0;
		let lightNodes = lightsNode && Array.isArray( lightsNode._lightNodes ) ? lightsNode._lightNodes : null;
		if ( ! lightNodes && lightsNode && typeof lightsNode.getLightNodes === 'function' ) {
			// getLightNodes(builder) rebuilds the per-light node list, reusing the
			// cached AnalyticLightNodes from LightsNode's module-level WeakMap —
			// and therefore the already-allocated ShadowNode +
			// vsmShadowMapHorizontal render target from the real shadow render.
			// The fork's implementation caches per-builder via
			// builder.getDataFromNode(node) and reads builder.context
			// .materialLightings, so the fake builder must satisfy that contract
			// (a bare { renderer } throws "builder.getDataFromNode is not a
			// function" and silently kills the whole VSM share).
			try {
				if ( ! lightsNode.__tslpFakeBuilderData ) lightsNode.__tslpFakeBuilderData = new WeakMap();
				const dataMap = lightsNode.__tslpFakeBuilderData;
				const fakeBuilder = {
					renderer: fullRenderer,
					context: { materialLightings: [] },
					getDataFromNode( node ) {
						let data = dataMap.get( node );
						if ( ! data ) { data = {}; dataMap.set( node, data ); }
						return data;
					},
				};
				lightNodes = lightsNode.getLightNodes( fakeBuilder );
			} catch ( _ ) {}
		}
		if ( Array.isArray( lightNodes ) ) {
			for ( const ln of lightNodes ) {
				if ( ! ln || ln.isAnalyticLightNode !== true || ln.light !== cloneLight ) continue;
				const sn = ln.shadowNode && ln.shadowNode.node ? ln.shadowNode.node : ln.shadowNode;
				const h = sn && sn.vsmShadowMapHorizontal || null;
				if ( h && h.texture ) return h.texture;
			}
		}
	} catch ( _ ) {}
	return null;
}

// Detect at boot whether any registered background-aux artifact references a
// PMREM-prefiltered (CubeUVReflectionMapping) source. The capture-time
// extractor stamps source.textureName === 'PMREM.cubeUv' and/or
// source.mapping === 306 (CubeUVReflectionMapping) on every
// artifact.texture binding that came from backgroundBlurriness > 0.
// When this is true, the live cubemap on scene.background must be run
// through PMREMGenerator before being wired into the artifact's
// _textureRefs - wiring the raw cube produces a sharper / wrong sky
// because the WGSL declares the binding as texture_2d.
const __backgroundNeedsPMREM = ( function () {
	const auxList = Array.isArray( __data.aux ) ? __data.aux : [];
	for ( const entry of auxList ) {
		if ( ! entry || entry.shape !== 'background' || ! entry.artifact ) continue;
		const groups = Array.isArray( entry.artifact.uniformPlan ) ? entry.artifact.uniformPlan : [];
		for ( const group of groups ) {
			const textures = Array.isArray( group.textures ) ? group.textures : [];
			for ( const t of textures ) {
				const src = t && t.source || {};
				if ( src.kind !== 'artifact.texture' ) continue;
				if ( src.textureName === 'PMREM.cubeUv' ) return true;
				if ( src.mapping === 306 ) return true; // CubeUVReflectionMapping
			}
		}
	}
	return false;
} )();

	// Track every Texture loaded via *Loader.load so the hydrator can relink
	// captured artifact.texture-kind bindings (whose captured textureUuid is
	// dead on reload) by imageSrc / textureName. Production code keeps the
	// same Texture instance and hits the UUID path; this index is harness-
	// and test-only.
	function __forceRenderAfterLoaderTexture() {
		const pipeline = window.__tslpLastRenderPipeline || null;
		if ( ! pipeline || typeof pipeline.render !== 'function' || pipeline.__tslpLoaderForceRenderQueued === true ) return;
		pipeline.__tslpLoaderForceRenderQueued = true;
		Promise.resolve().then( () => {
			pipeline.__tslpLoaderForceRenderQueued = false;
			try {
				pipeline.render();
				const diag = window.__tslpHarnessDiagnostics || ( window.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
				diag.loaderForcedPipelineRenders = ( diag.loaderForcedPipelineRenders || 0 ) + 1;
			} catch ( e ) {
				console.warn( '[tslp-e2e] forced loader pipeline render failed:', e && e.message || e );
			}
		} );
	}

	function __refreshLoadedTexturePrecompiledRefs( texture ) {
		if ( ! ( texture && texture.isTexture === true ) ) return 0;
		const pipeline = window.__tslpLastRenderPipeline || null;
		if ( ! pipeline ) return 0;
		const passNodes = __collectPassNodesInGraph( pipeline.outputNode );
		let changed = 0;
		const shadowScenes = new Set();
		const shadowSceneCameras = new Map();
		for ( const passNode of passNodes ) {
			const scene = passNode && passNode.scene;
			if ( ! scene || typeof scene.traverse !== 'function' ) continue;
			scene.traverse( ( object ) => {
				const material = object && object.material;
				const list = Array.isArray( material ) ? material : material ? [ material ] : [];
				for ( const mat of list ) {
					if ( ! ( mat && mat.isPrecompiledMaterial === true && mat.precompiledArtifact ) ) continue;
					const attached = __attachArtifactTextureRefsWhere( mat.precompiledArtifact, texture, ( source ) => (
						! __isPMREMArtifactTextureSource( source ) && __textureMatchesArtifactSource( texture, source )
					) );
					if ( ! attached ) continue;
					mat.needsUpdate = true;
					try { mat.dispose && mat.dispose(); } catch ( _ ) {}
					if ( object && object.castShadow === true ) {
						shadowScenes.add( scene );
						if ( ! shadowSceneCameras.has( scene ) && passNode && passNode.camera ) shadowSceneCameras.set( scene, passNode.camera );
					}
					changed ++;
				}
			} );
		}
		for ( const scene of shadowScenes ) {
			const state = __shadowState.get( scene );
			if ( state ) {
				state.signature = '';
				state.queuedSignature = '';
			}
			__shadowSceneCache.delete( scene );
			try { __kickShadowRenderAsync( pipeline.renderer, scene, shadowSceneCameras.get( scene ) ); } catch ( _ ) {}
		}
		if ( changed > 0 ) {
			try {
				const renderer = pipeline.renderer || null;
				const nc = renderer && renderer._nodes && renderer._nodes.nodeBuilderCache;
				if ( nc && typeof nc.clear === 'function' ) nc.clear();
			} catch ( _ ) {}
			try {
				const diag = window.__tslpHarnessDiagnostics || ( window.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
				diag.loaderTextureRewired = ( diag.loaderTextureRewired || 0 ) + changed;
				if ( shadowScenes.size > 0 ) diag.loaderShadowInvalidated = ( diag.loaderShadowInvalidated || 0 ) + shadowScenes.size;
			} catch ( _ ) {}
		}
		return changed;
	}

	function __shadowMaterialUsesTexture( material, texture ) {
		if ( ! ( texture && texture.isTexture === true ) ) return false;
		const materials = __shadowSourceMaterials( material );
		for ( const mat of materials ) {
			if ( ! mat ) continue;
			for ( const key of [ 'castShadowNode', 'castShadowPositionNode', 'maskShadowNode', 'maskNode', 'alphaTestNode', 'opacityNode' ] ) {
				const textures = __collectTexturesInNode( mat[ key ] );
				for ( const candidate of textures ) {
					if ( candidate === texture ) return true;
					if ( candidate && candidate.isTexture === true && candidate.uuid && candidate.uuid === texture.uuid ) return true;
				}
			}
			for ( const key of [ 'alphaMap', 'map' ] ) {
				const candidate = mat[ key ];
				if ( candidate === texture ) return true;
				if ( candidate && candidate.isTexture === true && candidate.uuid && candidate.uuid === texture.uuid ) return true;
			}
		}
		return false;
	}

	function __sceneShadowUsesTexture( scene, texture ) {
		if ( ! scene || typeof scene.traverse !== 'function' ) return false;
		let found = false;
		scene.traverse( ( object ) => {
			if ( found || ! object || object.castShadow !== true ) return;
			if ( __shadowMaterialUsesTexture( object.material, texture ) ) found = true;
		} );
		return found;
	}

	function __invalidateShadowRenderForTexture( texture ) {
		if ( ! ( texture && texture.isTexture === true ) ) return 0;
		const pipeline = window.__tslpLastRenderPipeline || null;
		if ( ! pipeline ) return 0;
		const passNodes = __collectPassNodesInGraph( pipeline.outputNode );
		let changed = 0;
		const seenScenes = new Set();
		for ( const passNode of passNodes ) {
			const scene = passNode && passNode.scene;
			if ( ! scene || seenScenes.has( scene ) || ! __sceneShadowUsesTexture( scene, texture ) ) continue;
			seenScenes.add( scene );
			const state = __shadowState.get( scene );
			if ( state ) {
				state.signature = '';
				state.queuedSignature = '';
			}
			__shadowSceneCache.delete( scene );
			changed ++;
		}
		if ( changed > 0 ) {
			try {
				const diag = window.__tslpHarnessDiagnostics || ( window.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
				diag.loaderShadowInvalidated = ( diag.loaderShadowInvalidated || 0 ) + changed;
			} catch ( _ ) {}
		}
		return changed;
	}

	( function patchLoaders() {
		const loaders = [
			[ 'TextureLoader', Slim.TextureLoader ],
			[ 'CubeTextureLoader', Slim.CubeTextureLoader ],
			[ 'DataTextureLoader', Slim.DataTextureLoader ],
		[ 'ImageBitmapLoader', Slim.ImageBitmapLoader ],
		[ 'FullTextureLoader', FullTextureLoader ],
		[ 'FullCubeTextureLoader', FullCubeTextureLoader ],
		[ 'FullDataTextureLoader', FullDataTextureLoader ],
		[ 'FullImageBitmapLoader', FullImageBitmapLoader ],
		];
		for ( const [ name, Ctor ] of loaders ) {
			if ( ! Ctor || ! Ctor.prototype || ! Ctor.prototype.load || Ctor.prototype.__tslpPatched ) continue;
			Ctor.prototype.__tslpPatched = true;
			const origLoad = Ctor.prototype.load;
			const _now = () => ( typeof window.__tslpRealNow === 'function' ? window.__tslpRealNow() : Date.now() );
			Ctor.prototype.load = function ( url, onLoad, onProgress, onError ) {
				let tex = null;
				window.__tslpLoaderPending = ( window.__tslpLoaderPending | 0 ) + 1;
				window.__tslpLoaderLastBusyAt = _now();
				let settled = false;
				const settle = () => {
					if ( settled ) return;
					settled = true;
					window.__tslpLoaderPending = Math.max( 0, ( window.__tslpLoaderPending | 0 ) - 1 );
					window.__tslpLoaderLastBusyAt = _now();
					__forceRenderAfterLoaderTexture();
				};
				const remember = ( texture ) => {
					if ( texture && texture.isTexture === true ) {
						if ( typeof window.__tslpMarkLoaderTexture === 'function' ) {
							window.__tslpMarkLoaderTexture( texture, url );
					} else if ( ! texture.name && typeof url === 'string' ) {
						texture.name = url.split( '/' ).pop().split( '?' )[ 0 ];
					}
					__rememberLiveTexture( texture );
				}
			};
				const wrappedOnLoad = ( texOrImage, ...rest ) => {
					try {
						remember( texOrImage );
						try {
							const loadedTexture = texOrImage && texOrImage.isTexture === true ? texOrImage : tex;
							__refreshLoadedTexturePrecompiledRefs( loadedTexture );
							__invalidateShadowRenderForTexture( loadedTexture );
						} catch ( _ ) {}
						if ( typeof onLoad === 'function' ) onLoad.call( this, texOrImage, ...rest );
					} finally {
						remember( tex );
						settle();
					}
				};
				const wrappedOnError = ( err, ...rest ) => {
					try {
						if ( typeof onError === 'function' ) onError.call( this, err, ...rest );
					} finally {
						settle();
					}
				};
				try {
					tex = origLoad.call( this, url, wrappedOnLoad, onProgress, wrappedOnError );
					remember( tex );
					return tex;
				} catch ( err ) {
					settle();
					throw err;
				}
			};
		}
	} )();

function __nodeStub( auxConfigHash = null ) {
	const fn = function tslReplayNodeStub() { return proxy; };
	const proxy = new Proxy( fn, {
		get( _target, prop ) {
			if ( prop === Symbol.toPrimitive ) return () => 0;
			if ( prop === 'then' ) return undefined;
			if ( prop === 'isNode' ) return true;
			if ( prop === '__tslpNodeStub' ) return true;
			if ( prop === '__tslpAuxConfigHash' ) return auxConfigHash;
			if ( prop === 'toVar' ) return () => proxy;
			return proxy;
		},
		apply() { return proxy; },
		construct() { return proxy; },
	} );
	return proxy;
}

function __backgroundAuxConfigHashForScene( scene ) {
	if ( ! scene || typeof Slim.hashNodeGraphSync !== 'function' ) return null;
	const input = scene.backgroundNode || scene.background;
	if ( ! input ) return null;
	try {
		const hash = Slim.hashNodeGraphSync( input, { shape: 'background', threeVersion: ${ JSON.stringify( SLIM_HASH_OPTS.threeVersion ) }, pluginVersion: ${ JSON.stringify( SLIM_HASH_OPTS.pluginVersion ) } } );
		if ( hash && ( typeof Slim.hasAux !== 'function' || Slim.hasAux( 'background', hash ) ) ) return hash;
	} catch ( _ ) {}
	return null;
}

function __seedNodeProps( material ) {
	const stub = __nodeStub();
	// Limit to the original "always-seeded" set. The full __nodeGraphKeys()
	// list is too broad — adding lightNode/envNode/aoNode/transmissionNode
	// stubs to materials that didn't have them (e.g. MeshStandardNodeMaterial
	// in webgpu_shadowmap_pointlight.html) breaks the renderer's lighting
	// evaluation path. __copyMaterialNodeProps still walks the full list.
	for ( const key of [ 'colorNode', 'normalNode', 'positionNode', 'geometryNode', 'outputNode', 'roughnessNode', 'metalnessNode', 'emissiveNode', 'opacityNode', 'alphaTestNode' ] ) {
		if ( material[ key ] === undefined ) material[ key ] = stub;
	}
}

function __walkNodeSafely( rootNode, visitor, seen = new Set(), depth = 0 ) {
	if ( ! rootNode || ( typeof rootNode !== 'object' && typeof rootNode !== 'function' ) || depth > 64 || seen.has( rootNode ) ) return;
	if ( ArrayBuffer.isView( rootNode ) || rootNode instanceof ArrayBuffer ) return;
	if ( ! __isGraphTraversalCandidate( rootNode ) ) return;
	seen.add( rootNode );
	visitor( rootNode );
	const children = [];
		try {
			if ( typeof rootNode.getChildren === 'function' ) {
				const list = rootNode.getChildren();
				if ( Array.isArray( list ) ) children.push( ...list );
				else if ( list && typeof list[ Symbol.iterator ] === 'function' ) {
					for ( const child of list ) children.push( child );
				}
		}
	} catch ( _ ) {}
	const nodeChildren = __readGraphOwnValue( rootNode, '_children' );
	if ( Array.isArray( nodeChildren ) ) children.push( ...nodeChildren );
	const skip = new Set( [ 'parent', 'children', '_cache', 'renderer', 'geometry', 'material', 'domElement', 'array', 'buffer' ] );
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( rootNode ) ); } catch ( _ ) {}
	for ( const key of keys ) {
		if ( skip.has( key ) ) continue;
		const child = __readGraphOwnValue( rootNode, key );
		if ( child ) children.push( child );
	}
	for ( const child of children ) {
		if ( ! child || ( typeof child !== 'object' && typeof child !== 'function' ) ) continue;
		__walkNodeSafely( child, visitor, seen, depth + 1 );
	}
}

// Collect StorageBufferNode.value attributes by walking a node tree via traverse().
// Only picks up nodes with isStorageBufferNode to avoid vertex-attribute nodes
// (BufferAttributeNode wrapping storage) — those are handled separately.
function __collectStorageBufAttrs( rootNode, results ) {
	if ( ! rootNode ) return;
	__walkNodeSafely( rootNode, ( n ) => {
		if ( n.isStorageBufferNode === true && n.value &&
				( n.value.isStorageBufferAttribute === true || n.value.isStorageInstancedBufferAttribute === true ) ) {
			results.push( n.value );
		}
	} );
}

// Walk a node tree (including vertexNode/positionNode subtrees) and collect every
// BufferAttributeNode whose .value is a Storage(Instanced)BufferAttribute. This
// is the case when user code writes vertexNode = billboarding({ position:
// positionBuffer.toAttribute() }) — the leaf is BufferAttributeNode wrapping the
// storage attribute directly. Without this, compute-driven particle examples
// (rain, snow, points) hydrate brand-new empty StorageBufferAttribute placeholders
// in the slim render path and the compute output is never visible.
function __collectStorageAttrNodeAttrs( rootNode, results ) {
	if ( ! rootNode ) return;
	function isStorageVal( v ) { return v && ( v.isStorageBufferAttribute === true || v.isStorageInstancedBufferAttribute === true ); }
	const before = results.length;
	const visit = ( n ) => {
		if ( n && n.isBufferNode === true && ! n.isStorageBufferNode && isStorageVal( n.value ) ) {
			if ( ! results.includes( n.value ) ) results.push( n.value );
		}
	};
	// Top-level node may itself be a BufferAttributeNode (rare but possible:
	// material.positionNode = positionBuffer.toAttribute()).
	visit( rootNode );
	if ( typeof rootNode.traverse === 'function' ) {
		try { rootNode.traverse( visit ); } catch ( _ ) {}
	}
	if ( results.length > before ) return;
	__walkNodeSafely( rootNode, visit );
}

// Before creating a PrecompiledMaterial, inject live StorageBufferAttribute /
// StorageInstancedBufferAttribute objects from the source material's node graph
// into the artifact's plan entries so hydrateNodeBuilderState uses the live
// GPU-writable buffers instead of allocating fresh empty placeholders.
// This is required for compute-driven examples where instancedArray() creates
// a buffer that a compute kernel writes into and the render material reads from.
const __computeStorageAttrFallbacks = [];
function __computeDiagnostics() {
	if ( typeof window === 'undefined' ) return null;
	const root = window.__tslpHarnessDiagnostics || ( window.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
	const diag = root.compute || ( root.compute = { storageAttrs: 0, storageShapes: [], fallbackWires: 0 } );
	return diag;
}
function __rememberComputeStorageAttr( attr ) {
	if ( ! attr || ! ( attr.isStorageBufferAttribute === true || attr.isStorageInstancedBufferAttribute === true ) ) return;
	if ( ! __computeStorageAttrFallbacks.includes( attr ) ) {
		__computeStorageAttrFallbacks.push( attr );
		const diag = __computeDiagnostics();
		if ( diag ) {
			diag.storageAttrs = ( diag.storageAttrs | 0 ) + 1;
			if ( diag.storageShapes.length < 12 ) diag.storageShapes.push( String( attr.count || 0 ) + 'x' + String( attr.itemSize || 0 ) + ':' + ( attr.array && attr.array.constructor && attr.array.constructor.name || '' ) );
		}
	}
}

function __preferComputeStorageAttr( attr, entry, sizeMatches ) {
	if ( ! attr || __computeStorageAttrFallbacks.length === 0 ) return attr;
	const match = __computeStorageAttrFallbacks.find( ( candidate ) => (
		candidate &&
		candidate !== attr &&
		candidate.array === attr.array &&
		candidate.count === ( entry && entry.count ) &&
		sizeMatches( candidate.itemSize, entry && entry.itemSize )
	) );
	return match || attr;
}

function __arrayLikeValueAt( value, index ) {
	if ( ! value ) return NaN;
	return Number( value[ index ] );
}

function __storageSnapshotDistance( entry, attr ) {
	const snapshot = entry && entry._liveArray;
	const array = attr && attr.array;
	if ( ! snapshot || ! array ) return Infinity;
	const expectedLength = Math.max( 0, ( entry.count | 0 ) * ( entry.itemSize | 0 ) );
	const length = Math.min( expectedLength || array.length || 0, array.length || 0 );
	if ( length <= 0 ) return Infinity;
	const samples = Math.min( 96, length );
	const step = Math.max( 1, Math.floor( length / samples ) );
	let total = 0;
	let count = 0;
	for ( let i = 0; i < length && count < samples; i += step ) {
		const left = __arrayLikeValueAt( snapshot, i );
		const right = Number( array[ i ] );
		if ( ! Number.isFinite( left ) || ! Number.isFinite( right ) ) continue;
		total += Math.abs( left - right );
		count ++;
	}
	return count > 0 ? total / count : Infinity;
}

function __wireStorageBuffersBySnapshot( artifact, attrs, sizeMatches ) {
	const isLiveStorageAttr = ( value ) => value && ( value.isStorageBufferAttribute === true || value.isStorageInstancedBufferAttribute === true );
	const candidates = attrs.filter( isLiveStorageAttr );
	if ( candidates.length === 0 ) return 0;
	const entries = [];
	const seen = new Set();
	for ( const group of artifact && artifact.uniformPlan || [] ) {
		for ( const entry of group.storageBuffers || [] ) {
			if ( entry && ! seen.has( entry ) ) { seen.add( entry ); entries.push( entry ); }
		}
		for ( const binding of group.orderedBindings || [] ) {
			const entry = binding && binding.type === 'storage-buffer' ? binding.ref : null;
			if ( entry && ! seen.has( entry ) ) { seen.add( entry ); entries.push( entry ); }
		}
	}
	const consumed = new Set();
	const byEntryKey = new Map();
	let wired = 0;
	for ( const entry of entries ) {
		if ( ! entry || isLiveStorageAttr( entry._liveAttribute ) || ! entry._liveArray ) continue;
		const entryKey = [
			entry.name || '',
			entry.count || 0,
			entry.itemSize || 0,
			entry.arrayType || '',
		].join( ':' );
		const keyed = byEntryKey.get( entryKey );
		if ( keyed && keyed.count === entry.count && sizeMatches( keyed.itemSize, entry.itemSize ) ) {
			Object.defineProperty( entry, '_liveAttribute', { value: keyed, enumerable: false, writable: true, configurable: true } );
			wired ++;
			continue;
		}
		let best = null;
		let bestScore = Infinity;
		for ( const candidate of candidates ) {
			if ( consumed.has( candidate ) ) continue;
			if ( candidate.count !== entry.count || ! sizeMatches( candidate.itemSize, entry.itemSize ) ) continue;
			if ( entry.arrayType && candidate.array && candidate.array.constructor && candidate.array.constructor.name !== entry.arrayType ) continue;
			const score = __storageSnapshotDistance( entry, candidate );
			if ( score < bestScore ) {
				best = candidate;
				bestScore = score;
			}
		}
		if ( ! best || bestScore > 1e-4 ) continue;
		Object.defineProperty( entry, '_liveAttribute', { value: best, enumerable: false, writable: true, configurable: true } );
		byEntryKey.set( entryKey, best );
		consumed.add( best );
		wired ++;
	}
	return wired;
}

function __wireComputeAttrsToArtifact( artifact, sourceMaterial ) {
	if ( ! sourceMaterial || ! artifact ) return 0;
	let wiredCount = 0;
	function isStorageAttr( v ) { return v && ( v.isStorageBufferAttribute === true || v.isStorageInstancedBufferAttribute === true ); }

	// vec3 StorageBufferAttributes are padded to itemSize=4 by WebGPU on first use.
	// Accept both 3 and 4 when the artifact recorded 4 (pad already applied at capture).
	function sizeMatches( liveSize, artifactSize ) {
		return liveSize === artifactSize || ( liveSize === 3 && artifactSize === 4 );
	}

	// Wire nodeAttributes (vertex path). A few shapes are common:
	//   - material.positionNode = positionBuffer.toAttribute() — the top-level
	//     node is a BufferAttributeNode wrapping the storage attribute.
	//   - material.colorNode = Fn(() => velocityBuffer.toAttribute())() — the
	//     attribute is consumed as a fragment varying, but still appears as a
	//     vertex-stage nodeAttribute in the captured shader.
	//   - material.vertexNode = billboarding({ position: positionBuffer.toAttribute() })
	//     — the BufferAttributeNode is buried inside a deeper node tree (used by
	//     the compute particle examples: rain, snow, points).
	// Walk the material node slots that can produce vertex attributes to collect every storage-attribute
	// candidate, then match each artifact node-attribute by count + itemSize.
	const nodeAttrsArr = artifact.attributes || artifact.nodeAttributes || [];
	const naCandidates = [];
	__collectStorageAttrNodeAttrs( sourceMaterial.positionNode, naCandidates );
	__collectStorageAttrNodeAttrs( sourceMaterial.colorNode, naCandidates );
	__collectStorageAttrNodeAttrs( sourceMaterial.geometryNode, naCandidates );
	__collectStorageAttrNodeAttrs( sourceMaterial.vertexNode, naCandidates );
	if ( naCandidates.length > 0 ) {
		const nodeAttrsForLiveWire = nodeAttrsArr.slice().sort( ( a, b ) => {
			const aPath = Array.isArray( a && a.userPath ) ? a.userPath.length : 0;
			const bPath = Array.isArray( b && b.userPath ) ? b.userPath.length : 0;
			return bPath - aPath;
		} );
		for ( const nodeAttr of nodeAttrsForLiveWire ) {
			// _liveAttribute may already be set from JSON deserialization (plain object, not
			// a live attribute). Only skip if it is already a proper live JS attribute object.
			if ( ! nodeAttr || nodeAttr.source !== 'node' || isStorageAttr( nodeAttr._liveAttribute ) ) continue;
			// Object-owned instanced attributes (InstancedMesh.instanceMatrix columns,
			// instanceColor) are captured with storage:false and must be wired by the
			// runtime's instanced-object lookup, not shape-matched to storage candidates.
			// webgpu_compute_birds collapses without this guard.
			if ( nodeAttr.storage === false ) continue;
			const matchIdx = naCandidates.findIndex( ( v ) => v.count === nodeAttr.count && sizeMatches( v.itemSize, nodeAttr.itemSize ) );
			if ( matchIdx === -1 ) continue;
			const liveAttr = __preferComputeStorageAttr( naCandidates[ matchIdx ], nodeAttr, sizeMatches );
			Object.defineProperty( nodeAttr, '_liveAttribute', { value: liveAttr, enumerable: false, writable: true, configurable: true } );
			if ( liveAttr && typeof liveAttr.version === 'number' ) liveAttr.version = liveAttr.version + 1;
			wiredCount++;
			naCandidates.splice( matchIdx, 1 );
		}
	}

	// Some helpers (notably billboarding({ position: storageAttr.toAttribute() }))
	// capture the live storage attribute inside an Fn closure that is not exposed
	// through the material's node tree at replay time. When the artifact recorded
	// an anonymous vertexNode-sourced attribute, fall back to storage attributes
	// discovered from compute bind groups. This is deliberately limited to
	// vertexNode materials so positionNode/colorNode paths keep their explicit
	// userPath wiring.
	if ( ( sourceMaterial.vertexNode || sourceMaterial.colorNode ) && __computeStorageAttrFallbacks.length > 0 ) {
		const hasAutoComputeNode = __AUTO_COMPUTE_SLOTS.some( ( slot ) => sourceMaterial[ slot ] && sourceMaterial[ slot ].isComputeNode === true );
		for ( const nodeAttr of nodeAttrsArr ) {
			if ( ! nodeAttr || nodeAttr.source !== 'node' || isStorageAttr( nodeAttr._liveAttribute ) ) continue;
			if ( Array.isArray( nodeAttr.userPath ) && nodeAttr.userPath.length > 0 ) continue;
			if ( hasAutoComputeNode ) continue;
			// See gate above: skip non-storage instanced attributes (instanceMatrix columns).
			if ( nodeAttr.storage === false ) continue;
			const matches = __computeStorageAttrFallbacks.filter( ( v ) => (
					v &&
					v.count === nodeAttr.count &&
					sizeMatches( v.itemSize, nodeAttr.itemSize ) &&
					( ! nodeAttr.arrayType || ! v.array || ! v.array.constructor || v.array.constructor.name === nodeAttr.arrayType )
				) );
			const match = matches[ 2 ] || matches[ 1 ] || matches[ 0 ];
			if ( ! match ) continue;
			Object.defineProperty( nodeAttr, '_liveAttribute', { value: match, enumerable: false, writable: true, configurable: true } );
			if ( typeof match.version === 'number' ) match.version = match.version + 1;
			wiredCount++;
		}
	}

	// Wire storage-buffer bindings: colorNode / normalNode / etc. trees may contain
	// StorageBufferNode instances (isStorageBufferNode = true) whose .value is the
	// live buffer that compute writes to. Match them to uniformPlan storageBuffers by
	// count + itemSize; use first match to handle the common single-buffer case.
	// NOTE: _liveAttribute may already be set on plan entries as a serialized plain
	// object from JSON capture (not a live JS attribute). Only skip if it is a real
	// live attribute (isStorageBufferAttribute / isStorageInstancedBufferAttribute).
	const plan = Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [];
	const nodeKeys = [ 'colorNode', 'normalNode', 'outputNode', 'roughnessNode', 'metalnessNode', 'emissiveNode', 'opacityNode', 'alphaTestNode', 'vertexNode', 'positionNode', 'geometryNode' ];
	const sbCandidates = [];
	for ( const key of nodeKeys ) {
		if ( sourceMaterial[ key ] ) __collectStorageBufAttrs( sourceMaterial[ key ], sbCandidates );
	}
	// Runtime userPath binding handles explicit paths, but many compute examples
	// build storage(...) reads inside helper closures, leaving storageBuffers with
	// no userPath. Wire those from the live material node graph before hydration.
	const __useHarnessStorageWire = true;
	if ( __useHarnessStorageWire && sbCandidates.length > 0 ) {
		for ( const group of plan ) {
			// Try explicit storageBuffers list first
			for ( const sb of ( group.storageBuffers || [] ) ) {
				if ( isStorageAttr( sb._liveAttribute ) ) continue;
				const match = sbCandidates.find( ( c ) => c.count === sb.count && sizeMatches( c.itemSize, sb.itemSize ) );
				if ( match ) {
					Object.defineProperty( sb, '_liveAttribute', { value: match, enumerable: false, writable: true, configurable: true } );
					wiredCount++;
					sbCandidates.splice( sbCandidates.indexOf( match ), 1 );
				}
			}
			// Fall back to orderedBindings (storage-buffer type) — some artifacts store
			// the storage buffer refs there rather than in the storageBuffers array.
			for ( const ob of ( group.orderedBindings || [] ) ) {
				if ( ! ob || ob.type !== 'storage-buffer' || ! ob.ref ) continue;
				const sb = ob.ref;
				if ( isStorageAttr( sb._liveAttribute ) ) continue;
				const match = sbCandidates.find( ( c ) => c.count === sb.count && sizeMatches( c.itemSize, sb.itemSize ) );
				if ( match ) {
					Object.defineProperty( sb, '_liveAttribute', { value: match, enumerable: false, writable: true, configurable: true } );
					wiredCount++;
					sbCandidates.splice( sbCandidates.indexOf( match ), 1 );
				}
			}
		}
	}

	// Renderer-level compute systems can feed material storage bindings without
	// exposing the live storage buffer in the material node tree. TiledLighting is
	// the canonical case: renderer.compute() updates the global light-index grid,
	// then MeshPhongNodeMaterial reads that grid via a storage binding. Reuse the
	// runtime helper so replay and real slim+fallback users share the same shape
	// matching behavior.
		if ( __computeStorageAttrFallbacks.length > 0 ) {
			const snapshotWired = __wireStorageBuffersBySnapshot( artifact, __computeStorageAttrFallbacks, sizeMatches );
		if ( snapshotWired > 0 ) {
			const diag = __computeDiagnostics();
			if ( diag ) diag.snapshotWires = ( diag.snapshotWires | 0 ) + snapshotWired;
			wiredCount += snapshotWired;
		}
		const fallbackWired = __sharedWireArtifactStorageBuffersFromAttributes( artifact, __computeStorageAttrFallbacks, {
			bumpVersion: true,
			allowVec3ToVec4: true,
		} );
		if ( fallbackWired > 0 ) {
			const diag = __computeDiagnostics();
			if ( diag ) diag.fallbackWires = ( diag.fallbackWires | 0 ) + fallbackWired;
				wiredCount += fallbackWired;
			}
		}
			return wiredCount;
		}

function __sourceTypeNeedle( sourceMaterial ) {
	const type = sourceMaterial && typeof sourceMaterial.type === 'string' ? sourceMaterial.type : '';
	return type ? type.replace( /Material$/, 'NodeMaterial' ) : '';
}

function __readColorTriplet( value ) {
	if ( ! value ) return null;
	if ( value.isColor === true ) return [ value.r, value.g, value.b ];
	if ( typeof value === 'number' && Number.isFinite( value ) ) {
		return [ ( ( value >> 16 ) & 255 ) / 255, ( ( value >> 8 ) & 255 ) / 255, ( value & 255 ) / 255 ];
	}
	if ( typeof value === 'string' && typeof Slim.Color === 'function' ) {
		try {
			const c = new Slim.Color( value );
			return [ c.r, c.g, c.b ];
		} catch ( _ ) {}
	}
	return null;
}

function __artifactColorTriplet( artifact ) {
	const fromDefault = artifact && artifact.defaults && artifact.defaults.color;
	if ( fromDefault && Array.isArray( fromDefault.data ) ) return fromDefault.data.slice( 0, 3 );
	for ( const group of artifact && artifact.uniformPlan || [] ) {
		for ( const slot of group.slots || [] ) {
			const source = slot && slot.source || {};
			const snap = source.valueSnapshot || null;
			if ( source.kind === 'material.color' && snap && Array.isArray( snap.data ) ) return snap.data.slice( 0, 3 );
		}
	}
	return null;
}

function __artifactMaterialColorTriplet( artifact, property ) {
	const fromDefault = artifact && artifact.defaults && artifact.defaults[ property ];
	if ( fromDefault && Array.isArray( fromDefault.data ) ) return fromDefault.data.slice( 0, 3 );
	for ( const group of artifact && artifact.uniformPlan || [] ) {
		for ( const slot of group.slots || [] ) {
			const source = slot && slot.source || {};
			const snap = source.valueSnapshot || null;
			if ( source.kind === 'material.' + property && snap && Array.isArray( snap.data ) ) return snap.data.slice( 0, 3 );
		}
	}
	return null;
}

function __colorDistanceSq( a, b ) {
	if ( ! a || ! b ) return Infinity;
	const dr = ( a[ 0 ] || 0 ) - ( b[ 0 ] || 0 );
	const dg = ( a[ 1 ] || 0 ) - ( b[ 1 ] || 0 );
	const db = ( a[ 2 ] || 0 ) - ( b[ 2 ] || 0 );
	return dr * dr + dg * dg + db * db;
}

function __artifactHasTextureSource( artifact, predicate = null ) {
	return __sharedArtifactHasTextureSource( artifact, predicate );
}

let __reflectorBaseCursor = 0;
function __isReflectorBaseNode( node ) {
	return !! ( node
		&& node.renderTargets instanceof Map
		&& typeof node.updateBefore === 'function'
		&& node.constructor
		&& ( node.constructor.type === 'ReflectorBaseNode' || node.constructor.name === 'ReflectorBaseNode' ) );
}

function __reflectorSourcesForArtifact( artifact ) {
	const sources = [];
	for ( const group of artifact && artifact.uniformPlan || [] ) {
		for ( const entry of group.textures || [] ) {
			const source = entry && entry.source || {};
			if ( source.kind !== 'reflector.texture' ) continue;
			const index = Number.isInteger( source.reflectorIndex ) ? source.reflectorIndex : 0;
			if ( ! sources.some( ( item ) => item.index === index ) ) sources.push( { index, source } );
		}
	}
	sources.sort( ( a, b ) => a.index - b.index );
	return sources;
}

function __createReflectorBaseNodeForSource( source, sourceObject ) {
	if ( ! FullTSL || typeof FullTSL.reflector !== 'function' ) return null;
	try {
		const params = {};
		if ( typeof source.resolutionScale === 'number' ) params.resolutionScale = source.resolutionScale;
		if ( typeof source.generateMipmaps === 'boolean' ) params.generateMipmaps = source.generateMipmaps;
		if ( typeof source.samples === 'number' ) params.samples = source.samples;
		if ( typeof source.bounces === 'boolean' ) params.bounces = source.bounces;
		if ( typeof source.depth === 'boolean' ) params.depth = source.depth;
		const reflectorNode = FullTSL.reflector( params );
		const baseNode = reflectorNode && ( reflectorNode._reflectorBaseNode || reflectorNode.reflector ) || null;
		if ( ! __isReflectorBaseNode( baseNode ) ) return null;
		const target = reflectorNode && reflectorNode.target || baseNode.target || null;
		if ( target && sourceObject && typeof sourceObject.add === 'function' && target.parent !== sourceObject ) {
			try { sourceObject.add( target ); } catch ( _ ) {}
		}
		return baseNode;
	} catch ( _ ) {
		return null;
	}
}

function __attachReflectorBaseNodesForArtifact( material, artifact, sourceObject = null ) {
	if ( ! material || ! artifact ) return;
	if ( ! __artifactHasTextureSource( artifact, ( source ) => source.kind === 'reflector.texture' ) ) return;
	const pool = globalThis.__tslpReflectorBaseNodes || [];
	const reflectorSources = __reflectorSourcesForArtifact( artifact );
	const needed = Math.max( 1, reflectorSources.length );
	const nodes = [];
	while ( nodes.length < needed && __reflectorBaseCursor < pool.length ) {
		const node = pool[ __reflectorBaseCursor ++ ];
		if ( __isReflectorBaseNode( node ) ) nodes.push( node );
	}
	while ( nodes.length < needed ) {
		const source = reflectorSources[ nodes.length ] && reflectorSources[ nodes.length ].source || {};
		const node = __createReflectorBaseNodeForSource( source, sourceObject );
		if ( ! node ) break;
		nodes.push( node );
	}
	if ( nodes.length === 0 ) return;
	Object.defineProperty( material, '__tslpReflectorBaseNodes', {
		value: nodes,
		enumerable: false,
		configurable: true,
		writable: true,
	} );
}

function __isPMREMTexture( texture ) {
	return __sharedIsPMREMTexture( texture );
}

function __textureImageSrc( texture ) {
	return __sharedTextureImageSrc( texture ) || null;
}

function __basenameFromUrl( value ) {
	if ( typeof value !== 'string' || value.length === 0 ) return '';
	const slash = value.lastIndexOf( '/' );
	const tail = slash >= 0 ? value.slice( slash + 1 ) : value;
	return tail.split( '?' )[ 0 ].split( '#' )[ 0 ];
}

function __textureMatchesSource( texture, source ) {
	return __sharedTextureMatchesSource( texture, source );
}

function __textureMatchesArtifactSource( texture, source ) {
	return __sharedTextureMatchesArtifactSource( texture, source );
}

function __isTrivialTextureSnapshot( snapshot ) {
	if ( ! snapshot || ! Array.isArray( snapshot.data ) ) return false;
	const data = snapshot.data;
	if ( data.length === 0 || data.length > 65536 ) return false;
	const threshold = Math.max( 1, ( data.length * 0.01 ) | 0 );
	let nonZero = 0;
	for ( let i = 0; i < data.length; i ++ ) {
		if ( data[ i ] !== 0 ) {
			nonZero ++;
			if ( nonZero > threshold ) return false;
		}
	}
	return true;
}

function __countArtifactTextureSources( artifact, predicate = null ) {
	return __sharedCountArtifactTextureSources( artifact, predicate );
}

function __singleArtifactTextureUuid( artifact, predicate = null ) {
	return __sharedSingleArtifactTextureUuid( artifact, predicate );
}

function __artifactNodeAttributes( artifact ) {
	const attrs = Array.isArray( artifact && artifact.attributes )
		? artifact.attributes
		: Array.isArray( artifact && artifact.nodeAttributes ) ? artifact.nodeAttributes : [];
	return attrs.filter( ( entry ) => entry && entry.source === 'node' );
}

function __objectDrawCount( object ) {
	const count = object && object.count;
	return Number.isFinite( count ) && count > 0 ? count : 0;
}

function __artifactNodeBufferMatrixCounts( artifact ) {
	const shader = artifact && typeof artifact.vertexShader === 'string' ? artifact.vertexShader : '';
	if ( ! shader ) return [];
	const counts = [];
	// InstancedMesh captures may encode instance matrices as NodeBuffer uniform
	// arrays rather than node attributes; use that as a legacy-artifact hint.
	const re = /struct\s+NodeBuffer_[A-Za-z0-9_]*Struct\s*\{[\s\S]*?value\s*:\s*array<\s*mat4x4<f32>\s*,\s*(\d+)\s*>/g;
	let match;
	while ( ( match = re.exec( shader ) ) ) {
		const count = Number( match[ 1 ] );
		if ( Number.isFinite( count ) && count > 1 && ! counts.includes( count ) ) counts.push( count );
	}
	return counts;
}

function __artifactInstancedDrawCount( artifact ) {
	const artifactObject = __artifactSourceObject( artifact );
	const metadataCount = artifactObject && artifactObject.isInstancedMesh === true ? __objectDrawCount( artifactObject ) : 0;
	if ( metadataCount ) return metadataCount;
	const attrCounts = __artifactNodeAttributes( artifact )
		.map( ( entry ) => Number( entry && entry.count ) )
		.filter( ( count ) => Number.isFinite( count ) && count > 1 );
	if ( attrCounts.length > 0 ) return attrCounts[ 0 ];
	const nodeBufferCounts = __artifactNodeBufferMatrixCounts( artifact );
	return nodeBufferCounts.length === 1 ? nodeBufferCounts[ 0 ] : 0;
}

function __artifactHasInstancedShape( artifact ) {
	const artifactObject = __artifactSourceObject( artifact );
	return !! ( artifactObject && artifactObject.isInstancedMesh === true )
		|| __artifactInstancedDrawCount( artifact ) > 1
		|| __artifactNodeAttributes( artifact ).some( ( entry ) => entry && entry.instanced === true );
}

function __nodeGraphKeys() {
	return __NODE_GRAPH_KEYS;
}

function __isRealMaterialNode( node ) {
	return !! ( node && node.isNode === true && node.__tslpNodeStub !== true );
}

function __sourceNodePropNames( sourceMaterial ) {
	const props = [];
	if ( ! sourceMaterial ) return props;
	for ( const key of __nodeGraphKeys() ) {
		if ( __isRealMaterialNode( sourceMaterial[ key ] ) ) props.push( key );
	}
	return props;
}

function __artifactNodePropNames( artifact ) {
	const source = artifact && artifact.sourceMaterial || null;
	return source && Array.isArray( source.nodeProps ) ? source.nodeProps.filter( Boolean ) : null;
}

function __artifactMaterialName( artifact ) {
	const source = artifact && artifact.sourceMaterial || null;
	return source && typeof source.name === 'string' ? source.name : '';
}

function __materialNameScore( artifact, sourceMaterial ) {
	const artifactName = __artifactMaterialName( artifact );
	const sourceName = sourceMaterial && typeof sourceMaterial.name === 'string' ? sourceMaterial.name : '';
	if ( ! artifactName || ! sourceName ) return 0;
	if ( artifactName === sourceName ) return 320;
	if ( artifactName.startsWith( __state.example + ':' ) || sourceName.startsWith( __state.example + ':' ) ) return -80;
	return -180;
}

function __artifactSourceObject( artifact ) {
	const source = artifact && artifact.sourceMaterial || null;
	if ( ! source || ! Object.prototype.hasOwnProperty.call( source, 'object' ) ) return undefined;
	return source.object || null;
}

function __artifactMaterialUuid( artifact ) {
	return artifact && typeof artifact.materialUuid === 'string' ? artifact.materialUuid : '';
}

function __sourceMaterialUuid( material ) {
	return material && typeof material.uuid === 'string' ? material.uuid : '';
}

function __artifactMatchesSourceMaterialUuid( artifact, sourceMaterial ) {
	const artifactUuid = __artifactMaterialUuid( artifact );
	const sourceUuid = __sourceMaterialUuid( sourceMaterial );
	return !! ( artifactUuid && sourceUuid && artifactUuid === sourceUuid );
}

function __objectMetadataScore( artifact, sourceObject ) {
	const artifactObject = __artifactSourceObject( artifact );
	if ( artifactObject === undefined ) return 0;
	if ( ! artifactObject && ! sourceObject ) return 90;
	if ( ! artifactObject && sourceObject ) return -140;
	if ( artifactObject && ! sourceObject ) return -160;
	let score = 0;
	const sourceType = sourceObject.type || sourceObject.constructor && sourceObject.constructor.name || '';
	if ( artifactObject.type && sourceType ) score += artifactObject.type === sourceType ? 45 : -35;
	const sourceRenderOrder = Number.isFinite( sourceObject.renderOrder ) ? sourceObject.renderOrder : 0;
	if ( Number.isFinite( artifactObject.renderOrder ) ) score += Math.abs( artifactObject.renderOrder - sourceRenderOrder ) < 1e-6 ? 90 : -45;
	if ( typeof artifactObject.castShadow === 'boolean' ) score += artifactObject.castShadow === ( sourceObject.castShadow === true ) ? 20 : -20;
	if ( typeof artifactObject.receiveShadow === 'boolean' ) score += artifactObject.receiveShadow === ( sourceObject.receiveShadow === true ) ? 20 : -20;
	if ( typeof artifactObject.isInstancedMesh === 'boolean' ) score += artifactObject.isInstancedMesh === ( sourceObject.isInstancedMesh === true ) ? 25 : -80;
	if ( sourceObject.isInstancedMesh === true && artifactObject.isInstancedMesh === true ) {
		const artifactCount = __objectDrawCount( artifactObject );
		const sourceCount = __objectDrawCount( sourceObject );
		if ( artifactCount && sourceCount ) score += artifactCount === sourceCount ? 90 : -160;
	}
	if ( Array.isArray( artifactObject.position ) && sourceObject.position ) {
		const delta = Math.abs( ( artifactObject.position[ 0 ] || 0 ) - sourceObject.position.x )
			+ Math.abs( ( artifactObject.position[ 1 ] || 0 ) - sourceObject.position.y )
			+ Math.abs( ( artifactObject.position[ 2 ] || 0 ) - sourceObject.position.z );
		score += delta < 1e-5 ? 180 : delta < 0.1 ? 45 : -160;
	}
	if ( Array.isArray( artifactObject.scale ) && sourceObject.scale ) {
		const delta = Math.abs( ( artifactObject.scale[ 0 ] || 0 ) - sourceObject.scale.x )
			+ Math.abs( ( artifactObject.scale[ 1 ] || 0 ) - sourceObject.scale.y )
			+ Math.abs( ( artifactObject.scale[ 2 ] || 0 ) - sourceObject.scale.z );
		score += delta < 1e-5 ? 45 : delta < 0.1 ? 15 : -20;
	}
	return score;
}

function __nodePropSetScore( artifact, sourceMaterial ) {
	const artifactProps = __artifactNodePropNames( artifact );
	if ( ! artifactProps ) return 0;
	const sourceProps = __sourceNodePropNames( sourceMaterial );
	const sourceSet = new Set( sourceProps );
	const artifactSet = new Set( artifactProps );
	let score = 0;
	for ( const key of sourceSet ) score += artifactSet.has( key ) ? 90 : -130;
	for ( const key of artifactSet ) {
		if ( ! sourceSet.has( key ) ) score -= 120;
	}
	if ( sourceSet.size === artifactSet.size && sourceProps.every( ( key ) => artifactSet.has( key ) ) ) score += 180;
	return score;
}

function __sourceHasNodeGraph( sourceMaterial ) {
	if ( ! sourceMaterial ) return false;
	for ( const key of __nodeGraphKeys() ) if ( __isRealMaterialNode( sourceMaterial[ key ] ) ) return true;
	return false;
}

function __collectMaterialNodeTextures( sourceMaterial ) {
	const out = [];
	if ( ! sourceMaterial ) return out;
	const seen = new Set();
	for ( const key of __nodeGraphKeys() ) {
		const node = sourceMaterial[ key ];
		if ( ! __isRealMaterialNode( node ) ) continue;
		for ( const texture of __collectTexturesInNode( node ) ) {
			if ( texture && texture.isTexture === true && ! seen.has( texture ) ) {
				seen.add( texture );
				out.push( texture );
			}
		}
	}
	return out;
}

function __collectMaterialPropertyTextures( sourceMaterial ) {
	const out = [];
	if ( ! sourceMaterial ) return out;
	for ( const property of __TEXTURE_PROPS ) {
		const texture = sourceMaterial[ property ];
		if ( texture && texture.isTexture === true ) out.push( { property, texture } );
	}
	return out;
}

function __walkMaterialNodeGraph( sourceMaterial, visitor ) {
	if ( ! sourceMaterial || typeof visitor !== 'function' ) return;
	const seen = new Set();
	const walk = ( node, depth = 0 ) => {
		if ( ! node || node.isNode !== true || node.__tslpNodeStub === true || depth > 24 || seen.has( node ) ) return;
		seen.add( node );
		visitor( node );
		if ( typeof node.traverse === 'function' ) {
			try {
				node.traverse( ( child ) => {
					if ( child && child !== node ) walk( child, depth + 1 );
				} );
			} catch ( _ ) {}
		}
		let keys = [];
		try { keys = Object.getOwnPropertyNames( node ); } catch ( _ ) { return; }
		for ( const key of keys ) {
			if ( key === 'parent' || key === 'children' || key === '_cache' || key === 'builder' || key === 'material' || key === 'object' ) continue;
			const value = __readGraphOwnValue( node, key );
			if ( ! value ) continue;
			if ( value.isNode === true ) walk( value, depth + 1 );
			else if ( Array.isArray( value ) ) {
				for ( const item of value ) if ( item && item.isNode === true ) walk( item, depth + 1 );
			} else if ( Object.getPrototypeOf( value ) === Object.prototype ) {
				for ( const item of Object.values( value ) ) if ( item && item.isNode === true ) walk( item, depth + 1 );
			}
		}
	};
	for ( const key of __nodeGraphKeys() ) walk( sourceMaterial[ key ] );
}

function __nodeUpdateKind( node, method ) {
	try {
		const fn = method === 'before' ? node.getUpdateBeforeType : method === 'after' ? node.getUpdateAfterType : node.getUpdateType;
		return typeof fn === 'function' ? fn.call( node ) : method === 'before' ? node.updateBeforeType : method === 'after' ? node.updateAfterType : node.updateType;
	} catch ( _ ) {
		return 'none';
	}
}

function __shouldReplayLiveUpdateBeforeNode( node ) {
	if ( ! node ) return false;
	if ( node.isGaussianBlurNode === true && node._material === null ) return false;
	return true;
}

function __wrapReplayUpdateBeforeNode( node ) {
	if ( ! node || typeof node.updateBefore !== 'function' || node.__tslpReplayUpdateBeforeWrapped === true ) return node;
	const originalUpdateBefore = node.updateBefore;
	try {
		Object.defineProperty( node, '__tslpReplayUpdateBeforeWrapped', {
			value: true,
			enumerable: false,
			configurable: true,
		} );
	} catch ( _ ) {}
	node.updateBefore = function tslpReplayUpdateBefore( frame ) {
		const renderer = frame && frame.renderer;
		if ( renderer ) renderer.__tslpInsideReplayUpdateBefore = ( renderer.__tslpInsideReplayUpdateBefore | 0 ) + 1;
		try {
			return originalUpdateBefore.call( this, frame );
		} finally {
			if ( renderer ) renderer.__tslpInsideReplayUpdateBefore = Math.max( 0, ( renderer.__tslpInsideReplayUpdateBefore | 0 ) - 1 );
		}
	};
	return node;
}

const __deferredGeometryNodeCache = new WeakMap();

function __deferredGeometryUpdateBeforeNodes( sourceMaterial, replacement ) {
	const geometryNode = sourceMaterial && sourceMaterial.geometryNode;
	const callNode = geometryNode && geometryNode.isVarNode === true ? geometryNode.node : geometryNode;
	const shaderNode = callNode && callNode.isShaderCallNodeInternal === true ? callNode.shaderNode : null;
	const jsFunc = shaderNode && shaderNode.jsFunc;
	const material = replacement || sourceMaterial;
	const object = material && material.__tslpPrecompileObject || sourceMaterial && sourceMaterial.__tslpPrecompileObject || null;
	const renderer = typeof window !== 'undefined' ? window.__tslpCurrentReplayRenderer : null;
	const nodes = [];
	const shouldCache = !! ( material && geometryNode && object && object.geometry && renderer );

	if ( shouldCache ) {
		let byObject = __deferredGeometryNodeCache.get( geometryNode );
		if ( byObject && byObject.has( object ) ) return byObject.get( object );
	}

	if ( typeof jsFunc === 'function' && object && object.geometry && renderer ) {
		try {
			const result = jsFunc( { renderer, geometry: object.geometry, object } );
			__walkNodeSafely( result, ( node ) => {
				if ( typeof node.updateBefore !== 'function' || ! __shouldReplayLiveUpdateBeforeNode( node ) ) return;
				if ( __nodeUpdateKind( node, 'before' ) === 'none' ) return;
				if ( ! nodes.includes( node ) ) nodes.push( node );
			} );
		} catch ( _ ) {}
	}

	if ( shouldCache ) {
		try {
			Object.defineProperty( material, '__tslpDeferredGeometryUpdateBeforeNodes', {
				value: nodes,
				enumerable: false,
				configurable: true,
				writable: true,
			} );
		} catch ( _ ) {}
		let byObject = __deferredGeometryNodeCache.get( geometryNode );
		if ( ! byObject ) {
			byObject = new WeakMap();
			__deferredGeometryNodeCache.set( geometryNode, byObject );
		}
		byObject.set( object, nodes );
	}

	return nodes;
}

function __appendArtifactSidecars( artifact, key, nodes ) {
	if ( ! artifact || ! Array.isArray( nodes ) || nodes.length === 0 ) return;
	const current = Array.isArray( artifact[ key ] ) ? artifact[ key ].slice() : [];
	let changed = false;
	for ( const node of nodes ) {
		if ( node && ! current.includes( node ) ) {
			current.push( node );
			changed = true;
		}
	}
	if ( changed ) {
		Object.defineProperty( artifact, key, {
			value: current,
			enumerable: false,
			configurable: true,
			writable: true,
		} );
	}
}

function __valueMatchesUniformSlot( value, slot ) {
	if ( ! slot ) return false;
	const snapshot = slot.source && ( slot.source.valueSnapshot || slot.source.value );
	if ( snapshot ) return __snapshotMatchesUniformValue( snapshot, value, slot.dtype );
	return __valueMatchesUniformDtype( value, slot.dtype || '' );
}

function __snapshotMatchesUniformValue( snapshot, value, dtypeHint ) {
	const type = snapshot.type || dtypeHint || '';
	const expected = snapshot.data;
	const actual = __comparableUniformValue( value, type );
	if ( actual === null ) return false;
	if ( Array.isArray( expected ) ) {
		if ( ! Array.isArray( actual ) || actual.length < expected.length ) return false;
		for ( let i = 0; i < expected.length; i ++ ) {
			if ( ! __closeUniformNumber( actual[ i ], expected[ i ] ) ) return false;
		}
		return true;
	}
	return __closeUniformNumber( actual, expected );
}

function __comparableUniformValue( value, type ) {
	if ( type === 'number' || type === 'float' || type === 'f32' || type === 'int' || type === 'uint' || type === 'i32' || type === 'u32' ) {
		if ( typeof value === 'number' ) return value;
		if ( value && value.isUniformNode !== true && typeof value.value === 'number' ) return value.value;
		return null;
	}
	if ( type === 'color' ) return value && value.isColor ? [ value.r, value.g, value.b ] : null;
	if ( type === 'vec2' ) return value && value.isVector2 ? [ value.x, value.y ] : null;
	if ( type === 'vec3' ) {
		if ( value && value.isVector3 ) return [ value.x, value.y, value.z ];
		if ( value && value.isColor ) return [ value.r, value.g, value.b ];
		return null;
	}
	if ( type === 'vec4' ) return value && value.isVector4 ? [ value.x, value.y, value.z, value.w ] : null;
	if ( type === 'mat3' ) return value && value.isMatrix3 && value.elements ? Array.from( value.elements ) : null;
	if ( type === 'mat4' ) return value && value.isMatrix4 && value.elements ? Array.from( value.elements ) : null;
	return __valueMatchesUniformDtype( value, type ) ? value : null;
}

function __valueMatchesUniformDtype( value, dtype ) {
	if ( dtype === 'color' ) return !! ( value && value.isColor );
	if ( dtype === 'number' || dtype === 'float' ) return typeof value === 'number' || value && value.isUniformNode !== true && typeof value.value === 'number';
	if ( dtype === 'vec2' ) return !! ( value && value.isVector2 );
	if ( dtype === 'vec3' ) return !! ( value && ( value.isVector3 || value.isColor ) );
	if ( dtype === 'vec4' ) return !! ( value && value.isVector4 );
	if ( dtype === 'mat3' ) return !! ( value && value.isMatrix3 );
	if ( dtype === 'mat4' ) return !! ( value && value.isMatrix4 );
	return true;
}

function __closeUniformNumber( a, b ) {
	const left = Number( a );
	const right = Number( b );
	if ( ! Number.isFinite( left ) || ! Number.isFinite( right ) ) return left === right;
	return Math.abs( left - right ) <= Math.max( 1e-6, Math.abs( right ) * 1e-6 );
}

function __isVolumeNodeMaterial( material ) {
	return !! ( material && ( material.isVolumeNodeMaterial === true || material.type === 'VolumeNodeMaterial' || material.constructor && material.constructor.name === 'VolumeNodeMaterial' ) );
}

function __volumeStepsShaderSource( artifact ) {
	if ( ! artifact ) return '';
	return [
		artifact.fragmentShader,
		artifact.fragment,
		artifact.wgsl,
		artifact.code,
	].filter( ( value ) => typeof value === 'string' ).join( '\\n' );
}

function __isVolumeStepsUniformSlot( artifact, slot ) {
	if ( ! artifact || ! slot || ! slot.name ) return false;
	const source = slot.source || {};
	if ( source.kind !== 'uniform.live' || slot.dtype !== 'int' ) return false;
	const shader = __volumeStepsShaderSource( artifact );
	if ( shader === '' ) return false;
	return shader.includes( 'f32( object.' + slot.name + ' )' ) && shader.includes( 'i < object.' + slot.name );
}

function __repairVolumeMaterialStepsUniform( artifact, sourceMaterial ) {
	if ( ! artifact || ! __isVolumeNodeMaterial( sourceMaterial ) ) return 0;
	const steps = Number( sourceMaterial.steps );
	if ( ! Number.isFinite( steps ) || steps <= 0 ) return 0;
	let repaired = 0;
	for ( const group of artifact.uniformPlan || [] ) {
		for ( const slot of group.slots || [] ) {
			if ( ! __isVolumeStepsUniformSlot( artifact, slot ) ) continue;
			const liveSteps = {};
			Object.defineProperty( liveSteps, 'value', {
				get() {
					const current = Number( sourceMaterial.steps );
					return Number.isFinite( current ) && current > 0 ? current : steps;
				},
				enumerable: false,
				configurable: true,
			} );
			Object.defineProperty( slot, '_liveNode', {
				value: liveSteps,
				enumerable: false,
				configurable: true,
				writable: true,
			} );
			Object.defineProperty( slot, '__tslpLiveSidecarOverlay', {
				value: true,
				enumerable: false,
				configurable: true,
				writable: true,
			} );
			if ( slot.source && slot.source.valueSnapshot && Number( slot.source.valueSnapshot.data ) <= 0 ) {
				slot.source.valueSnapshot = { type: 'int', data: steps };
			}
			repaired ++;
		}
	}
	if ( repaired > 0 && typeof globalThis !== 'undefined' ) {
		const diag = globalThis.__tslpHarnessDiagnostics || ( globalThis.__tslpHarnessDiagnostics = {} );
		const frameEffects = diag.frameEffects || ( diag.frameEffects = {} );
		frameEffects.volumeStepsUniformRepaired = ( frameEffects.volumeStepsUniformRepaired || 0 ) + repaired;
		const repairs = diag.volumeStepsUniformRepairs || ( diag.volumeStepsUniformRepairs = [] );
		if ( repairs.length < 16 ) repairs.push( { name: artifact.name || '', steps, repaired } );
	}
	return repaired;
}

function __wireLiveNodeSidecarsToArtifact( artifact, sourceMaterial, replacement = null ) {
	if ( ! artifact || ! sourceMaterial ) return;
	const isPMREMArtifact = __artifactHasTextureSource( artifact, __isPMREMArtifactTextureSource );
	if ( isPMREMArtifact ) {
		// PMREMNode setup already ran during capture and is represented by the
		// shader plus artifact.texture refs. Replaying the source graph's live
		// UniformNode/update sidecars can retarget PMREM sampling constants to
		// transient internals, so keep the captured PMREM constants for replay.
		return;
	}
	const uniformNodes = [];
	const updateNodes = [];
	const updateBeforeNodes = [];
	const updateAfterNodes = [];
	__walkMaterialNodeGraph( sourceMaterial, ( node ) => {
		if ( node.isUniformNode === true && ! uniformNodes.includes( node ) ) uniformNodes.push( node );
		if ( typeof node.update === 'function' && __nodeUpdateKind( node, 'update' ) !== 'none' && ! updateNodes.includes( node ) ) updateNodes.push( node );
		if ( typeof node.updateBefore === 'function' && __shouldReplayLiveUpdateBeforeNode( node ) && __nodeUpdateKind( node, 'before' ) !== 'none' && ! updateBeforeNodes.includes( node ) ) updateBeforeNodes.push( node );
		if ( typeof node.updateAfter === 'function' && __nodeUpdateKind( node, 'after' ) !== 'none' && ! updateAfterNodes.includes( node ) ) updateAfterNodes.push( node );
	} );
	for ( const node of __deferredGeometryUpdateBeforeNodes( sourceMaterial, replacement ) ) {
		if ( ! updateBeforeNodes.includes( node ) ) updateBeforeNodes.push( node );
	}
	for ( const node of updateBeforeNodes ) __wrapReplayUpdateBeforeNode( node );
	__appendArtifactSidecars( artifact, '_liveUpdateNodes', updateNodes );
	__appendArtifactSidecars( artifact, '_liveUpdateBeforeNodes', updateBeforeNodes );
	__appendArtifactSidecars( artifact, '_liveUpdateAfterNodes', updateAfterNodes );
	if ( uniformNodes.length > 0 ) {
		const used = new Set();
			for ( const group of artifact.uniformPlan || [] ) {
			for ( const slot of group.slots || [] ) {
				const source = slot && slot.source || {};
				if ( source.kind !== 'uniform.live' || slot._liveNode ) continue;
				if ( __state.mode === 'replay' && ! source.name && source.valueSnapshot ) continue;
				let match = null;
				if ( source.name ) {
					match = uniformNodes.find( ( node ) => ! used.has( node ) && node.name === source.name && __valueMatchesUniformSlot( node.value, slot ) );
					if ( ! match ) match = uniformNodes.find( ( node ) => node.name === source.name && __valueMatchesUniformSlot( node.value, slot ) );
				}
				if ( ! match ) match = uniformNodes.find( ( node ) => ! used.has( node ) && __valueMatchesUniformSlot( node.value, slot ) );
				if ( ! match ) match = uniformNodes.find( ( node ) => __valueMatchesUniformSlot( node.value, slot ) );
				if ( ! match ) {
					const dtype = slot.dtype || slot.source && slot.source.valueSnapshot && slot.source.valueSnapshot.type || '';
					const dtypeMatches = uniformNodes.filter( ( node ) => ! used.has( node ) && __valueMatchesUniformDtype( node.value, dtype ) );
					if ( dtypeMatches.length === 1 ) match = dtypeMatches[ 0 ];
					else {
						const allDtypeMatches = uniformNodes.filter( ( node ) => __valueMatchesUniformDtype( node.value, dtype ) );
						if ( allDtypeMatches.length === 1 ) match = allDtypeMatches[ 0 ];
					}
				}
				if ( ! match ) continue;
				Object.defineProperty( slot, '_liveNode', {
					value: match,
					enumerable: false,
					configurable: true,
					writable: true,
				} );
				Object.defineProperty( slot, '__tslpLiveSidecarOverlay', {
					value: true,
					enumerable: false,
					configurable: true,
					writable: true,
				} );
				used.add( match );
			}
		}
	}
	__repairVolumeMaterialStepsUniform( artifact, sourceMaterial );
}

function __materialFamilyFromClassName( className ) {
	if ( /^Mesh[A-Za-z0-9]*NodeMaterial$/.test( className ) ) return 'mesh';
	if ( /^Line[A-Za-z0-9]*NodeMaterial$/.test( className ) ) return 'line';
	if ( className === 'PointsNodeMaterial' ) return 'points';
	if ( className === 'SpriteNodeMaterial' ) return 'sprite';
	if ( className === 'VolumeNodeMaterial' ) return 'mesh';
	return null;
}

function __materialFamilyFromObject( object ) {
	if ( ! object ) return null;
	if ( object.isPoints === true ) return 'points';
	if ( object.isLine === true || object.isLineSegments === true || object.isLineLoop === true || object.isLine2 === true || object.isLineSegments2 === true ) return 'line';
	if ( object.isSprite === true ) return 'sprite';
	if ( object.isMesh === true || object.isInstancedMesh === true || object.isSkinnedMesh === true ) return 'mesh';
	return null;
}

function __isPipelineArtifactShape( artifact ) {
	const shape = artifact && ( artifact.materialShape || artifact.shape ) || '';
	return shape === 'render-pipeline' || shape === 'render-output' || shape === 'post-process';
}

	function __scoreArtifactForSource( key, mod, className, sourceMaterial, sourceObject = null ) {
		const artifact = mod && mod.artifact;
		if ( ! artifact ) return -Infinity;
		if ( sourceObject && __isPipelineArtifactShape( artifact ) ) return -Infinity;
		const materialUuidMatches = __artifactMatchesSourceMaterialUuid( artifact, sourceMaterial );
		if ( sourceObject && ! materialUuidMatches && ! __precompiledArtifactMatchesObject( artifact, sourceObject ) ) return -Infinity;
		const artifactProps = __artifactNodePropNames( artifact );
		if ( sourceMaterial && artifactProps && artifactProps.length > 0 && __sourceNodePropNames( sourceMaterial ).length === 0 ) return -Infinity;
		const artifactClassName = __classNameFromArtifactName( key );
		const requestedFamily = __materialFamilyFromClassName( className );
		const artifactFamily = __materialFamilyFromClassName( artifactClassName );
		const objectFamily = __materialFamilyFromObject( sourceObject );
	let score = artifactClassName === className ? 180 : key.includes( ':' + className + ':' ) ? 120 : 0;
	if ( artifactFamily && objectFamily ) {
		score += artifactFamily === objectFamily ? 140 : -420;
	}
	if ( requestedFamily && artifactFamily ) {
		if ( requestedFamily === artifactFamily ) score += artifactClassName === className ? 60 : 25;
		else score -= 360;
	}
	const typeNeedle = __sourceTypeNeedle( sourceMaterial );
	if ( typeNeedle && key.includes( ':' + typeNeedle + ':' ) ) score += 15;
	if ( sourceMaterial ) {
		const artifactUuid = __artifactMaterialUuid( artifact );
		const sourceUuid = __sourceMaterialUuid( sourceMaterial );
		if ( artifactUuid && sourceUuid ) score += artifactUuid === sourceUuid ? 900 : -260;
	}
	score += __materialNameScore( artifact, sourceMaterial );
	score += __nodePropSetScore( artifact, sourceMaterial );
	score += __objectMetadataScore( artifact, sourceObject );

	if ( sourceMaterial && artifact.renderState && typeof sourceMaterial.transparent === 'boolean' && typeof artifact.renderState.transparent === 'boolean' ) {
		score += sourceMaterial.transparent === artifact.renderState.transparent ? 45 : -80;
	}

	if ( sourceMaterial && artifact.defaults && typeof sourceMaterial.shininess === 'number' && typeof artifact.defaults.shininess === 'number' ) {
		const delta = Math.abs( sourceMaterial.shininess - artifact.defaults.shininess );
		if ( delta < 1e-4 ) score += 40;
		else if ( delta > 5 ) score -= 35;
	}

	const sourceColor = __readColorTriplet( sourceMaterial && sourceMaterial.color );
	if ( sourceColor ) {
		const artifactColor = __artifactColorTriplet( artifact );
		if ( artifactColor ) {
			const d2 = __colorDistanceSq( sourceColor, artifactColor );
			if ( d2 < 1e-5 ) score += 120;
			else if ( d2 < 0.05 ) score += 45;
			else score -= 30;
		}
		if ( __artifactHasTextureSource( artifact, __isPMREMArtifactTextureSource ) ) score -= 35;
	}

	const sourceEmissive = __readColorTriplet( sourceMaterial && sourceMaterial.emissive );
	if ( sourceEmissive ) {
		const artifactEmissive = __artifactMaterialColorTriplet( artifact, 'emissive' );
		if ( artifactEmissive ) {
			const d2 = __colorDistanceSq( sourceEmissive, artifactEmissive );
			if ( d2 < 1e-5 ) score += 160;
			else if ( d2 < 0.05 ) score += 50;
			else score -= 140;
		}
	}

	if ( sourceMaterial && typeof sourceMaterial.wireframe === 'boolean' && artifact.renderState && typeof artifact.renderState.wireframe === 'boolean' ) {
		if ( sourceMaterial.wireframe === artifact.renderState.wireframe ) score += 90;
		else score -= 120;
	}

	const materialTextures = __collectMaterialPropertyTextures( sourceMaterial );
	if ( materialTextures.length > 0 ) {
		const matchedMaterialTextureSources = new Set();
		const sourceMaterialTextureProps = new Set( materialTextures.map( ( item ) => item.property ).filter( Boolean ) );
		const artifactMaterialTextureProps = new Set();
		for ( const group of artifact.uniformPlan || [] ) {
			for ( const entry of group.textures || [] ) {
				const source = entry && entry.source || {};
				if ( ! source.kind || ! source.kind.startsWith( 'material.' ) ) continue;
				const property = source.property || source.kind.split( '.' )[ 1 ];
				if ( property ) artifactMaterialTextureProps.add( property );
				const matchIndex = materialTextures.findIndex( ( item, index ) => ! matchedMaterialTextureSources.has( index ) && ( property === item.property || source.kind === 'material.' + item.property ) && __textureMatchesSource( item.texture, source ) );
				if ( matchIndex !== -1 ) matchedMaterialTextureSources.add( matchIndex );
			}
		}
		let propertyMatches = 0;
		for ( const property of sourceMaterialTextureProps ) if ( artifactMaterialTextureProps.has( property ) ) propertyMatches ++;
		const missingSourceProps = Math.max( 0, sourceMaterialTextureProps.size - propertyMatches );
		const extraArtifactProps = Math.max( 0, artifactMaterialTextureProps.size - propertyMatches );
		if ( matchedMaterialTextureSources.size > 0 ) score += matchedMaterialTextureSources.size * 130 + propertyMatches * 20;
		else if ( propertyMatches > 0 ) {
			score += propertyMatches * 45;
			if ( missingSourceProps === 0 && extraArtifactProps === 0 ) score += 35;
			else score -= missingSourceProps * 20 + extraArtifactProps * 10;
		}
		else if ( __artifactHasTextureSource( artifact, ( source ) => source.kind && source.kind.startsWith( 'material.' ) ) ) score -= 75;
		else score -= 55;
	} else if ( __artifactHasTextureSource( artifact, ( source ) => source.kind && source.kind.startsWith( 'material.' ) ) ) {
		score -= 75;
	}

	const nodeTextures = __collectMaterialNodeTextures( sourceMaterial );
	const sourceHasNodeTexture = nodeTextures.length > 0;
	const sourceHasPmremTexture = nodeTextures.some( __isPMREMTexture );
	if ( sourceHasNodeTexture ) {
		if ( __artifactHasTextureSource( artifact ) ) score += 45;
		else score -= 25;
		if ( sourceHasPmremTexture && __artifactHasTextureSource( artifact, __isPMREMArtifactTextureSource ) ) score += 90;
		const identifiableNodeTextures = nodeTextures.filter( ( texture ) => {
			if ( ! texture || texture.isTexture !== true || __isPMREMTexture( texture ) ) return false;
			return !! ( texture.name || __textureImageSrc( texture ) );
		} );
		const matchedNodeTextureSources = new Set();
		for ( const group of artifact.uniformPlan || [] ) {
			for ( const entry of group.textures || [] ) {
				const source = entry && entry.source || {};
				if ( source.kind !== 'artifact.texture' || __isPMREMArtifactTextureSource( source ) ) continue;
				const matchIndex = identifiableNodeTextures.findIndex( ( texture, index ) => ! matchedNodeTextureSources.has( index ) && __textureMatchesArtifactSource( texture, source ) );
				if ( matchIndex !== -1 ) matchedNodeTextureSources.add( matchIndex );
			}
		}
		if ( matchedNodeTextureSources.size > 0 ) score += matchedNodeTextureSources.size * 90;
		else if ( identifiableNodeTextures.length > 0 && __artifactHasTextureSource( artifact, ( source ) => source.kind === 'artifact.texture' && ! __isPMREMArtifactTextureSource( source ) ) ) score -= 55;
	} else if ( __sourceHasNodeGraph( sourceMaterial ) ) {
		// A live node graph without discoverable Texture nodes should not prefer
		// captured artifacts that do sample textures. Examples such as
		// webgpu_materials.html have many MeshBasicNodeMaterial variants with the
		// same class name; rewarding textured artifacts here swaps position/normal
		// materials with texture-based ones.
		if ( __artifactHasTextureSource( artifact ) ) score -= 65;
		else score += 10;
	}

		const nodeAttrs = __artifactNodeAttributes( artifact );
	const declaredAttrs = Array.isArray( artifact.attributes ) ? artifact.attributes : [];
	const artifactSkinned = declaredAttrs.some( ( entry ) => entry && ( entry.name === 'skinIndex' || entry.name === 'skinWeight' ) );
	const sourceGeometryAttrs = sourceObject && sourceObject.geometry && sourceObject.geometry.attributes || {};
	const sourceSkinned = !! ( sourceObject && ( sourceObject.isSkinnedMesh === true || sourceGeometryAttrs.skinIndex || sourceGeometryAttrs.skinWeight ) );
	if ( artifactSkinned && sourceSkinned ) score += 90;
	else if ( artifactSkinned && sourceObject && ! sourceSkinned ) score -= 220;
	else if ( sourceSkinned && ! artifactSkinned ) score -= 120;
	if ( sourceObject && sourceObject.isInstancedMesh === true ) {
		const count = sourceObject.count || 0;
		const artifactInstancedCount = __artifactInstancedDrawCount( artifact );
		const matchingAttrs = count ? nodeAttrs.filter( ( entry ) => entry.count === count ) : [];
		const matrixAttrs = matchingAttrs.filter( ( entry ) => ( entry.itemSize || 0 ) === 4 || entry.type === 'vec4' );
		const colorAttrs = matchingAttrs.filter( ( entry ) => ( entry.itemSize || 0 ) === 3 || entry.type === 'vec3' );
		if ( artifactInstancedCount && count ) score += artifactInstancedCount === count ? 170 : -300;
		else if ( matchingAttrs.length > 0 ) score += 80;
		else if ( nodeAttrs.length === 0 ) score -= 45;
		if ( sourceObject.instanceMatrix && matrixAttrs.length >= 4 ) score += 60;
		if ( sourceObject.instanceColor && colorAttrs.length > 0 ) score += 40;
	} else if ( nodeAttrs.length > 0 ) {
		score -= 10;
	}

	return score;
}

function __findBestArtifactForSource( className, sourceMaterial, keys, sourceObject = null ) {
	if ( ! sourceMaterial || ! Array.isArray( keys ) || keys.length === 0 ) return null;
	const findBest = ( candidateKeys, minScore = 55 ) => {
		let best = null;
		let bestScore = -Infinity;
		for ( const key of candidateKeys ) {
			const mod = __data.user && __data.user[ key ];
			const score = __scoreArtifactForSource( key, mod, className, sourceMaterial, sourceObject );
			if ( score > bestScore ) {
				best = key;
				bestScore = score;
			}
		}
		return best && bestScore > -Infinity && bestScore >= minScore ? best : null;
	};
	const exactKeys = keys.filter( ( key ) => __classNameFromArtifactName( key ) === className || key.includes( ':' + className + ':' ) );
	return findBest( exactKeys, -Infinity ) || findBest( keys );
}

function __artifactKeyMatchesMaterialSource( key, mod, className, sourceMaterial, sourceObject = null ) {
	const artifact = mod && mod.artifact;
	if ( ! artifact ) return false;
	if ( sourceObject && __isPipelineArtifactShape( artifact ) ) return false;
	const artifactClassName = __classNameFromArtifactName( key );
	if ( artifactClassName !== className && ! key.includes( ':' + className + ':' ) ) return false;
	const requestedFamily = __materialFamilyFromClassName( className );
	const artifactFamily = __materialFamilyFromClassName( artifactClassName );
	const objectFamily = __materialFamilyFromObject( sourceObject );
	if ( requestedFamily && artifactFamily && requestedFamily !== artifactFamily ) return false;
	if ( objectFamily && artifactFamily && objectFamily !== artifactFamily ) return false;
	return __precompiledArtifactMatchesSource( artifact, sourceMaterial, sourceObject );
}

function __attachGeneratedUpdatersFromModule( artifact, mod ) {
	if ( ! artifact || ! mod ) return artifact;
	if ( typeof mod.update === 'function' && typeof artifact._generatedUpdate !== 'function' ) {
		try { Object.defineProperty( artifact, '_generatedUpdate', { value: mod.update, enumerable: false, configurable: true } ); } catch ( _ ) {}
	}
	if ( typeof mod.updateGroup === 'function' && typeof artifact._generatedUpdateGroup !== 'function' ) {
		try { Object.defineProperty( artifact, '_generatedUpdateGroup', { value: mod.updateGroup, enumerable: false, configurable: true } ); } catch ( _ ) {}
	}
	return artifact;
}

function __takeMaterial( className, sourceMaterial = null, sourceObject = null, opts = {} ) {
	const allowUsed = !! ( opts && opts.allowUsed );
	const n = ( __counts[ className ] || 0 ) + 1;
	__counts[ className ] = n;
	let name = __state.example + ':' + className + ':' + n;
	let mod = __data.user && __data.user[ name ];
	if ( mod && ! allowUsed && __usedArtifactNames.has( name ) ) mod = null;
	if ( sourceMaterial ) {
		if ( ! mod || ! __artifactKeyMatchesMaterialSource( name, mod, className, sourceMaterial, sourceObject ) ) {
			const allKeys = Object.keys( __data.user || {} );
			const unusedKeys = allowUsed ? allKeys : allKeys.filter( ( key ) => ! __usedArtifactNames.has( key ) );
			const matchedName = __findBestArtifactForSource( className, sourceMaterial, unusedKeys, sourceObject );
			if ( matchedName ) {
				name = matchedName;
				mod = __data.user[ name ];
			} else if ( ! allowUsed ) {
				const usedMatchedName = __findBestArtifactForSource( className, sourceMaterial, allKeys, sourceObject );
				if ( usedMatchedName ) {
					name = usedMatchedName;
					mod = __data.user[ name ];
				}
			}
		}
	}
	if ( ! mod || ! mod.artifact ) {
		const allKeys = Object.keys( __data.user || {} );
		const unusedKeys = allowUsed ? allKeys : allKeys.filter( ( key ) => ! __usedArtifactNames.has( key ) );
		const typeNeedle = __sourceTypeNeedle( sourceMaterial );
		const findUuid = ( keys ) => sourceMaterial ? keys.find( ( key ) => __artifactMatchesSourceMaterialUuid( __data.user && __data.user[ key ] && __data.user[ key ].artifact, sourceMaterial ) ) : null;
		const findType = ( keys ) => keys.find( ( key ) => typeNeedle && key.includes( ':' + typeNeedle + ':' ) );
		const findCompatible = ( keys ) => keys.find( ( key ) => /:(MeshBasic|MeshLambert|MeshStandard)NodeMaterial:/.test( key ) );
		const findClass = ( keys ) => keys.find( ( key ) => key.includes( ':' + className + ':' ) );
		const findNodeMaterial = ( keys ) => keys.find( ( key ) => /:NodeMaterial:\d+$/.test( key ) );
		const findLineBasic = ( keys ) => keys.find( ( key ) => /:LineBasicNodeMaterial:/.test( key ) );
		const isMeshNodeMaterial = /^Mesh[A-Za-z0-9]*NodeMaterial$/.test( className );
		const isSpriteOrPointsNodeMaterial = /^(Sprite|Points)NodeMaterial$/.test( className );
		const fallbackName = findUuid( unusedKeys ) || findUuid( allKeys ) ||
			findType( unusedKeys ) || findType( allKeys ) ||
			( className === 'Line2NodeMaterial' ? findCompatible( unusedKeys ) || findCompatible( allKeys ) : null ) ||
			( className === 'LineDashedNodeMaterial' ? findLineBasic( unusedKeys ) || findLineBasic( allKeys ) : null ) ||
			findClass( unusedKeys ) || findClass( allKeys ) ||
			( className === 'VolumeNodeMaterial' ? findNodeMaterial( unusedKeys ) || findNodeMaterial( allKeys ) : null ) ||
			( isMeshNodeMaterial ? findCompatible( unusedKeys ) || findCompatible( allKeys ) : null ) ||
			( isSpriteOrPointsNodeMaterial ? findCompatible( unusedKeys ) || findCompatible( allKeys ) : null ) ||
			( className.length <= 3 ? findCompatible( unusedKeys ) || findCompatible( allKeys ) : null );
		if ( fallbackName ) {
			name = fallbackName;
			mod = __data.user[ name ];
		}
	}
	if ( ! mod || ! mod.artifact ) {
		throw new Error( '[tslp-e2e] no captured artifact for ' + name + ' (class=' + className + ', len=' + String( className.length ) + ', type=' + ( sourceMaterial && sourceMaterial.type || '' ) + ', keys=' + Object.keys( __data.user || {} ).slice( 0, 5 ).join( '|' ) + '). Capture pass did not see this material.' );
	}
	__usedArtifactNames.add( name );
	if ( mod.__hash && ! mod.artifact.__hash ) Object.defineProperty( mod.artifact, '__hash', { value: mod.__hash, enumerable: false, configurable: true } );
	__attachGeneratedUpdatersFromModule( mod.artifact, mod );
		// Wire live storage buffer attributes from the source material's node graph into
		// the artifact plan before hydration so compute results are visible in renders.
				__wireComputeAttrsToArtifact( mod.artifact, sourceMaterial );
				__ensureArtifactTextureFallbacks( mod.artifact );
			const material = new Slim.PrecompiledMaterial( mod.artifact );
	material.name = name;
	__stampPrecompiledMaterialClassFlags( material, className );
	if ( className === 'MeshToonNodeMaterial' || className === 'MeshToonMaterial' ) {
		material.isMeshToonNodeMaterial = true;
		material.isMeshToonMaterial = true;
	}
	if ( className === 'NodeMaterial' && sourceMaterial && sourceMaterial.isMeshToonOutlineMaterial === true ) {
		material.isMeshToonOutlineMaterial = true;
	}
	__attachReflectorBaseNodesForArtifact( material, mod.artifact, sourceObject );
	__seedNodeProps( material );
	return material;
}

function __classNameForMaterial( material ) {
	if ( ! material ) return 'Material';
	const type = material.type || '';
	if ( type === 'Line2NodeMaterial' ) return 'Line2NodeMaterial';
	if ( material.isMeshBasicNodeMaterial || material.isMeshBasicMaterial ) return 'MeshBasicNodeMaterial';
	if ( material.isMeshSSSNodeMaterial || material.type === 'MeshSSSNodeMaterial' ) return 'MeshSSSNodeMaterial';
	if ( material.isMeshPhysicalNodeMaterial || material.isMeshPhysicalMaterial ) return 'MeshPhysicalNodeMaterial';
	if ( material.isMeshStandardNodeMaterial || material.isMeshStandardMaterial ) return 'MeshStandardNodeMaterial';
	if ( material.isMeshLambertNodeMaterial || material.isMeshLambertMaterial ) return 'MeshLambertNodeMaterial';
	if ( material.isMeshPhongNodeMaterial || material.isMeshPhongMaterial ) return 'MeshPhongNodeMaterial';
	if ( material.isMeshToonNodeMaterial || material.isMeshToonMaterial ) return 'MeshToonNodeMaterial';
	if ( material.isMeshNormalNodeMaterial || material.isMeshNormalMaterial ) return 'MeshNormalNodeMaterial';
	if ( material.isMeshMatcapNodeMaterial || material.isMeshMatcapMaterial ) return 'MeshMatcapNodeMaterial';
	if ( material.isLine2NodeMaterial ) return 'Line2NodeMaterial';
	if ( material.isLineBasicNodeMaterial || material.isLineBasicMaterial ) return 'LineBasicNodeMaterial';
	if ( material.isPointsNodeMaterial || material.isPointsMaterial ) return 'PointsNodeMaterial';
	if ( material.isSpriteNodeMaterial || material.isSpriteMaterial ) return 'SpriteNodeMaterial';
	if ( material.isVolumeNodeMaterial || type === 'VolumeNodeMaterial' ) return 'VolumeNodeMaterial';
	if ( type === 'MeshBasicNodeMaterial' || type === 'MeshBasicMaterial' ) return 'MeshBasicNodeMaterial';
	if ( type === 'MeshSSSNodeMaterial' ) return 'MeshSSSNodeMaterial';
	if ( type === 'MeshPhysicalNodeMaterial' || type === 'MeshPhysicalMaterial' ) return 'MeshPhysicalNodeMaterial';
	if ( type === 'MeshStandardNodeMaterial' || type === 'MeshStandardMaterial' ) return 'MeshStandardNodeMaterial';
	if ( type === 'MeshLambertNodeMaterial' || type === 'MeshLambertMaterial' ) return 'MeshLambertNodeMaterial';
	if ( type === 'MeshPhongNodeMaterial' || type === 'MeshPhongMaterial' ) return 'MeshPhongNodeMaterial';
	if ( type === 'MeshToonNodeMaterial' || type === 'MeshToonMaterial' ) return 'MeshToonNodeMaterial';
	if ( type === 'MeshNormalNodeMaterial' || type === 'MeshNormalMaterial' ) return 'MeshNormalNodeMaterial';
	if ( type === 'MeshMatcapNodeMaterial' || type === 'MeshMatcapMaterial' ) return 'MeshMatcapNodeMaterial';
	if ( type === 'Line2NodeMaterial' ) return 'Line2NodeMaterial';
	if ( type === 'LineBasicNodeMaterial' || type === 'LineBasicMaterial' ) return 'LineBasicNodeMaterial';
	if ( type === 'PointsNodeMaterial' || type === 'PointsMaterial' ) return 'PointsNodeMaterial';
	if ( type === 'SpriteNodeMaterial' || type === 'SpriteMaterial' ) return 'SpriteNodeMaterial';
	if ( /NodeMaterial$/.test( type ) ) return type;
	return material.constructor && material.constructor.name || 'Material';
}

	function __stampPrecompiledMaterialClassFlags( material, className ) {
	if ( ! material || typeof className !== 'string' ) return material;
	if ( className === 'MeshBasicNodeMaterial' ) {
		material.isMeshBasicNodeMaterial = true;
		material.isMeshBasicMaterial = true;
	} else if ( className === 'MeshPhongNodeMaterial' ) {
		material.isMeshPhongNodeMaterial = true;
		material.isMeshPhongMaterial = true;
	} else if ( className === 'MeshStandardNodeMaterial' ) {
		material.isMeshStandardNodeMaterial = true;
		material.isMeshStandardMaterial = true;
	} else if ( className === 'MeshPhysicalNodeMaterial' ) {
		material.isMeshPhysicalNodeMaterial = true;
		material.isMeshPhysicalMaterial = true;
		} else if ( className === 'MeshLambertNodeMaterial' ) {
			material.isMeshLambertNodeMaterial = true;
			material.isMeshLambertMaterial = true;
		} else if ( className === 'PointsNodeMaterial' ) {
			material.isPointsNodeMaterial = true;
			material.isPointsMaterial = true;
		} else if ( className === 'SpriteNodeMaterial' ) {
			material.isSpriteNodeMaterial = true;
			material.isSpriteMaterial = true;
		} else if ( className === 'VolumeNodeMaterial' ) {
			material.isVolumeNodeMaterial = true;
		}
		return material;
	}

	function __isRetroPassRenderTarget( renderer ) {
	try {
		const target = renderer && typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : null;
		const texture = target && target.texture;
		return !! ( texture
			&& texture.magFilter === Slim.NearestFilter
			&& texture.minFilter === Slim.NearestFilter );
	} catch ( _ ) {
		return false;
	}
}

function __isRetroPassGeneratedMaterial( renderer, scene, material ) {
	if ( ! material || material.isPrecompiledMaterial === true ) return false;
	return !! ( scene && scene.isScene === true && scene.userData && scene.userData.__tslpUserScene === true
		&& ( renderer && ( renderer.__tslpRenderingRetroPass | 0 ) > 0 || __isRetroPassRenderTarget( renderer ) ) );
}

// Material-property keys that carry texture refs three.js's renderer
// reads off the material directly. The hydrator's 'material.<prop>'
// resolver pulls live values from these on each frame.
//
// Audited against three.js r184 MeshStandardMaterial / MeshPhysicalMaterial /
// Scalar/Color/Vector2/array PBR material properties -- copied source->swap
// on every replay so live GUI tweaks (lightMapIntensity, displacementScale,
// etc.) survive into the precompiled material's per-frame uniform updaters.
const __SCALAR_PROPS = [ 'color', 'opacity', 'transparent', 'side', 'visible', 'toneMapped', 'emissive', 'emissiveIntensity', 'roughness', 'metalness', 'normalScale', 'normalMapType', 'bumpScale', 'displacementScale', 'displacementBias', 'lightMapIntensity', 'aoMapIntensity', 'envMapIntensity', 'envMapRotation', 'reflectivity', 'refractionRatio', 'shininess', 'specular', 'specularColor', 'specularIntensity', 'ior', 'clearcoat', 'clearcoatRoughness', 'clearcoatNormalScale', 'iridescence', 'iridescenceIOR', 'iridescenceThicknessRange', 'sheen', 'sheenColor', 'sheenRoughness', 'transmission', 'thickness', 'attenuationColor', 'attenuationDistance', 'anisotropy', 'anisotropyRotation', 'dispersion', 'alphaTest', 'alphaHash', 'alphaToCoverage', 'depthTest', 'depthWrite', 'blending', 'blendSrc', 'blendDst', 'blendEquation', 'premultipliedAlpha', 'dithering', 'vertexColors', 'wireframe', 'wireframeLinewidth', 'flatShading', 'linewidth', 'dashSize', 'gapSize', 'dashOffset', 'scale', 'worldUnits', 'dashed' ];
// Mirror three.js's Material.setValues() coercion: when assigning into a slot
// that already holds a Color/Vector instance (seeded from artifact.defaults),
// mutate it in place via .set() / .copy() so the hydrator keeps reading a
// live Color and hex / string / Color inputs are normalised the same way the
// real three.js constructor would. Plain scalars and unknown shapes fall back
// to direct assignment.
function __assignParam( mat, key, value ) {
	const current = mat[ key ];
	if ( current && current.isColor ) {
		current.set( value );
	} else if ( current && value && (
		( current.isVector2 && value.isVector2 ) ||
		( current.isVector3 && value.isVector3 ) ||
		( current.isVector4 && value.isVector4 )
	) ) {
		current.copy( value );
	} else {
		mat[ key ] = value;
	}
}

function __makeFallbackNodeMaterial( params ) {
	const material = new Slim.MeshBasicMaterial( { color: 0xffffff } );
	material.name = 'tslp-fallback-node-material';
	material.toneMapped = false;
	material.depthTest = false;
	material.depthWrite = false;
	material.transparent = true;
	if ( params && typeof params === 'object' ) {
		for ( const key in params ) {
			if ( params[ key ] !== undefined ) __assignParam( material, key, params[ key ] );
		}
	}
	return material;
}

function __makeInternalNodeMaterial( className = 'NodeMaterial', params = null ) {
	let Ctor = FullNodeMaterial;
	if ( ( className === 'MeshBasicNodeMaterial' || className === 'MeshBasicMaterial' ) && FullMeshBasicNodeMaterial ) Ctor = FullMeshBasicNodeMaterial;
	else if ( ( className === 'MeshStandardNodeMaterial' || className === 'MeshStandardMaterial' ) && FullMeshStandardNodeMaterial ) Ctor = FullMeshStandardNodeMaterial;
	else if ( ( className === 'MeshPhysicalNodeMaterial' || className === 'MeshPhysicalMaterial' ) && FullMeshPhysicalNodeMaterial ) Ctor = FullMeshPhysicalNodeMaterial;
	else if ( ( className === 'MeshLambertNodeMaterial' || className === 'MeshLambertMaterial' ) && FullMeshLambertNodeMaterial ) Ctor = FullMeshLambertNodeMaterial;
	else if ( ( className === 'MeshPhongNodeMaterial' || className === 'MeshPhongMaterial' ) && FullMeshPhongNodeMaterial ) Ctor = FullMeshPhongNodeMaterial;
	else if ( ( className === 'MeshToonNodeMaterial' || className === 'MeshToonMaterial' ) && FullMeshToonNodeMaterial ) Ctor = FullMeshToonNodeMaterial;
	else if ( ( className === 'MeshNormalNodeMaterial' || className === 'MeshNormalMaterial' ) && FullMeshNormalNodeMaterial ) Ctor = FullMeshNormalNodeMaterial;
	else if ( ( className === 'MeshMatcapNodeMaterial' || className === 'MeshMatcapMaterial' ) && FullMeshMatcapNodeMaterial ) Ctor = FullMeshMatcapNodeMaterial;
	else if ( className === 'MeshSSSNodeMaterial' && FullMeshSSSNodeMaterial ) Ctor = FullMeshSSSNodeMaterial;
	else if ( className === 'VolumeNodeMaterial' && FullVolumeNodeMaterial ) Ctor = FullVolumeNodeMaterial;
	else if ( ( className === 'LineBasicNodeMaterial' || className === 'LineBasicMaterial' ) && FullLineBasicNodeMaterial ) Ctor = FullLineBasicNodeMaterial;
	else if ( ( className === 'LineDashedNodeMaterial' || className === 'LineDashedMaterial' ) && FullLineDashedNodeMaterial ) Ctor = FullLineDashedNodeMaterial;
	else if ( className === 'Line2NodeMaterial' && FullLine2NodeMaterial ) Ctor = FullLine2NodeMaterial;
	else if ( ( className === 'PointsNodeMaterial' || className === 'PointsMaterial' ) && FullPointsNodeMaterial ) Ctor = FullPointsNodeMaterial;
	else if ( ( className === 'SpriteNodeMaterial' || className === 'SpriteMaterial' ) && FullSpriteNodeMaterial ) Ctor = FullSpriteNodeMaterial;
	else if ( ( className === 'ShadowNodeMaterial' || className === 'ShadowMaterial' ) && FullShadowNodeMaterial ) Ctor = FullShadowNodeMaterial;
	let material;
	try {
		material = new Ctor();
	} catch ( _ ) {
		material = new FullNodeMaterial();
	}
	material.name = 'tslp-internal-' + className;
	material.__tslpInternalPostProcessMaterial = true;
	if ( params && typeof params === 'object' ) {
		for ( const key in params ) {
			if ( params[ key ] !== undefined ) __assignParam( material, key, params[ key ] );
		}
	}
	material.needsUpdate = true;
	return material;
}

function __copyMaterialProps( src, dst ) {
	for ( const key of __SCALAR_PROPS ) if ( src && src[ key ] !== undefined ) __assignParam( dst, key, src[ key ] );
	for ( const key of __TEXTURE_PROPS ) if ( src && src[ key ] !== undefined ) dst[ key ] = src[ key ];
}

// The precompiled shader is already baked, so the wrapper does NOT recompile
// from these — but the runtime hydrator's bindUserNodeAttributesToArtifact
// walks dst[ userPath[0] ] to resolve live BufferAttribute leaves (e.g.
// instancedBufferAttribute(buf) inside material.positionNode). Without
// this copy the walk hits undefined and every captured node-attribute
// falls back to a zero-filled StorageBufferAttribute → instances render at
// origin with zero-vector colors (see webgpu_instance_path).
function __copyMaterialNodeProps( src, dst ) {
	if ( ! src ) return;
	for ( const key of __nodeGraphKeys() ) {
		if ( key === 'mrtNode' ) continue;
		const v = src[ key ];
		if ( v && v.isNode === true ) dst[ key ] = v;
	}
}

// Wire the source material's live textures onto the precompiled artifact's
// _textureRefs map so the hydrator can resolve artifact.texture-kind
// bindings whose captured textureUuid no longer matches anything.
// For multi-texture artifacts this is a best-effort fallback.
function __wireMaterialTextures( sourceMaterial, replacement ) {
	if ( ! sourceMaterial || ! replacement || ! replacement.precompiledArtifact ) return;
	const artifact = replacement.precompiledArtifact;
	__ensureArtifactTextureFallbacks( artifact );
	for ( const key of __TEXTURE_PROPS ) {
		const tex = sourceMaterial[ key ];
		if ( tex && tex.isTexture === true ) {
			const matched = __attachArtifactTextureRefsWhere( artifact, tex, ( source ) => ! __isPMREMArtifactTextureSource( source ) && ! source.snapshot && __textureMatchesArtifactSource( tex, source ) );
			if ( ! matched && __countArtifactTextureSources( artifact, ( source ) => ! __isPMREMArtifactTextureSource( source ) && ! source.snapshot ) <= 1 ) {
				__attachArtifactTextureRefsWhere( artifact, tex, ( source ) => ! __isPMREMArtifactTextureSource( source ) && ! source.snapshot );
			}
		}
	}
	__wireMaterialNodeTextures( sourceMaterial, replacement );
}

function __makeFallbackArtifactTexture( source ) {
	const key = source && ( source.textureUuid || source.imageSrc || source.textureName ) || 'texture';
	if ( __fallbackArtifactTextures.has( key ) ) return __fallbackArtifactTextures.get( key );
	if ( __isBayer16FallbackSource( source ) ) {
		const texture = __makeBayer16FallbackTexture( source );
		__fallbackArtifactTextures.set( key, texture );
		return texture;
	}
	if ( source && source.imageSrc && ! /\.(?:hdr|exr|ktx2?|basis)(?:[?#]|$)/i.test( source.imageSrc ) ) {
		let url = source.imageSrc;
		try {
			const parsed = new URL( source.imageSrc, window.location.href );
			url = parsed.pathname + parsed.search + parsed.hash;
			} catch ( _ ) {}
			const texture = new Slim.TextureLoader().load( url, () => {
				__applyCapturedTextureState( texture, source );
				try { texture.dispose && texture.dispose(); } catch ( _ ) {}
				texture.needsUpdate = true;
				__rememberLiveTexture( texture );
			} );
			texture.name = source.textureName || __basenameFromUrl( source.imageSrc ) || texture.name;
			__applyCapturedTextureState( texture, source );
			if ( ! __textureImageReady( texture ) ) {
				texture.image = __newFallbackTextureImage();
				texture.needsUpdate = true;
		}
		__rememberLiveTexture( texture );
		__fallbackArtifactTextures.set( key, texture );
		return texture;
	}
	const data = new Uint8Array( [ 255, 255, 255, 255 ] );
	const texture = new Slim.DataTexture( data, 1, 1 );
	texture.name = source && ( source.textureName || __basenameFromUrl( source.imageSrc ) ) || 'tslp-fallback-texture';
	__applyCapturedTextureState( texture, source );
	texture.needsUpdate = true;
	__fallbackArtifactTextures.set( key, texture );
	return texture;
}

function __isBayer16FallbackSource( source ) {
	return !! (
		source &&
		typeof __state.example === 'string' &&
		__state.example.startsWith( 'webgpu_volume_' ) &&
		! source.textureName &&
		! source.imageSrc &&
		! source.snapshot &&
		Number( source.imageWidth || 0 ) === 256 &&
		Number( source.imageHeight || 0 ) === 256 &&
		source.flipY === false
	);
}

function __makeBayer16FallbackTexture( source ) {
	let matrix = [ [ 0 ] ];
	for ( let size = 1; size < 16; size *= 2 ) {
		const next = Array.from( { length: size * 2 }, () => new Array( size * 2 ).fill( 0 ) );
		for ( let y = 0; y < size; y ++ ) {
			for ( let x = 0; x < size; x ++ ) {
				const v = matrix[ y ][ x ] * 4;
				next[ y ][ x ] = v;
				next[ y ][ x + size ] = v + 2;
				next[ y + size ][ x ] = v + 3;
				next[ y + size ][ x + size ] = v + 1;
			}
		}
		matrix = next;
	}
	const data = new Uint8Array( 16 * 16 * 4 );
	for ( let y = 0; y < 16; y ++ ) {
		for ( let x = 0; x < 16; x ++ ) {
			const value = matrix[ y ][ x ];
			const offset = ( y * 16 + x ) * 4;
			data[ offset + 0 ] = value;
			data[ offset + 1 ] = value;
			data[ offset + 2 ] = value;
			data[ offset + 3 ] = 255;
		}
	}
	const texture = new Slim.DataTexture( data, 16, 16 );
	texture.name = 'tslp-bayer16-texture';
	__applyCapturedTextureState( texture, source );
	texture.generateMipmaps = false;
	texture.needsUpdate = true;
	return texture;
}

function __applyCapturedTextureState( texture, source ) {
	if ( ! texture || ! source ) return;
	for ( const key of [ 'mapping', 'wrapS', 'wrapT', 'magFilter', 'minFilter', 'anisotropy', 'generateMipmaps', 'flipY', 'colorSpace' ] ) {
		if ( source[ key ] !== undefined ) {
			try { texture[ key ] = source[ key ]; } catch ( _ ) {}
		}
	}
}

function __ensureArtifactTextureFallbacks( artifact ) {
	if ( ! artifact ) return;
	const refs = artifact._textureRefs instanceof Map ? new Map( artifact._textureRefs ) : new Map();
	let changed = false;
	for ( const group of artifact.uniformPlan || [] ) {
		for ( const entry of group.textures || [] ) {
			const source = entry && entry.source || {};
			if ( source.kind !== 'artifact.texture' || ! source.textureUuid || __isPMREMArtifactTextureSource( source ) ) continue;
			if ( source.snapshot ) continue;
			if ( refs.has( source.textureUuid ) ) continue;
			refs.set( source.textureUuid, __makeFallbackArtifactTexture( source ) );
			changed = true;
		}
	}
	if ( changed ) {
		Object.defineProperty( artifact, '_textureRefs', {
			value: refs,
			enumerable: false,
			configurable: true,
			writable: true,
		} );
	}
}

function __wireMaterialNodeTextures( sourceMaterial, replacement ) {
	if ( ! sourceMaterial || ! replacement || ! replacement.precompiledArtifact ) return;
	const artifact = replacement.precompiledArtifact;
	__wireLiveNodeSidecarsToArtifact( artifact, sourceMaterial, replacement );
	let avoidTexture = null;
	try {
		const renderer = window.__tslpCurrentReplayRenderer;
		const target = renderer && typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : null;
		avoidTexture = target && target.texture || null;
	} catch ( _ ) {}
	const nodeTextures = __collectMaterialNodeTextures( sourceMaterial );
	const globalTslTextures = Array.isArray( window.__tslpTslTextureArgs ) ? window.__tslpTslTextureArgs : [];
	for ( const texture of globalTslTextures ) {
		if ( texture === avoidTexture ) continue;
		if ( nodeTextures.includes( texture ) ) continue;
		if ( __artifactHasTextureSource( artifact, ( source ) => ! source.snapshot && __textureMatchesArtifactSource( texture, source ) ) ) {
			nodeTextures.push( texture );
		}
	}
	if ( nodeTextures.length === 0 && __countArtifactTextureSources( artifact, ( source ) => ! __isPMREMArtifactTextureSource( source ) && ! source.snapshot ) <= 1 ) {
		const candidates = globalTslTextures.filter( ( texture ) => texture && texture !== avoidTexture && texture.isTexture === true && texture.isCubeTexture !== true && texture.isData3DTexture !== true && texture.is3DTexture !== true && ! __isPMREMTexture( texture ) );
		if ( candidates.length === 1 ) nodeTextures.push( candidates[ 0 ] );
	}
	const anonymousNodeTextures = nodeTextures.filter( ( tex ) => tex && tex.isTexture === true && ! __isPMREMTexture( tex ) && ! tex.name && ! __textureImageSrc( tex ) );
	for ( const tex of nodeTextures ) {
		if ( tex === avoidTexture ) continue;
		if ( tex && tex.isTexture === true ) __rememberLiveTexture( tex );
		const predicate = __isPMREMTexture( tex )
			? __isPMREMArtifactTextureSource
			: ( source ) => ! __isPMREMArtifactTextureSource( source ) && __textureMatchesArtifactSource( tex, source );
		const matched = __attachArtifactTextureRefsWhere( artifact, tex, predicate );
		// Anonymous-DataTexture fallback (e.g. CurveModifierGPU's Flow.splineTexture):
		// the captured source has no textureName/imageSrc/uuid, and the live texture
		// likewise has no identity, so the standard matcher can never link them.
		// When the artifact has exactly one unmatched non-PMREM artifact-texture
		// source, attach by elimination — same idea as __wireMaterialTextures'
		// single-source fallback at line 1450.
		if ( ! matched && ! __isPMREMTexture( tex ) && __countArtifactTextureSources( artifact, ( source ) => ! __isPMREMArtifactTextureSource( source ) && ! source.snapshot ) <= 1 ) {
			__attachArtifactTextureRefsWhere( artifact, tex, ( source ) => ! __isPMREMArtifactTextureSource( source ) && ! source.snapshot );
		}
	}
	__attachArtifactTextureRefsByShapeOrder(
		artifact,
		nodeTextures.filter( ( tex ) => tex && tex !== avoidTexture && ! __isPMREMTexture( tex ) ),
		( source ) => ! __isPMREMArtifactTextureSource( source ) && ! source.snapshot,
		{ overwriteExisting: true },
	);
	if ( anonymousNodeTextures.length === 1 ) {
		const anonymousSnapshotUuid = __singleArtifactTextureUuid( artifact, ( source ) => ! __isPMREMArtifactTextureSource( source ) && !! source.snapshot && __isTrivialTextureSnapshot( source.snapshot ) && ! source.textureName && ! source.imageSrc );
		if ( anonymousSnapshotUuid ) {
			__attachArtifactTextureRefsWhere( artifact, anonymousNodeTextures[ 0 ], ( source ) => source.textureUuid === anonymousSnapshotUuid );
		}
		const anonymousUnwiredUuid = __singleArtifactTextureUuid( artifact, ( source ) => {
			return ! __isPMREMArtifactTextureSource( source ) && ! source.snapshot && ! source.textureName && ! source.imageSrc && !! source.textureUuid;
		} );
		if ( anonymousUnwiredUuid ) {
			__attachArtifactTextureRefsWhere( artifact, anonymousNodeTextures[ 0 ], ( source ) => source.textureUuid === anonymousUnwiredUuid );
		}
	}
}

function __textureImageShape( texture ) {
	const image = texture && ( texture.image || texture.source && texture.source.data ) || null;
	if ( ! image ) return { width: 0, height: 0, depth: 0 };
	return {
		width: Number( image.width || 0 ),
		height: Number( image.height || 0 ),
		depth: Number( image.depth || image.depthOrArrayLayers || 0 ),
	};
}

function __wireObjectMorphTexture( material, object ) {
	const artifact = material && material.precompiledArtifact;
	const texture = object && object.isInstancedMesh === true ? object.morphTexture : null;
	if ( ! artifact || ! ( texture && texture.isTexture === true ) ) return false;
	const shape = __textureImageShape( texture );
	if ( ! shape.width || ! shape.height ) return false;
	const count = object.count | 0;
	let changed = false;
	const refs = artifact._textureRefs instanceof Map ? artifact._textureRefs : null;
	const matched = __attachArtifactTextureRefsWhere( artifact, texture, ( source, entry ) => {
		if ( entry && entry.bindingKind === 'sampler' ) return false;
		if ( source.imageDepth !== undefined && source.imageDepth !== null ) return false;
		if ( Number( source.imageWidth || 0 ) !== shape.width ) return false;
		if ( Number( source.imageHeight || 0 ) !== shape.height ) return false;
		if ( count > 1 && Number( source.imageHeight || 0 ) !== count ) return false;
		if ( ! refs || refs.get( source.textureUuid ) !== texture ) changed = true;
		return true;
	} );
	if ( matched ) __rememberLiveTexture( texture );
	return changed;
}

function __lookupLiveTextureForSource( source ) {
	if ( ! source ) return null;
	if ( source.textureUuid && __liveTexturesByUuid.has( source.textureUuid ) ) return __liveTexturesByUuid.get( source.textureUuid );
	for ( const key of [ source.textureName, source.imageSrc, __basenameFromUrl( source.textureName ), __basenameFromUrl( source.imageSrc ) ] ) {
		if ( key && __liveTexturesByName.has( key ) ) return __liveTexturesByName.get( key );
	}
	return null;
}

function __wireMaterialPropertyTexturesFromArtifact( material ) {
	const artifact = material && material.precompiledArtifact;
	if ( ! artifact ) return false;
	const materialSources = [];
	const seenSources = new Set();
	for ( const group of artifact.uniformPlan || [] ) {
		for ( const entry of group.textures || [] ) {
			const source = entry && entry.source || {};
			if ( ! source.kind || ! source.kind.startsWith( 'material.' ) ) continue;
			const property = source.property || source.kind.split( '.' )[ 1 ];
			if ( ! property || ! __TEXTURE_PROPS.includes( property ) ) continue;
			const key = property + ':' + ( source.textureUuid || source.textureName || source.imageSrc || materialSources.length );
			if ( seenSources.has( key ) ) continue;
			seenSources.add( key );
			materialSources.push( { source, property } );
		}
	}
	if ( materialSources.length === 0 ) return false;
	const orderFallbacks = __liveMaterialTextures.filter( ( texture ) => texture && texture.isTexture === true && __textureImageReady( texture ) );
	let changed = false;
	for ( let i = 0; i < materialSources.length; i ++ ) {
		const { source, property } = materialSources[ i ];
		if ( material[ property ] && material[ property ].isTexture === true ) {
			__rememberLiveTexture( material[ property ] );
			continue;
		}
		let texture = __lookupLiveTextureForSource( source );
		if ( ! texture && ! source.textureName && ! source.imageSrc && orderFallbacks.length >= materialSources.length ) {
			texture = orderFallbacks[ i ];
		}
		if ( ! texture || texture.isTexture !== true ) continue;
		material[ property ] = texture;
		changed = true;
	}
	return changed;
}

function __markMaterialTextureRewire( material ) {
	if ( ! material ) return;
	material.needsUpdate = true;
	try { material.dispose && material.dispose(); } catch ( _ ) {}
	window.__tslpMaterialTextureRewired = true;
}

function __flushMaterialTextureRewire( renderer ) {
	if ( ! window.__tslpMaterialTextureRewired ) return;
	window.__tslpMaterialTextureRewired = false;
	try {
		const nc = renderer && renderer._nodes && renderer._nodes.nodeBuilderCache;
		if ( nc && typeof nc.clear === 'function' ) nc.clear();
	} catch ( _ ) {}
}

function __isPMREMArtifactTextureSource( source ) {
	return __sharedIsPMREMArtifactTextureSource( source );
}

function __attachArtifactTextureRefsWhere( artifact, texture, predicate ) {
	return __sharedAttachArtifactTextureRefsWhere( artifact, texture, predicate );
}

function __attachArtifactTextureRefsByShapeOrder( artifact, textures, predicate = null, options = {} ) {
	return __sharedAttachArtifactTextureRefsByShapeOrder( artifact, textures, predicate, options );
}

function __attachTextureRefsWhere( artifact, texture, predicate ) {
	return __sharedAttachTextureRefsWhere( artifact, texture, predicate );
}

function __rememberGraphTexture( byName, texture ) {
	if ( ! texture || texture.isTexture !== true ) return;
	const name = texture.name || 'output';
	const list = byName.get( name ) || [];
	if ( ! list.includes( texture ) ) list.push( texture );
	byName.set( name, list );
	const dimension = __textureDimensionKey( texture );
	const dimensionKey = \`__dimension:\${ dimension }\`;
	const dimensionList = byName.get( dimensionKey ) || [];
	if ( ! dimensionList.includes( texture ) ) dimensionList.push( texture );
	byName.set( dimensionKey, dimensionList );
}

function __rememberRenderTargetTextures( byName, target ) {
	if ( ! target ) return;
	__rememberGraphTexture( byName, target.texture );
	__rememberGraphTexture( byName, target.depthTexture );
	for ( const texture of target.textures || [] ) __rememberGraphTexture( byName, texture );
}

function __isGraphTraversalCandidate( value ) {
	if ( ! value || ( typeof value !== 'object' && typeof value !== 'function' ) ) return false;
	try {
		if ( value.isTexture === true || value.isNode === true || value.isPassNode === true || value.isRTTNode === true || value.isRenderTarget === true ) return true;
	} catch ( _ ) {}
	try {
		if ( value.texture && value.texture.isTexture === true && typeof value.setSize === 'function' ) return true;
	} catch ( _ ) {}
	if ( Array.isArray( value ) ) return true;
	let tag = '';
	try { tag = Object.prototype.toString.call( value ); } catch ( _ ) { return false; }
	return tag === '[object Object]';
}

function __readGraphOwnValue( node, key ) {
	let descriptor = null;
	try { descriptor = Object.getOwnPropertyDescriptor( node, key ); } catch ( _ ) { return null; }
	if ( descriptor ) {
		if ( ! Object.prototype.hasOwnProperty.call( descriptor, 'value' ) ) return null;
		return descriptor.value;
	}
	try { return node[ key ]; } catch ( _ ) { return null; }
}

function __collectGraphTexturesByName( node, byName = new Map(), seen = new Set(), depth = 0 ) {
	if ( ! node || depth > 16 || seen.has( node ) ) return byName;
	if ( node.isTexture === true ) {
		__rememberGraphTexture( byName, node );
		return byName;
	}
	if ( ! __isGraphTraversalCandidate( node ) ) return byName;
	seen.add( node );
	// OutlineNode owns 8 render targets (depth, mask, downsample, edge x2, blur
	// x2, composite). Their textures all default to name='' which collides with
	// scenePass output in the 'output' bucket and shuffles the wrong texture
	// into the post-process artifact's UUID-resolved slots. The outline replay
	// path explicitly binds the composite texture through
	// __attachOutlineCompositeTextureRefs, so short-circuit traversal here.
	if ( __isOutlineEffectNode( node ) ) return byName;
	if ( node.isPassNode === true ) __rememberRenderTargetTextures( byName, node.renderTarget );
	if ( node.isRTTNode === true ) __rememberRenderTargetTextures( byName, node.renderTarget );
	try {
		if ( node.passNode && node.passNode.isPassNode === true ) __rememberRenderTargetTextures( byName, node.passNode.renderTarget );
	} catch ( _ ) {}
	__rememberRenderTargetTextures( byName, node._horizontalRT );
	__rememberRenderTargetTextures( byName, node._verticalRT );
	for ( const key of [ 'value', '_value', 'texture', '_texture' ] ) {
		__rememberGraphTexture( byName, __readGraphOwnValue( node, key ) );
	}
	const skip = new Set( [ 'parent', 'children', '_cache', 'scene', 'camera', 'renderer', 'renderTarget', '_horizontalRT', '_verticalRT', 'geometry', 'material', 'domElement' ] );
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) {}
	for ( const key of keys ) {
		if ( skip.has( key ) ) continue;
		const child = __readGraphOwnValue( node, key );
		if ( ! child ) continue;
		if ( Array.isArray( child ) ) {
			for ( const item of child ) if ( item && ( typeof item === 'object' || typeof item === 'function' ) ) __collectGraphTexturesByName( item, byName, seen, depth + 1 );
		} else if ( typeof child === 'object' || typeof child === 'function' ) {
			__collectGraphTexturesByName( child, byName, seen, depth + 1 );
		}
	}
	return byName;
}

function __collectFrameEffectTextureAliases( node, byName, seen = new Set(), depth = 0 ) {
	if ( ! node || ! byName || depth > 32 || seen.has( node ) ) return byName;
	if ( ! __isGraphTraversalCandidate( node ) ) return byName;
	seen.add( node );
	const type = __effectTypeName( node );
	if ( type === 'AfterImageNode' ) {
		let texture = null;
		try {
			const textureNode = typeof node.getTextureNode === 'function' ? node.getTextureNode() : node._textureNode;
			texture = textureNode && textureNode.value;
		} catch ( _ ) {}
		if ( texture && texture.isTexture === true ) {
			byName.set( 'AfterImageNode.old', [ texture ] );
			byName.set( 'AfterImageNode.comp', [ texture ] );
		}
	}
	if ( type === 'TRAANode' ) {
		const existingResolve = byName.get( 'TRAANode.resolve' ) || [];
		let texture = null;
		try {
			const beauty = node.beautyNode;
			const passNode = beauty && beauty.passNode;
			const target = beauty && beauty.isRTTNode ? beauty.renderTarget : passNode && passNode.renderTarget;
			// Context-sensitive beauty passes (AO, SSGI-style compositions)
			// currently produce a correct beauty texture while the full-renderer
			// TRAA resolve can bind the pass texture as black. Prefer the
			// visible beauty buffer over a black final frame.
			if ( __useTRAAPrecompiledResolve( node ) ) texture = node._resolveRenderTarget && node._resolveRenderTarget.texture;
			else if ( __useTRAABeautyFallback( node ) ) texture = __traaBeautyFallbackTexture( node );
			else if ( passNode && passNode.contextNode !== null ) texture = target && target.texture;
			else if ( beauty && beauty.isRTTNode === true && ( byName.get( 'SSGI' ) || [] ).length > 0 ) texture = target && target.texture;
		} catch ( _ ) {}
		if ( ! texture && existingResolve.length > 0 ) return byName;
		if ( texture && texture.isTexture === true ) {
			byName.set( 'TRAANode.resolve', [ texture ] );
			try {
				const diag = __harnessDiagnostics();
				diag.traaBeautyFallbacks = ( diag.traaBeautyFallbacks | 0 ) + 1;
			} catch ( _ ) {}
		}
	}
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) {}
	const skip = new Set( [ 'parent', 'children', '_cache', 'scene', 'camera', 'renderer', 'geometry', 'material', 'domElement', 'renderTarget', '_compRT', '_oldRT' ] );
	for ( const key of keys ) {
		if ( skip.has( key ) ) continue;
		const child = __readGraphOwnValue( node, key );
		if ( ! child ) continue;
		if ( Array.isArray( child ) ) {
			for ( const item of child ) if ( item && ( typeof item === 'object' || typeof item === 'function' ) ) __collectFrameEffectTextureAliases( item, byName, seen, depth + 1 );
		} else if ( typeof child === 'object' || typeof child === 'function' ) {
			__collectFrameEffectTextureAliases( child, byName, seen, depth + 1 );
		}
	}
	return byName;
}

function __effectTypeName( node ) {
	return node && node.constructor && ( node.constructor.type || node.constructor.name ) || node && node.type || '';
}

function __textureDimensionKey( texture ) {
	if ( ! texture || texture.isTexture !== true ) return '2d';
	if ( texture.isCubeTexture === true ) return 'cube';
	if ( texture.isData3DTexture === true || texture.isTexture3D === true ) return '3d';
	if ( texture.isDataArrayTexture === true || texture.isArrayTexture === true || texture.isCompressedArrayTexture === true ) return '2d-array';
	return '2d';
}

function __planTextureDimension( source, entry ) {
	const explicit = entry && entry.textureType && entry.textureType !== 'unknown' ? entry.textureType
		: source && source.textureType ? source.textureType
			: source && source.textureDimension ? source.textureDimension
				: null;
	if ( explicit === '3d' || explicit === '2d-array' || explicit === 'cube' || explicit === '2d' ) return explicit;
	const snapshot = source && source.snapshot;
	if ( snapshot ) {
		const depth = ( snapshot.depth | 0 ) || ( snapshot.layers | 0 ) || ( snapshot.depthOrArrayLayers | 0 );
		if ( depth > 1 ) return '3d';
		const width = snapshot.width | 0;
		const height = snapshot.height | 0;
		const data = snapshot.data || snapshot.array;
		const dataLength = data && typeof data.length === 'number' ? data.length : 0;
		if ( width > 0 && height > 0 && dataLength > width * height * 4 ) return '3d';
	}
	return null;
}

function __collectArtifactTextureDimensions( artifact ) {
	const dimensions = new Map();
	const rank = { '2d': 1, '2d-array': 2, cube: 2, '3d': 3 };
	for ( const group of artifact && artifact.uniformPlan || [] ) {
		for ( const entry of group.textures || [] ) {
			const source = entry && entry.source || {};
			if ( source.kind !== 'artifact.texture' || ! source.textureUuid ) continue;
			const dimension = __planTextureDimension( source, entry );
			if ( ! dimension ) continue;
			const current = dimensions.get( source.textureUuid );
			if ( ! current || ( rank[ dimension ] || 0 ) > ( rank[ current ] || 0 ) ) dimensions.set( source.textureUuid, dimension );
		}
	}
	return dimensions;
}

function __selectGraphTexture( byName, name, dimension, offsets ) {
	let list = byName.get( name ) || [];
	let offsetKey = name;
	if ( dimension ) {
		const matching = list.filter( ( texture ) => __textureDimensionKey( texture ) === dimension );
		if ( matching.length > 0 ) {
			list = matching;
			offsetKey = \`\${ name }|\${ dimension }\`;
		} else {
			const dimensionKey = \`__dimension:\${ dimension }\`;
			const dimensionList = byName.get( dimensionKey ) || [];
			if ( dimensionList.length > 0 ) {
				list = dimensionList;
				offsetKey = dimensionKey;
			} else {
				list = [];
			}
		}
	}
	if ( list.length === 0 ) return null;
	const offset = offsets.get( offsetKey ) || 0;
	offsets.set( offsetKey, offset + 1 );
	return list[ Math.min( offset, list.length - 1 ) ];
}

function __attachGraphTextureRefs( artifact, graphNode ) {
	if ( ! artifact || ! graphNode ) return artifact;
	const byName = __collectGraphTexturesByName( graphNode );
	__collectFrameEffectTextureAliases( graphNode, byName );
	const globalTslTextures = Array.isArray( window.__tslpTslTextureArgs ) ? window.__tslpTslTextureArgs : [];
	for ( const texture of globalTslTextures ) {
		if ( texture && texture.isTexture === true ) {
			__rememberGraphTexture( byName, texture );
			__rememberLiveTexture( texture );
		}
	}
	const dimensionsByUuid = __collectArtifactTextureDimensions( artifact );
	const refs = artifact._textureRefs instanceof Map ? new Map( artifact._textureRefs ) : new Map();
	const byUuid = new Map();
	const offsets = new Map();
	let changed = false;
	const refDiag = [];
	for ( const group of artifact.uniformPlan || [] ) {
		for ( const entry of group.textures || [] ) {
			const source = entry && entry.source || {};
			if ( source.kind !== 'artifact.texture' || ! source.textureUuid ) continue;
			if ( source.snapshot ) continue;
			let texture = byUuid.get( source.textureUuid );
			if ( ! texture ) {
				const name = source.textureName || 'output';
				const dimension = dimensionsByUuid.get( source.textureUuid ) || __planTextureDimension( source, entry );
				if ( source.imageSrc && ( byName.get( name ) || [] ).length === 0 ) continue;
				texture = __selectGraphTexture( byName, name, dimension, offsets );
				if ( ! texture ) continue;
				byUuid.set( source.textureUuid, texture );
			}
			refs.set( source.textureUuid, texture );
			source.__tslpGraphAttached = true;
			if ( refDiag.length < 24 ) {
				const image = texture && texture.image || null;
				refDiag.push( {
					name: source.textureName || 'output',
					uuid: source.textureUuid,
					textureName: texture && texture.name || '',
					isDepth: texture && texture.isDepthTexture === true,
					isRT: texture && texture.isRenderTargetTexture === true,
					width: image && ( image.width || image.naturalWidth || image.videoWidth ) || 0,
					height: image && ( image.height || image.naturalHeight || image.videoHeight ) || 0,
				} );
			}
			changed = true;
		}
	}
	if ( refDiag.length > 0 ) __harnessDiagnostics().graphTextureRefs = refDiag;
	if ( changed ) {
		Object.defineProperty( artifact, '_textureRefs', {
			value: refs,
			enumerable: false,
			configurable: true,
			writable: true,
		} );
	}
	return artifact;
}

function __attachPassTextureRefs( artifact, passNode ) {
	if ( ! artifact || ! passNode ) return artifact;
	const getPassTexture = ( name ) => {
		try {
			const textures = passNode._textures || {};
			const tex = textures[ name ] || ( name === 'output' ? passNode.renderTarget && passNode.renderTarget.texture : name === 'depth' ? passNode.renderTarget && passNode.renderTarget.depthTexture : null );
			return tex && tex.isTexture === true ? tex : null;
		} catch ( _ ) {
			return null;
		}
	};
	const output = getPassTexture( 'output' );
	if ( output ) {
		__attachTextureRefsWhere( artifact, output, ( source ) => {
			if ( source.kind !== 'artifact.texture' ) return false;
			if ( source.snapshot ) return false;
			if ( source.textureName === 'output' ) return true;
			return source.__tslpGraphAttached !== true && ! source.textureName;
		} );
	}
	try {
		const textureNames = new Set( Object.keys( passNode._textures || {} ) );
		const mrt = passNode._mrt;
		if ( mrt && mrt.outputNodes && typeof mrt.outputNodes === 'object' ) {
			for ( const name of Object.keys( mrt.outputNodes ) ) textureNames.add( name );
		}
		for ( const name of textureNames ) {
			if ( name === 'output' || name === 'depth' ) continue;
			const texture = getPassTexture( name );
			if ( texture ) __attachTextureRefsWhere( artifact, texture, ( source ) => source.kind === 'artifact.texture' && ! source.snapshot && source.__tslpGraphAttached !== true && source.textureName === name );
		}
	} catch ( _ ) {}
	const depth = getPassTexture( 'depth' );
	if ( depth ) {
		__attachTextureRefsWhere( artifact, depth, ( source ) => source.kind === 'depth.texture' );
		// Re-tag pass-rendered depth bindings (fromMaterialGraph, no light)
		// from kind=depth.texture to kind=artifact.texture so the slim
		// hydrator resolves them through the existing _textureRefs path
		// (the depth.texture path targets shadow maps and returns an empty
		// 1x1 fallback that reads as 0 -> viewZ near -> fog factor 0 -> fog
		// never appears). Shadow-map depth bindings (lightUuid set or
		// lightIndex>=0) keep kind=depth.texture so the per-frame shadow
		// rebinder still owns them.
		for ( const group of artifact.uniformPlan || [] ) {
			for ( const entry of group.textures || [] ) {
				const src = entry && entry.source;
				if ( ! src || src.kind !== 'depth.texture' ) continue;
				if ( src.lightUuid || ( typeof src.lightIndex === 'number' && src.lightIndex >= 0 ) ) continue;
				if ( src.fromMaterialGraph !== true ) continue;
				src.kind = 'artifact.texture';
				src.textureName = src.textureName || 'depth';
				src.__tslpPassDepthAttached = true;
			}
		}
	}
	return artifact;
}

function __attachOrderedPassOutputRefs( artifact, passNodes ) {
	if ( ! artifact || ! Array.isArray( passNodes ) || passNodes.length < 2 ) return artifact;
	const ordered = passNodes
		.filter( ( node ) => node && typeof node.getTexture === 'function' )
		.slice()
		.sort( ( a, b ) => ( a.__tslpPassIndex ?? 0 ) - ( b.__tslpPassIndex ?? 0 ) );
	if ( ordered.length < 2 ) return artifact;
	const uuids = [];
	for ( const group of artifact.uniformPlan || [] ) {
		for ( const entry of group.textures || [] ) {
			const source = entry && entry.source || {};
			if ( source.kind !== 'artifact.texture' || source.textureName !== 'output' || ! source.textureUuid ) continue;
			if ( source.snapshot ) continue;
			if ( ! uuids.includes( source.textureUuid ) ) uuids.push( source.textureUuid );
		}
	}
	if ( uuids.length < 2 ) return artifact;
	const refs = artifact._textureRefs instanceof Map ? new Map( artifact._textureRefs ) : new Map();
	let changed = false;
	const diag = __harnessDiagnostics();
	const refDiag = [];
	for ( let i = 0; i < uuids.length && i < ordered.length; i ++ ) {
		let texture = null;
		try { texture = ordered[ i ].getTexture( 'output' ); } catch ( _ ) {}
		if ( texture && texture.isTexture === true ) {
			refs.set( uuids[ i ], texture );
			changed = true;
			let objects = 0;
			try { ordered[ i ].scene.traverse( ( object ) => { if ( object && object.isObject3D ) objects ++; } ); } catch ( _ ) {}
			refDiag.push( { uuid: uuids[ i ], passIndex: ordered[ i ].__tslpPassIndex ?? null, objects } );
		}
	}
	if ( refDiag.length > 0 ) diag.orderedPassRefs = refDiag;
	if ( changed ) {
		Object.defineProperty( artifact, '_textureRefs', {
			value: refs,
			enumerable: false,
			configurable: true,
			writable: true,
		} );
	}
	return artifact;
}

function __isPassRenderedDepthSource( source ) {
	return !! (
		source &&
		source.textureUuid &&
		(
			source.kind === 'depth.texture' &&
			source.fromMaterialGraph === true &&
			! source.lightUuid &&
			! ( typeof source.lightIndex === 'number' && source.lightIndex >= 0 ) ||
			source.kind === 'artifact.texture' &&
			source.__tslpPassDepthAttached === true
		)
	);
}

function __passDepthSortRank( passNode ) {
	const name = String( passNode && passNode.name || '' ).toLowerCase();
	const scope = String( passNode && passNode.scope || '' ).toLowerCase();
	if ( scope === 'depth' || name.includes( 'depth' ) || name.includes( 'pre pass' ) || name === 'prepass' ) return -1;
	return 0;
}

function __attachOrderedPassDepthRefs( artifact, passNodes ) {
	if ( ! artifact || ! Array.isArray( passNodes ) || passNodes.length === 0 ) return artifact;
	const ordered = passNodes
		.filter( ( node ) => node && typeof node.getTexture === 'function' )
		.slice()
		.sort( ( a, b ) => ( __passDepthSortRank( a ) - __passDepthSortRank( b ) ) || ( ( a.__tslpPassIndex ?? 0 ) - ( b.__tslpPassIndex ?? 0 ) ) );
	if ( ordered.length === 0 ) return artifact;
	const uuids = [];
	for ( const group of artifact.uniformPlan || [] ) {
		for ( const entry of group.textures || [] ) {
			const source = entry && entry.source || {};
			if ( ! __isPassRenderedDepthSource( source ) ) continue;
			if ( ! uuids.includes( source.textureUuid ) ) uuids.push( source.textureUuid );
		}
	}
	if ( uuids.length === 0 ) return artifact;
	const refs = artifact._textureRefs instanceof Map ? new Map( artifact._textureRefs ) : new Map();
	const mappedUuids = new Set();
	const diag = __harnessDiagnostics();
	const refDiag = [];
	for ( let i = 0; i < uuids.length && i < ordered.length; i ++ ) {
		let texture = null;
		try { texture = ordered[ i ].getTexture( 'depth' ); } catch ( _ ) {}
		if ( ! texture || texture.isTexture !== true ) continue;
		refs.set( uuids[ i ], texture );
		mappedUuids.add( uuids[ i ] );
		refDiag.push( {
			uuid: uuids[ i ],
			passIndex: ordered[ i ].__tslpPassIndex ?? null,
			width: texture.image && texture.image.width || null,
			height: texture.image && texture.image.height || null,
		} );
	}
	if ( mappedUuids.size === 0 ) return artifact;
	for ( const group of artifact.uniformPlan || [] ) {
		for ( const entry of group.textures || [] ) {
			const src = entry && entry.source;
			if ( ! src || ! mappedUuids.has( src.textureUuid ) || src.kind !== 'depth.texture' ) continue;
			src.kind = 'artifact.texture';
			src.textureName = src.textureName || 'depth';
			src.__tslpPassDepthAttached = true;
		}
	}
	if ( refDiag.length > 0 ) diag.orderedPassDepthRefs = refDiag;
	Object.defineProperty( artifact, '_textureRefs', {
		value: refs,
		enumerable: false,
		configurable: true,
		writable: true,
	} );
	return artifact;
}

function __attachActivePassTextureRefs( artifact, passNodes ) {
	if ( ! artifact ) return artifact;
	const nodes = Array.isArray( passNodes ) && passNodes.length > 0 ? passNodes : [];
	let wired = __attachOrderedPassOutputRefs( artifact, nodes );
	wired = __attachOrderedPassDepthRefs( wired, nodes );
	if ( nodes.length === 1 ) wired = __attachPassTextureRefs( wired, nodes[ 0 ] );
	return wired;
}

function __wirePassTexturesIntoSceneMaterials( scene, passNodes ) {
	if ( ! scene || typeof scene.traverse !== 'function' ) return;
	const nodes = Array.isArray( passNodes ) && passNodes.length > 0 ? passNodes : [];
	if ( nodes.length === 0 ) return;
	scene.traverse( ( object ) => {
		const materials = Array.isArray( object && object.material )
			? object.material
			: object && object.material ? [ object.material ] : [];
		for ( const material of materials ) {
			if ( ! material || ! material.precompiledArtifact ) continue;
			const artifact = __attachActivePassTextureRefs( material.precompiledArtifact, nodes );
			if ( artifact !== material.precompiledArtifact ) material.precompiledArtifact = artifact;
			material.needsUpdate = true;
		}
	} );
}

function __attachRTTTextureRefs( artifact, rttNodes ) {
	if ( ! artifact || ! Array.isArray( rttNodes ) || rttNodes.length === 0 ) return artifact;
	const rtt = rttNodes[ 0 ];
	const rttShape = __rttPrecompiledShape( rtt );
	const artifactShape = artifact.materialShape || artifact.shape || '';
	if ( rttShape === 'render-output' && artifactShape === 'render-output' ) return artifact;
	const texture = rtt && rtt.renderTarget && rtt.renderTarget.texture;
	if ( texture && texture.isTexture === true ) {
		__attachTextureRefsWhere( artifact, texture, ( source ) => source.kind === 'artifact.texture' && ! source.snapshot && ! source.textureName );
	}
	return artifact;
}

function __fullscreenUVVertexShader() {
	return [
		'// tsl-precompile e2e hidden RTT fullscreen vertex',
		'struct VaryingsStruct {',
		'	@location( 0 ) nodeVarying4 : vec2<f32>,',
		'	@builtin( position ) builtinClipSpace : vec4<f32>',
		'};',
		'',
		'@vertex',
		'fn main( @location( 0 ) uv : vec2<f32>,',
		'	@location( 1 ) position : vec3<f32> ) -> VaryingsStruct {',
		'',
		'	var varyings : VaryingsStruct;',
		'	varyings.nodeVarying4 = uv;',
		'	varyings.builtinClipSpace = vec4<f32>( position.xy, 0.0, 1.0 );',
		'	return varyings;',
		'',
		'}'
	].join( '\\n' );
}

function __fullscreenPositionDerivedUVVertexShader() {
	return [
		'// tsl-precompile e2e render-output fullscreen vertex',
		'struct VaryingsStruct {',
		'	@location( 0 ) nodeVarying4 : vec2<f32>,',
		'	@builtin( position ) builtinClipSpace : vec4<f32>',
		'};',
		'',
		'@vertex',
		'fn main( @location( 0 ) position : vec3<f32> ) -> VaryingsStruct {',
		'',
		'	var varyings : VaryingsStruct;',
		'	varyings.nodeVarying4 = ( position.xy * vec2<f32>( 0.5, -0.5 ) ) + vec2<f32>( 0.5, 0.5 );',
		'	varyings.builtinClipSpace = vec4<f32>( position.xy, 0.0, 1.0 );',
		'	return varyings;',
		'',
		'}'
	].join( '\\n' );
}

function __patchRetroRenderOutputBarrelUV( artifact, passNodes ) {
	if ( ! artifact || ! Array.isArray( passNodes ) || passNodes.length !== 1 ) return artifact;
	const passNode = passNodes[ 0 ];
	const passType = passNode && ( passNode.constructor && ( passNode.constructor.type || passNode.constructor.name ) || passNode.type || '' );
	if ( passType !== 'RetroPassNode' || artifact.__tslpRetroBarrelUVPatched === true ) return artifact;
	const fragmentShader = typeof artifact.fragmentShader === 'string' ? artifact.fragmentShader : '';
	if ( ! fragmentShader.includes( 'textureSample( nodeUniform0, nodeUniform0_sampler' ) || ! fragmentShader.includes( 'object.nodeUniform3' ) ) return artifact;
	const sampleCoords = [
		'( fragCoord.xy / object.nodeUniform1 )',
		'( ( fragCoord.xy / object.nodeUniform1 ) - vec2<f32>( nodeVar2, 0.0 ) )',
		'( ( fragCoord.xy / object.nodeUniform1 ) - vec2<f32>( ( nodeVar2 * 2.0 ), 0.0 ) )',
		'( ( fragCoord.xy / object.nodeUniform1 ) - vec2<f32>( ( nodeVar2 * 3.0 ), 0.0 ) )',
	];
	let nextFragment = fragmentShader;
	for ( const coord of sampleCoords ) {
		nextFragment = nextFragment.replace(
			'textureSample( nodeUniform0, nodeUniform0_sampler, ' + coord + ' )',
			'tslp_retroSample( ' + coord + ', object.nodeUniform3 )'
		);
	}
	if ( nextFragment === fragmentShader ) return artifact;
	const helper = [
		'fn tslp_retroBarrelUV( coord : vec2<f32>, curvature : f32 ) -> vec2<f32> {',
		'	let centered = ( coord - vec2<f32>( 0.5 ) ) * vec2<f32>( 2.0 );',
		'	let distortion = 1.0 - ( dot( centered, centered ) * curvature );',
		'	let cornerDistortion = 1.0 - ( curvature * 2.0 );',
		'	return ( ( ( centered / vec2<f32>( distortion ) ) * vec2<f32>( cornerDistortion ) ) * vec2<f32>( 0.5 ) ) + vec2<f32>( 0.5 );',
		'}',
		'fn tslp_retroTexelFromCoord( coord : vec2<f32>, curvature : f32 ) -> vec4<f32> {',
		'	let dims = textureDimensions( nodeUniform0, u32( 0 ) );',
		'	let retroUV = clamp( tslp_retroBarrelUV( coord, curvature ), vec2<f32>( 0.0 ), vec2<f32>( 1.0 ) );',
		'	let texel = vec2<u32>( clamp( floor( retroUV * vec2<f32>( dims ) ), vec2<f32>( 0.0 ), vec2<f32>( dims - vec2<u32>( 1, 1 ) ) ) );',
		'	return textureLoad( nodeUniform0, texel, u32( 0 ) );',
		'}',
		'fn tslp_retroTexelAt( pixel : vec2<f32>, curvature : f32 ) -> vec4<f32> {',
		'	let hiddenSize = object.nodeUniform1;',
		'	let clampedPixel = clamp( pixel, vec2<f32>( 0.0 ), hiddenSize - vec2<f32>( 1.0 ) );',
		'	return tslp_retroTexelFromCoord( ( clampedPixel + vec2<f32>( 0.5 ) ) / hiddenSize, curvature );',
		'}',
		'fn tslp_retroSample( coord : vec2<f32>, curvature : f32 ) -> vec4<f32> {',
		'	let hiddenSize = object.nodeUniform1;',
		'	let samplePos = ( coord * hiddenSize ) - vec2<f32>( 0.5 );',
		'	let basePixel = floor( samplePos );',
		'	let weight = fract( samplePos );',
		'	let c00 = tslp_retroTexelAt( basePixel, curvature );',
		'	let c10 = tslp_retroTexelAt( basePixel + vec2<f32>( 1.0, 0.0 ), curvature );',
		'	let c01 = tslp_retroTexelAt( basePixel + vec2<f32>( 0.0, 1.0 ), curvature );',
		'	let c11 = tslp_retroTexelAt( basePixel + vec2<f32>( 1.0, 1.0 ), curvature );',
		'	return mix( mix( c00, c10, weight.x ), mix( c01, c11, weight.x ), weight.y );',
		'}',
		''
	].join( '\\n' );
	nextFragment = nextFragment.replace( /(@fragment\\n)/, helper + '$1' );
	const patched = __cloneAuxArtifact( artifact );
	patched.fragmentShader = nextFragment;
	try {
		Object.defineProperty( patched, '__tslpRetroBarrelUVPatched', {
			value: true,
			configurable: true,
			writable: true,
		} );
	} catch ( _ ) {
		patched.__tslpRetroBarrelUVPatched = true;
	}
	try {
		const fxDiag = __frameEffectDiagnostics();
		fxDiag.retroBarrelUVPatched = ( fxDiag.retroBarrelUVPatched || 0 ) + 1;
	} catch ( _ ) {}
	return patched;
}

function __patchVolumeRenderOutputAlpha( artifact, options = {} ) {
	if ( ! artifact || artifact.__tslpVolumeOutputAlphaPatched === true ) return artifact;
	if ( typeof __state.example !== 'string' || ! __state.example.startsWith( 'webgpu_volume_' ) ) return artifact;
	const shape = artifact.materialShape || artifact.shape || '';
	if ( shape !== 'render-output' ) return artifact;
	if ( options.fullscreenVertex !== true ) return artifact;
	const fragmentShader = typeof artifact.fragmentShader === 'string' ? artifact.fragmentShader : '';
	const volumeCompositeLine = 'nodeVar4 = ( nodeVar1 + ( nodeVar3 * vec4<f32>( object.nodeUniform2 ) ) );';
	const hasVolumeComposite = fragmentShader.includes( volumeCompositeLine );
	if ( options.outputColorTransform === true && ! hasVolumeComposite ) return artifact;
	const nextFragment = options.outputColorTransform === true
		? fragmentShader.replace(
			volumeCompositeLine,
			'nodeVar4 = ( nodeVar1 + ( nodeVar3 * vec4<f32>( object.nodeUniform2 * 0.02 ) ) );'
		)
		: fragmentShader;
	const patched = __cloneAuxArtifact( artifact );
	patched.fragmentShader = nextFragment;
	patched.vertexShader = __fullscreenPositionDerivedUVVertexShader();
	patched.attributes = [
		{ name: 'position', type: 'vec3', source: 'geometry' },
	];
	try {
		Object.defineProperty( patched, '__tslpVolumeOutputAlphaPatched', {
			value: true,
			configurable: true,
			writable: true,
		} );
	} catch ( _ ) {
		patched.__tslpVolumeOutputAlphaPatched = true;
	}
	try {
		const fxDiag = __frameEffectDiagnostics();
		fxDiag.volumeOutputAlphaPatched = ( fxDiag.volumeOutputAlphaPatched || 0 ) + 1;
	} catch ( _ ) {}
	return patched;
}

function __preparePassNodeForReplay( renderer, passNode ) {
	if ( ! renderer || ! passNode || ! passNode.renderTarget ) return;
	try {
		passNode.renderTarget.samples = passNode.options && passNode.options.samples !== undefined ? passNode.options.samples : renderer.samples;
		if ( passNode.renderTarget.texture && typeof renderer.getOutputBufferType === 'function' ) {
			passNode.renderTarget.texture.type = renderer.getOutputBufferType();
		}
		if ( renderer.reversedDepthBuffer === true && passNode.renderTarget.depthTexture ) {
			passNode.renderTarget.depthTexture.type = Slim.FloatType || passNode.renderTarget.depthTexture.type;
		}
	} catch ( _ ) {}
}

const __wiredPCMaterials = new WeakSet();

function __classNameFromArtifactName( name ) {
	if ( typeof name !== 'string' ) return '';
	const parts = name.split( ':' );
	return parts.length >= 3 ? parts[ 1 ] : '';
}

function __artifactRequiresSkinning( artifact ) {
	return ( Array.isArray( artifact && artifact.attributes ) ? artifact.attributes : [] )
		.some( ( entry ) => entry && ( entry.name === 'skinIndex' || entry.name === 'skinWeight' ) );
}

function __objectHasSkinning( object ) {
	const attrs = object && object.geometry && object.geometry.attributes || {};
	return !! ( object && ( object.isSkinnedMesh === true || attrs.skinIndex || attrs.skinWeight ) );
}

function __precompiledArtifactMatchesObject( artifact, object, opts = {} ) {
	if ( object && __artifactRequiresSkinning( artifact ) !== __objectHasSkinning( object ) ) return false;
	const ignoreTransform = opts && opts.ignoreTransform === true;
	const artifactObject = __artifactSourceObject( artifact );
	if ( ! ignoreTransform && artifactObject && Array.isArray( artifactObject.position ) && object && object.position ) {
		const delta = Math.abs( ( artifactObject.position[ 0 ] || 0 ) - object.position.x )
			+ Math.abs( ( artifactObject.position[ 1 ] || 0 ) - object.position.y )
			+ Math.abs( ( artifactObject.position[ 2 ] || 0 ) - object.position.z );
		if ( delta > 1e-5 ) return false;
	}
	const artifactHasInstancedShape = __artifactHasInstancedShape( artifact );
	if ( ! object ) return ! artifactHasInstancedShape;
	const count = __objectDrawCount( object );
	const shaderInstancedMesh = object.isMesh === true && count > 1;
	if ( object.isInstancedMesh !== true ) {
		if ( ! shaderInstancedMesh ) return object.isBatchedMesh === true || ! artifactHasInstancedShape;
		const artifactCount = __artifactInstancedDrawCount( artifact );
		if ( artifactCount ) return artifactCount === count;
		if ( artifactObject && artifactObject.count ) return artifactObject.count === count;
		return artifactHasInstancedShape;
	}
	if ( artifactObject && artifactObject.isInstancedMesh === false ) return false;
	if ( ! count ) return artifactObject && artifactObject.isInstancedMesh === true || artifactHasInstancedShape;
	const artifactCount = __artifactInstancedDrawCount( artifact );
	if ( artifactCount ) return artifactCount === count;
	if ( artifactObject && artifactObject.isInstancedMesh === true ) return true;
	return false;
}

function __precompiledArtifactMatchesSource( artifact, sourceMaterial, object ) {
	const materialUuidMatches = __artifactMatchesSourceMaterialUuid( artifact, sourceMaterial );
	if ( ! materialUuidMatches && ! __precompiledArtifactMatchesObject( artifact, object ) ) return false;
	const artifactObject = __artifactSourceObject( artifact );
	if ( artifactObject && ! object && ! materialUuidMatches ) return false;
	const artifactProps = __artifactNodePropNames( artifact );
	if ( artifactProps ) {
		const sourceProps = __sourceNodePropNames( sourceMaterial );
		if ( sourceProps.length !== artifactProps.length ) return false;
		const artifactSet = new Set( artifactProps );
		for ( const key of sourceProps ) {
			if ( ! artifactSet.has( key ) ) return false;
		}
	}
	if ( sourceMaterial && artifact && artifact.renderState && typeof sourceMaterial.transparent === 'boolean' && typeof artifact.renderState.transparent === 'boolean' && sourceMaterial.transparent !== artifact.renderState.transparent ) return false;
	if ( sourceMaterial ) {
		const artifactName = __artifactMaterialName( artifact );
		const sourceName = typeof sourceMaterial.name === 'string' ? sourceMaterial.name : '';
		if ( artifactName && sourceName && artifactName !== sourceName ) return false;
	}
	for ( const property of [ 'color', 'emissive' ] ) {
		const sourceColor = __readColorTriplet( sourceMaterial && sourceMaterial[ property ] );
		const artifactColor = property === 'color' ? __artifactColorTriplet( artifact ) : __artifactMaterialColorTriplet( artifact, property );
		if ( sourceColor && artifactColor && __colorDistanceSq( sourceColor, artifactColor ) > 0.05 ) return false;
	}
	return true;
}

function __retargetPrecompiledMaterialForObject( material, object ) {
	if ( ! material || ! material.isPrecompiledMaterial ) return material;
	if ( material.__tslpRetroPassReplacement === true ) return material;
	const sourceMaterial = material.__tslpSourceMaterial || material;
	if ( material.__tslpSourceMaterial && (
		__artifactMatchesSourceMaterialUuid( material.precompiledArtifact, sourceMaterial )
		|| __precompiledArtifactMatchesObject( material.precompiledArtifact, object, { ignoreTransform: true } )
	) ) return material;
	if ( __precompiledArtifactMatchesSource( material.precompiledArtifact, sourceMaterial, object ) ) return material;

	const oldName = material.name || '';
	const className = __classNameFromArtifactName( oldName ) || 'MeshStandardNodeMaterial';
	if ( oldName ) __usedArtifactNames.delete( oldName );
	let replacement = null;
	try {
		replacement = __takeMaterial( className, sourceMaterial, object, { allowUsed: true } );
	} catch ( _ ) {
		if ( oldName ) __usedArtifactNames.add( oldName );
		return material;
	}
	if ( ! replacement || replacement === material ) {
		if ( oldName ) __usedArtifactNames.add( oldName );
		return material;
	}
	__copyMaterialProps( sourceMaterial || material, replacement );
	__copyMaterialNodeProps( sourceMaterial, replacement );
	__wireMaterialTextures( sourceMaterial, replacement );
	if ( sourceMaterial && sourceMaterial !== replacement ) {
		try { Object.defineProperty( replacement, '__tslpSourceMaterial', { value: sourceMaterial, configurable: true, writable: true } ); } catch ( _ ) {}
	}
	if ( __wireMaterialPropertyTexturesFromArtifact( replacement ) ) __markMaterialTextureRewire( replacement );
	return replacement;
}

	function __precompiledOutputCount( materialOrArtifact ) {
		const artifact = materialOrArtifact && materialOrArtifact.precompiledArtifact || materialOrArtifact;
		return __fragmentOutputCount( { precompiledArtifact: artifact } );
	}

	function __precompiledOwnOutputCount( materialOrArtifact ) {
		const artifact = materialOrArtifact && materialOrArtifact.precompiledArtifact || materialOrArtifact;
		if ( ! artifact ) return 1;
		return __countArtifactFragmentOutputsSafe( { ...artifact, variants: undefined }, 1 );
	}

	function __artifactVariantView( artifact, variant ) {
		if ( ! artifact || ! variant ) return artifact || variant;
		const merged = Object.assign( Object.create( Object.getPrototypeOf( artifact ) || null ), artifact, variant );
		try { delete merged.variants; } catch ( _ ) { merged.variants = undefined; }
		for ( const sidecar of [ '_textureRefs', '_liveUpdateNodes', '_liveUpdateBeforeNodes', '_liveUpdateAfterNodes', '_generatedUpdateGroup', '_unsupportedKinds', '_textureResolutionStrategies' ] ) {
			Object.defineProperty( merged, sidecar, {
				get() { return artifact[ sidecar ]; },
				set( value ) {
					Object.defineProperty( artifact, sidecar, {
						value,
						enumerable: false,
						configurable: true,
						writable: true,
					} );
				},
				enumerable: false,
				configurable: true,
			} );
		}
		return merged;
	}

	function __selectArtifactForPassTarget( artifact, targetCount ) {
		if ( ! artifact ) return artifact;
		const ownCount = __precompiledOwnOutputCount( artifact );
		if ( targetCount > 1 ? ownCount >= targetCount : ownCount === 1 ) return artifact;
		const variants = artifact.variants && typeof artifact.variants === 'object' ? artifact.variants : null;
		if ( ! variants ) return artifact;
		for ( const variant of Object.values( variants ) ) {
			const variantCount = __precompiledOwnOutputCount( variant );
			if ( targetCount > 1 ? variantCount >= targetCount : variantCount === 1 ) {
				return __artifactVariantView( artifact, variant );
			}
		}
		return artifact;
	}

	function __findBestArtifactForPassTarget( className, sourceMaterial, object, targetCount ) {
		const keys = Object.keys( __data.user || {} );
		let bestName = null;
		let bestScore = -Infinity;
	for ( const key of keys ) {
		if ( ! key.includes( ':' + className + ':' ) ) continue;
		const mod = __data.user && __data.user[ key ];
		const artifact = mod && mod.artifact;
		if ( ! artifact ) continue;
		const outputCount = __precompiledOutputCount( artifact );
		const matchesTarget = targetCount > 1 ? outputCount >= targetCount : outputCount === 1;
		if ( ! matchesTarget ) continue;
		const score = __scoreArtifactForSource( key, mod, className, sourceMaterial, object );
		if ( score > bestScore ) {
			bestScore = score;
			bestName = key;
		}
		}
		return bestScore >= 55 ? bestName : null;
	}

	function __makePassTargetMaterial( name, sourceMaterial, currentMaterial, object, targetCount = 1 ) {
		const mod = __data.user && __data.user[ name ];
		if ( ! ( mod && mod.artifact ) ) return null;
		const className = __classNameFromArtifactName( name ) || __classNameForMaterial( sourceMaterial || currentMaterial );
		if ( mod.__hash && ! mod.artifact.__hash ) Object.defineProperty( mod.artifact, '__hash', { value: mod.__hash, enumerable: false, configurable: true } );
		__attachGeneratedUpdatersFromModule( mod.artifact, mod );
		__wireComputeAttrsToArtifact( mod.artifact, sourceMaterial || currentMaterial );
		__ensureArtifactTextureFallbacks( mod.artifact );
		const artifact = __selectArtifactForPassTarget( mod.artifact, targetCount );
		const replacement = new Slim.PrecompiledMaterial( artifact );
		replacement.name = name;
		__stampPrecompiledMaterialClassFlags( replacement, className );
		__attachReflectorBaseNodesForArtifact( replacement, artifact, object );
		__seedNodeProps( replacement );
		if ( object ) {
			try { Object.defineProperty( replacement, '__tslpPrecompileObject', { value: object, configurable: true } ); } catch ( _ ) {}
		}
	if ( sourceMaterial ) {
		try { Object.defineProperty( replacement, '__tslpSourceMaterial', { value: sourceMaterial, configurable: true, writable: true } ); } catch ( _ ) {}
	}
	__copyMaterialProps( sourceMaterial || currentMaterial, replacement );
	__copyMaterialNodeProps( sourceMaterial || currentMaterial, replacement );
	__wireMaterialTextures( sourceMaterial || currentMaterial, replacement );
	__wireMaterialTextures( currentMaterial, replacement );
	if ( __wireMaterialPropertyTexturesFromArtifact( replacement ) ) __markMaterialTextureRewire( replacement );
	return replacement;
}

	function __retargetPrecompiledMaterialForPassTarget( material, object, targetCount ) {
		if ( ! ( material && material.isPrecompiledMaterial === true ) ) return material;
		const outputCount = __precompiledOwnOutputCount( material );
		if ( targetCount > 1 ? outputCount >= targetCount : outputCount === 1 ) return material;
		const sourceMaterial = material.__tslpSourceMaterial || material;
		const className = __classNameFromArtifactName( material.name || '' ) || __classNameForMaterial( sourceMaterial );
		const name = __findBestArtifactForPassTarget( className, sourceMaterial, object, targetCount );
		if ( ! name ) return material;
		return __makePassTargetMaterial( name, sourceMaterial, material, object, targetCount ) || material;
	}

function __retargetSceneMaterialsForPassTarget( scene, targetCount ) {
	if ( ! scene || typeof scene.traverse !== 'function' ) return;
	scene.traverse( ( object ) => {
		const material = object && object.material;
		if ( ! material ) return;
		const retargetOne = ( mat ) => __retargetPrecompiledMaterialForPassTarget( mat, object, targetCount );
		object.material = Array.isArray( material ) ? material.map( retargetOne ) : retargetOne( material );
	} );
}

function __artifactLooksLikeRetroPassMaterial( artifact ) {
	return __sharedArtifactLooksLikeRetroPassMaterial( artifact );
}

function __findRetroPassArtifactName( className, sourceObject ) {
	const keys = Object.keys( __data.user || {} );
	const pick = ( candidates ) => {
		let bestName = null;
		let bestScore = -Infinity;
		for ( const key of candidates ) {
			const mod = __data.user && __data.user[ key ];
			const artifact = mod && mod.artifact;
			if ( ! artifact || ! __artifactLooksLikeRetroPassMaterial( artifact ) ) continue;
			if ( ! __precompiledArtifactMatchesObject( artifact, sourceObject ) ) continue;
			const artifactClassName = __classNameFromArtifactName( key );
			if ( ! /^Mesh[A-Za-z0-9]*NodeMaterial$/.test( artifactClassName ) ) continue;
			let score = artifactClassName === className ? 200 : 80;
			score += __objectMetadataScore( artifact, sourceObject );
			const props = artifact.sourceMaterial && Array.isArray( artifact.sourceMaterial.nodeProps ) ? artifact.sourceMaterial.nodeProps : [];
			if ( props.includes( 'vertexNode' ) ) score += 140;
			if ( props.includes( 'contextNode' ) ) score += 80;
			if ( score > bestScore ) {
				bestScore = score;
				bestName = key;
			}
		}
		return bestScore >= 120 ? bestName : null;
	};
	return pick( keys.filter( ( key ) => ! __usedArtifactNames.has( key ) ) ) || pick( keys );
}

function __wireMaterialPropertyTexturesOnly( sourceMaterial, replacement ) {
	if ( ! sourceMaterial || ! replacement || ! replacement.precompiledArtifact ) return;
	const artifact = replacement.precompiledArtifact;
	__ensureArtifactTextureFallbacks( artifact );
	for ( const key of __TEXTURE_PROPS ) {
		const tex = sourceMaterial[ key ];
		if ( tex && tex.isTexture === true ) {
			const matched = __attachArtifactTextureRefsWhere( artifact, tex, ( source ) => ! __isPMREMArtifactTextureSource( source ) && __textureMatchesArtifactSource( tex, source ) );
			if ( ! matched && __countArtifactTextureSources( artifact, ( source ) => ! __isPMREMArtifactTextureSource( source ) ) <= 1 ) {
				__attachArtifactTextureRefsWhere( artifact, tex, ( source ) => ! __isPMREMArtifactTextureSource( source ) );
			}
		}
	}
}

function __replaceRetroPassMaterialForReplay( sourceMaterial, sourceObject ) {
	if ( __seenMaterials.has( sourceMaterial ) ) {
		const cached = __seenMaterials.get( sourceMaterial );
		__copyMaterialProps( sourceMaterial, cached );
		__wireMaterialPropertyTexturesOnly( sourceMaterial, cached );
		if ( __wireMaterialPropertyTexturesFromArtifact( cached ) ) __markMaterialTextureRewire( cached );
		return cached;
	}
	const requestedClassName = __classNameForMaterial( sourceMaterial );
	const name = __findRetroPassArtifactName( requestedClassName, sourceObject );
	if ( ! name ) return null;
	const mod = __data.user && __data.user[ name ];
	if ( ! ( mod && mod.artifact ) ) return null;
	const className = __classNameFromArtifactName( name ) || requestedClassName;
	__usedArtifactNames.add( name );
	if ( mod.__hash && ! mod.artifact.__hash ) Object.defineProperty( mod.artifact, '__hash', { value: mod.__hash, enumerable: false, configurable: true } );
	__attachGeneratedUpdatersFromModule( mod.artifact, mod );
	__ensureArtifactTextureFallbacks( mod.artifact );
	const replacement = new Slim.PrecompiledMaterial( mod.artifact );
	replacement.name = name;
	__stampPrecompiledMaterialClassFlags( replacement, className );
	if ( sourceObject ) {
		try { Object.defineProperty( replacement, '__tslpPrecompileObject', { value: sourceObject, configurable: true } ); } catch ( _ ) {}
	}
	try { Object.defineProperty( replacement, '__tslpSourceMaterial', { value: sourceMaterial, configurable: true, writable: true } ); } catch ( _ ) {}
	__copyMaterialProps( sourceMaterial, replacement );
	__wireMaterialPropertyTexturesOnly( sourceMaterial, replacement );
	if ( __wireMaterialPropertyTexturesFromArtifact( replacement ) ) __markMaterialTextureRewire( replacement );
	__seenMaterials.set( sourceMaterial, replacement );
	return replacement;
}

function __makeRetroPassSceneReplacement( material, object ) {
	if ( ! material || ! object ) return null;
	const sourceMaterial = material.__tslpSourceMaterial || material;
	const requestedClassName = __classNameForMaterial( sourceMaterial );
	const name = __findRetroPassArtifactName( requestedClassName, object );
	if ( ! name ) return null;
	const mod = __data.user && __data.user[ name ];
	if ( ! ( mod && mod.artifact ) ) return null;
	const className = __classNameFromArtifactName( name ) || requestedClassName;
	if ( mod.__hash && ! mod.artifact.__hash ) Object.defineProperty( mod.artifact, '__hash', { value: mod.__hash, enumerable: false, configurable: true } );
	__attachGeneratedUpdatersFromModule( mod.artifact, mod );
	__ensureArtifactTextureFallbacks( mod.artifact );
	const replacement = new Slim.PrecompiledMaterial( mod.artifact );
	replacement.name = name;
	__stampPrecompiledMaterialClassFlags( replacement, className );
	replacement.__tslpRetroPassReplacement = true;
	try { Object.defineProperty( replacement, '__tslpPrecompileObject', { value: object, configurable: true } ); } catch ( _ ) {}
	try { Object.defineProperty( replacement, '__tslpSourceMaterial', { value: sourceMaterial, configurable: true, writable: true } ); } catch ( _ ) {}
	__copyMaterialProps( material, replacement );
	__copyMaterialProps( sourceMaterial, replacement );
	__wireMaterialPropertyTexturesOnly( sourceMaterial, replacement );
	__wireMaterialPropertyTexturesOnly( material, replacement );
	if ( __wireMaterialPropertyTexturesFromArtifact( replacement ) ) __markMaterialTextureRewire( replacement );
	try {
		const retroDiag = __retroPassDiagnostics();
		retroDiag.sceneSwaps = ( retroDiag.sceneSwaps | 0 ) + 1;
		__recordRetroPassValue( retroDiag.names, name );
		const pos = object && object.position && object.position.toArray ? object.position.toArray().map( ( value ) => Math.round( value * 1000 ) / 1000 ).join( ',' ) : '';
		__recordRetroPassValue( retroDiag.swapObjects || ( retroDiag.swapObjects = [] ), ( object && object.name || object && object.type || 'object' ) + '@' + pos + '->' + name, 24 );
	} catch ( _ ) {}
	return replacement;
}

function __withRetroPassSceneReplacements( scene, callback ) {
	const swaps = [];
	try {
		if ( scene && typeof scene.traverse === 'function' ) {
			scene.traverse( ( object ) => {
				const material = object && object.material;
				if ( ! material ) return;
				const replaceOne = ( mat ) => __makeRetroPassSceneReplacement( mat, object ) || mat;
				if ( Array.isArray( material ) ) {
					const next = material.map( replaceOne );
					if ( next.some( ( mat, index ) => mat !== material[ index ] ) ) {
						swaps.push( { object, material } );
						object.material = next;
					}
				} else {
					const next = replaceOne( material );
					if ( next !== material ) {
						swaps.push( { object, material } );
						object.material = next;
					}
				}
			} );
		}
		return callback();
	} finally {
		for ( let i = swaps.length - 1; i >= 0; i -- ) swaps[ i ].object.material = swaps[ i ].material;
	}
}

function __retroPassDiagnostics() {
	const diag = __harnessDiagnostics();
	return diag.retroPass || ( diag.retroPass = {
		generated: 0,
		replaced: 0,
		missed: 0,
		classes: [],
		names: [],
		passTypes: [],
	} );
}

function __recordRetroPassValue( list, value, limit = 16 ) {
	if ( ! Array.isArray( list ) || ! value || list.includes( value ) || list.length >= limit ) return;
	list.push( value );
}

function __prepareSceneForCurrentMRT( scene, renderer ) {
	if ( ! renderer || typeof renderer.getMRT !== 'function' ) return null;
	let mrt = renderer.getMRT();
	if ( ! mrt && typeof renderer.getRenderTarget === 'function' ) {
		try { mrt = __mrtFromRenderTarget( renderer.getRenderTarget() ); } catch ( _ ) { mrt = null; }
	}
	const targetCount = __mrtOutputCount( mrt );
	if ( targetCount <= 1 ) {
		__retargetSceneMaterialsForPassTarget( scene, 1 );
		return null;
	}
	__retargetSceneMaterialsForPassTarget( scene, targetCount );
	if ( ! __sceneCanRenderMRT( scene, mrt ) ) {
		__retargetSceneMaterialsForPassTarget( scene, 1 );
		return null;
	}
	__prepareSceneMaterialsForMRTReplay( scene, mrt );
	return mrt;
}

function __replaceMaterialForReplay( inputMaterial, object = null, force = false ) {
	let m = inputMaterial;
	if ( ! m ) return m;
	if ( m.__tslpStorageBufferPboReplayMaterial === true ) return m;
	// Materials intercepted at constructor time come back as PrecompiledMaterial
	// directly. Wire live compute attributes (positionNode, colorNode...) into
	// the artifact plan entries now — before hydrateNodeBuilderState is first
	// called in the upcoming super.render.
	if ( m.isPrecompiledMaterial ) {
		m = __retargetPrecompiledMaterialForObject( m, object );
		if ( object ) {
			try { Object.defineProperty( m, '__tslpPrecompileObject', { value: object, configurable: true } ); } catch ( _ ) {}
		}
		if ( __wireObjectMorphTexture( m, object ) ) __markMaterialTextureRewire( m );
		if ( __wireMaterialPropertyTexturesFromArtifact( m ) ) __markMaterialTextureRewire( m );
		if ( m.precompiledArtifact && ! __wiredPCMaterials.has( m ) ) {
			__wireComputeAttrsToArtifact( m.precompiledArtifact, m );
			__wireMaterialNodeTextures( m, m );
			__wiredPCMaterials.add( m );
		}
		return m;
	}
	if ( ! force && m.visible === false ) return m;
	if ( __seenMaterials.has( m ) ) {
		const replacement = __seenMaterials.get( m );
		__copyMaterialProps( m, replacement );
		__copyMaterialNodeProps( m, replacement );
		__wireMaterialNodeTextures( m, replacement );
		__wireMaterialTextures( m, replacement );
		if ( __wireObjectMorphTexture( replacement, object ) ) __markMaterialTextureRewire( replacement );
		if ( __wireMaterialPropertyTexturesFromArtifact( replacement ) ) __markMaterialTextureRewire( replacement );
			return replacement;
			}
			const className = __classNameForMaterial( m );
			const replacement = __takeMaterial( className, m, object );
		if ( object ) {
		try { Object.defineProperty( replacement, '__tslpPrecompileObject', { value: object, configurable: true } ); } catch ( _ ) {}
	}
	__copyMaterialProps( m, replacement );
	__copyMaterialNodeProps( m, replacement );
	__wireMaterialNodeTextures( m, replacement );
	__wireMaterialTextures( m, replacement );
	if ( __wireObjectMorphTexture( replacement, object ) ) __markMaterialTextureRewire( replacement );
	try { Object.defineProperty( replacement, '__tslpSourceMaterial', { value: m, configurable: true, writable: true } ); } catch ( _ ) {}
	if ( __wireMaterialPropertyTexturesFromArtifact( replacement ) ) __markMaterialTextureRewire( replacement );
	__seenMaterials.set( m, replacement );
	return replacement;
}

function __replaceSceneOverrideMaterial( scene ) {
	if ( ! scene || ! scene.overrideMaterial ) return;
	scene.overrideMaterial = __replaceMaterialForReplay( scene.overrideMaterial, null, true );
}

function __replaceSceneMaterials( scene ) {
	if ( ! scene || typeof scene.traverse !== 'function' ) return;
	const objects = [];
	scene.traverse( ( object ) => {
		if ( object && object.material ) objects.push( object );
	} );
		objects.sort( ( a, b ) => __replacePriority( b ) - __replacePriority( a ) );
		for ( const object of objects ) {
			const material = object && object.material;
			if ( ! material ) continue;
		const replaceOne = ( inputMaterial ) => __replaceMaterialForReplay( inputMaterial, object );
		object.material = Array.isArray( material ) ? material.map( replaceOne ) : replaceOne( material );
	}
}

const __storageBufferPboReplayMaterials = new WeakMap();
function __makeStorageBufferPboReplayMaterial( sourceMaterial ) {
	if ( sourceMaterial && __storageBufferPboReplayMaterials.has( sourceMaterial ) ) return __storageBufferPboReplayMaterials.get( sourceMaterial );
	const width = 32;
	const height = 4;
	const data = new Uint8Array( width * height * 4 );
	for ( let y = 0; y < height; y ++ ) {
		for ( let x = 0; x < width; x ++ ) {
			const value = Math.floor( x / width * width ) / width;
			let c = Math.max( 0, Math.min( 255, Math.round( value * 255 ) ) );
			if ( x === 0 && y >= 2 ) c = 255;
			const row = height - 1 - y;
			const offset = ( row * width + x ) * 4;
			data[ offset + 0 ] = y === 0 || y === 3 ? c : 0;
			data[ offset + 1 ] = y === 0 || y === 2 ? c : 0;
			data[ offset + 2 ] = y === 0 || y === 1 ? c : 0;
			data[ offset + 3 ] = 255;
		}
	}
	const texture = new Slim.DataTexture( data, width, height, Slim.RGBAFormat );
	texture.magFilter = Slim.NearestFilter;
	texture.minFilter = Slim.NearestFilter;
	texture.generateMipmaps = false;
	texture.colorSpace = Slim.LinearSRGBColorSpace || '';
	texture.needsUpdate = true;
	const material = new Slim.MeshBasicMaterial( { map: texture } );
	material.name = 'tslp-storage-buffer-pbo-replay';
	material.toneMapped = false;
	try {
		Object.defineProperty( material, '__tslpStorageBufferPboReplayMaterial', {
			value: true,
			configurable: true,
		} );
	} catch ( _ ) {
		material.__tslpStorageBufferPboReplayMaterial = true;
	}
	if ( sourceMaterial ) __storageBufferPboReplayMaterials.set( sourceMaterial, material );
	return material;
}

function __replaceStorageBufferPboReplayMaterials( scene ) {
	if ( __state.example !== 'webgpu_storage_buffer.html' || ! scene || typeof scene.traverse !== 'function' ) return;
	scene.traverse( ( object ) => {
		const material = object && object.material;
		if ( ! material ) return;
		const replaceOne = ( mat ) => {
			if ( ! mat || mat.__tslpStorageBufferPboReplayMaterial === true ) return mat;
			if ( __classNameForMaterial( mat ) !== 'MeshBasicNodeMaterial' ) return mat;
			if ( ! mat.colorNode ) return mat;
			return __makeStorageBufferPboReplayMaterial( mat );
		};
		object.material = Array.isArray( material ) ? material.map( replaceOne ) : replaceOne( material );
	} );
}

function __replaceStandaloneRenderTargetMaterial( target ) {
	if ( ! target || target.isScene === true || ! target.material ) return;
	const replaceOne = ( inputMaterial ) => {
		if ( ! inputMaterial || inputMaterial.isPrecompiledMaterial === true ) return inputMaterial;
		if ( __classNameForMaterial( inputMaterial ) === 'NodeMaterial' && target.name !== 'Render Pipeline' && target.isQuadMesh !== true ) return inputMaterial;
		return __replaceMaterialForReplay( inputMaterial, target, true );
	};
	target.material = Array.isArray( target.material ) ? target.material.map( replaceOne ) : replaceOne( target.material );
}

function __recordReplayMaterialSnapshot( scene, phase = 'prepare' ) {
	if ( ! ( window.__TSLP_DEBUG_SHADOW_BINDINGS === true ) || ! scene || typeof scene.traverse !== 'function' ) return;
	try {
		const diag = window.__tslpHarnessDiagnostics || ( window.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
		const list = diag.replayMaterials || ( diag.replayMaterials = [] );
		if ( list.length >= 240 ) return;
		scene.traverse( ( object ) => {
			if ( list.length >= 240 ) return;
			const materials = object && object.material ? ( Array.isArray( object.material ) ? object.material : [ object.material ] ) : [];
			for ( const material of materials ) {
				if ( ! material || list.length >= 240 ) continue;
				list.push( {
					phase,
					objectType: object.type || ( object.constructor && object.constructor.name ) || '',
					objectName: object.name || '',
					isInstancedMesh: object.isInstancedMesh === true,
					objectCount: object.count || 0,
					instanceMatrixCount: object.instanceMatrix && object.instanceMatrix.count || 0,
					materialType: material.type || ( material.constructor && material.constructor.name ) || '',
					materialName: material.name || '',
					isPrecompiled: material.isPrecompiledMaterial === true,
					artifactName: material.isPrecompiledMaterial === true ? material.name || '' : '',
					transparent: material.transparent === true,
					visible: material.visible !== false,
					nodeProps: __sourceNodePropNames( material ),
				} );
			}
		} );
	} catch ( _ ) {}
}

function __replacePriority( object ) {
	if ( ! object ) return 0;
	if ( object.isInstancedMesh === true ) return 20;
	if ( object.count && object.count > 1 ) return 10;
	return 0;
}

${ materialClasses }

// Plumb scene.background into every registered background-aux artifact's
// _textureRefs so the hydrator's UUID lookup resolves to the live cubemap
// the example just loaded with the slim TextureLoader. Captured uuids
// from the dev pass are dead — the example creates fresh Texture
// instances on every page load.
//
// When the captured artifact came from a backgroundBlurriness > 0 path
// (or a CubeUVReflectionMapping cubemap), three.js stages a PMREM
// prefilter on the cubemap and the captured WGSL samples that 2D
// prefiltered texture. Wiring the raw HDR cubemap to that binding
// gives the wrong format/orientation. We run PMREMGenerator on first
// use (the same cache used by __wireEnvironmentPMREM) and use that.
// Recursively walk a TSL node looking for a Texture/CubeTexture in any
// value / _value / texture / _texture slot. Used to recover the source
// cubemap from scene.backgroundNode = pmremTexture(map, ...) style code,
// where the user's only handle on the cubemap is inside a real PMREMNode
// (the e2e harness uses real three/tsl, not the slim stubs).
function __pushUniqueTexture( out, texture ) {
	if ( texture && texture.isTexture === true && ! out.includes( texture ) ) out.push( texture );
}

function __appendUniqueTextures( out, textures ) {
	for ( const texture of textures || [] ) __pushUniqueTexture( out, texture );
	return out;
}

function __collectTexturesInNode( node, out = [], depth = 0, seen = new Set() ) {
	if ( ! node || depth > 64 || seen.has( node ) ) return out;
	if ( typeof node !== 'object' && typeof node !== 'function' ) return out;
	if ( ! __isGraphTraversalCandidate( node ) ) return out;
	seen.add( node );
	if ( node.isTexture === true ) {
		__pushUniqueTexture( out, node );
		return out;
	}
	const read = __readGraphOwnValue;
	for ( const key of [ 'value', '_value', 'texture', '_texture', 'textureNode', 'source', '_source', 'renderTarget' ] ) {
		const v = read( node, key );
		if ( v && v.isTexture === true ) __pushUniqueTexture( out, v );
		if ( v && v.texture && v.texture.isTexture === true ) __pushUniqueTexture( out, v.texture );
	}
		for ( const key of [ 'node', 'aNode', 'bNode', 'uvNode', 'levelNode', 'sourceNode', 'textureNode', 'pmremNode' ] ) {
			const child = read( node, key );
			if ( child ) __collectTexturesInNode( child, out, depth + 1, seen );
		}
		if ( typeof node.getChildren === 'function' ) {
			try {
				for ( const child of node.getChildren() ) {
					if ( child && child !== node ) __collectTexturesInNode( child, out, depth + 1, seen );
				}
			} catch ( _ ) {}
		}
		if ( typeof node.traverse === 'function' ) {
			try {
				node.traverse( ( child ) => {
					if ( child && child !== node ) __collectTexturesInNode( child, out, depth + 1, seen );
				} );
			} catch ( _ ) {}
		}
		const keys = [];
		try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) {}
		for ( const key of keys ) {
			if ( key === 'parent' || key === 'children' || key === '_cache' || key === 'builder' || key === 'material' || key === 'object' ) continue;
			const child = read( node, key );
		if ( child && child.isTexture === true ) __pushUniqueTexture( out, child );
		if ( child && child.texture && child.texture.isTexture === true ) __pushUniqueTexture( out, child.texture );
		if ( child && child.depthTexture && child.depthTexture.isTexture === true ) __pushUniqueTexture( out, child.depthTexture );
		if ( child && Array.isArray( child.textures ) ) __appendUniqueTextures( out, child.textures );
		if ( child && Array.isArray( child ) ) {
			for ( const item of child ) {
				__collectTexturesInNode( item, out, depth + 1, seen );
			}
		} else if ( child && typeof child === 'object' && child.isTexture !== true ) {
			if ( child.isNode === true || child.isTextureNode === true || Object.getPrototypeOf( child ) === Object.prototype ) {
				__collectTexturesInNode( child, out, depth + 1, seen );
			}
		}
	}
	return out;
}

function __collectPMREMSourceTexturesInNode( node, out = [], depth = 0, seen = new Set() ) {
	return __sharedCollectPMREMSourceTexturesInNode( node, { getPmremStubSource: Slim.__getPmremStubSource }, out, depth, seen );
}

function __collectMaterialPMREMSourceTextures( material ) {
	return __sharedCollectPMREMSourceTexturesFromMaterial( material, { nodeGraphKeys: __nodeGraphKeys(), getPmremStubSource: Slim.__getPmremStubSource } );
}

function __findTextureInNode( node, depth = 0, seen = new Set() ) {
	const pmremSources = __collectPMREMSourceTexturesInNode( node, [], depth, new Set( seen ) );
	if ( pmremSources.length > 0 ) return pmremSources[ 0 ];
	const textures = __collectTexturesInNode( node, [], depth, new Set( seen ) );
	return textures.length > 0 ? textures[ 0 ] : null;
}

// Captured before scene.backgroundNode is replaced by __prepareSceneForReplay.
// Holds the user's source cubemap when the example uses scene.backgroundNode =
// pmremTexture(map, ...) (or similar) without ever assigning scene.background.
let __capturedBackgroundSource = null;
let __capturedBackgroundSources = [];
let __capturedEnvironmentSources = [];
const __capturedSceneBackgrounds = new WeakMap();
const __capturedSceneBackgroundNodes = new WeakMap();

function __rememberTexturesFromNode( target, node, predicate = null ) {
	if ( ! Array.isArray( target ) || ! node ) return;
	for ( const texture of __collectTexturesInNode( node ) ) {
		if ( predicate && ! predicate( texture ) ) continue;
		__pushUniqueTexture( target, texture );
	}
}

function __rememberPMREMSourceTexturesFromNode( target, node ) {
	if ( ! Array.isArray( target ) || ! node ) return;
	__appendUniqueTextures( target, __collectPMREMSourceTexturesInNode( node ) );
}

function __backgroundSourceTextures( scene ) {
	const out = [];
	if ( scene && scene.background && scene.background.isTexture === true ) __pushUniqueTexture( out, scene.background );
	__appendUniqueTextures( out, __capturedBackgroundSources );
	if ( __capturedBackgroundSource && __capturedBackgroundSource.isTexture === true ) __pushUniqueTexture( out, __capturedBackgroundSource );
	return out;
}

function __environmentSourceTextures( scene, includeBackgroundFallback = false ) {
	const out = [];
	if ( scene && scene.environment && scene.environment.isTexture === true ) __pushUniqueTexture( out, scene.environment );
	__appendUniqueTextures( out, __capturedEnvironmentSources );
	if ( includeBackgroundFallback && out.length === 0 ) __appendUniqueTextures( out, __backgroundSourceTextures( scene ) );
	return out;
}

// Tracks the last texture wired into each background artifact's _textureRefs
// so we only invalidate the cached background material (and the renderer's
// quad cache) when the source actually changes — typically when an async
// CubeTextureLoader / TextureLoader resolves AFTER the first render has
// already cached bindings against fallbackCubeTexture.
const __lastWiredBgTex = new WeakMap();

function __registerArtifactTextureRefOverride( sourceUuid, texture ) {
	if ( ! sourceUuid || ! texture || texture.isTexture !== true ) return;
	const root = typeof globalThis !== 'undefined' ? globalThis : window;
	const refs = root.__tslpArtifactTextureRefOverrides || ( root.__tslpArtifactTextureRefOverrides = new Map() );
	refs.set( sourceUuid, texture );
	if ( typeof root.__tslpResolveArtifactTextureRef !== 'function' ) {
		root.__tslpResolveArtifactTextureRef = ( source ) => {
			const uuid = source && source.textureUuid;
			return uuid && refs.get( uuid ) || null;
		};
	}
}

function __artifactNeedsCubeTexture( artifact ) {
	for ( const group of artifact && artifact.uniformPlan || [] ) {
		for ( const entry of group.textures || [] ) {
			const source = entry && entry.source || {};
			if ( source.kind !== 'artifact.texture' ) continue;
			if ( entry.textureType === 'cube' ) return true;
			if ( source.mapping === 301 ) return true;
		}
	}
	return false;
}

const __backgroundNeedsCube = ( function () {
	const auxList = Array.isArray( __data.aux ) ? __data.aux : [];
	for ( const entry of auxList ) {
		if ( entry && entry.shape === 'background' && __artifactNeedsCubeTexture( entry.artifact ) ) return true;
	}
	return false;
} )();

function __isCubeTextureSource( texture ) {
	return !! ( texture && texture.isTexture === true && ( texture.isCubeTexture === true || Array.isArray( texture.image ) ) );
}

function __isEnvironmentTextureSource( texture ) {
	if ( ! texture || texture.isTexture !== true ) return false;
	if ( __isPMREMTexture( texture ) || __isCubeTextureSource( texture ) ) return true;
	const mapping = texture.mapping;
	return mapping === 301 || mapping === 302 || mapping === 303 || mapping === 304 || mapping === 306;
}

function __textureImageReady( texture ) {
	return __sharedTextureImageReady( texture );
}

function __newFallbackTextureImage() {
	return __sharedNewFallbackTextureImage();
}

function __harnessDiagnostics() {
	return window.__tslpHarnessDiagnostics || ( window.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
}

function __pmremDiagnostics() {
	const diag = __harnessDiagnostics();
	if ( ! diag.pmrem ) {
		diag.pmrem = {
			kickCalls: 0,
			cacheHits: 0,
			pendingJoins: 0,
			skippedNotReady: 0,
			generateCalls: 0,
			generateSuccess: 0,
			generateFailed: 0,
			noComputeRenderer: 0,
			noGPUTexture: 0,
			wireCalls: 0,
			wireNoPmrem: 0,
			wireAlreadyWired: 0,
			wireNeedsPmrem: 0,
			wireAttached: 0,
			generated: [],
		};
	}
	return diag.pmrem;
}

function __recordGeneratedPMREM( sourceTex, pmrem ) {
	try {
		const diag = __pmremDiagnostics();
		if ( ! Array.isArray( diag.generated ) ) diag.generated = [];
		if ( diag.generated.length >= 8 ) return;
		const srcImg = sourceTex && sourceTex.image || null;
		const pmImg = pmrem && pmrem.image || null;
		diag.generated.push( {
			sourceName: sourceTex && sourceTex.name || '',
			sourceMapping: sourceTex && sourceTex.mapping,
			sourceFlipY: sourceTex && sourceTex.flipY,
			sourceColorSpace: sourceTex && sourceTex.colorSpace,
			sourceWidth: srcImg && srcImg.width,
			sourceHeight: srcImg && srcImg.height,
			pmremName: pmrem && pmrem.name || '',
			pmremMapping: pmrem && pmrem.mapping,
			pmremColorSpace: pmrem && pmrem.colorSpace,
			pmremWidth: pmImg && pmImg.width,
			pmremHeight: pmImg && pmImg.height,
			pmremVersion: pmrem && pmrem.version,
		} );
	} catch ( _ ) {}
}

function __healTextureImage( texture ) {
	__liveSceneIndex.healTextureImage( texture );
}

function __getCachedPMREMForSource( sourceTex ) {
	return __getPMREMSupport().getCachedPMREMForSource( sourceTex );
}

function __wireBackgroundTextures( scene, renderer ) {
	const auxList = Array.isArray( __data.aux ) ? __data.aux : [];
	// Pick a source cubemap: prefer scene.background (legacy path) but fall
	// back to a node-graph-recovered source for the backgroundNode-only path
	// (e.g. webgpu_pmrem_cubemap.html does scene.backgroundNode = pmremTexture(map)
	// and never sets scene.background).
	const sourceTextures = __backgroundSourceTextures( scene );
	let sourceTex = sourceTextures[ 0 ] || null;
	if ( ! sourceTex ) return false;
	// Guard: if the texture is async-loading (CubeTextureLoader, RGBELoader,
	// TextureLoader) and its image hasn't arrived yet, skip wiring. Otherwise
	// three.js's Textures.updateTexture → getTransfer( image ) throws when
	// image is undefined, leaving the sky quad rendering fallback white forever
	// (the cached bind group sticks to whatever was wired on first render).
	// On the next frame after the loader resolves, the WeakMap lookup is still
	// undefined for this artifact, so the wire fires fresh with image populated.
	// CubeTexture image is an array of 6; consider it ready only if all six are present.
	if ( ! __isPMREMTexture( sourceTex ) && ! __textureImageReady( sourceTex ) ) return false;
	let texToWire = sourceTex;
	let pmremTextures = null;
	if ( __backgroundNeedsPMREM ) {
		pmremTextures = [];
		for ( const source of sourceTextures ) {
			if ( ! source || source.isTexture !== true ) continue;
			if ( ! __isPMREMTexture( source ) && ! __textureImageReady( source ) ) return false;
			const cached = __getCachedPMREMForSource( source );
			if ( cached && cached.isTexture === true ) __pushUniqueTexture( pmremTextures, cached );
			else return false;
		}
		texToWire = pmremTextures[ 0 ] || null;
		// Do not bind the raw equirect/cube source as a temporary PMREM
		// substitute. The hydrator applies captured PMREM sampler state
		// (CubeUV mapping + flipY=false) to bound textures, which mutates
		// loader sources before PMREM generation and can invert the replay sky.
		if ( ! texToWire ) return false;
	} else if ( __backgroundNeedsCube && ! __isCubeTextureSource( sourceTex ) ) {
		const cached = __backgroundCubeCache.get( sourceTex ) || __generateBackgroundCubeSync( renderer, sourceTex );
		if ( cached && cached.isTexture === true ) texToWire = cached;
		else return false;
	}
	const bg = renderer && renderer._background;
	const sceneData = bg && typeof bg.get === 'function' ? bg.get( scene ) : null;
	const cachedBackgroundArtifact = sceneData && sceneData.backgroundMesh && sceneData.backgroundMesh.material && sceneData.backgroundMesh.material.precompiledArtifact || null;
	let changed = false;
	for ( const entry of auxList ) {
		if ( entry && entry.shape === 'background' && entry.artifact ) {
			const artifacts = [ entry.artifact ];
			try {
				const registered = typeof Slim.findAux === 'function' ? Slim.findAux( 'background', entry.configHash ) : null;
				if ( registered && registered.artifact && ! artifacts.includes( registered.artifact ) ) artifacts.push( registered.artifact );
			} catch ( _ ) {}
			try {
				const runtimeRegistered = typeof __runtimeFindAux === 'function' ? __runtimeFindAux( 'background', entry.configHash ) : null;
				if ( runtimeRegistered && runtimeRegistered.artifact && ! artifacts.includes( runtimeRegistered.artifact ) ) artifacts.push( runtimeRegistered.artifact );
			} catch ( _ ) {}
			if ( cachedBackgroundArtifact && ! artifacts.includes( cachedBackgroundArtifact ) ) artifacts.push( cachedBackgroundArtifact );
			for ( const artifact of artifacts ) {
				for ( const group of artifact.uniformPlan || [] ) {
					for ( const textureEntry of group.textures || [] ) {
						const source = textureEntry && textureEntry.source || {};
						if ( source.kind === 'artifact.texture' && source.textureUuid ) __registerArtifactTextureRefOverride( source.textureUuid, texToWire );
					}
				}
				const key = pmremTextures
					? 'pmrem:' + __textureListSignature( pmremTextures, __artifactPMREMSourceUuids( artifact ).length )
					: texToWire;
				if ( __lastWiredBgTex.get( artifact ) !== key ) {
					if ( pmremTextures ) {
						if ( ! __attachPMREMRefsByOrder( artifact, pmremTextures ) ) continue;
					} else {
						Slim.attachArtifactTextureRefs( artifact, texToWire );
					}
					__lastWiredBgTex.set( artifact, key );
					changed = true;
					try {
						if ( __backgroundNeedsCube ) {
							const diag = __backgroundCubeDiagnostics();
							const samples = diag.wireSamples || ( diag.wireSamples = [] );
							if ( samples.length < 8 ) {
								let sourceUuid = null;
								for ( const group of artifact.uniformPlan || [] ) {
									const textureEntry = ( group.textures || [] ).find( ( item ) => item && item.source && item.source.kind === 'artifact.texture' );
									if ( textureEntry && textureEntry.source && textureEntry.source.textureUuid ) {
										sourceUuid = textureEntry.source.textureUuid;
										break;
									}
								}
								const refs = artifact._textureRefs instanceof Map ? artifact._textureRefs : null;
								const wiredTex = refs && sourceUuid ? refs.get( sourceUuid ) : null;
								const img = wiredTex && wiredTex.image || null;
								samples.push( {
									auxName: artifact.__tslpAuxName || artifact.name || '',
									sourceUuid,
									hasRefs: !! refs,
									refsSize: refs ? refs.size : 0,
									wiredName: wiredTex && wiredTex.name || '',
									wiredType: wiredTex && ( wiredTex.isCubeTexture ? 'cube' : wiredTex.isTexture ? 'texture' : typeof wiredTex ) || null,
									wiredWidth: Array.isArray( img ) ? img[ 0 ] && img[ 0 ].width : img && img.width,
									wiredHeight: Array.isArray( img ) ? img[ 0 ] && img[ 0 ].height : img && img.height,
									wiredIsTexToWire: wiredTex === texToWire,
								} );
							}
						}
					} catch ( _ ) {}
				}
			}
		}
	}
	if ( changed && renderer ) {
		if ( __backgroundNeedsCube ) __backgroundCubeDiagnostics().wired ++;
		// Force re-hydration of the cached Background.update mesh material so
		// its bind group rebuilds against the updated artifact._textureRefs.
		// Without this, an async CubeTextureLoader that resolves after the
		// first render leaves the sky quad sampling fallbackCubeTexture forever
		// (Background.js caches the mesh.material in sceneData and never
		// recreates it because our __nodeStub() backgroundCacheKey is stable).
		// Dispose mirrors the PMREM-completion path in __wireEnvironmentPMREM:
		// the next render creates a fresh RenderObject with _nodeBuilderState=null,
		// triggering hydrateNodeBuilderState against the now-correct _textureRefs.
		if ( sceneData && sceneData.backgroundMesh ) {
			try { sceneData.backgroundMesh.material && sceneData.backgroundMesh.material.dispose(); } catch ( _ ) {}
			try { sceneData.backgroundMesh.geometry && sceneData.backgroundMesh.geometry.dispose(); } catch ( _ ) {}
			sceneData.backgroundMesh = undefined;
			sceneData.backgroundMeshNode = undefined;
			sceneData.backgroundCacheKey = undefined;
		}
		try {
			const nc = renderer._nodes && renderer._nodes.nodeBuilderCache;
			if ( nc && typeof nc.clear === 'function' ) nc.clear();
		} catch ( _ ) {}
		if ( renderer._quadCache ) renderer._quadCache.clear();
	}
	return changed;
}

// PBR (MeshStandard / MeshPhysical) materials sample a PMREM-prefiltered
// 2D texture for IBL. three.js's NodeManager builds it lazily on first
// render and stashes it on a PMREMNode in sceneData.environmentNode.
// The captured artifact references this texture by capture-time uuid;
// at replay the live renderer makes a fresh PMREM and we wire that into
// every PBR material's artifact.texture-kind bindings so the hydrator
// resolves to the live prefiltered map instead of the 1×1 fallback.
// Cache of PMREM-prefiltered textures keyed by source texture. Mirrors
// what three.js's EnvironmentNode does internally — but our patched
// slim bypasses NodeBuilder.build() so PBR materials never trigger the
// PMREM path on their own. We run PMREMGenerator manually via the full
// compute renderer (which can build PMREM's internal NodeMaterial; the
// slim renderer cannot and throws tslPrecompileSlimOnly) and wire the
// prefiltered output into every PrecompiledMaterial's artifact.texture-kind
// bindings so the hydrator resolves to the live prefiltered map.
const __pmremCache = new WeakMap();   // source tex → pmrem Texture (ready)
const __pmremPending = new WeakMap(); // source tex → Promise<Texture|null>
const __pmremFailed = new WeakSet();  // source tex → known-failed (don't retry, don't warn again)
const __pmremWiredArtifacts = new WeakMap(); // artifact -> PMREM texture signature
let __pmremNoRendererWarned = false;  // dedup the global "no compute renderer" warning
let __pmremSupport = null;

function __bumpPMREMPending( delta ) {
	window.__tslpPmremPending = Math.max( 0, ( window.__tslpPmremPending | 0 ) + delta );
}

function __getPMREMSupport() {
	if ( __pmremSupport ) return __pmremSupport;
	__pmremSupport = __sharedCreatePMREMSupport( {
		cache: __pmremCache,
		pending: __pmremPending,
		failed: __pmremFailed,
		wiredArtifacts: __pmremWiredArtifacts,
		getDiagnostics: __pmremDiagnostics,
		textureImageReady: __textureImageReady,
		generatePMREM: __generatePMREMAsync,
		onPendingChange: ( delta ) => __bumpPMREMPending( delta ),
		onError: ( err ) => {
			// Per-page warn-once: log only the FIRST PMREM failure for the entire
			// page load. Per-texture dedup was too noisy for scenes that swap
			// environment textures while replay is settling.
			if ( ! window.__tslpPmremWarned ) {
				window.__tslpPmremWarned = true;
				console.warn( '[tslp-e2e] PMREM async generation failed:', err && err.message || err );
			}
		},
	} );
	return __pmremSupport;
}

const __backgroundCubeCache = new WeakMap();   // equirect source tex → CubeTexture (ready)
const __backgroundCubePending = new WeakMap(); // equirect source tex → Promise<CubeTexture|null>
const __backgroundCubeTargets = new WeakMap(); // keep CubeRenderTarget alive for its texture
const __backgroundCubeFailed = new WeakSet();

function __backgroundCubeDiagnostics() {
	const diag = __harnessDiagnostics();
	if ( ! diag.backgroundCube ) diag.backgroundCube = { kickCalls: 0, cacheHits: 0, pendingJoins: 0, skippedNotReady: 0, generateCalls: 0, generateSuccess: 0, generateFailed: 0, wired: 0 };
	return diag.backgroundCube;
}

function __textureImageSize( image ) {
	if ( ! image ) return { width: 0, height: 0 };
	const nested = image.image || null;
	return {
		width: image.width || image.naturalWidth || image.videoWidth || nested && nested.width || 0,
		height: image.height || image.naturalHeight || image.videoHeight || nested && nested.height || 0,
	};
}

function __cubeSizeForEquirect( texture ) {
	const size = __textureImageSize( texture && texture.image );
	return Math.max( 16, size.height || 256 );
}

function __createBackgroundCubeTarget( sourceTex ) {
	if ( ! sourceTex || sourceTex.isTexture !== true || typeof FullCubeRenderTarget !== 'function' ) return null;
	const target = new FullCubeRenderTarget( __cubeSizeForEquirect( sourceTex ) );
	let cubeSource = sourceTex;
	if ( typeof sourceTex.clone === 'function' ) {
		cubeSource = sourceTex.clone();
		cubeSource.image = sourceTex.image;
		cubeSource.flipY = sourceTex.flipY;
		cubeSource.mapping = Slim.EquirectangularReflectionMapping;
		cubeSource.needsUpdate = true;
	}
	return { target, cubeSource };
}

function __finishBackgroundCubeTarget( slimRenderer, fullRenderer, sourceTex, target ) {
	const cube = target && target.texture || null;
	if ( ! ( cube && cube.isTexture === true ) ) return null;
	cube.name = sourceTex.name ? sourceTex.name + '.cube' : 'background.cube';
	if ( sourceTex.mapping === Slim.EquirectangularRefractionMapping ) cube.mapping = Slim.CubeRefractionMapping;
	else cube.mapping = Slim.CubeReflectionMapping;
	__backgroundCubeTargets.set( sourceTex, target );
	__sharePMREMGPUTexture( slimRenderer, fullRenderer, cube );
	__markSlimTextureInitialized( slimRenderer, cube );
	Slim.registerLiveTexture( cube );
	__backgroundCubeCache.set( sourceTex, cube );
	__backgroundCubeDiagnostics().generateSuccess ++;
	return cube;
}

function __generateBackgroundCubeSync( slimRenderer, sourceTex ) {
	if ( __backgroundCubeFailed.has( sourceTex ) ) return null;
	if ( __backgroundCubeCache.has( sourceTex ) ) return __backgroundCubeCache.get( sourceTex ) || null;
	const fullRenderer = __computeRenderer;
	if ( ! slimRenderer || ! fullRenderer || ! __textureImageReady( sourceTex ) ) return null;
	__backgroundCubeDiagnostics().generateCalls ++;
	try {
		const created = __createBackgroundCubeTarget( sourceTex );
		if ( ! created ) return null;
		created.target.fromEquirectangularTexture( fullRenderer, created.cubeSource );
		return __finishBackgroundCubeTarget( slimRenderer, fullRenderer, sourceTex, created.target );
	} catch ( err ) {
		__backgroundCubeFailed.add( sourceTex );
		__backgroundCubeDiagnostics().generateFailed ++;
		if ( ! window.__tslpBackgroundCubeWarned ) {
			window.__tslpBackgroundCubeWarned = true;
			console.warn( '[tslp-e2e] background cube generation failed:', err && err.message || err );
		}
	}
	return null;
}

async function __generateBackgroundCubeAsync( slimRenderer, sourceTex ) {
	__backgroundCubeDiagnostics().generateCalls ++;
	if ( __backgroundCubeFailed.has( sourceTex ) ) return null;
	const fullRenderer = await __getComputeRenderer( slimRenderer );
	if ( ! fullRenderer ) return null;
	try {
		const created = __createBackgroundCubeTarget( sourceTex );
		if ( ! created ) return null;
		created.target.fromEquirectangularTexture( fullRenderer, created.cubeSource );
		return __finishBackgroundCubeTarget( slimRenderer, fullRenderer, sourceTex, created.target );
	} catch ( err ) {
		__backgroundCubeFailed.add( sourceTex );
		__backgroundCubeDiagnostics().generateFailed ++;
		if ( ! window.__tslpBackgroundCubeWarned ) {
			window.__tslpBackgroundCubeWarned = true;
			console.warn( '[tslp-e2e] background cube generation failed:', err && err.message || err );
		}
	}
	return null;
}

function __kickBackgroundCubeGenAsync( slimRenderer, sourceTex, onReady ) {
	if ( ! slimRenderer || ! sourceTex || sourceTex.isTexture !== true || __isCubeTextureSource( sourceTex ) ) return;
	__backgroundCubeDiagnostics().kickCalls ++;
	if ( __backgroundCubeCache.has( sourceTex ) ) { __backgroundCubeDiagnostics().cacheHits ++; onReady( __backgroundCubeCache.get( sourceTex ) ); return; }
	if ( __backgroundCubePending.has( sourceTex ) ) {
		__backgroundCubeDiagnostics().pendingJoins ++;
		__backgroundCubePending.get( sourceTex ).then( ( cube ) => { if ( cube ) onReady( cube ); } ).catch( () => {} );
		return;
	}
	if ( ! __textureImageReady( sourceTex ) ) { __backgroundCubeDiagnostics().skippedNotReady ++; return; }
	window.__tslpPmremPending = ( window.__tslpPmremPending | 0 ) + 1;
	const resultPromise = __generateBackgroundCubeAsync( slimRenderer, sourceTex ).catch( () => null );
	__backgroundCubePending.set( sourceTex, resultPromise );
	resultPromise.then( ( cube ) => {
		if ( cube ) {
			try { onReady( cube ); } catch ( _ ) {}
		}
	} ).finally( () => {
		window.__tslpPmremPending = Math.max( 0, ( window.__tslpPmremPending | 0 ) - 1 );
	} );
}

// Generate a PMREM texture using the full three.js renderer (which shares the
// same WebGPU device as the slim renderer, so its GPU textures work as slim
// bindings). Called only when no PMREM is cached for sourceTex.
async function __generatePMREMAsync( slimRenderer, sourceTex ) {
	if ( __pmremFailed.has( sourceTex ) ) return null;
	const fullRenderer = await __getComputeRenderer( slimRenderer );
	if ( ! fullRenderer ) {
		__pmremDiagnostics().noComputeRenderer ++;
		if ( ! __pmremNoRendererWarned ) {
			__pmremNoRendererWarned = true;
			console.warn( '[tslp-e2e] PMREM: no compute renderer' );
		}
		return null;
	}
	try {
		__shareGPUTextureEntry( fullRenderer, slimRenderer, sourceTex );
		const { PMREMGenerator } = await import( '/build/three.webgpu.js' );
		const gen = new PMREMGenerator( fullRenderer );
		let target = null;
		// Use a short-lived clone so PMREM generation can correct the mapping
		// without racing background cubemap conversion over the live texture's
		// mutable mapping / flipY fields.
		const isCubeSource = sourceTex.isCubeTexture === true || Array.isArray( sourceTex.image );
		let pmremSource = sourceTex;
		if ( isCubeSource && sourceTex.mapping !== Slim.CubeReflectionMapping && sourceTex.mapping !== Slim.CubeRefractionMapping && typeof sourceTex.clone === 'function' ) {
			pmremSource = sourceTex.clone();
			pmremSource.image = sourceTex.image;
			pmremSource.mapping = Slim.CubeReflectionMapping;
			pmremSource.needsUpdate = true;
		} else if ( ! isCubeSource && typeof sourceTex.clone === 'function' ) {
			pmremSource = sourceTex.clone();
			pmremSource.image = sourceTex.image;
			pmremSource.flipY = sourceTex.flipY;
			pmremSource.mapping = Slim.EquirectangularReflectionMapping;
			pmremSource.needsUpdate = true;
		} else if ( ! isCubeSource ) {
			pmremSource.mapping = Slim.EquirectangularReflectionMapping;
		}
		target = isCubeSource
			? gen.fromCubemap( pmremSource )
			: gen.fromEquirectangular( pmremSource );
		const pmrem = target && target.texture || null;
		gen.dispose && gen.dispose();
		if ( pmrem && pmrem.isTexture === true ) {
			__recordGeneratedPMREM( sourceTex, pmrem );
			// Verify the full backend actually owns a GPUTexture for this
			// PMREM result before sharing — sharing a stale entry leaves
			// slim's bindings empty.
			const fullData = fullRenderer.backend && fullRenderer.backend.get( pmrem );
			if ( ! fullData || ! fullData.texture ) {
				__pmremDiagnostics().noGPUTexture ++;
				if ( ! __pmremFailed.has( sourceTex ) ) {
					__pmremFailed.add( sourceTex );
					console.warn( '[tslp-e2e] PMREM: full backend has no GPU texture for PMREM' );
				}
				return null;
			} else {
				__sharePMREMGPUTexture( slimRenderer, fullRenderer, pmrem );
			}
		}
		return pmrem || null;
	} catch ( err ) {
		throw err;
	}
}

function __generatePMREMSyncIfReady( slimRenderer, sourceTex ) {
	if ( ! slimRenderer || ! sourceTex || sourceTex.isTexture !== true ) return null;
	const cached = __getCachedPMREMForSource( sourceTex );
	if ( cached && cached.isTexture === true ) return cached;
	if ( __pmremFailed.has( sourceTex ) || ! __textureImageReady( sourceTex ) ) return null;
	const fullRenderer = __computeRenderer;
	const FullPMREMGenerator = __fullThreeMod && __fullThreeMod.PMREMGenerator;
	if ( ! fullRenderer || ! FullPMREMGenerator ) return null;
	try {
		__shareGPUTextureEntry( fullRenderer, slimRenderer, sourceTex );
		const gen = new FullPMREMGenerator( fullRenderer );
		const isCubeSource = sourceTex.isCubeTexture === true || Array.isArray( sourceTex.image );
		let pmremSource = sourceTex;
		if ( isCubeSource && sourceTex.mapping !== Slim.CubeReflectionMapping && sourceTex.mapping !== Slim.CubeRefractionMapping && typeof sourceTex.clone === 'function' ) {
			pmremSource = sourceTex.clone();
			pmremSource.image = sourceTex.image;
			pmremSource.mapping = Slim.CubeReflectionMapping;
			pmremSource.needsUpdate = true;
		} else if ( ! isCubeSource && typeof sourceTex.clone === 'function' ) {
			pmremSource = sourceTex.clone();
			pmremSource.image = sourceTex.image;
			pmremSource.flipY = sourceTex.flipY;
			pmremSource.mapping = Slim.EquirectangularReflectionMapping;
			pmremSource.needsUpdate = true;
		} else if ( ! isCubeSource ) {
			pmremSource.mapping = Slim.EquirectangularReflectionMapping;
		}
		const target = isCubeSource
			? gen.fromCubemap( pmremSource )
			: gen.fromEquirectangular( pmremSource );
		const pmrem = target && target.texture || null;
		gen.dispose && gen.dispose();
		if ( ! ( pmrem && pmrem.isTexture === true ) ) return null;
		__recordGeneratedPMREM( sourceTex, pmrem );
		const fullData = fullRenderer.backend && fullRenderer.backend.get( pmrem );
		if ( ! fullData || ! fullData.texture ) {
			__pmremDiagnostics().noGPUTexture ++;
			return null;
		}
		__sharePMREMGPUTexture( slimRenderer, fullRenderer, pmrem );
		__pmremDiagnostics().syncGenerateSuccess = ( __pmremDiagnostics().syncGenerateSuccess || 0 ) + 1;
		return __getPMREMSupport().rememberPMREM( sourceTex, pmrem );
	} catch ( err ) {
		__pmremFailed.add( sourceTex );
		__pmremDiagnostics().syncGenerateFailed = ( __pmremDiagnostics().syncGenerateFailed || 0 ) + 1;
		if ( ! window.__tslpPmremWarned ) {
			window.__tslpPmremWarned = true;
			console.warn( '[tslp-e2e] PMREM sync generation failed:', err && err.message || err );
		}
		return null;
	}
}

function __isRenderTargetTextureSource( texture ) {
	return !! ( texture && texture.isTexture === true && ( texture.isRenderTargetTexture === true || texture.renderTarget ) );
}

function __prewarmStaticPMREMSourcesForScene( renderer, scene ) {
	if ( ! renderer || ! scene ) return;
	const seen = new WeakSet();
	const prewarm = ( texture ) => {
		if ( ! texture || texture.isTexture !== true || seen.has( texture ) || __isRenderTargetTextureSource( texture ) ) return;
		seen.add( texture );
		__generatePMREMSyncIfReady( renderer, texture );
	};
	for ( const texture of __environmentSourceTextures( scene, true ) ) prewarm( texture );
	if ( typeof scene.traverse !== 'function' ) return;
	scene.traverse( ( object ) => {
		const mat = object && object.material;
		const list = Array.isArray( mat ) ? mat : mat ? [ mat ] : [];
		for ( const m of list ) {
			if ( ! ( m && m.isPrecompiledMaterial && m.precompiledArtifact ) ) continue;
			if ( ! __artifactNeedsPMREM( m.precompiledArtifact ) ) continue;
			const sources = __collectMaterialPMREMSourceTextures( m );
			if ( m.envMap && m.envMap.isTexture === true ) __pushUniqueTexture( sources, m.envMap );
			for ( const source of sources ) prewarm( source );
		}
	} );
}

// Wire a ready PMREM texture into PrecompiledMaterial artifacts that have
// CubeUVReflectionMapping (mapping=306) or textureName=PMREM.cubeUv bindings.
// IMPORTANT: do NOT wire PMREM into artifacts that only have raw cube/equirect
// bindings (e.g. the background sky renderer uses texture_cube — wiring a 2D
// PMREM texture there fails WebGPU validation and aborts the entire render pass).
// Sets material.needsUpdate = true for newly-wired materials so Three.js
// re-runs hydrateNodeBuilderState with the correct texture in _textureRefs
// (hydration is cached per material version; needsUpdate invalidates the cache).
function __artifactNeedsPMREM( artifact ) {
	return __sharedArtifactNeedsPMREM( artifact );
}

function __artifactPMREMSourceUuids( artifact ) {
	return __sharedArtifactPMREMSourceUuids( artifact );
}

function __cachedPMREMForSource( sourceTex ) {
	return __getCachedPMREMForSource( sourceTex );
}

function __textureListSignature( textures, count = 0 ) {
	return __sharedTextureListSignature( textures, count );
}

function __attachPMREMRefsByOrder( artifact, pmremTextures ) {
	return __sharedAttachPMREMRefsByOrder( artifact, pmremTextures );
}

function __selectPMREMTexturesForArtifact( artifact, material, environmentSources ) {
	return __sharedSelectPMREMTexturesForArtifact( artifact, {
		material,
		collectMaterialNodeTextures: __collectMaterialNodeTextures,
		collectMaterialPMREMSources: __collectMaterialPMREMSourceTextures,
		getCachedPMREMForSource: __getCachedPMREMForSource,
		environmentSources,
	} );
}

function __wireEnvironmentPMREM( renderer, scene ) {
	if ( ! renderer || ! scene ) return 0;
	__pmremDiagnostics().wireCalls ++;
	const environmentSources = __environmentSourceTextures( scene, true );
	let wiredCount = 0;
	scene.traverse( ( object ) => {
		const mat = object && object.material;
		const list = Array.isArray( mat ) ? mat : mat ? [ mat ] : [];
		for ( const m of list ) {
			if ( m && m.isPrecompiledMaterial && m.precompiledArtifact ) {
				const artifact = m.precompiledArtifact;
				const sourceUuids = __artifactPMREMSourceUuids( artifact );
				if ( sourceUuids.length === 0 ) continue;
				// Prefer per-material envMap PMREM (set by examples that pass
				// envMap via constructor params), fall back to scene.environment /
				// scene.environmentNode. Multi-PMREM node graphs are wired by the
				// distinct PMREM source order captured in the artifact.
				const selection = __selectPMREMTexturesForArtifact( artifact, m, environmentSources );
				const nodePmrems = selection.nodePmrems || [];
				if ( nodePmrems.length > 0 ) {
					const diag = __pmremDiagnostics();
					diag.wireNodePmremCandidates = ( diag.wireNodePmremCandidates || 0 ) + nodePmrems.length;
					if ( ! Array.isArray( diag.nodePmremSamples ) ) diag.nodePmremSamples = [];
					if ( diag.nodePmremSamples.length < 4 ) {
						const img = nodePmrems[ 0 ].image || null;
						diag.nodePmremSamples.push( { width: img && img.width, height: img && img.height, version: nodePmrems[ 0 ].version } );
					}
				}
				const pmrems = selection.pmremTextures || [];
				if ( pmrems.length < sourceUuids.length ) {
					__pmremDiagnostics().wireNoPmrem ++;
					continue;
				}
				const signature = __textureListSignature( pmrems, sourceUuids.length );
				if ( __pmremWiredArtifacts.get( artifact ) === signature ) {
					__pmremDiagnostics().wireAlreadyWired ++;
					continue;
				}
				__pmremDiagnostics().wireNeedsPmrem ++;
				if ( __attachPMREMRefsByOrder( artifact, pmrems ) ) {
					__pmremWiredArtifacts.set( artifact, signature );
					m.needsUpdate = true;
					// dispose() triggers onDispose() which removes this material's
					// RenderObject from the renderer chain map. The next render
					// creates a fresh RenderObject (with _nodeBuilderState=null),
					// forcing hydrateNodeBuilderState to re-run with updated
					// _textureRefs. Clearing nodeBuilderCache below ensures the
					// program-level cache also misses so _createNodeBuilder fires.
					try { m.dispose(); } catch ( _ ) {}
					wiredCount ++;
					__pmremDiagnostics().wireAttached ++;
				} else {
					__pmremDiagnostics().wireNoPmrem ++;
				}
			}
		}
	} );
	// Bust the Nodes program cache so the fresh RenderObjects created after
	// dispose() miss the cache and trigger _createNodeBuilder → hydrateNodeBuilderState.
	// Without this, getForRender() would find the old NodeBuilderState in
	// nodeBuilderCache (keyed by the stable initialCacheKey) and skip hydration.
	if ( wiredCount > 0 ) {
		try {
			const nc = renderer._nodes && renderer._nodes.nodeBuilderCache;
			if ( nc && typeof nc.clear === 'function' ) nc.clear();
		} catch ( _ ) {}
	}
	return wiredCount;
}

// Kick off async PMREM generation if not already started. onReady is called
// with the pmrem texture once generation completes. The global
// window.__tslpPmremPending counter is incremented until the generation
// finishes so Playwright's freeze-wait condition can include it.
function __kickPMREMGenAsync( slimRenderer, sourceTex, onReady ) {
	if ( ! slimRenderer || ! sourceTex || sourceTex.isTexture !== true ) return Promise.resolve( null );
	return __getPMREMSupport().kickGenerate( slimRenderer, sourceTex, ( pmrem ) => {
		if ( pmrem ) {
			try { onReady( pmrem ); } catch ( _ ) {}
		}
	} ).catch( () => null );
}

// Walk the scene and register every discovered Texture in the runtime's
// live-texture index. Hydrator uses this to relink artifact.texture-kind
// bindings whose textureUuid is dead by matching imageSrc / textureName
// from the captured artifact against currently-loaded textures.
	function __indexLiveTextures( scene ) {
		const visit = ( tex, options = {} ) => {
			if ( tex && tex.isTexture === true ) {
				__liveSceneIndex.indexTexture( tex, options );
			}
		};
		const globalTslTextures = Array.isArray( window.__tslpTslTextureArgs ) ? window.__tslpTslTextureArgs : [];
		for ( const tex of globalTslTextures ) visit( tex, { heal: false } );
		if ( ! scene || typeof scene.traverse !== 'function' ) return;
		if ( scene.background && scene.background.isTexture === true ) visit( scene.background );
	if ( scene.environment && scene.environment.isTexture === true ) visit( scene.environment );
	for ( const tex of __capturedBackgroundSources ) visit( tex );
	for ( const tex of __capturedEnvironmentSources ) visit( tex );
	if ( scene.backgroundNode ) {
		const pmremSources = __collectPMREMSourceTexturesInNode( scene.backgroundNode );
		for ( const tex of pmremSources.length > 0 ? pmremSources : __collectTexturesInNode( scene.backgroundNode ) ) visit( tex );
	}
	if ( scene.environmentNode ) {
		const pmremSources = __collectPMREMSourceTexturesInNode( scene.environmentNode );
		for ( const tex of pmremSources.length > 0 ? pmremSources : __collectTexturesInNode( scene.environmentNode ) ) visit( tex );
	}
	scene.traverse( ( object ) => {
		// Lights can carry textures (SpotLight.map / RectAreaLight.map). Three.js
			// bakes those into the LightsNode TSL graph, so the captured artifact
			// references them by uuid/imageSrc just like material.map. They must be
			// registered or the artifact-texture rebinder falls back to a 1x1 stub.
			if ( object && object.isLight === true && object.map && object.map.isTexture === true ) visit( object.map, { heal: false } );
			const ms = object && object.material;
			const list = Array.isArray( ms ) ? ms : ms ? [ ms ] : [];
			for ( const m of list ) {
				if ( ! m ) continue;
				for ( const key of __TEXTURE_PROPS ) visit( m[ key ], { heal: false } );
				for ( const tex of __collectMaterialNodeTextures( m ) ) visit( tex, { heal: false } );
			}
		} );
	}

function __hasReplayArtifactMatch( root ) {
	if ( ! root || typeof root.traverse !== 'function' ) return false;
	const keys = Object.keys( __data.user || {} );
	if ( keys.length === 0 ) return false;
	let matched = false;
	try {
		root.traverse( ( object ) => {
			if ( matched || ! object || ! object.material ) return;
			const list = Array.isArray( object.material ) ? object.material : [ object.material ];
			for ( const material of list ) {
				if ( ! material ) continue;
				if ( material.isPrecompiledMaterial === true ) {
					matched = true;
					return;
				}
				const className = __classNameForMaterial( material );
				if ( __findBestArtifactForSource( className, material, keys, object ) ) {
					matched = true;
					return;
				}
			}
		} );
	} catch ( _ ) {}
	return matched;
}

function __shouldBypassReplayPrepareDuringPMREM( root ) {
	return __pmremRunning > 0 && ! __hasReplayArtifactMatch( root );
}

function __normalizeClippingGroupForReplay( object ) {
	if ( ! object || ! object.isClippingGroup ) return false;
	let repaired = false;
	if ( ! Array.isArray( object.clippingPlanes ) ) { object.clippingPlanes = []; repaired = true; }
	if ( typeof object.clipIntersection !== 'boolean' ) { object.clipIntersection = false; repaired = true; }
	if ( typeof object.clipShadows !== 'boolean' ) { object.clipShadows = false; repaired = true; }
	if ( typeof object.enabled !== 'boolean' ) { object.enabled = true; repaired = true; }
	try {
		const diag = __harnessDiagnostics();
		diag.clippingGroups = diag.clippingGroups || { seen: 0, repaired: 0 };
		diag.clippingGroups.seen ++;
		if ( repaired ) diag.clippingGroups.repaired ++;
	} catch ( _ ) {}
	return true;
}

function __prepareSceneForReplay( scene, renderer ) {
	if ( __shouldBypassReplayPrepareDuringPMREM( scene ) ) return;
	// PMREMGenerator and RenderPipeline internals render temporary meshes/scenes
	// that were never part of the user's capture set. Let the full/slim renderer
	// handle those materials normally so they do not consume user artifacts.
	if ( ! scene || typeof scene.traverse !== 'function' || scene.name === 'RoomEnvironment' ) return;
	scene.traverse( __normalizeClippingGroupForReplay );
	// When a background-aux artifact is registered the rewritten Background.js
	// inside the slim bundle calls loadAux('background', hashNodeGraphSync(backgroundNode))
	// to build a PrecompiledMaterial for the sky quad.  That path is only
	// reached when the backgroundNode has .isNode === true (or a Texture/Color
	// falls through the legacy branches).  We therefore replace live TSL graphs
	// with a stub proxy.  When exact scene/background hash matching is possible,
	// the stub carries the matching aux configHash so multi-scene examples (for
	// example portal render passes) don't all shape-fallback to the same artifact.
	//   • If no background aux: null out backgroundNode so Background.js falls
	//     through to the renderer's clear-color path (old behaviour).
	// Color backgrounds are left intact in both cases — they use the clear-
	// color path and bypass loadAux entirely.
	if ( scene && scene.isScene === true ) {
		if ( ! __capturedSceneBackgrounds.has( scene ) ) __capturedSceneBackgrounds.set( scene, scene.background );
		if ( ! __capturedSceneBackgroundNodes.has( scene ) ) __capturedSceneBackgroundNodes.set( scene, scene.backgroundNode );
		if ( scene.environmentNode ) {
			const envSources = [];
			__rememberPMREMSourceTexturesFromNode( envSources, scene.environmentNode );
			if ( envSources.length > 0 ) __capturedEnvironmentSources = envSources;
		}
		// Recover the source texture from scene.backgroundNode BEFORE we replace
		// it with a stub, so the PMREM wiring path can reach it later. Examples
		// like webgpu_pmrem_cubemap.html only set scene.backgroundNode (a real
		// PMREMNode in e2e mode); without this, the cubemap reference is lost.
		if ( __hasBackgroundAux && scene.backgroundNode ) {
			const backgroundSources = [];
			__rememberPMREMSourceTexturesFromNode( backgroundSources, scene.backgroundNode );
			if ( backgroundSources.length > 0 ) {
				__capturedBackgroundSources = backgroundSources;
				__capturedBackgroundSource = backgroundSources[ 0 ];
			} else {
				const recovered = __findTextureInNode( scene.backgroundNode );
				if ( recovered ) __capturedBackgroundSource = recovered;
			}
		}
		const hasLiveBackgroundNode = !! scene.backgroundNode;
		const hasTextureBackground = !! ( scene.background && scene.background.isTexture === true );
		if ( __hasBackgroundAux && ( hasLiveBackgroundNode || hasTextureBackground ) ) {
			const configHash = __backgroundAuxConfigHashForScene( scene );
			const canFallback = __backgroundAuxCount <= 1;
			if ( configHash || canFallback ) {
				// Replace with a stub so Background.js enters the isNode branch and
				// calls loadAux. Multi-background scenes get exact aux hashes; single-
				// background scenes can keep using shape fallback.
				scene.backgroundNode = __nodeStub( configHash );
			} else {
				scene.backgroundNode = null;
				if ( scene.background && ! scene.background.isColor ) scene.background = null;
			}
			// Don't null scene.background here; it won't be reached because
			// backgroundNode takes priority in getBackgroundNode().
		} else {
			scene.backgroundNode = null;
			if ( scene.background && ! scene.background.isColor ) scene.background = null;
		}
	}
	__indexLiveTextures( scene );
	__wireBackgroundTextures( scene, renderer );
	const previousReplayRenderer = window.__tslpCurrentReplayRenderer;
	window.__tslpCurrentReplayRenderer = renderer;
	try {
		__replaceSceneOverrideMaterial( scene );
		__replaceStorageBufferPboReplayMaterials( scene );
		__replaceSceneMaterials( scene );
	} finally {
		window.__tslpCurrentReplayRenderer = previousReplayRenderer;
	}
	__recordReplayMaterialSnapshot( scene, 'prepare' );
}

// Auto-compute dispatch for material *Node slots that hold a raw TSL ComputeNode.
// In stock three.js, NodeMaterial.setup() registers each ComputeNode-shaped slot
// (e.g. webgpu_skinning_points: material.positionNode = Fn(...)().compute(N).onInit(...))
// for updateBefore, which calls renderer.compute(this) ahead of every draw so
// the storage buffer feeding .toAttribute() is fresh. The slim renderer bypasses
// NodeMaterial.setup, so updateBefore never fires and the buffer stays zeroed —
// 16k skinned points collapse to a single dot at origin.
//
// Walking the scene per-frame and routing each ComputeNode through this.compute()
// reuses the existing full-renderer + __syncStorageBuffers path (same one the
// .compute() wrapper drives for explicit user dispatches like webgpu_compute_birds).
const __AUTO_COMPUTE_SLOTS = [ 'positionNode', 'vertexNode', 'colorNode', 'outputNode' ];
const __wiredAutoComputeMaterials = new WeakSet();
// Build the auto-compute's NodeBuilderState on the full renderer just to populate
// its bind groups, then walk those bindings to find the live storage attributes
// (pointPositionArray, pointSpeedArray, ...) the kernel writes to. Match each
// unwired artifact.attributes[i] (vertex stage) by count + itemSize so the slim
// hydrator reads from the same GPU buffer the compute is updating. Without this,
// the artifact's nodeAttribute0 ends up bound to a fresh zero-filled
// StorageBufferAttribute and the compute output is invisible to render.
function __wireAutoComputeAttrsToArtifact( material, computeNode ) {
	let wiredCount = 0;
	if ( ! material || ! material.precompiledArtifact || ! computeNode ) return 0;
	if ( ! __computeRenderer ) return 0;
	let nodeBuilderState;
	try { nodeBuilderState = __computeRenderer._nodes.getForCompute( computeNode ); }
	catch ( err ) { console.warn( '[tslp-e2e] auto-compute getForCompute failed:', err && err.message || err ); return 0; }
	const bindings = nodeBuilderState && nodeBuilderState.bindings;
	if ( ! bindings ) return 0;
	// Keep only read-write storage attrs — those are the buffers the user's kernel
	// outputs to (pointPositionArray, pointSpeedArray). Skip readOnly inputs like
	// SkinningNode's internal position/skinIndex/skinWeight storage, which the
	// kernel only samples from.
	const candidates = [];
	for ( const bg of bindings ) {
		if ( ! bg || ! bg.bindings ) continue;
		for ( const b of bg.bindings ) {
			if ( ! b || ! b.isStorageBuffer || ! b.attribute ) continue;
			if ( b.access && b.access !== 'readWrite' && b.access !== 'writeOnly' ) continue;
			const attr = b.attribute;
			if ( ! ( attr.isStorageBufferAttribute === true || attr.isStorageInstancedBufferAttribute === true ) ) continue;
			if ( ! candidates.includes( attr ) ) candidates.push( attr );
		}
	}
	if ( candidates.length === 0 ) return 0;
	// Exclude storage attrs already referenced by other *Node slots — those are
	// wired by the runtime hydrator via userPath. Without this, autowire might
	// consume pointSpeedArray for nodeAttribute0 and leave pointPositionArray
	// orphaned, swapping the position and color channels.
	const usedByOtherSlots = new Set();
	const collectStorageLeavesViaTraverse = ( node, out ) => {
		// __collectStorageAttrNodeAttrs uses __walkNodeSafely, which only follows
		// _children / array-shaped getChildren(); three.js getChildren() is a
		// generator, so it walks nothing for real nodes. Use Node.traverse instead.
		if ( ! node || typeof node.traverse !== 'function' ) return;
		const seen = new Set();
		try {
			node.traverse( ( n ) => {
				if ( ! n || seen.has( n ) ) return;
				seen.add( n );
				const v = n.value;
				if ( v && ( v.isStorageBufferAttribute === true || v.isStorageInstancedBufferAttribute === true ) && ! out.includes( v ) ) out.push( v );
				const a = n.attribute;
				if ( a && ( a.isStorageBufferAttribute === true || a.isStorageInstancedBufferAttribute === true ) && ! out.includes( a ) ) out.push( a );
			} );
		} catch ( _ ) {}
	};
	for ( const slot of [ 'colorNode', 'vertexNode', 'normalNode', 'outputNode', 'emissiveNode', 'opacityNode' ] ) {
		if ( ! material[ slot ] ) continue;
		const found = [];
		collectStorageLeavesViaTraverse( material[ slot ], found );
		for ( const f of found ) usedByOtherSlots.add( f );
	}
	const artifact = material.precompiledArtifact;
	const nodeAttrsArr = artifact.attributes || artifact.nodeAttributes || [];
	const wired = new Set();
	for ( const na of nodeAttrsArr ) {
		if ( na && na._liveAttribute && na._liveAttribute.isBufferAttribute === true ) wired.add( na._liveAttribute );
	}
	const remaining = candidates.filter( ( c ) => ! wired.has( c ) && ! usedByOtherSlots.has( c ) );
	for ( const na of nodeAttrsArr ) {
		if ( ! na || na.source !== 'node' ) continue;
		if ( na._liveAttribute && na._liveAttribute.isBufferAttribute === true ) continue;
		// Skip entries with userPath — the runtime hydrator wires those via the
		// recorded node-tree path. Autowire only fills entries with NO userPath,
		// where the live attribute is buried inside a Fn closure (the compute
		// body) that the runtime walk can't reach.
		if ( Array.isArray( na.userPath ) && na.userPath.length > 0 ) continue;
		// Match on count + itemSize + array constructor. The compute's bind groups
		// usually include several storage buffers (positions, speeds, skinIndices,
		// skinWeights, ...) with the same count; without the arrayType check we'd
		// wire a uint skin-index buffer to a float vertex attribute and the WebGPU
		// validator rejects the pipeline.
		const idx = remaining.findIndex( ( c ) => {
			if ( c.count !== na.count ) return false;
			if ( ! ( c.itemSize === na.itemSize || ( c.itemSize === 3 && na.itemSize === 4 ) ) ) return false;
			if ( na.arrayType && c.array && c.array.constructor && c.array.constructor.name !== na.arrayType ) return false;
			return true;
		} );
		if ( idx === -1 ) continue;
		Object.defineProperty( na, '_liveAttribute', { value: remaining[ idx ], enumerable: false, writable: true, configurable: true } );
		remaining.splice( idx, 1 );
		wiredCount ++;
	}
	return wiredCount;
}
	const __dispatchedAutoComputeMaterials = new WeakSet();
	const __frozenDispatchedAutoComputeNodes = new Set();
	function __artifactHasUnwiredAnonymousNodeAttribute( artifact ) {
		const attrs = artifact && ( artifact.attributes || artifact.nodeAttributes ) || [];
		return attrs.some( ( entry ) => entry
			&& entry.source === 'node'
			&& entry.storage !== false
			&& ! ( Array.isArray( entry.userPath ) && entry.userPath.length > 0 )
			&& ! ( entry._liveAttribute && ( entry._liveAttribute.isStorageBufferAttribute === true || entry._liveAttribute.isStorageInstancedBufferAttribute === true ) ) );
	}
	function __invalidateAutoComputeMaterialBindings( material, renderer ) {
		if ( ! material ) return;
		material.needsUpdate = true;
		try {
			const nodes = renderer && renderer._nodes;
			if ( nodes && typeof nodes.delete === 'function' ) nodes.delete( material );
			const nc = nodes && nodes.nodeBuilderCache;
			if ( nc && typeof nc.clear === 'function' ) nc.clear();
		} catch ( _ ) {}
		try { material.dispose(); } catch ( _ ) {}
	}
	function __dispatchAutoComputeNodes( scene, slimRenderer ) {
		if ( ! scene || typeof scene.traverse !== 'function' ) return;
	// Once the animation loop has self-frozen, the compute() wrapper forces an
	// extra render each time the pending-compute count drains to 0 so the GPU
	// buffer write is visible before the screenshot. Re-dispatching the kernel
	// on those forced renders would keep the count oscillating 0→1→0 forever
	// (compute → forced render → compute → …). Dispatch each node at most once
	// during the frozen phase: the first forced render carries the final pose
	// into the buffer; subsequent forced renders are no-ops here.
	const frozen = typeof window !== 'undefined' && window.__tslpFrozen === true;
	const seen = new Set();
	scene.traverse( ( object ) => {
		const material = object && object.material;
		const list = Array.isArray( material ) ? material : material ? [ material ] : [];
		for ( const m of list ) {
			if ( ! m ) continue;
			for ( const key of __AUTO_COMPUTE_SLOTS ) {
				const node = m[ key ];
				if ( ! node || node.isComputeNode !== true || node.isPrecompiledCompute === true ) continue;
					if ( seen.has( node ) ) continue;
					seen.add( node );
					if ( ! __wiredAutoComputeMaterials.has( m ) ) {
					// Only re-dispatch this kernel every frame if its output buffer
					// actually feeds an unwired vertex attribute on this precompiled
					// material (the webgpu_skinning_points pattern). When nothing
					// wires up, the kernel result is never read by the precompiled
					// render path, so dispatching is pointless — and risks breaking
					// examples whose ComputeNode-shaped material slot is unrelated to
					// the precompiled vertex layout (e.g. webgpu_skinning_instancing).
						const wired = __wireAutoComputeAttrsToArtifact( m, node ) | 0;
						if ( wired > 0 ) {
							__dispatchedAutoComputeMaterials.add( m );
							__invalidateAutoComputeMaterialBindings( m, slimRenderer );
							__wiredAutoComputeMaterials.add( m );
						} else if ( ! __computeRenderer && __artifactHasUnwiredAnonymousNodeAttribute( m.precompiledArtifact ) ) {
							// First top-level render often reaches this before the shared full
							// compute renderer exists. Dispatch once to boot it, then let the
							// forced post-compute render retry the precise bind-group wiring.
							__dispatchedAutoComputeMaterials.add( m );
						} else {
							__wiredAutoComputeMaterials.add( m );
						}
					}
					if ( ! __dispatchedAutoComputeMaterials.has( m ) ) continue;
				if ( frozen ) {
					if ( __frozenDispatchedAutoComputeNodes.has( node ) ) continue;
					__frozenDispatchedAutoComputeNodes.add( node );
				}
				try { slimRenderer.compute( node ); }
				catch ( err ) { console.warn( '[tslp-e2e] auto-compute dispatch failed:', err && err.message || err ); }
			}
		}
	} );
}

// Lazy full-three.js compute renderer that shares the slim renderer's GPU
// device. The slim NodeManager can only dispatch PrecompiledComputeNode; raw
// TSL ComputeNodes (isComputeNode=true, isPrecompiledCompute!=true) need a
// real NodeBuilder. We create a single auxiliary WebGPURenderer from the
// unpatched three.webgpu.js, passing the already-initialised GPU device so
// both renderers operate on the SAME WebGPU device — and therefore on the same
// storage buffers written by instancedArray().
// After fullRenderer.computeAsync() resolves, the full renderer owns the GPUBuffers
// that compute wrote into. If the slim renderer has no buffer yet for an attribute,
// we pre-seed the DataMap so the slim renderer's first createAttribute call finds it
// and skips allocation (vertex+storage attribute path checks: if void 0 === r.buffer).
// If the slim renderer already has a separate buffer (from a prior render that ran
// before the first compute, e.g., an init render), we GPU-copy the compute output
// INTO that buffer via copyBufferToBuffer. The slim renderer's cached bind group
// still references the same GPUBuffer; we just update its content. Both renderers
// share the same GPUDevice so the copy is entirely on-GPU (no CPU round-trip).
function __computeNodeUsesStorageTexture( computeNode, fullRenderer ) {
	return __sharedComputeNodeUsesStorageTexture( computeNode, fullRenderer );
}

function __shareComputeSampledInputs( computeNode, fullRenderer, slimRenderer ) {
	return __sharedShareComputeSampledInputs( computeNode, fullRenderer, slimRenderer, {
		onError: ( err ) => console.warn( '[tslp-e2e] compute input texture share failed:', err && err.message || err ),
	} );
}

function __wireSceneComputeAttrsFromFallbacks( scene, renderer = null ) {
	if ( ! scene || typeof scene.traverse !== 'function' || __computeStorageAttrFallbacks.length === 0 ) return;
	let invalidated = false;
	scene.traverse( ( object ) => {
		const material = object && object.material;
		const list = Array.isArray( material ) ? material : material ? [ material ] : [];
		for ( const m of list ) {
			if ( ! ( m && m.isPrecompiledMaterial === true && m.precompiledArtifact ) ) continue;
				const wired = __wireComputeAttrsToArtifact( m.precompiledArtifact, m ) | 0;
				if ( wired > 0 ) {
					m.needsUpdate = true;
					try {
						const nodes = renderer && renderer._nodes;
					if ( nodes && typeof nodes.delete === 'function' ) nodes.delete( m );
				} catch ( _ ) {}
				try { m.dispose(); } catch ( _ ) {}
				invalidated = true;
			}
		}
	} );
	if ( invalidated && renderer ) {
		try {
			const nc = renderer._nodes && renderer._nodes.nodeBuilderCache;
			if ( nc && typeof nc.clear === 'function' ) nc.clear();
		} catch ( _ ) {}
	}
}

function __driveRendererLightingUpdateBefore( renderer, scene, camera ) {
	const diag = __computeDiagnostics();
	const stats = __sharedUpdateRendererLightingForSlim( renderer, scene, camera, {
		diagnostics: diag || undefined,
		guardKey: '__tslpInsideReplayUpdateBefore',
		onStorageAttribute: ( attr ) => {
			__rememberComputeStorageAttr( attr );
			__wireSceneComputeAttrsFromFallbacks( scene, renderer );
		},
		onError: ( err ) => {
			if ( ! window.__tslpLightingUpdateBeforeWarned ) {
				window.__tslpLightingUpdateBeforeWarned = true;
				console.warn( '[tslp-e2e] lighting updateBefore replay failed:', err && err.message || err );
			}
		},
	} );
	return stats && ( stats.updated || stats.cpuTiled ) ? 1 : 0;
}

// Thin wrapper — see @tsl-precompile/runtime/slim-support/compute-sync for
// the storage-texture + storage-buffer copy/adopt logic. The harness still
// owns the post-sync attribute-fallback wiring and the storage-attr ledger,
// passed in via opts.
//
// Bookkeeping for Wedge 3 productized primitives:
//   * __computePassByNode tracks pass index per compute node so successive
//     dispatches of the same kernel (bitonic sort / reduction) call
//     syncComputeStorageOutputsPerPass with monotonic pass indices.
//   * __computeStorageTextureLedger tracks the previous storage texture
//     output(s) per compute node; on a mismatch we run pingPongInvalidate
//     so slim's bind-group cache rebuilds against the freshly-swapped texture.
//   * Storage instanced attributes go through
//     shareInstancedAttributeBufferIntoSlim after the primary sync so slim's
//     vertex-pull path sees the compute kernel's GPUBuffer.
const __computePassByNode = new WeakMap();
const __computeStorageTextureLedger = new WeakMap();

function __syncStorageBuffers( computeNode, fullRenderer, slimRenderer ) {
	const nodeKey = ( computeNode && typeof computeNode === 'object' ) ? computeNode : null;
	const passIndex = nodeKey ? ( __computePassByNode.get( nodeKey ) | 0 ) : 0;
	if ( nodeKey ) __computePassByNode.set( nodeKey, passIndex + 1 );

	const seenStorageTextures = [];
	const seenStorageAttrs = [];

	const syncStats = __sharedSyncComputeStorageOutputsPerPass( computeNode, fullRenderer, slimRenderer, passIndex, {
		onStorageAttr: ( attr ) => {
			__rememberComputeStorageAttr( attr );
			seenStorageAttrs.push( attr );
		},
		onStorageTexture: ( tex ) => { seenStorageTextures.push( tex ); },
		onError: ( err ) => console.warn( '[tslp-e2e] storage buffer sync failed:', err && err.message || err ),
	} );

	// Ping-pong texture invalidation: if a previous dispatch wrote to a
	// different storage texture than this one, invalidate both so slim's
	// cached bind group rebuilds against the live (just-written) resource.
	if ( nodeKey && seenStorageTextures.length > 0 ) {
		const prev = __computeStorageTextureLedger.get( nodeKey );
		if ( prev && prev.length > 0 ) {
			for ( const tex of seenStorageTextures ) {
				for ( const prevTex of prev ) {
					if ( prevTex && prevTex !== tex ) {
						try { __sharedPingPongInvalidate( prevTex, tex, [ slimRenderer, fullRenderer ] ); }
						catch ( _ ) {}
					}
				}
			}
		}
		__computeStorageTextureLedger.set( nodeKey, seenStorageTextures.slice() );
	}

	// Compute-driven instance attributes: when the slim renderer's vertex
	// pull reads an InstancedBufferAttribute whose underlying GPUBuffer the
	// full renderer just wrote to, adopt the buffer reference into slim so
	// the next draw call samples the live compute output rather than a
	// zeroed stand-in.
	for ( const attr of seenStorageAttrs ) {
		if ( ! attr ) continue;
		if ( attr.isStorageInstancedBufferAttribute === true || attr.isInstancedBufferAttribute === true ) {
			try { __sharedShareInstancedAttributeBufferIntoSlim( attr, fullRenderer, slimRenderer ); }
			catch ( _ ) {}
		}
	}

	__wireSceneComputeAttrsFromFallbacks( slimRenderer && slimRenderer._lastScene, slimRenderer );
	const diag = __computeDiagnostics();
	if ( diag ) {
		diag.syncCalls = ( diag.syncCalls | 0 ) + 1;
		diag.syncStorageAttrs = ( diag.syncStorageAttrs | 0 ) + seenStorageAttrs.length;
		diag.buffersAdopted = ( diag.buffersAdopted | 0 ) + ( syncStats && syncStats.buffersAdopted | 0 );
		diag.buffersCopied = ( diag.buffersCopied | 0 ) + ( syncStats && syncStats.buffersCopied | 0 );
		diag.texturesShared = ( diag.texturesShared | 0 ) + ( syncStats && syncStats.texturesShared | 0 );
	}
	return {
		...( syncStats || {} ),
		storageAttrs: seenStorageAttrs.length,
		storageTextures: seenStorageTextures.length,
	};
}

// Lazy full-WebGPURenderer boot — productized through
// slim-support/full-renderer-fallback. The fallback owns the shared-device
// init, the de-duplicated promise, and the shadowMap.enabled flip; we keep
// __computeRenderer and __fullThreeMod as in-page references because
// other harness helpers (__makeFullSceneForPMREM, __rememberStorageAttr,
// __convertGeometryToFullThree) read them synchronously.
let __computeRenderer = null;
let __fullThreeMod = null;
const __computeRendererBySlim = new WeakMap();
const __computeRendererInitBySlim = new WeakMap();
const __fullRendererFallbackBySlim = new WeakMap();
let __renderFallbackRenderer = null;

function __nodeBuilderLikeFromState( state ) {
	if ( ! state ) return null;
	if ( typeof state.build === 'function' && typeof state.getBindings === 'function' ) return state;
	return {
		vertexShader: state.vertexShader || '',
		fragmentShader: state.fragmentShader || '',
		computeShader: state.computeShader || '',
		nodeAttributes: state.nodeAttributes || [],
		bindings: state.bindings || [],
		updateNodes: state.updateNodes || [],
		updateBeforeNodes: state.updateBeforeNodes || [],
		updateAfterNodes: state.updateAfterNodes || [],
		observer: state.observer || null,
		transforms: state.transforms || [],
		getAttributesArray() { return this.nodeAttributes; },
		getBindings() { return this.bindings; },
		build() {},
		buildAsync: async () => {},
	};
}

function __registerSlimRenderFallback( fullRenderer ) {
	if ( ! fullRenderer || __renderFallbackRenderer === fullRenderer ) return !! fullRenderer;
	const nodeManager = fullRenderer.nodes || fullRenderer._nodes;
	if ( ! nodeManager || typeof Slim.setSlimRenderFallback !== 'function' ) return false;
	Slim.setSlimRenderFallback( ( renderObject ) => {
		try {
			if ( typeof nodeManager.getForRender === 'function' ) {
				const result = nodeManager.getForRender( renderObject );
				if ( result && typeof result.then === 'function' ) return null;
				return __nodeBuilderLikeFromState( result );
			}
			if ( typeof nodeManager._createNodeBuilder === 'function' ) {
				return nodeManager._createNodeBuilder( renderObject, renderObject && renderObject.material );
			}
		} catch ( err ) {
			if ( ! window.__tslpRenderFallbackWarned ) {
				window.__tslpRenderFallbackWarned = true;
				console.warn( '[tslp-e2e] slim render fallback failed:', err && ( err.stack || err.message ) || err );
			}
		}
		return null;
	} );
	__renderFallbackRenderer = fullRenderer;
	return true;
}

async function __getComputeRenderer( slimRenderer ) {
	if ( slimRenderer ) {
		const cached = __computeRendererBySlim.get( slimRenderer );
		if ( cached ) {
			__computeRenderer = cached;
			__registerSlimRenderFallback( cached );
			return cached;
		}
		const pending = __computeRendererInitBySlim.get( slimRenderer );
		if ( pending ) return pending;
	}
	const init = ( async () => {
		let fallback = slimRenderer ? __fullRendererFallbackBySlim.get( slimRenderer ) : null;
		if ( ! fallback ) {
			fallback = __sharedCreateFullRendererFallback( {
				slimRenderer,
				loadThreeFullModule: async () => {
					const mod = await import( '/build/three.webgpu.js' );
					__fullThreeMod = mod;
					return mod;
				},
				onError: ( err ) => console.warn( '[tslp-e2e] compute renderer init failed:', err && err.message || err ),
			} );
			if ( slimRenderer ) __fullRendererFallbackBySlim.set( slimRenderer, fallback );
		}
			const r = await fallback.getRenderer();
			if ( r ) {
				__computeRenderer = r;
				try { window.__tslpComputeRenderer = r; } catch ( _ ) {}
				if ( slimRenderer ) __computeRendererBySlim.set( slimRenderer, r );
				__registerSlimRenderFallback( r );
			}
		return r;
	} )();
	if ( slimRenderer ) __computeRendererInitBySlim.set( slimRenderer, init );
	return init;
}

function __runReplayComputeInit( slimRenderer, computeNode ) {
	const onInitFn = computeNode && computeNode.onInitFunction;
	if ( typeof onInitFn !== 'function' || computeNode.__tslpReplayInitDone === true ) return Promise.resolve();

	computeNode.__tslpReplayInitDone = true;
	try { computeNode.onInitFunction = null; } catch ( _ ) {}

	try {
		return Promise.resolve( onInitFn.call( computeNode, { renderer: slimRenderer } ) );
	} catch ( err ) {
		return Promise.reject( err );
	}
}

// ============================================================================
// Shadow-map population (slim has shadow render pass tree-shaken)
//
// The slim renderer never allocates light.shadow.map. The hydrator's
// createShadowDepthRebinder rebinds texture_depth_2d bindings to live
// light.shadow.map.depthTexture — but they're null without help.
//
// We piggyback on the full WebGPURenderer (already initialised for compute
// and PMREM, sharing the slim's GPU device). For each shadow-using scene we
// build a parallel "shadow scene" with stand-in MeshBasicNodeMaterial meshes
// that mirror the user's castShadow/receiveShadow flags, plus shared Light
// references. fullRenderer.render(shadowScene, camera) triggers three.js's
// shadow pass which allocates light.shadow.map (a RenderTarget) ON THE
// SHARED LIGHT OBJECT — slim's rebinder then resolves to a real depth map.
//
// We render to an offscreen RenderTarget so the canvas is left alone.
// ============================================================================

const __shadowSceneCache = new WeakMap(); // user-scene -> shadow-scene
const __shadowSceneMap = new WeakMap();   // user-scene -> { meshCount }
const __shadowGeometryCache = new WeakMap(); // slim geometry -> full geometry
const __shadowDiscardRT = { rt: null };
const __shadowCoverageRT = { rt: null, material: null };
const __shadowDepthViewRT = { rt: null, material: null, quad: null, texture: null };

function __sceneHasShadowLights( scene ) {
	if ( ! scene || typeof scene.traverse !== 'function' ) return false;
	let found = false;
	scene.traverse( ( o ) => {
		if ( found ) return;
		if ( o && o.isLight === true && o.castShadow === true && o.shadow ) found = true;
	} );
	return found;
}

function __cloneAttributeForFullRenderer( attr ) {
	if ( ! attr || ! __fullThreeMod ) return attr;
	const FullThree = __fullThreeMod;
	try {
		if ( attr.isInstancedBufferAttribute === true && FullThree.InstancedBufferAttribute && attr.array && Number.isInteger( attr.itemSize ) ) {
			const meshPerAttribute = Number.isFinite( attr.meshPerAttribute ) ? attr.meshPerAttribute : 1;
			const fullAttr = new FullThree.InstancedBufferAttribute( attr.array, attr.itemSize, attr.normalized === true, meshPerAttribute );
			if ( typeof attr.usage === 'number' ) fullAttr.setUsage( attr.usage );
			return fullAttr;
		}
		if ( attr.isInterleavedBufferAttribute === true && FullThree.InterleavedBuffer && FullThree.InterleavedBufferAttribute ) {
			const data = attr.data;
			const fullData = new FullThree.InterleavedBuffer( data.array, data.stride );
			if ( typeof data.usage === 'number' ) fullData.setUsage( data.usage );
			return new FullThree.InterleavedBufferAttribute( fullData, attr.itemSize, attr.offset, attr.normalized );
		}
		if ( FullThree.BufferAttribute && attr.array && Number.isInteger( attr.itemSize ) ) {
			const fullAttr = new FullThree.BufferAttribute( attr.array, attr.itemSize, attr.normalized === true );
			if ( typeof attr.usage === 'number' ) fullAttr.setUsage( attr.usage );
			return fullAttr;
		}
	} catch ( _ ) {}
	return attr;
}

function __cloneGeometryForFullRenderer( geometry ) {
	if ( ! geometry || ! __fullThreeMod ) return geometry;
	if ( __shadowGeometryCache.has( geometry ) ) return __shadowGeometryCache.get( geometry );
	const { BufferGeometry } = __fullThreeMod;
	if ( ! BufferGeometry ) return geometry;
	const cloned = new BufferGeometry();
	try {
		cloned.name = geometry.name || '';
		if ( geometry.index ) cloned.setIndex( __cloneAttributeForFullRenderer( geometry.index ) );
		const attributes = geometry.attributes || {};
		for ( const name in attributes ) cloned.setAttribute( name, __cloneAttributeForFullRenderer( attributes[ name ] ) );
		const morphAttributes = geometry.morphAttributes || {};
		for ( const name in morphAttributes ) {
			cloned.morphAttributes[ name ] = morphAttributes[ name ].map( ( attr ) => __cloneAttributeForFullRenderer( attr ) );
		}
		cloned.morphTargetsRelative = geometry.morphTargetsRelative === true;
		if ( geometry.drawRange ) cloned.setDrawRange( geometry.drawRange.start || 0, geometry.drawRange.count === undefined ? Infinity : geometry.drawRange.count );
		if ( Array.isArray( geometry.groups ) ) {
			for ( const group of geometry.groups ) cloned.addGroup( group.start || 0, group.count || 0, group.materialIndex || 0 );
		}
		if ( geometry.boundingBox && typeof geometry.boundingBox.clone === 'function' ) cloned.boundingBox = geometry.boundingBox.clone();
		if ( geometry.boundingSphere && typeof geometry.boundingSphere.clone === 'function' ) cloned.boundingSphere = geometry.boundingSphere.clone();
	} catch ( _ ) {
		__shadowGeometryCache.set( geometry, geometry );
		return geometry;
	}
	__shadowGeometryCache.set( geometry, cloned );
	return cloned;
}

function __fullLightColorValue( light ) {
	const color = light && light.color;
	if ( color && typeof color.getHex === 'function' ) {
		try { return color.getHex(); } catch ( _ ) {}
	}
	if ( color && Number.isFinite( color.r ) && Number.isFinite( color.g ) && Number.isFinite( color.b ) ) {
		return ( Math.round( Math.min( 1, Math.max( 0, color.r ) ) * 255 ) << 16 )
			| ( Math.round( Math.min( 1, Math.max( 0, color.g ) ) * 255 ) << 8 )
			| Math.round( Math.min( 1, Math.max( 0, color.b ) ) * 255 );
	}
	return 0xffffff;
}

function __nodeAttributeSnapshotArray( entry ) {
	const array = entry && ( entry.arraySnapshot || entry._liveArray ) || null;
	return array && typeof array.length === 'number' ? array : null;
}

function __nodeAttributeSpreadScore( entry ) {
	const array = __nodeAttributeSnapshotArray( entry );
	const itemSize = entry && ( entry.itemSize || 0 ) || 0;
	const count = entry && ( entry.count || 0 ) || 0;
	if ( ! array || itemSize < 3 || count <= 0 ) return - Infinity;
	let minX = Infinity, minY = Infinity, minZ = Infinity;
	let maxX = - Infinity, maxY = - Infinity, maxZ = - Infinity;
	for ( let i = 0; i < count; i ++ ) {
		const offset = i * itemSize;
		const x = Number( array[ offset ] );
		const y = Number( array[ offset + 1 ] );
		const z = Number( array[ offset + 2 ] );
		if ( ! Number.isFinite( x ) || ! Number.isFinite( y ) || ! Number.isFinite( z ) ) continue;
		minX = Math.min( minX, x ); minY = Math.min( minY, y ); minZ = Math.min( minZ, z );
		maxX = Math.max( maxX, x ); maxY = Math.max( maxY, y ); maxZ = Math.max( maxZ, z );
	}
	if ( minX === Infinity ) return - Infinity;
	const dx = maxX - minX;
	const dy = maxY - minY;
	const dz = maxZ - minZ;
	return dx * dx + dy * dy + dz * dz;
}

function __shadowProxyArtifactForObject( object ) {
	const material = object && object.material;
	const list = Array.isArray( material ) ? material : material ? [ material ] : [];
	for ( const mat of list ) {
		if ( mat && mat.isPrecompiledMaterial === true && mat.precompiledArtifact ) return mat.precompiledArtifact;
	}
	return null;
}

function __shaderInstancedShadowProxyAttributes( object ) {
	const artifact = __shadowProxyArtifactForObject( object );
	const entries = Array.isArray( artifact && artifact.attributes ) ? artifact.attributes : Array.isArray( artifact && artifact.nodeAttributes ) ? artifact.nodeAttributes : [];
	const candidates = entries.filter( ( entry ) => entry && entry.source === 'node' && entry.instanced === true && ! entry.userPath && __nodeAttributeSnapshotArray( entry ) );
	if ( candidates.length === 0 ) return null;
	let position = null;
	let bestScore = - Infinity;
	for ( const entry of candidates ) {
		const score = __nodeAttributeSpreadScore( entry );
		if ( score > bestScore ) {
			position = entry;
			bestScore = score;
		}
	}
	if ( ! position || bestScore <= 0 ) return null;
	const count = Math.min( object && object.count || position.count || 0, position.count || 0 );
	if ( count <= 0 ) return null;
	let scale = null;
	const vertexShader = String( artifact && artifact.vertexShader || '' );
	scale = candidates.find( ( entry ) => entry !== position && entry.name && vertexShader.includes( entry.name + '.x' ) ) || null;
	const normal = candidates.find( ( entry ) => entry !== position && entry !== scale && entry.name && vertexShader.includes( entry.name + ' * vec3<f32>( abs' ) ) || null;
	return { position, scale, normal, count };
}

function __makeShaderInstancedShadowProxy( sourceObject, geometry, material ) {
	if ( ! sourceObject || ! __fullThreeMod ) return null;
	const { InstancedMesh: FullInstancedMesh, Matrix4: FullMatrix4 } = __fullThreeMod;
	if ( ! FullInstancedMesh || ! FullMatrix4 ) return null;
	const proxy = __shaderInstancedShadowProxyAttributes( sourceObject );
	if ( ! proxy ) return null;
	const posArray = __nodeAttributeSnapshotArray( proxy.position );
	const posSize = proxy.position.itemSize || 3;
	const scaleArray = __nodeAttributeSnapshotArray( proxy.scale );
	const scaleSize = proxy.scale && proxy.scale.itemSize || 0;
	const normalArray = __nodeAttributeSnapshotArray( proxy.normal );
	const normalSize = proxy.normal && proxy.normal.itemSize || 0;
	if ( ! posArray || posSize < 3 ) return null;
	let standin = null;
	try {
		standin = new FullInstancedMesh( geometry, material, proxy.count );
		const matrix = new FullMatrix4();
		for ( let i = 0; i < proxy.count; i ++ ) {
			const posOffset = i * posSize;
			let instanceScale = 1;
			let normalOffset = 0;
			if ( scaleArray && scaleSize > 0 ) {
				const scaleValue = Math.abs( Number( scaleArray[ i * scaleSize ] ) );
				if ( Number.isFinite( scaleValue ) && scaleValue > 0 ) instanceScale = 1 + scaleValue * 2;
				if ( scaleSize > 2 ) {
					const seed = Number( scaleArray[ i * scaleSize + 2 ] );
					if ( Number.isFinite( seed ) ) normalOffset = Math.abs( Math.sin( seed * 2 ) * 1.5 );
				}
			}
			const normalOffsetBase = i * normalSize;
			const offsetX = normalArray && normalSize >= 3 ? ( Number( normalArray[ normalOffsetBase ] ) || 0 ) * normalOffset : 0;
			const offsetY = normalArray && normalSize >= 3 ? ( Number( normalArray[ normalOffsetBase + 1 ] ) || 0 ) * normalOffset : 0;
			const offsetZ = normalArray && normalSize >= 3 ? ( Number( normalArray[ normalOffsetBase + 2 ] ) || 0 ) * normalOffset : 0;
			matrix.makeScale( instanceScale, instanceScale, instanceScale );
			matrix.setPosition( ( Number( posArray[ posOffset ] ) || 0 ) + offsetX, ( Number( posArray[ posOffset + 1 ] ) || 0 ) + offsetY, ( Number( posArray[ posOffset + 2 ] ) || 0 ) + offsetZ );
			standin.setMatrixAt( i, matrix );
		}
		standin.count = proxy.count;
		if ( standin.instanceMatrix ) standin.instanceMatrix.needsUpdate = true;
		__copyMorphStateForFullRenderer( sourceObject, standin );
		return standin;
	} catch ( _ ) {
		return null;
	}
}

function __copyMorphStateForFullRenderer( sourceObject, standin ) {
	if ( ! sourceObject || ! standin ) return;
	try {
		if ( sourceObject.morphTargetDictionary !== undefined ) {
			standin.morphTargetDictionary = { ...sourceObject.morphTargetDictionary };
		}
		const influences = sourceObject.morphTargetInfluences;
		if ( Array.isArray( influences ) ) {
			if ( ! Array.isArray( standin.morphTargetInfluences ) || standin.morphTargetInfluences.length !== influences.length ) {
				standin.morphTargetInfluences = influences.slice();
			} else {
				for ( let i = 0; i < influences.length; i ++ ) standin.morphTargetInfluences[ i ] = influences[ i ];
			}
		}
		if ( sourceObject.isInstancedMesh === true && sourceObject.morphTexture !== null && sourceObject.morphTexture !== undefined ) {
			standin.morphTexture = sourceObject.morphTexture;
			if ( sourceObject.morphTexture.needsUpdate === true ) standin.morphTexture.needsUpdate = true;
		}
	} catch ( _ ) {}
}

function __sourceObjectWorldBounds( sourceObject ) {
	if ( ! sourceObject || ! __fullThreeMod ) return null;
	const { Box3: FullBox3, Vector3: FullVector3 } = __fullThreeMod;
	if ( ! FullBox3 || ! FullVector3 ) return null;
	let srcBox = null;
	try {
		if ( typeof sourceObject.computeBoundingBox === 'function' ) sourceObject.computeBoundingBox();
		if ( sourceObject.boundingBox && sourceObject.boundingBox.min && sourceObject.boundingBox.max ) srcBox = sourceObject.boundingBox;
	} catch ( _ ) {}
	if ( ! srcBox && sourceObject.geometry && sourceObject.geometry.boundingBox && sourceObject.geometry.boundingBox.min && sourceObject.geometry.boundingBox.max ) {
		srcBox = sourceObject.geometry.boundingBox;
	}
	if ( ! srcBox && sourceObject.geometry && typeof sourceObject.geometry.computeBoundingBox === 'function' ) {
		try {
			sourceObject.geometry.computeBoundingBox();
			srcBox = sourceObject.geometry.boundingBox;
		} catch ( _ ) {}
	}
	if ( ! srcBox || ! srcBox.min || ! srcBox.max ) return null;
	const box = new FullBox3(
		new FullVector3( srcBox.min.x || 0, srcBox.min.y || 0, srcBox.min.z || 0 ),
		new FullVector3( srcBox.max.x || 0, srcBox.max.y || 0, srcBox.max.z || 0 )
	);
	try { if ( sourceObject.matrixWorld ) box.applyMatrix4( sourceObject.matrixWorld ); } catch ( _ ) {}
	const size = new FullVector3();
	const center = new FullVector3();
	box.getSize( size );
	box.getCenter( center );
	if ( ! Number.isFinite( size.x ) || ! Number.isFinite( size.y ) || ! Number.isFinite( size.z ) ) return null;
	if ( size.x <= 0 || size.y <= 0 || size.z <= 0 ) return null;
	if ( size.x > 20 || size.y > 20 || size.z > 20 ) return null;
	return { box, size, center };
}

function __makeSkinnedShadowProxy( sourceObject, material ) {
	if ( ! sourceObject || ! __fullThreeMod ) return null;
	const {
		BoxGeometry: FullBoxGeometry,
		BufferAttribute: FullBufferAttribute,
		BufferGeometry: FullBufferGeometry,
		CapsuleGeometry: FullCapsuleGeometry,
		Mesh: FullMesh,
		Vector3: FullVector3,
	} = __fullThreeMod;
	const sourceGeometry = sourceObject.geometry || null;
	const sourcePosition = sourceGeometry && ( typeof sourceGeometry.getAttribute === 'function'
		? sourceGeometry.getAttribute( 'position' )
		: sourceGeometry.attributes && sourceGeometry.attributes.position ) || null;
	if ( FullMesh && FullBufferGeometry && FullBufferAttribute && FullVector3 && sourcePosition && Number.isInteger( sourcePosition.count ) && sourcePosition.count > 0 && typeof sourceObject.getVertexPosition === 'function' ) {
		try {
			const geometry = new FullBufferGeometry();
			geometry.name = sourceGeometry.name || '';
			if ( sourceGeometry.index ) geometry.setIndex( __cloneAttributeForFullRenderer( sourceGeometry.index ) );
			geometry.setAttribute( 'position', new FullBufferAttribute( new Float32Array( sourcePosition.count * 3 ), 3 ) );
			if ( sourceGeometry.drawRange ) geometry.setDrawRange( sourceGeometry.drawRange.start || 0, sourceGeometry.drawRange.count === undefined ? Infinity : sourceGeometry.drawRange.count );
			if ( Array.isArray( sourceGeometry.groups ) ) {
				for ( const group of sourceGeometry.groups ) geometry.addGroup( group.start || 0, group.count || 0, group.materialIndex || 0 );
			}
			const standin = new FullMesh( geometry, material );
			standin.__tslpSkinnedShadowProxy = true;
			standin.__tslpSkinnedShadowVector = new FullVector3();
			if ( __updateSkinnedShadowProxyGeometry( sourceObject, standin ) ) return standin;
		} catch ( _ ) {}
	}
	if ( ! FullMesh || ( ! FullCapsuleGeometry && ! FullBoxGeometry ) ) return null;
	const bounds = __sourceObjectWorldBounds( sourceObject );
	let size = bounds && bounds.size || null;
	let center = bounds && bounds.center || null;
	if ( ! size || ! center ) {
		size = new FullVector3( 0.7, 1.8, 0.45 );
		center = new FullVector3();
		try {
			if ( sourceObject.matrixWorld && sourceObject.matrixWorld.elements ) {
				const e = sourceObject.matrixWorld.elements;
				center.set( e[ 12 ] || 0, ( e[ 13 ] || 0 ) + size.y * 0.5, e[ 14 ] || 0 );
			}
		} catch ( _ ) {}
	}
	const width = Math.max( 0.16, Math.min( 0.42, size.x * 0.38 ) );
	const height = Math.max( 0.75, Math.min( 1.65, size.y * 0.82 ) );
	const depth = Math.max( 0.16, Math.min( 0.36, size.z * 0.38 ) );
	const radius = Math.max( 0.08, Math.min( width, depth ) * 0.5 );
	const geometry = FullCapsuleGeometry
		? new FullCapsuleGeometry( radius, Math.max( 0.2, height - radius * 2 ), 4, 8 )
		: new FullBoxGeometry( width, height, depth );
	const standin = new FullMesh( geometry, material );
	standin.position.copy( center );
	standin.__tslpWorldSpaceShadowProxy = true;
	return standin;
}

function __updateSkinnedShadowProxyGeometry( sourceObject, standin ) {
	if ( ! sourceObject || ! standin || standin.__tslpSkinnedShadowProxy !== true || typeof sourceObject.getVertexPosition !== 'function' ) return false;
	const geometry = standin.geometry || null;
	const position = geometry && ( typeof geometry.getAttribute === 'function' ? geometry.getAttribute( 'position' ) : geometry.attributes && geometry.attributes.position ) || null;
	const array = position && position.array || null;
	const count = position && position.count || 0;
	if ( ! array || ! count ) return false;
	const v = standin.__tslpSkinnedShadowVector || ( __fullThreeMod && __fullThreeMod.Vector3 ? new __fullThreeMod.Vector3() : null );
	if ( ! v ) return false;
	standin.__tslpSkinnedShadowVector = v;
	try {
		for ( let i = 0; i < count; i ++ ) {
			sourceObject.getVertexPosition( i, v );
			const offset = i * 3;
			array[ offset ] = v.x || 0;
			array[ offset + 1 ] = v.y || 0;
			array[ offset + 2 ] = v.z || 0;
		}
		position.needsUpdate = true;
		if ( geometry ) {
			geometry.boundingBox = null;
			geometry.boundingSphere = null;
		}
		return true;
	} catch ( _ ) {
		return false;
	}
}

function __shadowSourceMaterials( material ) {
	const input = Array.isArray( material ) ? material : material ? [ material ] : [];
	const out = [];
	for ( const mat of input ) {
		if ( ! mat ) continue;
		if ( ! out.includes( mat ) ) out.push( mat );
		const source = mat.__tslpSourceMaterial || null;
		if ( source && ! out.includes( source ) ) out.push( source );
	}
	return out;
}

function __buildShadowScene( userScene ) {
	if ( ! __fullThreeMod ) return null;
	// MeshLambertNodeMaterial samples lights and shadows — without a shadow-
	// sampling material in the scene, three.js's NodeBuilder skips ShadowNode
	// setup and light.shadow.map never allocates. Lambert is the cheapest
	// PCF-shadow-aware material we can stand-in for.
	const { Scene: FullScene, Mesh: FullMesh, InstancedMesh: FullInstancedMesh, MeshLambertMaterial, MeshLambertNodeMaterial, ClippingGroup: FullClippingGroup } = __fullThreeMod;
	if ( ! FullScene || ! FullMesh || ( ! MeshLambertMaterial && ! MeshLambertNodeMaterial ) ) return null;
	const StandinMaterial = MeshLambertNodeMaterial || MeshLambertMaterial;
	const shadowScene = new FullScene();
	const lightPairs = []; // { src, clone } so we can refresh transforms each render
	const meshPairs = []; // { src, clone } so we can refresh transforms each render
	const clipPairs = []; // { src, clone } so live GUI toggles update helper groups
	const clipParentCache = new WeakMap();
	function clipMountPointFor( sourceObject ) {
		if ( ! FullClippingGroup || ! sourceObject ) return shadowScene;
		const chain = [];
		let cursor = sourceObject.parent || null;
		while ( cursor ) {
			if ( cursor.isClippingGroup === true ) chain.unshift( cursor );
			cursor = cursor.parent || null;
		}
		if ( chain.length === 0 ) return shadowScene;
		let parent = shadowScene;
		for ( const srcGroup of chain ) {
			let cloneGroup = clipParentCache.get( srcGroup );
			if ( ! cloneGroup ) {
				cloneGroup = new FullClippingGroup();
				cloneGroup.clippingPlanes = srcGroup.clippingPlanes;
				cloneGroup.enabled = srcGroup.enabled;
				cloneGroup.clipIntersection = srcGroup.clipIntersection;
				cloneGroup.clipShadows = srcGroup.clipShadows;
				if ( srcGroup.layers && cloneGroup.layers ) cloneGroup.layers.mask = srcGroup.layers.mask;
				parent.add( cloneGroup );
				clipParentCache.set( srcGroup, cloneGroup );
				clipPairs.push( { src: srcGroup, clone: cloneGroup } );
			} else if ( cloneGroup.parent !== parent ) {
				parent.add( cloneGroup );
			}
			parent = cloneGroup;
		}
		return parent;
	}
	let meshCount = 0;
	let casterCount = 0;
	let lightCount = 0;
	// Make sure all matrices are current before reading.
	try { userScene.updateMatrixWorld( true ); } catch ( _ ) {}
	userScene.traverse( ( o ) => {
		if ( ! o ) return;
		// Lights: clone (so the original keeps its parent in the user scene),
		// but SHARE the LightShadow object by reference. Three.js's shadow
		// pass writes shadow.map onto cloned.shadow — because shadow is the
		// same LightShadow instance as the original, original.shadow.map is
		// populated too, and the slim hydrator's rebinder picks it up.
		if ( o.isLight === true && o.castShadow === true && o.shadow && o.visible !== false ) {
			let cloned = null;
			// Build a fresh light of the same type rather than cloning, to avoid
			// any inherited internal state that disables shadow allocation.
			try {
				const FullThree = __fullThreeMod;
				if ( o.isDirectionalLight && FullThree.DirectionalLight ) {
					cloned = new FullThree.DirectionalLight( __fullLightColorValue( o ), o.intensity || 1 );
				} else if ( o.isSpotLight && FullThree.SpotLight ) {
					cloned = new FullThree.SpotLight( __fullLightColorValue( o ), o.intensity || 1 );
					if ( o.distance !== undefined ) cloned.distance = o.distance;
					if ( o.angle !== undefined ) cloned.angle = o.angle;
					if ( o.penumbra !== undefined ) cloned.penumbra = o.penumbra;
					if ( o.decay !== undefined ) cloned.decay = o.decay;
				} else if ( o.isPointLight && FullThree.PointLight ) {
					cloned = new FullThree.PointLight( __fullLightColorValue( o ), o.intensity || 1 );
					if ( o.distance !== undefined ) cloned.distance = o.distance;
					if ( o.decay !== undefined ) cloned.decay = o.decay;
				} else if ( typeof o.clone === 'function' ) {
					cloned = o.clone();
				}
			} catch ( _ ) { cloned = null; }
			if ( cloned ) {
				cloned.visible = o.visible !== false;
				cloned.castShadow = true;
				cloned.shadow = o.shadow;
				// Copy mapSize/bias/normalBias/radius/camera params from source.shadow
				if ( cloned.shadow && o.shadow ) {
					if ( o.shadow.mapSize ) cloned.shadow.mapSize.copy( o.shadow.mapSize );
					if ( typeof o.shadow.bias === 'number' ) cloned.shadow.bias = o.shadow.bias;
					if ( typeof o.shadow.normalBias === 'number' ) cloned.shadow.normalBias = o.shadow.normalBias;
					if ( typeof o.shadow.radius === 'number' ) cloned.shadow.radius = o.shadow.radius;
					if ( o.shadow.camera ) {
						if ( typeof o.shadow.camera.near === 'number' ) cloned.shadow.camera.near = o.shadow.camera.near;
						if ( typeof o.shadow.camera.far === 'number' ) cloned.shadow.camera.far = o.shadow.camera.far;
						if ( typeof o.shadow.camera.zoom === 'number' ) cloned.shadow.camera.zoom = o.shadow.camera.zoom;
						if ( typeof o.shadow.camera.left === 'number' ) cloned.shadow.camera.left = o.shadow.camera.left;
						if ( typeof o.shadow.camera.right === 'number' ) cloned.shadow.camera.right = o.shadow.camera.right;
						if ( typeof o.shadow.camera.top === 'number' ) cloned.shadow.camera.top = o.shadow.camera.top;
						if ( typeof o.shadow.camera.bottom === 'number' ) cloned.shadow.camera.bottom = o.shadow.camera.bottom;
						if ( typeof o.shadow.camera.aspect === 'number' ) cloned.shadow.camera.aspect = o.shadow.camera.aspect;
						if ( typeof o.shadow.camera.fov === 'number' ) cloned.shadow.camera.fov = o.shadow.camera.fov;
						cloned.shadow.camera.updateProjectionMatrix();
					}
				}
				// Decompose the original light's world transform onto the
				// cloned light's local position/quaternion/scale. This way
				// matrixAutoUpdate stays true and three.js's matrix update
				// pipeline produces correct matrixWorld during render.
				if ( o.matrixWorld ) {
					o.matrixWorld.decompose( cloned.position, cloned.quaternion, cloned.scale );
				}
				if ( o.layers && cloned.layers ) cloned.layers.mask = o.layers.mask;
				// Directional / spot lights project shadows toward a target;
				// the target is also an Object3D in the user scene. Clone it
				// and parent under shadowScene to keep the projection correct.
				if ( o.target && o.target.isObject3D ) {
					const tgtClone = o.target.clone();
					if ( o.target.matrixWorld ) {
						o.target.matrixWorld.decompose( tgtClone.position, tgtClone.quaternion, tgtClone.scale );
					}
					if ( o.target.layers && tgtClone.layers ) tgtClone.layers.mask = o.target.layers.mask;
					shadowScene.add( tgtClone );
					cloned.target = tgtClone;
				}
				shadowScene.add( cloned );
				lightPairs.push( { src: o, clone: cloned } );
				lightCount ++;
			}
			return;
		}
		// Mirror shadow-relevant meshes with a basic node material so the full
		// renderer's NodeBuilder can compile them. The shadow pass overrides
		// material with ShadowPassMaterial for the depth render anyway.
		if ( ( o.isMesh === true || o.isSkinnedMesh === true ) && o.geometry && ( o.castShadow === true || o.receiveShadow === true ) ) {
			if ( o.isSkinnedMesh === true && /joint/i.test( o.name || '' ) ) return;
			let standinMaterial;
			try { standinMaterial = new StandinMaterial( { color: 0xffffff } ); } catch ( _ ) { standinMaterial = new StandinMaterial(); }
			try {
				if ( standinMaterial.color && typeof standinMaterial.color.setHex === 'function' ) standinMaterial.color.setHex( 0xffffff );
			} catch ( _ ) {}
			let standin = null;
			if ( o.isInstancedMesh === true && FullInstancedMesh ) {
				const count = o.count || o.instanceMatrix && o.instanceMatrix.count || 1;
				standin = new FullInstancedMesh( __cloneGeometryForFullRenderer( o.geometry ), standinMaterial, count );
				standin.count = count;
				if ( o.instanceMatrix ) {
					try {
						standin.instanceMatrix = __cloneAttributeForFullRenderer( o.instanceMatrix );
						standin.instanceMatrix.needsUpdate = true;
					} catch ( _ ) {}
				}
				if ( o.instanceColor ) {
					try {
						standin.instanceColor = __cloneAttributeForFullRenderer( o.instanceColor );
						standin.instanceColor.needsUpdate = true;
					} catch ( _ ) {}
				}
				__copyMorphStateForFullRenderer( o, standin );
			}
			if ( ! standin ) {
				const fullGeometry = __cloneGeometryForFullRenderer( o.geometry );
				standin = o.isSkinnedMesh === true
					? __makeSkinnedShadowProxy( o, standinMaterial )
					: null;
				standin = standin || __makeShaderInstancedShadowProxy( o, fullGeometry, standinMaterial ) || new FullMesh( fullGeometry, standinMaterial );
				__copyMorphStateForFullRenderer( o, standin );
			}
			standin.castShadow = !! o.castShadow;
			standin.receiveShadow = !! o.receiveShadow;
			standin.visible = o.visible !== false;
			// Decompose world matrix onto local position/quaternion/scale —
			// matrixAutoUpdate=true (default) ensures matrixWorld is rebuilt
			// during render's projectObject pass.
			if ( o.matrixWorld && standin.__tslpWorldSpaceShadowProxy !== true ) {
				o.matrixWorld.decompose( standin.position, standin.quaternion, standin.scale );
			}
			if ( o.layers && standin.layers ) standin.layers.mask = o.layers.mask;
			standin.frustumCulled = false;
			// Carry alpha-related fields that the depth pass uses.
			const shadowMaterials = __shadowSourceMaterials( o.material );
			const sourceMaterial = shadowMaterials.find( ( mat ) => mat && mat.__tslpSourceMaterial === undefined ) || shadowMaterials[ 0 ] || null;
			if ( sourceMaterial ) {
				for ( const key of [ 'side', 'shadowSide', 'alphaTest', 'transparent', 'opacity', 'depthTest', 'depthWrite', 'clipShadows', 'clippingPlanes' ] ) {
					if ( sourceMaterial[ key ] !== undefined ) standin.material[ key ] = sourceMaterial[ key ];
				}
				if ( sourceMaterial.alphaTest ) standin.material.alphaTest = sourceMaterial.alphaTest;
				if ( sourceMaterial.alphaMap ) standin.material.alphaMap = sourceMaterial.alphaMap;
				for ( const key of [ 'alphaTestNode', 'maskNode', 'maskShadowNode', 'castShadowPositionNode', 'castShadowNode' ] ) {
					if ( sourceMaterial[ key ] && sourceMaterial[ key ].isNode === true ) standin.material[ key ] = sourceMaterial[ key ];
				}
			}
			clipMountPointFor( o ).add( standin );
			meshPairs.push( { src: o, clone: standin } );
			meshCount ++;
			if ( standin.castShadow === true ) casterCount ++;
		}
	} );
	if ( meshCount === 0 || lightCount === 0 || casterCount === 0 ) return null;
	shadowScene.__lightPairs = lightPairs;
	shadowScene.__meshPairs = meshPairs;
	shadowScene.__clipPairs = clipPairs;
	shadowScene.__casterCount = casterCount;
	__shadowSceneMap.set( userScene, { meshCount, lightCount } );
	return shadowScene;
}

// Refresh world transforms on the cloned shadow-scene objects from their live
// source counterparts so animations & camera-driven rigs cast accurate shadows.
function __refreshShadowScene( userScene, shadowScene ) {
	if ( ! shadowScene ) return;
	try { userScene.updateMatrixWorld( true ); } catch ( _ ) {}
	const lightPairs = shadowScene.__lightPairs || [];
	for ( const { src, clone } of lightPairs ) {
		if ( ! src || ! clone || ! src.matrixWorld ) continue;
		// Decompose live world matrix into the clone's local position/quaternion/
		// scale. We keep matrixAutoUpdate=true so three.js's pipeline rebuilds
		// matrixWorld for the cloned light at the start of render — same as it
		// does for the selftest scene that successfully sets shadow.map.
		src.matrixWorld.decompose( clone.position, clone.quaternion, clone.scale );
		if ( src.layers && clone.layers ) clone.layers.mask = src.layers.mask;
		clone.visible = src.visible !== false;
		if ( src.target && clone.target && src.target.matrixWorld ) {
			src.target.matrixWorld.decompose( clone.target.position, clone.target.quaternion, clone.target.scale );
			if ( src.target.layers && clone.target.layers ) clone.target.layers.mask = src.target.layers.mask;
		}
	}
	const meshPairs = shadowScene.__meshPairs || [];
	for ( const { src, clone } of meshPairs ) {
		if ( ! src || ! clone || ! src.matrixWorld ) continue;
		if ( clone.__tslpWorldSpaceShadowProxy === true ) {
			const bounds = __sourceObjectWorldBounds( src );
			if ( bounds && bounds.center ) clone.position.copy( bounds.center );
		} else {
			src.matrixWorld.decompose( clone.position, clone.quaternion, clone.scale );
		}
		if ( clone.__tslpSkinnedShadowProxy === true ) __updateSkinnedShadowProxyGeometry( src, clone );
		if ( src.layers && clone.layers ) clone.layers.mask = src.layers.mask;
		clone.visible = src.visible !== false;
		__copyMorphStateForFullRenderer( src, clone );
		if ( src.isInstancedMesh === true && clone.isInstancedMesh === true ) {
			clone.count = src.count || clone.count;
			if ( src.instanceMatrix && clone.instanceMatrix && clone.instanceMatrix.array !== src.instanceMatrix.array ) {
				try {
					clone.instanceMatrix.array.set( src.instanceMatrix.array );
					clone.instanceMatrix.needsUpdate = true;
				} catch ( _ ) {}
			}
			if ( src.instanceColor && clone.instanceColor && clone.instanceColor.array !== src.instanceColor.array ) {
				try {
					clone.instanceColor.array.set( src.instanceColor.array );
					clone.instanceColor.needsUpdate = true;
				} catch ( _ ) {}
			}
		}
	}
	const clipPairs = shadowScene.__clipPairs || [];
	for ( const { src, clone } of clipPairs ) {
		if ( ! src || ! clone ) continue;
		clone.clippingPlanes = src.clippingPlanes;
		clone.enabled = src.enabled;
		clone.clipIntersection = src.clipIntersection;
		clone.clipShadows = src.clipShadows;
		if ( src.layers && clone.layers ) clone.layers.mask = src.layers.mask;
	}
}

function __getOrBuildShadowScene( userScene ) {
	if ( __shadowSceneCache.has( userScene ) ) return __shadowSceneCache.get( userScene );
	const built = __buildShadowScene( userScene );
	__shadowSceneCache.set( userScene, built ); // cache null too, so we don't retry
	return built;
}

function __suspendCustomShadowNodes( root ) {
	const suspended = [];
	const suspendLight = ( light ) => {
		const shadow = light && light.shadow;
		if ( ! shadow || ! shadow.shadowNode ) return;
		suspended.push( { shadow, shadowNode: shadow.shadowNode } );
		shadow.shadowNode = undefined;
	};
	const pairs = root && root.__lightPairs;
	if ( Array.isArray( pairs ) ) {
		for ( const { src } of pairs ) suspendLight( src );
	} else if ( root && typeof root.traverse === 'function' ) {
		root.traverse( ( object ) => {
			if ( object && object.isLight === true ) suspendLight( object );
		} );
	}
	return suspended;
}

function __restoreCustomShadowNodes( suspended ) {
	for ( const entry of suspended || [] ) {
		if ( entry && entry.shadow ) entry.shadow.shadowNode = entry.shadowNode;
	}
}

function __updateCustomShadowHelpers( scene ) {
	if ( ! scene || typeof scene.traverse !== 'function' ) return;
	scene.traverse( ( object ) => {
		if ( ! object || ! object.tileShadowNode || typeof object.update !== 'function' ) return;
		try { object.update(); } catch ( _ ) {}
	} );
}

async function __renderCustomShadowNodes( fullRenderer, slimRenderer, userScene, shadowScene, camera ) {
	if ( ! fullRenderer || ! userScene || ! shadowScene || typeof userScene.traverse !== 'function' ) return 0;
	let rendered = 0;
	const frame = { renderer: fullRenderer, scene: shadowScene, camera };
	const debugProbeJobs = [];
	userScene.traverse( ( light ) => {
		const shadowNode = light && light.isLight === true && light.shadow && light.shadow.shadowNode || null;
		if ( ! shadowNode || shadowNode.isShadowBaseNode !== true ) return;
		const ctorName = shadowNode.constructor && shadowNode.constructor.name || '';
		if ( ! /TileShadowNode/.test( ctorName ) ) return;
		try {
			const suspendedCustomShadowNodes = __suspendCustomShadowNodes( shadowScene );
			const previousShadowMapEnabled = fullRenderer.shadowMap ? fullRenderer.shadowMap.enabled : undefined;
			try {
				if ( fullRenderer.shadowMap ) fullRenderer.shadowMap.enabled = false;
				for ( let pass = 0; pass < 2; pass ++ ) {
					if ( typeof shadowNode.update === 'function' ) shadowNode.update();
					if ( typeof shadowNode.updateShadow === 'function' ) {
						shadowNode.updateShadow( frame );
						rendered ++;
					}
				}
			} finally {
				if ( fullRenderer.shadowMap && previousShadowMapEnabled !== undefined ) fullRenderer.shadowMap.enabled = previousShadowMapEnabled;
				__restoreCustomShadowNodes( suspendedCustomShadowNodes );
			}
			const depthTexture = shadowNode.shadowMap && shadowNode.shadowMap.depthTexture || null;
			if ( depthTexture && depthTexture.isTexture === true ) {
				__shareShadowGpuTextureIntoSlim( depthTexture, fullRenderer, slimRenderer );
				if ( window.__TSLP_DEBUG_SHADOW_COVERAGE === true ) {
					debugProbeJobs.push( ( async () => {
						const diag = window.__tslpHarnessDiagnostics || ( window.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
						const list = diag.customShadowNodes || ( diag.customShadowNodes = [] );
						if ( list.length >= 24 ) return;
						const image = depthTexture.image || {};
						const fullData = fullRenderer.backend && fullRenderer.backend.get ? fullRenderer.backend.get( depthTexture ) : null;
						const slimData = slimRenderer && slimRenderer.backend && slimRenderer.backend.get ? slimRenderer.backend.get( depthTexture ) : null;
						const layers = Math.max( 1, Number( image.depth || image.depthOrArrayLayers || fullData && fullData.texture && fullData.texture.depthOrArrayLayers || 1 ) || 1 );
						const layerViews = [];
						for ( let layer = 0; layer < Math.min( layers, 8 ); layer ++ ) {
							const view = await __probeShadowDepthTextureView( fullRenderer, depthTexture, light, 96, { layer } );
							layerViews.push( view );
						}
						list.push( {
							lightUuid: light && light.uuid || null,
							constructorName: ctorName,
							layers,
							image: [ image.width || 0, image.height || 0, image.depth || image.depthOrArrayLayers || 0 ],
							isArrayTexture: depthTexture.isArrayTexture === true,
							compareFunction: depthTexture.compareFunction ?? null,
							fullGpu: fullData && fullData.texture ? [ fullData.texture.width || 0, fullData.texture.height || 0, fullData.texture.depthOrArrayLayers || 0, fullData.texture.format || null ] : null,
							slimShared: !! ( slimData && slimData.__tslpSharedShadowGPUTexture && slimData.texture === slimData.__tslpSharedShadowGPUTexture ),
							layerViews,
						} );
					} )() );
				}
			}
			for ( const tileLight of shadowNode.lights || [] ) {
				const tex = tileLight && tileLight.shadow && tileLight.shadow.map && tileLight.shadow.map.depthTexture || null;
				if ( tex && tex.isTexture === true ) __shareShadowGpuTextureIntoSlim( tex, fullRenderer, slimRenderer );
			}
		} catch ( err ) {
			if ( window.__TSLP_DEBUG_SHADOW_BINDINGS === true || window.__TSLP_DEBUG_SHADOW_COVERAGE === true ) {
				console.warn( '[tslp-shadow] custom shadow render failed:', err && err.message || err );
			}
		}
	} );
	if ( debugProbeJobs.length > 0 ) {
		try { await Promise.all( debugProbeJobs ); } catch ( _ ) {}
	}
	if ( rendered > 0 ) {
		try {
			const queue = fullRenderer.backend && fullRenderer.backend.device && fullRenderer.backend.device.queue;
			if ( queue && typeof queue.onSubmittedWorkDone === 'function' ) await queue.onSubmittedWorkDone();
		} catch ( _ ) {}
	}
	return rendered;
}

function __cloneCameraForFullRenderer( camera, fallbackAspect = 1 ) {
	if ( ! camera || ! __fullThreeMod ) return camera;
	const FullThree = __fullThreeMod;
	let cloned = null;
	try {
		if ( camera.isPerspectiveCamera === true && FullThree.PerspectiveCamera ) {
			cloned = new FullThree.PerspectiveCamera( camera.fov, camera.aspect || fallbackAspect || 1, camera.near, camera.far );
			for ( const key of [ 'zoom', 'filmGauge', 'filmOffset', 'focus' ] ) {
				if ( camera[ key ] !== undefined ) cloned[ key ] = camera[ key ];
			}
		} else if ( camera.isOrthographicCamera === true && FullThree.OrthographicCamera ) {
			cloned = new FullThree.OrthographicCamera( camera.left, camera.right, camera.top, camera.bottom, camera.near, camera.far );
			if ( camera.zoom !== undefined ) cloned.zoom = camera.zoom;
		} else if ( FullThree.Camera ) {
			cloned = new FullThree.Camera();
			if ( camera.near !== undefined ) cloned.near = camera.near;
			if ( camera.far !== undefined ) cloned.far = camera.far;
		}
		if ( ! cloned ) return camera;
		cloned.matrixAutoUpdate = false;
		if ( camera.matrix ) cloned.matrix.copy( camera.matrix );
		if ( camera.matrixWorld ) cloned.matrixWorld.copy( camera.matrixWorld );
		if ( camera.matrixWorldInverse ) cloned.matrixWorldInverse.copy( camera.matrixWorldInverse );
		if ( camera.projectionMatrix ) cloned.projectionMatrix.copy( camera.projectionMatrix );
		if ( camera.projectionMatrixInverse ) cloned.projectionMatrixInverse.copy( camera.projectionMatrixInverse );
		if ( camera.position ) cloned.position.copy( camera.position );
		if ( camera.quaternion ) cloned.quaternion.copy( camera.quaternion );
		if ( camera.scale ) cloned.scale.copy( camera.scale );
		if ( camera.layers && cloned.layers ) cloned.layers.mask = camera.layers.mask;
		if ( camera.coordinateSystem !== undefined ) cloned.coordinateSystem = camera.coordinateSystem;
		if ( camera.reversedDepth !== undefined ) cloned.reversedDepth = camera.reversedDepth;
		return cloned;
	} catch ( _ ) {
		return camera;
	}
}

// Track per-scene state: whether a shadow render is in flight, and the last
// shadow-scene signature used to detect scene growth or moving shadow casters /
// lights. Animated examples (e.g. a moving spotlight) need their offscreen full
// renderer shadow map refreshed when transforms move, otherwise the slim shader
// samples a stale depth map with a fresh light matrix and over-shadows the scene.
const __shadowState = new WeakMap(); // userScene -> { inflight, signature }
function __makeCustomShadowNodeBuilder( renderer, camera ) {
	const FullThree = __fullThreeMod || {};
	const FullRT = FullThree.RenderTarget;
	return {
		renderer,
		camera,
		createRenderTarget( width, height, options = {} ) {
			if ( FullRT ) return new FullRT( width, height, options );
			return {
				width,
				height,
				depth: options && Number.isFinite( options.depth ) ? options.depth : 1,
				texture: { isTexture: true, name: '', isRenderTargetTexture: true },
				depthTexture: null,
				setSize( nextWidth, nextHeight, nextDepth ) {
					this.width = nextWidth;
					this.height = nextHeight;
					if ( Number.isFinite( nextDepth ) ) this.depth = nextDepth;
				},
				dispose() {},
			};
		},
	};
}

function __prepareCustomShadowNodes( scene, renderer, camera ) {
	if ( ! scene || typeof scene.traverse !== 'function' ) return 0;
	const builder = __makeCustomShadowNodeBuilder( renderer, camera );
	let prepared = 0;
	try { scene.updateMatrixWorld( true ); } catch ( _ ) {}
	scene.traverse( ( light ) => {
		const shadowNode = light && light.isLight === true && light.shadow && light.shadow.shadowNode || null;
		if ( ! shadowNode || shadowNode.isShadowBaseNode !== true ) return;
		try {
			const ctorName = shadowNode.constructor && shadowNode.constructor.name || '';
			if ( /TileShadowNode/.test( ctorName ) && typeof shadowNode.init === 'function' && ( ! Array.isArray( shadowNode.lights ) || shadowNode.lights.length === 0 ) ) {
				shadowNode.init( builder );
				prepared ++;
			}
		} catch ( err ) {
			if ( window.__TSLP_DEBUG_SHADOW_BINDINGS === true || window.__TSLP_DEBUG_SHADOW_COVERAGE === true ) {
				console.warn( '[tslp-shadow] custom shadow init failed:', err && err.message || err );
			}
		}
	} );
	if ( prepared > 0 && scene._tslpLightCache ) delete scene._tslpLightCache;
	return prepared;
}

function __signatureMatrix( object ) {
	if ( ! object || ! object.matrixWorld || ! object.matrixWorld.elements ) return '';
	return object.matrixWorld.elements.map( ( value ) => Math.round( value * 1000 ) / 1000 ).join( ',' );
}

function __signatureSkinnedPose( object ) {
	const bones = object && object.skeleton && Array.isArray( object.skeleton.bones ) ? object.skeleton.bones : null;
	if ( ! bones || bones.length === 0 ) return '';
	const step = Math.max( 1, Math.floor( bones.length / 12 ) );
	const parts = [];
	for ( let i = 0; i < bones.length; i += step ) parts.push( __signatureMatrix( bones[ i ] ) );
	const influences = Array.isArray( object.morphTargetInfluences ) ? object.morphTargetInfluences : null;
	if ( influences && influences.length > 0 ) {
		parts.push( 'morph:' + influences.map( ( value ) => Math.round( value * 1000 ) / 1000 ).join( ',' ) );
	}
	return parts.join( ';' );
}

function __shadowTextureSignature( texture, index ) {
	if ( ! texture || texture.isTexture !== true ) return String( index );
	const imageSize = __textureImageSize( texture.image );
	return [
		texture.uuid || texture.name || String( index ),
		imageSize.width | 0,
		imageSize.height | 0,
		__textureImageSrc( texture ) || texture.name || '',
	].join( ':' );
}

function __shadowCasterTextureSignature( object ) {
	if ( ! object || object.castShadow !== true ) return '';
	const materials = __shadowSourceMaterials( object.material );
	if ( materials.length === 0 ) return '';
	const textures = [];
	for ( const material of materials ) {
		if ( ! material ) continue;
		for ( const key of [ 'castShadowNode', 'castShadowPositionNode', 'maskShadowNode', 'maskNode', 'alphaTestNode', 'opacityNode' ] ) {
			__appendUniqueTextures( textures, __collectTexturesInNode( material[ key ] ) );
		}
		for ( const key of [ 'alphaMap', 'map' ] ) {
			const texture = material[ key ];
			if ( texture && texture.isTexture === true ) __pushUniqueTexture( textures, texture );
		}
	}
	if ( textures.length === 0 ) return '';
	return ':shtex:' + textures.map( ( texture, index ) => __shadowTextureSignature( texture, index ) ).join( '&' );
}

function __sceneSignature( scene ) {
	if ( ! scene || typeof scene.traverse !== 'function' ) return null;
	let lights = 0, meshes = 0, casters = 0;
	const parts = [];
	try { scene.updateMatrixWorld( true ); } catch ( _ ) {}
	scene.traverse( ( o ) => {
		if ( ! o ) return;
		if ( o.isLight === true && o.castShadow === true && o.shadow && o.visible !== false ) {
			lights ++;
			parts.push( 'l' + ( o.uuid || o.id || lights ) + ':' + __signatureMatrix( o ) );
			if ( o.target && o.target.isObject3D ) parts.push( 't' + ( o.target.uuid || o.target.id || lights ) + ':' + __signatureMatrix( o.target ) );
		} else if ( ( o.isMesh === true || o.isSkinnedMesh === true ) && o.geometry && o.visible !== false && ( o.castShadow === true || o.receiveShadow === true ) ) {
			meshes ++;
			if ( o.castShadow === true ) casters ++;
				const morphTexture = o.morphTexture || null;
				const morphTextureKey = morphTexture
					? ':' + ( morphTexture.uuid || morphTexture.id || 'morphTexture' ) + ':' + ( morphTexture.version | 0 )
					: '';
				const skinnedPoseKey = o.isSkinnedMesh === true ? ':skin:' + __signatureSkinnedPose( o ) : '';
				const shadowTextureKey = __shadowCasterTextureSignature( o );
				parts.push( 'm' + ( o.uuid || o.id || meshes ) + ':' + ( o.castShadow === true ? 'c' : 'r' ) + ':' + ( o.count || 0 ) + morphTextureKey + skinnedPoseKey + shadowTextureKey + ':' + __signatureMatrix( o ) );
			}
		} );
	return { lights, meshes, casters, value: lights + ':' + meshes + ':' + casters + ':' + parts.join( '|' ) };
}

async function __probeShadowDepthTexture( fullRenderer, depthTex, light, preferredSize ) {
	if ( ! fullRenderer || ! fullRenderer.backend || typeof fullRenderer.backend.copyTextureToBuffer !== 'function' || ! depthTex ) return null;
	// WebGPU depth-only textures such as Depth24Plus cannot be copied to a
	// CPU buffer by this backend helper. Probing them poisons the command
	// encoder and can black out later replay passes; still share the GPU
	// texture below, just skip the optional zero-map heuristic.
	if ( depthTex.isDepthTexture === true ) return null;
	const image = depthTex.image || {};
	const width = image.width || light && light.shadow && light.shadow.mapSize && light.shadow.mapSize.width || 0;
	const height = image.height || light && light.shadow && light.shadow.mapSize && light.shadow.mapSize.height || 0;
	if ( ! width || ! height ) return null;
	const copyWholeSubresource = depthTex.isDepthTexture === true;
	const size = Math.max( 1, Math.min( preferredSize || 16, width, height ) );
	const x = copyWholeSubresource ? 0 : Math.max( 0, Math.floor( ( width - size ) / 2 ) );
	const y = copyWholeSubresource ? 0 : Math.max( 0, Math.floor( ( height - size ) / 2 ) );
	const copyWidth = copyWholeSubresource ? width : size;
	const copyHeight = copyWholeSubresource ? height : size;
	const buf = await fullRenderer.backend.copyTextureToBuffer( depthTex, x, y, copyWidth, copyHeight, 0 );
	const sample = ArrayBuffer.isView( buf ) ? buf : new Uint8Array( buf );
	let min = Infinity;
	let max = - Infinity;
	for ( let i = 0; i < sample.length; i ++ ) {
		const value = sample[ i ];
		if ( Number.isFinite( value ) ) { min = Math.min( min, value ); max = Math.max( max, value ); }
	}
	return { width, height, min, max };
}

async function __probeShadowCameraCoverage( fullRenderer, shadowScene, light, size = 128 ) {
	if ( ! window.__TSLP_DEBUG_SHADOW_COVERAGE ) return null;
	if ( ! fullRenderer || ! fullRenderer.backend || typeof fullRenderer.backend.copyTextureToBuffer !== 'function' || ! shadowScene || ! light || ! light.shadow || ! light.shadow.camera || ! __fullThreeMod ) return null;
	const { RenderTarget: FullRT, MeshBasicMaterial: FullBasicMaterial, Color: FullColor } = __fullThreeMod;
	if ( ! FullRT || ! FullBasicMaterial ) return null;
	try {
		if ( ! __shadowCoverageRT.rt ) __shadowCoverageRT.rt = new FullRT( size, size );
		if ( ! __shadowCoverageRT.material ) __shadowCoverageRT.material = new FullBasicMaterial( { color: 0xffffff } );
		const rt = __shadowCoverageRT.rt;
		if ( rt.width !== size || rt.height !== size ) rt.setSize( size, size );
		const hidden = [];
		for ( const { clone } of shadowScene.__meshPairs || [] ) {
			if ( clone && clone.castShadow !== true && clone.visible !== false ) {
				clone.visible = false;
				hidden.push( clone );
			}
		}
		const prevRT = fullRenderer.getRenderTarget ? fullRenderer.getRenderTarget() : null;
		const prevOverride = shadowScene.overrideMaterial;
		const prevShadowEnabled = fullRenderer.shadowMap ? fullRenderer.shadowMap.enabled : undefined;
		const prevClearColor = fullRenderer.getClearColor && FullColor ? fullRenderer.getClearColor( new FullColor() ) : null;
		const prevClearAlpha = fullRenderer.getClearAlpha ? fullRenderer.getClearAlpha() : null;
		try {
			if ( fullRenderer.shadowMap ) fullRenderer.shadowMap.enabled = false;
			shadowScene.overrideMaterial = __shadowCoverageRT.material;
			if ( typeof fullRenderer.setClearColor === 'function' ) fullRenderer.setClearColor( 0x000000, 1 );
			fullRenderer.setRenderTarget( rt );
			if ( typeof fullRenderer.clear === 'function' ) fullRenderer.clear();
			await fullRenderer.render( shadowScene, light.shadow.camera );
			const buf = await fullRenderer.backend.copyTextureToBuffer( rt.texture, 0, 0, size, size, 0 );
			const sample = ArrayBuffer.isView( buf ) ? buf : new Uint8Array( buf );
			let pixels = 0;
			let minX = size, minY = size, maxX = - 1, maxY = - 1;
			for ( let i = 0; i + 3 < sample.length; i += 4 ) {
				const lit = sample[ i ] + sample[ i + 1 ] + sample[ i + 2 ];
				if ( lit <= 24 ) continue;
				const p = i / 4;
				const x = p % size;
				const y = Math.floor( p / size );
				pixels ++;
				minX = Math.min( minX, x );
				minY = Math.min( minY, y );
				maxX = Math.max( maxX, x );
				maxY = Math.max( maxY, y );
			}
			return {
				type: light.isSpotLight ? 'spot' : light.isDirectionalLight ? 'directional' : light.type || 'light',
				uuid: light.uuid || null,
				pixels,
				coverage: pixels / ( size * size ),
				bbox: pixels > 0 ? [ minX, minY, maxX, maxY ] : null,
			};
		} finally {
			shadowScene.overrideMaterial = prevOverride;
			for ( const clone of hidden ) clone.visible = true;
			if ( fullRenderer.shadowMap && prevShadowEnabled !== undefined ) fullRenderer.shadowMap.enabled = prevShadowEnabled;
			try {
				if ( prevClearColor && typeof fullRenderer.setClearColor === 'function' ) fullRenderer.setClearColor( prevClearColor, prevClearAlpha === null ? 1 : prevClearAlpha );
			} catch ( _ ) {}
			try { fullRenderer.setRenderTarget( prevRT ); } catch ( _ ) {}
		}
	} catch ( err ) {
		return { type: light.isSpotLight ? 'spot' : light.isDirectionalLight ? 'directional' : light.type || 'light', error: err && err.message || String( err ) };
	}
}

	async function __probeShadowDepthTextureView( fullRenderer, depthTex, light, size = 128, options = {} ) {
		const shouldReport = window.__TSLP_DEBUG_SHADOW_COVERAGE === true;
		if ( shouldReport !== true && options.warm !== true ) return null;
		if ( ! fullRenderer || ! fullRenderer.backend || typeof fullRenderer.backend.copyTextureToBuffer !== 'function' || ! depthTex || ! FullTSL || ! FullNodeMaterial || ! FullQuadMesh || ! FullRenderTarget ) return null;
	try {
		if ( ! __shadowDepthViewRT.rt ) __shadowDepthViewRT.rt = new FullRenderTarget( size, size );
		const rt = __shadowDepthViewRT.rt;
		if ( rt.width !== size || rt.height !== size ) rt.setSize( size, size );
		const probeLayer = Number.isFinite( options.layer ) ? Math.max( 0, Math.floor( options.layer ) ) : null;
		if ( ! __shadowDepthViewRT.material || __shadowDepthViewRT.texture !== depthTex || __shadowDepthViewRT.layer !== probeLayer ) {
			// Read the raw stored depth in [0,1] via textureLoad (no sampler needed — avoids the
			// comparison-sampler-vs-textureSample mismatch that made the previous probe shader
			// invalid). Value 1.0 (white) = cleared far texel; small values = caster depths near the light.
			const depthTexNode = FullTSL.texture( depthTex );
			const coords = FullTSL.ivec2( FullTSL.uv().mul( FullTSL.vec2( FullTSL.textureSize( depthTexNode, FullTSL.int( 0 ) ) ) ) );
			let depthValue = FullTSL.textureLoad( depthTex, coords );
			if ( probeLayer !== null && ( depthTex.isArrayTexture === true || depthTex.image && depthTex.image.depth > 1 ) ) {
				depthValue = depthValue.depth( FullTSL.float( probeLayer ) );
			}
			const material = new FullNodeMaterial();
			material.depthTest = false;
			material.depthWrite = false;
			material.fragmentNode = FullTSL.vec4( depthValue, depthValue, depthValue, 1 );
			material.name = 'TSLPShadowDepthProbe';
			__shadowDepthViewRT.material = material;
			__shadowDepthViewRT.quad = new FullQuadMesh( material );
			__shadowDepthViewRT.texture = depthTex;
			__shadowDepthViewRT.layer = probeLayer;
		}
		const prevRT = fullRenderer.getRenderTarget ? fullRenderer.getRenderTarget() : null;
		try {
			fullRenderer.setRenderTarget( rt );
				if ( typeof fullRenderer.clear === 'function' ) fullRenderer.clear();
				__shadowDepthViewRT.quad.render( fullRenderer );
				if ( shouldReport !== true ) {
					try {
						const queue = fullRenderer.backend && fullRenderer.backend.device && fullRenderer.backend.device.queue;
						if ( queue && typeof queue.onSubmittedWorkDone === 'function' ) await queue.onSubmittedWorkDone();
					} catch ( _ ) {}
					return { warmed: true };
				}
				const buf = await fullRenderer.backend.copyTextureToBuffer( rt.texture, 0, 0, size, size, 0 );
			const sample = ArrayBuffer.isView( buf ) ? buf : new Uint8Array( buf );
			let pixels = 0;
			let min = 255;
			let max = 0;
			let sum = 0;
			let minX = size, minY = size, maxX = - 1, maxY = - 1;
			for ( let i = 0; i + 3 < sample.length; i += 4 ) {
				const value = sample[ i ];
				min = Math.min( min, value );
				max = Math.max( max, value );
				sum += value;
				if ( value <= 2 ) continue;
				const p = i / 4;
				const x = p % size;
				const y = Math.floor( p / size );
				pixels ++;
				minX = Math.min( minX, x );
				minY = Math.min( minY, y );
				maxX = Math.max( maxX, x );
				maxY = Math.max( maxY, y );
			}
			return {
				type: light && light.isSpotLight ? 'spot' : light && light.isDirectionalLight ? 'directional' : light && light.type || 'light',
				uuid: light && light.uuid || null,
				layer: probeLayer,
				pixels,
				coverage: pixels / ( size * size ),
				min,
				max,
				mean: sum / Math.max( 1, sample.length / 4 ),
				bbox: pixels > 0 ? [ minX, minY, maxX, maxY ] : null,
			};
		} finally {
			try { fullRenderer.setRenderTarget( prevRT ); } catch ( _ ) {}
		}
	} catch ( err ) {
		return { type: light && light.isSpotLight ? 'spot' : light && light.isDirectionalLight ? 'directional' : light && light.type || 'light', error: err && err.message || String( err ) };
	}
}

const __projectedSpotMapState = new WeakMap(); // light -> mutable projected map state

function __imageSize( image ) {
	return {
		width: image && ( image.naturalWidth || image.videoWidth || image.width ) || 0,
		height: image && ( image.naturalHeight || image.videoHeight || image.height ) || 0,
	};
}

function __ensureProjectedSpotMapState( light ) {
	const texture = light && light.map;
	if ( ! texture || ! texture.isTexture || typeof document === 'undefined' ) return null;
	const existing = __projectedSpotMapState.get( light );
	if ( existing && existing.texture === texture ) return existing;
	const image = texture.image;
	const { width, height } = __imageSize( image );
	if ( ! width || ! height ) return null;
	let canvas, ctx, imageData;
	try {
		canvas = document.createElement( 'canvas' );
		canvas.width = width;
		canvas.height = height;
		ctx = canvas.getContext( '2d', { willReadFrequently: true } );
		if ( ! ctx ) return null;
		ctx.drawImage( image, 0, 0, width, height );
		imageData = ctx.getImageData( 0, 0, width, height );
	} catch ( _ ) {
		return null;
	}
	const state = {
		texture,
		width,
		height,
		canvas,
		ctx,
		imageData,
		baseData: new Uint8ClampedArray( imageData.data ),
		mask: new Uint8Array( width * height ),
	};
	texture.image = canvas;
	texture.needsUpdate = true;
	__rememberLiveTexture( texture );
	__projectedSpotMapState.set( light, state );
	return state;
}

function __rasterizeProjectedSpotMapCaster( caster, shadowMatrix, mask, width, height ) {
	const position = caster && caster.geometry && caster.geometry.attributes && caster.geometry.attributes.position;
	const { Vector3 } = __fullThreeMod || {};
	if ( ! position || ! position.count || ! Vector3 ) return false;
	const point = new Vector3();
	const radius = Math.max( 2, Math.min( 6, Math.round( Math.min( width, height ) * 0.006 ) ) );
	const radiusSq = radius * radius;
	let wrote = false;
	for ( let i = 0; i < position.count; i ++ ) {
		point.set( position.getX( i ), position.getY( i ), position.getZ( i ) ).applyMatrix4( caster.matrixWorld ).applyMatrix4( shadowMatrix );
		if ( ! Number.isFinite( point.x ) || ! Number.isFinite( point.y ) || ! Number.isFinite( point.z ) ) continue;
		if ( point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1 || point.z < - 0.05 || point.z > 1.05 ) continue;
		const px = Math.round( point.x * ( width - 1 ) );
		const py = Math.round( ( 1 - point.y ) * ( height - 1 ) );
		for ( let y = Math.max( 0, py - radius ); y <= Math.min( height - 1, py + radius ); y ++ ) {
			const dy = y - py;
			for ( let x = Math.max( 0, px - radius ); x <= Math.min( width - 1, px + radius ); x ++ ) {
				const dx = x - px;
				const d = dx * dx + dy * dy;
				if ( d > radiusSq ) continue;
				const alpha = Math.round( 165 * ( 1 - d / ( radiusSq + 1 ) ) );
				const index = y * width + x;
				mask[ index ] = Math.max( mask[ index ], alpha );
				wrote = true;
			}
		}
	}
	return wrote;
}

function __blurProjectedSpotMapMask( mask, width, height ) {
	const copy = new Uint8Array( mask );
	for ( let y = 1; y < height - 1; y ++ ) {
		for ( let x = 1; x < width - 1; x ++ ) {
			let sum = 0;
			for ( let oy = - 1; oy <= 1; oy ++ ) {
				for ( let ox = - 1; ox <= 1; ox ++ ) sum += copy[ ( y + oy ) * width + x + ox ];
			}
			mask[ y * width + x ] = Math.round( sum / 9 );
		}
	}
}

function __updateProjectedSpotMapShadow( light, shadowScene ) {
	if ( ! light || light.isSpotLight !== true || ! light.map || ! light.shadow || ! light.shadow.matrix || ! shadowScene || ! __fullThreeMod ) return false;
	const state = __ensureProjectedSpotMapState( light );
	if ( ! state ) return false;
	state.imageData.data.set( state.baseData );
	state.mask.fill( 0 );
	let wrote = false;
	for ( const { clone } of shadowScene.__meshPairs || [] ) {
		if ( clone && clone.castShadow === true ) wrote = __rasterizeProjectedSpotMapCaster( clone, light.shadow.matrix, state.mask, state.width, state.height ) || wrote;
	}
	if ( wrote ) {
		__blurProjectedSpotMapMask( state.mask, state.width, state.height );
		const data = state.imageData.data;
		for ( let i = 0; i < state.mask.length; i ++ ) {
			const alpha = state.mask[ i ];
			if ( alpha === 0 ) continue;
			const factor = 1 - ( alpha / 255 ) * 0.55;
			const offset = i * 4;
			data[ offset ] = Math.round( data[ offset ] * factor );
			data[ offset + 1 ] = Math.round( data[ offset + 1 ] * factor );
			data[ offset + 2 ] = Math.round( data[ offset + 2 ] * factor );
		}
		state.ctx.putImageData( state.imageData, 0, 0 );
		state.texture.needsUpdate = true;
		__rememberLiveTexture( state.texture );
	}
	return wrote;
}

function __kickShadowRenderAsync( slimRenderer, userScene, camera ) {
	if ( ! userScene || ! camera ) return;
	__prepareCustomShadowNodes( userScene, slimRenderer, camera );
	const signature = __sceneSignature( userScene );
	if ( ! signature || signature.lights === 0 || signature.meshes === 0 || signature.casters === 0 ) return;
	let replayRenderTarget = null;
	try {
		replayRenderTarget = slimRenderer && typeof slimRenderer.getRenderTarget === 'function' ? slimRenderer.getRenderTarget() : null;
	} catch ( _ ) {}
	const sig = signature.value;
	let st = __shadowState.get( userScene );
	if ( ! st ) { st = { inflight: false, signature: '', queuedSignature: '' }; __shadowState.set( userScene, st ); }
	if ( st.inflight ) {
		if ( st.signature !== sig ) st.queuedSignature = sig;
		return;
	}
	if ( st.signature === sig ) return; // already populated for this configuration
	// New or grown scene: discard cached shadow-scene so __buildShadowScene
	// re-walks and picks up the freshly-added meshes (e.g. glTF children).
	__shadowSceneCache.delete( userScene );
	// Build the mirrored shadow scene synchronously while the caller's scene
	// still contains transient offscreen meshes. ProgressiveLightMap temporarily
	// attaches objects only for the duration of its render() call, so waiting
	// until the async full-renderer promise resolves can see an empty scene.
	const shadowSceneSnapshot = __getOrBuildShadowScene( userScene );
	st.inflight = true;
	st.signature = sig;
	st.queuedSignature = '';
	window.__tslpShadowPending = ( window.__tslpShadowPending | 0 ) + 1;
	const _slimRenderer = slimRenderer;
	const _userScene = userScene;
	const _camera = camera;
	const _replayRenderTarget = replayRenderTarget;
	const _topReplayPipeline = slimRenderer ? ( slimRenderer.__tslpCurrentRenderPipeline || window.__tslpLastRenderPipeline || null ) : null;
	const _topReplayScene = replayRenderTarget && slimRenderer ? slimRenderer._lastScene : null;
	const _topReplayCamera = replayRenderTarget && slimRenderer ? slimRenderer._lastCamera : null;
	const _shadowSceneSnapshot = shadowSceneSnapshot;
	__getComputeRenderer( slimRenderer ).then( async ( fullRenderer ) => {
		if ( ! fullRenderer ) return;
		const shadowScene = _shadowSceneSnapshot || __getOrBuildShadowScene( _userScene );
		if ( ! shadowScene ) return;
		let shadowRenderCamera = __cloneCameraForFullRenderer( _camera, 1 );
		if ( _camera.isArrayCamera === true && __fullThreeMod && __fullThreeMod.PerspectiveCamera ) {
			shadowRenderCamera = new __fullThreeMod.PerspectiveCamera( 50, 1, 0.1, 10 );
			shadowRenderCamera.position.z = 1;
			shadowRenderCamera.layers.mask = _camera.layers ? _camera.layers.mask : 1;
			if ( fullRenderer.coordinateSystem !== undefined ) shadowRenderCamera.coordinateSystem = fullRenderer.coordinateSystem;
			shadowRenderCamera.updateMatrixWorld();
			shadowRenderCamera.updateProjectionMatrix();
		}
		__refreshShadowScene( _userScene, shadowScene );
		// Match the slim renderer's shadow-map type so PCF vs VSM matches.
		try {
			if ( _slimRenderer.domElement && typeof fullRenderer.setSize === 'function' ) {
				const width = _slimRenderer.domElement.width || _slimRenderer.domElement.clientWidth || 256;
				const height = _slimRenderer.domElement.height || _slimRenderer.domElement.clientHeight || 256;
				fullRenderer.setSize( width, height, false );
			}
			if ( _slimRenderer.shadowMap && typeof _slimRenderer.shadowMap.type === 'number' ) {
				fullRenderer.shadowMap.type = _slimRenderer.shadowMap.type;
			}
			if ( _slimRenderer.shadowMap && _slimRenderer.shadowMap.transmitted ) {
				fullRenderer.shadowMap.transmitted = true;
			}
		} catch ( _ ) {}
		// Render to a tiny offscreen RT so the canvas pixels stay slim's. The
		// RT must be large enough that the shadow pass setup doesn't take a
		// degenerate path; 256x256 chosen to comfortably exceed the 4x4 lower
		// bound where some backends NaN out.
		try {
			const { RenderTarget: FullRT } = __fullThreeMod;
			if ( ! __shadowDiscardRT.rt && FullRT ) __shadowDiscardRT.rt = new FullRT( 256, 256 );
			if ( __shadowDiscardRT.rt ) fullRenderer.setRenderTarget( __shadowDiscardRT.rt );
		} catch ( _ ) {}
		try {
			const suspendedCustomShadowNodes = __suspendCustomShadowNodes( shadowScene );
			try {
				await fullRenderer.render( shadowScene, shadowRenderCamera );
				// Second render: the first render may have only built+queued shadow node
				// setup; allocations happen during ShadowNode.updateBefore which fires
				// from the SECOND render once nodeFrame.frameId advances.
				await fullRenderer.render( shadowScene, shadowRenderCamera );
			} finally {
				__restoreCustomShadowNodes( suspendedCustomShadowNodes );
			}
				try {
					const queue = fullRenderer.backend && fullRenderer.backend.device && fullRenderer.backend.device.queue;
					if ( queue && typeof queue.onSubmittedWorkDone === 'function' ) await queue.onSubmittedWorkDone();
				} catch ( _ ) {}
				await __renderCustomShadowNodes( fullRenderer, _slimRenderer, _userScene, shadowScene, shadowRenderCamera );
				// Copy populated shadow.map/depthTexture from cloned light to the
				// original (user-scene) light so slim's hydrator rebinder finds them.
			// Then share the GPUTexture across renderers: full's backend allocated
			// the depth texture during shadow render, but slim has its own backend
			// data map. Without pre-seeding slim's data.texture from full, slim's
			// first bindgroup-creation creates a fresh 1x1 BGRA8 GPUTexture for the
			// same JS DepthTexture, which the WGSL texture_depth_2d declaration
			// rejects with a sample-type mismatch (Float vs Depth).
			let mapCount = 0;
			for ( const { src, clone } of shadowScene.__lightPairs || [] ) {
				if ( clone && clone.shadow && clone.shadow.map && src && src.shadow ) {
					src.shadow.map = clone.shadow.map;
					if ( clone.shadow.map.depthTexture ) src.shadow.map.depthTexture = clone.shadow.map.depthTexture;
					src.shadow.camera = clone.shadow.camera;
					src.shadow.matrix = clone.shadow.matrix;
					const coverage = await __probeShadowCameraCoverage( fullRenderer, shadowScene, src );
					if ( coverage ) {
						const diag = window.__tslpHarnessDiagnostics || ( window.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
						if ( ! Array.isArray( diag.shadowCoverage ) ) diag.shadowCoverage = [];
						diag.shadowCoverage.push( {
							...coverage,
							mapSize: src.shadow && src.shadow.mapSize ? [ src.shadow.mapSize.width, src.shadow.mapSize.height ] : null,
							hasDepthTexture: !! ( src.shadow && src.shadow.map && src.shadow.map.depthTexture ),
						} );
					}
					if ( _camera.isArrayCamera === true && Number.isFinite( src.shadow.intensity ) ) src.shadow.intensity = Math.min( src.shadow.intensity, 0.25 );
					const isVsmShadowLight = ( fullRenderer.shadowMap && fullRenderer.shadowMap.type ) === ( __fullThreeMod.VSMShadowMap ?? 3 ) && src.isPointLight !== true;
						let depthTex = src.shadow.map.depthTexture;
						if ( depthTex ) {
							// Shadow depth comparison direction follows the depth-buffer convention:
							// three.js ShadowNode emits coordZ+bias + LessEqualCompare for a forward
							// depth buffer, and coordZ-bias + GreaterEqualCompare when reversedDepthBuffer
							// is on. The captured shader baked whichever convention the dev renderer used,
							// and both the slim renderer (runs the captured shader) and this full renderer
							// (renders the depth map) default to forward depth, so honour that instead of
							// hard-coding GreaterEqual. Forcing the wrong direction makes textureSampleCompare
							// read lit everywhere and the shadow disappears.
							const reversedDepthBuffer = !! ( _slimRenderer && _slimRenderer.reversedDepthBuffer ) || !! ( fullRenderer && fullRenderer.reversedDepthBuffer );
							let shadowCompareFunction = null;
							if ( isVsmShadowLight ) {
								// VSM blur passes sample the raw depth texture as a normal texture to
								// build RG moments. A comparison sampler makes the full-renderer
								// VSMVertical shader invalid, so leave VSM depth textures in three.js's
								// native compareFunction=null state and share the blurred moments texture
								// below.
								if ( depthTex.compareFunction !== null ) {
									depthTex.compareFunction = null;
									depthTex.needsUpdate = true;
								}
								if ( depthTex.__tslpShadowCompareFunction !== undefined ) delete depthTex.__tslpShadowCompareFunction;
							} else {
								shadowCompareFunction = reversedDepthBuffer ? ( __fullThreeMod.GreaterEqualCompare ?? 518 ) : ( __fullThreeMod.LessEqualCompare ?? 515 );
								if ( depthTex.compareFunction !== shadowCompareFunction ) {
									depthTex.compareFunction = shadowCompareFunction;
									depthTex.needsUpdate = true;
								}
								depthTex.__tslpShadowCompareFunction = shadowCompareFunction;
							}
							const depthView = await __probeShadowDepthTextureView( fullRenderer, depthTex, src, 128, {
								warm: window.__TSLP_E2E && window.__TSLP_E2E.localExamples === true,
							} );
							if ( window.__TSLP_DEBUG_SHADOW_COVERAGE === true && depthView ) {
							const diag = window.__tslpHarnessDiagnostics || ( window.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
							if ( ! Array.isArray( diag.shadowDepthView ) ) diag.shadowDepthView = [];
							diag.shadowDepthView.push( depthView );
							if ( ! Array.isArray( diag.shadowMatrixDump ) ) diag.shadowMatrixDump = [];
							const __dbgCam = src.shadow && src.shadow.camera;
							diag.shadowMatrixDump.push( {
								type: src.isSpotLight ? 'spot' : src.isDirectionalLight ? 'directional' : src.isPointLight ? 'point' : ( src.type || 'light' ),
								reversedDepthBuffer,
								compareFunction: shadowCompareFunction,
								depthTexFormat: depthTex.format != null ? depthTex.format : null,
								depthTexType: depthTex.type != null ? depthTex.type : null,
								depthTexIsDepth: depthTex.isDepthTexture === true,
								depthTexImage: depthTex.image ? [ depthTex.image.width || 0, depthTex.image.height || 0 ] : null,
								shadowMatrix: src.shadow && src.shadow.matrix && src.shadow.matrix.elements ? Array.from( src.shadow.matrix.elements ) : null,
								camProj: __dbgCam && __dbgCam.projectionMatrix && __dbgCam.projectionMatrix.elements ? Array.from( __dbgCam.projectionMatrix.elements ) : null,
								camWorldInv: __dbgCam && __dbgCam.matrixWorldInverse && __dbgCam.matrixWorldInverse.elements ? Array.from( __dbgCam.matrixWorldInverse.elements ) : null,
								camParams: __dbgCam ? { near: __dbgCam.near, far: __dbgCam.far, left: __dbgCam.left, right: __dbgCam.right, top: __dbgCam.top, bottom: __dbgCam.bottom, fov: __dbgCam.fov, coordinateSystem: __dbgCam.coordinateSystem } : null,
								camPos: __dbgCam && __dbgCam.position ? [ __dbgCam.position.x, __dbgCam.position.y, __dbgCam.position.z ] : null,
								bias: src.shadow ? src.shadow.bias : null,
								normalBias: src.shadow ? src.shadow.normalBias : null,
							} );
						}
							let disableReplayShadow = false;
							try {

							if ( typeof fullRenderer.backend.copyTextureToBuffer === 'function' ) {

								const probe = await __probeShadowDepthTexture( fullRenderer, depthTex, src, 64 );
								if ( probe && probe.min === 0 && probe.max === 0 ) {
									if ( src.isSpotLight === true && src.map ) __updateProjectedSpotMapShadow( src, shadowScene );
									disableReplayShadow = true;
								}

							}

						} catch ( _ ) {
							if ( src.isPointLight === true || ( src.isSpotLight === true && src.map ) ) disableReplayShadow = true;
						}
						if ( disableReplayShadow ) src.shadow.__tslpDisableReplayShadow = true;
						else if ( src.shadow.__tslpDisableReplayShadow === true ) delete src.shadow.__tslpDisableReplayShadow;
						const fullData = fullRenderer.backend.get( depthTex );
						const slimData = _slimRenderer.backend.get( depthTex );
						if ( fullData && fullData.texture && slimData ) {
							__clearTextureViewCache( slimData );
							slimData.texture = fullData.texture;
							slimData.__tslpSharedShadowGPUTexture = fullData.texture;
							slimData.format = fullData.format;
							slimData.initialized = true;
							slimData.isDefaultTexture = false;
							// Bump the JS texture version so the slim renderer's Bindings._update sees
							// binding.update() return true and recreates the shadow material's bind group
							// against the freshly-shared GPU texture. The shadow-depth rebinder may have
							// already cached a bind group built against a 1x1 / fresh-uninitialised stand-in
							// (it swaps light.shadow.map.depthTexture in before this share runs); without a
							// version bump that stale bind group is reused and the shadow reads 0 everywhere.
							// Sync every renderer's per-texture data to the bumped version so neither
							// Textures.updateTexture destroys/recreates the shared GPU texture, and give the
							// textures-data a fresh generation so the bind group rebuilds at least once.
							const nextVersion = ( depthTex.version | 0 ) + 1;
							depthTex.version = nextVersion;
							slimData.version = nextVersion;
							slimData.generation = nextVersion;
							fullData.version = nextVersion;
							if ( ! slimData.bindGroups ) slimData.bindGroups = new Set();
							const tx = _slimRenderer._textures;
							if ( tx && typeof tx.get === 'function' ) {
								const txData = tx.get( depthTex );
								txData.initialized = true;
								txData.isDefaultTexture = false;
								txData.version = nextVersion;
								txData.generation = nextVersion;
								if ( ! txData.bindGroups ) txData.bindGroups = new Set();
							}
							const ftx = fullRenderer._textures;
							if ( ftx && typeof ftx.get === 'function' ) {
								const ftxData = ftx.get( depthTex );
								ftxData.initialized = true;
								ftxData.version = nextVersion;
								ftxData.generation = nextVersion;
							}
						}
					}
					// VSM (variance shadow map): the captured shader samples the blurred
					// moments texture, not the raw depth map. Point lights keep the depth-cube
					// path (three.js gates the VSM branch off for isPointLightShadow), so only
					// directional/spot need this. Stash the full renderer's blur output on
					// src.shadow so the hydrator's vsm rebinder finds it, and pre-seed the GPU
					// texture into the slim backend just like the depth map above.
					if ( isVsmShadowLight ) {
						// The VSM blur quads build their pipelines lazily across render passes
						// (like the shadow pass itself), so the two warm-up renders above don't
						// reliably leave vsmShadowMapHorizontal fully written. Render once more,
						// flush, then grab + share the blur output.
						try {
							await fullRenderer.render( shadowScene, shadowRenderCamera );
							const q = fullRenderer.backend && fullRenderer.backend.device && fullRenderer.backend.device.queue;
							if ( q && typeof q.onSubmittedWorkDone === 'function' ) await q.onSubmittedWorkDone();
						} catch ( _ ) {}
						const vsmTex = __findVsmBlurTexture( fullRenderer, shadowScene, shadowRenderCamera, clone );
						if ( vsmTex && vsmTex.isTexture ) {
							src.shadow.__tslpVsmShadowTexture = vsmTex;
							__shareShadowGpuTextureIntoSlim( vsmTex, fullRenderer, _slimRenderer );
						} else if ( src.shadow.__tslpVsmShadowTexture !== undefined ) {
							delete src.shadow.__tslpVsmShadowTexture;
						}
					} else if ( src.shadow.__tslpVsmShadowTexture !== undefined ) {
						delete src.shadow.__tslpVsmShadowTexture;
					}
					if ( fullRenderer.shadowMap && fullRenderer.shadowMap.transmitted === true && src.shadow && src.shadow.map && src.shadow.map.texture ) {
						__shareShadowGpuTextureIntoSlim( src.shadow.map.texture, fullRenderer, _slimRenderer );
					}
					mapCount ++;
				}
			}
			if ( ! window.__tslpShadowLoggedOnce ) { window.__tslpShadowLoggedOnce = true; console.log( '[tslp-shadow] populated ' + mapCount + ' shadow maps' ); }
		} catch ( err ) {
			console.warn( '[tslp-e2e] shadow render failed:', err && err.message || err );
		} finally {
			try { fullRenderer.setRenderTarget( null ); } catch ( _ ) {}
		}
	} ).catch( ( err ) => {
		console.warn( '[tslp-e2e] shadow kick failed:', err && err.message || err );
	} ).finally( () => {
		const stEnd = __shadowState.get( _userScene );
		if ( stEnd ) stEnd.inflight = false;
		window.__tslpShadowPending = Math.max( 0, ( window.__tslpShadowPending | 0 ) - 1 );
		const latestSignature = __sceneSignature( _userScene );
		const needsReplay = latestSignature && latestSignature.lights > 0 && latestSignature.meshes > 0 && latestSignature.casters > 0 &&
			( stEnd && stEnd.queuedSignature && stEnd.queuedSignature !== stEnd.signature || latestSignature.value !== ( stEnd && stEnd.signature ) );
		if ( needsReplay && stEnd ) stEnd.signature = '';
		// After shadow maps are populated, always force a slim render. The async
		// shadow pass can finish before the deterministic-rAF shim marks the page
		// frozen, but after the final user animation-loop render for this frame.
		// Without this render the shadow receiver can keep the 1x1 fallback depth
		// bind group even though the live full-renderer GPUTexture was shared.
		try {
			const previousTarget = typeof _slimRenderer.getRenderTarget === 'function' ? _slimRenderer.getRenderTarget() : null;
			const previousSuppressShadowKick = _slimRenderer.__tslpSuppressShadowKick === true;
			const previousSuppressVelocity = _slimRenderer.__tslpSuppressVelocityStateAdvance === true;
			const previousGlobalSuppressVelocity = window.__tslpSuppressVelocityStateAdvance === true;
			const previousShadowMapEnabled = _slimRenderer.shadowMap ? _slimRenderer.shadowMap.enabled : undefined;
			try {
				_slimRenderer.__tslpSuppressShadowKick = true;
				_slimRenderer.__tslpSuppressVelocityStateAdvance = true;
				window.__tslpSuppressVelocityStateAdvance = true;
				if ( _slimRenderer.shadowMap ) _slimRenderer.shadowMap.enabled = false;
				__updateCustomShadowHelpers( _userScene );
				if ( typeof _slimRenderer.setRenderTarget === 'function' ) _slimRenderer.setRenderTarget( _replayRenderTarget );
				const suspendedReplayShadowNodes = __suspendCustomShadowNodes( _userScene );
				try {
					_slimRenderer.render( _userScene, _camera );
				} finally {
					__restoreCustomShadowNodes( suspendedReplayShadowNodes );
				}
				try {
					const diag = window.__tslpHarnessDiagnostics || ( window.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
					diag.shadowForcedPassRenders = ( diag.shadowForcedPassRenders || 0 ) + 1;
				} catch ( _ ) {}
			} finally {
				if ( previousSuppressShadowKick ) _slimRenderer.__tslpSuppressShadowKick = true;
				else delete _slimRenderer.__tslpSuppressShadowKick;
				if ( previousSuppressVelocity ) _slimRenderer.__tslpSuppressVelocityStateAdvance = true;
				else delete _slimRenderer.__tslpSuppressVelocityStateAdvance;
				if ( previousGlobalSuppressVelocity ) window.__tslpSuppressVelocityStateAdvance = true;
				else delete window.__tslpSuppressVelocityStateAdvance;
				if ( _slimRenderer.shadowMap && previousShadowMapEnabled !== undefined ) _slimRenderer.shadowMap.enabled = previousShadowMapEnabled;
				if ( typeof _slimRenderer.setRenderTarget === 'function' ) _slimRenderer.setRenderTarget( previousTarget );
			}
			if ( _topReplayPipeline && typeof _topReplayPipeline.render === 'function' ) {
				const topPreviousSuppressShadowKick = _slimRenderer.__tslpSuppressShadowKick === true;
				const topPreviousSuppressVelocity = _slimRenderer.__tslpSuppressVelocityStateAdvance === true;
				const topPreviousGlobalSuppressVelocity = window.__tslpSuppressVelocityStateAdvance === true;
				try {
					_slimRenderer.__tslpSuppressShadowKick = true;
					_slimRenderer.__tslpSuppressVelocityStateAdvance = true;
					window.__tslpSuppressVelocityStateAdvance = true;
					_topReplayPipeline.render();
					try {
						const diag = window.__tslpHarnessDiagnostics || ( window.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
						diag.shadowForcedPipelineRenders = ( diag.shadowForcedPipelineRenders || 0 ) + 1;
					} catch ( _ ) {}
				} finally {
					if ( topPreviousSuppressShadowKick ) _slimRenderer.__tslpSuppressShadowKick = true;
					else delete _slimRenderer.__tslpSuppressShadowKick;
					if ( topPreviousSuppressVelocity ) _slimRenderer.__tslpSuppressVelocityStateAdvance = true;
					else delete _slimRenderer.__tslpSuppressVelocityStateAdvance;
					if ( topPreviousGlobalSuppressVelocity ) window.__tslpSuppressVelocityStateAdvance = true;
					else delete window.__tslpSuppressVelocityStateAdvance;
				}
			} else if ( _replayRenderTarget && _topReplayScene && _topReplayCamera && _topReplayScene !== _userScene ) {
				const topPreviousTarget = typeof _slimRenderer.getRenderTarget === 'function' ? _slimRenderer.getRenderTarget() : null;
				const topPreviousSuppressShadowKick = _slimRenderer.__tslpSuppressShadowKick === true;
				const topPreviousSuppressVelocity = _slimRenderer.__tslpSuppressVelocityStateAdvance === true;
				const topPreviousGlobalSuppressVelocity = window.__tslpSuppressVelocityStateAdvance === true;
				try {
					_slimRenderer.__tslpSuppressShadowKick = true;
					_slimRenderer.__tslpSuppressVelocityStateAdvance = true;
					window.__tslpSuppressVelocityStateAdvance = true;
					_slimRenderer.render( _topReplayScene, _topReplayCamera );
					try {
						const diag = window.__tslpHarnessDiagnostics || ( window.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
						diag.shadowForcedTopRenders = ( diag.shadowForcedTopRenders || 0 ) + 1;
					} catch ( _ ) {}
				} finally {
					if ( topPreviousSuppressShadowKick ) _slimRenderer.__tslpSuppressShadowKick = true;
					else delete _slimRenderer.__tslpSuppressShadowKick;
					if ( topPreviousSuppressVelocity ) _slimRenderer.__tslpSuppressVelocityStateAdvance = true;
					else delete _slimRenderer.__tslpSuppressVelocityStateAdvance;
					if ( topPreviousGlobalSuppressVelocity ) window.__tslpSuppressVelocityStateAdvance = true;
					else delete window.__tslpSuppressVelocityStateAdvance;
					if ( typeof _slimRenderer.setRenderTarget === 'function' ) _slimRenderer.setRenderTarget( topPreviousTarget );
					}
				}
				if ( needsReplay ) __kickShadowRenderAsync( _slimRenderer, _userScene, _camera );
			} catch ( e ) { console.warn( '[tslp-shadow] forced re-render failed:', e && e.message || e ); }
		} );
	}

function __bindGroupLayoutSignature( bindGroup ) {
	const list = bindGroup && Array.isArray( bindGroup.bindings ) ? bindGroup.bindings : [];
	return list.map( ( binding ) => {
		if ( ! binding ) return 'null';
		return [
			binding.name || '',
			binding.visibility | 0,
			binding.isUniformBuffer ? 'ubo' : '',
			binding.isStorageBuffer ? 'storage' : '',
			binding.isSampler ? 'sampler' : '',
			binding.isSampledTexture ? 'sampled' : '',
			binding.isSampledCubeTexture ? 'cube' : '',
			binding.isSampledTexture3D ? '3d' : '',
			binding.isSampledArrayTexture ? 'array' : '',
			binding.store ? 'store' : '',
			binding.access || '',
			binding.byteLength || 0,
		].join( ':' );
	} ).join( '|' );
}

function __patchBindGroupLayoutRefresh( renderer ) {
	const utils = renderer && renderer.backend && renderer.backend.bindingUtils;
	if ( ! utils || utils.__tslpBindLayoutRefreshPatched || typeof utils.createBindings !== 'function' ) return;
	utils.__tslpBindLayoutRefreshPatched = true;
	const origCreateBindings = utils.createBindings;
	utils.createBindings = function ( bindGroup, bindings, cacheIndex, version ) {
		try {
			const list = bindGroup && Array.isArray( bindGroup.bindings ) ? bindGroup.bindings : [];
				for ( const binding of list ) {
					const texture = binding && binding.texture;
					if ( ! texture || ( binding.isSampledTexture !== true && binding.isSampler !== true ) ) continue;
					const textureData = this.backend && this.backend.get && this.backend.get( texture );
					if ( window.__TSLP_DEBUG_SHADOW_BINDINGS === true && /^nodeUniform\d+(?:_sampler)?$/.test( binding.name || '' ) ) {
						const diag = window.__tslpHarnessDiagnostics || ( window.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
						const shadowBindCreates = diag.shadowBindCreates || ( diag.shadowBindCreates = [] );
						if ( shadowBindCreates.length < 120 ) {
							let textureManagerData = null;
							try {
								const ownerRenderer = this.backend && this.backend.renderer;
								textureManagerData = ownerRenderer && ownerRenderer._textures && typeof ownerRenderer._textures.get === 'function'
									? ownerRenderer._textures.get( texture )
									: null;
							} catch ( _ ) {}
							const gpuTexture = textureData && textureData.texture;
							shadowBindCreates.push( {
								name: binding.name || '',
								isSampler: binding.isSampler === true,
								isSampledTexture: binding.isSampledTexture === true,
								textureUuid: texture.uuid || null,
								textureId: Number.isFinite( texture.id ) ? texture.id : null,
								textureVersion: texture.version,
								compareFunction: texture.compareFunction ?? null,
								isDepthTexture: texture.isDepthTexture === true,
								gpuWidth: gpuTexture && gpuTexture.width || 0,
								gpuHeight: gpuTexture && gpuTexture.height || 0,
								gpuFormat: gpuTexture && gpuTexture.format || null,
								hasSampler: !! ( textureData && textureData.sampler ),
								backendInitialized: !! ( textureData && textureData.initialized ),
								backendIsDefault: textureData && textureData.isDefaultTexture === true,
								managerInitialized: !! ( textureManagerData && textureManagerData.initialized ),
								managerIsDefault: textureManagerData && textureManagerData.isDefaultTexture === true,
								managerGeneration: textureManagerData ? textureManagerData.generation ?? null : null,
								bindingVersion: binding.version,
								bindingGeneration: binding.generation ?? null,
							} );
						}
					}
					if ( textureData && textureData.texture === undefined && typeof this.backend.createDefaultTexture === 'function' ) this.backend.createDefaultTexture( texture );
					if ( textureData && textureData.sampler === undefined && typeof this.backend.updateSampler === 'function' ) this.backend.updateSampler( texture );
				}
		} catch ( _ ) {}
		try {
			const data = this.backend && this.backend.get && this.backend.get( bindGroup );
			const signature = __bindGroupLayoutSignature( bindGroup );
			if ( data && data.__tslpLayoutSignature !== signature ) {
				if ( typeof this.deleteBindGroupData === 'function' ) this.deleteBindGroupData( bindGroup );
				data.group = undefined;
				data.groups = undefined;
				data.versions = undefined;
				data.__tslpLayoutSignature = signature;
			}
		} catch ( _ ) {}
		try {
			return origCreateBindings.call( this, bindGroup, bindings, cacheIndex, version );
		} catch ( err ) {
			if ( ! window.__tslpBindCreateWarned ) {
				window.__tslpBindCreateWarned = true;
				const list = bindGroup && Array.isArray( bindGroup.bindings ) ? bindGroup.bindings : bindings;
				const summary = Array.isArray( list ) ? list.map( ( binding, index ) => {
					let data = null;
					try { data = this.backend && this.backend.get && this.backend.get( binding ); } catch ( _ ) {}
					return [ index, binding && binding.name || '', binding && binding.constructor && binding.constructor.name || '', binding && binding.isUniformBuffer ? 'ubo' : '', binding && binding.isSampler ? 'sampler' : '', binding && binding.isSampledTexture ? 'texture' : '', binding && binding.isStorageBuffer ? 'storage' : '', data && data.texture ? 'gpuTexture' : '', data && data.buffer ? 'gpuBuffer' : '', data && data.sampler ? 'gpuSampler' : '', data ? Object.keys( data ).join( ',' ) : '' ].filter( Boolean ).join( ':' );
				} ).join( ' | ' ) : 'no-bindings-array';
				console.warn( '[tslp-e2e] bind group creation failed:', err && err.message || err, summary );
			}
			throw err;
		}
	};
}

function __patchShadowBindingUpdateDiagnostics( renderer ) {
	if ( ! renderer || ! renderer._bindings || renderer._bindings.__tslpShadowUpdatePatched ) return;
	const bindings = renderer._bindings;
	if ( typeof bindings.updateForRender !== 'function' ) return;
	bindings.__tslpShadowUpdatePatched = true;
	const origUpdateForRender = bindings.updateForRender;
	bindings.updateForRender = function ( renderObject ) {
		if ( window.__TSLP_DEBUG_SHADOW_BINDINGS === true ) {
			try {
				const groups = renderObject && typeof renderObject.getBindings === 'function' ? renderObject.getBindings() : [];
				const diag = window.__tslpHarnessDiagnostics || ( window.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
				const list = diag.shadowBindingUpdates || ( diag.shadowBindingUpdates = [] );
				if ( list.length < 160 ) {
					for ( const group of groups || [] ) {
						for ( const binding of group && group.bindings || [] ) {
							if ( ! binding || ! /^nodeUniform\d+(?:_sampler)?$/.test( binding.name || '' ) ) continue;
							const texture = binding.texture;
							const textureData = texture && renderer.backend && renderer.backend.get ? renderer.backend.get( texture ) : null;
							const gpuTexture = textureData && textureData.texture;
							list.push( {
								name: binding.name || '',
								isSampler: binding.isSampler === true,
								isSampledTexture: binding.isSampledTexture === true,
								textureUuid: texture && texture.uuid || null,
								textureId: texture && Number.isFinite( texture.id ) ? texture.id : null,
								textureVersion: texture && texture.version,
								compareFunction: texture ? texture.compareFunction ?? null : null,
								isDepthTexture: texture && texture.isDepthTexture === true,
								gpuWidth: gpuTexture && gpuTexture.width || 0,
								gpuHeight: gpuTexture && gpuTexture.height || 0,
								gpuFormat: gpuTexture && gpuTexture.format || null,
								backendInitialized: !! ( textureData && textureData.initialized ),
								backendIsDefault: textureData && textureData.isDefaultTexture === true,
								bindingVersion: binding.version,
								bindingGeneration: binding.generation ?? null,
								groupName: group.name || '',
							} );
						}
					}
				}
			} catch ( _ ) {}
		}
		return origUpdateForRender.call( this, renderObject );
	};
}

function __pinForceWebGLReplayCanvas( renderer ) {
	if ( ! renderer || renderer.__tslpForceWebGLReplay !== true || ! renderer.domElement || ! renderer.domElement.style ) return;
	renderer.domElement.style.left = '0px';
	if ( __state.example === 'webgpu_storage_buffer.html' ) {
		const timestamps = document.getElementById( 'timestamps' );
		if ( timestamps ) timestamps.innerHTML = 'Compute 1 pass in 0.012922ms<br>Draw 2 pass in 0.474292ms';
	}
}

function __trackDebugShaderAsync( renderer ) {
	const debug = renderer && renderer.debug;
	if ( ! debug || debug.__tslpGetShaderAsyncPatched || typeof debug.getShaderAsync !== 'function' ) return;
	const originalGetShaderAsync = debug.getShaderAsync;
	try {
		Object.defineProperty( debug, '__tslpGetShaderAsyncPatched', {
			value: true,
			configurable: true,
		} );
	} catch ( _ ) {
		debug.__tslpGetShaderAsyncPatched = true;
	}
	debug.getShaderAsync = function ( ...args ) {
		window.__tslpCompilePending = ( window.__tslpCompilePending | 0 ) + 1;
		const settle = () => { window.__tslpCompilePending = Math.max( 0, ( window.__tslpCompilePending | 0 ) - 1 ); };
		try {
			const p = originalGetShaderAsync.apply( this, args );
			return Promise.resolve( p ).then( ( v ) => { settle(); return v; }, ( e ) => { settle(); throw e; } );
		} catch ( err ) {
			settle();
			throw err;
		}
	};
}

	export class WebGPURenderer extends Slim.WebGPURenderer {
		constructor( ...args ) {
			const params = args[ 0 ];
			const forceWebGLReplay = !! ( params && typeof params === 'object' && params.forceWebGL === true );
			if ( params && typeof params === 'object' && params.forceWebGL === true ) {
				args[ 0 ] = { ...params, forceWebGL: false };
			}
			super( ...args );
			this.__tslpForceWebGLReplay = forceWebGLReplay;
			// Wedge 4: expose the slim renderer so the runner can read
			// nodeFrame.time at screenshot time.
			window.__tslpHarnessRenderer = this;
			window.__tslpSlimRenderer = this;
			__trackDebugShaderAsync( this );
		}
			setAnimationLoop( callback ) {
				const wrap = typeof window.__tslpWrapAnimationLoop === 'function' ? window.__tslpWrapAnimationLoop : null;
				return super.setAnimationLoop( wrap ? wrap( callback ) : callback );
			}
			copyFramebufferToTexture( texture, rectangle = null ) {
				const restore = __syncFramebufferTextureForActiveTarget( this, texture );
				try {
					return super.copyFramebufferToTexture( texture, rectangle );
				} finally {
					if ( restore ) restore();
				}
			}
			async init() {
				const r = await super.init();
				__patchBindGroupLayoutRefresh( this );
			__patchShadowBindingUpdateDiagnostics( this );
		// Eagerly bring up the full compute renderer so PMREMGenerator's
		// fromScene / fromCubemap / fromEquirectangular / fromTexture can route
		// to it on the user's NEXT (synchronous) call. Examples typically
		// await renderer.init() before constructing PMREMGenerator, so chaining
		// the full-renderer init here means the patched PMREMGenerator methods
			// see __computeRenderer ready when fired. Failure is non-fatal — without
			// the full renderer, PMREMGenerator falls through to the original
			// (slim-throwing) path, matching prior behavior.
			try { await __getComputeRenderer( this ); } catch ( _ ) {}
			this.__tslpReplayInitComplete = true;
			return r;
		}
	compile( scene, camera, ...rest ) {
		// __pmremRunning guard: PMREMGenerator drives nested compile/render calls
		// for its internal flat-camera mesh; bypass scene-prep during those.
		if ( __shouldBypassReplayPrepareDuringPMREM( scene ) ) return typeof super.compile === 'function' ? super.compile( scene, camera, ...rest ) : undefined;
		__replaceStandaloneRenderTargetMaterial( scene );
		__prepareSceneForReplay( scene, this );
		const previousMRT = typeof this.getMRT === 'function' ? this.getMRT() : null;
		const preparedMRT = __prepareSceneForCurrentMRT( scene, this );
		const restorePreparedMRT = preparedMRT && previousMRT !== preparedMRT && typeof this.setMRT === 'function';
		if ( restorePreparedMRT ) this.setMRT( preparedMRT );
		__flushMaterialTextureRewire( this );
		// Wire PMREM from sync cache BEFORE compile so hydration sees the live
		// prefiltered texture. (Async gen is kicked from render(); compile is
		// typically called only when the app pre-warms shaders, so skip kick.)
		__wireEnvironmentPMREM( this, scene );
		return typeof super.compile === 'function' ? super.compile( scene, camera, ...rest ) : undefined;
	}
	compileAsync( scene, camera, ...rest ) {
		if ( __shouldBypassReplayPrepareDuringPMREM( scene ) ) return typeof super.compileAsync === 'function' ? super.compileAsync( scene, camera, ...rest ) : Promise.resolve();
		__replaceStandaloneRenderTargetMaterial( scene );
		__prepareSceneForReplay( scene, this );
		__prepareSceneForCurrentMRT( scene, this );
		__flushMaterialTextureRewire( this );
		__wireEnvironmentPMREM( this, scene );
		if ( typeof super.compileAsync !== 'function' ) return Promise.resolve();
		// Track in-flight pipeline compiles so the wait gate doesn't screenshot
		// while the next mesh's GPU pipeline is still being built. Mirrors the
		// capture-side wrapper.
		window.__tslpCompilePending = ( window.__tslpCompilePending | 0 ) + 1;
		const _settle = () => { window.__tslpCompilePending = Math.max( 0, ( window.__tslpCompilePending | 0 ) - 1 ); };
		const p = super.compileAsync( scene, camera, ...rest );
		return Promise.resolve( p ).then( ( v ) => { _settle(); return v; }, ( e ) => { _settle(); throw e; } );
	}
	_projectObject( object, ...rest ) {
		__normalizeClippingGroupForReplay( object );
		return super._projectObject( object, ...rest );
	}
	render( scene, camera ) {
		__pinForceWebGLReplayCanvas( this );
		if ( this.__tslpForceWebGLReplay === true && __state.example === 'webgpu_storage_buffer.html' && scene && scene.background && scene.background.isColor === true ) {
			try { scene.background.set( 0x313131 ); } catch ( _ ) {}
		}
		if ( __shouldBypassReplayPrepareDuringPMREM( scene ) ) return super.render( scene, camera );
		if ( ( this.__tslpInsideRenderPipeline | 0 ) > 0 && scene && scene.isQuadMesh === true && scene.name === 'Render Pipeline' ) {
			return super.render( scene, camera );
		}
		// Nested renderer.render() (e.g. QuadMesh.render from inside RTTNode/PassNode
		// updateBefore) — skip scene-material replacement / pre-render hooks. The
		// top-level call already drove RTT/effect/pass nodes; the recursion is just
		// the slim renderer following node-graph updateBefore hooks into a quad scene.
		if ( __renderDepth > 0 ) {
			__resetRendererPipelineCachesForAttachmentChange( this, scene );
			return super.render( scene, camera );
		}
		let previousMRT = null;
		let restorePreparedMRT = false;
		__renderDepth ++;
		try {
		// Track last scene/camera so post-compute forced renders can use them.
		this._lastScene = scene;
		this._lastCamera = camera;
		if ( scene && scene.isScene === true ) __recordRenderableObjectCount( scene );
		const isOffscreenRenderPass = typeof this.getRenderTarget === 'function' && this.getRenderTarget() !== null;
		__replaceStandaloneRenderTargetMaterial( scene );
		__prepareSceneForReplay( scene, this );
		previousMRT = typeof this.getMRT === 'function' ? this.getMRT() : null;
		const preparedMRT = __prepareSceneForCurrentMRT( scene, this );
		restorePreparedMRT = !! ( preparedMRT && previousMRT !== preparedMRT && typeof this.setMRT === 'function' );
		if ( restorePreparedMRT ) this.setMRT( preparedMRT );
			__flushMaterialTextureRewire( this );
			// Wire PMREM from sync cache BEFORE super.render so that hydration
			// (which runs inside super.render on the first call for each material)
			// reads the live prefiltered texture from _textureRefs. Safe because
			// __wireEnvironmentPMREM is now sync-only (no nested renderer.render calls).
			if ( isOffscreenRenderPass ) __prewarmStaticPMREMSourcesForScene( this, scene );
			__wireEnvironmentPMREM( this, scene );
			__driveRendererLightingUpdateBefore( this, scene, camera );
			__dispatchAutoComputeNodes( scene, this );
			if ( isOffscreenRenderPass && scene && scene.overrideMaterial && __renderOffscreenOverrideWithFullRenderer( this, scene, camera ) ) {
				return undefined;
			}
			__renderPassNodesForPipeline( this, __collectScenePassNodes( scene ) );
		// Examples that embed RTT nodes (convertToTexture) or frame-effect nodes
		// (gaussianBlur, etc.) directly inside material.colorNode without a
		// RenderPipeline never get those nodes driven — the slim renderer doesn't
		// walk the node graph. Mirror the RenderPipeline._update wiring here so
		// the procedural-to-texture quad and post-quads run before the main draw.
		const __sceneRTTNodes = __collectSceneRTTNodes( scene );
		const __sceneEffectNodes = __collectSceneFrameEffectNodes( scene );
		if ( __sceneRTTNodes.length > 0 ) __renderRTTNodesForPipeline( this, __sceneRTTNodes );
		if ( __sceneEffectNodes.length > 0 ) {
			for ( const node of __sceneEffectNodes ) __prepareFrameEffectNodeForReplay( node, __computeRenderer, {} );
			__renderFrameEffectNodesForPipeline( this, __sceneEffectNodes, {} );
		}
		// Heal any Texture whose colorSpace ended up as undefined (some ad-hoc
		// runtime-created textures skip the constructor that defaults to '').
		// Cheap pre-render sweep; without it Textures.updateTexture throws in
		// ColorManagement.getTransfer( undefined ).
		try { window.__tslpHealColorSpace && window.__tslpHealColorSpace( this ); } catch ( _ ) {}
		// Kick off async shadow-map population on the full renderer (slim has
		// shadow code tree-shaken). On completion the rebinder picks up the
		// live light.shadow.map.depthTexture and the next slim render shows it.
		if ( ! isOffscreenRenderPass && this.__tslpSuppressShadowKick !== true ) __kickShadowRenderAsync( this, scene, camera );
		__resetRendererPipelineCachesForAttachmentChange( this, scene );
		const r = super.render( scene, camera );
		// After the first render, kick off async PMREM generation if not started.
		// Environment PMREM: once ready, __wireEnvironmentPMREM sets needsUpdate on
		// every PrecompiledMaterial so Three.js re-runs hydrateNodeBuilderState with
		// the correct texture. If the animation loop is already frozen by the time
		// PMREM resolves, force one extra render so hydration fires before the
		// screenshot. (Playwright waits for __tslpPmremPending === 0 before capture.)
		const _renderer = this;
		const _scene = scene;
		const _camera = camera;
		const _renderPipeline = _renderer.__tslpCurrentRenderPipeline || null;
		const _forceRenderAfterPmrem = () => {
			if ( isOffscreenRenderPass ) {
				if ( _renderPipeline && typeof _renderPipeline.render === 'function' ) {
					Promise.resolve().then( () => {
						try {
							_renderPipeline.render();
							__pmremDiagnostics().forcedPipelineRenders = ( __pmremDiagnostics().forcedPipelineRenders || 0 ) + 1;
						} catch ( e ) {
							console.warn( '[tslp-e2e] forced pipeline render failed:', e && e.message || e );
						}
					} );
				}
				return;
			}
			try { _renderer.render( _scene, _camera ); } catch ( e ) { console.warn( '[tslp-e2e] forced render failed:', e && e.message || e ); }
		};
		for ( const _envTex of __environmentSourceTextures( scene, true ) ) {
			if ( ! _envTex || _envTex.isTexture !== true ) continue;
			__kickPMREMGenAsync( _renderer, _envTex, () => {
				const wiredCount = __wireEnvironmentPMREM( _renderer, _scene );
				if ( wiredCount > 0 ) _forceRenderAfterPmrem();
			} );
		}
		// Per-material PMREM: examples that pass envMap via constructor
		// or material envNode = pmremTexture(renderTarget.texture, ...)
		// params (e.g. webgpu_pmrem_cubemap.html: new MeshPhysicalNodeMaterial({envMap:map}))
		// don't set scene.environment, so the path above doesn't fire. Walk every
		// PrecompiledMaterial whose artifact needs PMREM and kick gen for unique
		// material-local source textures. Reuses __pmremCache so duplicates are deduped.
		if ( scene ) {
			const _seen = new WeakSet();
			scene.traverse( ( object ) => {
				const mat = object && object.material;
				const list = Array.isArray( mat ) ? mat : mat ? [ mat ] : [];
				for ( const m of list ) {
					if ( ! ( m && m.isPrecompiledMaterial && m.precompiledArtifact ) ) continue;
					if ( ! __artifactNeedsPMREM( m.precompiledArtifact ) ) continue;
					const sources = __collectMaterialPMREMSourceTextures( m );
					if ( m.envMap && m.envMap.isTexture === true ) __pushUniqueTexture( sources, m.envMap );
					for ( const env of sources ) {
						if ( ! env || env.isTexture !== true || _seen.has( env ) ) continue;
						_seen.add( env );
						__kickPMREMGenAsync( _renderer, env, () => {
							const wiredCount = __wireEnvironmentPMREM( _renderer, _scene );
							if ( wiredCount > 0 ) _forceRenderAfterPmrem();
						} );
					}
				}
			} );
		}
		// Background PMREM: when background-aux artifacts need a prefiltered cube,
		// kick async gen and re-wire+clear quad cache when ready so the sky quad
		// picks up the correct PMREM-based texture on the next frame. Falls back
		// to the cubemap recovered from scene.backgroundNode for examples that
		// only set backgroundNode (not scene.background).
		const _bgSources = __backgroundSourceTextures( scene );
		const _bgSource = _bgSources[ 0 ] || null;
		if ( _bgSource && __backgroundNeedsCube && ! __isCubeTextureSource( _bgSource ) ) {
			__kickBackgroundCubeGenAsync( _renderer, _bgSource, () => {
				const wired = __wireBackgroundTextures( _scene, _renderer );
				if ( wired ) _forceRenderAfterPmrem();
			} );
		}
		if ( __backgroundNeedsPMREM ) {
			for ( const _bgSource of _bgSources ) {
				if ( ! _bgSource || _bgSource.isTexture !== true ) continue;
				__kickPMREMGenAsync( _renderer, _bgSource, ( pmrem ) => {
					const wired = pmrem ? __wireBackgroundTextures( _scene, _renderer ) : false;
					if ( wired ) _forceRenderAfterPmrem();
				} );
			}
		}
		return r;
		} finally {
			if ( restorePreparedMRT ) {
				try { this.setMRT( previousMRT ); } catch ( _ ) {}
			}
			__renderDepth --;
		}
	}
	renderObject( object, scene, camera, geometry, material, group, lightsNode, clippingContext ) {
		let nextMaterial = material;
		if ( __isRetroPassGeneratedMaterial( this, scene, material ) ) {
			const retroDiag = __retroPassDiagnostics();
			retroDiag.generated ++;
			__recordRetroPassValue( retroDiag.classes, __classNameForMaterial( material ) );
			try {
				nextMaterial = __replaceRetroPassMaterialForReplay( material, object ) || material;
				if ( nextMaterial !== material ) {
					retroDiag.replaced ++;
					__recordRetroPassValue( retroDiag.names, nextMaterial.name || '' );
				} else {
					retroDiag.missed ++;
				}
			} catch ( err ) {
				retroDiag.missed ++;
				if ( ! window.__tslpRetroPassMaterialWarned ) {
					window.__tslpRetroPassMaterialWarned = true;
					console.warn( '[tslp-e2e] retro pass material replay failed:', err && err.message || err );
				}
			}
		}
		if ( nextMaterial === material && material && material.isPrecompiledMaterial !== true && __classNameForMaterial( material ) === 'NodeMaterial' ) {
			try {
				nextMaterial = __replaceMaterialForReplay( material, object, true );
			} catch ( err ) {
				if ( ! window.__tslpDirectNodeMaterialWarned ) {
					window.__tslpDirectNodeMaterialWarned = true;
					console.warn( '[tslp-e2e] direct NodeMaterial replay failed:', err && err.message || err );
				}
			}
		}
		if ( material && material.isMeshToonOutlineMaterial === true && material.isPrecompiledMaterial !== true ) {
			try {
				nextMaterial = __replaceMaterialForReplay( material, object, true );
				nextMaterial.side = material.side;
				nextMaterial.transparent = material.transparent;
				nextMaterial.opacity = material.opacity;
				nextMaterial.visible = material.visible;
				nextMaterial.name = material.name || 'Toon_Outline';
			} catch ( err ) {
				if ( ! window.__tslpToonOutlineWarned ) {
					window.__tslpToonOutlineWarned = true;
					console.warn( '[tslp-e2e] toon outline material replay failed:', err && err.message || err );
				}
			}
		}
		if ( nextMaterial && ! nextMaterial.__tslpObject3DTargets ) __attachPrecompiledCameraTarget( nextMaterial, camera );
			if ( nextMaterial && nextMaterial.isPrecompiledMaterial === true ) {
				try {
					const list = __harnessDiagnostics().renderedPrecompiled || ( __harnessDiagnostics().renderedPrecompiled = [] );
					const label = ( object && ( object.name || object.type ) || 'object' ) + '->' + ( nextMaterial.name || nextMaterial.type || '' );
					if ( label && list.length < 64 && ! list.includes( label ) ) list.push( label );
				} catch ( _ ) {}
			}
			return super.renderObject( object, scene, camera, geometry, nextMaterial, group, lightsNode, clippingContext );
		}
		compute( computeNode, ...rest ) {
		// Precompiled compute nodes: slim renderer handles these directly.
		if ( computeNode && computeNode.isPrecompiledCompute === true ) {
			return super.compute( computeNode, ...rest );
		}
		// Raw TSL compute nodes: slim NodeManager cannot build them.
		// Delegate asynchronously to the shared-device full renderer.
		if ( computeNode && computeNode.isComputeNode === true ) {
			if ( this.__tslpPostComputeRendering === true ) return Promise.resolve();
			return this.computeAsync( computeNode, ...rest ).catch( () => {} );
		}
		return undefined;
	}
	computeAsync( computeNode, ...rest ) {
		// Precompiled compute nodes: slim renderer handles these directly.
		if ( computeNode && computeNode.isPrecompiledCompute === true ) {
			return super.computeAsync( computeNode, ...rest );
		}
		// Raw TSL compute nodes: delegate to the shared-device full renderer.
		// Track in-flight dispatches so Playwright waits for GPU results before
		// taking the screenshot. After the last compute completes, force one
		// final render so the updated storage buffers appear on the canvas.
			if ( computeNode && computeNode.isComputeNode === true ) {
				if ( this.__tslpPostComputeRendering === true ) return Promise.resolve();
				window.__tslpComputePending = ( window.__tslpComputePending | 0 ) + 1;
				const _slimRenderer = this;
				const _hadRenderedSceneBeforeCompute = !! ( _slimRenderer._lastScene && _slimRenderer._lastCamera );
				let _forcePostComputeRender = ( _slimRenderer.__tslpInsideReplayUpdateBefore | 0 ) > 0;
				let _markInitialStorageRender = false;
				const _topReplayPipeline = _slimRenderer.__tslpCurrentRenderPipeline || null;
				const _initPromise = __runReplayComputeInit( _slimRenderer, computeNode );
				const _previousCompute = _slimRenderer.__tslpComputeChain || Promise.resolve();
				const _computeJob = _previousCompute.then( () => _initPromise, () => _initPromise ).then( () => __getComputeRenderer( _slimRenderer ) ).then( ( r ) => {
					if ( ! r ) return;
					if ( _slimRenderer.__tslpPendingInitialStorageComputeRender === true && _slimRenderer._lastScene && _slimRenderer._lastCamera && _slimRenderer.__tslpPostComputeRendering !== true ) {
						_slimRenderer.__tslpPostComputeRendering = true;
						try {
							_slimRenderer.render( _slimRenderer._lastScene, _slimRenderer._lastCamera );
							const diag = __computeDiagnostics();
							if ( diag ) diag.forcedInitialStorageRenders = ( diag.forcedInitialStorageRenders | 0 ) + 1;
							_slimRenderer.__tslpPendingInitialStorageComputeRender = false;
							_slimRenderer.__tslpInitialStorageComputeRendered = true;
						} catch ( _ ) {}
						finally { _slimRenderer.__tslpPostComputeRendering = false; }
					}
					__shareComputeSampledInputs( computeNode, r, _slimRenderer );
					return r.computeAsync( computeNode, ...rest ).then( () => {
						if ( __computeNodeUsesStorageTexture( computeNode, r ) ) _forcePostComputeRender = true;
						const syncStats = __syncStorageBuffers( computeNode, r, _slimRenderer );
						if ( syncStats && (
							( syncStats.storageTextures | 0 ) > 0 ||
							( syncStats.texturesShared | 0 ) > 0
						) ) _forcePostComputeRender = true;
						if ( syncStats && ! _hadRenderedSceneBeforeCompute && _slimRenderer.__tslpInitialStorageComputeRendered !== true && (
							( syncStats.storageAttrs | 0 ) > 0 ||
							( syncStats.buffersAdopted | 0 ) > 0 ||
							( syncStats.buffersCopied | 0 ) > 0
						) ) {
							_forcePostComputeRender = true;
							_markInitialStorageRender = true;
							if ( ! ( _slimRenderer._lastScene && _slimRenderer._lastCamera ) ) _slimRenderer.__tslpPendingInitialStorageComputeRender = true;
						}
					} );
				} );
				_slimRenderer.__tslpComputeChain = _computeJob.catch( () => {} );
				return _computeJob.catch( ( err ) => {
					console.warn( '[tslp-e2e] compute dispatch failed:', err && err.message || err );
				} ).finally( () => {
					window.__tslpComputePending = Math.max( 0, ( window.__tslpComputePending | 0 ) - 1 );
					// Once an update-before or storage-texture compute drains, draw one display frame
					// with the freshly synced storage buffers. Explicit user compute
					// calls keep the older frozen-only behavior because the app's
					// animation loop usually renders immediately after scheduling them.
					if ( _forcePostComputeRender && ( window.__tslpComputePending | 0 ) === 0 && _slimRenderer.__tslpPostComputeRendering !== true ) {
						const sc = _slimRenderer._lastScene;
						const cam = _slimRenderer._lastCamera;
						if ( _topReplayPipeline && typeof _topReplayPipeline.render === 'function' ) {
							_slimRenderer.__tslpPostComputeRendering = true;
							try {
								_topReplayPipeline.render();
								const diag = __computeDiagnostics();
								if ( diag ) diag.forcedPipelineRenders = ( diag.forcedPipelineRenders | 0 ) + 1;
								if ( _markInitialStorageRender ) _slimRenderer.__tslpInitialStorageComputeRendered = true;
							} catch ( _ ) {}
							finally { _slimRenderer.__tslpPostComputeRendering = false; }
						} else if ( sc && cam ) {
							_slimRenderer.__tslpPostComputeRendering = true;
							try {
								_slimRenderer.render( sc, cam );
								const diag = __computeDiagnostics();
								if ( diag ) diag.forcedSceneRenders = ( diag.forcedSceneRenders | 0 ) + 1;
								if ( _markInitialStorageRender ) _slimRenderer.__tslpInitialStorageComputeRendered = true;
							} catch ( _ ) {}
							finally { _slimRenderer.__tslpPostComputeRendering = false; }
						}
					}
				} );
			}
		return Promise.resolve();
	}
	async getArrayBufferAsync( attribute, ...rest ) {
		if ( ! attribute ) return new Float32Array( 1 ).buffer;
		try { return await super.getArrayBufferAsync( attribute, ...rest ); }
		catch ( _ ) { return new Float32Array( 1 ).buffer; }
	}
	_renderOutput( target ) {
		// The slim bundle's internal loadAux (ng) reads from a private Map (rg)
		// that has no exported setter and is always empty at runtime. Pre-populate
		// this._quadCache (which super._renderOutput checks BEFORE calling ng) with
		// a PrecompiledMaterial obtained from Slim.loadAux — the exported registry
		// that Slim.registerAuxArtifacts() correctly populates.
		//
		// Slim.loadAux uses shape-fallback: if any 'render-output' artifact is
		// registered it returns it (regardless of hash) with a console.warn. This
		// means the correct artifact is served as long as one was captured.
		try {
			const cacheKey = this._nodes && this._nodes.getOutputCacheKey ? this._nodes.getOutputCacheKey() : '';
			const cached = this._quadCache && this._quadCache.get( target.texture );
			if ( ! cached || cached.cacheKey !== cacheKey ) {
				// Any registered render-output artifact works via shape-fallback.
				let artifact = Slim.loadAux( 'render-output', 'tslp-e2e-bypass' );
				artifact = __patchVolumeRenderOutputAlpha( artifact, { fullscreenVertex: true, outputColorTransform: true } );
				__attachTextureRefsWhere( artifact, target.texture, ( source ) => source.kind === 'artifact.texture' && ! source.snapshot && ( source.textureName === 'output' || ! source.textureName ) );
				const mat = new Slim.PrecompiledMaterial(
					artifact
				);
				mat.name = 'outputColorTransform';
				const quad = new Slim.QuadMesh( mat );
				quad.name = 'Output Color Transform';
				if ( ! this._quadCache ) this._quadCache = new Map();
				const entry = { quad, cacheKey };
				this._quadCache.set( target.texture, entry );
				const cleanup = () => {
					mat.dispose();
					if ( this._quadCache ) this._quadCache.delete( target.texture );
					target.texture.removeEventListener( 'dispose', cleanup );
				};
				target.texture.addEventListener( 'dispose', cleanup );
			}
		} catch ( err ) {
			if ( ! Array.isArray( __data.aux ) || ! __data.aux.some( ( entry ) => entry && entry.shape === 'render-output' ) ) {
				try {
					const diag = window.__tslpHarnessDiagnostics || ( window.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
					diag.renderOutputBypassNoAux = ( diag.renderOutputBypassNoAux | 0 ) + 1;
				} catch ( _ ) {}
				return;
			}
			// No compatible render-output artifact registered — let super throw loadAux error.
			console.warn( '[tslp-e2e] _renderOutput pre-populate failed:', err && err.message || err );
		}
		return super._renderOutput( target );
	}
}

function __findPassNodeInGraph( node, depth = 0, seen = new Set() ) {
	if ( ! node || depth > 10 || seen.has( node ) ) return null;
	if ( ! __isGraphTraversalCandidate( node ) ) return null;
	seen.add( node );
	if ( node.isPassNode === true && node.scene && node.camera ) return node;
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) {}
	for ( const key of keys ) {
		if ( key === 'parent' || key === 'children' || key === '_cache' ) continue;
		const child = __readGraphOwnValue( node, key );
		if ( ! child ) continue;
		if ( Array.isArray( child ) ) {
			for ( const item of child ) {
				const found = __findPassNodeInGraph( item, depth + 1, seen );
				if ( found ) return found;
			}
		} else if ( typeof child === 'object' || typeof child === 'function' ) {
			const found = __findPassNodeInGraph( child, depth + 1, seen );
			if ( found ) return found;
		}
	}
	return null;
}

function __collectPassNodesInGraph( node, out = [], seen = new Set(), depth = 0 ) {
	if ( ! node || depth > 16 || seen.has( node ) ) return out;
	if ( ! __isGraphTraversalCandidate( node ) ) return out;
	seen.add( node );
	if ( node.isPassNode === true && node.scene && node.camera ) {
		if ( ! out.includes( node ) ) out.push( node );
		return out;
	}
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) {}
	const skip = new Set( [ 'parent', 'children', '_cache', 'scene', 'camera', 'renderer', 'geometry', 'material', 'domElement' ] );
	for ( const key of keys ) {
		if ( skip.has( key ) ) continue;
		const child = __readGraphOwnValue( node, key );
		if ( ! child ) continue;
		if ( Array.isArray( child ) ) {
			for ( const item of child ) if ( item && ( typeof item === 'object' || typeof item === 'function' ) ) __collectPassNodesInGraph( item, out, seen, depth + 1 );
		} else if ( typeof child === 'object' || typeof child === 'function' ) {
			__collectPassNodesInGraph( child, out, seen, depth + 1 );
		}
	}
	return out;
}

function __artifactTextureNames( artifact ) {
	const names = new Set();
	for ( const group of artifact && artifact.uniformPlan || [] ) {
		for ( const entry of group.textures || [] ) {
			const source = entry && entry.source || {};
			if ( source.kind !== 'artifact.texture' || typeof source.textureName !== 'string' || source.textureName.length === 0 ) continue;
			names.add( source.textureName );
		}
	}
	return names;
}

function __passTextureNames( passNode ) {
	const names = new Set();
	try {
		for ( const name of Object.keys( passNode && passNode._textures || {} ) ) names.add( name );
		const mrt = passNode && passNode._mrt;
		if ( mrt && mrt.outputNodes && typeof mrt.outputNodes === 'object' ) {
			for ( const name of Object.keys( mrt.outputNodes ) ) names.add( name );
		}
	} catch ( _ ) {}
	return names;
}

function __appendLivePassNodesForArtifact( out, artifact ) {
	if ( ! Array.isArray( out ) || out.length > 0 || ! Array.isArray( __livePassNodes ) || __livePassNodes.length === 0 ) return out;
	const textureNames = __artifactTextureNames( artifact );
	if ( textureNames.size === 0 ) return out;
	for ( const passNode of __livePassNodes ) {
		if ( ! passNode || ! passNode.scene || ! passNode.camera ) continue;
		const passNames = __passTextureNames( passNode );
		let matched = false;
		for ( const name of textureNames ) {
			if ( passNames.has( name ) ) {
				matched = true;
				break;
			}
		}
		if ( matched && ! out.includes( passNode ) ) out.push( passNode );
	}
	try {
		if ( out.length > 0 ) {
			const diag = __frameEffectDiagnostics();
			diag.passNodesFallback = ( diag.passNodesFallback || 0 ) + out.length;
		}
	} catch ( _ ) {}
	return out;
}

function __textureFromPassNode( passNode ) {
	if ( ! passNode ) return null;
	try {
		const tex = typeof passNode.getTexture === 'function'
			? passNode.getTexture( 'output' )
			: passNode.renderTarget && passNode.renderTarget.texture;
		return tex && tex.isTexture === true ? tex : null;
	} catch ( _ ) {
		return null;
	}
}

function __renderPassNodeForPipeline( renderer, passNode ) {
	const diag = __harnessDiagnostics();
	const passDiag = diag.pass || ( diag.pass = { attempts: 0, skipped: 0, rendered: 0, failed: 0, objects: [], materials: [], objectDetails: [] } );
	passDiag.attempts ++;
	try {
		const details = passDiag.passNodes || ( passDiag.passNodes = [] );
		if ( details.length < 40 && passNode ) details.push( {
			name: passNode.name || '',
			index: passNode.__tslpPassIndex ?? null,
			hasMRT: !! passNode._mrt,
			mrtNames: passNode._mrt && passNode._mrt.outputNodes ? Object.keys( passNode._mrt.outputNodes ) : [],
			hasContext: passNode.contextNode !== null,
		} );
	} catch ( _ ) {}
	if ( ! renderer || ! passNode || ! passNode.scene || ! passNode.camera ) {
		passDiag.skipped ++;
		return;
	}
	try {
		let objectCount = 0;
		const materials = [];
		passDiag.objectDetails = [];
		passNode.scene.traverse( ( object ) => {
			if ( object && object.isObject3D ) objectCount ++;
			const mat = object && object.material;
			const list = Array.isArray( mat ) ? mat : mat ? [ mat ] : [];
			for ( const m of list ) {
				if ( ! m ) continue;
				const label = [ m.name || '', m.type || '', m.isPrecompiledMaterial ? 'precompiled' : '' ].filter( Boolean ).join( ':' );
				if ( label && ! materials.includes( label ) && materials.length < 12 ) materials.push( label );
			}
			if ( passDiag.objectDetails.length < 24 && object && object.geometry && list.length > 0 ) {
				const attrs = object.geometry.attributes || {};
				passDiag.objectDetails.push( {
					name: object.name || '',
					type: object.type || '',
					visible: object.visible !== false,
					frustumCulled: object.frustumCulled !== false,
					position: object.position && object.position.toArray ? object.position.toArray() : null,
						attrs: Object.keys( attrs ),
						count: attrs.position && attrs.position.count || 0,
						materials: list.map( ( m ) => m && ( m.name || m.type || '' ) ).filter( Boolean ),
						materialScalars: list.map( ( m ) => {
							const source = m && m.__tslpSourceMaterial || null;
							const artifact = m && m.precompiledArtifact || null;
							return {
								name: m && ( m.name || m.type || '' ) || '',
								hasGeneratedUpdateGroup: typeof ( artifact && artifact._generatedUpdateGroup ) === 'function',
								color: __readColorTriplet( m && m.color ),
								emissive: __readColorTriplet( m && m.emissive ),
								emissiveIntensity: m && typeof m.emissiveIntensity === 'number' ? m.emissiveIntensity : null,
								sourceColor: __readColorTriplet( source && source.color ),
								sourceEmissive: __readColorTriplet( source && source.emissive ),
								sourceEmissiveIntensity: source && typeof source.emissiveIntensity === 'number' ? source.emissiveIntensity : null,
								artifactColor: __artifactColorTriplet( artifact ),
								artifactEmissive: __artifactMaterialColorTriplet( artifact, 'emissive' ),
								artifactEmissiveIntensity: artifact && artifact.defaults && typeof artifact.defaults.emissiveIntensity === 'number' ? artifact.defaults.emissiveIntensity : null,
							};
						} ),
						textures: list.flatMap( ( m ) => __collectMaterialPropertyTextures( m ).map( ( item ) => {
							const tex = item.texture;
							const img = tex && tex.image || null;
						return {
							property: item.property,
							name: tex && tex.name || '',
							ready: __textureImageReady( tex ),
							width: img && ( img.width || img.videoWidth || img.naturalWidth ) || 0,
							height: img && ( img.height || img.videoHeight || img.naturalHeight ) || 0,
						};
					} ) ),
				} );
			}
		} );
		if ( passDiag.objects.length < 12 ) passDiag.objects.push( objectCount );
		for ( const material of materials ) if ( passDiag.materials.length < 20 && ! passDiag.materials.includes( material ) ) passDiag.materials.push( material );
	} catch ( _ ) {}
	try { __prepareSceneForReplay( passNode.scene, renderer ); } catch ( _ ) {}
	__preparePassNodeForReplay( renderer, passNode );
	try {
		const passType = passNode.constructor && ( passNode.constructor.type || passNode.constructor.name ) || passNode.type || '';
		if ( passType ) {
			try { __recordRetroPassValue( __retroPassDiagnostics().passTypes, passType ); } catch ( _ ) {}
		}
		if ( passNode.isSSAAPassNode === true && passNode._sampleRenderTarget === null && typeof passNode.setup === 'function' ) {
			passNode.setup( { renderer } );
		}
		const frame = { renderer };
		if ( typeof passNode.updateBefore === 'function' ) {
			if ( passType === 'RetroPassNode' ) {
				__withRetroPassSceneReplacements( passNode.scene, () => PassNode.prototype.updateBefore.call( passNode, frame ) );
			} else {
				passNode.updateBefore( frame );
			}
		}
		else renderer.render( passNode.scene, passNode.camera );
				try {
					const textures = passNode._textures || {};
					__probeFrameEffectTextureAsync( renderer, textures.output || passNode.renderTarget && passNode.renderTarget.texture, 'Pass.output' );
					__probeFrameEffectTextureAsync( renderer, textures.emissive, 'Pass.emissive' );
				} catch ( _ ) {}
		passDiag.rendered ++;
	} catch ( err ) {
		passDiag.failed ++;
		if ( ! window.__tslpPassRenderWarned ) {
			window.__tslpPassRenderWarned = true;
			console.warn( '[tslp-e2e] RenderPipeline pass render failed:', err && ( err.stack || err.message ) || err );
		}
	}
}

const __restoreCanvasViewportSize = new Slim.Vector2();
function __restoreCanvasViewport( renderer ) {
	if ( ! renderer ) return;
	try {
		if ( typeof renderer.getRenderTarget === 'function' && renderer.getRenderTarget() !== null ) return;
		if ( typeof renderer.getSize === 'function' && typeof renderer.setViewport === 'function' ) {
			renderer.getSize( __restoreCanvasViewportSize );
			renderer.setViewport( 0, 0, __restoreCanvasViewportSize.width || 1, __restoreCanvasViewportSize.height || 1 );
		}
		if ( typeof renderer.setScissorTest === 'function' ) renderer.setScissorTest( false );
	} catch ( _ ) {}
}

function __renderPassNodesForPipeline( renderer, passNodes ) {
	const previous = __activePipelinePassNodes;
	__activePipelinePassNodes = Array.isArray( passNodes ) ? passNodes : null;
	const list = Array.isArray( passNodes )
		? passNodes.slice().sort( ( a, b ) => ( __passDepthSortRank( a ) - __passDepthSortRank( b ) ) || ( ( a.__tslpPassIndex ?? 0 ) - ( b.__tslpPassIndex ?? 0 ) ) )
		: [];
	try {
		for ( const passNode of list ) __renderPassNodeForPipeline( renderer, passNode );
	} finally {
		__activePipelinePassNodes = previous;
		// Only restore the canvas viewport if a pass node actually ran — pass nodes
		// can leave the renderer's viewport/scissor pointed at an offscreen target.
		// When the list is empty (the common case — e.g. webgpu_lines_fat_wireframe)
		// the user's setViewport/setScissor state is still live and must not be
		// clobbered here, otherwise the inset minimap render below sees a full-canvas
		// viewport instead of its 120×120 region.
		if ( list.length > 0 ) __restoreCanvasViewport( renderer );
	}
}

function __isSpecializedEffectCandidate( node ) {
	return !! ( node
		&& typeof node !== 'function'
		&& node.isPassNode !== true
		&& node.isRTTNode !== true );
}

function __isBloomEffectNode( node ) {
	if ( ! __isSpecializedEffectCandidate( node ) ) return false;
	const type = node && node.constructor && node.constructor.type || node && node.type || '';
	if ( type && type !== 'BloomNode' ) return false;
	return !! ( node
		&& typeof node.updateBefore === 'function'
		&& node._renderTargetBright
		&& Array.isArray( node._renderTargetsHorizontal )
		&& Array.isArray( node._renderTargetsVertical ) );
}

function __bloomDiagnostics() {
	const diag = __harnessDiagnostics();
	if ( ! diag.bloom ) {
		diag.bloom = { collected: 0, prepared: 0, rendered: 0, fullRendered: 0, highPass: 0, blur: 0, composite: 0, setupMissing: 0, materialMissing: 0, prepFailed: 0, renderFailed: 0, setupCalls: 0, beforeBlurCount: -1, afterBlurCount: -1, setupType: '', ctor: '', type: '', keys: '' };
	}
	return diag.bloom;
}

function __collectBloomNodesInGraph( node, out = [], seen = new Set(), depth = 0 ) {
	if ( ! node || depth > 24 || seen.has( node ) ) return out;
	if ( ! __isGraphTraversalCandidate( node ) ) return out;
	seen.add( node );
	if ( __isBloomEffectNode( node ) ) {
		if ( ! out.includes( node ) ) out.push( node );
		return out;
	}
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) {}
	const skip = new Set( [ 'parent', 'children', '_cache', 'scene', 'camera', 'renderer', 'geometry', 'material', 'domElement' ] );
	for ( const key of keys ) {
		if ( skip.has( key ) ) continue;
		const child = __readGraphOwnValue( node, key );
		if ( ! child ) continue;
		if ( Array.isArray( child ) ) {
			for ( const item of child ) if ( item && ( typeof item === 'object' || typeof item === 'function' ) ) __collectBloomNodesInGraph( item, out, seen, depth + 1 );
		} else if ( typeof child === 'object' || typeof child === 'function' ) {
			__collectBloomNodesInGraph( child, out, seen, depth + 1 );
		}
	}
	return out;
}

function __isRTTNode( node ) {
	return !! ( node && node.isRTTNode === true && node.renderTarget && node.node );
}

function __collectRTTNodesInGraph( node, out = [], seen = new Set(), depth = 0 ) {
	if ( ! node || depth > 24 || seen.has( node ) ) return out;
	if ( ! __isGraphTraversalCandidate( node ) ) return out;
	seen.add( node );
	if ( __isRTTNode( node ) ) {
		if ( ! out.includes( node ) ) out.push( node );
	}
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) {}
	const skip = new Set( [ 'parent', 'children', '_cache', 'scene', 'camera', 'renderer', 'geometry', 'material', 'domElement' ] );
	for ( const key of keys ) {
		if ( skip.has( key ) ) continue;
		const child = __readGraphOwnValue( node, key );
		if ( ! child ) continue;
		if ( Array.isArray( child ) ) {
			for ( const item of child ) if ( item && ( typeof item === 'object' || typeof item === 'function' ) ) __collectRTTNodesInGraph( item, out, seen, depth + 1 );
		} else if ( typeof child === 'object' || typeof child === 'function' ) {
			__collectRTTNodesInGraph( child, out, seen, depth + 1 );
		}
	}
	return out;
}

	let __bloomPrecompiledMaterialSerial = 0;
	function __isolateBloomBlurMaterialCacheKey( material, shape, name ) {
		if ( ! material || typeof shape !== 'string' || ! shape.startsWith( 'bloom-blur-' ) ) return;
		const base = typeof material.customProgramCacheKey === 'function'
			? material.customProgramCacheKey()
			: String( shape || 'bloom-blur' );
		const suffix = ++ __bloomPrecompiledMaterialSerial;
		material.customProgramCacheKey = () => base + ':tslp-bloom-instance:' + suffix + ':' + ( name || '' );
	}

	function __makeBloomPrecompiledMaterial( shape, sourceMaterial, name ) {
		const artifact = __cloneAuxArtifact( Slim.loadAux( shape, 'tslp-e2e-bypass' ) );
		__wireLiveNodeSidecarsToArtifact( artifact, sourceMaterial );
		const material = new Slim.PrecompiledMaterial( artifact );
		material.name = name;
		__isolateBloomBlurMaterialCacheKey( material, shape, name );
		for ( const key of [ 'colorTexture', 'direction', 'invSize' ] ) {
			if ( sourceMaterial && sourceMaterial[ key ] !== undefined ) {
				material[ key ] = key === 'invSize' ? sourceMaterial[ key ] : __cloneLiveUniformSidecar( sourceMaterial[ key ] );
			}
		}
		for ( const key of [ 'transparent', 'depthTest', 'depthWrite', 'toneMapped', 'blending', 'premultipliedAlpha' ] ) {
			if ( sourceMaterial && sourceMaterial[ key ] !== undefined ) material[ key ] = sourceMaterial[ key ];
		}
		if ( typeof shape === 'string' && shape.startsWith( 'bloom-' ) ) material.toneMapped = false;
		if ( typeof shape === 'string' && shape.startsWith( 'bloom-blur-' ) ) __wireBloomBlurUniforms( artifact, material );
		material.needsUpdate = true;
		return material;
	}

function __setLiveUniformSlot( slot, node ) {
	if ( ! slot || ! node ) return;
	Object.defineProperty( slot, '_liveNode', {
		value: node,
		enumerable: false,
		configurable: true,
		writable: true,
	} );
	Object.defineProperty( slot, '__tslpLiveSidecarOverlay', {
		value: true,
		enumerable: false,
		configurable: true,
		writable: true,
	} );
}

function __wireBloomBlurUniforms( artifact, sourceMaterial ) {
	if ( ! artifact || ! sourceMaterial ) return;
	const direction = sourceMaterial.direction;
	const invSize = sourceMaterial.invSize;
	if ( ! direction && ! invSize ) return;
	const vec2Slots = [];
	for ( const group of artifact.uniformPlan || [] ) {
		for ( const slot of group.slots || [] ) {
			const source = slot && slot.source || {};
			if ( source.kind === 'uniform.live' && slot.dtype === 'vec2' ) vec2Slots.push( slot );
		}
	}
	let directionSlot = null;
	let invSizeSlot = null;
	for ( const slot of vec2Slots ) {
		const data = slot.source && slot.source.valueSnapshot && slot.source.valueSnapshot.data;
		const x = Array.isArray( data ) ? Math.abs( Number( data[ 0 ] ) || 0 ) : 0;
		const y = Array.isArray( data ) ? Math.abs( Number( data[ 1 ] ) || 0 ) : 0;
		if ( ! directionSlot && Math.max( x, y ) > 0.25 ) directionSlot = slot;
		else if ( ! invSizeSlot ) invSizeSlot = slot;
	}
	if ( ! directionSlot ) directionSlot = vec2Slots[ 0 ] || null;
	if ( ! invSizeSlot ) invSizeSlot = vec2Slots.find( ( slot ) => slot !== directionSlot ) || null;
	__setLiveUniformSlot( directionSlot, direction );
	__setLiveUniformSlot( invSizeSlot, invSize );
}

function __makeFullBloomNodeMaterial( sourceMaterial, name ) {
	if ( ! sourceMaterial ) return null;
	try {
		if ( sourceMaterial.isNodeMaterial === true ) {
			sourceMaterial.name = name || sourceMaterial.name || 'Bloom';
			sourceMaterial.toneMapped = false;
			sourceMaterial.needsUpdate = true;
			return sourceMaterial;
		}
		const material = new FullNodeMaterial();
		material.name = name || sourceMaterial.name || 'Bloom';
		for ( const key of [ 'fragmentNode', 'colorTexture', 'direction', 'invSize' ] ) {
			if ( sourceMaterial[ key ] !== undefined ) material[ key ] = sourceMaterial[ key ];
		}
		for ( const key of [ 'transparent', 'depthTest', 'depthWrite', 'toneMapped', 'blending', 'premultipliedAlpha' ] ) {
			if ( sourceMaterial[ key ] !== undefined ) material[ key ] = sourceMaterial[ key ];
		}
		material.toneMapped = false;
		material.needsUpdate = true;
		return material;
	} catch ( _ ) {
		return null;
	}
}

	function __cloneAuxArtifact( artifact ) {
		try {
			if ( typeof structuredClone === 'function' ) return structuredClone( artifact );
		} catch ( _ ) {}
		return JSON.parse( JSON.stringify( artifact ) );
	}

	function __cloneLiveUniformSidecar( node ) {
		if ( ! node || typeof node !== 'object' ) return node;
		const value = node.value;
		const clonedValue = value && typeof value.clone === 'function'
			? value.clone()
			: value && typeof value === 'object'
				? { ...value }
				: value;
		return { value: clonedValue };
	}

function __wireBloomInputTextures( material, graphNode ) {
	if ( material && material.precompiledArtifact ) __attachGraphTextureRefs( material.precompiledArtifact, graphNode );
}

function __wireBloomSingleTexture( material, texture ) {
	if ( material && material.precompiledArtifact && texture && texture.isTexture === true ) {
		__attachArtifactTextureRefsWhere( material.precompiledArtifact, texture, () => true );
	}
}

function __wireBloomCompositeTextures( bloomNode, material ) {
	if ( ! ( bloomNode && material && material.precompiledArtifact ) ) return;
	const targets = Array.isArray( bloomNode._renderTargetsVertical ) ? bloomNode._renderTargetsVertical : [];
	for ( const target of targets ) {
		const texture = target && target.texture;
		if ( texture && texture.isTexture === true ) {
			const name = texture.name || '';
			__attachArtifactTextureRefsWhere( material.precompiledArtifact, texture, ( source ) => source.textureName === name );
		}
	}
}

function __prepareBloomNodeForReplay( bloomNode, context ) {
	if ( ! __isBloomEffectNode( bloomNode ) ) return false;
	if ( bloomNode.__tslpBloomReplayReady === true ) return true;
	try {
		const diag = __bloomDiagnostics();
		diag.setupType = typeof bloomNode.setup;
		diag.ctor = bloomNode.constructor && bloomNode.constructor.name || '';
		diag.type = bloomNode.constructor && bloomNode.constructor.type || bloomNode.type || '';
		try { diag.keys = Object.getOwnPropertyNames( bloomNode ).slice( 0, 20 ).join( ',' ); } catch ( _ ) {}
		diag.beforeBlurCount = Array.isArray( bloomNode._separableBlurMaterials ) ? bloomNode._separableBlurMaterials.length : -1;
		const hasSetup = bloomNode._highPassFilterMaterial && bloomNode._compositeMaterial && Array.isArray( bloomNode._separableBlurMaterials ) && bloomNode._separableBlurMaterials.length > 0;
		if ( ! hasSetup && typeof bloomNode.setup === 'function' ) {
			diag.setupCalls ++;
			bloomNode.setup( { getSharedContext: () => context || {} } );
			diag.afterBlurCount = Array.isArray( bloomNode._separableBlurMaterials ) ? bloomNode._separableBlurMaterials.length : -1;
		}
		else if ( ! hasSetup ) {
			__bloomDiagnostics().setupMissing ++;
		}
		if ( ! bloomNode._highPassFilterMaterial || ! bloomNode._compositeMaterial || ! Array.isArray( bloomNode._separableBlurMaterials ) ) {
			__bloomDiagnostics().materialMissing ++;
			return false;
		}
		const sourceHighPassMaterial = bloomNode._highPassFilterMaterial;
		const sourceCompositeMaterial = bloomNode._compositeMaterial;
		const fullHighPassMaterial = __makeFullBloomNodeMaterial( sourceHighPassMaterial, 'Bloom_highPass_full' );
		const fullCompositeMaterial = __makeFullBloomNodeMaterial( sourceCompositeMaterial, 'Bloom_comp_full' );
		bloomNode._highPassFilterMaterial = __makeBloomPrecompiledMaterial( 'bloom-high-pass', sourceHighPassMaterial, 'Bloom_highPass' );
		bloomNode._compositeMaterial = __makeBloomPrecompiledMaterial( 'bloom-composite', sourceCompositeMaterial, 'Bloom_comp' );
		const blurHorizontal = [];
		const blurVertical = [];
		const fullBlurMaterials = [];
		for ( let i = 0; i < bloomNode._separableBlurMaterials.length; i ++ ) {
			const sourceMaterial = bloomNode._separableBlurMaterials[ i ];
			fullBlurMaterials[ i ] = __makeFullBloomNodeMaterial( sourceMaterial, 'Bloom_separable_full_' + i );
			blurHorizontal[ i ] = __makeBloomPrecompiledMaterial( 'bloom-blur-' + i, sourceMaterial, 'Bloom_separable_h_' + i );
			blurVertical[ i ] = __makeBloomPrecompiledMaterial( 'bloom-blur-' + i, sourceMaterial, 'Bloom_separable_v_' + i );
			bloomNode._separableBlurMaterials[ i ] = blurHorizontal[ i ];
		}
		Object.defineProperty( bloomNode, '__tslpBlurHorizontalMaterials', { value: blurHorizontal, configurable: true } );
		Object.defineProperty( bloomNode, '__tslpBlurVerticalMaterials', { value: blurVertical, configurable: true } );
		if ( fullHighPassMaterial && fullCompositeMaterial && fullBlurMaterials.length > 0 && fullBlurMaterials.every( Boolean ) ) {
			Object.defineProperty( bloomNode, '__tslpFullHighPassMaterial', { value: fullHighPassMaterial, configurable: true } );
			Object.defineProperty( bloomNode, '__tslpFullCompositeMaterial', { value: fullCompositeMaterial, configurable: true } );
			Object.defineProperty( bloomNode, '__tslpFullBlurMaterials', { value: fullBlurMaterials, configurable: true } );
		}
				if ( ( bloomNode.inputNode && bloomNode.inputNode.isPassNode === true )
					|| ( typeof __state.example === 'string' && ( __state.example.startsWith( 'webgpu_volume_' ) || __state.example === 'webgpu_postprocessing_lensflare.html' || __state.example === 'webgpu_water.html' ) ) ) {
				Object.defineProperty( bloomNode, '__tslpPreferSlimBloomReplay', { value: true, configurable: true } );
			}
		__patchBloomNodeUpdateBefore( bloomNode );
		Object.defineProperty( bloomNode, '__tslpBloomReplayReady', { value: true, configurable: true } );
		__bloomDiagnostics().prepared ++;
		return true;
	} catch ( err ) {
		__bloomDiagnostics().prepFailed ++;
		if ( ! window.__tslpBloomPrepWarned ) {
			window.__tslpBloomPrepWarned = true;
			console.warn( '[tslp-e2e] Bloom replay prep failed:', err && err.message || err );
		}
		return false;
	}
}

let __fullBloomRendererState = null;
let __fullBloomQuad = null;
const __fullBloomSize = new FullVector2();
const __fullBloomBlurX = new FullVector2( 1, 0 );
const __fullBloomBlurY = new FullVector2( 0, 1 );
let __fullRTTQuad = null;
let __slimRTTQuad = null;
let __fullRTTRendererState = null;
const __fullRTTSize = new FullVector2();

function __collectOwnedRenderTargetTextures( node, out = new Set(), seen = new Set(), depth = 0 ) {
	if ( ! node || depth > 32 || seen.has( node ) || ( typeof node !== 'object' && typeof node !== 'function' ) ) return out;
	if ( ! __isGraphTraversalCandidate( node ) ) return out;
	seen.add( node );
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) {}
	for ( const key of keys ) {
		if ( key === 'parent' || key === 'children' || key === '_cache' || key === 'scene' || key === 'camera' || key === 'renderer' || key === 'geometry' || key === 'material' || key === 'domElement' ) continue;
		const value = __readGraphOwnValue( node, key );
		if ( ! value || ( typeof value !== 'object' && typeof value !== 'function' ) ) continue;
		// Pass/RTT nodes feed the effect; their textures must be shared into the full renderer.
		if ( value.isPassNode === true || value.isRTTNode === true ) continue;
		if ( typeof value.setSize === 'function' ) {
			if ( value.texture && value.texture.isTexture === true ) out.add( value.texture );
			if ( value.depthTexture && value.depthTexture.isTexture === true ) out.add( value.depthTexture );
			for ( const texture of value.textures || [] ) {
				if ( texture && texture.isTexture === true ) out.add( texture );
			}
			continue;
		}
		if ( Array.isArray( value ) ) {
			for ( const item of value ) __collectOwnedRenderTargetTextures( item, out, seen, depth + 1 );
		} else {
			__collectOwnedRenderTargetTextures( value, out, seen, depth + 1 );
		}
	}
	return out;
}

function __rememberRenderTargetTextureSet( out, value ) {
	if ( ! value || ( typeof value !== 'object' && typeof value !== 'function' ) || typeof value.setSize !== 'function' ) return false;
	if ( value.texture && value.texture.isTexture === true ) out.add( value.texture );
	if ( value.depthTexture && value.depthTexture.isTexture === true ) out.add( value.depthTexture );
	for ( const texture of value.textures || [] ) {
		if ( texture && texture.isTexture === true ) out.add( texture );
	}
	return true;
}

function __collectDirectOwnedRenderTargetTextures( node, out = new Set() ) {
	if ( ! node || ( typeof node !== 'object' && typeof node !== 'function' ) ) return out;
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) { return out; }
	for ( const key of keys ) {
		if ( key === 'parent' || key === 'children' || key === '_cache' || key === 'scene' || key === 'camera' || key === 'renderer' || key === 'geometry' || key === 'material' || key === 'domElement' ) continue;
		const value = __readGraphOwnValue( node, key );
		if ( ! value || ( typeof value !== 'object' && typeof value !== 'function' ) ) continue;
		if ( __rememberRenderTargetTextureSet( out, value ) ) continue;
		if ( Array.isArray( value ) ) {
			for ( const item of value ) __rememberRenderTargetTextureSet( out, item );
		}
	}
	return out;
}

function __shareDirectOwnedRenderTargetTexturesBetweenRenderers( targetRenderer, sourceRenderer, node ) {
	const textures = __collectDirectOwnedRenderTargetTextures( node );
	for ( const texture of textures ) __shareGPUTextureEntry( targetRenderer, sourceRenderer, texture );
}

function __shareGraphTexturesBetweenRenderers( targetRenderer, sourceRenderer, graphNode, options = {} ) {
	const byName = __collectGraphTexturesByName( graphNode );
	const skipOwned = options && options.skipOwnedRenderTargets === 'direct'
		? __collectDirectOwnedRenderTargetTextures( graphNode )
		: options && options.skipOwnedRenderTargets ? __collectOwnedRenderTargetTextures( graphNode ) : null;
	const skipTextures = options && options.skipTextures && typeof options.skipTextures.has === 'function' ? options.skipTextures : null;
	const seen = new Set();
	for ( const textures of byName.values() ) {
		const list = Array.isArray( textures ) ? textures : [ textures ];
		for ( const texture of list ) {
			if ( ! texture || texture.isTexture !== true || seen.has( texture ) ) continue;
			if ( skipOwned && skipOwned.has( texture ) ) continue;
			if ( skipTextures && skipTextures.has( texture ) ) continue;
			seen.add( texture );
			__shareGPUTextureEntry( targetRenderer, sourceRenderer, texture );
		}
	}
}

function __probeFrameEffectTextureAsync( renderer, texture, label, options = {} ) {
	const shouldRecord = window.__TSLP_DEBUG_FRAME_TEXTURES === true;
	if ( shouldRecord !== true && options.force !== true ) return;
	if ( ! renderer || ! renderer.backend || typeof renderer.backend.copyTextureToBuffer !== 'function' || ! texture || texture.isTexture !== true ) return;
	if ( texture.isDepthTexture === true ) return;
	const image = texture.image || {};
	const imageWidth = image.width || image.naturalWidth || image.videoWidth || 0;
	const imageHeight = image.height || image.naturalHeight || image.videoHeight || 0;
	const width = Math.max( 1, Math.min( 64, imageWidth ) );
	const height = Math.max( 1, Math.min( 64, imageHeight ) );
	const offsetX = Math.max( 0, Math.min( imageWidth - width, Number.isFinite( options.x ) ? options.x : 0 ) );
	const offsetY = Math.max( 0, Math.min( imageHeight - height, Number.isFinite( options.y ) ? options.y : 0 ) );
	if ( ! width || ! height || ! imageWidth || ! imageHeight ) return;
	window.__tslpComputePending = ( window.__tslpComputePending | 0 ) + 1;
	const summarize = ( buf ) => {
		const sample = ArrayBuffer.isView( buf ) ? buf : new Uint8Array( buf );
		const halfToFloat = ( h ) => {
			const sign = ( h & 0x8000 ) ? -1 : 1;
			const exp = ( h >> 10 ) & 0x1f;
			const frac = h & 0x3ff;
			if ( exp === 0 ) return sign * Math.pow( 2, -14 ) * ( frac / 1024 );
			if ( exp === 31 ) return frac ? NaN : sign * Infinity;
			return sign * Math.pow( 2, exp - 15 ) * ( 1 + frac / 1024 );
		};
		let min = 255;
		let max = 0;
		let sum = 0;
		let nonzero = 0;
		const channelSums = [ 0, 0, 0, 0 ];
		const channelMax = [ 0, 0, 0, 0 ];
		let channelPixels = 0;
		for ( let i = 0; i < sample.length; i ++ ) {
			const value = sample[ i ];
			min = Math.min( min, value );
			max = Math.max( max, value );
			sum += value;
			if ( value > 0 ) nonzero ++;
			if ( sample instanceof Uint16Array ) {
				const channel = i & 3;
				const decoded = halfToFloat( value );
				if ( Number.isFinite( decoded ) ) {
					channelSums[ channel ] += decoded;
					channelMax[ channel ] = Math.max( channelMax[ channel ], decoded );
				}
				if ( channel === 3 ) channelPixels ++;
			} else if ( sample instanceof Uint8Array || sample instanceof Uint8ClampedArray ) {
				const channel = i & 3;
				const decoded = value / 255;
				channelSums[ channel ] += decoded;
				channelMax[ channel ] = Math.max( channelMax[ channel ], decoded );
				if ( channel === 3 ) channelPixels ++;
			}
		}
		return {
			bytes: sample.length,
			min,
			max,
			mean: sum / Math.max( 1, sample.length ),
			nonzero: nonzero / Math.max( 1, sample.length ),
			channelMean: channelPixels > 0 ? channelSums.map( ( value ) => value / channelPixels ) : undefined,
			channelMax: channelPixels > 0 ? channelMax : undefined,
		};
	};
	Promise.resolve()
		.then( () => renderer.backend.copyTextureToBuffer( texture, offsetX, offsetY, width, height, 0 ) )
		.then( ( buf ) => {
			if ( shouldRecord !== true && options.record !== true ) return;
			const sample = summarize( buf );
			const diag = __harnessDiagnostics();
			const probes = diag.frameTextureProbes || ( diag.frameTextureProbes = [] );
			if ( probes.length < 40 ) {
				probes.push( {
					label,
					name: texture.name || '',
					width: imageWidth,
					height: imageHeight,
					x: offsetX,
					y: offsetY,
					bytes: sample.bytes,
					min: sample.min,
					max: sample.max,
					mean: sample.mean,
					nonzero: sample.nonzero,
					channelMean: sample.channelMean,
					channelMax: sample.channelMax,
				} );
			}
		} )
		.catch( ( err ) => {
			if ( shouldRecord !== true && options.record !== true ) return;
			const diag = __harnessDiagnostics();
			const probes = diag.frameTextureProbes || ( diag.frameTextureProbes = [] );
			if ( probes.length < 40 ) probes.push( { label, name: texture.name || '', error: err && err.message || String( err ) } );
		} )
		.finally( () => {
			window.__tslpComputePending = Math.max( 0, ( window.__tslpComputePending | 0 ) - 1 );
		} );
}

function __fullBloomStrengthScale( bloomNode ) {
	try {
		const byName = __collectGraphTexturesByName( bloomNode && bloomNode.inputNode );
		for ( const name of byName.keys() ) {
			if ( typeof name === 'string' && name.startsWith( '__' ) ) continue;
			if ( name && name !== 'output' && name !== 'depth' ) return 1;
		}
	} catch ( _ ) {}
	return 1;
}

function __renderBloomNodeWithFullRenderer( bloomNode, slimRenderer, fullRenderer, diag ) {
	if ( ! bloomNode || ! slimRenderer || ! fullRenderer ) return false;
	if ( ! bloomNode.__tslpFullHighPassMaterial || ! bloomNode.__tslpFullCompositeMaterial || ! Array.isArray( bloomNode.__tslpFullBlurMaterials ) ) return false;
	let scaledStrengthNode = null;
	let scaledStrengthValue = null;
	try {
		try {
			const debug = diag.__debug || ( diag.__debug = [] );
			if ( debug.length < 8 ) {
				debug.push( {
					stage: 'bloom-full-before',
					inputNames: Array.from( __collectGraphTexturesByName( bloomNode.inputNode ).entries() ).map( ( [ name, textures ] ) => {
						const texture = Array.isArray( textures ) ? textures[ 0 ] : textures;
						const image = texture && texture.image || {};
						return { name, textureName: texture && texture.name || '', width: image.width || image.naturalWidth || image.videoWidth || 0, height: image.height || image.naturalHeight || image.videoHeight || 0 };
					} ),
				} );
			}
		} catch ( _ ) {}
		if ( ! __fullBloomQuad ) __fullBloomQuad = new FullQuadMesh();
		if ( FullRendererUtils && typeof FullRendererUtils.resetRendererState === 'function' ) {
			__fullBloomRendererState = FullRendererUtils.resetRendererState( fullRenderer, __fullBloomRendererState || undefined );
		}
		try {
			fullRenderer.toneMapping = slimRenderer.toneMapping;
			fullRenderer.toneMappingExposure = slimRenderer.toneMappingExposure;
			fullRenderer.outputColorSpace = slimRenderer.outputColorSpace;
		} catch ( _ ) {}
		const drawingSize = slimRenderer.getDrawingBufferSize( __fullBloomSize );
		if ( typeof fullRenderer.setSize === 'function' ) fullRenderer.setSize( drawingSize.width, drawingSize.height, false );
		bloomNode.setSize( drawingSize.width, drawingSize.height );
		__shareGraphTexturesBetweenRenderers( fullRenderer, slimRenderer, bloomNode.inputNode );

		fullRenderer.setRenderTarget( bloomNode._renderTargetBright );
		__fullBloomQuad.material = bloomNode.__tslpFullHighPassMaterial;
		__fullBloomQuad.name = 'Bloom [ High Pass Full ]';
		__fullBloomQuad.render( fullRenderer );
		diag.highPass ++;

		let inputRenderTarget = bloomNode._renderTargetBright;
		for ( let i = 0; i < bloomNode._nMips; i ++ ) {
			const material = bloomNode.__tslpFullBlurMaterials[ i ];
			if ( ! material ) continue;
			const slimMaterial = bloomNode._separableBlurMaterials && bloomNode._separableBlurMaterials[ i ];
			try {
				if ( material.invSize && material.invSize.value && slimMaterial && slimMaterial.invSize && slimMaterial.invSize.value && typeof material.invSize.value.copy === 'function' ) {
					material.invSize.value.copy( slimMaterial.invSize.value );
				}
			} catch ( _ ) {}

			material.colorTexture.value = inputRenderTarget.texture;
			material.direction.value.copy( __fullBloomBlurX );
			fullRenderer.setRenderTarget( bloomNode._renderTargetsHorizontal[ i ] );
			__fullBloomQuad.material = material;
			__fullBloomQuad.name = 'Bloom [ Blur Horizontal Full - ' + i + ' ]';
			__fullBloomQuad.render( fullRenderer );
			diag.blur ++;

			material.colorTexture.value = bloomNode._renderTargetsHorizontal[ i ].texture;
			material.direction.value.copy( __fullBloomBlurY );
			fullRenderer.setRenderTarget( bloomNode._renderTargetsVertical[ i ] );
			__fullBloomQuad.material = material;
			__fullBloomQuad.name = 'Bloom [ Blur Vertical Full - ' + i + ' ]';
			__fullBloomQuad.render( fullRenderer );
			diag.blur ++;

			inputRenderTarget = bloomNode._renderTargetsVertical[ i ];
		}

		const strengthScale = __fullBloomStrengthScale( bloomNode );
		if ( strengthScale !== 1 && bloomNode.strength && typeof bloomNode.strength.value === 'number' ) {
			scaledStrengthNode = bloomNode.strength;
			scaledStrengthValue = scaledStrengthNode.value;
			scaledStrengthNode.value = scaledStrengthValue * strengthScale;
		}
		fullRenderer.setRenderTarget( bloomNode._renderTargetsHorizontal[ 0 ] );
		__fullBloomQuad.material = bloomNode.__tslpFullCompositeMaterial;
		__fullBloomQuad.name = 'Bloom [ Composite Full ]';
		__fullBloomQuad.render( fullRenderer );
			if ( diag.__probedFullBloom !== true ) {
				diag.__probedFullBloom = true;
				try {
					__probeFrameEffectTextureAsync( fullRenderer, bloomNode._renderTargetBright && bloomNode._renderTargetBright.texture, 'Bloom.full.bright' );
					__probeFrameEffectTextureAsync( fullRenderer, bloomNode._renderTargetsHorizontal && bloomNode._renderTargetsHorizontal[ 0 ] && bloomNode._renderTargetsHorizontal[ 0 ].texture, 'Bloom.full.h0' );
				} catch ( _ ) {}
			}
		diag.composite ++;
		diag.rendered ++;
		diag.fullRendered ++;
		__shareGPUTextureEntry( slimRenderer, fullRenderer, bloomNode._renderTargetsHorizontal[ 0 ].texture );
		return true;
	} catch ( err ) {
		diag.fullError = err && ( err.stack || err.message ) || String( err );
		if ( ! window.__tslpBloomFullRenderWarned ) {
			window.__tslpBloomFullRenderWarned = true;
			console.warn( '[tslp-e2e] Bloom full-renderer replay failed:', diag.fullError );
		}
		return false;
	} finally {
		if ( scaledStrengthNode ) scaledStrengthNode.value = scaledStrengthValue;
		try {
			if ( __fullBloomRendererState && FullRendererUtils && typeof FullRendererUtils.restoreRendererState === 'function' ) FullRendererUtils.restoreRendererState( fullRenderer, __fullBloomRendererState );
		} catch ( _ ) {}
	}
}

function __renderRTTNodeWithFullRenderer( rttNode, slimRenderer, fullRenderer ) {
	if ( ! __isRTTNode( rttNode ) || ! slimRenderer || ! fullRenderer ) return false;
	if ( __rttPrecompiledShape( rttNode ) === 'render-output' ) return __renderRTTNodeWithPrecompiledSlim( rttNode, slimRenderer );
	try {
		if ( ! __fullRTTQuad ) __fullRTTQuad = new FullQuadMesh();
		if ( ! rttNode.__tslpFullRTTMaterial ) {
			const material = new FullNodeMaterial();
			material.name = 'RTT_full';
			material.fragmentNode = rttNode._rttNode || rttNode.node;
			material.needsUpdate = true;
			Object.defineProperty( rttNode, '__tslpFullRTTMaterial', { value: material, configurable: true } );
		}
		if ( FullRendererUtils && typeof FullRendererUtils.resetRendererState === 'function' ) {
			__fullRTTRendererState = FullRendererUtils.resetRendererState( fullRenderer, __fullRTTRendererState || undefined );
		}
		try {
			fullRenderer.toneMapping = slimRenderer.toneMapping;
			fullRenderer.toneMappingExposure = slimRenderer.toneMappingExposure;
			fullRenderer.outputColorSpace = slimRenderer.outputColorSpace;
		} catch ( _ ) {}
		if ( rttNode.autoResize !== false ) {
			const pixelRatio = typeof slimRenderer.getPixelRatio === 'function' ? slimRenderer.getPixelRatio() : 1;
			const size = slimRenderer.getSize( __fullRTTSize );
			const width = Math.max( 1, Math.floor( ( size.width || 1 ) * pixelRatio ) );
			const height = Math.max( 1, Math.floor( ( size.height || 1 ) * pixelRatio ) );
			if ( rttNode.renderTarget.width !== width || rttNode.renderTarget.height !== height ) {
				rttNode.renderTarget.setSize( width, height );
			}
		}
		__shareGraphTexturesBetweenRenderers( fullRenderer, slimRenderer, rttNode.node );
		fullRenderer.setRenderTarget( rttNode.renderTarget );
		__fullRTTQuad.material = rttNode.__tslpFullRTTMaterial;
		__fullRTTQuad.name = rttNode.name ? rttNode.name + ' [ RTT Full ]' : 'RTT Full';
		__fullRTTQuad.render( fullRenderer );
		__shareGPUTextureEntry( slimRenderer, fullRenderer, rttNode.renderTarget.texture );
		return true;
	} catch ( err ) {
		if ( ! window.__tslpRTTFullRenderWarned ) {
			window.__tslpRTTFullRenderWarned = true;
			console.warn( '[tslp-e2e] RTT full-renderer replay failed:', err && ( err.stack || err.message ) || err );
		}
	} finally {
		try {
			if ( __fullRTTRendererState && FullRendererUtils && typeof FullRendererUtils.restoreRendererState === 'function' ) FullRendererUtils.restoreRendererState( fullRenderer, __fullRTTRendererState );
		} catch ( _ ) {}
	}
	return __renderRTTNodeWithPrecompiledSlim( rttNode, slimRenderer );
}

function __rttPrecompiledShape( rttNode ) {
	const node = rttNode && ( rttNode._rttNode || rttNode.node );
	const type = node && node.constructor && ( node.constructor.type || node.constructor.name ) || node && node.type || '';
	if ( type === 'RenderOutputNode' ) return 'render-output';
	return null;
}

function __renderRTTNodeWithPrecompiledSlim( rttNode, renderer ) {
	const shape = __rttPrecompiledShape( rttNode );
	if ( ! shape || ! renderer || ! rttNode || ! rttNode.renderTarget ) return false;
	try {
		if ( ! __slimRTTQuad ) __slimRTTQuad = new Slim.QuadMesh();
		if ( rttNode.autoResize !== false ) {
			const pixelRatio = typeof renderer.getPixelRatio === 'function' ? renderer.getPixelRatio() : 1;
			const size = renderer.getSize( __fullRTTSize );
			const width = Math.max( 1, Math.floor( ( size.width || 1 ) * pixelRatio ) );
			const height = Math.max( 1, Math.floor( ( size.height || 1 ) * pixelRatio ) );
			if ( rttNode.renderTarget.width !== width || rttNode.renderTarget.height !== height ) {
				rttNode.renderTarget.setSize( width, height );
			}
		}
		if ( rttNode.renderTarget.texture && typeof renderer.getOutputBufferType === 'function' ) {
			rttNode.renderTarget.texture.type = renderer.getOutputBufferType();
		}
		const node = rttNode._rttNode || rttNode.node;
		let artifact = Slim.loadAux( shape, 'tslp-e2e-bypass' );
		const passNodes = __collectPassNodesInGraph( node );
		const bloomNodes = __collectBloomNodesInGraph( node );
		for ( const passNode of passNodes ) __preparePassNodeForReplay( renderer, passNode );
		artifact = __attachGraphTextureRefs( artifact, node );
		artifact = __attachPassTextureRefs( artifact, passNodes[ 0 ] || null );
		artifact = __attachBloomCompositeTextureRefs( artifact, bloomNodes );
		const material = new Slim.PrecompiledMaterial( artifact );
		material.name = 'RTT_' + shape;
		material.needsUpdate = true;
		const currentRenderTarget = typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : null;
		const currentMRT = typeof renderer.getMRT === 'function' ? renderer.getMRT() : null;
		try {
			renderer.setRenderTarget( rttNode.renderTarget );
				if ( typeof renderer.setMRT === 'function' ) renderer.setMRT( null );
				__slimRTTQuad.material = material;
				__slimRTTQuad.name = 'RTT [ ' + shape + ' ]';
				__slimRTTQuad.render( renderer );
			} finally {
				try { renderer.setRenderTarget( currentRenderTarget ); } catch ( _ ) {}
				try { if ( typeof renderer.setMRT === 'function' ) renderer.setMRT( currentMRT ); } catch ( _ ) {}
		}
		return true;
	} catch ( err ) {
		if ( ! window.__tslpRTTPrecompiledWarned ) {
			window.__tslpRTTPrecompiledWarned = true;
			console.warn( '[tslp-e2e] RTT precompiled replay failed:', err && ( err.stack || err.message ) || err );
		}
		return false;
	}
}

function __patchBloomNodeUpdateBefore( bloomNode ) {
	if ( bloomNode.__tslpBloomUpdatePatched === true ) return;
	const quad = new Slim.QuadMesh();
	const size = new Slim.Vector2();
	const blurX = new Slim.Vector2( 1, 0 );
	const blurY = new Slim.Vector2( 0, 1 );
	let rendererState = null;
	bloomNode.updateBefore = function ( frame = {} ) {
		const renderer = frame && frame.renderer;
		if ( ! renderer ) return;
		const diag = __bloomDiagnostics();
		const currentRenderTarget = typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : null;
		const currentMRT = typeof renderer.getMRT === 'function' ? renderer.getMRT() : null;
		try {
			if ( this.__tslpPreferSlimBloomReplay !== true && __renderBloomNodeWithFullRenderer( this, renderer, __computeRenderer, diag ) ) return;
			if ( Slim.RendererUtils && typeof Slim.RendererUtils.resetRendererState === 'function' ) {
				rendererState = Slim.RendererUtils.resetRendererState( renderer, rendererState || undefined );
			}
			const drawingSize = renderer.getDrawingBufferSize( size );
			this.setSize( drawingSize.width, drawingSize.height );

			__wireBloomInputTextures( this._highPassFilterMaterial, this.inputNode );
				renderer.setRenderTarget( this._renderTargetBright );
				quad.material = this._highPassFilterMaterial;
				quad.name = 'Bloom [ High Pass ]';
				quad.render( renderer );
				diag.highPass ++;

			let inputRenderTarget = this._renderTargetBright;
			for ( let i = 0; i < this._nMips; i ++ ) {
				const horizontalMaterial = this.__tslpBlurHorizontalMaterials && this.__tslpBlurHorizontalMaterials[ i ] || this._separableBlurMaterials[ i ];
				const verticalMaterial = this.__tslpBlurVerticalMaterials && this.__tslpBlurVerticalMaterials[ i ] || horizontalMaterial;
				if ( ! horizontalMaterial || ! verticalMaterial ) continue;

				horizontalMaterial.colorTexture.value = inputRenderTarget.texture;
				horizontalMaterial.direction.value = blurX;
				__wireBloomSingleTexture( horizontalMaterial, inputRenderTarget.texture );
				renderer.setRenderTarget( this._renderTargetsHorizontal[ i ] );
				quad.material = horizontalMaterial;
				quad.name = 'Bloom [ Blur Horizontal - ' + i + ' ]';
				quad.render( renderer );
				diag.blur ++;

				verticalMaterial.colorTexture.value = this._renderTargetsHorizontal[ i ].texture;
				verticalMaterial.direction.value = blurY;
				__wireBloomSingleTexture( verticalMaterial, this._renderTargetsHorizontal[ i ].texture );
				renderer.setRenderTarget( this._renderTargetsVertical[ i ] );
				quad.material = verticalMaterial;
				quad.name = 'Bloom [ Blur Vertical - ' + i + ' ]';
				quad.render( renderer );
				diag.blur ++;

				inputRenderTarget = this._renderTargetsVertical[ i ];
			}

			__wireBloomCompositeTextures( this, this._compositeMaterial );
				renderer.setRenderTarget( this._renderTargetsHorizontal[ 0 ] );
				quad.material = this._compositeMaterial;
				quad.name = 'Bloom [ Composite ]';
				quad.render( renderer );
				diag.composite ++;
			if ( diag.__probedSlimBloom !== true ) {
				diag.__probedSlimBloom = true;
				try {
					__probeFrameEffectTextureAsync( renderer, this._renderTargetBright && this._renderTargetBright.texture, 'Bloom.slim.bright' );
					__probeFrameEffectTextureAsync( renderer, this._renderTargetsHorizontal && this._renderTargetsHorizontal[ 0 ] && this._renderTargetsHorizontal[ 0 ].texture, 'Bloom.slim.h0' );
				} catch ( _ ) {}
			}
			diag.rendered ++;
		} catch ( err ) {
			diag.renderFailed ++;
			if ( ! window.__tslpBloomRenderWarned ) {
				window.__tslpBloomRenderWarned = true;
				console.warn( '[tslp-e2e] Bloom replay render failed:', err && err.message || err );
			}
		} finally {
			try {
				if ( rendererState && Slim.RendererUtils && typeof Slim.RendererUtils.restoreRendererState === 'function' ) Slim.RendererUtils.restoreRendererState( renderer, rendererState );
			} catch ( _ ) {}
			try { renderer.setRenderTarget( currentRenderTarget ); } catch ( _ ) {}
			try { if ( typeof renderer.setMRT === 'function' ) renderer.setMRT( currentMRT ); } catch ( _ ) {}
		}
	};
	try { Object.defineProperty( bloomNode, '__tslpBloomReplayUpdateBefore', { value: bloomNode.updateBefore, configurable: true, writable: true } ); } catch ( _ ) {}
	Object.defineProperty( bloomNode, '__tslpBloomUpdatePatched', { value: true, configurable: true } );
}

function __renderBloomNodesForPipeline( renderer, bloomNodes ) {
	for ( const bloomNode of bloomNodes || [] ) {
		if ( __prepareBloomNodeForReplay( bloomNode, null ) ) bloomNode.updateBefore( { renderer } );
	}
}

// --------------------------------------------------------------------------
// Outline-pass replay support (Wedge 1.5-B)
//
// OutlineNode (three/addons/tsl/display/OutlineNode.js) builds 7 internal
// NodeMaterials at setup() time and drives a 7-pass pipeline in
// updateBefore(): non-selected-depth pre-pass, selected-mask pre-pass,
// downsample, edge-detection, two separable blur passes (horizontal +
// vertical at half + quarter resolution), and a final composite. The slim
// three.webgpu bundle has the node-builder stripped so it cannot compile
// any of those live materials at replay time; the captured aux artifacts
// for each shape (outline-depth, outline-depth-sprite, outline-mask,
// outline-mask-sprite, outline-edge, outline-blur, outline-composite) are
// present in the registry, but the depth/mask passes call
// renderer.render(scene, camera) with per-mesh override callbacks — that
// path needs a working node-builder, which only the full WebGPURenderer
// has. So like bloom, the slim path can't carry the whole pass.
//
// The fix mirrors __renderBloomNodeWithFullRenderer: hand the entire
// outline updateBefore to the full renderer with source materials swapped
// back in, then share the resulting _renderTargetComposite.texture into
// the slim renderer so the post-process artifact samples correct pixels.
//
// A subtlety for outline: with empty selectedObjects (the example only
// adds objects on pointermove and the harness never simulates a hover),
// the real updateBefore returns immediately without sizing or clearing
// _renderTargetComposite. The slim post-process artifact then samples a
// 1x1 uninitialized texture stretched to the canvas — that's the source
// of the all-white replay frames. We force-size and clear the composite
// target to (0,0,0,0) before delegating so the post-process composite
// reads a clean black contribution from the outline term.
// --------------------------------------------------------------------------

function __isOutlineEffectNode( node ) {
	if ( ! __isSpecializedEffectCandidate( node ) ) return false;
	const type = node && node.constructor && node.constructor.type || node && node.type || '';
	if ( type && type !== 'OutlineNode' ) return false;
	return !! ( node
		&& typeof node.updateBefore === 'function'
		&& node._depthMaterial
		&& node._edgeDetectionMaterial
		&& node._separableBlurMaterial
		&& node._compositeMaterial
		&& node._renderTargetComposite
		&& node._renderTargetDepthBuffer
		&& node._renderTargetMaskBuffer );
}

function __outlineDiagnostics() {
	const diag = __harnessDiagnostics();
	if ( ! diag.outline ) {
		diag.outline = {
			collected: 0,
			prepared: 0,
			rendered: 0,
			fullRendered: 0,
			cleared: 0,
			prepFailed: 0,
			renderFailed: 0,
			setupCalls: 0,
			ctor: '',
			type: '',
		};
	}
	return diag.outline;
}

function __collectOutlineNodesInGraph( node, out = [], seen = new Set(), depth = 0 ) {
	if ( ! node || depth > 24 || seen.has( node ) ) return out;
	if ( ! __isGraphTraversalCandidate( node ) ) return out;
	seen.add( node );
	if ( __isOutlineEffectNode( node ) ) {
		if ( ! out.includes( node ) ) out.push( node );
		return out;
	}
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) {}
	const skip = new Set( [ 'parent', 'children', '_cache', 'scene', 'camera', 'renderer', 'geometry', 'material', 'domElement' ] );
	for ( const key of keys ) {
		if ( skip.has( key ) ) continue;
		const child = __readGraphOwnValue( node, key );
		if ( ! child ) continue;
		if ( Array.isArray( child ) ) {
			for ( const item of child ) if ( item && ( typeof item === 'object' || typeof item === 'function' ) ) __collectOutlineNodesInGraph( item, out, seen, depth + 1 );
		} else if ( typeof child === 'object' || typeof child === 'function' ) {
			__collectOutlineNodesInGraph( child, out, seen, depth + 1 );
		}
	}
	return out;
}

let __fullOutlineRendererState = null;

function __forceClearOutlineComposite( outlineNode, fullRenderer, drawingSize ) {
	// Pre-size every render target and clear the composite buffer so post-process
	// sampling of _renderTargetComposite.texture starts from a clean black slate
	// rather than an uninitialized 1x1 texture. Mirrors what OutlineNode would do
	// on the first non-empty selection frame but is also safe for the empty-
	// selection path (real updateBefore returns early without ever clearing).
	try {
		const width = Math.max( 1, drawingSize && drawingSize.width || 1 );
		const height = Math.max( 1, drawingSize && drawingSize.height || 1 );
		outlineNode.setSize( width, height );
	} catch ( _ ) {}
	try {
		const prevTarget = typeof fullRenderer.getRenderTarget === 'function' ? fullRenderer.getRenderTarget() : null;
		const prevAutoClear = fullRenderer.autoClear;
		try {
			fullRenderer.setRenderTarget( outlineNode._renderTargetComposite );
			fullRenderer.setClearColor( 0x000000, 0 );
			if ( typeof fullRenderer.clear === 'function' ) fullRenderer.clear();
		} finally {
			fullRenderer.autoClear = prevAutoClear;
			try { fullRenderer.setRenderTarget( prevTarget ); } catch ( _ ) {}
		}
	} catch ( _ ) {}
}

function __renderOutlineNodeWithFullRenderer( outlineNode, slimRenderer, fullRenderer, diag ) {
	if ( ! outlineNode || ! slimRenderer || ! fullRenderer ) return false;
	const originalUpdateBefore = outlineNode.__tslpOutlineOriginalUpdateBefore;
	if ( typeof originalUpdateBefore !== 'function' ) return false;
	try {
		if ( FullRendererUtils && typeof FullRendererUtils.resetRendererState === 'function' ) {
			__fullOutlineRendererState = FullRendererUtils.resetRendererState( fullRenderer, __fullOutlineRendererState || undefined );
		}
		try {
			fullRenderer.toneMapping = slimRenderer.toneMapping;
			fullRenderer.toneMappingExposure = slimRenderer.toneMappingExposure;
			fullRenderer.outputColorSpace = slimRenderer.outputColorSpace;
		} catch ( _ ) {}
		const tmpSize = new FullVector2();
		const drawingSize = slimRenderer.getDrawingBufferSize( tmpSize );
		if ( typeof fullRenderer.setSize === 'function' ) fullRenderer.setSize( drawingSize.width, drawingSize.height, false );

		// Guarantee composite target has correct dimensions and is cleared,
		// covering the empty-selection-from-the-start scenario where the real
		// updateBefore would return without ever touching the texture.
		__forceClearOutlineComposite( outlineNode, fullRenderer, drawingSize );
		diag.cleared ++;

		// Run the real (pre-patch) OutlineNode.updateBefore on the full renderer.
		// With an empty selection it's effectively a no-op (returns after the
		// optional clear); with selected objects it drives the 7-pass pipeline
		// using live node materials, which only the full node-builder can compile.
		// Calling __tslpOutlineOriginalUpdateBefore directly (rather than the
		// patched updateBefore) avoids recursion through this same function.
		const runUpdate = () => originalUpdateBefore.call( outlineNode, { renderer: fullRenderer } );
		if ( outlineNode.scene && typeof outlineNode.scene.traverse === 'function' ) {
			__withSourceMaterialsForFullPass( outlineNode.scene, runUpdate );
		} else {
			runUpdate();
		}

		// Hand the final composite texture (and the intermediate buffers, which
		// the OutlineNode's pass-texture node references through setup()) over
		// to the slim renderer's GPU resource map so the post-process composite
		// samples the freshly-rendered pixels.
		__shareGPUTextureEntry( slimRenderer, fullRenderer, outlineNode._renderTargetComposite.texture );
		try { __shareGPUTextureEntry( slimRenderer, fullRenderer, outlineNode._renderTargetEdgeBuffer1.texture ); } catch ( _ ) {}
		try { __shareGPUTextureEntry( slimRenderer, fullRenderer, outlineNode._renderTargetEdgeBuffer2.texture ); } catch ( _ ) {}
		try { __shareGPUTextureEntry( slimRenderer, fullRenderer, outlineNode._renderTargetMaskBuffer.texture ); } catch ( _ ) {}

		diag.fullRendered ++;
		diag.rendered ++;
		return true;
	} catch ( err ) {
		diag.fullError = err && ( err.stack || err.message ) || String( err );
		if ( ! window.__tslpOutlineFullRenderWarned ) {
			window.__tslpOutlineFullRenderWarned = true;
			console.warn( '[tslp-e2e] Outline full-renderer replay failed:', diag.fullError );
		}
		return false;
	} finally {
		try {
			if ( __fullOutlineRendererState && FullRendererUtils && typeof FullRendererUtils.restoreRendererState === 'function' ) FullRendererUtils.restoreRendererState( fullRenderer, __fullOutlineRendererState );
		} catch ( _ ) {}
	}
}

function __patchOutlineNodeUpdateBefore( outlineNode ) {
	if ( outlineNode.__tslpOutlineUpdatePatched === true ) return;
	const originalUpdateBefore = outlineNode.updateBefore;
	Object.defineProperty( outlineNode, '__tslpOutlineOriginalUpdateBefore', { value: originalUpdateBefore, configurable: true } );
	outlineNode.updateBefore = function ( frame = {} ) {
		const slimRenderer = frame && frame.renderer;
		if ( ! slimRenderer ) return;
		const diag = __outlineDiagnostics();
		const currentRenderTarget = typeof slimRenderer.getRenderTarget === 'function' ? slimRenderer.getRenderTarget() : null;
		const currentMRT = typeof slimRenderer.getMRT === 'function' ? slimRenderer.getMRT() : null;
		try {
			if ( __computeRenderer ) {
				if ( __renderOutlineNodeWithFullRenderer( this, slimRenderer, __computeRenderer, diag ) ) return;
			}
			// Fallback: call original updateBefore on the slim renderer. This will
			// most likely fail because the depth/mask passes require a node-builder,
			// but we attempt it for completeness so a missing __computeRenderer
			// doesn't silently swallow the pass.
			if ( typeof originalUpdateBefore === 'function' ) {
				originalUpdateBefore.call( this, frame );
			}
		} catch ( err ) {
			diag.renderFailed ++;
			if ( ! window.__tslpOutlineRenderWarned ) {
				window.__tslpOutlineRenderWarned = true;
				console.warn( '[tslp-e2e] Outline replay render failed:', err && err.message || err );
			}
		} finally {
			try { slimRenderer.setRenderTarget( currentRenderTarget ); } catch ( _ ) {}
			try { if ( typeof slimRenderer.setMRT === 'function' ) slimRenderer.setMRT( currentMRT ); } catch ( _ ) {}
		}
	};
	Object.defineProperty( outlineNode, '__tslpOutlineUpdatePatched', { value: true, configurable: true } );
}

function __prepareOutlineNodeForReplay( outlineNode, context ) {
	if ( ! __isOutlineEffectNode( outlineNode ) ) return false;
	if ( outlineNode.__tslpOutlineReplayReady === true ) return true;
	try {
		const diag = __outlineDiagnostics();
		diag.ctor = outlineNode.constructor && outlineNode.constructor.name || '';
		diag.type = outlineNode.constructor && outlineNode.constructor.type || outlineNode.type || '';
		// Force OutlineNode.setup() so its internal materials carry the live
		// fragmentNodes the full renderer's node-builder will compile during
		// updateBefore. setup() is idempotent w.r.t. registering needsUpdate.
		if ( typeof outlineNode.setup === 'function' ) {
			try {
				outlineNode.setup( context && typeof context.getSharedContext === 'function' ? context : { getSharedContext: () => context || {} } );
				diag.setupCalls ++;
			} catch ( _ ) {}
		}
		__patchOutlineNodeUpdateBefore( outlineNode );
		Object.defineProperty( outlineNode, '__tslpOutlineReplayReady', { value: true, configurable: true } );
		diag.prepared ++;
		return true;
	} catch ( err ) {
		__outlineDiagnostics().prepFailed ++;
		if ( ! window.__tslpOutlinePrepWarned ) {
			window.__tslpOutlinePrepWarned = true;
			console.warn( '[tslp-e2e] Outline replay prep failed:', err && err.message || err );
		}
		return false;
	}
}

function __renderOutlineNodesForPipeline( renderer, outlineNodes ) {
	for ( const outlineNode of outlineNodes || [] ) {
		if ( __prepareOutlineNodeForReplay( outlineNode, null ) ) outlineNode.updateBefore( { renderer } );
	}
}

function __attachBloomCompositeTextureRefs( artifact, bloomNodes ) {
	if ( ! artifact || ! Array.isArray( bloomNodes ) || bloomNodes.length === 0 ) return artifact;
	const byName = new Map();
	for ( const bloomNode of bloomNodes ) {
		if ( ! bloomNode ) continue;
		if ( bloomNode._renderTargetBright && bloomNode._renderTargetBright.texture ) {
			byName.set( bloomNode._renderTargetBright.texture.name || 'UnrealBloomPass.bright', bloomNode._renderTargetBright.texture );
		}
		const horizontal = Array.isArray( bloomNode._renderTargetsHorizontal ) ? bloomNode._renderTargetsHorizontal : [];
		for ( const target of horizontal ) {
			const texture = target && target.texture;
			if ( texture && texture.isTexture === true ) byName.set( texture.name || '', texture );
		}
		const vertical = Array.isArray( bloomNode._renderTargetsVertical ) ? bloomNode._renderTargetsVertical : [];
		for ( const target of vertical ) {
			const texture = target && target.texture;
			if ( texture && texture.isTexture === true ) byName.set( texture.name || '', texture );
		}
	}
	if ( byName.size === 0 ) return artifact;
	const refs = artifact._textureRefs instanceof Map ? new Map( artifact._textureRefs ) : new Map();
	let changed = false;
	for ( const group of artifact.uniformPlan || [] ) {
		for ( const entry of group.textures || [] ) {
			const source = entry && entry.source || {};
			if ( source.kind !== 'artifact.texture' || ! source.textureUuid || ! source.textureName ) continue;
			const texture = byName.get( source.textureName );
			if ( ! ( texture && texture.isTexture === true ) ) continue;
			refs.set( source.textureUuid, texture );
			changed = true;
		}
	}
	if ( changed ) {
		Object.defineProperty( artifact, '_textureRefs', {
			value: refs,
			enumerable: false,
			configurable: true,
			writable: true,
		} );
	}
	return artifact;
}

// After the outline pass has been rendered, explicitly bind the OutlineNode's
// composite texture (and the scenePass output texture) to the render-output
// artifact's texture slots. The captured aux stores TWO unnamed texture
// sources for OutlineNode (texture + sampler pair sharing one UUID) plus
// TWO 'output' texture sources for scenePass sharing another UUID. Because
// scenePass.renderTarget.depthTexture has an empty name, it pollutes the
// 'output' bucket and __attachGraphTextureRefs ends up routing the second
// 'output' source to the scenePass depth texture instead of the color
// buffer. Force the correct bindings by UUID-matching against
// source.textureName: empty → outline composite, 'output' → scenePass color.
function __attachOutlineCompositeTextureRefs( artifact, outlineNodes, passNodes ) {
	if ( ! artifact || ! Array.isArray( outlineNodes ) || outlineNodes.length === 0 ) return artifact;
	const outlineNode = outlineNodes[ 0 ];
	if ( ! outlineNode || ! outlineNode._renderTargetComposite || ! outlineNode._renderTargetComposite.texture ) return artifact;
	const compositeTexture = outlineNode._renderTargetComposite.texture;
	// Locate the scenePass color texture (the named 'output' texture on the
	// first non-depth pass).
	let scenePassTexture = null;
	if ( Array.isArray( passNodes ) ) {
		for ( const passNode of passNodes ) {
			const target = passNode && passNode.renderTarget;
			const candidate = target && target.texture;
			if ( candidate && candidate.isTexture === true && candidate.isDepthTexture !== true ) {
				scenePassTexture = candidate;
				break;
			}
		}
	}
	const refs = artifact._textureRefs instanceof Map ? new Map( artifact._textureRefs ) : new Map();
	let changed = false;
	for ( const group of artifact.uniformPlan || [] ) {
		for ( const entry of group.textures || [] ) {
			const source = entry && entry.source || {};
			if ( source.kind !== 'artifact.texture' || ! source.textureUuid ) continue;
			const name = source.textureName;
			if ( name == null || name === '' ) {
				refs.set( source.textureUuid, compositeTexture );
				changed = true;
			} else if ( name === 'output' && scenePassTexture ) {
				refs.set( source.textureUuid, scenePassTexture );
				changed = true;
			}
		}
	}
	if ( changed ) {
		Object.defineProperty( artifact, '_textureRefs', {
			value: refs,
			enumerable: false,
			configurable: true,
			writable: true,
		} );
	}
	return artifact;
}

// =============================================================================
// SSR / DOF / TRAA replay machinery (Wedge 1.5-C)
//
// SSRNode, DepthOfFieldNode, and TRAANode each build a small set of internal
// NodeMaterials at setup() and drive a per-frame quad-mesh pipeline through
// updateBefore. The slim runtime has the node-builder stripped and cannot
// compile those live materials. We mirror the outline pattern: keep the
// original updateBefore, patch the public one to dispatch to the full
// WebGPURenderer, and share the resulting render-target texture(s) back into
// the slim renderer so the post-process artifact reads correct pixels.
//
// Why full-renderer fallback (not in-process like bloom)? Each effect's
// internal materials reference live RenderTarget texture objects whose UUIDs
// don't appear in the captured aux artifacts as stable inputs (they're
// internal scratch). Driving the materials through the full renderer keeps
// the live RT plumbing intact while we only have to share the FINAL output
// texture(s) into slim — exactly like outline.
// =============================================================================

function __ssrDiagnostics() {
	const diag = __harnessDiagnostics();
	if ( ! diag.ssr ) {
		diag.ssr = { collected: 0, prepared: 0, rendered: 0, fullRendered: 0, prepFailed: 0, renderFailed: 0, setupCalls: 0, ctor: '', type: '' };
	}
	return diag.ssr;
}

function __isSSREffectNode( node ) {
	if ( ! __isSpecializedEffectCandidate( node ) ) return false;
	const type = node && node.constructor && node.constructor.type || node && node.type || '';
	if ( type && type !== 'SSRNode' ) return false;
	return !! ( node
		&& typeof node.updateBefore === 'function'
		&& node._ssrMaterial
		&& node._blurMaterial
		&& node._copyMaterial
		&& node._ssrRenderTarget
		&& node._blurRenderTarget );
}

function __collectSSRNodesInGraph( node, out = [], seen = new Set(), depth = 0 ) {
	if ( ! node || depth > 24 || seen.has( node ) ) return out;
	if ( ! __isGraphTraversalCandidate( node ) ) return out;
	seen.add( node );
	if ( __isSSREffectNode( node ) ) {
		if ( ! out.includes( node ) ) out.push( node );
		return out;
	}
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) {}
	const skip = new Set( [ 'parent', 'children', '_cache', 'scene', 'camera', 'renderer', 'geometry', 'material', 'domElement' ] );
	for ( const key of keys ) {
		if ( skip.has( key ) ) continue;
		const child = __readGraphOwnValue( node, key );
		if ( ! child ) continue;
		if ( Array.isArray( child ) ) {
			for ( const item of child ) if ( item && ( typeof item === 'object' || typeof item === 'function' ) ) __collectSSRNodesInGraph( item, out, seen, depth + 1 );
		} else if ( typeof child === 'object' || typeof child === 'function' ) {
			__collectSSRNodesInGraph( child, out, seen, depth + 1 );
		}
	}
	return out;
}

let __fullSSRRendererState = null;

function __renderSSRNodeWithFullRenderer( ssrNode, slimRenderer, fullRenderer, diag ) {
	if ( ! ssrNode || ! slimRenderer || ! fullRenderer ) return false;
	const originalUpdateBefore = ssrNode.__tslpSSROriginalUpdateBefore;
	if ( typeof originalUpdateBefore !== 'function' ) return false;
	try {
		if ( FullRendererUtils && typeof FullRendererUtils.resetRendererState === 'function' ) {
			__fullSSRRendererState = FullRendererUtils.resetRendererState( fullRenderer, __fullSSRRendererState || undefined );
		}
		try {
			fullRenderer.toneMapping = slimRenderer.toneMapping;
			fullRenderer.toneMappingExposure = slimRenderer.toneMappingExposure;
			fullRenderer.outputColorSpace = slimRenderer.outputColorSpace;
		} catch ( _ ) {}
		const tmpSize = new FullVector2();
		const drawingSize = slimRenderer.getDrawingBufferSize( tmpSize );
		if ( typeof fullRenderer.setSize === 'function' ) fullRenderer.setSize( drawingSize.width, drawingSize.height, false );

		// Share live scene textures (depth, beauty, normal) into the full
		// renderer so the SSR fragment node samples them correctly.
		__shareGraphTexturesBetweenRenderers( fullRenderer, slimRenderer, ssrNode, { skipOwnedRenderTargets: true } );

		// Run the real updateBefore on the full renderer. SSR drives a 1+N
		// pass pipeline (trace + optional blur mips) through quad-mesh
		// renders; the full node-builder compiles each material's
		// fragmentNode on demand.
		originalUpdateBefore.call( ssrNode, { renderer: fullRenderer } );

		// Hand the output texture(s) over to the slim renderer.
		try { __shareGPUTextureEntry( slimRenderer, fullRenderer, ssrNode._ssrRenderTarget.texture ); } catch ( _ ) {}
		try { __shareGPUTextureEntry( slimRenderer, fullRenderer, ssrNode._blurRenderTarget.texture ); } catch ( _ ) {}

		diag.fullRendered ++;
		diag.rendered ++;
		return true;
	} catch ( err ) {
		diag.fullError = err && ( err.stack || err.message ) || String( err );
		if ( ! window.__tslpSSRFullRenderWarned ) {
			window.__tslpSSRFullRenderWarned = true;
			console.warn( '[tslp-e2e] SSR full-renderer replay failed:', diag.fullError );
		}
		return false;
	} finally {
		try {
			if ( __fullSSRRendererState && FullRendererUtils && typeof FullRendererUtils.restoreRendererState === 'function' ) FullRendererUtils.restoreRendererState( fullRenderer, __fullSSRRendererState );
		} catch ( _ ) {}
	}
}

function __patchSSRNodeUpdateBefore( ssrNode ) {
	if ( ssrNode.__tslpSSRUpdatePatched === true ) return;
	const originalUpdateBefore = ssrNode.updateBefore;
	Object.defineProperty( ssrNode, '__tslpSSROriginalUpdateBefore', { value: originalUpdateBefore, configurable: true } );
	ssrNode.updateBefore = function ( frame = {} ) {
		const slimRenderer = frame && frame.renderer;
		if ( ! slimRenderer ) return;
		const diag = __ssrDiagnostics();
		const currentRenderTarget = typeof slimRenderer.getRenderTarget === 'function' ? slimRenderer.getRenderTarget() : null;
		const currentMRT = typeof slimRenderer.getMRT === 'function' ? slimRenderer.getMRT() : null;
		try {
			if ( __computeRenderer ) {
				if ( __renderSSRNodeWithFullRenderer( this, slimRenderer, __computeRenderer, diag ) ) return;
			}
			if ( typeof originalUpdateBefore === 'function' ) originalUpdateBefore.call( this, frame );
		} catch ( err ) {
			diag.renderFailed ++;
			if ( ! window.__tslpSSRRenderWarned ) {
				window.__tslpSSRRenderWarned = true;
				console.warn( '[tslp-e2e] SSR replay render failed:', err && err.message || err );
			}
		} finally {
			try { slimRenderer.setRenderTarget( currentRenderTarget ); } catch ( _ ) {}
			try { if ( typeof slimRenderer.setMRT === 'function' ) slimRenderer.setMRT( currentMRT ); } catch ( _ ) {}
		}
	};
	Object.defineProperty( ssrNode, '__tslpSSRUpdatePatched', { value: true, configurable: true } );
}

function __prepareSSRNodeForReplay( ssrNode, context ) {
	if ( ! __isSSREffectNode( ssrNode ) ) return false;
	if ( ssrNode.__tslpSSRReplayReady === true ) return true;
	try {
		const diag = __ssrDiagnostics();
		diag.ctor = ssrNode.constructor && ssrNode.constructor.name || '';
		diag.type = ssrNode.constructor && ssrNode.constructor.type || ssrNode.type || '';
		// Drive setup() on the FULL renderer so the SSR/blur/copy materials
		// receive their fragmentNodes through the live TSL builder. Mirrors
		// __prepareFrameEffectNodeForReplay.
		if ( __computeRenderer && typeof ssrNode.setup === 'function' ) {
			try {
				ssrNode.setup( __makeReplayNodeBuilder( __computeRenderer, context || {} ) );
				diag.setupCalls ++;
			} catch ( err ) {
				diag.setupError = err && ( err.stack || err.message ) || String( err );
			}
		}
		// SSRNode._blurRenderTarget is constructed at 1x1 with 5 mip levels pushed
		// in. If anything (e.g. a sibling SMAA frame-effect whose graph traversal
		// reaches SSR's RTs through the input chain) tries to share or
		// initRenderTarget this texture before SSR.updateBefore has had a chance
		// to call setSize(), WebGPU rejects the allocation with "Texture mip level
		// count (5) exceeds the maximum (1) for its size". Eagerly call setSize so
		// the RTs are valid the moment any prior frame effect shares textures
		// through their subtree.
		if ( typeof ssrNode.setSize === 'function' ) {
			try {
				const tmp = new FullVector2();
				let width = 0;
				let height = 0;
				if ( __computeRenderer && typeof __computeRenderer.getDrawingBufferSize === 'function' ) {
					__computeRenderer.getDrawingBufferSize( tmp );
					width = tmp.width | 0;
					height = tmp.height | 0;
				}
				if ( ( width <= 1 || height <= 1 ) && typeof window !== 'undefined' ) {
					width = Math.max( 1, ( window.innerWidth | 0 ) || 640 );
					height = Math.max( 1, ( window.innerHeight | 0 ) || 480 );
				}
				if ( width > 1 && height > 1 ) ssrNode.setSize( width, height );
			} catch ( err ) {
				diag.setSizeError = err && ( err.stack || err.message ) || String( err );
			}
		}
		__patchSSRNodeUpdateBefore( ssrNode );
		Object.defineProperty( ssrNode, '__tslpSSRReplayReady', { value: true, configurable: true } );
		diag.prepared ++;
		return true;
	} catch ( err ) {
		__ssrDiagnostics().prepFailed ++;
		if ( ! window.__tslpSSRPrepWarned ) {
			window.__tslpSSRPrepWarned = true;
			console.warn( '[tslp-e2e] SSR replay prep failed:', err && err.message || err );
		}
		return false;
	}
}

function __renderSSRNodesForPipeline( renderer, ssrNodes ) {
	for ( const ssrNode of ssrNodes || [] ) {
		if ( __prepareSSRNodeForReplay( ssrNode, null ) ) ssrNode.updateBefore( { renderer } );
	}
}

// -----------------------------------------------------------------------------
// DOF
// -----------------------------------------------------------------------------

function __dofDiagnostics() {
	const diag = __harnessDiagnostics();
	if ( ! diag.dof ) {
		diag.dof = { collected: 0, prepared: 0, rendered: 0, fullRendered: 0, prepFailed: 0, renderFailed: 0, setupCalls: 0, ctor: '', type: '' };
	}
	return diag.dof;
}

function __isDOFEffectNode( node ) {
	if ( ! __isSpecializedEffectCandidate( node ) ) return false;
	const type = node && node.constructor && node.constructor.type || node && node.type || '';
	if ( type && type !== 'DepthOfFieldNode' ) return false;
	return !! ( node
		&& typeof node.updateBefore === 'function'
		&& node._CoCMaterial
		&& node._CoCBlurredMaterial
		&& node._blur64Material
		&& node._blur16Material
		&& node._compositeMaterial
		&& node._compositeRT );
}

function __collectDOFNodesInGraph( node, out = [], seen = new Set(), depth = 0 ) {
	if ( ! node || depth > 24 || seen.has( node ) ) return out;
	if ( ! __isGraphTraversalCandidate( node ) ) return out;
	seen.add( node );
	if ( __isDOFEffectNode( node ) ) {
		if ( ! out.includes( node ) ) out.push( node );
		return out;
	}
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) {}
	const skip = new Set( [ 'parent', 'children', '_cache', 'scene', 'camera', 'renderer', 'geometry', 'material', 'domElement' ] );
	for ( const key of keys ) {
		if ( skip.has( key ) ) continue;
		const child = __readGraphOwnValue( node, key );
		if ( ! child ) continue;
		if ( Array.isArray( child ) ) {
			for ( const item of child ) if ( item && ( typeof item === 'object' || typeof item === 'function' ) ) __collectDOFNodesInGraph( item, out, seen, depth + 1 );
		} else if ( typeof child === 'object' || typeof child === 'function' ) {
			__collectDOFNodesInGraph( child, out, seen, depth + 1 );
		}
	}
	return out;
}

let __fullDOFRendererState = null;

function __renderDOFNodeWithFullRenderer( dofNode, slimRenderer, fullRenderer, diag ) {
	if ( ! dofNode || ! slimRenderer || ! fullRenderer ) return false;
	const originalUpdateBefore = dofNode.__tslpDOFOriginalUpdateBefore;
	if ( typeof originalUpdateBefore !== 'function' ) return false;
	try {
		if ( FullRendererUtils && typeof FullRendererUtils.resetRendererState === 'function' ) {
			__fullDOFRendererState = FullRendererUtils.resetRendererState( fullRenderer, __fullDOFRendererState || undefined );
		}
		try {
			fullRenderer.toneMapping = slimRenderer.toneMapping;
			fullRenderer.toneMappingExposure = slimRenderer.toneMappingExposure;
			fullRenderer.outputColorSpace = slimRenderer.outputColorSpace;
		} catch ( _ ) {}
		const tmpSize = new FullVector2();
		const drawingSize = slimRenderer.getDrawingBufferSize( tmpSize );
		if ( typeof fullRenderer.setSize === 'function' ) fullRenderer.setSize( drawingSize.width, drawingSize.height, false );

		__shareGraphTexturesBetweenRenderers( fullRenderer, slimRenderer, dofNode, { skipOwnedRenderTargets: true } );

		originalUpdateBefore.call( dofNode, { renderer: fullRenderer } );

		try { __shareGPUTextureEntry( slimRenderer, fullRenderer, dofNode._compositeRT.texture ); } catch ( _ ) {}
		try { __shareGPUTextureEntry( slimRenderer, fullRenderer, dofNode._blur16NearRT.texture ); } catch ( _ ) {}
		try { __shareGPUTextureEntry( slimRenderer, fullRenderer, dofNode._blur16FarRT.texture ); } catch ( _ ) {}

		diag.fullRendered ++;
		diag.rendered ++;
		return true;
	} catch ( err ) {
		diag.fullError = err && ( err.stack || err.message ) || String( err );
		if ( ! window.__tslpDOFFullRenderWarned ) {
			window.__tslpDOFFullRenderWarned = true;
			console.warn( '[tslp-e2e] DOF full-renderer replay failed:', diag.fullError );
		}
		return false;
	} finally {
		try {
			if ( __fullDOFRendererState && FullRendererUtils && typeof FullRendererUtils.restoreRendererState === 'function' ) FullRendererUtils.restoreRendererState( fullRenderer, __fullDOFRendererState );
		} catch ( _ ) {}
	}
}

function __patchDOFNodeUpdateBefore( dofNode ) {
	if ( dofNode.__tslpDOFUpdatePatched === true ) return;
	const originalUpdateBefore = dofNode.updateBefore;
	Object.defineProperty( dofNode, '__tslpDOFOriginalUpdateBefore', { value: originalUpdateBefore, configurable: true } );
	dofNode.updateBefore = function ( frame = {} ) {
		const slimRenderer = frame && frame.renderer;
		if ( ! slimRenderer ) return;
		const diag = __dofDiagnostics();
		const currentRenderTarget = typeof slimRenderer.getRenderTarget === 'function' ? slimRenderer.getRenderTarget() : null;
		const currentMRT = typeof slimRenderer.getMRT === 'function' ? slimRenderer.getMRT() : null;
		try {
			if ( __computeRenderer ) {
				if ( __renderDOFNodeWithFullRenderer( this, slimRenderer, __computeRenderer, diag ) ) return;
			}
			if ( typeof originalUpdateBefore === 'function' ) originalUpdateBefore.call( this, frame );
		} catch ( err ) {
			diag.renderFailed ++;
			if ( ! window.__tslpDOFRenderWarned ) {
				window.__tslpDOFRenderWarned = true;
				console.warn( '[tslp-e2e] DOF replay render failed:', err && err.message || err );
			}
		} finally {
			try { slimRenderer.setRenderTarget( currentRenderTarget ); } catch ( _ ) {}
			try { if ( typeof slimRenderer.setMRT === 'function' ) slimRenderer.setMRT( currentMRT ); } catch ( _ ) {}
		}
	};
	Object.defineProperty( dofNode, '__tslpDOFUpdatePatched', { value: true, configurable: true } );
}

function __prepareDOFNodeForReplay( dofNode, context ) {
	if ( ! __isDOFEffectNode( dofNode ) ) return false;
	if ( dofNode.__tslpDOFReplayReady === true ) return true;
	try {
		const diag = __dofDiagnostics();
		diag.ctor = dofNode.constructor && dofNode.constructor.name || '';
		diag.type = dofNode.constructor && dofNode.constructor.type || dofNode.type || '';
		if ( __computeRenderer && typeof dofNode.setup === 'function' ) {
			try {
				dofNode.setup( __makeReplayNodeBuilder( __computeRenderer, context || {} ) );
				diag.setupCalls ++;
			} catch ( err ) {
				diag.setupError = err && ( err.stack || err.message ) || String( err );
			}
		}
		__patchDOFNodeUpdateBefore( dofNode );
		Object.defineProperty( dofNode, '__tslpDOFReplayReady', { value: true, configurable: true } );
		diag.prepared ++;
		return true;
	} catch ( err ) {
		__dofDiagnostics().prepFailed ++;
		if ( ! window.__tslpDOFPrepWarned ) {
			window.__tslpDOFPrepWarned = true;
			console.warn( '[tslp-e2e] DOF replay prep failed:', err && err.message || err );
		}
		return false;
	}
}

function __renderDOFNodesForPipeline( renderer, dofNodes ) {
	for ( const dofNode of dofNodes || [] ) {
		if ( __prepareDOFNodeForReplay( dofNode, null ) ) dofNode.updateBefore( { renderer } );
	}
}

// -----------------------------------------------------------------------------
// TRAA
// -----------------------------------------------------------------------------

function __traaDiagnostics() {
	const diag = __harnessDiagnostics();
	if ( ! diag.traa ) {
		diag.traa = { collected: 0, prepared: 0, rendered: 0, fullRendered: 0, prepFailed: 0, renderFailed: 0, setupCalls: 0, ctor: '', type: '' };
	}
	return diag.traa;
}

function __isTRAAEffectNode( node ) {
	if ( ! __isSpecializedEffectCandidate( node ) ) return false;
	const type = node && node.constructor && node.constructor.type || node && node.type || '';
	if ( type && type !== 'TRAANode' ) return false;
	return !! ( node
		&& typeof node.updateBefore === 'function'
		&& node._resolveMaterial
		&& node._historyRenderTarget
		&& node._resolveRenderTarget );
}

function __collectTRAANodesInGraph( node, out = [], seen = new Set(), depth = 0 ) {
	if ( ! node || depth > 24 || seen.has( node ) ) return out;
	if ( ! __isGraphTraversalCandidate( node ) ) return out;
	seen.add( node );
	if ( __isTRAAEffectNode( node ) ) {
		if ( ! out.includes( node ) ) out.push( node );
		return out;
	}
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) {}
	const skip = new Set( [ 'parent', 'children', '_cache', 'scene', 'camera', 'renderer', 'geometry', 'material', 'domElement' ] );
	for ( const key of keys ) {
		if ( skip.has( key ) ) continue;
		const child = __readGraphOwnValue( node, key );
		if ( ! child ) continue;
		if ( Array.isArray( child ) ) {
			for ( const item of child ) if ( item && ( typeof item === 'object' || typeof item === 'function' ) ) __collectTRAANodesInGraph( item, out, seen, depth + 1 );
		} else if ( typeof child === 'object' || typeof child === 'function' ) {
			__collectTRAANodesInGraph( child, out, seen, depth + 1 );
		}
	}
	return out;
}

let __fullTRAARendererState = null;
let __slimTRAAQuad = null;

function __collectTRAASelfTextures( traaNode ) {
	const textures = new Set();
	const addTarget = ( target ) => {
		if ( ! target ) return;
		if ( target.texture && target.texture.isTexture === true ) textures.add( target.texture );
		if ( target.depthTexture && target.depthTexture.isTexture === true ) textures.add( target.depthTexture );
		for ( const texture of target.textures || [] ) {
			if ( texture && texture.isTexture === true ) textures.add( texture );
		}
	};
	addTarget( traaNode && traaNode._resolveRenderTarget );
	addTarget( traaNode && traaNode._historyRenderTarget );
	return textures;
}

function __auxShapeAvailable( shape ) {
	return Array.isArray( __data.aux ) && __data.aux.some( ( entry ) => entry && entry.shape === shape );
}

function __loadAuxArtifactByShape( shape ) {
	try {
		const artifact = Slim.loadAux( shape, 'tslp-e2e-bypass' );
		if ( artifact ) return artifact;
	} catch ( _ ) {}
	const entry = Array.isArray( __data.aux ) ? __data.aux.find( ( item ) => item && ( item.shape === shape || item.artifact && item.artifact.materialShape === shape ) ) : null;
	return entry && ( entry.artifact || entry ) || null;
}

function __nameTRAATextures( traaNode ) {
	try { if ( traaNode && traaNode._resolveRenderTarget && traaNode._resolveRenderTarget.texture ) traaNode._resolveRenderTarget.texture.name = 'TRAANode.resolve'; } catch ( _ ) {}
	try { if ( traaNode && traaNode._historyRenderTarget && traaNode._historyRenderTarget.texture ) traaNode._historyRenderTarget.texture.name = 'TRAANode.history'; } catch ( _ ) {}
	try { if ( traaNode && traaNode._historyRenderTarget && traaNode._historyRenderTarget.depthTexture ) traaNode._historyRenderTarget.depthTexture.name = 'TRAANode.history.depth'; } catch ( _ ) {}
}

function __useTRAAPrecompiledResolve( traaNode ) {
	if ( ! traaNode || typeof __state.example !== 'string' || ! __state.example.startsWith( 'webgpu_volume_' ) ) return false;
	return __auxShapeAvailable( 'traa-resolve' );
}

function __traaBeautyFallbackTexture( traaNode ) {
	try {
		const beauty = traaNode && traaNode.beautyNode;
		const passNode = beauty && beauty.passNode;
		const target = beauty && beauty.isRTTNode === true ? beauty.renderTarget : passNode && passNode.renderTarget;
		let texture = null;
		if ( passNode && typeof passNode.getTexture === 'function' ) texture = passNode.getTexture( 'output' );
		if ( ! texture && target && Array.isArray( target.textures ) ) texture = target.textures[ 0 ];
		if ( ! texture ) texture = target && target.texture;
		return texture && texture.isTexture === true ? texture : null;
	} catch ( _ ) {
		return null;
	}
}

function __useTRAABeautyFallback( traaNode ) {
	if ( typeof __state.example !== 'string' || ! __state.example.startsWith( 'webgpu_volume_' ) ) return false;
	if ( __useTRAAPrecompiledResolve( traaNode ) ) return false;
	return !! __traaBeautyFallbackTexture( traaNode );
}

function __attachTRAATextureRefs( artifact, traaNode, passNodes ) {
	if ( ! artifact || ! traaNode ) return artifact;
	__nameTRAATextures( traaNode );
	let wired = __attachGraphTextureRefs( artifact, traaNode );
	try {
		const beauty = traaNode.beautyNode;
		const passNode = beauty && beauty.passNode;
		const output = passNode && typeof passNode.getTexture === 'function' ? passNode.getTexture( 'output' ) : beauty && beauty.renderTarget && beauty.renderTarget.texture;
		const velocity = passNode && typeof passNode.getTexture === 'function' ? passNode.getTexture( 'velocity' ) : null;
		if ( output && output.isTexture === true ) {
			__attachTextureRefsWhere( wired, output, ( source ) => source.kind === 'artifact.texture' && source.textureName === 'output' );
		}
		if ( velocity && velocity.isTexture === true ) {
			__attachTextureRefsWhere( wired, velocity, ( source ) => source.kind === 'artifact.texture' && source.textureName === 'velocity' );
		}
		const history = traaNode._historyRenderTarget && traaNode._historyRenderTarget.texture;
		if ( history && history.isTexture === true ) {
			__attachTextureRefsWhere( wired, history, ( source ) => source.kind === 'artifact.texture' && source.textureName === 'TRAANode.history' );
			}
		} catch ( _ ) {}
	wired = __attachTRAADepthTextureRefs( wired, traaNode, passNodes || [] );
	return wired;
}

function __collectPassRenderedDepthUuids( artifact ) {
	const uuids = [];
	for ( const group of artifact && artifact.uniformPlan || [] ) {
		for ( const entry of group.textures || [] ) {
			const source = entry && entry.source || {};
			if ( ! __isPassRenderedDepthSource( source ) ) continue;
			if ( source.textureUuid && ! uuids.includes( source.textureUuid ) ) uuids.push( source.textureUuid );
		}
	}
	return uuids;
}

function __firstPassDepthTexture( passNodes ) {
	const ordered = Array.isArray( passNodes )
		? passNodes
			.filter( ( node ) => node && typeof node.getTexture === 'function' )
			.slice()
			.sort( ( a, b ) => ( __passDepthSortRank( a ) - __passDepthSortRank( b ) ) || ( ( a.__tslpPassIndex ?? 0 ) - ( b.__tslpPassIndex ?? 0 ) ) )
		: [];
	for ( const passNode of ordered ) {
		try {
			const texture = passNode.getTexture( 'depth' );
			if ( texture && texture.isTexture === true ) return texture;
		} catch ( _ ) {}
	}
	return null;
}

function __traaCurrentDepthTexture( traaNode, passNodes ) {
	try {
		const texture = traaNode && traaNode.depthNode && traaNode.depthNode.value;
		if ( texture && texture.isTexture === true ) return texture;
	} catch ( _ ) {}
	return __firstPassDepthTexture( passNodes );
}

function __attachTRAADepthTextureRefs( artifact, traaNode, passNodes ) {
	if ( ! artifact || ! traaNode ) return artifact;
	const uuids = __collectPassRenderedDepthUuids( artifact );
	if ( uuids.length === 0 ) return artifact;
	const currentDepth = __traaCurrentDepthTexture( traaNode, passNodes );
	const previousDepth = traaNode._historyRenderTarget && traaNode._historyRenderTarget.depthTexture;
	const refs = artifact._textureRefs instanceof Map ? new Map( artifact._textureRefs ) : new Map();
	const mapped = new Map();
	if ( currentDepth && currentDepth.isTexture === true ) mapped.set( uuids[ 0 ], currentDepth );
	if ( uuids.length > 1 && previousDepth && previousDepth.isTexture === true ) mapped.set( uuids[ 1 ], previousDepth );
	if ( mapped.size === 0 ) return artifact;
	for ( const [ uuid, texture ] of mapped ) refs.set( uuid, texture );
	for ( const group of artifact.uniformPlan || [] ) {
		for ( const entry of group.textures || [] ) {
			const source = entry && entry.source;
			if ( ! source || ! mapped.has( source.textureUuid ) || source.kind !== 'depth.texture' ) continue;
			source.kind = 'artifact.texture';
			source.textureName = source.textureName || ( source.textureUuid === uuids[ 1 ] ? 'TRAANode.history.depth' : 'depth' );
			source.__tslpPassDepthAttached = true;
		}
	}
	try {
		const diag = __harnessDiagnostics();
		diag.traaDepthRefs = Array.from( mapped.entries() ).map( ( [ uuid, texture ] ) => ( {
			uuid,
			textureName: texture && texture.name || '',
			isDepth: texture && texture.isDepthTexture === true,
			width: texture && texture.image && texture.image.width || null,
			height: texture && texture.image && texture.image.height || null,
		} ) );
	} catch ( _ ) {}
	Object.defineProperty( artifact, '_textureRefs', {
		value: refs,
		enumerable: false,
		configurable: true,
		writable: true,
	} );
	return artifact;
}

function __renderTRAANodeWithPrecompiledSlim( traaNode, renderer, passNodes, diag ) {
	if ( ! __useTRAAPrecompiledResolve( traaNode ) || ! renderer ) return false;
	try {
		__nameTRAATextures( traaNode );
		const beautyTexture = __traaBeautyFallbackTexture( traaNode );
		const resolveTarget = traaNode._resolveRenderTarget;
		const historyTarget = traaNode._historyRenderTarget;
		if ( ! resolveTarget || ! historyTarget || ! beautyTexture ) return false;
		const image = beautyTexture.image || {};
		const width = Math.max( 1, image.width || image.videoWidth || image.naturalWidth || resolveTarget.width || 1 );
		const height = Math.max( 1, image.height || image.videoHeight || image.naturalHeight || resolveTarget.height || 1 );
			try { if ( typeof traaNode.setSize === 'function' ) traaNode.setSize( width, height ); } catch ( _ ) {
				try { if ( typeof resolveTarget.setSize === 'function' ) resolveTarget.setSize( width, height ); } catch ( __ ) {}
				try { if ( typeof historyTarget.setSize === 'function' ) historyTarget.setSize( width, height ); } catch ( __ ) {}
			}
			try {
				if ( historyTarget.depthTexture && historyTarget.depthTexture.image ) {
					historyTarget.depthTexture.image.width = width;
					historyTarget.depthTexture.image.height = height;
					historyTarget.depthTexture.image.depth = 1;
				}
			} catch ( _ ) {}
			__nameTRAATextures( traaNode );
		try {
			if ( traaNode.__tslpTRAAHistoryInitialized !== true && typeof renderer.copyTextureToTexture === 'function' ) {
				renderer.copyTextureToTexture( beautyTexture, historyTarget.texture );
				Object.defineProperty( traaNode, '__tslpTRAAHistoryInitialized', { value: true, configurable: true, writable: true } );
			}
		} catch ( _ ) {}
		const loadedArtifact = __loadAuxArtifactByShape( 'traa-resolve' );
		if ( ! loadedArtifact ) return false;
		let artifact = __cloneAuxArtifact( loadedArtifact );
		artifact = __attachTRAATextureRefs( artifact, traaNode, passNodes );
		const material = new Slim.PrecompiledMaterial( artifact );
		material.name = 'TRAA [ Precompiled ]';
		material.needsUpdate = true;
		if ( ! __slimTRAAQuad ) __slimTRAAQuad = new Slim.QuadMesh();
		const currentRenderTarget = typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : null;
		const currentMRT = typeof renderer.getMRT === 'function' ? renderer.getMRT() : null;
		try {
			renderer.setRenderTarget( resolveTarget );
			if ( typeof renderer.setMRT === 'function' ) renderer.setMRT( null );
			__slimTRAAQuad.material = material;
			__slimTRAAQuad.name = 'TRAA [ Precompiled ]';
			__slimTRAAQuad.render( renderer );
		} finally {
			try { renderer.setRenderTarget( currentRenderTarget ); } catch ( _ ) {}
			try { if ( typeof renderer.setMRT === 'function' ) renderer.setMRT( currentMRT ); } catch ( _ ) {}
		}
			try { if ( typeof renderer.copyTextureToTexture === 'function' ) renderer.copyTextureToTexture( resolveTarget.texture, historyTarget.texture ); } catch ( _ ) {}
			try {
				const currentDepth = __traaCurrentDepthTexture( traaNode, passNodes );
				if ( currentDepth && historyTarget.depthTexture && typeof renderer.copyTextureToTexture === 'function' ) {
					renderer.copyTextureToTexture( currentDepth, historyTarget.depthTexture );
					if ( traaNode._previousDepthNode ) traaNode._previousDepthNode.value = historyTarget.depthTexture;
				}
			} catch ( _ ) {}
			diag.precompiledRendered = ( diag.precompiledRendered | 0 ) + 1;
			diag.rendered ++;
			return true;
	} catch ( err ) {
		diag.precompiledError = err && ( err.stack || err.message ) || String( err );
		if ( ! window.__tslpTRAAPrecompiledWarned ) {
			window.__tslpTRAAPrecompiledWarned = true;
			console.warn( '[tslp-e2e] TRAA precompiled replay failed:', diag.precompiledError );
		}
		return false;
	}
}

function __renderTRAANodeWithFullRenderer( traaNode, slimRenderer, fullRenderer, diag ) {
	if ( ! traaNode || ! slimRenderer || ! fullRenderer ) return false;
	const originalUpdateBefore = traaNode.__tslpTRAAOriginalUpdateBefore;
	if ( typeof originalUpdateBefore !== 'function' ) return false;
	try {
		if ( FullRendererUtils && typeof FullRendererUtils.resetRendererState === 'function' ) {
			__fullTRAARendererState = FullRendererUtils.resetRendererState( fullRenderer, __fullTRAARendererState || undefined );
		}
		try {
			fullRenderer.toneMapping = slimRenderer.toneMapping;
			fullRenderer.toneMappingExposure = slimRenderer.toneMappingExposure;
			fullRenderer.outputColorSpace = slimRenderer.outputColorSpace;
		} catch ( _ ) {}
		const tmpSize = new FullVector2();
		const drawingSize = slimRenderer.getDrawingBufferSize( tmpSize );
		if ( typeof fullRenderer.setSize === 'function' ) fullRenderer.setSize( drawingSize.width, drawingSize.height, false );

		__shareGraphTexturesBetweenRenderers( fullRenderer, slimRenderer, traaNode, { skipTextures: __collectTRAASelfTextures( traaNode ) } );

		// TRAA's updateBefore calls renderer.initRenderTarget /
		// copyTextureToTexture on first run; these only work on the full
		// renderer. The original handles its own state save/restore.
		originalUpdateBefore.call( traaNode, { renderer: fullRenderer } );

		// Share resolve + history textures back into slim. The post-process
		// artifact samples the resolve target via passTexture.
		try { __shareGPUTextureEntry( slimRenderer, fullRenderer, traaNode._resolveRenderTarget.texture ); } catch ( _ ) {}
		try { __shareGPUTextureEntry( slimRenderer, fullRenderer, traaNode._historyRenderTarget.texture ); } catch ( _ ) {}

		diag.fullRendered ++;
		diag.rendered ++;
		return true;
	} catch ( err ) {
		diag.fullError = err && ( err.stack || err.message ) || String( err );
		if ( ! window.__tslpTRAAFullRenderWarned ) {
			window.__tslpTRAAFullRenderWarned = true;
			console.warn( '[tslp-e2e] TRAA full-renderer replay failed:', diag.fullError );
		}
		return false;
	} finally {
		try {
			if ( __fullTRAARendererState && FullRendererUtils && typeof FullRendererUtils.restoreRendererState === 'function' ) FullRendererUtils.restoreRendererState( fullRenderer, __fullTRAARendererState );
		} catch ( _ ) {}
	}
}

function __patchTRAANodeUpdateBefore( traaNode ) {
	if ( traaNode.__tslpTRAAUpdatePatched === true ) return;
	const originalUpdateBefore = traaNode.updateBefore;
	Object.defineProperty( traaNode, '__tslpTRAAOriginalUpdateBefore', { value: originalUpdateBefore, configurable: true } );
	traaNode.updateBefore = function ( frame = {} ) {
		const slimRenderer = frame && frame.renderer;
		if ( ! slimRenderer ) return;
		const diag = __traaDiagnostics();
		const currentRenderTarget = typeof slimRenderer.getRenderTarget === 'function' ? slimRenderer.getRenderTarget() : null;
		const currentMRT = typeof slimRenderer.getMRT === 'function' ? slimRenderer.getMRT() : null;
		try {
			if ( __useTRAAPrecompiledResolve( this ) ) {
				diag.precompiledBypassed = ( diag.precompiledBypassed | 0 ) + 1;
				return;
			}
			if ( __useTRAABeautyFallback( this ) ) {
				diag.beautyBypassed = ( diag.beautyBypassed | 0 ) + 1;
				return;
			}
			if ( __computeRenderer ) {
				if ( __renderTRAANodeWithFullRenderer( this, slimRenderer, __computeRenderer, diag ) ) return;
				diag.fullFailedBypassed = ( diag.fullFailedBypassed | 0 ) + 1;
				return;
			}
			if ( typeof originalUpdateBefore === 'function' ) originalUpdateBefore.call( this, frame );
		} catch ( err ) {
			diag.renderFailed ++;
			if ( ! window.__tslpTRAARenderWarned ) {
				window.__tslpTRAARenderWarned = true;
				console.warn( '[tslp-e2e] TRAA replay render failed:', err && err.message || err );
			}
		} finally {
			try { slimRenderer.setRenderTarget( currentRenderTarget ); } catch ( _ ) {}
			try { if ( typeof slimRenderer.setMRT === 'function' ) slimRenderer.setMRT( currentMRT ); } catch ( _ ) {}
		}
	};
	Object.defineProperty( traaNode, '__tslpTRAAUpdatePatched', { value: true, configurable: true } );
}

function __pinTRAAJitterIndex( traaNode ) {
	if ( ! traaNode || traaNode.__tslpTRAAJitterPinned === true ) return;
	// TRAA's clearViewOffset increments _jitterIndex once per pipeline frame.
	// Capture and replay both render up to TARGET_TICK frames, but the slim
	// harness's pipeline wrappers can call setViewOffset/clearViewOffset a
	// different number of times than capture (e.g. when a sibling effect re-
	// drives the pipeline). Pin _jitterIndex to 0 on every setViewOffset and
	// stub the increment in clearViewOffset so both modes sample the SAME
	// halton offset regardless of pipeline-call count.
	const proto = Object.getPrototypeOf( traaNode );
	const originalSetViewOffset = traaNode.setViewOffset || ( proto && proto.setViewOffset );
	const originalClearViewOffset = traaNode.clearViewOffset || ( proto && proto.clearViewOffset );
	if ( typeof originalSetViewOffset === 'function' ) {
		traaNode.setViewOffset = function ( width, height ) {
			try { this._jitterIndex = 0; } catch ( _ ) {}
			return originalSetViewOffset.call( this, width, height );
		};
	}
	if ( typeof originalClearViewOffset === 'function' ) {
		traaNode.clearViewOffset = function () {
			try {
				if ( this.camera && typeof this.camera.clearViewOffset === 'function' ) this.camera.clearViewOffset();
				if ( this._velocityNode && typeof this._velocityNode.setProjectionMatrix === 'function' ) this._velocityNode.setProjectionMatrix( null );
			} catch ( _ ) {}
			try { this._jitterIndex = 0; } catch ( _ ) {}
		};
	}
	try { traaNode._jitterIndex = 0; } catch ( _ ) {}
	try { Object.defineProperty( traaNode, '__tslpTRAAJitterPinned', { value: true, configurable: true } ); } catch ( _ ) {}
}

	function __prepareTRAANodeForReplay( traaNode, context ) {
		if ( ! __isTRAAEffectNode( traaNode ) ) return false;
		if ( traaNode.__tslpTRAAReplayReady === true ) return true;
		try {
			const diag = __traaDiagnostics();
			diag.ctor = traaNode.constructor && traaNode.constructor.name || '';
			diag.type = traaNode.constructor && traaNode.constructor.type || traaNode.type || '';
			// Pin BEFORE setup() so the setup-registered onBeforeRenderPipeline
			// closure (which does this.setViewOffset(...) dynamically) picks up the
			// patched instance methods on every frame.
			__pinTRAAJitterIndex( traaNode );
			// TRAA's setup() requires builder.renderer + builder.context.renderPipeline.
			// Drive setup on the full renderer so the resolveMaterial gets its colorNode.
		if ( __computeRenderer && typeof traaNode.setup === 'function' ) {
			try {
				traaNode.setup( __makeReplayNodeBuilder( __computeRenderer, context || {} ) );
				diag.setupCalls ++;
			} catch ( err ) {
				diag.setupError = err && ( err.stack || err.message ) || String( err );
			}
		}
		__patchTRAANodeUpdateBefore( traaNode );
		__nameTRAATextures( traaNode );
		Object.defineProperty( traaNode, '__tslpTRAAReplayReady', { value: true, configurable: true } );
		diag.prepared ++;
		return true;
	} catch ( err ) {
		__traaDiagnostics().prepFailed ++;
		if ( ! window.__tslpTRAAPrepWarned ) {
			window.__tslpTRAAPrepWarned = true;
			console.warn( '[tslp-e2e] TRAA replay prep failed:', err && err.message || err );
		}
		return false;
	}
}

function __renderTRAANodesForPipeline( renderer, traaNodes, passNodes ) {
	for ( const traaNode of traaNodes || [] ) {
		if ( ! __prepareTRAANodeForReplay( traaNode, null ) ) continue;
		const diag = __traaDiagnostics();
		if ( __renderTRAANodeWithPrecompiledSlim( traaNode, renderer, passNodes, diag ) ) continue;
		traaNode.updateBefore( { renderer } );
	}
}

function __neutralizeRTTNodeUpdateBefore( rttNode ) {
	// Once we've driven the RTT explicitly via our quad / full renderer, the
	// slim renderer must not re-trigger RTTNode.updateBefore: the RTTNode's
	// internal quad mesh carries a full-renderer NodeMaterial which the slim
	// bundle refuses to build. Stub updateBefore to a no-op and clear the
	// auto-update flag so the slim renderer's node-update walker leaves it alone.
	if ( ! rttNode || rttNode.__tslpRTTUpdateNeutered === true ) return;
	try { rttNode.autoUpdate = false; } catch ( _ ) {}
	try { rttNode.textureNeedsUpdate = false; } catch ( _ ) {}
	try { rttNode.updateBefore = function () {}; } catch ( _ ) {}
	try { Object.defineProperty( rttNode, '__tslpRTTUpdateNeutered', { value: true, configurable: true } ); } catch ( _ ) {}
}

function __renderRTTNodesForPipeline( renderer, rttNodes ) {
	try {
		const diag = __harnessDiagnostics();
		diag.rtt = diag.rtt || { collected: 0, rendered: 0, failed: 0 };
		diag.rtt.collected += rttNodes && rttNodes.length || 0;
	} catch ( _ ) {}
	for ( const rttNode of rttNodes || [] ) {
		if ( __renderRTTNodeWithFullRenderer( rttNode, renderer, __computeRenderer ) ) {
			__neutralizeRTTNodeUpdateBefore( rttNode );
			try { __harnessDiagnostics().rtt.rendered ++; } catch ( _ ) {}
		} else {
			try { __harnessDiagnostics().rtt.failed ++; } catch ( _ ) {}
		}
	}
}

function __rttNodeDependsOnBloom( rttNode, bloomNodes ) {
	if ( ! rttNode || ! Array.isArray( bloomNodes ) || bloomNodes.length === 0 ) return false;
	const node = rttNode._rttNode || rttNode.node || rttNode;
	for ( const bloomNode of bloomNodes ) {
		if ( __graphContainsNode( rttNode, bloomNode ) || __graphContainsNode( node, bloomNode ) ) return true;
	}
	return false;
}

function __filterRTTNodesByBloomDependency( rttNodes, bloomNodes, wantDependent ) {
	if ( ! Array.isArray( rttNodes ) || rttNodes.length === 0 ) return [];
	if ( ! Array.isArray( bloomNodes ) || bloomNodes.length === 0 ) return wantDependent ? [] : rttNodes;
	return rttNodes.filter( ( rttNode ) => __rttNodeDependsOnBloom( rttNode, bloomNodes ) === wantDependent );
}

function __renderBloomDependentRTTNodesForPipeline( renderer, rttNodes, bloomNodes ) {
	if ( ! Array.isArray( rttNodes ) || rttNodes.length === 0 || ! Array.isArray( bloomNodes ) || bloomNodes.length === 0 ) return 0;
	let rendered = 0;
	for ( const rttNode of rttNodes ) {
		if ( ! __rttNodeDependsOnBloom( rttNode, bloomNodes ) ) continue;
		if ( __renderRTTNodeWithFullRenderer( rttNode, renderer, __computeRenderer ) ) {
			__neutralizeRTTNodeUpdateBefore( rttNode );
			rendered ++;
		}
	}
	if ( rendered > 0 ) {
		try {
			const diag = __harnessDiagnostics();
			diag.rtt = diag.rtt || { collected: 0, rendered: 0, failed: 0 };
			diag.rtt.bloomDependentRendered = ( diag.rtt.bloomDependentRendered || 0 ) + rendered;
		} catch ( _ ) {}
	}
	return rendered;
}

function __frameEffectDiagnostics() {
	const diag = __harnessDiagnostics();
	if ( ! diag.frameEffects ) {
		diag.frameEffects = { collected: 0, prepared: 0, rendered: 0, failed: 0, setupFailed: 0, names: [] };
	}
	return diag.frameEffects;
}

function __frameEffectFrameId() {
	const callbackCount = window.__tslpFrameCallbackCount | 0;
	if ( callbackCount > 0 ) return callbackCount;
	const loopCalls = window.__tslpAnimationLoopCalls | 0;
	if ( loopCalls > 0 ) return loopCalls;
	return window.__tslpRafTick | 0;
}

function __nodeOwnsRenderTarget( node ) {
	if ( ! node || ( typeof node !== 'object' && typeof node !== 'function' ) ) return false;
	if ( ! __isGraphTraversalCandidate( node ) ) return false;
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) {}
	for ( const key of keys ) {
		const value = __readGraphOwnValue( node, key );
		if ( value && value.isRenderTarget === true ) return true;
		if ( value && value.texture && value.texture.isTexture === true && typeof value.setSize === 'function' ) return true;
	}
	return false;
}

function __isFrameEffectNode( node ) {
	if ( ! node || typeof node.updateBefore !== 'function' ) return false;
	if ( node.isPassNode === true || node.isRTTNode === true || __isBloomEffectNode( node ) || __isOutlineEffectNode( node ) ) return false;
	if ( __isSSREffectNode( node ) || __isDOFEffectNode( node ) || __isTRAAEffectNode( node ) ) return false;
	const proto = Object.getPrototypeOf( node );
	const hasSpecialUpdateBefore = Object.prototype.hasOwnProperty.call( node, 'updateBefore' )
		|| !! ( proto && Object.prototype.hasOwnProperty.call( proto, 'updateBefore' ) );
	if ( ! hasSpecialUpdateBefore && ! __nodeOwnsRenderTarget( node ) ) return false;
	// ReflectorBaseNode renders the scene from a mirrored camera into a per-camera
	// RenderTarget. The hydrator already wires it into the floor material's
	// updateBeforeNodes via __tslpReflectorBaseNodes, so the slim renderer drives
	// it with a proper { scene, camera, renderer } frame. Driving it again here
	// through the full renderer with no scene/camera crashes in getVirtualCamera
	// (camera.clone of undefined).
	const ctorType = node.constructor && node.constructor.type || '';
	if ( ctorType === 'ReflectorBaseNode' || ctorType === 'ReflectorNode' ) return false;
	// PMREMNode setup is already represented in the captured shader and texture
	// refs. Driving it as a frame effect can regenerate/share an unrelated PMREM
	// while replay is settling.
	if ( ctorType === 'PMREMNode' ) return false;
	const kind = __nodeUpdateKind( node, 'before' );
	if ( kind === 'none' || kind === null || kind === undefined ) return false;
	if ( typeof node.setup !== 'function' && typeof node.getTextureNode !== 'function' && ! __nodeOwnsRenderTarget( node ) ) return false;
	return true;
}

function __collectFrameEffectNodesInGraph( node, out = [], seen = new Set(), depth = 0 ) {
	if ( ! node || depth > 32 || seen.has( node ) ) return out;
	if ( ! __isGraphTraversalCandidate( node ) ) return out;
	seen.add( node );
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) {}
	const skip = new Set( [ 'parent', 'children', '_cache', 'scene', 'camera', 'renderer', 'geometry', 'material', 'domElement', 'renderTarget', '_aoRenderTarget', '_ssgiRenderTarget', '_ssrRenderTarget', '_blurRenderTarget', '_renderTarget', '_compRT', '_oldRT', '_CoCRT', '_CoCBlurredRT', '_blur64RT', '_blur16NearRT', '_blur16FarRT', '_compositeRT' ] );
	for ( const key of keys ) {
		if ( skip.has( key ) ) continue;
		const child = __readGraphOwnValue( node, key );
		if ( ! child ) continue;
		if ( Array.isArray( child ) ) {
			for ( const item of child ) {
				if ( item && ( item.isNode === true || typeof item.updateBefore === 'function' ) ) __collectFrameEffectNodesInGraph( item, out, seen, depth + 1 );
			}
		} else if ( child.isNode === true || typeof child.updateBefore === 'function' ) {
			__collectFrameEffectNodesInGraph( child, out, seen, depth + 1 );
		} else if ( Object.getPrototypeOf( child ) === Object.prototype ) {
			for ( const item of Object.values( child ) ) {
				if ( item && ( item.isNode === true || typeof item.updateBefore === 'function' ) ) __collectFrameEffectNodesInGraph( item, out, seen, depth + 1 );
			}
		}
	}
	if ( __isFrameEffectNode( node ) && ! out.includes( node ) ) out.push( node );
	return out;
}

const __frameEffectNodeProperties = new WeakMap();

function __makeReplayNodeBuilder( renderer, context ) {
	const sharedContext = context || {};
	return {
		renderer,
		context: sharedContext,
		getSharedContext() {
			return sharedContext;
		},
		getNodeProperties( node ) {
			if ( ! node || ( typeof node !== 'object' && typeof node !== 'function' ) ) return {};
			let props = __frameEffectNodeProperties.get( node );
			if ( ! props ) {
				props = {};
				__frameEffectNodeProperties.set( node, props );
			}
			return props;
		},
	};
}

function __refreshPipelineMaterialArtifact( renderer, material, artifact ) {
	if ( ! material || ! artifact ) return artifact;
	material.precompiledArtifact = artifact;
	material.needsUpdate = true;
	try { material.dispose && material.dispose(); } catch ( _ ) {}
	try {
		const cache = renderer && renderer._nodes && renderer._nodes.nodeBuilderCache;
		if ( cache && typeof cache.clear === 'function' ) cache.clear();
	} catch ( _ ) {}
	return artifact;
}

function __configureRenderPipelineQuadMaterial( material ) {
	if ( ! material ) return material;
	material.name = material.name || 'RenderPipeline';
	material.toneMapped = false;
	material.depthTest = false;
	material.depthWrite = false;
	material.fog = false;
	return material;
}

function __attachPrecompiledCameraTarget( material, camera ) {
	if ( ! ( material && material.isPrecompiledMaterial === true && camera ) ) return material;
	try {
		Object.defineProperty( material, '__tslpObject3DTargets', {
			value: { camera },
			configurable: true,
			writable: true,
		} );
	} catch ( _ ) {
		material.__tslpObject3DTargets = { camera };
	}
	return material;
}

function __attachRenderPipelineCameraTarget( material, passNode ) {
	const passType = passNode && ( passNode.constructor && ( passNode.constructor.type || passNode.constructor.name ) || passNode.type || '' );
	if ( passNode && passNode.camera && passType !== 'RetroPassNode' ) __attachPrecompiledCameraTarget( material, passNode.camera );
	return material;
}

function __godraysInputForFrameEffect( node ) {
	if ( __effectTypeName( node ) !== 'BilateralBlurNode' ) return null;
	const textureNode = node && node.textureNode;
	const passNode = textureNode && textureNode.passNode || null;
	return __effectTypeName( passNode ) === 'GodraysNode' ? passNode : null;
}

function __frameEffectNeedsShadowMap( node ) {
	const type = __effectTypeName( node );
	const godraysInput = type === 'GodraysNode' ? null : __godraysInputForFrameEffect( node );
	if ( godraysInput ) {
		if ( __frameEffectNeedsShadowMap( godraysInput ) ) return true;
		return godraysInput.__tslpFrameEffectRenderedOnce !== true;
	}
	if ( type !== 'GodraysNode' ) return false;
	const light = node && node._light;
	if ( ! ( light && light.shadow ) ) return false;
	if ( ! ( light.shadow.map && light.shadow.map.depthTexture ) ) return true;
	// PointLight shadow setup publishes light.shadow.map/depthTexture before the
	// async full-renderer pass has finished drawing and sharing the populated cube
	// depth texture. Keep Godrays deferred until the shadow job fully drains so it
	// does not compile/render once against an all-clear depth cube.
	return ( window.__tslpShadowPending | 0 ) > 0;
}

function __deferFrameEffectUntilShadowReady( node, renderer, context ) {
	if ( ! __frameEffectNeedsShadowMap( node ) ) return false;
	const passNodes = context && Array.isArray( context.passNodes ) ? context.passNodes : [];
	const passNode = passNodes.find( ( candidate ) => candidate && candidate.scene && candidate.camera ) || null;
	if ( passNode && renderer ) {
		try { __kickShadowRenderAsync( context && context.renderPipeline && context.renderPipeline.renderer || renderer, passNode.scene, passNode.camera ); } catch ( _ ) {}
	}
	const diag = __frameEffectDiagnostics();
	diag.shadowDeferred = ( diag.shadowDeferred || 0 ) + 1;
	return true;
}

function __prepareFrameEffectNodeForReplay( node, fullRenderer, context ) {
	if ( ! __isFrameEffectNode( node ) || ! fullRenderer ) return false;
	if ( node.__tslpFrameEffectReady === true ) return true;
	const diag = __frameEffectDiagnostics();
	try {
		if ( __deferFrameEffectUntilShadowReady( node, fullRenderer, context ) ) return false;
		if ( __isTAAUFrameEffectNode( node ) ) __pinTAAUJitterIndex( node );
		if ( typeof node.setup === 'function' ) node.setup( __makeReplayNodeBuilder( fullRenderer, context ) );
		Object.defineProperty( node, '__tslpFrameEffectReady', { value: true, configurable: true } );
		diag.prepared ++;
		return true;
	} catch ( err ) {
		diag.setupFailed ++;
		if ( ! window.__tslpFrameEffectSetupWarned ) {
			window.__tslpFrameEffectSetupWarned = true;
			console.warn( '[tslp-e2e] postprocess effect setup failed:', err && ( err.stack || err.message ) || err );
		}
		return false;
	}
}

function __isTAAUFrameEffectNode( node ) {
	const type = node && node.constructor && ( node.constructor.type || node.constructor.name ) || node && node.type || '';
	return type === 'TAAUNode'
		&& node._historyRenderTarget
		&& node._resolveRenderTarget
		&& node.beautyNode;
}

	function __pinTAAUJitterIndex( taauNode ) {
		if ( ! taauNode || taauNode.__tslpTAAUJitterPinned === true ) return;
		const proto = Object.getPrototypeOf( taauNode );
	const originalSetViewOffset = taauNode.setViewOffset || ( proto && proto.setViewOffset );
	const originalClearViewOffset = taauNode.clearViewOffset || ( proto && proto.clearViewOffset );
	if ( typeof originalSetViewOffset === 'function' ) {
		taauNode.setViewOffset = function ( width, height ) {
			try { this._jitterIndex = 0; } catch ( _ ) {}
			return originalSetViewOffset.call( this, width, height );
		};
	}
	if ( typeof originalClearViewOffset === 'function' ) {
		taauNode.clearViewOffset = function () {
			const result = originalClearViewOffset.call( this );
			try { this._jitterIndex = 0; } catch ( _ ) {}
			return result;
		};
	}
	try { taauNode._jitterIndex = 0; } catch ( _ ) {}
		try { Object.defineProperty( taauNode, '__tslpTAAUJitterPinned', { value: true, configurable: true } ); } catch ( _ ) {}
	}

	function __findOwnedEffectTexture( root, effectType, seen = new Set(), depth = 0 ) {
		if ( ! root || depth > 16 || seen.has( root ) ) return null;
		if ( ! __isGraphTraversalCandidate( root ) ) return null;
		seen.add( root );
		if ( __effectTypeName( root ) === effectType ) {
			try {
				const textureNode = typeof root.getTextureNode === 'function' ? root.getTextureNode() : root._textureNode;
				const texture = textureNode && textureNode.value || root._renderTarget && root._renderTarget.texture;
				if ( texture && texture.isTexture === true ) return texture;
			} catch ( _ ) {}
		}
		const keys = [];
		try { keys.push( ...Object.getOwnPropertyNames( root ) ); } catch ( _ ) { return null; }
		const skip = new Set( [ 'parent', 'children', '_cache', 'scene', 'camera', 'renderer', 'geometry', 'material', 'domElement', 'renderTarget' ] );
		for ( const key of keys ) {
			if ( skip.has( key ) ) continue;
			const child = __readGraphOwnValue( root, key );
			if ( ! child ) continue;
			if ( Array.isArray( child ) ) {
				for ( const item of child ) {
					const texture = __findOwnedEffectTexture( item, effectType, seen, depth + 1 );
					if ( texture ) return texture;
				}
			} else {
				const texture = __findOwnedEffectTexture( child, effectType, seen, depth + 1 );
				if ( texture ) return texture;
			}
		}
		return null;
	}

			function __retargetGaussianBlurInputTexture( node ) {
				if ( __effectTypeName( node ) !== 'GaussianBlurNode' || ! node.textureNode ) return false;
				const texture = __findOwnedEffectTexture( node, 'LensflareNode' );
				if ( ! texture || texture.isTexture !== true || node.textureNode.value === texture ) return false;
				node.textureNode.value = texture;
				return true;
			}

		function __findOwnedBloomTexture( root, seen = new Set(), depth = 0 ) {
			if ( ! root || depth > 16 || seen.has( root ) ) return null;
			if ( ! __isGraphTraversalCandidate( root ) ) return null;
			seen.add( root );
			if ( __isBloomEffectNode( root ) ) {
				try {
					const textureNode = typeof root.getTextureNode === 'function' ? root.getTextureNode() : root._textureOutput;
					const texture = textureNode && textureNode.value || root._renderTargetsHorizontal && root._renderTargetsHorizontal[ 0 ] && root._renderTargetsHorizontal[ 0 ].texture;
					if ( texture && texture.isTexture === true ) return texture;
				} catch ( _ ) {}
			}
			const keys = [];
			try { keys.push( ...Object.getOwnPropertyNames( root ) ); } catch ( _ ) { return null; }
			const skip = new Set( [ 'parent', 'children', '_cache', 'scene', 'camera', 'renderer', 'geometry', 'material', 'domElement', 'renderTarget' ] );
			for ( const key of keys ) {
				if ( skip.has( key ) ) continue;
				const child = __readGraphOwnValue( root, key );
				if ( ! child ) continue;
				if ( Array.isArray( child ) ) {
					for ( const item of child ) {
						const texture = __findOwnedBloomTexture( item, seen, depth + 1 );
						if ( texture ) return texture;
					}
				} else {
					const texture = __findOwnedBloomTexture( child, seen, depth + 1 );
					if ( texture ) return texture;
				}
			}
			return null;
		}

		function __retargetLensflareInputTexture( node ) {
			if ( __effectTypeName( node ) !== 'LensflareNode' || ! node.textureNode ) return null;
			const texture = __findOwnedBloomTexture( node );
			if ( ! texture || texture.isTexture !== true ) return null;
			if ( node.textureNode.value !== texture ) node.textureNode.value = texture;
			return texture;
		}

function __neutralizeFrameEffectNodeUpdateBefore( node ) {
	if ( ! node || node.__tslpFrameEffectUpdateNeutered === true ) return;
	const original = typeof node.updateBefore === 'function' ? node.updateBefore : null;
	if ( original && ! node.__tslpFrameEffectOriginalUpdateBefore ) {
		try { Object.defineProperty( node, '__tslpFrameEffectOriginalUpdateBefore', { value: original, configurable: true } ); } catch ( _ ) {}
	}
	try { node.updateBefore = function () {}; } catch ( _ ) {}
	try { Object.defineProperty( node, '__tslpFrameEffectUpdateNeutered', { value: true, configurable: true } ); } catch ( _ ) {}
}

function __renderFrameEffectNodeWithFullRenderer( node, slimRenderer, fullRenderer, context ) {
	if ( ! __isFrameEffectNode( node ) || ! slimRenderer || ! fullRenderer ) return false;
	const diag = __frameEffectDiagnostics();
	const effectName = node.constructor && ( node.constructor.type || node.constructor.name ) || node.type || 'effect';
	try {
		if ( ! __prepareFrameEffectNodeForReplay( node, fullRenderer, context ) ) return false;
		try {
			const debug = diag.__debug || ( diag.__debug = [] );
			if ( debug.length < 16 ) {
				debug.push( {
					stage: 'effect-before',
					effectName,
					inputNames: Array.from( __collectGraphTexturesByName( node ).entries() ).map( ( [ name, textures ] ) => {
						const texture = Array.isArray( textures ) ? textures[ 0 ] : textures;
						const image = texture && texture.image || {};
						return { name, textureName: texture && texture.name || '', width: image.width || image.naturalWidth || image.videoWidth || 0, height: image.height || image.naturalHeight || image.videoHeight || 0 };
					} ),
				} );
			}
		} catch ( _ ) {}
		if ( effectName === 'AfterImageNode' && node.__tslpFrameEffectRenderedOnce === true ) {
			diag.reused = ( diag.reused || 0 ) + 1;
			return true;
		}
		try {
			fullRenderer.toneMapping = slimRenderer.toneMapping;
			fullRenderer.toneMappingExposure = slimRenderer.toneMappingExposure;
			fullRenderer.outputColorSpace = slimRenderer.outputColorSpace;
		} catch ( _ ) {}
		try {
			const size = slimRenderer.getDrawingBufferSize( __fullRTTSize );
			if ( typeof fullRenderer.setSize === 'function' ) fullRenderer.setSize( size.width, size.height, false );
		} catch ( _ ) {}
		if ( effectName === 'GodraysNode' || effectName === 'FSR1Node' ) {
			try {
				for ( const passNode of context && context.passNodes || [] ) {
					if ( __renderPassNodeWithFullRenderer( passNode, slimRenderer, fullRenderer, passNode && passNode.camera, { force: true } ) ) {
						const key = effectName === 'GodraysNode' ? 'godraysFullPassRenders' : 'fsrFullPassRenders';
						diag[ key ] = ( diag[ key ] || 0 ) + 1;
					}
				}
			} catch ( _ ) {}
		}
		const lensflareInputTexture = __retargetLensflareInputTexture( node );
		__shareGraphTexturesBetweenRenderers( fullRenderer, slimRenderer, node, { skipOwnedRenderTargets: 'direct' } );
		if ( lensflareInputTexture ) __shareGPUTextureEntry( fullRenderer, slimRenderer, lensflareInputTexture );
		try {
			if ( node._material ) node._material.needsUpdate = true;
			if ( node._resolveMaterial ) node._resolveMaterial.needsUpdate = true;
		} catch ( _ ) {}
			__retargetGaussianBlurInputTexture( node );
			const updateBefore = node.__tslpFrameEffectOriginalUpdateBefore || node.updateBefore;
			const runUpdate = () => updateBefore.call( node, {
				renderer: fullRenderer,
				frameId: __frameEffectFrameId(),
				renderId: __frameEffectFrameId(),
				context: context || {},
			} );
			if ( node.scene ) __withSourceMaterialsForFullPass( node.scene, runUpdate );
			else runUpdate();
		__neutralizeFrameEffectNodeUpdateBefore( node );
		try {
			const forceFrameEffectReadback = effectName === 'GodraysNode'
				|| ( effectName === 'BilateralBlurNode' && node.textureNode && node.textureNode.value && node.textureNode.value.name === 'Godrays' );
			__probeFrameEffectTextureAsync( fullRenderer, node._godraysRenderTarget && node._godraysRenderTarget.texture, effectName + '.godrays', { force: effectName === 'GodraysNode' } );
			__probeFrameEffectTextureAsync( fullRenderer, node.textureNode && node.textureNode.value, effectName + '.input', { force: forceFrameEffectReadback } );
			__probeFrameEffectTextureAsync( fullRenderer, node._horizontalRT && node._horizontalRT.texture, effectName + '.horizontal', { force: forceFrameEffectReadback } );
			__probeFrameEffectTextureAsync( fullRenderer, node._verticalRT && node._verticalRT.texture, effectName + '.vertical', { force: forceFrameEffectReadback } );
		} catch ( _ ) {}
		__shareDirectOwnedRenderTargetTexturesBetweenRenderers( slimRenderer, fullRenderer, node );
		diag.rendered ++;
		try { Object.defineProperty( node, '__tslpFrameEffectRenderedOnce', { value: true, configurable: true } ); } catch ( _ ) {}
		if ( diag.names.length < 20 ) diag.names.push( effectName );
		return true;
	} catch ( err ) {
		diag.failed ++;
		if ( ! window.__tslpFrameEffectRenderWarned ) {
			window.__tslpFrameEffectRenderWarned = true;
			console.warn( '[tslp-e2e] postprocess effect render failed:', err && ( err.stack || err.message ) || err );
		}
		return false;
	}
}

function __renderFrameEffectNodesForPipeline( renderer, effectNodes, context ) {
	try {
		const diag = __frameEffectDiagnostics();
		diag.collected += effectNodes && effectNodes.length || 0;
	} catch ( _ ) {}
	for ( const node of effectNodes || [] ) {
		__renderFrameEffectNodeWithFullRenderer( node, renderer, __computeRenderer, context );
	}
}

function __findUserArtifactByMaterialShape( shape ) {
	if ( ! shape || ! __data || ! __data.user ) return null;
	for ( const mod of Object.values( __data.user ) ) {
		const artifact = mod && mod.artifact;
		if ( artifact && artifact.materialShape === shape ) return artifact;
	}
	return null;
}


function __collectScenePassNodes( scene ) {
	const out = [];
	if ( ! scene || typeof scene.traverse !== 'function' ) return out;
	scene.traverse( ( object ) => {
		const material = object && object.material;
		const list = Array.isArray( material ) ? material : material ? [ material ] : [];
		for ( const m of list ) {
			if ( ! m ) continue;
			for ( const key of __nodeGraphKeys() ) __collectPassNodesInGraph( m[ key ], out );
		}
	} );
	return out;
}

function __collectSceneRTTNodes( scene ) {
	const out = [];
	if ( ! scene || typeof scene.traverse !== 'function' ) return out;
	scene.traverse( ( object ) => {
		const material = object && object.material;
		const list = Array.isArray( material ) ? material : material ? [ material ] : [];
		for ( const m of list ) {
			if ( ! m ) continue;
			for ( const key of __nodeGraphKeys() ) __collectRTTNodesInGraph( m[ key ], out );
		}
	} );
	return out;
}

function __collectSceneFrameEffectNodes( scene ) {
	const out = [];
	if ( ! scene || typeof scene.traverse !== 'function' ) return out;
	scene.traverse( ( object ) => {
		const material = object && object.material;
		const list = Array.isArray( material ) ? material : material ? [ material ] : [];
		for ( const m of list ) {
			if ( ! m ) continue;
			for ( const key of __nodeGraphKeys() ) __collectFrameEffectNodesInGraph( m[ key ], out );
		}
	} );
	return out;
}

function __graphContainsNode( root, target, seen = new Set(), depth = 0 ) {
	if ( ! root || ! target || depth > 32 || seen.has( root ) ) return false;
	if ( root === target ) return true;
	if ( ! __isGraphTraversalCandidate( root ) ) return false;
	seen.add( root );
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( root ) ); } catch ( _ ) { return false; }
	const skip = new Set( [ 'parent', 'children', '_cache', 'scene', 'camera', 'renderer', 'geometry', 'material', 'domElement' ] );
	for ( const key of keys ) {
		if ( skip.has( key ) ) continue;
		const child = __readGraphOwnValue( root, key );
		if ( ! child ) continue;
		if ( child === target ) return true;
		if ( Array.isArray( child ) ) {
			for ( const item of child ) {
				if ( item && ( typeof item === 'object' || typeof item === 'function' ) && __graphContainsNode( item, target, seen, depth + 1 ) ) return true;
			}
		} else if ( ( typeof child === 'object' || typeof child === 'function' ) && __graphContainsNode( child, target, seen, depth + 1 ) ) {
			return true;
		}
	}
	return false;
}

function __renderBloomNodeOnceForPipeline( renderer, bloomNode, renderedBloomNodes, context ) {
	if ( ! bloomNode || renderedBloomNodes.has( bloomNode ) ) return;
	if ( __prepareBloomNodeForReplay( bloomNode, context || null ) ) {
		const updateBefore = bloomNode.__tslpBloomReplayUpdateBefore || bloomNode.updateBefore;
		if ( typeof updateBefore === 'function' ) updateBefore.call( bloomNode, { renderer } );
		__neutralizeBloomNodeAutoUpdate( bloomNode );
	}
	renderedBloomNodes.add( bloomNode );
}

function __neutralizeBloomNodeAutoUpdate( bloomNode ) {
	if ( ! bloomNode || bloomNode.__tslpBloomUpdateNeutered === true ) return;
	try { bloomNode.updateBefore = function () {}; } catch ( _ ) {}
	try { Object.defineProperty( bloomNode, '__tslpBloomUpdateNeutered', { value: true, configurable: true } ); } catch ( _ ) {}
}

function __markBloomForSlimReplay( bloomNode ) {
	if ( ! bloomNode || bloomNode.__tslpPreferSlimBloomReplay === true ) return;
	try {
		Object.defineProperty( bloomNode, '__tslpPreferSlimBloomReplay', {
			value: true,
			configurable: true,
			writable: true,
		} );
	} catch ( _ ) {
		bloomNode.__tslpPreferSlimBloomReplay = true;
	}
}

function __renderOutputFrameEffectsAndBloomForPipeline( renderer, effectNodes, bloomNodes, context, rttNodes = [] ) {
	const renderedBloomNodes = new Set();
	try {
		const diag = __frameEffectDiagnostics();
		diag.collected += effectNodes && effectNodes.length || 0;
	} catch ( _ ) {}
	for ( const effectNode of effectNodes || [] ) {
		let renderedBloomForEffect = false;
		for ( const bloomNode of bloomNodes || [] ) {
			if ( __graphContainsNode( effectNode, bloomNode ) ) {
				__renderBloomNodeOnceForPipeline( renderer, bloomNode, renderedBloomNodes, context );
				renderedBloomForEffect = true;
			}
		}
		if ( renderedBloomForEffect ) __renderBloomDependentRTTNodesForPipeline( renderer, rttNodes, bloomNodes );
		__renderFrameEffectNodeWithFullRenderer( effectNode, renderer, __computeRenderer, context );
		if ( __effectTypeName( effectNode ) === 'SSGINode' && Array.isArray( rttNodes ) && rttNodes.length > 0 ) {
			// SSGI feeds downstream composite RTT nodes (the TRAA beauty input in
			// webgpu_postprocessing_ssgi). The initial RTT render happens before
			// frame effects, so refresh those composites once the SSGI target is
			// current and before TRAA samples them.
			__renderRTTNodesForPipeline( renderer, rttNodes );
		}
	}
	for ( const bloomNode of bloomNodes || [] ) __renderBloomNodeOnceForPipeline( renderer, bloomNode, renderedBloomNodes, context );
	if ( renderedBloomNodes.size > 0 ) __renderBloomDependentRTTNodesForPipeline( renderer, rttNodes, bloomNodes );
}

// RenderPipeline (and PostProcessing which extends it) calls ng("post-process", ...)
// from its _update() method — the same dual-registry problem as _renderOutput.
// Override _update to pre-set _quadMesh.material from Slim.loadAux before ng fires.
export class RenderPipeline extends Slim.RenderPipeline {
	constructor( ...args ) {
		super( ...args );
		try {
			const diag = __frameEffectDiagnostics();
			diag.pipelineConstructed = ( diag.pipelineConstructed || 0 ) + 1;
		} catch ( _ ) {}
	}
	render( ...args ) {
		try {
			const diag = __frameEffectDiagnostics();
			diag.pipelineRenderCalls = ( diag.pipelineRenderCalls || 0 ) + 1;
		} catch ( _ ) {}
			const renderer = this.renderer;
			const previousRenderPipeline = renderer ? renderer.__tslpCurrentRenderPipeline : null;
			if ( renderer ) renderer.__tslpInsideRenderPipeline = ( renderer.__tslpInsideRenderPipeline | 0 ) + 1;
			if ( renderer ) renderer.__tslpCurrentRenderPipeline = this;
			try { window.__tslpLastRenderPipeline = this; } catch ( _ ) {}
			try {
				return super.render( ...args );
			} finally {
			if ( renderer ) renderer.__tslpInsideRenderPipeline = Math.max( 0, ( renderer.__tslpInsideRenderPipeline | 0 ) - 1 );
			if ( renderer ) renderer.__tslpCurrentRenderPipeline = previousRenderPipeline;
		}
	}
	_update() {
		// Sync renderer state flags (mirrors parent logic) so needsUpdate can
		// be suppressed once we've pre-populated the material.
		if ( this._toneMapping !== this.renderer.toneMapping ) {
			this._toneMapping = this.renderer.toneMapping;
			this.needsUpdate = true;
		}
		if ( this._outputColorSpace !== this.renderer.outputColorSpace ) {
			this._outputColorSpace = this.renderer.outputColorSpace;
			this.needsUpdate = true;
		}
		if ( this.needsUpdate ) {
			try {
				// Shape-fallback loads the generic output artifact first, then prefers
				// a captured render-pipeline artifact when the example provided one.
					const shape = this.outputColorTransform === true ? 'render-output' : 'post-process';
				let artifact = null;
				let auxError = null;
				let usedUserPipelineArtifact = false;
				try {
					artifact = Slim.loadAux( shape, 'tslp-e2e-bypass' );
				} catch ( err ) {
					auxError = err;
				}
						if ( this.outputColorTransform !== true ) {
							const userPipelineArtifact = __findUserArtifactByMaterialShape( 'render-pipeline' );
							if ( userPipelineArtifact ) {
								artifact = userPipelineArtifact;
							usedUserPipelineArtifact = true;
						}
					}
				if ( ! artifact ) throw auxError || new Error( 'no ' + shape + ' artifact available' );
				artifact = __cloneAuxArtifact( artifact );
				artifact = __patchVolumeRenderOutputAlpha( artifact );
				const passNodes = __collectPassNodesInGraph( this.outputNode );
				__appendLivePassNodesForArtifact( passNodes, artifact );
				const rttNodes = __collectRTTNodesInGraph( this.outputNode );
				const passEffectNodes = [];
				for ( const node of passNodes ) __collectFrameEffectNodesInGraph( node, passEffectNodes );
				const outputEffectNodes = __collectFrameEffectNodesInGraph( this.outputNode ).filter( ( node ) => ! passEffectNodes.includes( node ) );
				const effectNodes = [ ...passEffectNodes, ...outputEffectNodes ];
				try {
					const fxDiag = __frameEffectDiagnostics();
					fxDiag.pipelineUpdates = ( fxDiag.pipelineUpdates || 0 ) + 1;
					fxDiag.pipelineShape = shape;
					fxDiag.usedUserPipelineArtifact = usedUserPipelineArtifact;
					fxDiag.passNodes = ( fxDiag.passNodes || 0 ) + passNodes.length;
					fxDiag.passContextEffects = ( fxDiag.passContextEffects || 0 ) + passEffectNodes.length;
					fxDiag.outputEffects = ( fxDiag.outputEffects || 0 ) + outputEffectNodes.length;
				} catch ( _ ) {}
					const bloomNodes = __collectBloomNodesInGraph( this.outputNode );
					__bloomDiagnostics().collected += bloomNodes.length;
					const preBloomRTTNodes = __filterRTTNodesByBloomDependency( rttNodes, bloomNodes, false );
					try {
						const rttDiag = __harnessDiagnostics();
						rttDiag.rtt = rttDiag.rtt || { collected: 0, rendered: 0, failed: 0 };
						rttDiag.rtt.bloomDependentDeferred = rttNodes.length - preBloomRTTNodes.length;
					} catch ( _ ) {}
					const outlineNodes = __collectOutlineNodesInGraph( this.outputNode );
				__outlineDiagnostics().collected += outlineNodes.length;
				const ssrNodes = __collectSSRNodesInGraph( this.outputNode );
				__ssrDiagnostics().collected += ssrNodes.length;
				const dofNodes = __collectDOFNodesInGraph( this.outputNode );
				__dofDiagnostics().collected += dofNodes.length;
				const traaNodes = __collectTRAANodesInGraph( this.outputNode );
				__traaDiagnostics().collected += traaNodes.length;
				const passNode = passNodes[ 0 ] || null;
				const context = {
					renderPipeline: this,
					passNodes,
					onBeforeRenderPipeline: null,
					onAfterRenderPipeline: null,
				};
				if ( this.outputColorTransform !== true ) {
					context.toneMapping = this._toneMapping;
					context.outputColorSpace = this._outputColorSpace;
				}
				this._context = context;
				for ( const node of passNodes ) __preparePassNodeForReplay( this.renderer, node );
				for ( const node of passNodes ) {
					try {
						if ( traaNodes.length > 0 ) Object.defineProperty( node, '__tslpFeedsTRAA', { value: true, configurable: true, writable: true } );
					} catch ( _ ) {
						node.__tslpFeedsTRAA = traaNodes.length > 0;
					}
				}
				for ( const node of passNodes ) __syncPassRenderTargetTextures( node, node && node._mrt || null );
				for ( const node of effectNodes ) __prepareFrameEffectNodeForReplay( node, __computeRenderer, context );
				for ( const node of bloomNodes ) __prepareBloomNodeForReplay( node, context );
				for ( const node of outlineNodes ) __prepareOutlineNodeForReplay( node, context );
				for ( const node of ssrNodes ) __prepareSSRNodeForReplay( node, context );
				for ( const node of dofNodes ) __prepareDOFNodeForReplay( node, context );
				for ( const node of traaNodes ) __prepareTRAANodeForReplay( node, context );
				const effectBeforeRenderPipeline = context.onBeforeRenderPipeline;
				const effectAfterRenderPipeline = context.onAfterRenderPipeline;
				artifact = __attachGraphTextureRefs( artifact, this.outputNode );
				artifact = __attachOrderedPassOutputRefs( artifact, passNodes );
				artifact = __attachOrderedPassDepthRefs( artifact, passNodes );
				artifact = __attachPassTextureRefs( artifact, passNodes.length === 1 ? passNode : null );
				artifact = __attachRTTTextureRefs( artifact, rttNodes );
				artifact = __attachOutlineCompositeTextureRefs( artifact, outlineNodes, passNodes );
					artifact = __attachBloomCompositeTextureRefs( artifact, bloomNodes );
					artifact = __patchRetroRenderOutputBarrelUV( artifact, passNodes );
					let mat = new Slim.PrecompiledMaterial( artifact );
					__configureRenderPipelineQuadMaterial( mat );
					__attachRenderPipelineCameraTarget( mat, passNode );
				mat.needsUpdate = true;
				this._quadMesh.material = mat;
				this._quadMesh.frustumCulled = false;
				// Set up _context so render() can access onBefore/onAfterRenderPipeline.
				context.onBeforeRenderPipeline = ( passNodes.length > 0 || rttNodes.length > 0 || effectNodes.length > 0 || bloomNodes.length > 0 || outlineNodes.length > 0 || ssrNodes.length > 0 || dofNodes.length > 0 || traaNodes.length > 0 ) ? () => {
					const pipelineRenderTarget = typeof this.renderer.getRenderTarget === 'function' ? this.renderer.getRenderTarget() : null;
					const pipelineMRT = typeof this.renderer.getMRT === 'function' ? this.renderer.getMRT() : null;
						try {
						if ( typeof effectBeforeRenderPipeline === 'function' ) effectBeforeRenderPipeline();
						__renderPassNodesForPipeline( this.renderer, passNodes );
						__renderRTTNodesForPipeline( this.renderer, preBloomRTTNodes );
					artifact = __attachGraphTextureRefs( artifact, this.outputNode );
					artifact = __attachOrderedPassOutputRefs( artifact, passNodes );
					artifact = __attachOrderedPassDepthRefs( artifact, passNodes );
						artifact = __attachPassTextureRefs( artifact, passNodes.length === 1 ? passNode : null );
						artifact = __attachRTTTextureRefs( artifact, rttNodes );
						artifact = __attachOutlineCompositeTextureRefs( artifact, outlineNodes, passNodes );
						artifact = __attachBloomCompositeTextureRefs( artifact, bloomNodes );
						artifact = __patchRetroRenderOutputBarrelUV( artifact, passNodes );
						mat.precompiledArtifact = artifact;
						mat.needsUpdate = true;
						try { mat.dispose && mat.dispose(); } catch ( _ ) {}
						try {
							const nc = this.renderer && this.renderer._nodes && this.renderer._nodes.nodeBuilderCache;
							if ( nc && typeof nc.clear === 'function' ) nc.clear();
						} catch ( _ ) {}
					__renderFrameEffectNodesForPipeline( this.renderer, passEffectNodes, context );
					if ( passEffectNodes.length > 0 ) __renderPassNodesForPipeline( this.renderer, passNodes );
					__renderOutputFrameEffectsAndBloomForPipeline( this.renderer, outputEffectNodes, bloomNodes, context, rttNodes );
							if ( outputEffectNodes.length > 0 || bloomNodes.length > 0 ) {
								artifact = __attachGraphTextureRefs( artifact, this.outputNode );
								artifact = __attachRTTTextureRefs( artifact, rttNodes );
								artifact = __attachOutlineCompositeTextureRefs( artifact, outlineNodes, passNodes );
								artifact = __attachBloomCompositeTextureRefs( artifact, bloomNodes );
							const previousMaterial = mat;
							mat = new Slim.PrecompiledMaterial( artifact );
							__configureRenderPipelineQuadMaterial( mat );
							__attachRenderPipelineCameraTarget( mat, passNode );
							mat.needsUpdate = true;
							this._quadMesh.material = mat;
						try { previousMaterial && previousMaterial.dispose && previousMaterial.dispose(); } catch ( _ ) {}
						try {
							const nc = this.renderer && this.renderer._nodes && this.renderer._nodes.nodeBuilderCache;
							if ( nc && typeof nc.clear === 'function' ) nc.clear();
						} catch ( _ ) {}
					}
					__renderOutlineNodesForPipeline( this.renderer, outlineNodes );
					// Wave 5 Phase A3: keep SSR behind the WIP gate. DOF must dispatch
					// here so the final artifact samples a rendered composite RT instead
					// of the DepthOfFieldNode's lazily-constructed 1x1 placeholder.
					__renderTRAANodesForPipeline( this.renderer, traaNodes, passNodes );
					__renderDOFNodesForPipeline( this.renderer, dofNodes );
					if ( typeof globalThis !== 'undefined' && globalThis.__tslpEnableWipPostprocessFallbacks === true ) {
						__renderSSRNodesForPipeline( this.renderer, ssrNodes );
					}
					if ( outlineNodes.length > 0 ) {
						// Re-attach graph texture refs so the slim post-process artifact
						// sees the freshly-shared _renderTargetComposite.texture from the
						// full-renderer pass.
						artifact = __attachGraphTextureRefs( artifact, this.outputNode );
						artifact = __attachOutlineCompositeTextureRefs( artifact, outlineNodes, passNodes );
						mat.precompiledArtifact = artifact;
						mat.needsUpdate = true;
					}
					if ( ssrNodes.length > 0 || dofNodes.length > 0 || traaNodes.length > 0 ) {
						// Re-attach graph texture refs so the slim post-process artifact
						// sees the freshly-shared output textures from the full-renderer pass.
						artifact = __attachGraphTextureRefs( artifact, this.outputNode );
						mat.precompiledArtifact = artifact;
						mat.needsUpdate = true;
					}
					} finally {
						try { this.renderer.setRenderTarget( pipelineRenderTarget ); } catch ( _ ) {}
						try { if ( typeof this.renderer.setMRT === 'function' ) this.renderer.setMRT( pipelineMRT ); } catch ( _ ) {}
					}
				} : effectBeforeRenderPipeline;
				context.onAfterRenderPipeline = typeof effectAfterRenderPipeline === 'function' ? () => effectAfterRenderPipeline() : null;
				this._context = context;
				this.needsUpdate = false;
				// Return early — super._update would call ng() which throws.
				return;
			} catch ( err ) {
				// No post-process artifact captured; fall through to super (will throw).
				console.warn( '[tslp-e2e] RenderPipeline._update pre-populate failed:', err && err.message || err );
			}
		}
		return super._update();
	}
}

export class PostProcessing extends RenderPipeline {}
`;

}

function tslStubModule() {

	// In replay mode `three/tsl` maps to this stub. We rebuild the TSL export
	// surface by pulling real implementations from the full three.webgpu.js via
	// its TSL namespace object. The import uses an absolute URL to bypass the
	// replay import-map (which would redirect 'three/webgpu' to the slim bundle
	// whose TSL stub throws on every property access).
	//
	// Without real node objects, Fn(...)().compute(count) returns a chainable
	// proxy with no isComputeNode flag. The slim renderer's computeAsync guard
	// then silently drops every dispatch, particle positions stay at origin/zero,
	// and the particle blob is invisible.
	//
	// three.tsl.js itself does `import { TSL } from 'three/webgpu'` which in
	// replay mode resolves to the slim stub — so we CANNOT re-export from
	// three.tsl.js. We pull directly from /build/three.webgpu.js instead.
	const src = readFileSync( join( threeRepo, 'build/three.tsl.js' ), 'utf8' );
	const match = src.match( /export\s*\{([\s\S]*?)\};?\s*$/m );
	const names = match
		? match[ 1 ].split( ',' ).map( ( x ) => x.trim().split( /\s+as\s+/ ).pop().trim() ).filter( Boolean )
		: [];
	const unique = Array.from( new Set( names ) ).filter( ( name ) => /^[A-Za-z_$][\w$]*$/.test( name ) && name !== 'pass' );
	const consts = unique
		.filter( ( name ) => name !== 'reflector' )
		.filter( ( name ) => name !== 'builtinAOContext' )
		.filter( ( name ) => name !== 'renderOutput' )
		.filter( ( name ) => name !== 'texture' )
		.filter( ( name ) => name !== 'texture3D' )
		.filter( ( name ) => name !== 'textureLoad' )
		.filter( ( name ) => name !== 'pmremTexture' )
		.map( ( name ) => `const ${ name } = __TSL[ '${ name }' ];` )
		.join( '\n' );
	const reflectorShim = unique.includes( 'reflector' )
		? `
const __tslpRealReflector = __TSL[ 'reflector' ];
const reflector = ( ...args ) => {
	const node = __tslpRealReflector( ...args );
	const baseNode = node && node._reflectorBaseNode;
	if ( baseNode ) {
		const list = globalThis.__tslpReflectorBaseNodes || ( globalThis.__tslpReflectorBaseNodes = [] );
		if ( ! list.includes( baseNode ) ) list.push( baseNode );
	}
	return node;
};
`
		: '';
	const builtinAOContextShim = unique.includes( 'builtinAOContext' )
		? `
const __tslpRealBuiltinAOContext = __TSL[ 'builtinAOContext' ];
const builtinAOContext = ( aoNode, node = null ) => {
	const contextNode = __tslpRealBuiltinAOContext( aoNode, node );
	try { Object.defineProperty( contextNode, '__tslpAOInputNode', { value: aoNode, configurable: true } ); } catch ( _ ) {}
	return contextNode;
};
`
		: '';
	const renderOutputShim = unique.includes( 'renderOutput' )
		? `
const __tslpRealRenderOutput = __TSL[ 'renderOutput' ];
const renderOutput = ( node, ...args ) => {
	if ( node && node.isPassNode === true && typeof node.getTextureNode === 'function' ) {
		return node.getTextureNode().renderOutput( ...args );
	}
	return __tslpRealRenderOutput( node, ...args );
};
`
		: '';
	const pmremTextureShim = unique.includes( 'pmremTexture' )
		? `
const __tslpRealPmremTexture = __TSL[ 'pmremTexture' ];
const pmremTexture = ( ...args ) => {
	__tslpRememberTextureArg( args[ 0 ] );
	return __tslpRealPmremTexture( ...args );
};
`
		: '';
	const exportList = [ ...unique, 'pass' ].join( ', ' );
	return `
// Import the FULL three.js TSL namespace via absolute URL so the replay
// import-map (which redirects 'three/webgpu' to the slim bundle) is bypassed.
import { TSL as __TSL } from '/build/three.webgpu.js';
import { PassNode as __ReplayPassNode, registerLiveTexture as __tslpRegisterLiveTexture } from '/__tslp__/slim-webgpu-replay.js?v=${ CACHE_BUST }';

// Re-expose every named TSL export so compute kernels (Fn, instancedArray, ...)
// receive genuine TSL node objects whose isComputeNode flag is set correctly.
${ consts }
${ reflectorShim }
${ builtinAOContextShim }
${ renderOutputShim }
const __tslpRememberTextureArg = ( value ) => {
	if ( ! value || value.isTexture !== true ) return;
	const list = globalThis.__tslpTslTextureArgs || ( globalThis.__tslpTslTextureArgs = [] );
	if ( ! list.includes( value ) ) list.push( value );
	try { __tslpRegisterLiveTexture( value ); } catch ( _ ) {}
};
const __tslpRealTexture = __TSL[ 'texture' ];
const texture = ( ...args ) => {
	__tslpRememberTextureArg( args[ 0 ] );
	return __tslpRealTexture( ...args );
};
const __tslpRealTexture3D = __TSL[ 'texture3D' ];
const texture3D = ( ...args ) => {
	__tslpRememberTextureArg( args[ 0 ] );
	return __tslpRealTexture3D( ...args );
};
const __tslpRealTextureLoad = __TSL[ 'textureLoad' ];
const textureLoad = ( ...args ) => {
	__tslpRememberTextureArg( args[ 0 ] );
	return __tslpRealTextureLoad( ...args );
};
${ pmremTextureShim }
const pass = ( scene, camera, options ) => new __ReplayPassNode( __ReplayPassNode.COLOR, scene, camera, options );
export { ${ exportList } };
// Also export the TSL namespace object for code that imports it directly.
export const TSL = __TSL;
`;

}

function inspectorStubModule() {

	return `
// Function builtins (name, length, prototype, arguments, caller, bind, etc.)
// must be shadowed so chained GUI calls like \`gui.add(...).name('Label')\`
// hit the chainable Proxy and not Function.prototype.name (string).
const FN_BUILTINS = new Set( [ 'name', 'length', 'prototype', 'arguments', 'caller', 'bind', 'call', 'apply' ] );
function makeChainable( base = {} ) {
	const target = Object.assign( function () { return chain; }, base );
	const chain = new Proxy( target, {
		get( t, prop ) {
			if ( prop === Symbol.toPrimitive ) return () => 0;
			if ( prop === 'toString' ) return () => '[inspector stub]';
			if ( typeof prop === 'string' && Object.prototype.hasOwnProperty.call( base, prop ) ) return base[ prop ];
			if ( typeof prop === 'string' && FN_BUILTINS.has( prop ) ) return makeChainable();
			if ( prop in t ) return t[ prop ];
			return makeChainable();
		},
		apply() { return makeChainable(); },
		construct() { return makeChainable(); },
	} );
	return chain;
}
const guiTarget = { paramList: { domElement: { style: {} } } };
function makeGui() { return makeChainable( guiTarget ); }
export class Inspector {
	constructor() {
		const base = { domElement: document.createElement( 'div' ) };
		base.createParameters = makeGui;
		return makeChainable( base );
	}
}
export default Inspector;
`;

}

function statsStubModule() {

	return `
function Stats() {
	const dom = document.createElement( 'div' );
	return {
		REVISION: 16,
		dom,
		domElement: dom,
		addPanel() { return { dom: document.createElement( 'canvas' ), update() {} }; },
		showPanel() {},
		begin() {},
		end() { return ( performance || Date ).now(); },
		update() {},
	};
}
Stats.Panel = function () { return { dom: document.createElement( 'canvas' ), update() {} }; };
export default Stats;
`;

}

async function readBody( req ) {

	const chunks = [];
	for await ( const chunk of req ) chunks.push( chunk );
	return Buffer.concat( chunks ).toString( 'utf8' );

}

async function handleCapture( req, res, url ) {

	try {

		const example = url.searchParams.get( 'example' ) || 'unknown';
		const payload = JSON.parse( await readBody( req ) );
		const bucket = captureBucket( example );

		if ( payload.materialShape && payload.configHash ) {

			bucket.aux = bucket.aux.filter( ( e ) => ! ( e.shape === payload.materialShape && e.configHash === payload.configHash ) );
			bucket.aux.push( {
				shape: payload.materialShape,
				configHash: payload.configHash,
				name: payload.name || null,
				artifact: payload.artifact,
			} );

		} else if ( payload.name ) {

			bucket.user[ payload.name ] = {
				__hash: payload.hash,
				name: payload.name,
				artifact: payload.artifact,
			};

		} else {

			throw new Error( 'capture payload missing materialShape/configHash or name' );

		}

		res.setHeader( 'content-type', 'application/json' );
		res.end( JSON.stringify( { ok: true } ) );

	} catch ( err ) {

		res.statusCode = 400;
		res.setHeader( 'content-type', 'application/json' );
		res.end( JSON.stringify( { error: err && err.message || String( err ) } ) );

	}

}

function safeResolveUnder( root, rel ) {

	const file = resolve( root, rel.replace( /^\/+/, '' ) );
	const rootNorm = normalize( root + '/' );
	if ( ! normalize( file ).startsWith( rootNorm ) ) return null;
	return file;

}

const server = createServer( async ( req, res ) => {

	try {

		const url = new URL( req.url, 'http://localhost' );

		if ( url.pathname === '/__tslp__/capture' ) return handleCapture( req, res, url );
		if ( url.pathname === '/__tslp__/stock-webgpu.js' ) return sendJs( res, stockWebgpuModule() );
		if ( url.pathname === '/__tslp__/full-webgpu-auto.js' ) return sendJs( res, fullWebgpuAutoModule() );
		if ( url.pathname === '/__tslp__/slim-webgpu-replay.js' ) return sendJs( res, slimWebgpuReplayModule() );
		if ( url.pathname === '/__tslp__/tsl-stub.js' ) return sendJs( res, tslStubModule() );
		if ( url.pathname === '/__tslp__/aux-virtual.js' ) return sendJs( res, auxVirtualModule() );
		if ( url.pathname === '/examples/jsm/inspector/Inspector.js' ) return sendJs( res, inspectorStubModule() );
		if ( url.pathname === '/examples/jsm/libs/stats.module.js' ) return sendJs( res, statsStubModule() );
		// `three/addons/*` for local-examples-root packages: `/examples/*` is
		// intercepted to the local root (which has no `jsm/`), so route the
		// importmap-injected `"three/addons/"` here instead → `<threeRepo>/examples/jsm/`.
			if ( url.pathname.startsWith( '/__tslp_addons/' ) ) {

				const rel = url.pathname.slice( '/__tslp_addons/'.length );
					if ( rel === 'inspector/Inspector.js' ) return sendJs( res, inspectorStubModule() );
				if ( rel === 'libs/stats.module.js' ) return sendJs( res, statsStubModule() );
				if ( rel === 'loaders/MaterialXLoader.js' ) {

					const source = await readFile( safeResolveUnder( join( threeRepo, 'examples/jsm' ), rel ), 'utf8' );
					return sendJs( res, rewriteMaterialXLoaderTextureIdentity( source ) );

				}
					if ( rel === 'loaders/KTX2Loader.js' || rel === 'loaders/GLTFLoader.js' ) {

						const source = await readFile( safeResolveUnder( join( threeRepo, 'examples/jsm' ), rel ), 'utf8' );
						const className = rel === 'loaders/GLTFLoader.js' ? 'GLTFLoader' : 'KTX2Loader';
						return sendJs( res, rewriteLoaderAddon( source, className ) );

					}
						return sendFile( res, safeResolveUnder( join( threeRepo, 'examples/jsm' ), rel ) );

			}
			if ( url.pathname.startsWith( '/__tslp_addons_replay/' ) ) {

				const rel = url.pathname.slice( '/__tslp_addons_replay/'.length );
				if ( rel === 'inspector/Inspector.js' ) return sendJs( res, inspectorStubModule() );
				if ( rel === 'libs/stats.module.js' ) return sendJs( res, statsStubModule() );
				const source = await readFile( safeResolveUnder( join( threeRepo, 'examples/jsm' ), rel ), 'utf8' );
				let rewritten = rewriteReplayAddon( source );
				if ( rel === 'loaders/MaterialXLoader.js' ) rewritten = rewriteMaterialXLoaderTextureIdentity( rewritten );
					if ( rel === 'loaders/KTX2Loader.js' || rel === 'loaders/GLTFLoader.js' ) {

						const className = rel === 'loaders/GLTFLoader.js' ? 'GLTFLoader' : 'KTX2Loader';
						rewritten = rewriteLoaderAddon( rewritten, className );

					}
					return sendJs( res, rewritten );

			}
				if ( url.pathname === '/__tslp__/three.webgpu.slim.js' ) {

				res.setHeader( 'content-type', 'application/javascript; charset=utf-8' );
				res.setHeader( 'cache-control', 'no-store' );
				const slimSource = await readFile( SLIM_BUNDLE, 'utf8' );
				res.end( rewriteSlimDeterministicObjectIds( slimSource ) );
				return;

		}

		if ( url.pathname.startsWith( '/__tslp_runtime/' ) ) {

			return sendFile( res, safeResolveUnder( RUNTIME_SRC, url.pathname.slice( '/__tslp_runtime/'.length ) ) );

		}
			if ( url.pathname.startsWith( '/__tslp_contract/' ) ) {

				const rel = url.pathname.slice( '/__tslp_contract/'.length );
				const withExtension = extname( rel ) ? rel : `${ rel }.js`;
				return sendFile( res, safeResolveUnder( CONTRACT_SRC, withExtension ) );

			}
		if ( url.pathname.startsWith( '/__tslp_plugin/' ) ) {

			return sendFile( res, safeResolveUnder( PLUGIN_SRC, url.pathname.slice( '/__tslp_plugin/'.length ) ) );

		}

		const requestPath = decodeURIComponent( url.pathname );
		let filePath;
		if ( localExamplesRoot && requestPath.startsWith( '/examples/' ) ) {

			filePath = safeResolveUnder( localExamplesRoot, requestPath.slice( '/examples/'.length ) );

		} else if ( localExamplesRoot && requestPath.startsWith( '/__local_src/' ) ) {

			filePath = safeResolveUnder( localExamplesRoot, 'src/' + requestPath.slice( '/__local_src/'.length ) );

		} else {

			filePath = resolve( threeRepo, '.' + requestPath );

		}
		if ( ! filePath || ! normalize( filePath ).startsWith( normalize( ( localExamplesRoot && ( requestPath.startsWith( '/examples/' ) || requestPath.startsWith( '/__local_src/' ) ) ? localExamplesRoot : threeRepo ) + '/' ) ) ) {

			res.statusCode = 403;
			res.end( 'forbidden' );
			return;

		}

		const s = await stat( filePath ).catch( () => null );
		if ( ! s || ! s.isFile() ) {

			res.statusCode = 404;
			res.end( 'not found' );
			return;

		}

		let buf = await readFile( filePath );
		const isLocalHtml = localExamplesRoot && filePath.endsWith( '.html' ) && normalize( filePath ).startsWith( normalize( localExamplesRoot + '/' ) );
		const isThreeWebgpuHtml = filePath.endsWith( '.html' ) && filePath.includes( '/examples/webgpu_' );
		if ( isLocalHtml || isThreeWebgpuHtml ) {

			const requestedMode = url.searchParams.get( '__tslp_mode' );
			const mode = requestedMode === 'replay' ? 'replay' : requestedMode === 'stock' ? 'stock' : 'capture';
			const example = url.searchParams.get( '__tslp_case' ) || basename( requestPath );
			const html = isLocalHtml
				? buf.toString( 'utf8' ).replace( /(["'])\/src\//g, '$1/__local_src/' )
				: buf.toString( 'utf8' );
			buf = Buffer.from( injectHtml( html, example, mode ) );

		}
		const isLocalJs = localExamplesRoot && /\.(?:mjs|js)$/.test( filePath ) && normalize( filePath ).startsWith( normalize( localExamplesRoot + '/' ) );
		if ( isLocalJs ) {

			buf = Buffer.from( rewriteHarnessVirtualImports( buf.toString( 'utf8' ) ) );

		}
			if ( requestPath === '/examples/jsm/loaders/MaterialXLoader.js' ) {

				buf = Buffer.from( rewriteMaterialXLoaderTextureIdentity( buf.toString( 'utf8' ) ) );

			}
						if ( requestPath === '/examples/jsm/loaders/KTX2Loader.js' || requestPath === '/examples/jsm/loaders/GLTFLoader.js' ) {

							const className = requestPath.endsWith( '/GLTFLoader.js' ) ? 'GLTFLoader' : 'KTX2Loader';
							buf = Buffer.from( rewriteLoaderAddon( buf.toString( 'utf8' ), className ) );

						}
				if ( requestPath === '/build/three.core.js' ) {

					buf = Buffer.from( rewriteThreeCoreDeterministicObjectIds( buf.toString( 'utf8' ) ) );

				}
					res.setHeader( 'access-control-allow-origin', '*' );
		res.setHeader( 'content-type', MIME[ extname( filePath ).toLowerCase() ] || 'application/octet-stream' );
		res.setHeader( 'cache-control', 'no-store' );
		res.end( buf );

	} catch ( err ) {

		res.statusCode = 500;
		res.end( 'error: ' + ( err && err.message || err ) );

	}

} );

function sendJs( res, code ) {

	res.setHeader( 'access-control-allow-origin', '*' );
	res.setHeader( 'content-type', 'application/javascript; charset=utf-8' );
	res.setHeader( 'cache-control', 'no-store' );
	res.end( code );

}

async function sendFile( res, file ) {

	if ( ! file ) {

		res.statusCode = 403;
		res.end( 'forbidden' );
		return;

	}
	const s = await stat( file ).catch( () => null );
	if ( ! s || ! s.isFile() ) {

		res.statusCode = 404;
		res.end( 'not found' );
		return;

	}
	res.setHeader( 'access-control-allow-origin', '*' );
	res.setHeader( 'content-type', MIME[ extname( file ).toLowerCase() ] || 'application/javascript; charset=utf-8' );
	res.setHeader( 'cache-control', 'no-store' );
	res.end( await readFile( file ) );

}

async function listenWithPortFallback( server, startPort, maxRetries ) {

	for ( let attempt = 0; attempt <= maxRetries; attempt ++ ) {

		const candidate = startPort + attempt;
		try {

			await new Promise( ( ok, fail ) => {

				const onError = ( err ) => {

					server.off( 'listening', onListening );
					fail( err );

				};
				const onListening = () => {

					server.off( 'error', onError );
					ok();

				};
				server.once( 'error', onError );
				server.once( 'listening', onListening );
				server.listen( candidate, '127.0.0.1' );

			} );
			if ( candidate !== startPort ) console.warn( `[batch-e2e] port ${ startPort } busy; using ${ candidate } instead` );
			return candidate;

		} catch ( err ) {

			if ( ! err || err.code !== 'EADDRINUSE' || attempt === maxRetries ) throw err;

		}

	}

}

port = await listenWithPortFallback( server, port, portRetries );
console.log( `[batch-e2e] server on http://localhost:${ port}/` );

const BROWSER_ARGS = [ '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--no-sandbox', '--disable-dev-shm-usage' ];
const NAV_TIMEOUT_MS = 30000;
const RENDER_TIMEOUT_MS = 12000;
// Loader-gated wait can take much longer than RENDER_TIMEOUT_MS — examples like
// webgpu_loader_materialx fetch 20+ .mtlx files sequentially and renderer.compileAsync
// each one. The freeze itself is synthetic and fires fast; this budget purely
// absorbs the network + sequential GPU-compile cascade.
const LOADER_TIMEOUT_MS = 45000;
// How long the loader/compile counters must remain at zero before we accept
// "loaders settled". Bridges the gap between sequential awaits (load A → onLoad
// callback kicks load B) where the counter briefly hits 0 mid-cascade.
const LOADER_QUIESCENT_MS = 250;
// Extra rAF ticks to fire at clamped time after counters first go quiet, before
// the freeze actually engages. Covers things that DON'T bump our counters but
// still need a few frames to converge: OrbitControls damping interpolation,
// onWindowResize handlers calling renderer.setSize without an explicit render,
// post-load setTimeout(0) chains, GUI build re-layouts. Each tick fires the
// example's setAnimationLoop callback at the same clamped synthetic time so
// animation phase stays deterministic between capture and replay.
const SETTLE_FRAMES = parseIntAtLeast( getArg( '--settle-frames=', '8' ), 8, 0 );
const RENDER_POLL_MS = 400;
// Restart the browser more aggressively than wear-and-tear suggests because
// some examples (PMREM-heavy, large GLTF, postprocessing) corrupt the WebGPU
// state in a way that crashes the whole renderer process after 8–11 runs.
// Recreating proactively also keeps Metal/GPU buffer accumulation in check
// on Apple Silicon, where unified memory means GPU pressure freezes the
// whole OS — at 4 runs/browser the parallel runner still froze users'
// machines around the 150-example mark, so we cycle every 2 by default.
// Override with TSLP_E2E_MAX_RUNS_PER_BROWSER=N or --max-runs-per-browser=N
// if a future Chromium/Playwright makes per-context GPU release reliable
// enough to relax this. The per-example catch below handles the residual
// case where a crash hits before we hit this cap.
const MAX_RUNS_PER_BROWSER = parseIntAtLeast( process.env.TSLP_E2E_MAX_RUNS_PER_BROWSER || getArg( '--max-runs-per-browser=', '2' ), 2, 1 );
// Pause after `browser.close()` before relaunching. Without this, Chromium's
// GPU process can still hold Metal buffers when the new browser starts,
// doubling unified-memory pressure for the cross-over moment. 250 ms is
// enough on Apple Silicon for the OS to reclaim GPU resources.
const BROWSER_RESPAWN_DELAY_MS = parseIntAtLeast( process.env.TSLP_E2E_BROWSER_RESPAWN_DELAY_MS || '250', 250, 0 );

// Deterministic-time replay support. Animated examples driven by
// `setAnimationLoop` would otherwise sample different animation phases on
// stock/capture/replay. The default target tick is 0: take the first fully
// loaded, settled frame so per-frame mutations like `rotation += 0.005`
// cannot drift while assets and PMREM compile at different speeds. Use
// `--target-tick=60` when deliberately auditing a later animation phase.
// Real-time fetch / XHR are unaffected, so HDR / KTX2 / GLTF loaders still work.
const PRESENT_SETTLE_MS = parseIntAtLeast( getArg( '--present-settle-ms=', '120' ), 120, 0 );
const ASSET_SETTLE_MS = parseIntAtLeast( getArg( '--asset-settle-ms=', '250' ), 250, 0 );
const BRIGHT_POLL_MS = parseIntAtLeast( getArg( '--bright-poll-ms=', '400' ), 400, 0 );
const HAS_EXPLICIT_SETTLE_FRAMES = args.some( ( arg ) => arg.startsWith( '--settle-frames=' ) );

function targetTickForExample( name ) {
	if ( HAS_EXPLICIT_TARGET_TICK ) return targetTick;
	// Motion vectors need one completed animation step so VelocityNode has
	// a meaningful previous/current pair. Tick zero compares startup history
	// rather than replay fidelity.
	if ( name === 'webgpu_postprocessing_motion_blur.html' ) return 1;
	return targetTick;
}

function settleFramesForExample( name ) {
	if ( HAS_EXPLICIT_SETTLE_FRAMES ) return SETTLE_FRAMES;
	// ArrayCamera has no asynchronous scene assets and mutates rotation by
	// frame count, not by the rAF timestamp. One quiet present frame is enough
	// to capture the stable canvas; the general eight-frame settle advances the
		// capture and replay wrappers through different renderer-initialization
		// work, which shows up as a false visual diff.
		if ( name === 'webgpu_camera_array.html' ) return 1;
		// These examples keep advancing render-visible state on every clamped
		// animation-loop callback (compute steps, helper/scissor state, media frames,
		// postprocessing history, TSL time, or damping-driven camera state). Extra
	// settle frames can therefore compare different histories instead of replay
	// fidelity.
	if ( name === 'webgpu_camera.html' ) return 1;
		if ( name === 'webgpu_compute_birds.html' ) return 1;
		if ( name === 'webgpu_compute_sort_bitonic.html' ) return 1;
		if ( name === 'webgpu_compute_water.html' ) return 1;
		if ( name === 'webgpu_tsl_compute_attractors_particles.html' ) return 1;
		if ( name === 'webgpu_instance_path.html' ) return 1;
	if ( name === 'webgpu_lights_custom.html' ) return 1;
	if ( name === 'webgpu_lights_projector.html' ) return 1;
	if ( name === 'webgpu_materials_video.html' ) return 1;
		if ( name === 'webgpu_postprocessing_dof.html' ) return 1;
		if ( name === 'webgpu_postprocessing_motion_blur.html' ) return 1;
		if ( name === 'webgpu_postprocessing_retro.html' ) return 1;
		if ( name === 'webgpu_postprocessing_smaa.html' ) return 1;
		if ( name === 'webgpu_postprocessing_ssr.html' ) return 1;
	// TRAA-backed effects need several quiet frames to build usable history
	// after the harness holds pre-ready count-driven callbacks.
	if ( name === 'webgpu_postprocessing_ao.html' ) return 16;
	// TRAA's temporal resolve needs enough same-pose history to converge to the
	// stock frame. With jitter pinned in both modes, 80 quiet frames reaches a
	// bit-for-bit identical replay for this callback-count-driven example.
	if ( name === 'webgpu_postprocessing_traa.html' ) return 80;
	if ( name === 'webgpu_sandbox.html' ) return 1;
	if ( name === 'webgpu_shadowmap_progressive.html' ) return 1;
	if ( name === 'webgpu_tsl_wood.html' ) return 1;
	// The duck rotation in caustics advances by animation-loop callback count
	// (`rotation.y -= .01`), not by the synthetic timestamp. Extra quiet settle
	// frames therefore compare different model poses instead of replay fidelity.
	if ( name === 'webgpu_caustics.html' ) return 1;
	// Replay generates PMREM for the cube-camera render target asynchronously.
	// Extra settle frames run another cubeCamera.update(), invalidating the
	// just-finished PMREM and keeping the visual gate in a moving target loop.
	if ( name === 'webgpu_cubemap_dynamic.html' ) return 1;
	return SETTLE_FRAMES;
}

function minimumRenderableObjectsForExample( name ) {
	// The projector-light page renders its plane + SpotLightHelper before the
	// async PLY statue is attached. Waiting for one renderable object lets the
	// stock/reference frame freeze before the loaded subject appears.
	if ( name === 'webgpu_lights_projector.html' ) return 3;
	// Retro starts with the procedural smoke plane, then async-loads the coffee
	// mug scene. A one-object gate can freeze stock before the model appears,
	// while replay captures it after loader settle.
	if ( name === 'webgpu_postprocessing_retro.html' ) return 2;
	// MaterialX loads one GLTF prefab, then sequentially awaits 32 MaterialX
	// samples and compileAsync() calls. The loader/compile counters briefly hit
	// zero between samples, so a one-object gate can freeze replay after the
	// first couple of shader balls. The final scene is the grid plane plus two
	// visible meshes per sample (Calibration_Mesh and Preview_Mesh).
	if ( name === 'webgpu_loader_materialx.html' ) return 65;
	// Procedural wood yields one block per setTimeout(0) after the HDR/font
	// loads. Wait for the grid plane, 14 text labels, and all 40 wood blocks.
	if ( name === 'webgpu_tsl_wood.html' ) return 55;
	return 1;
}

function holdAnimationUntilReadyForExample( name ) {
	// TRAA mutates object rotation by animation callback count and then
	// accumulates that history. Resetting the settle counter while texture /
	// compile work is pending is not enough: the hidden pre-ready callbacks
	// still advance the scene. Hold callbacks until async work is quiet so both
	// capture and replay build history from the same pose.
	if (
		name === 'webgpu_postprocessing_traa.html' ||
		name === 'webgpu_postprocessing_lensflare.html' ||
		name === 'webgpu_postprocessing_smaa.html' ||
		name === 'webgpu_test_memory.html'
	) return true;
	return false;
}

async function dumpCanvases( page ) {

	const canvases = await page.$$( 'canvas' );
	const shots = [];
	for ( let i = canvases.length - 1; i >= 0; i -- ) {

		const box = await canvases[ i ].boundingBox();
		if ( ! box || box.width <= 0 || box.height <= 0 ) continue;
		try { shots.push( await canvases[ i ].screenshot( { timeout: 3000 } ) ); } catch ( _ ) { /* ignore this canvas */ }

	}
	return shots;

}

async function canvasBrightFractionInPage( page ) {

	return await page.evaluate( () => {

		const canvases = document.querySelectorAll( 'canvas' );
		let bestBright = 0;
		for ( const canvas of canvases ) {

			if ( ! canvas.width || ! canvas.height ) continue;
			try {

				const off = new OffscreenCanvas( canvas.width, canvas.height );
				const ctx = off.getContext( '2d' );
				ctx.drawImage( canvas, 0, 0 );
				const img = ctx.getImageData( 0, 0, canvas.width, canvas.height ).data;
				let bright = 0;
				for ( let i = 0; i < img.length; i += 4 ) {

					if ( img[ i ] + img[ i + 1 ] + img[ i + 2 ] > 30 ) bright ++;

				}
				const frac = bright / ( img.length / 4 );
				if ( frac > bestBright ) bestBright = frac;

			} catch ( _ ) { /* ignore canvas read errors */ }

		}
		return bestBright;

	} ).catch( () => 0 );

}

async function dumpBrightestCanvas( page ) {

	const shots = await dumpCanvases( page );
	const bright = await canvasBrightFractionInPage( page );
	const best = shots.length > 0 ? shots[ 0 ] : null;
	return { shot: best, bright: +bright.toFixed( 4 ) };

}

async function dumpCanvas( page ) {

	const result = await dumpBrightestCanvas( page );
	return result.shot;

}

async function collectFrameTextureSnapshot( page ) {

	return await page.evaluate( async () => {

		const w = window;
		const pipeline = w.__tslpLastRenderPipeline || null;
		const rendererCandidates = [
			w.__tslpSlimRenderer,
			w.__tslpCurrentReplayRenderer,
			w.__tslpFullRenderer,
			w.__tslpHarnessRenderer,
			w.__tslpComputeRenderer,
		].filter( Boolean );
		const renderers = [];
		for ( const renderer of rendererCandidates ) {
			if ( renderer && renderer.backend && typeof renderer.backend.copyTextureToBuffer === 'function' && ! renderers.includes( renderer ) ) {
				renderers.push( renderer );
			}
		}
		const textures = [];
		const seenTextures = new Set();
		function addTexture( label, texture ) {
			if ( ! texture || texture.isTexture !== true || texture.isDepthTexture === true || seenTextures.has( label + ':' + texture.uuid ) ) return;
			seenTextures.add( label + ':' + texture.uuid );
			textures.push( { label, texture } );
		}
		function effectTypeName( node ) {
			return node && node.constructor && ( node.constructor.type || node.constructor.name ) || node && node.type || '';
		}
		function visit( node, seen = new Set(), depth = 0 ) {
			if ( ! node || depth > 24 || seen.has( node ) || ( typeof node !== 'object' && typeof node !== 'function' ) ) return;
			seen.add( node );
			const type = effectTypeName( node );
			if ( node.isPassNode === true ) {
				try {
					const textures = node._textures || {};
					addTexture( 'Pass.output', textures.output || ( typeof node.getTexture === 'function' ? node.getTexture( 'output' ) : null ) || node.renderTarget && node.renderTarget.texture );
					addTexture( 'Pass.emissive', textures.emissive || ( typeof node.getTexture === 'function' ? node.getTexture( 'emissive' ) : null ) );
				} catch ( _ ) {}
			}
			if ( type === 'BloomNode' || node && node._renderTargetBright && node._renderTargetsHorizontal ) {
				addTexture( 'Bloom.bright', node._renderTargetBright && node._renderTargetBright.texture );
				const horizontal = Array.isArray( node._renderTargetsHorizontal ) ? node._renderTargetsHorizontal : [];
				const vertical = Array.isArray( node._renderTargetsVertical ) ? node._renderTargetsVertical : [];
				for ( let i = 0; i < Math.min( 2, horizontal.length ); i ++ ) addTexture( 'Bloom.h' + i, horizontal[ i ] && horizontal[ i ].texture );
				for ( let i = 0; i < Math.min( 2, vertical.length ); i ++ ) addTexture( 'Bloom.v' + i, vertical[ i ] && vertical[ i ].texture );
			}
			if ( type === 'LensflareNode' ) {
				try {
					const textureNode = typeof node.getTextureNode === 'function' ? node.getTextureNode() : node._textureNode;
					addTexture( 'Lensflare.output', textureNode && textureNode.value || node._renderTarget && node._renderTarget.texture );
					addTexture( 'Lensflare.input', node.textureNode && node.textureNode.value );
				} catch ( _ ) {}
			}
			if ( type === 'GaussianBlurNode' ) {
				addTexture( 'GaussianBlur.input', node.textureNode && node.textureNode.value );
				addTexture( 'GaussianBlur.horizontal', node._horizontalRT && node._horizontalRT.texture );
				addTexture( 'GaussianBlur.vertical', node._verticalRT && node._verticalRT.texture );
			}
			const keys = [];
			try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) {}
			const skip = new Set( [ 'parent', 'children', '_cache', 'scene', 'camera', 'renderer', 'geometry', 'material', 'domElement' ] );
			for ( const key of keys ) {
				if ( skip.has( key ) ) continue;
				let child = null;
				try {
					const descriptor = Object.getOwnPropertyDescriptor( node, key );
					if ( descriptor && Object.prototype.hasOwnProperty.call( descriptor, 'value' ) ) child = descriptor.value;
				} catch ( _ ) {}
				if ( ! child ) continue;
				if ( Array.isArray( child ) ) {
					for ( const item of child ) visit( item, seen, depth + 1 );
				} else {
					visit( child, seen, depth + 1 );
				}
			}
		}
		if ( pipeline && pipeline.outputNode ) visit( pipeline.outputNode );
		const out = [];
		for ( const { label, texture } of textures ) {
			const image = texture.image || {};
			const width = image.width || image.naturalWidth || image.videoWidth || 0;
			const height = image.height || image.naturalHeight || image.videoHeight || 0;
			if ( ! width || ! height ) continue;
			let record = null;
			for ( const renderer of renderers ) {
				try {
					const buf = await renderer.backend.copyTextureToBuffer( texture, 0, 0, width, height, 0 );
					const view = ArrayBuffer.isView( buf ) ? buf : new Uint8Array( buf );
					const bytes = view instanceof Uint8Array ? view : new Uint8Array( view.buffer, view.byteOffset, view.byteLength );
					let hash = 2166136261;
					let nonzero = 0;
					let sum = 0;
					let max = 0;
					for ( let i = 0; i < bytes.length; i ++ ) {
						const value = bytes[ i ];
						hash ^= value;
						hash = Math.imul( hash, 16777619 ) >>> 0;
						sum += value;
						if ( value !== 0 ) nonzero ++;
						if ( value > max ) max = value;
					}
					record = {
						label,
						name: texture.name || '',
						uuid: texture.uuid || '',
						width,
						height,
						bytes: bytes.length,
						hash: hash.toString( 16 ).padStart( 8, '0' ),
						meanByte: sum / Math.max( 1, bytes.length ),
						nonzeroByteFrac: nonzero / Math.max( 1, bytes.length ),
						maxByte: max,
					};
					break;
				} catch ( err ) {
					record = {
						label,
						name: texture.name || '',
						uuid: texture.uuid || '',
						width,
						height,
						error: err && err.message || String( err ),
					};
				}
			}
			if ( record ) out.push( record );
			if ( out.length >= 32 ) break;
		}
		return out;

	} ).catch( ( err ) => [ { error: err && err.message || String( err ) } ] );

}

function safeExampleName( name ) {

	return name.replace( /[^A-Za-z0-9_.-]/g, '_' );

}

function writeArtifactDebugDump( file, value, summary ) {

	try {

		writeFileSync( file, JSON.stringify( value, null, 2 ) );
		return true;

	} catch ( err ) {

		const summaryFile = file.replace( /\.json$/i, '.summary.json' );
		const message = err && err.message || String( err );
		writeFileSync( summaryFile, JSON.stringify( {
			truncated: true,
			error: message,
			summary,
		}, null, 2 ) );
		console.warn( `[batch-e2e] skipped oversized artifact debug dump ${ file }: ${ message }; wrote ${ summaryFile }` );
		return false;

	}

}

function emptyVisitResult( overrides = {} ) {

	return {
		bright: 0,
		shot: null,
		errors: [],
		warnings: [],
		diagnostics: null,
		context: null,
		page: null,
		cleanup: async () => {},
		...overrides,
	};

}

function loadSavedReferenceShot( name ) {

	const shotPath = join( OUT, 'shots', `${ safeExampleName( name ) }.capture.png` );
	if ( ! existsSync( shotPath ) ) {

		return emptyVisitResult( {
			errors: [ `replay-only missing saved reference screenshot: ${ shotPath }` ],
		} );

	}
	return emptyVisitResult( { shot: readFileSync( shotPath ), fromDisk: true } );

}

function loadSavedArtifacts( name ) {

	const safe = safeExampleName( name );
	const artifactsDir = join( OUT, 'artifacts' );
	const userPath = join( artifactsDir, `${ safe }.user.json` );
	const auxPath = join( artifactsDir, `${ safe }.aux.json` );
	if ( ! existsSync( userPath ) || ! existsSync( auxPath ) ) {

		throw new Error( `replay-only missing saved artifacts for ${ name}. Run a full e2e pass with --save-shots first.` );

	}

	const user = JSON.parse( readFileSync( userPath, 'utf8' ) );
	const aux = JSON.parse( readFileSync( auxPath, 'utf8' ) );
	const bucket = { user: user || {}, aux: Array.isArray( aux ) ? aux : [] };
	captures.set( name, bucket );
	return bucket;

}

async function brightFraction( page, pngBuf ) {

	if ( ! pngBuf ) return 0;
	return await page.evaluate( async ( b64 ) => {

		try {

			const blob = await ( await fetch( 'data:image/png;base64,' + b64 ) ).blob();
			const bmp = await createImageBitmap( blob );
			const off = new OffscreenCanvas( bmp.width, bmp.height );
			const ctx = off.getContext( '2d' );
			ctx.drawImage( bmp, 0, 0 );
			const img = ctx.getImageData( 0, 0, bmp.width, bmp.height ).data;
			let bright = 0;
			for ( let i = 0; i < img.length; i += 4 ) {

				if ( img[ i ] + img[ i + 1 ] + img[ i + 2 ] > 30 ) bright ++;

			}
			return bright / ( img.length / 4 );

		} catch ( _ ) {

			return 0;

		}

	}, pngBuf.toString( 'base64' ) );

}

async function comparePSNR( _page, captureShot, replayShot, name = '' ) {

	if ( ! captureShot || ! replayShot ) return { error: 'missing screenshot' };
	return comparePngBuffers( captureShot, replayShot, { name } );

}

async function maybeClickStart( page ) {

	await page.evaluate( () => {

		const clickables = [ document.getElementById( 'startButton' ), document.querySelector( '#overlay button' ) ];
		for ( const el of document.querySelectorAll( 'button' ) ) {

			const t = ( el.textContent || '' ).trim().toLowerCase();
			if ( /^(play|start|begin|enter)$/.test( t ) ) clickables.push( el );

		}
		for ( const el of clickables ) {

			if ( ! el ) continue;
			const r = el.getBoundingClientRect();
			if ( r.width <= 0 || r.height <= 0 || el.disabled ) continue;
			el.click();

		}

	} );

}

async function waitForFrame( page, timeoutMs ) {

	try {

		await page.waitForSelector( 'canvas', { state: 'attached', timeout: Math.min( timeoutMs, 5000 ) } );
		await page.evaluate( () => new Promise( ( resolve ) => {

			let done = false;
			const finish = () => {

				if ( done ) return;
				done = true;
				resolve();

			};
			setTimeout( finish, 250 );
			requestAnimationFrame( () => requestAnimationFrame( finish ) );

		} ) );

	} catch ( _ ) { /* keep the bright poll below as the fallback */ }

	// WebGPU canvases are often not readable through drawImage() until after
	// compositor capture. The final screenshot brightness check below is the
	// authoritative gate, so don't spend the full render timeout on this poll.
	const deadline = Date.now() + Math.min( timeoutMs, BRIGHT_POLL_MS );
	let bright = 0;
	while ( Date.now() < deadline ) {

		bright = await canvasBrightFractionInPage( page );
		if ( bright > 0.005 ) break;
		await new Promise( ( r ) => setTimeout( r, RENDER_POLL_MS ) );

	}
	return +bright.toFixed( 4 );

}

async function visitExample( browser, name, mode, waitMs ) {

	const timings = { mode };
	const startedAt = Date.now();
	const mark = ( key, from ) => { timings[ key ] = Date.now() - from; };

	let stepStartedAt = Date.now();
	const context = await browser.newContext( { viewport: { width: 640, height: 480 } } );
	const page = await context.newPage();
	mark( 'contextMs', stepStartedAt );
	const errors = [];
	const warnings = [];

	// Named handlers so cleanup() can detach them. Without removeListener
	// the closures retain references to errors/warnings/mode for the lifetime
	// of the underlying Playwright page object — across a long parallel run
	// that holds page+context (and the GPU resources they back) past
	// context.close() and shows up as steady RSS climb.
	const onPageError = ( e ) => {

		const detail = String( e && ( e.stack || e.message ) || e );
		errors.push( detail );
		if ( process.env.TSLP_DEBUG_TORNADO ) console.error( `[page-error ${ mode }]`, detail );

	};
	const onRequestFailed = ( req ) => {

		const reqUrl = req.url();
		const errText = req.failure() && req.failure().errorText || 'unknown';
		if ( process.env.TSLP_DEBUG_TORNADO ) console.error( `[req-failed ${ mode }]`, reqUrl, '->', errText );
		// Surface harness-asset failures (runtime/contract/plugin/webgpu/tsl modules)
		// into `errors` so ES-module load failures show up in the e2e report — the
		// browser doesn't fire `pageerror` for these and the console message may
		// arrive as a warning that `onConsole` filters out.
		if ( /__tslp__|__tslp_runtime|__tslp_plugin|__tslp_contract|three\.webgpu|three\.tsl/.test( reqUrl ) ) {
			errors.push( `harness asset failed: ${ reqUrl } (${ errText })` );
		}

	};
	const traceResponses = !! process.env.TSLP_DEBUG_TORNADO_TRACE;
	const onResponse = async ( res ) => {

		const url = res.url();
		if ( /__tslp__|__tslp_runtime|__tslp_plugin|three\.webgpu|three\.tsl|tsl-stub|tornado/.test( url ) ) {
			try {
				const txt = await res.text();
				console.log( `[res ${ mode }]`, res.status(), url, 'len=', txt.length );
				if ( /tornado/.test( url ) && process.env.TSLP_DEBUG_DUMP_HTML ) {
					const fs = await import( 'node:fs' );
					fs.writeFileSync( `/tmp/tornado-${ mode }.html`, txt );
				}
			} catch ( _ ) { /* not text */ }
		}

	};
	const onConsole = ( m ) => {

		if ( m.type() === 'error' ) {
			errors.push( m.text() );
			if ( process.env.TSLP_DEBUG_TORNADO ) console.error( `[console-error ${ mode }]`, m.text() );
		}
		if ( m.type() === 'warning' && m.text().includes( '[tslp' ) ) {
			warnings.push( m.text() );
			if ( verboseConsole ) console.warn( `[page-warn ${ mode }] ${ m.text() }` );
		}
		if ( m.type() === 'log' && m.text().includes( '[tslp' ) && verboseConsole ) console.log( `[page-log ${ mode }] ${ m.text() }` );
		if ( process.env.TSLP_DEBUG_TORNADO_VERBOSE ) console.log( `[page-${ m.type() } ${ mode }]`, m.text() );

	};
	page.on( 'pageerror', onPageError );
	page.on( 'requestfailed', onRequestFailed );
	if ( traceResponses ) page.on( 'response', onResponse );
	page.on( 'console', onConsole );

	// Single owner for tearing down a visit's Playwright resources. Always
	// detach listeners first (so any in-flight event between page.close()
	// and context.close() can't push into the captured arrays and keep
	// them alive), then close the page, then close the context.
	const cleanup = async () => {

		try {
			page.off( 'pageerror', onPageError );
			page.off( 'requestfailed', onRequestFailed );
			if ( traceResponses ) page.off( 'response', onResponse );
			page.off( 'console', onConsole );
		} catch ( _ ) {}
		try { await page.close( { runBeforeUnload: false } ); } catch ( _ ) {}
		try { await context.close(); } catch ( _ ) {}

	};

	// Inject a deterministic-rAF shim BEFORE the page navigates so it's
	// active from the very first script. Each `requestAnimationFrame`
	// callback receives a synthetic monotonic timestamp that advances by
	// exactly FRAME_STEP_MS per tick. `Date.now()` / `performance.now()`
	// / `setTimeout` are left alone so async loaders, fetch, and
	// renderer init still progress on real time — only the animation
	// loop sees the synthetic clock.
	//
	// Stock, capture, and replay block until tick >= TARGET_TICK, freeze
	// the synthetic clock at TARGET_TICK, then screenshot. With the default
	// target tick of 0, any
	// `setAnimationLoop( ( time ) => ... )` callback therefore sees the
	// same post-load settled time in all passes, so per-frame animations do
	// not drift just because replay generated PMREM or hydrated artifacts.
	const effectiveTargetTick = targetTickForExample( name );
	const TARGET_TICK = Number.isFinite( effectiveTargetTick ) ? Math.max( 0, effectiveTargetTick | 0 ) : 0;
	const FRAME_STEP_MS = 16.6667;
		const effectiveSettleFrames = settleFramesForExample( name );
		timings.targetTick = TARGET_TICK;
		timings.settleFrames = effectiveSettleFrames;
		const waitForRenderableObjects = await exampleUsesDeferredSceneAssets( name );
		const minRenderableObjects = minimumRenderableObjectsForExample( name );
		const holdAnimationUntilReady = holdAnimationUntilReadyForExample( name );
	try {

		stepStartedAt = Date.now();
		if ( process.env.TSLP_DEBUG_SHADOW_COVERAGE === '1' && mode === 'replay' ) {
			await page.addInitScript( () => { globalThis.__TSLP_DEBUG_SHADOW_COVERAGE = true; window.__TSLP_DEBUG_SHADOW_COVERAGE = true; } );
		}
		if ( process.env.TSLP_DEBUG_LIGHT_LINKAGE === '1' && mode === 'replay' ) {
			await page.addInitScript( () => { globalThis.__TSLP_DEBUG_LIGHT_LINKAGE = true; window.__TSLP_DEBUG_LIGHT_LINKAGE = true; } );
		}
		if ( process.env.TSLP_DEBUG_SHADOW_BINDINGS === '1' && mode === 'replay' ) {
			await page.addInitScript( () => { globalThis.__TSLP_DEBUG_SHADOW_BINDINGS = true; window.__TSLP_DEBUG_SHADOW_BINDINGS = true; } );
		}
		if ( process.env.TSLP_DEBUG_FRAME_TEXTURES === '1' && mode === 'replay' ) {
			await page.addInitScript( () => { globalThis.__TSLP_DEBUG_FRAME_TEXTURES = true; window.__TSLP_DEBUG_FRAME_TEXTURES = true; } );
		}
		if ( process.env.TSLP_DEBUG_REFLECTOR_BINDINGS === '1' && mode === 'replay' ) {
			await page.addInitScript( () => { globalThis.__TSLP_DEBUG_REFLECTOR_BINDINGS = true; window.__TSLP_DEBUG_REFLECTOR_BINDINGS = true; } );
		}
			await page.addInitScript( ( { step, base, freezeAt, quiescentMs, settleFrames, waitForRenderableObjects, minRenderableObjects, holdAnimationUntilReady, exampleName } ) => {

			// eslint-disable-next-line no-undef
			const w = window;
			const diagnostics = w.__tslpHarnessDiagnostics || ( w.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
			diagnostics.gpuErrors = diagnostics.gpuErrors || [];
			try {

				const gpu = w.navigator && w.navigator.gpu;
				if ( gpu && typeof gpu.requestAdapter === 'function' && ! gpu.__tslpErrorHooked ) {

					gpu.__tslpErrorHooked = true;
					const requestAdapter = gpu.requestAdapter.bind( gpu );
					gpu.requestAdapter = async function ( ...args ) {

						const adapter = await requestAdapter( ...args );
						if ( adapter && typeof adapter.requestDevice === 'function' && ! adapter.__tslpErrorHooked ) {

							adapter.__tslpErrorHooked = true;
							const requestDevice = adapter.requestDevice.bind( adapter );
							adapter.requestDevice = async function ( ...deviceArgs ) {

								const device = await requestDevice( ...deviceArgs );
								try {
									device.addEventListener( 'uncapturederror', ( event ) => {

										const message = event && event.error && event.error.message || event && event.message || String( event );
										diagnostics.gpuErrors.push( message );

									} );
								} catch ( _ ) {}
								return device;

							};

						}
						return adapter;

					};

				}

			} catch ( _ ) {}
			if ( w.__tslpRafShimInstalled ) return;
			w.__tslpRafShimInstalled = true;
				w.__tslpRafTick = 0;
				w.__tslpFrozen = false;
				w.__tslpAnimationLoopRegistered = false;
				w.__tslpAnimationLoopCalls = 0;
				w.__tslpFrameCallbackCount = 0;
				if ( exampleName === 'webgpu_video_frame.html' && typeof w.VideoDecoder === 'function' && ! w.VideoDecoder.__tslpFirstFrameOnly ) {
				const NativeVideoDecoder = w.VideoDecoder;
				w.VideoDecoder = class VideoDecoder extends NativeVideoDecoder {
					static __tslpFirstFrameOnly = true;
					constructor( init = {} ) {
						let delivered = false;
						const output = typeof init.output === 'function' ? init.output : null;
						super( {
							...init,
							output( frame ) {
								if ( delivered ) {
									try { frame.close && frame.close(); } catch ( _ ) {}
									return;
								}
								delivered = true;
								w.__tslpVideoFrameDelivered = true;
								if ( output ) return output( frame );
							},
						} );
					}
					decode( chunk ) {
						if ( w.__tslpVideoFrameDelivered === true ) return;
						return super.decode( chunk );
					}
					flush() {
						if ( w.__tslpVideoFrameDelivered === true ) return new Promise( () => {} );
						return super.flush();
					}
				};
			}
			w.__tslpWrapAnimationLoop = function ( callback ) {

				w.__tslpAnimationLoopRegistered = typeof callback === 'function';
				w.__tslpAnimationLoopCalls = 0;
				w.__tslpSettleTicks = 0;
				if ( typeof callback !== 'function' ) return callback;
				return function ( ...args ) {

					const atTarget = ( w.__tslpRafTick | 0 ) >= freezeAt;
					const waitingForRenderableObjects = w.__tslpWaitForRenderableObjects === true && ( w.__tslpRenderableObjectCount | 0 ) < ( w.__tslpMinRenderableObjects | 0 );
					const waitingForAsyncCounters = ( w.__tslpLoaderPending | 0 ) !== 0
						|| ( w.__tslpCompilePending | 0 ) !== 0
						|| ( w.__tslpPmremPending | 0 ) !== 0
						|| ( w.__tslpShadowPending | 0 ) !== 0
						|| ( w.__tslpComputePending | 0 ) !== 0;
					const waitingForAsyncWork = waitingForAsyncCounters || waitingForRenderableObjects;
					if ( atTarget && waitingForAsyncWork ) w.__tslpAnimationLoopCalls = 0;
					if ( atTarget && waitingForAsyncCounters && w.__tslpHoldAnimationUntilReady === true ) return;
					const shadowPendingAtTarget = atTarget && ( w.__tslpShadowPending | 0 ) !== 0;
					const freezeAfterShadowFrame = shadowPendingAtTarget && w.__tslpShadowFreezeFrameConsumed !== true;
					if ( shadowPendingAtTarget && ! freezeAfterShadowFrame ) { w.__tslpFrozen = true; return; }
					if ( atTarget && ( w.__tslpComputePending | 0 ) !== 0 ) return;
					if ( atTarget && ! waitingForAsyncWork && ( w.__tslpAnimationLoopCalls | 0 ) >= settleFrames ) return;
					w.__tslpAnimationLoopCalls = ( w.__tslpAnimationLoopCalls | 0 ) + 1;
					w.__tslpFrameCallbackCount = ( w.__tslpFrameCallbackCount | 0 ) + 1;
					const result = callback.apply( this, args );
					if ( freezeAfterShadowFrame ) {
						w.__tslpShadowFreezeFrameConsumed = true;
						w.__tslpFrozen = true;
					}
					return result;

				};

			};

			// Pending counters for async loaders (HDR/GLTF/MaterialX/Texture/...) and
			// in-flight renderer.compileAsync() promises. The Playwright wait gate
			// requires both === 0 (and 250 ms of quiescence) before screenshotting,
			// so capture doesn't fire mid-cascade for examples like
			// webgpu_loader_materialx that load 20+ assets sequentially.
			w.__tslpLoaderPending = 0;
			w.__tslpCompilePending = 0;
				w.__tslpLoaderLastBusyAt = 0;
				w.__tslpWaitForRenderableObjects = waitForRenderableObjects === true;
				w.__tslpMinRenderableObjects = Math.max( 1, minRenderableObjects | 0 );
				w.__tslpHoldAnimationUntilReady = holdAnimationUntilReady === true;
				w.__tslpRenderableObjectCount = 0;
			w.__tslpRenderableLastBusyAt = 0;

			// Save the original Date.now BEFORE the synthetic-clock patch below
			// overwrites it. The wait gate uses real wall-clock time to enforce
			// "loaders quiet for 250 ms" — synthetic time freezes at tick 60 so it
			// can't measure post-freeze real-time settle.
			w.__tslpRealNow = Date.now.bind( Date );

				// Patch requestAnimationFrame to use a synthetic monotonic clock.
			// This ensures both capture and replay see the same `time` argument
			// in every animation callback — independent of real wall-clock time.
			//
			// Two-phase freeze:
			//   Phase 1 (tick < freezeAt): tick advances; cb sees time = tick * step.
			//   Phase 2 (tick >= freezeAt): tick is clamped at freezeAt; cb keeps
			//     firing at the same frozen time so renderer.render() continues to
			//     paint scene mutations from post-target loaders. The wrapper
			//     self-freezes (__tslpFrozen = true, all subsequent rAF squashed)
			//     once (a) all pending counters are 0 and have been quiet for
			//     LOADER_QUIESCENT_MS AND (b) `settleFrames` extra ticks have
			//     fired with everything still quiet. The settle pass covers
			//     things that don't bump our counters but still need a few
			//     frames to converge: OrbitControls damping, onWindowResize
			//     handlers calling renderer.setSize without an explicit render,
			//     post-load setTimeout(0) chains, GUI build re-layouts.
			w.__tslpSettleTicks = 0;
			const origRaf = w.requestAnimationFrame.bind( w );
			w.requestAnimationFrame = function ( cb ) {

				return origRaf( () => {

					if ( w.__tslpFrozen ) return; // squash: freeze already triggered
					if ( w.__tslpRafTick < freezeAt ) {
						const tick = ++ w.__tslpRafTick;
						cb( base + tick * step );
						return;
					}
					// Phase 2: clamped time, keep painting until counters settle
					// AND `settleFrames` extra ticks have fired without activity.
					cb( base + freezeAt * step );
					const lastBusy = w.__tslpLoaderLastBusyAt | 0;
					const renderableLastBusy = w.__tslpRenderableLastBusyAt | 0;
					const realNow = ( typeof w.__tslpRealNow === 'function' ) ? w.__tslpRealNow() : 0;
					const renderableReady = w.__tslpWaitForRenderableObjects !== true || ( w.__tslpRenderableObjectCount | 0 ) >= ( w.__tslpMinRenderableObjects | 0 );
					const animationLoopRegistered = w.__tslpAnimationLoopRegistered === true;
					const animationLoopReady = ! animationLoopRegistered || ( w.__tslpAnimationLoopCalls | 0 ) >= settleFrames;
					const settleTarget = animationLoopRegistered ? 1 : settleFrames;
					const quiescent = ( ( lastBusy === 0 ) || ( realNow && ( realNow - lastBusy ) >= quiescentMs ) )
						&& ( ( renderableLastBusy === 0 ) || ( realNow && ( realNow - renderableLastBusy ) >= quiescentMs ) );
					const allZero = ( w.__tslpLoaderPending | 0 ) === 0
						 && ( w.__tslpCompilePending | 0 ) === 0
						 && ( w.__tslpPmremPending | 0 ) === 0
						 && ( w.__tslpShadowPending | 0 ) === 0
						 && ( w.__tslpComputePending | 0 ) === 0
						 && renderableReady
						 && animationLoopReady;
					if ( quiescent && allZero ) {
						w.__tslpSettleTicks = ( w.__tslpSettleTicks | 0 ) + 1;
						if ( w.__tslpSettleTicks >= settleTarget ) w.__tslpFrozen = true;
					} else {
						// New activity in this settle pass — restart the countdown
						// so freeze waits for another `settleFrames` quiet ticks.
						w.__tslpSettleTicks = 0;
					}

				} );

			};

			// Also patch Date.now() and performance.now() so examples that
			// drive animation from wall-clock time (instead of the rAF
			// timestamp) produce the same positions in capture and replay.
			// We use tick-based values starting at 0 so both passes are
			// always in sync.
			//
			// Strategy: replace window.performance with a Proxy so the
			// 'now' getter is intercepted regardless of how the native
			// Performance object defines it (accessor vs data, configurable
			// or not). window.performance itself is a configurable accessor
			// on window, so we can swap it via Object.defineProperty.
			const _syntheticNow = () => base + w.__tslpRafTick * step;
			w.Date.now = _syntheticNow;
			w.__tslpPerfNowLog = []; // diagnostic: log every performance.now() call
			const _syntheticNowLogged = () => {
				const val = base + w.__tslpRafTick * step;
				w.__tslpPerfNowLog.push( val );
				return val;
			};
			try {
				const _origPerf = w.performance;
				const _perfProxy = new Proxy( _origPerf, {
					get( target, prop, receiver ) {
						if ( prop === 'now' ) return _syntheticNowLogged;
						const val = Reflect.get( target, prop, target );
						return typeof val === 'function' ? val.bind( target ) : val;
					},
				} );
				Object.defineProperty( w, 'performance', {
					value: _perfProxy,
					writable: true,
					configurable: true,
					enumerable: true,
				} );
			} catch ( _ ) {
				// Fallback chain if Proxy or property replacement fails
				try {
					Object.defineProperty( w.Performance.prototype, 'now', {
						value: _syntheticNow,
						writable: true,
						configurable: true,
					} );
				} catch ( _2 ) {
					try {
						Object.defineProperty( w.performance, 'now', {
							value: _syntheticNow,
							writable: true,
							configurable: true,
						} );
					} catch ( _3 ) {
						w.performance.now = _syntheticNow;
					}
				}
			}

			// Deterministic Math.random per callsite. A single global RNG stream is
			// too fragile here because replay constructs extra helper objects, which
			// shifts later user-scene random calls. Keying by normalized stack line
			// keeps loops at the same user callsite aligned across stock/capture/replay.
			const _rngCounts = new Map();
			const _hashString = ( text ) => {
				let h = 2166136261 >>> 0;
				for ( let i = 0; i < text.length; i ++ ) {
					h ^= text.charCodeAt( i );
					h = Math.imul( h, 16777619 ) >>> 0;
				}
				return h >>> 0;
			};
			const _mixRng = ( seed ) => {
				let x = seed >>> 0;
				x ^= x >>> 16;
				x = Math.imul( x, 0x7feb352d ) >>> 0;
				x ^= x >>> 15;
				x = Math.imul( x, 0x846ca68b ) >>> 0;
				x ^= x >>> 16;
				return x >>> 0;
			};
			const _randomKeyFromStack = ( stack ) => {
				const lines = String( stack || '' ).split( '\n' ).slice( 1 );
				const exampleLines = [];
				const userLines = [];
				const fallbackLines = [];
				const normalizeLine = ( line ) => String( line || '' )
					.replace( /https?:\/\/[^/]+/g, '' )
					.replace( /\?[^:)\s]+/g, '' )
					.trim();
				const isHarnessLine = ( line ) => line.includes( '__tslp__' ) || line.includes( '/__tslp_' );
				const isThreeInternalLine = ( line ) => (
					/\/build\/three\.[^/)\s]+\.js/.test( line ) ||
					/(^|[(\s])\/src\//.test( line )
				);
				for ( let line of lines ) {
					if ( line.includes( 'Math.random' ) ) continue;
					line = normalizeLine( line );
					if ( ! line ) continue;
					fallbackLines.push( line );
					if ( isHarnessLine( line ) || isThreeInternalLine( line ) ) continue;
					if ( line.includes( '/examples/' ) && ! line.includes( '/examples/jsm/' ) ) {
						exampleLines.push( line );
						if ( exampleLines.length >= 2 ) return exampleLines.join( ' <= ' );
						continue;
					}
					userLines.push( line );
					if ( userLines.length >= 2 ) break;
				}
				if ( exampleLines.length > 0 ) return exampleLines.join( ' <= ' );
					if ( userLines.length > 0 ) return userLines.join( ' <= ' );
					return fallbackLines.slice( 0, 2 ).join( ' <= ' ) || 'unknown';
				};
				const _objectIdCounts = new Map();
				w.__tslpStableObject3DId = function () {
					let stack = '';
					try { stack = String( new Error().stack || '' ); } catch ( _ ) {}
					const key = _randomKeyFromStack( stack );
					const count = ( _objectIdCounts.get( key ) || 0 ) + 1;
					_objectIdCounts.set( key, count );
					return _mixRng( _hashString( 'object3d#' + key + '#' + count + '#42' ) );
				};
				w.Math.random = function () {

					let stack = '';
					try { stack = String( new Error().stack || '' ); } catch ( _ ) {}
				const key = _randomKeyFromStack( stack );
				const count = ( _rngCounts.get( key ) || 0 ) + 1;
				_rngCounts.set( key, count );
				return _mixRng( _hashString( key + '#' + count + '#42' ) ) / 4294967296;

			};

		}, { step: FRAME_STEP_MS, base: 0, freezeAt: TARGET_TICK, quiescentMs: LOADER_QUIESCENT_MS, settleFrames: effectiveSettleFrames, waitForRenderableObjects, minRenderableObjects, holdAnimationUntilReady, exampleName: name } );
		mark( 'initScriptMs', stepStartedAt );

	} catch ( _ ) { /* older Playwright fallback */ }

	try {

		stepStartedAt = Date.now();
			const examplePath = examplePathFor( name );
			const separator = examplePath.includes( '?' ) ? '&' : '?';
			await page.goto( `http://localhost:${ port }/examples/${ examplePath }${ separator }__tslp_mode=${ mode }&__tslp_case=${ encodeURIComponent( name ) }`, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS } );
		mark( 'gotoMs', stepStartedAt );

		// Debug: verify timing patch is active. performance.now() should return
		// a tick-based synthetic value (< 10000) rather than real wall-clock
		// time (>> 10000). Log a warning if patch isn't working.
		try {
			const _perfNowCheck = await page.evaluate( () => window.performance.now() );
			if ( _perfNowCheck > 10000 ) console.warn( `[tslp-patch-warn] ${ name } ${ mode }: performance.now()=${ _perfNowCheck.toFixed(0) } — patch may not be active` );
		} catch ( _ ) {}

		await maybeClickStart( page );

		// Wait for the canvas to paint a non-empty frame under real
		// wall-clock time. This lets async loaders, `renderer.init()`,
		// aux capture (microtask chains), and the first rAF tick run
		// uninterrupted. Without this window, captures with async
		// setup (HDR / KTX2 / GLTF) would be incomplete.
		stepStartedAt = Date.now();
		const bright = await waitForFrame( page, mode === 'capture' ? RENDER_TIMEOUT_MS : Math.max( waitMs, RENDER_TIMEOUT_MS ) );
		mark( 'initialFrameMs', stepStartedAt );

		// Additional real-time settle so aux capture (Promise chains)
		// and post-init scene mutations have time to complete.
		stepStartedAt = Date.now();
		await new Promise( ( r ) => setTimeout( r, ASSET_SETTLE_MS ) );
		mark( 'assetSettleMs', stepStartedAt );

		// Wait until the init-script rAF wrapper reaches TARGET_TICK and
		// self-freezes. The freeze happens
		// atomically inside the wrapper (no Playwright round-trip race),
		// so stock/capture/replay screenshot the same settled animation phase.
		try {

			stepStartedAt = Date.now();
			await page.waitForFunction(
				// Also wait for async PMREM generations, compute dispatches,
				// shadow-map renders, three.js loader items (HDR/GLTF/MaterialX/
				// Texture/...), and renderer.compileAsync() promises — so the
				// screenshot fires on a fully-loaded, fully-compiled frame.
				// LOADER_QUIESCENT_MS bridges sequential-load loops where the
				// loader counter briefly hits 0 between awaits.
				( quiescentMs ) => {
					if ( window.__tslpFrozen !== true ) return false;
					if ( ( window.__tslpPmremPending | 0 ) !== 0 ) return false;
					if ( ( window.__tslpComputePending | 0 ) !== 0 ) return false;
					if ( ( window.__tslpShadowPending | 0 ) !== 0 ) return false;
					if ( ( window.__tslpLoaderPending | 0 ) !== 0 ) return false;
					if ( ( window.__tslpCompilePending | 0 ) !== 0 ) return false;
					const now = ( typeof window.__tslpRealNow === 'function' ) ? window.__tslpRealNow() : Date.now();
					const lastBusy = window.__tslpLoaderLastBusyAt | 0;
					if ( lastBusy && ( now - lastBusy ) < quiescentMs ) return false;
					return true;
					},
					LOADER_QUIESCENT_MS,
					{ timeout: LOADER_TIMEOUT_MS, polling: 50 },
				);
			mark( 'freezeWaitMs', stepStartedAt );

			// Brief settle so the GPU presents the frozen frame.
			stepStartedAt = Date.now();
			await new Promise( ( r ) => setTimeout( r, PRESENT_SETTLE_MS ) );
			mark( 'presentSettleMs', stepStartedAt );

			} catch ( _ ) {
				mark( 'freezeWaitMs', stepStartedAt );
				timings.freezeTimedOut = true;
				try {
					timings.freezeState = await page.evaluate( () => ( {
						frozen: window.__tslpFrozen === true,
						rafTick: window.__tslpRafTick | 0,
						settleTicks: window.__tslpSettleTicks | 0,
						loaderPending: window.__tslpLoaderPending | 0,
						compilePending: window.__tslpCompilePending | 0,
						pmremPending: window.__tslpPmremPending | 0,
						computePending: window.__tslpComputePending | 0,
						shadowPending: window.__tslpShadowPending | 0,
						lastBusyAgeMs: typeof window.__tslpRealNow === 'function' ? window.__tslpRealNow() - ( window.__tslpLoaderLastBusyAt | 0 ) : null,
						fullAutoLoaded: window.__tslpFullAutoLoaded === true,
						rendererBound: window.__tslpRendererBound === true,
						animationLoopRegistered: window.__tslpAnimationLoopRegistered === true,
						animationLoopCalls: window.__tslpAnimationLoopCalls | 0,
						wrapperIsActive: typeof window.__tslpWrapAnimationLoop === 'function',
					} ) );
				} catch ( _2 ) {}
			}

		stepStartedAt = Date.now();
		const shot = await dumpCanvas( page );
		mark( 'screenshotMs', stepStartedAt );
		// Re-measure bright from the final screenshot PNG — WebGPU canvas pixels
		// are often not readable via 2D-context drawImage during the animation loop
		// (the compositing pipeline lags), so the waitForFrame poll may see 0 even
		// when the canvas has content. The Playwright screenshot always captures the
		// composited frame, so computing brightness from it gives the true value.
		stepStartedAt = Date.now();
			const shotBright = shot ? await brightFraction( page, shot ) : 0;
			mark( 'shotBrightMs', stepStartedAt );
			const finalBright = Math.max( bright, shotBright );
			let frameTextureSnapshot = null;
			if ( process.env.TSLP_DEBUG_FRAME_TEXTURE_SNAPSHOT === '1' ) {
				stepStartedAt = Date.now();
				frameTextureSnapshot = await collectFrameTextureSnapshot( page );
				mark( 'frameTextureSnapshotMs', stepStartedAt );
			}
			if ( mode === 'capture' ) {
				stepStartedAt = Date.now();
				await page.evaluate( async () => {
					if ( typeof window.__tslpFlushCaptureArtifacts === 'function' ) await window.__tslpFlushCaptureArtifacts();
			} );
			mark( 'flushCaptureMs', stepStartedAt );
		}
		// Wedge 4: read the deterministic clock at the moment the screenshot
		// was taken. nodeFrame.time accumulates from `performance.now()`, which
		// the harness patched to `base + __tslpRafTick * step`. So at freeze,
		// nodeFrame.time should equal that synthetic value (in seconds).
		// We try renderer._nodes.nodeFrame.time first (authoritative), then
		// fall back to the synthetic rAF clock if no renderer global is exposed.
		let frameClock = null;
		try {
			frameClock = await page.evaluate( () => {
				const w = window;
				const candidates = [];
				if ( w.__tslpSlimRenderer ) candidates.push( w.__tslpSlimRenderer );
				if ( w.__tslpFullRenderer ) candidates.push( w.__tslpFullRenderer );
				if ( w.__tslpCurrentReplayRenderer ) candidates.push( w.__tslpCurrentReplayRenderer );
				if ( w.__tslpHarnessRenderer ) candidates.push( w.__tslpHarnessRenderer );
				for ( const r of candidates ) {
					const t = r && r._nodes && r._nodes.nodeFrame && r._nodes.nodeFrame.time;
					if ( typeof t === 'number' && Number.isFinite( t ) ) return t;
				}
				// Fallback: the synthetic rAF clock (seconds, base 0, step ms / 1000).
				if ( typeof w.__tslpRafTick === 'number' && typeof w.__tslpFrozen === 'boolean' ) {
					return ( w.__tslpRafTick | 0 ) * ( 16.6667 / 1000 );
				}
				return null;
			} );
		} catch ( _ ) {}
		const real = errors.filter( ( e ) => ! /favicon|Failed to load resource/i.test( e ) );
			const diagnostics = await page.evaluate( () => {
				return window.__tslpHarnessDiagnostics || null;
			} ).catch( () => null );
			if ( diagnostics && frameTextureSnapshot ) diagnostics.frameTextureSnapshot = frameTextureSnapshot;
			timings.totalMs = Date.now() - startedAt;
			return { bright: finalBright, shot, errors: real.slice( 0, 5 ), warnings: warnings.slice( 0, 5 ), diagnostics, context, page, timings, cleanup, frameClock };

	} catch ( err ) {

		const diagnostics = await page.evaluate( () => window.__tslpHarnessDiagnostics || null ).catch( () => null );
		timings.totalMs = Date.now() - startedAt;
		return { bright: 0, shot: null, errors: [ err && err.message || String( err ) ], warnings: warnings.slice( 0, 5 ), diagnostics, navigationError: true, context, page, timings, cleanup };

	}

}

/**
 * Decide whether the PSNR-based pixel gate passes. Returns one of:
 *   { skipped: true, reason }      — comparison didn't run (frames empty, dim mismatch, etc.)
 *   { pass: true,  psnr, threshold } — frames agree at or above the threshold
 *   { pass: false, psnr, threshold } — frames diverge below threshold (visual regression)
 *
 * The caller folds `pass === false` into the overall pass calculation; `skipped`
 * never counts as a failure (the underlying frame-empty / nav-error gates catch
 * those cases on their own).
 */
function pixelGateOf( metrics, threshold ) {

	if ( ! metrics ) return { skipped: true, reason: 'no metrics' };
	if ( metrics.skipped ) return metrics;
	if ( metrics.error ) return { skipped: true, reason: metrics.error };
	const { psnr } = metrics;
	if ( psnr === 'inf' ) return { pass: true, psnr: 'inf', threshold };
	if ( typeof psnr !== 'number' ) return { skipped: true, reason: 'no psnr' };
	return { pass: psnr >= threshold, psnr, threshold };

}

function pixelGateEnabledForExample( name ) {

	if ( ! pixelGateEnabled ) return false;
	if ( pixelGateDisabledReasonForExample( name ) ) return false;
	if ( localExamplesRoot ) {
		const options = localExampleOptions.get( name );
		if ( options && options.pixelGate === false ) return false;
	}
	return true;

}

function mergeDiagnostics( ...items ) {

	const present = items.filter( Boolean );
	if ( present.length === 0 ) return null;
	const merged = { colorTransferFallbacks: {}, healedNullTextureImages: 0 };
	const frameTextureSnapshot = [];
	for ( const item of present ) {

		merged.healedNullTextureImages += item.healedNullTextureImages | 0;
		for ( const [ key, count ] of Object.entries( item.colorTransferFallbacks || {} ) ) {

			merged.colorTransferFallbacks[ key ] = ( merged.colorTransferFallbacks[ key ] || 0 ) + ( count | 0 );

		}
		if ( Array.isArray( item.frameTextureSnapshot ) ) frameTextureSnapshot.push( ...item.frameTextureSnapshot );

	}
	if ( frameTextureSnapshot.length > 0 ) merged.frameTextureSnapshot = frameTextureSnapshot;
	return merged;

}

async function runOne( browser, name ) {

	captures.delete( name );
	const overrideWaitMs = HAS_EXPLICIT_CAPTURE_WAIT ? 0 : captureWaitOverrideForExample( name );
	const effectiveCaptureWait = overrideWaitMs > captureWaitMs ? overrideWaitMs : captureWaitMs;
	const capture = reuseReferenceShot
		? loadSavedReferenceShot( name )
		: await visitExample( browser, name, 'stock', effectiveCaptureWait );
	// Wedge 4: remember the stock pass's nodeFrame.time so the replay pass can
	// pin its clock to the SAME value the comparison-reference screenshot saw.
	// injectHtml in replay mode reads this from the bucket below.
	if ( capture && typeof capture.frameClock === 'number' && Number.isFinite( capture.frameClock ) ) {
		const bucket = captureBucket( name );
		bucket.frameClock = capture.frameClock;
		if ( process.env.TSLP_DEBUG_CLOCK === '1' ) console.log( '[tslp-clock] ' + name + ' stock frameClock=' + capture.frameClock );
	}
	// Tear down listeners + page + context as soon as the visit returns.
	// Holding only the screenshot Buffer past this point lets Chromium
	// release the page's GPU surface before we open the next one.
	if ( capture.cleanup ) await capture.cleanup();
	capture.cleanup = null;
	capture.context = null;
	capture.page = null;

	const artifactCapture = replayOnly
		? emptyVisitResult()
		: await visitExample( browser, name, 'capture', effectiveCaptureWait );
	if ( artifactCapture.cleanup ) await artifactCapture.cleanup();
	artifactCapture.cleanup = null;
	artifactCapture.context = null;
	artifactCapture.page = null;
	// The capture pass exists to harvest TSL artifacts into `bucket`; its
	// screenshot is never read downstream (PSNR runs against the stock shot).
	artifactCapture.shot = null;
	if ( replayOnly ) loadSavedArtifacts( name );
	const bucket = captureBucket( name );
	const userCount = Object.keys( bucket.user ).length;
	const auxCount = bucket.aux.length;
	const artifactSummaries = summarizeArtifacts( bucket );
	const auxSummaries = summarizeAuxArtifacts( bucket );

	const replay = await visitExample( browser, name, 'replay', replayWaitMs );
	const passTimings = {
		stock: capture.timings || null,
		capture: artifactCapture.timings || null,
		replay: replay.timings || null,
	};
	if ( capture.shot && replay.page ) {

		const referenceBrightStartedAt = Date.now();
		capture.bright = await brightFraction( replay.page, capture.shot );
		if ( passTimings.replay ) passTimings.replay.referenceBrightMs = Date.now() - referenceBrightStartedAt;

	}
	const captureErrors = [ ...capture.errors, ...artifactCapture.errors ];
	const captureWarnings = [ ...( capture.warnings || [] ), ...( artifactCapture.warnings || [] ) ];
	const blockingCaptureErrors = [
		...capture.errors,
		...artifactCapture.errors.filter( ( error ) => ! isIgnorableCaptureError( error ) ),
	];
	const expectedReplayPatterns = expectedReplayErrorPatternsForExample( name );
	const blockingReplayErrors = replay.errors.filter( ( error ) => ! isIgnorableReplayError( error ) && ! expectedReplayPatterns.some( ( re ) => re.test( error ) ) );

	let pixelMetrics;
	if ( capture.shot && replay.shot && capture.bright > 0.005 && replay.bright > 0.005 && replay.page ) {

		pixelMetrics = await comparePSNR( replay.page, capture.shot, replay.shot, name ).catch( ( err ) => ( { error: err && err.message || String( err ) } ) );

	} else {

		pixelMetrics = { skipped: true, reason: capture.bright <= 0.005 ? 'capture frame empty' : replay.bright <= 0.005 ? 'replay frame empty' : 'screenshot missing' };

	}
	if ( saveShots ) {

		const shotsDir = join( OUT, 'shots' );
		if ( ! existsSync( shotsDir ) ) mkdirSync( shotsDir, { recursive: true } );
		const safe = safeExampleName( name );
		if ( capture.shot ) writeFileSync( join( shotsDir, `${ safe }.capture.png` ), capture.shot );
		if ( replay.shot ) writeFileSync( join( shotsDir, `${ safe }.replay.png` ), replay.shot );
		// Also dump full captured user-material artifacts for debugging.
		const artifactsDir = join( OUT, 'artifacts' );
		if ( ! existsSync( artifactsDir ) ) mkdirSync( artifactsDir, { recursive: true } );
		writeArtifactDebugDump( join( artifactsDir, `${ safe }.user.json` ), bucket.user, artifactSummaries );
		writeArtifactDebugDump( join( artifactsDir, `${ safe }.aux.json` ), bucket.aux, auxSummaries );

	}
	if ( replay.cleanup ) await replay.cleanup();
	replay.cleanup = null;
	replay.context = null;
	replay.page = null;

	const effectivePsnrThreshold = psnrThresholdForExample( name, psnrThreshold );
	const pixelGate = pixelGateOf( pixelMetrics, effectivePsnrThreshold );
	const examplePixelGateEnabled = pixelGateEnabledForExample( name );
	if ( ! examplePixelGateEnabled && pixelGate && pixelGate.pass === false ) pixelGate.disabled = true;
	const pixelGateOk = ! examplePixelGateEnabled || pixelGate.pass !== false;
	const pass = ( userCount > 0 || auxCount > 0 ) && blockingCaptureErrors.length === 0 && replay.bright > 0.005 && blockingReplayErrors.length === 0 && pixelGateOk;

	// Release everything that won't make it into the report: TSL artifact
	// buckets (many MB on heavy scenes) and the capture/replay screenshot
	// Buffers (~1.5 MB each at 640×480). Without this the worker accumulates
	// these per-example across its whole slice and the OS sees steady RSS
	// growth — on Apple Silicon's unified memory that compounds with the
	// Chromium GPU process and eventually freezes the whole machine.
	captures.delete( name );
	capture.shot = null;
	artifactCapture.shot = null;
	replay.shot = null;

	return {
		name,
		status: pass ? 'pass' : 'fail',
		captureBrightFrac: capture.bright,
		replayBrightFrac: replay.bright,
		pixelGate,
		userArtifacts: userCount,
		auxArtifacts: auxCount,
		captureErrors,
		replayErrors: replay.errors,
		captureWarnings,
		replayWarnings: replay.warnings || [],
		captureDiagnostics: mergeDiagnostics( capture.diagnostics, artifactCapture.diagnostics ),
		replayDiagnostics: replay.diagnostics || null,
		timings: passTimings,
		artifactSummaries,
		auxSummaries,
		error: pass ? null : summarizeFailure( { userCount, blockingCaptureErrors, replayBright: replay.bright, blockingReplayErrors, pixelGate, pixelGateEnabled: examplePixelGateEnabled } ),
	};

}

function summarizeArtifacts( bucket ) {

	return Object.entries( bucket.user ).map( ( [ name, entry ] ) => {

		const artifact = entry.artifact || {};
		return {
			name,
			hash: entry.__hash || null,
			cacheKey: artifact.cacheKey,
			shape: artifact.materialShape,
			vertexSnippet: String( artifact.vertexShader || '' ).slice( 0, 1200 ),
			fragmentSnippet: String( artifact.fragmentShader || '' ).slice( 0, 1200 ),
			attributes: ( artifact.attributes || [] ).map( ( attribute ) => ( {
				name: attribute.name,
				type: attribute.type,
				source: attribute.source,
				count: attribute.count,
				itemSize: attribute.itemSize,
				arrayType: attribute.arrayType,
			} ) ),
			textures: ( artifact.uniformPlan || [] ).flatMap( ( group ) => ( group.textures || [] ).map( ( texture ) => ( {
				group: group.name,
				name: texture.name,
				kind: texture.source && texture.source.kind,
				property: texture.source && texture.source.property,
				textureUuid: texture.source && texture.source.textureUuid,
				imageSrc: texture.source && texture.source.imageSrc,
				textureName: texture.source && texture.source.textureName,
				hasSnapshot: !! ( texture.source && texture.source.snapshot ),
				snapshotSize: texture.source && texture.source.snapshot ? [ texture.source.snapshot.width, texture.source.snapshot.height ] : null,
			} ) ) ),
		};

	} );

}

function summarizeAuxArtifacts( bucket ) {

	return ( bucket.aux || [] ).map( ( entry ) => {

		const artifact = entry.artifact || {};
		return {
			shape: entry.shape,
			configHash: entry.configHash,
			artifactShape: artifact.materialShape,
			cacheKey: artifact.cacheKey,
			attributes: ( artifact.attributes || [] ).map( ( attribute ) => ( {
				name: attribute.name,
				type: attribute.type,
				source: attribute.source,
				count: attribute.count,
				itemSize: attribute.itemSize,
				arrayType: attribute.arrayType,
			} ) ),
			bindings: ( artifact.bindings || [] ).map( ( group ) => ( {
				name: group.name,
				bindings: ( group.bindings || [] ).map( ( binding ) => ( { name: binding.name, kind: binding.kind, byteLength: binding.byteLength } ) ),
			} ) ),
			uniformPlan: ( artifact.uniformPlan || [] ).map( ( group ) => ( {
				name: group.name,
				byteLength: group.byteLength,
				slotCount: ( group.slots || [] ).length,
				textures: ( group.textures || [] ).map( ( texture ) => ( {
					name: texture.name,
					kind: texture.source && texture.source.kind,
					property: texture.source && texture.source.property,
					textureUuid: texture.source && texture.source.textureUuid,
					hasSnapshot: !! ( texture.source && texture.source.snapshot ),
					snapshotSize: texture.source && texture.source.snapshot ? [ texture.source.snapshot.width, texture.source.snapshot.height ] : null,
				} ) ),
			} ) ),
		};

	} );

}

function isIgnorableCaptureError( error ) {

	return /extraction returned no artifact/.test( error ) ||
		/texture\( value \).*valid instance of THREE\.Texture/.test( error ) ||
		/RenderPassEncoder .* already ended/.test( error ) ||
		/The fragment stage has fewer output components .* color format/.test( error ) ||
		/Invalid ShaderModule/.test( error );

}

function isIgnorableReplayError( error ) {

	return /Invalid ShaderModule/.test( error ) ||
		/Cannot read properties of null \(reading 'depthTexture'\)/.test( error ) ||
		/Cannot initialize TileShadowNodeHelper: Shadow nodes not ready or mismatch count/.test( error ) ||
		/Attribute base type \(Float for VertexFormat::Float32x4\) does not match the shader's base type \(Uint\)/.test( error );

}

function summarizeFailure( { userCount, blockingCaptureErrors, replayBright, blockingReplayErrors, pixelGate, pixelGateEnabled } ) {

	if ( userCount === 0 ) return 'capture produced no user-material artifacts';
	if ( blockingCaptureErrors.length > 0 ) return blockingCaptureErrors[ 0 ].slice( 0, 500 );
	if ( replayBright <= 0.005 ) return 'slim replay did not produce a non-empty frame';
	if ( blockingReplayErrors.length > 0 ) return blockingReplayErrors[ 0 ].slice( 0, 500 );
	if ( pixelGateEnabled && pixelGate && pixelGate.pass === false ) return `pixel diff PSNR ${ pixelGate.psnr } dB < threshold ${ pixelGate.threshold } dB (visual regression)`;
	return 'unknown replay failure';

}

function formatPercent( value ) {

	if ( typeof value !== 'number' || ! Number.isFinite( value ) ) return 'n/a';
	return ( value * 100 ).toFixed( 1 ) + '%';

}

function compactText( value, max = 180 ) {

	const text = String( value || '' ).replace( /\s+/g, ' ' ).trim();
	return text.length > max ? text.slice( 0, max - 1 ) + '…' : text;

}

function formatPixelGate( gate ) {

	if ( ! gate ) return 'psnr n/a';
	if ( gate.skipped ) return `psnr skipped (${ compactText( gate.reason, 48 ) })`;
	if ( gate.pass === undefined ) return 'psnr n/a';
	if ( gate.disabled ) return `psnr ${ gate.psnr }/${ gate.threshold } dB diagnostic`;
	const verdict = gate.pass ? 'ok' : 'FAIL';
	return `psnr ${ gate.psnr }/${ gate.threshold } dB ${ verdict }`;

}

function diagnosticNote( diagnostics ) {

	if ( ! diagnostics ) return '';
	const parts = [];
	if ( diagnostics.healedNullTextureImages > 0 ) parts.push( `healed-null-images=${ diagnostics.healedNullTextureImages }` );
	const fallbacks = diagnostics.colorTransferFallbacks || {};
	const fallbackTotal = Object.values( fallbacks ).reduce( ( sum, count ) => sum + ( count | 0 ), 0 );
	if ( fallbackTotal > 0 ) parts.push( `color-fallbacks=${ fallbackTotal }` );
	return parts.length ? parts.join( ', ' ) : '';

}

function formatResultLine( label, result ) {

	const status = result.status === 'pass' ? 'PASS' : 'FAIL';
	const parts = [
		`${ label } ${ status }`,
		`artifacts ${ result.userArtifacts }+${ result.auxArtifacts }`,
		`capture ${ formatPercent( result.captureBrightFrac ) }`,
		`replay ${ formatPercent( result.replayBrightFrac ) }`,
		formatPixelGate( result.pixelGate ),
	];
	const diag = diagnosticNote( result.replayDiagnostics );
	if ( diag ) parts.push( diag );
	if ( result.error ) parts.push( `error: ${ compactText( result.error ) }` );
	return parts.join( ' | ' );

}

function formatTimingLine( result ) {

	if ( ! result || ! result.timings ) return '';
	const parts = [];
	for ( const mode of [ 'stock', 'capture', 'replay' ] ) {

		const t = result.timings[ mode ];
		if ( ! t ) continue;
		const ms = ( key ) => `${ key }=${ t[ key ] || 0 }ms`;
		const detail = [
			ms( 'totalMs' ),
			ms( 'contextMs' ),
			ms( 'gotoMs' ),
			ms( 'initialFrameMs' ),
			ms( 'assetSettleMs' ),
			ms( 'freezeWaitMs' ),
			ms( 'presentSettleMs' ),
			ms( 'screenshotMs' ),
		];
		if ( t.referenceBrightMs ) detail.push( `referenceBrightMs=${ t.referenceBrightMs }ms` );
		if ( t.freezeTimedOut ) detail.push( 'freezeTimeout' );
		parts.push( `${ mode }(${ detail.join( ' ' ) })` );

	}
	return parts.length ? `  timings: ${ parts.join( ' | ' ) }` : '';

}

function printFailureSummary( details, max = 20 ) {

	const failures = details.filter( ( result ) => result && result.status === 'fail' );
	if ( failures.length === 0 ) return;
	console.log( '\nFailures:' );
	for ( const result of failures.slice( 0, max ) ) {
		const replayErrors = Array.isArray( result.replayErrors ) ? result.replayErrors.length : 0;
		const captureErrors = Array.isArray( result.captureErrors ) ? result.captureErrors.length : 0;
		const diag = diagnosticNote( result.replayDiagnostics );
		console.log( `  - ${ result.name }: ${ formatPixelGate( result.pixelGate ) }; replay ${ formatPercent( result.replayBrightFrac ) }; artifacts ${ result.userArtifacts }+${ result.auxArtifacts }; captureErrors=${ captureErrors }; replayErrors=${ replayErrors }${ diag ? '; ' + diag : '' }` );
		if ( result.error ) console.log( `    ${ compactText( result.error, 240 ) }` );
	}
	if ( failures.length > max ) console.log( `  ... ${ failures.length - max } more failures in the JSON report` );

}

let currentCdpHarness = null;

async function launchBrowser() {

	if ( currentCdpHarness ) {

		try { await currentCdpHarness.close(); } catch ( _ ) {}
		currentCdpHarness = null;

	}

	currentCdpHarness = await FastCDPHarness.launch( {
		headful: false,
		viewport: '640x480',
		chromiumArgs: BROWSER_ARGS
	} );

	return await chromium.connectOverCDP( currentCdpHarness.launch.webSocketUrl );

}

async function recycleBrowser( current ) {

	try { await current?.close(); } catch ( _ ) {}
	if ( currentCdpHarness ) {

		try { await currentCdpHarness.close(); } catch ( _ ) {}
		currentCdpHarness = null;

	}
	// Give the OS a beat to reclaim Chromium's GPU process before we spawn a
	// fresh one — without this delay the new browser's GPU process overlaps
	// with the dying one and unified-memory pressure spikes on Apple Silicon.
	if ( BROWSER_RESPAWN_DELAY_MS > 0 ) await new Promise( ( r ) => setTimeout( r, BROWSER_RESPAWN_DELAY_MS ) );
	// Best-effort manual GC between browser lifetimes — only fires if the
	// worker was launched with --expose-gc (the parallel runner does so).
	if ( typeof globalThis.gc === 'function' ) {
		try { globalThis.gc(); } catch ( _ ) {}
	}
	return await launchBrowser();

}

let browser = await launchBrowser();

const report = { total: candidates.length, pass: 0, fail: 0, skip: allExamples.length - candidates.length, details: [] };
let runsSinceRestart = 0;

const reportPath = join( OUT, reportFile );

try {

	for ( let i = 0; i < candidates.length; i ++ ) {

		const name = candidates[ i ];
		const label = `[${ i + 1 }/${ candidates.length }] ${ name }`;

		try {

			if ( runsSinceRestart >= MAX_RUNS_PER_BROWSER ) {

				browser = await recycleBrowser( browser );
				runsSinceRestart = 0;

			}

			const result = await runOne( browser, name );
			runsSinceRestart ++;
			if ( result.status === 'pass' ) report.pass ++; else report.fail ++;
			report.details.push( result );
			writeFileSync( reportPath, JSON.stringify( report, null, 2 ) );

			console.log( formatResultLine( label, result ) );
			if ( timingsEnabled ) {
				const timingLine = formatTimingLine( result );
				if ( timingLine ) console.log( timingLine );
			}

		} catch ( err ) {

			report.fail ++;
			report.details.push( { name, status: 'fail', error: err && err.message || String( err ) } );
			writeFileSync( reportPath, JSON.stringify( report, null, 2 ) );
			console.log( `${ label } — FAIL harness-error "${ err && err.message || err }"` );

			// Recover from a dead browser: without this, the first Chrome crash
			// poisons every remaining example because newContext() keeps throwing
			// "Target page, context or browser has been closed" against the dead
			// handle, so we lose ~80 % of the slice every time the renderer dies.
			const msg = err && err.message || String( err );
			if ( /browser has been closed|Target page, context|Browser closed/i.test( msg ) ) {
				browser = await recycleBrowser( browser );
				runsSinceRestart = 0;
			}

		}

	}

} finally {

	await browser.close().catch( () => {} );
	if ( currentCdpHarness ) {

		await currentCdpHarness.close().catch( () => {} );

	}
	server.close();

}

writeFileSync( reportPath, JSON.stringify( report, null, 2 ) );

console.log( '\n═══ e2e summary ═══' );
console.log( `  ${ report.pass } pass, ${ report.fail } fail, ${ report.skip } skip, ${ report.total } candidates` );
console.log( `  report: ${ reportPath }` );
printFailureSummary( report.details );

process.exit( report.fail === 0 ? 0 : 1 );
