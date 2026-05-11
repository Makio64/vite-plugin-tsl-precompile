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
 *   node packages/examples/batch/run-e2e.mjs --filter=ocean --port=8729 --port-retries=20
 *   node packages/examples/batch/run-e2e.mjs --filter=ocean --target-tick=60
 *   node packages/examples/batch/run-e2e.mjs --filter=ocean --timings
 */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolve, join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertThreeAtLeast184 } from './_three-version.mjs';

const SELF = dirname( fileURLToPath( import.meta.url ) );
const REPO = resolve( SELF, '../../..' );
const OUT = resolve( SELF, 'results' );
const RUNTIME_SRC = resolve( REPO, 'packages/runtime/src' );
const PLUGIN_SRC = resolve( REPO, 'packages/plugin/src' );
const SLIM_BUNDLE = resolve( REPO, 'packages/runtime/build/three.webgpu.slim.js' );

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

const threeRepo = resolve( getArg( '--three-repo=', resolve( SELF, '../../../../three.js' ) ) );
const filter = getArg( '--filter=', '' );
const limit = parseInt( getArg( '--limit=', '9999' ), 10 );
const offset = parseInt( getArg( '--offset=', '0' ), 10 );
let port = parseInt( getArg( '--port=', '8729' ), 10 );
const portRetries = parseInt( getArg( '--port-retries=', '100' ), 10 );
const captureWaitMs = parseInt( getArg( '--capture-wait-ms=', '8000' ), 10 );
const replayWaitMs = parseInt( getArg( '--replay-wait-ms=', '5000' ), 10 );
const targetTick = parseInt( getArg( '--target-tick=', '0' ), 10 );
const psnrThreshold = parseFloat( getArg( '--psnr-threshold=', '30' ) );
const pixelGateEnabled = ! args.includes( '--no-pixel-gate' );
const saveShots = args.includes( '--save-shots' );
const replayOnly = args.includes( '--replay-only' );
const reuseReferenceShot = replayOnly || args.includes( '--reuse-reference-shot' );
const verboseConsole = args.includes( '--verbose' ) || process.env.TSLP_E2E_VERBOSE === '1' || !! process.env.TSLP_DEBUG_TORNADO_VERBOSE;
const timingsEnabled = args.includes( '--timings' ) || process.env.TSLP_E2E_TIMINGS === '1';
const reportFile = getArg( '--report=', 'e2e-report.json' );

if ( ! existsSync( join( threeRepo, 'examples' ) ) ) {

	console.error( `[batch-e2e] three.js examples not found at ${ threeRepo }/examples. Pass --three-repo=<absolute-path>` );
	process.exit( 2 );

}

assertThreeAtLeast184( threeRepo, 'batch-e2e' );

const SKIP_PREFIXES = [
	'webxr_', 'vr_', 'ar_', 'webgpu_xr_', 'webgpu_webxr_',
	'webgpu_compile_async',
	'webgpu_tsl_precompile',
];
function shouldSkip( name ) { return SKIP_PREFIXES.some( ( p ) => name.includes( p ) ); }

const allExamples = readdirSync( join( threeRepo, 'examples' ) )
	.filter( ( f ) => f.startsWith( 'webgpu_' ) && f.endsWith( '.html' ) )
	.filter( ( f ) => ! filter || f.includes( filter ) )
	.slice( offset, offset + limit );
const candidates = allExamples.filter( ( f ) => ! shouldSkip( f ) );

console.log( `[batch-e2e] discovered ${ allExamples.length } webgpu_*.html — ${ candidates.length } after skip list` );

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
	'LineBasicNodeMaterial',
	'LineDashedNodeMaterial',
	'Line2NodeMaterial',
	'PointsNodeMaterial',
	'SpriteNodeMaterial',
	'ShadowNodeMaterial',
];

const captures = new Map();
function captureBucket( example ) {

	if ( ! captures.has( example ) ) captures.set( example, { user: {}, aux: [] } );
	return captures.get( example );

}

function jsonScriptLiteral( value ) {

	return JSON.stringify( value ).replace( /</g, '\\u003c' );

}

function injectHtml( html, example, mode ) {

	const bucket = captureBucket( example );
	const boot = `<script>window.__TSLP_E2E=${ jsonScriptLiteral( { example, mode, artifacts: bucket } ) };</script>`;
	const mapped = rewriteImportmap( html, mode );
	return mapped.includes( '</head>' )
		? mapped.replace( '</head>', `${ boot }\n</head>` )
		: boot + mapped;

}

function rewriteImportmap( html, mode ) {

	const webgpuTarget = mode === 'capture'
		? '/__tslp__/full-webgpu-auto.js'
		: mode === 'stock'
			? '/__tslp__/stock-webgpu.js'
			: '/__tslp__/slim-webgpu-replay.js';
	let out = html
		.replace( /("three\/webgpu"\s*:\s*")[^"]+(")/g, `$1${ webgpuTarget }$2` )
		.replace( /("three"\s*:\s*")[^"]*three\.webgpu[^"]*(")/g, `$1${ webgpuTarget }$2` );

	if ( mode === 'replay' ) {

		out = out.replace( /("three\/tsl"\s*:\s*")[^"]+(")/g, '$1/__tslp__/tsl-stub.js$2' );

	}

	const tslTarget = mode === 'replay' ? '/__tslp__/tsl-stub.js' : '/build/three.tsl.js';
	const extraImports = [
		`"three/webgpu": "${ webgpuTarget }"`,
		`"three/tsl": "${ tslTarget }"`,
		`"@tsl-precompile/runtime": "/__tslp_runtime/index.js"`,
		`"@tsl-precompile/runtime/apply": "/__tslp_runtime/apply-precompiled.js"`,
		`"@tsl-precompile/runtime/writers": "/__tslp_runtime/writers.js"`,
		`"three/src/": "/src/"`,
		`"vite-plugin-tsl-precompile/src/vendor/compileTSL.js": "/__tslp_plugin/vendor/compileTSL.js"`,
		`"vite-plugin-tsl-precompile/src/emit-updater.js": "/__tslp_plugin/emit-updater.js"`,
	];

	if ( out.includes( '</script>' ) && out.includes( '"imports"' ) ) {

		return out.replace( /"imports"\s*:\s*\{/, ( m ) => `${ m }\n${ extraImports.map( ( x ) => `\t\t\t\t${ x },` ).join( '\n' ) }` );

	}

	const importMap = `<script type="importmap">{"imports":{${ extraImports.join( ',' ) }}}</script>`;
	return out.includes( '</head>' ) ? out.replace( '</head>', `${ importMap }\n</head>` ) : importMap + out;

}

function stockWebgpuModule() {

	return `
import * as Original from '/build/three.webgpu.js';
export * from '/build/three.webgpu.js';

let __pmremRunning = 0;
window.__tslpPmremPending = window.__tslpPmremPending || 0;
window.__tslpCompilePending = window.__tslpCompilePending || 0;

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

export class WebGPURenderer extends Original.WebGPURenderer {
	compileAsync( scene, camera, ...rest ) {
		if ( __pmremRunning > 0 ) return typeof super.compileAsync === 'function' ? super.compileAsync( scene, camera, ...rest ) : Promise.resolve();
		if ( typeof super.compileAsync !== 'function' ) return Promise.resolve();
		window.__tslpCompilePending = ( window.__tslpCompilePending | 0 ) + 1;
		const settle = () => { window.__tslpCompilePending = Math.max( 0, ( window.__tslpCompilePending | 0 ) - 1 ); };
		const p = super.compileAsync( scene, camera, ...rest );
		return Promise.resolve( p ).then( ( v ) => { settle(); return v; }, ( e ) => { settle(); throw e; } );
	}
}
`;

}

function fullWebgpuAutoModule() {

	return `
import * as Original from '/build/three.webgpu.js';
export * from '/build/three.webgpu.js';
import { installPrecompileMarker, setDevRenderer, precompileAuxiliary } from '@tsl-precompile/runtime';

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

function __mark( material, className, sourceObject = null ) {
	if ( ! material ) return;
	if ( sourceObject && ! material.__tslpPrecompileObject ) Object.defineProperty( material, '__tslpPrecompileObject', { value: sourceObject, configurable: true } );
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
	const type = material.type || '';
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
	return material.constructor && material.constructor.name || 'Material';
}

function __markSceneMaterials( scene ) {
	if ( ! scene || typeof scene.traverse !== 'function' ) return;
	if ( scene.isScene !== true ) return;
	if ( ! scene.userData || scene.userData.__tslpUserScene !== true ) return;
	if ( scene.userData && scene.userData.__tslpSyntheticCaptureScene ) return;
	scene.traverse( ( object ) => {
		const material = object && object.material;
		const materials = Array.isArray( material ) ? material : material ? [ material ] : [];
		for ( const m of materials ) {

			if ( m && m.visible === false ) continue;
			__mark( m, __classNameForMaterial( m ), object );

		}
	} );
}

function __rememberAuxScene( scene, camera ) {
	if ( ! scene || scene.isScene !== true ) return;
	if ( ! scene.userData || scene.userData.__tslpUserScene !== true ) return;
	if ( scene.userData && scene.userData.__tslpSyntheticCaptureScene ) return;
	__auxScenes.set( scene, camera || null );
}

function __flush() {
	if ( ! __renderer ) return;
	for ( const item of __pending ) {
		if ( item.done ) continue;
		item.done = true;
		try { item.material.precompile( item.name ); } catch ( err ) { console.error( '[tslp-e2e] precompile failed:', err ); }
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

async function __waitForCaptureIdle( timeoutMs = 45000 ) {
	const now = () => ( typeof window.__tslpRealNow === 'function' ? window.__tslpRealNow() : Date.now() );
	const start = now();
	while ( ( window.__tslpPrecompilePending | 0 ) > 0 || ( window.__tslpAuxCapturePending | 0 ) > 0 || __auxPromises.size > 0 ) {
		if ( now() - start > timeoutMs ) throw new Error( 'timed out waiting for capture artifacts' );
		await new Promise( ( resolve ) => setTimeout( resolve, 50 ) );
	}
}

window.__tslpFlushCaptureArtifacts = async function () {
	__flush();
	if ( __renderer ) {
		const scenes = Array.from( __auxScenes.entries() );
		if ( scenes.length === 0 && __lastScene && __lastCamera ) scenes.push( [ __lastScene, __lastCamera ] );
		for ( const [ scene, camera ] of scenes ) {
			if ( scene && camera ) __trackAuxCapture( precompileAuxiliary( __renderer, scene, camera, __auxOpts() ), 'aux capture' );
		}
	}
	if ( __renderer ) {
		for ( const pipeline of __postProcessingPipelines ) {
			__trackAuxCapture( precompileAuxiliary( __renderer, null, null, __auxOpts( { postProcessing: pipeline } ) ), 'post-process aux capture' );
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

function __capturePostProcessing( pipeline ) {
	if ( pipeline ) __postProcessingPipelines.add( pipeline );
}

const __RenderPipelineBase = Original.RenderPipeline || Original.PostProcessing;
export class RenderPipeline extends __RenderPipelineBase {
	render( ...args ) {
		__capturePostProcessing( this );
		return super.render( ...args );
	}
}

export class PostProcessing extends RenderPipeline {}

export class WebGPURenderer extends Original.WebGPURenderer {
	async init( ...args ) {
		const result = await super.init( ...args );
		__renderer = this;
		setDevRenderer( this );
		// __flush deliberately skipped here — see __mark for why.
		return result;
	}
	compile( scene, camera, ...rest ) {
		if ( __pmremRunning > 0 ) return typeof super.compile === 'function' ? super.compile( scene, camera, ...rest ) : undefined;
		__lastScene = scene;
		__lastCamera = camera;
		__rememberAuxScene( scene, camera );
		__markSceneMaterials( scene );
		return typeof super.compile === 'function' ? super.compile( scene, camera, ...rest ) : undefined;
	}
	compileAsync( scene, camera, ...rest ) {
		if ( __pmremRunning > 0 ) return typeof super.compileAsync === 'function' ? super.compileAsync( scene, camera, ...rest ) : Promise.resolve();
		__lastScene = scene;
		__lastCamera = camera;
		__rememberAuxScene( scene, camera );
		__markSceneMaterials( scene );
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
		__lastScene = scene;
		__lastCamera = camera;
		__rememberAuxScene( scene, camera );
		__markSceneMaterials( scene );
		return super.render( scene, camera );
	}
}
`;

}

function slimWebgpuReplayModule() {

	const materialClasses = NODE_MATERIAL_EXPORTS.map( ( name ) => `
export class ${ name } {
	constructor( params ) {
		let mat;
		try {
			mat = __takeMaterial( ${ JSON.stringify( name ) }, params && typeof params === 'object' ? params : null );
		} catch ( err ) {
			const hasParams = params && typeof params === 'object' && Object.keys( params ).length > 0;
			if ( hasParams ) {
				if ( ${ JSON.stringify( name ) } !== 'NodeMaterial' ) throw err;
				mat = __makeFallbackNodeMaterial( params );
			} else {
				mat = __makeInternalNodeMaterial( ${ JSON.stringify( name ) }, params );
			}
		}
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
import * as Slim from '/__tslp__/three.webgpu.slim.js';
import { TextureNode as FullTextureNode, BlendMode as FullBlendMode, TempNode as FullTempNode, NodeUpdateType as FullNodeUpdateType, NodeMaterial as FullNodeMaterial, MeshBasicNodeMaterial as FullMeshBasicNodeMaterial, MeshPhongNodeMaterial as FullMeshPhongNodeMaterial, SpriteNodeMaterial as FullSpriteNodeMaterial, RenderTarget as FullRenderTarget, QuadMesh as FullQuadMesh, RendererUtils as FullRendererUtils, Vector2 as FullVector2 } from '/build/three.webgpu.js';
export * from '/__tslp__/three.webgpu.slim.js';
export { FullTextureNode as TextureNode, FullBlendMode as BlendMode, FullTempNode as TempNode, FullNodeUpdateType as NodeUpdateType, FullRenderTarget as RenderTarget, FullQuadMesh as QuadMesh, FullRendererUtils as RendererUtils };

const __state = window.__TSLP_E2E || { example: 'unknown', artifacts: { user: {}, aux: [] } };
const __data = __state.artifacts || { user: {}, aux: [] };

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

	function __fragmentOutputCount( material ) {
		const artifact = material && material.precompiledArtifact;
		if ( ! artifact ) return 1;
		if ( Array.isArray( artifact.fragmentOutputs ) ) return artifact.fragmentOutputs.length;
		const fragmentShader = typeof artifact.fragmentShader === 'string' ? artifact.fragmentShader : '';
		const outputStruct = fragmentShader.match( /struct\\s+\\w+\\s*\\{([\\s\\S]*?)\\};\\s*var<private>\\s+output\\s*:/ );
		const matches = ( outputStruct ? outputStruct[ 1 ] : fragmentShader ).match( /@location\\s*\\(\\s*\\d+\\s*\\)/g );
		return matches && matches.length > 0 ? matches.length : 1;
	}

	function __syncPassRenderTargetTextures( passNode, mrt ) {
		const target = passNode && passNode.renderTarget;
		if ( ! target || ! Array.isArray( target.textures ) ) return;
		if ( ! mrt || ! mrt.outputNodes || typeof mrt.outputNodes !== 'object' ) {
			target.textures = [ target.texture ];
			return;
		}
		const textures = [];
		for ( const name of Object.keys( mrt.outputNodes ) ) {
			const texture = passNode.getTexture( name );
			if ( texture && ! textures.includes( texture ) ) textures.push( texture );
		}
		if ( textures.length === 0 && target.texture ) textures.push( target.texture );
		target.textures = textures;
	}

	function __sceneCanRenderMRT( scene, mrt ) {
		const targetCount = __mrtOutputCount( mrt );
		if ( targetCount <= 1 || ! scene || typeof scene.traverse !== 'function' ) return true;
		if ( scene.background || scene.backgroundNode ) return false;
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
			this._previousTextures = Object.create( null );
			this._previousTextureNodes = Object.create( null );
			this._cameraNear = { value: 0 };
			this._cameraFar = { value: 1 };
			this.overrideMaterial = null;
			this.transparent = true;
			this.opaque = true;
			this.contextNode = null;
			this.isNode = true;
			this.isPassNode = true;
			const depthTexture = new Slim.DepthTexture();
			depthTexture.isRenderTargetTexture = true;
			depthTexture.name = 'depth';
			const renderTarget = new Slim.RenderTarget( 1, 1, { type: Slim.HalfFloatType, ...this.options } );
			renderTarget.texture.name = 'output';
			renderTarget.depthTexture = depthTexture;
			this.renderTarget = renderTarget;
			this._textures.output = renderTarget.texture;
			this._textures.depth = depthTexture;
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
		setMRT( mrt ) { this._mrt = mrt; return this; }
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
		getViewZNode( name = 'depth' ) { return this.getTextureNode( name ); }
		getLinearDepthNode( name = 'depth' ) { return this.getTextureNode( name ); }
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
			if ( this.renderTarget && typeof this.renderTarget.setSize === 'function' ) this.renderTarget.setSize( effectiveWidth, effectiveHeight );
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
			renderer.setRenderTarget( this.renderTarget );
			const replayMRT = __sceneCanRenderMRT( scene, this._mrt ) ? this._mrt : null;
			__syncPassRenderTargetTextures( this, replayMRT );
			if ( typeof renderer.setMRT === 'function' ) renderer.setMRT( replayMRT );
			renderer.autoClear = true;
			renderer.transparent = this.transparent;
			renderer.opaque = this.opaque;
			renderer.render( scene, camera );
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
const __liveTexturesByUuid = new Map();
const __liveTexturesByName = new Map();
const __liveMaterialTextures = [];
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
	if ( ! texture || texture.isTexture !== true ) return;
	Slim.registerLiveTexture( texture );
	if ( texture.uuid ) __liveTexturesByUuid.set( texture.uuid, texture );
	const names = [];
	if ( texture.name ) names.push( texture.name );
	const imageSrc = __textureImageSrc( texture );
	if ( imageSrc ) names.push( imageSrc );
	for ( const name of names ) {
		if ( typeof name !== 'string' || name.length === 0 ) continue;
		__liveTexturesByName.set( name, texture );
		const base = __basenameFromUrl( name );
		if ( base ) __liveTexturesByName.set( base, texture );
	}
	const identity = texture.name || imageSrc || '';
	if ( ! /\.(hdr|exr)$/i.test( __basenameFromUrl( identity ) ) && ! __isEnvironmentTextureSource( texture ) && ! __liveMaterialTextures.includes( texture ) ) {
		__liveMaterialTextures.push( texture );
	}
}

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

function __preparePMREMArgsForFullRenderer( method, args ) {
	if ( method !== 'fromScene' || ! args || ! args[ 0 ] ) return args;
	const scene = args[ 0 ];
	if ( scene.name !== 'RoomEnvironment' && scene.constructor && scene.constructor.name !== 'RoomEnvironment' ) return args;
	const fullScene = __makeFullRoomEnvironment( __fullThreeMod );
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
( function patchPMREMGenerator() {
	const PG = Slim.PMREMGenerator;
	if ( ! PG || ! PG.prototype || PG.prototype.__tslpPatched ) return;
	PG.prototype.__tslpPatched = true;
	for ( const method of [ 'fromScene', 'fromCubemap', 'fromEquirectangular', 'fromTexture' ] ) {
		const orig = PG.prototype[ method ];
		if ( typeof orig !== 'function' ) continue;
		PG.prototype[ method ] = function ( ...args ) {
			__pmremRunning ++;
			const slimRenderer = this._renderer;
			const fullRenderer = __computeRenderer;
			const FullPMREMGenerator = __fullThreeMod && __fullThreeMod.PMREMGenerator;
			const useFull = fullRenderer && fullRenderer !== slimRenderer && slimRenderer && slimRenderer.backend && typeof FullPMREMGenerator === 'function';
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

// Copy the PMREM GPU-texture entry from the full renderer's backend WeakMap
// into the slim renderer's backend WeakMap so the slim renderer can bind the
// already-created GPUTexture without trying to upload from (empty) CPU data.
// Both renderers must share the same WebGPU device for this to be safe.
// Extracted from __generatePMREMAsync so the synchronous PMREMGenerator
// patch above can reuse it.
function __sharePMREMGPUTexture( slimRenderer, fullRenderer, pmrem ) {
	if ( ! slimRenderer || ! fullRenderer || ! pmrem ) return;
	if ( ! slimRenderer.backend || ! fullRenderer.backend ) return;
	try {
		const fullData = fullRenderer.backend.get( pmrem );
		if ( ! fullData || ! fullData.texture ) return;
		const slimData = slimRenderer.backend.get( pmrem );
		for ( const key of Object.keys( fullData ) ) slimData[ key ] = fullData[ key ];
		// The Textures manager (renderer._textures) has its OWN DataMap separate
		// from the backend. updateTexture() checks textures.get(pmrem).initialized
		// before calling backend.createTexture(). If textures.initialized is unset,
		// it calls backend.createTexture() which throws "already initialized".
		// Populate the Textures DataMap so updateTexture returns early without
		// touching the backend.
		const tx = slimRenderer._textures;
		if ( tx && typeof tx.get === 'function' ) {
			__markSlimTextureInitialized( slimRenderer, pmrem );
		}
	} catch ( shareErr ) {
		console.warn( '[tslp-e2e] PMREM GPU share failed:', shareErr && shareErr.message || shareErr );
	}
}

function __shareGPUTextureEntry( targetRenderer, sourceRenderer, texture ) {
	if ( ! targetRenderer || ! sourceRenderer || ! texture ) return;
	if ( ! targetRenderer.backend || ! sourceRenderer.backend ) return;
	try {
		const diag = typeof __harnessDiagnostics === 'function' ? __harnessDiagnostics() : null;
		const shareDiag = diag ? ( diag.textureShare || ( diag.textureShare = { calls: 0, noSourceData: 0, noSourceTexture: 0, success: 0, names: [], missingNames: [] } ) ) : null;
		if ( shareDiag ) shareDiag.calls ++;
		const sourceData = sourceRenderer.backend.get( texture );
		if ( ! sourceData ) {
			if ( shareDiag ) shareDiag.noSourceData ++;
			return;
		}
		if ( ! sourceData.texture ) {
			if ( shareDiag ) {
				shareDiag.noSourceTexture ++;
				if ( shareDiag.missingNames.length < 20 ) shareDiag.missingNames.push( texture.name || 'unnamed' );
			}
			return;
		}
		const targetData = targetRenderer.backend.get( texture );
		for ( const key of Object.keys( sourceData ) ) targetData[ key ] = sourceData[ key ];
		__markSlimTextureInitialized( targetRenderer, texture );
		if ( shareDiag ) {
			shareDiag.success ++;
			if ( shareDiag.names.length < 20 ) shareDiag.names.push( texture.name || 'unnamed' );
		}
	} catch ( shareErr ) {
		console.warn( '[tslp-e2e] GPU texture share failed:', shareErr && shareErr.message || shareErr );
	}
}

function __markSlimTextureInitialized( slimRenderer, texture ) {
	if ( ! slimRenderer || ! texture ) return;
	const tx = slimRenderer._textures;
	if ( ! tx || typeof tx.get !== 'function' ) return;
	const txData = tx.get( texture );
	txData.initialized = true;
	txData.version = texture.version;
	txData.generation = texture.version;
	if ( ! txData.bindGroups ) txData.bindGroups = new Set();
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
( function patchLoaders() {
	const loaders = [ 'TextureLoader', 'CubeTextureLoader', 'DataTextureLoader', 'ImageBitmapLoader' ];
	for ( const name of loaders ) {
		const Ctor = Slim[ name ];
		if ( ! Ctor || ! Ctor.prototype || ! Ctor.prototype.load || Ctor.prototype.__tslpPatched ) continue;
		Ctor.prototype.__tslpPatched = true;
		const origLoad = Ctor.prototype.load;
		Ctor.prototype.load = function ( url, onLoad, onProgress, onError ) {
			const wrappedOnLoad = ( texOrImage, ...rest ) => {
				try {
					if ( typeof onLoad === 'function' ) onLoad( texOrImage, ...rest );
				} finally {
					if ( tex && tex.isTexture === true ) __rememberLiveTexture( tex );
				}
			};
			const tex = origLoad.call( this, url, wrappedOnLoad, onProgress, onError );
			if ( tex && tex.isTexture === true ) {
				if ( ! tex.name && typeof url === 'string' ) tex.name = url.split( '/' ).pop().split( '?' )[ 0 ];
				__rememberLiveTexture( tex );
			}
			return tex;
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
	for ( const key of [ 'colorNode', 'normalNode', 'positionNode', 'outputNode', 'roughnessNode', 'metalnessNode', 'emissiveNode', 'opacityNode', 'alphaTestNode' ] ) {
		if ( material[ key ] === undefined ) material[ key ] = stub;
	}
}

function __walkNodeSafely( rootNode, visitor, seen = new Set(), depth = 0 ) {
	if ( ! rootNode || ( typeof rootNode !== 'object' && typeof rootNode !== 'function' ) || depth > 64 || seen.has( rootNode ) ) return;
	seen.add( rootNode );
	visitor( rootNode );
	const children = [];
	try {
		if ( typeof rootNode.getChildren === 'function' ) {
			const list = rootNode.getChildren();
			if ( Array.isArray( list ) ) children.push( ...list );
		}
	} catch ( _ ) {}
	if ( Array.isArray( rootNode._children ) ) children.push( ...rootNode._children );
	for ( const child of children ) {
		if ( ! child || ( typeof child !== 'object' && typeof child !== 'function' ) ) continue;
		if ( child.isNode === true || typeof child.getChildren === 'function' || Array.isArray( child._children ) ) {
			__walkNodeSafely( child, visitor, seen, depth + 1 );
		}
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
	// Top-level node may itself be a BufferAttributeNode (rare but possible:
	// material.positionNode = positionBuffer.toAttribute()).
	if ( rootNode.isBufferNode === true && ! rootNode.isStorageBufferNode && isStorageVal( rootNode.value ) ) {
		results.push( rootNode.value );
	}
	__walkNodeSafely( rootNode, ( n ) => {
		if ( n && n.isBufferNode === true && ! n.isStorageBufferNode && isStorageVal( n.value ) ) {
			if ( ! results.includes( n.value ) ) results.push( n.value );
		}
	} );
}

// Before creating a PrecompiledMaterial, inject live StorageBufferAttribute /
// StorageInstancedBufferAttribute objects from the source material's node graph
// into the artifact's plan entries so hydrateNodeBuilderState uses the live
// GPU-writable buffers instead of allocating fresh empty placeholders.
// This is required for compute-driven examples where instancedArray() creates
// a buffer that a compute kernel writes into and the render material reads from.
function __wireComputeAttrsToArtifact( artifact, sourceMaterial ) {
	if ( ! sourceMaterial || ! artifact ) return;
	function isStorageAttr( v ) { return v && ( v.isStorageBufferAttribute === true || v.isStorageInstancedBufferAttribute === true ); }

	// vec3 StorageBufferAttributes are padded to itemSize=4 by WebGPU on first use.
	// Accept both 3 and 4 when the artifact recorded 4 (pad already applied at capture).
	function sizeMatches( liveSize, artifactSize ) {
		return liveSize === artifactSize || ( liveSize === 3 && artifactSize === 4 );
	}

	// Wire nodeAttributes (vertex path). Two shapes are common:
	//   - material.positionNode = positionBuffer.toAttribute() — the top-level
	//     node is a BufferAttributeNode wrapping the storage attribute.
	//   - material.vertexNode = billboarding({ position: positionBuffer.toAttribute() })
	//     — the BufferAttributeNode is buried inside a deeper node tree (used by
	//     the compute particle examples: rain, snow, points).
	// Walk both positionNode and vertexNode to collect every storage-attribute
	// candidate, then match each artifact node-attribute by count + itemSize.
	const nodeAttrsArr = artifact.attributes || artifact.nodeAttributes || [];
	const naCandidates = [];
	__collectStorageAttrNodeAttrs( sourceMaterial.positionNode, naCandidates );
	__collectStorageAttrNodeAttrs( sourceMaterial.vertexNode, naCandidates );
	if ( naCandidates.length > 0 ) {
		for ( const nodeAttr of nodeAttrsArr ) {
			// _liveAttribute may already be set from JSON deserialization (plain object, not
			// a live attribute). Only skip if it is already a proper live JS attribute object.
			if ( ! nodeAttr || nodeAttr.source !== 'node' || isStorageAttr( nodeAttr._liveAttribute ) ) continue;
			const matchIdx = naCandidates.findIndex( ( v ) => v.count === nodeAttr.count && sizeMatches( v.itemSize, nodeAttr.itemSize ) );
			if ( matchIdx === -1 ) continue;
			Object.defineProperty( nodeAttr, '_liveAttribute', { value: naCandidates[ matchIdx ], enumerable: false, writable: true, configurable: true } );
			naCandidates.splice( matchIdx, 1 );
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
	const nodeKeys = [ 'colorNode', 'normalNode', 'outputNode', 'roughnessNode', 'metalnessNode', 'emissiveNode', 'opacityNode', 'alphaTestNode', 'vertexNode', 'positionNode' ];
	const sbCandidates = [];
	for ( const key of nodeKeys ) {
		if ( sourceMaterial[ key ] ) __collectStorageBufAttrs( sourceMaterial[ key ], sbCandidates );
	}
	// SUPERSEDED by runtime hydrator's bindUserStorageBuffersToArtifact —
	// disabled to validate the runtime path. Re-enable by setting
	// __TSLP_HARNESS_WIRE_STORAGE = true on window if you need the old behaviour.
	const __useHarnessStorageWire = ( typeof window !== 'undefined' && window.__TSLP_HARNESS_WIRE_STORAGE === true );
	if ( __useHarnessStorageWire && sbCandidates.length > 0 ) {
		for ( const group of plan ) {
			// Try explicit storageBuffers list first
			for ( const sb of ( group.storageBuffers || [] ) ) {
				if ( isStorageAttr( sb._liveAttribute ) ) continue;
				const match = sbCandidates.find( ( c ) => c.count === sb.count && sizeMatches( c.itemSize, sb.itemSize ) );
				if ( match ) {
					Object.defineProperty( sb, '_liveAttribute', { value: match, enumerable: false, writable: true, configurable: true } );
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
					sbCandidates.splice( sbCandidates.indexOf( match ), 1 );
				}
			}
		}
	}
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

function __colorDistanceSq( a, b ) {
	if ( ! a || ! b ) return Infinity;
	const dr = ( a[ 0 ] || 0 ) - ( b[ 0 ] || 0 );
	const dg = ( a[ 1 ] || 0 ) - ( b[ 1 ] || 0 );
	const db = ( a[ 2 ] || 0 ) - ( b[ 2 ] || 0 );
	return dr * dr + dg * dg + db * db;
}

function __artifactHasTextureSource( artifact, predicate = null ) {
	for ( const group of artifact && artifact.uniformPlan || [] ) {
		for ( const entry of group.textures || [] ) {
			const source = entry && entry.source || {};
			if ( ! source.kind ) continue;
			if ( ! predicate || predicate( source, entry, group ) ) return true;
		}
	}
	return false;
}

let __reflectorBaseCursor = 0;
function __attachReflectorBaseNodesForArtifact( material, artifact ) {
	if ( ! material || ! artifact ) return;
	if ( ! __artifactHasTextureSource( artifact, ( source ) => source.kind === 'reflector.texture' ) ) return;
	const pool = globalThis.__tslpReflectorBaseNodes || [];
	if ( pool.length === 0 ) return;
	let maxIndex = -1;
	for ( const group of artifact.uniformPlan || [] ) {
		for ( const entry of group.textures || [] ) {
			const source = entry && entry.source || {};
			if ( source.kind === 'reflector.texture' && Number.isInteger( source.reflectorIndex ) ) {
				maxIndex = Math.max( maxIndex, source.reflectorIndex );
			}
		}
	}
	const needed = Math.max( 1, maxIndex + 1 );
	const nodes = [];
	while ( nodes.length < needed && __reflectorBaseCursor < pool.length ) {
		const node = pool[ __reflectorBaseCursor ++ ];
		if ( node && node.constructor && node.constructor.type === 'ReflectorBaseNode' && node.renderTargets instanceof Map ) nodes.push( node );
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
	return !! ( texture && texture.isTexture === true && texture.isCubeTexture !== true && ! Array.isArray( texture.image ) && ( texture.mapping === 306 || texture.name === 'PMREM.cubeUv' ) );
}

function __textureImageSrc( texture ) {
	const image = texture && texture.image;
	if ( ! image ) return null;
	if ( Array.isArray( image ) && image.length > 0 ) {
		const first = image[ 0 ];
		const src = first && ( first.src || first.currentSrc || null );
		return typeof src === 'string' && src.length > 0 ? src : null;
	}
	const src = image.src || image.currentSrc || null;
	return typeof src === 'string' && src.length > 0 ? src : null;
}

function __basenameFromUrl( value ) {
	if ( typeof value !== 'string' || value.length === 0 ) return '';
	const slash = value.lastIndexOf( '/' );
	const tail = slash >= 0 ? value.slice( slash + 1 ) : value;
	return tail.split( '?' )[ 0 ].split( '#' )[ 0 ];
}

function __textureMatchesArtifactSource( texture, source ) {
	if ( ! texture || texture.isTexture !== true || ! source || source.kind !== 'artifact.texture' ) return false;
	if ( source.textureUuid && texture.uuid === source.textureUuid ) return true;
	const textureName = typeof texture.name === 'string' ? texture.name : '';
	if ( source.textureName && textureName === source.textureName ) return true;
	const textureSrc = __textureImageSrc( texture );
	if ( source.imageSrc && textureSrc && source.imageSrc === textureSrc ) return true;
	const sourceBase = __basenameFromUrl( source.textureName || source.imageSrc );
	const textureBase = __basenameFromUrl( textureName || textureSrc );
	return !! ( sourceBase && textureBase && sourceBase === textureBase );
}

function __countArtifactTextureSources( artifact, predicate = null ) {
	const uuids = new Set();
	for ( const group of artifact && artifact.uniformPlan || [] ) {
		for ( const entry of group.textures || [] ) {
			const source = entry && entry.source || {};
			if ( source.kind !== 'artifact.texture' || ! source.textureUuid ) continue;
			if ( predicate && ! predicate( source, entry, group ) ) continue;
			uuids.add( source.textureUuid );
		}
	}
	return uuids.size;
}

function __singleArtifactTextureUuid( artifact, predicate = null ) {
	let uuid = null;
	for ( const group of artifact && artifact.uniformPlan || [] ) {
		for ( const entry of group.textures || [] ) {
			const source = entry && entry.source || {};
			if ( source.kind !== 'artifact.texture' || ! source.textureUuid ) continue;
			if ( predicate && ! predicate( source, entry, group ) ) continue;
			if ( uuid && uuid !== source.textureUuid ) return null;
			uuid = source.textureUuid;
		}
	}
	return uuid;
}

function __artifactNodeAttributes( artifact ) {
	const attrs = Array.isArray( artifact && artifact.attributes )
		? artifact.attributes
		: Array.isArray( artifact && artifact.nodeAttributes ) ? artifact.nodeAttributes : [];
	return attrs.filter( ( entry ) => entry && entry.source === 'node' );
}

function __nodeGraphKeys() {
	return [ 'colorNode', 'fragmentNode', 'normalNode', 'positionNode', 'outputNode', 'roughnessNode', 'metalnessNode', 'emissiveNode', 'opacityNode', 'alphaTestNode', 'vertexNode', 'envNode', 'lightNode', 'aoNode', 'transmissionNode', 'thicknessNode' ];
}

function __sourceHasNodeGraph( sourceMaterial ) {
	if ( ! sourceMaterial ) return false;
	for ( const key of __nodeGraphKeys() ) if ( sourceMaterial[ key ] && sourceMaterial[ key ].isNode === true ) return true;
	return false;
}

function __collectMaterialNodeTextures( sourceMaterial ) {
	const out = [];
	if ( ! sourceMaterial ) return out;
	const seen = new Set();
	for ( const key of __nodeGraphKeys() ) {
		const node = sourceMaterial[ key ];
		if ( ! node ) continue;
		for ( const texture of __collectTexturesInNode( node ) ) {
			if ( texture && texture.isTexture === true && ! seen.has( texture ) ) {
				seen.add( texture );
				out.push( texture );
			}
		}
	}
	return out;
}

function __walkMaterialNodeGraph( sourceMaterial, visitor ) {
	if ( ! sourceMaterial || typeof visitor !== 'function' ) return;
	const seen = new Set();
	const walk = ( node, depth = 0 ) => {
		if ( ! node || node.isNode !== true || depth > 24 || seen.has( node ) ) return;
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
			let value = null;
			try { value = node[ key ]; } catch ( _ ) { continue; }
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
	const dtype = slot.dtype || ( slot.source && slot.source.valueSnapshot && slot.source.valueSnapshot.type ) || '';
	if ( dtype === 'color' ) return !! ( value && value.isColor );
	if ( dtype === 'number' || dtype === 'float' ) return typeof value === 'number' || value && value.isUniformNode !== true && typeof value.value === 'number';
	if ( dtype === 'vec2' ) return !! ( value && value.isVector2 );
	if ( dtype === 'vec3' ) return !! ( value && ( value.isVector3 || value.isColor ) );
	if ( dtype === 'vec4' ) return !! ( value && value.isVector4 );
	if ( dtype === 'mat3' ) return !! ( value && value.isMatrix3 );
	if ( dtype === 'mat4' ) return !! ( value && value.isMatrix4 );
	return true;
}

function __wireLiveNodeSidecarsToArtifact( artifact, sourceMaterial ) {
	if ( ! artifact || ! sourceMaterial ) return;
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
	__appendArtifactSidecars( artifact, '_liveUpdateNodes', updateNodes );
	__appendArtifactSidecars( artifact, '_liveUpdateBeforeNodes', updateBeforeNodes );
	__appendArtifactSidecars( artifact, '_liveUpdateAfterNodes', updateAfterNodes );
	if ( uniformNodes.length === 0 ) return;
	const used = new Set();
	for ( const group of artifact.uniformPlan || [] ) {
		for ( const slot of group.slots || [] ) {
			const source = slot && slot.source || {};
			if ( source.kind !== 'uniform.live' || slot._liveNode ) continue;
			let match = null;
			if ( source.name ) match = uniformNodes.find( ( node ) => ! used.has( node ) && node.name === source.name && __valueMatchesUniformSlot( node.value, slot ) );
			if ( ! match ) match = uniformNodes.find( ( node ) => ! used.has( node ) && __valueMatchesUniformSlot( node.value, slot ) );
			if ( ! match ) continue;
			Object.defineProperty( slot, '_liveNode', {
				value: match,
				enumerable: false,
				configurable: true,
				writable: true,
			} );
			used.add( match );
		}
	}
}

function __scoreArtifactForSource( key, mod, className, sourceMaterial, sourceObject = null ) {
	const artifact = mod && mod.artifact;
	if ( ! artifact ) return -Infinity;
	let score = key.includes( ':' + className + ':' ) ? 30 : 0;
	const typeNeedle = __sourceTypeNeedle( sourceMaterial );
	if ( typeNeedle && key.includes( ':' + typeNeedle + ':' ) ) score += 15;

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
		if ( __artifactHasTextureSource( artifact ) ) score += 20;
	}

	const nodeAttrs = __artifactNodeAttributes( artifact );
	if ( sourceObject && sourceObject.isInstancedMesh === true ) {
		const count = sourceObject.count || 0;
		const matchingAttrs = count ? nodeAttrs.filter( ( entry ) => entry.count === count ) : [];
		const matrixAttrs = matchingAttrs.filter( ( entry ) => ( entry.itemSize || 0 ) === 4 || entry.type === 'vec4' );
		const colorAttrs = matchingAttrs.filter( ( entry ) => ( entry.itemSize || 0 ) === 3 || entry.type === 'vec3' );
		if ( matchingAttrs.length > 0 ) score += 80;
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
	let best = null;
	let bestScore = -Infinity;
	for ( const key of keys ) {
		const mod = __data.user && __data.user[ key ];
		const score = __scoreArtifactForSource( key, mod, className, sourceMaterial, sourceObject );
		if ( score > bestScore ) {
			best = key;
			bestScore = score;
		}
	}
	return best && bestScore >= 55 ? best : null;
}

function __takeMaterial( className, sourceMaterial = null, sourceObject = null ) {
	const n = ( __counts[ className ] || 0 ) + 1;
	__counts[ className ] = n;
	let name = __state.example + ':' + className + ':' + n;
	let mod = __data.user && __data.user[ name ];
	if ( mod && __usedArtifactNames.has( name ) ) mod = null;
	if ( sourceMaterial ) {
		const allKeys = Object.keys( __data.user || {} );
		const unusedKeys = allKeys.filter( ( key ) => ! __usedArtifactNames.has( key ) );
		const matchedName = __findBestArtifactForSource( className, sourceMaterial, unusedKeys, sourceObject );
		if ( matchedName ) {
			name = matchedName;
			mod = __data.user[ name ];
		}
	}
	if ( ! mod || ! mod.artifact ) {
		const allKeys = Object.keys( __data.user || {} );
		const unusedKeys = allKeys.filter( ( key ) => ! __usedArtifactNames.has( key ) );
		const typeNeedle = __sourceTypeNeedle( sourceMaterial );
		const findType = ( keys ) => keys.find( ( key ) => typeNeedle && key.includes( ':' + typeNeedle + ':' ) );
		const findCompatible = ( keys ) => keys.find( ( key ) => /:(MeshBasic|MeshLambert|MeshStandard)NodeMaterial:/.test( key ) );
		const findClass = ( keys ) => keys.find( ( key ) => key.includes( ':' + className + ':' ) );
		const findLineBasic = ( keys ) => keys.find( ( key ) => /:LineBasicNodeMaterial:/.test( key ) );
		const isMeshNodeMaterial = /^Mesh[A-Za-z0-9]*NodeMaterial$/.test( className );
		const isSpriteOrPointsNodeMaterial = /^(Sprite|Points)NodeMaterial$/.test( className );
		const fallbackName = findType( unusedKeys ) || findType( allKeys ) ||
			( className === 'Line2NodeMaterial' ? findCompatible( unusedKeys ) || findCompatible( allKeys ) : null ) ||
			( className === 'LineDashedNodeMaterial' ? findLineBasic( unusedKeys ) || findLineBasic( allKeys ) : null ) ||
			findClass( unusedKeys ) || findClass( allKeys ) ||
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
	// Wire live storage buffer attributes from the source material's node graph into
	// the artifact plan before hydration so compute results are visible in renders.
	__wireComputeAttrsToArtifact( mod.artifact, sourceMaterial );
	__ensureArtifactTextureFallbacks( mod.artifact );
	const material = new Slim.PrecompiledMaterial( mod.artifact );
	material.name = name;
	__attachReflectorBaseNodesForArtifact( material, mod.artifact );
	__seedNodeProps( material );
	return material;
}

function __classNameForMaterial( material ) {
	if ( ! material ) return 'Material';
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
	const type = material.type || '';
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
	return material.constructor && material.constructor.name || 'Material';
}

// Material-property keys that carry texture refs three.js's renderer
// reads off the material directly. The hydrator's 'material.<prop>'
// resolver pulls live values from these on each frame.
//
// Audited against three.js r184 MeshStandardMaterial / MeshPhysicalMaterial /
// MeshPhongMaterial / MeshBasicMaterial / MeshLambertMaterial / MeshMatcap-
// Material / MeshToonMaterial. Keep in sync with the TEXTURE_PROPS scan in
// runtime/src/hydrator.js.
// TODO(post-merge): hydrator.js TEXTURE_PROPS scan (lines ~806-814) is missing
// anisotropyMap -- add when Agent A's changes land so material->artifact UUID
// fallback resolves anisotropy textures too.
const __TEXTURE_PROPS = [ 'map', 'alphaMap', 'aoMap', 'bumpMap', 'displacementMap', 'emissiveMap', 'envMap', 'lightMap', 'normalMap', 'specularMap', 'roughnessMap', 'metalnessMap', 'gradientMap', 'matcap', 'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap', 'iridescenceMap', 'iridescenceThicknessMap', 'sheenColorMap', 'sheenRoughnessMap', 'specularColorMap', 'specularIntensityMap', 'transmissionMap', 'thicknessMap', 'anisotropyMap' ];
// Scalar/Color/Vector2/array PBR material properties -- copied source->swap
// on every replay so live GUI tweaks (lightMapIntensity, displacementScale,
// etc.) survive into the precompiled material's per-frame uniform updaters.
const __SCALAR_PROPS = [ 'color', 'opacity', 'transparent', 'side', 'visible', 'toneMapped', 'emissive', 'emissiveIntensity', 'roughness', 'metalness', 'normalScale', 'normalMapType', 'bumpScale', 'displacementScale', 'displacementBias', 'lightMapIntensity', 'aoMapIntensity', 'envMapIntensity', 'envMapRotation', 'reflectivity', 'refractionRatio', 'shininess', 'specular', 'specularColor', 'specularIntensity', 'ior', 'clearcoat', 'clearcoatRoughness', 'clearcoatNormalScale', 'iridescence', 'iridescenceIOR', 'iridescenceThicknessRange', 'sheen', 'sheenColor', 'sheenRoughness', 'transmission', 'thickness', 'attenuationColor', 'attenuationDistance', 'anisotropy', 'anisotropyRotation', 'dispersion', 'alphaTest', 'alphaToCoverage', 'depthTest', 'depthWrite', 'blending', 'blendSrc', 'blendDst', 'blendEquation', 'premultipliedAlpha', 'dithering', 'vertexColors', 'wireframe', 'wireframeLinewidth', 'flatShading' ];
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
	if ( className === 'MeshBasicNodeMaterial' && FullMeshBasicNodeMaterial ) Ctor = FullMeshBasicNodeMaterial;
	else if ( className === 'MeshPhongNodeMaterial' && FullMeshPhongNodeMaterial ) Ctor = FullMeshPhongNodeMaterial;
	else if ( className === 'SpriteNodeMaterial' && FullSpriteNodeMaterial ) Ctor = FullSpriteNodeMaterial;
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
	for ( const key of [ 'colorNode', 'fragmentNode', 'normalNode', 'positionNode', 'outputNode', 'roughnessNode', 'metalnessNode', 'emissiveNode', 'opacityNode', 'alphaTestNode', 'vertexNode', 'maskNode', 'maskShadowNode', 'receivedShadowPositionNode', 'castShadowPositionNode', 'castShadowNode' ] ) {
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
			const matched = __attachArtifactTextureRefsWhere( artifact, tex, ( source ) => ! __isPMREMArtifactTextureSource( source ) && __textureMatchesArtifactSource( tex, source ) );
			if ( ! matched && __countArtifactTextureSources( artifact, ( source ) => ! __isPMREMArtifactTextureSource( source ) ) <= 1 ) {
				__attachArtifactTextureRefsWhere( artifact, tex, ( source ) => ! __isPMREMArtifactTextureSource( source ) );
			}
		}
	}
	__wireMaterialNodeTextures( sourceMaterial, replacement );
}

function __makeFallbackArtifactTexture( source ) {
	const key = source && ( source.textureUuid || source.imageSrc || source.textureName ) || 'texture';
	if ( __fallbackArtifactTextures.has( key ) ) return __fallbackArtifactTextures.get( key );
	const data = new Uint8Array( [ 255, 255, 255, 255 ] );
	const texture = new Slim.DataTexture( data, 1, 1 );
	texture.name = source && ( source.textureName || __basenameFromUrl( source.imageSrc ) ) || 'tslp-fallback-texture';
	if ( source && source.colorSpace !== undefined ) texture.colorSpace = source.colorSpace;
	texture.needsUpdate = true;
	__fallbackArtifactTextures.set( key, texture );
	return texture;
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
	__wireLiveNodeSidecarsToArtifact( artifact, sourceMaterial );
	const nodeTextures = __collectMaterialNodeTextures( sourceMaterial );
	const anonymousNodeTextures = nodeTextures.filter( ( tex ) => tex && tex.isTexture === true && ! __isPMREMTexture( tex ) && ! tex.name && ! __textureImageSrc( tex ) );
	for ( const tex of nodeTextures ) {
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
		if ( ! matched && ! __isPMREMTexture( tex ) && __countArtifactTextureSources( artifact, ( source ) => ! __isPMREMArtifactTextureSource( source ) ) <= 1 ) {
			__attachArtifactTextureRefsWhere( artifact, tex, ( source ) => ! __isPMREMArtifactTextureSource( source ) );
		}
	}
	if ( anonymousNodeTextures.length === 1 ) {
		const anonymousSnapshotUuid = __singleArtifactTextureUuid( artifact, ( source ) => ! __isPMREMArtifactTextureSource( source ) && !! source.snapshot && ! source.textureName && ! source.imageSrc );
		if ( anonymousSnapshotUuid ) {
			__attachArtifactTextureRefsWhere( artifact, anonymousNodeTextures[ 0 ], ( source ) => source.textureUuid === anonymousSnapshotUuid );
		}
	}
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
	return !! ( source && source.kind === 'artifact.texture' && ( source.mapping === 306 || source.textureName === 'PMREM.cubeUv' ) );
}

function __attachArtifactTextureRefsWhere( artifact, texture, predicate ) {
	return __attachTextureRefsWhere( artifact, texture, ( source, entry, group ) => source.kind === 'artifact.texture' && predicate( source, entry, group ) );
}

function __attachTextureRefsWhere( artifact, texture, predicate ) {
	if ( ! artifact || ! texture || texture.isTexture !== true || typeof predicate !== 'function' ) return artifact;
	const refs = artifact._textureRefs instanceof Map ? new Map( artifact._textureRefs ) : new Map();
	let changed = false;
	for ( const group of artifact.uniformPlan || [] ) {
		for ( const entry of group.textures || [] ) {
			const source = entry && entry.source || {};
			if ( ! source.textureUuid ) continue;
			if ( ! predicate( source, entry, group ) ) continue;
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
	return changed;
}

function __rememberGraphTexture( byName, texture ) {
	if ( ! texture || texture.isTexture !== true ) return;
	const name = texture.name || 'output';
	const list = byName.get( name ) || [];
	if ( ! list.includes( texture ) ) list.push( texture );
	byName.set( name, list );
}

function __rememberRenderTargetTextures( byName, target ) {
	if ( ! target ) return;
	__rememberGraphTexture( byName, target.texture );
	__rememberGraphTexture( byName, target.depthTexture );
	for ( const texture of target.textures || [] ) __rememberGraphTexture( byName, texture );
}

function __collectGraphTexturesByName( node, byName = new Map(), seen = new Set(), depth = 0 ) {
	if ( ! node || depth > 16 || seen.has( node ) ) return byName;
	if ( node.isTexture === true ) {
		__rememberGraphTexture( byName, node );
		return byName;
	}
	seen.add( node );
	if ( node.isPassNode === true ) __rememberRenderTargetTextures( byName, node.renderTarget );
	if ( node.isRTTNode === true ) __rememberRenderTargetTextures( byName, node.renderTarget );
	try {
		if ( node.passNode && node.passNode.isPassNode === true ) __rememberRenderTargetTextures( byName, node.passNode.renderTarget );
	} catch ( _ ) {}
	__rememberRenderTargetTextures( byName, node._horizontalRT );
	__rememberRenderTargetTextures( byName, node._verticalRT );
	for ( const key of [ 'value', '_value', 'texture', '_texture' ] ) {
		try { __rememberGraphTexture( byName, node[ key ] ); } catch ( _ ) {}
	}
	const skip = new Set( [ 'parent', 'children', '_cache', 'scene', 'camera', 'renderer', 'renderTarget', '_horizontalRT', '_verticalRT', 'geometry', 'material', 'domElement' ] );
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) {}
	for ( const key of keys ) {
		if ( skip.has( key ) ) continue;
		let child = null;
		try { child = node[ key ]; } catch ( _ ) { continue; }
		if ( ! child ) continue;
		if ( Array.isArray( child ) ) {
			for ( const item of child ) if ( item && ( typeof item === 'object' || typeof item === 'function' ) ) __collectGraphTexturesByName( item, byName, seen, depth + 1 );
		} else if ( typeof child === 'object' || typeof child === 'function' ) {
			__collectGraphTexturesByName( child, byName, seen, depth + 1 );
		}
	}
	return byName;
}

function __attachGraphTextureRefs( artifact, graphNode ) {
	if ( ! artifact || ! graphNode ) return artifact;
	const byName = __collectGraphTexturesByName( graphNode );
	const refs = artifact._textureRefs instanceof Map ? new Map( artifact._textureRefs ) : new Map();
	const byUuid = new Map();
	const offsets = new Map();
	let changed = false;
	for ( const group of artifact.uniformPlan || [] ) {
		for ( const entry of group.textures || [] ) {
			const source = entry && entry.source || {};
			if ( source.kind !== 'artifact.texture' || ! source.textureUuid ) continue;
			let texture = byUuid.get( source.textureUuid );
			if ( ! texture ) {
				const name = source.textureName || 'output';
				const list = byName.get( name ) || [];
				if ( list.length === 0 ) continue;
				const offset = offsets.get( name ) || 0;
				texture = list[ Math.min( offset, list.length - 1 ) ];
				offsets.set( name, offset + 1 );
				byUuid.set( source.textureUuid, texture );
			}
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
	if ( output ) __attachTextureRefsWhere( artifact, output, ( source ) => source.kind === 'artifact.texture' && ( source.textureName === 'output' || ! source.textureName ) );
	const depth = getPassTexture( 'depth' );
	if ( depth ) __attachTextureRefsWhere( artifact, depth, ( source ) => source.kind === 'depth.texture' );
	return artifact;
}

function __attachRTTTextureRefs( artifact, rttNodes ) {
	if ( ! artifact || ! Array.isArray( rttNodes ) || rttNodes.length === 0 ) return artifact;
	const rtt = rttNodes[ 0 ];
	const texture = rtt && rtt.renderTarget && rtt.renderTarget.texture;
	if ( texture && texture.isTexture === true ) {
		__attachTextureRefsWhere( artifact, texture, ( source ) => source.kind === 'artifact.texture' && ! source.textureName );
	}
	return artifact;
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

function __precompiledArtifactMatchesObject( artifact, object ) {
	if ( ! object || object.isInstancedMesh !== true ) return true;
	const count = object.count || 0;
	if ( ! count ) return true;
	return __artifactNodeAttributes( artifact ).some( ( entry ) => entry.count === count );
}

function __retargetPrecompiledMaterialForObject( material, object ) {
	if ( ! material || ! material.isPrecompiledMaterial ) return material;
	if ( __precompiledArtifactMatchesObject( material.precompiledArtifact, object ) ) return material;

	const oldName = material.name || '';
	const className = __classNameFromArtifactName( oldName ) || 'MeshStandardNodeMaterial';
	if ( oldName ) __usedArtifactNames.delete( oldName );
	let replacement = null;
	try {
		replacement = __takeMaterial( className, material, object );
	} catch ( _ ) {
		if ( oldName ) __usedArtifactNames.add( oldName );
		return material;
	}
	if ( ! replacement || replacement === material ) {
		if ( oldName ) __usedArtifactNames.add( oldName );
		return material;
	}
	__copyMaterialProps( material, replacement );
	__copyMaterialNodeProps( material, replacement );
	__wireMaterialTextures( material, replacement );
	if ( __wireMaterialPropertyTexturesFromArtifact( replacement ) ) __markMaterialTextureRewire( replacement );
	return replacement;
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
		const replaceOne = ( inputMaterial ) => {
			let m = inputMaterial;
			if ( ! m ) return m;
			// Materials intercepted at constructor time come back as PrecompiledMaterial
			// directly. Wire live compute attributes (positionNode, colorNode...) into
			// the artifact plan entries now — before hydrateNodeBuilderState is first
			// called in the upcoming super.render.
			if ( m.isPrecompiledMaterial ) {
				m = __retargetPrecompiledMaterialForObject( m, object );
				try { Object.defineProperty( m, '__tslpPrecompileObject', { value: object, configurable: true } ); } catch ( _ ) {}
				if ( __wireMaterialPropertyTexturesFromArtifact( m ) ) __markMaterialTextureRewire( m );
				if ( m.precompiledArtifact && ! __wiredPCMaterials.has( m ) ) {
					__wireComputeAttrsToArtifact( m.precompiledArtifact, m );
					__wireMaterialNodeTextures( m, m );
					__wiredPCMaterials.add( m );
				}
				return m;
			}
			if ( m.visible === false ) return m;
			if ( __seenMaterials.has( m ) ) {
				const replacement = __seenMaterials.get( m );
				__copyMaterialProps( m, replacement );
				__copyMaterialNodeProps( m, replacement );
				__wireMaterialTextures( m, replacement );
				if ( __wireMaterialPropertyTexturesFromArtifact( replacement ) ) __markMaterialTextureRewire( replacement );
				return replacement;
			}
			const className = __classNameForMaterial( m );
			const replacement = __takeMaterial( className, m, object );
			try { Object.defineProperty( replacement, '__tslpPrecompileObject', { value: object, configurable: true } ); } catch ( _ ) {}
			__copyMaterialProps( m, replacement );
			__copyMaterialNodeProps( m, replacement );
			__wireMaterialTextures( m, replacement );
			if ( __wireMaterialPropertyTexturesFromArtifact( replacement ) ) __markMaterialTextureRewire( replacement );
			__seenMaterials.set( m, replacement );
			return replacement;
		};
		object.material = Array.isArray( material ) ? material.map( replaceOne ) : replaceOne( material );
	}
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
	if ( ! node || depth > 12 || seen.has( node ) ) return out;
	if ( typeof node !== 'object' && typeof node !== 'function' ) return out;
	seen.add( node );
	if ( node.isTexture === true ) {
		__pushUniqueTexture( out, node );
		return out;
	}
	const read = ( object, key ) => {
		try { return object && object[ key ]; }
		catch ( _ ) { return null; }
	};
	for ( const key of [ 'value', '_value', 'texture', '_texture', 'textureNode', 'source', '_source', 'renderTarget' ] ) {
		const v = read( node, key );
		if ( v && v.isTexture === true ) __pushUniqueTexture( out, v );
		if ( v && v.texture && v.texture.isTexture === true ) __pushUniqueTexture( out, v.texture );
	}
	for ( const key of [ 'node', 'aNode', 'bNode', 'uvNode', 'levelNode', 'sourceNode', 'textureNode', 'pmremNode' ] ) {
		const child = read( node, key );
		if ( child ) __collectTexturesInNode( child, out, depth + 1, seen );
	}
	for ( const key of Object.getOwnPropertyNames( node ) ) {
		if ( key === 'parent' || key === 'children' || key === '_cache' || key === 'builder' || key === 'material' || key === 'object' ) continue;
		const child = read( node, key );
		if ( child && child.isTexture === true ) __pushUniqueTexture( out, child );
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

function __isPMREMNode( node ) {
	return !! ( node && node.isNode === true && Object.prototype.hasOwnProperty.call( node, '_value' ) && Object.prototype.hasOwnProperty.call( node, '_pmrem' ) );
}

function __collectPMREMSourceTexturesInNode( node, out = [], depth = 0, seen = new Set() ) {
	if ( ! node || depth > 24 || seen.has( node ) ) return out;
	if ( typeof node !== 'object' && typeof node !== 'function' ) return out;
	seen.add( node );
	const read = ( object, key ) => {
		try { return object && object[ key ]; }
		catch ( _ ) { return null; }
	};
	if ( __isPMREMNode( node ) ) {
		const source = read( node, '_value' );
		if ( source && source.isTexture === true && __isEnvironmentTextureSource( source ) ) __pushUniqueTexture( out, source );
	}
	if ( typeof node.getChildren === 'function' ) {
		try {
			for ( const child of node.getChildren() ) {
				__collectPMREMSourceTexturesInNode( child, out, depth + 1, seen );
			}
		} catch ( _ ) {}
	}
	for ( const key of [ 'node', 'aNode', 'bNode', 'uvNode', 'levelNode', 'sourceNode', 'textureNode', 'pmremNode' ] ) {
		const child = read( node, key );
		if ( child ) __collectPMREMSourceTexturesInNode( child, out, depth + 1, seen );
	}
	return out;
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

// True iff a Texture's pixel source has actually arrived from its async loader.
// CubeTexture: image is a 6-element array of HTMLImageElement / ImageBitmap.
// 2D textures: image is a single HTMLImageElement / ImageBitmap / HTMLCanvasElement.
// DataTexture: image carries .data (typed array) — these are sync, always ready.
// HDR / equirect via RGBELoader / TextureLoader: image is set on onLoad.
function __textureImageReady( texture ) {
	if ( ! texture || texture.isTexture !== true ) return false;
	const hasSize = ( image ) => {

		if ( ! image ) return false;
		const width = image.width || image.naturalWidth || image.videoWidth || image.image && image.image.width;
		const height = image.height || image.naturalHeight || image.videoHeight || image.image && image.image.height;
		return width > 0 && height > 0;

	};
	const img = texture.image;
	if ( img === null || img === undefined ) return false;
	if ( Array.isArray( img ) ) {
		if ( img.length === 0 ) return false;
		for ( const face of img ) if ( ! hasSize( face ) ) return false;
		return true;
	}
	// DataTexture / Data3DTexture / RenderTargetTexture: synchronous shape.
	return hasSize( img );
}

function __newFallbackTextureImage() {
	return { data: new Uint8Array( [ 255, 255, 255, 255 ] ), width: 1, height: 1 };
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
	if ( ! texture || texture.isTexture !== true ) return;
	const img = texture.image;
	if ( img === null || img === undefined ) {
		try {
			texture.image = __newFallbackTextureImage();
			__harnessDiagnostics().healedNullTextureImages ++;
		} catch ( _ ) {}
		return;
	}
	if ( Array.isArray( img ) ) {
		let changed = false;
		const healed = img.map( ( face ) => {
			if ( face ) return face;
			changed = true;
			return __newFallbackTextureImage();
		} );
		if ( changed ) {
			try {
				texture.image = healed;
				__harnessDiagnostics().healedNullTextureImages ++;
			} catch ( _ ) {}
		}
	}
}

function __getCachedPMREMForSource( sourceTex ) {
	if ( ! sourceTex || sourceTex.isTexture !== true ) return null;
	const cached = __pmremCache.get( sourceTex );
	if ( cached && cached.isTexture === true ) return cached;
	return __isPMREMTexture( sourceTex ) ? sourceTex : null;
}

function __wireBackgroundTextures( scene, renderer ) {
	const auxList = Array.isArray( __data.aux ) ? __data.aux : [];
	// Pick a source cubemap: prefer scene.background (legacy path) but fall
	// back to a node-graph-recovered source for the backgroundNode-only path
	// (e.g. webgpu_pmrem_cubemap.html does scene.backgroundNode = pmremTexture(map)
	// and never sets scene.background).
	const sourceTextures = __backgroundSourceTextures( scene );
	let sourceTex = sourceTextures[ 0 ] || null;
	if ( ! sourceTex ) return;
	// Guard: if the texture is async-loading (CubeTextureLoader, RGBELoader,
	// TextureLoader) and its image hasn't arrived yet, skip wiring. Otherwise
	// three.js's Textures.updateTexture → getTransfer( image ) throws when
	// image is undefined, leaving the sky quad rendering fallback white forever
	// (the cached bind group sticks to whatever was wired on first render).
	// On the next frame after the loader resolves, the WeakMap lookup is still
	// undefined for this artifact, so the wire fires fresh with image populated.
	// CubeTexture image is an array of 6; consider it ready only if all six are present.
	if ( ! __isPMREMTexture( sourceTex ) && ! __textureImageReady( sourceTex ) ) return;
	let texToWire = sourceTex;
	let pmremTextures = null;
	if ( __backgroundNeedsPMREM ) {
		pmremTextures = [];
		for ( const source of sourceTextures ) {
			if ( ! source || source.isTexture !== true ) continue;
			if ( ! __isPMREMTexture( source ) && ! __textureImageReady( source ) ) return;
			const cached = __getCachedPMREMForSource( source );
			if ( cached && cached.isTexture === true ) __pushUniqueTexture( pmremTextures, cached );
			else return;
		}
		texToWire = pmremTextures[ 0 ] || null;
		// Do not bind the raw equirect/cube source as a temporary PMREM
		// substitute. The hydrator applies captured PMREM sampler state
		// (CubeUV mapping + flipY=false) to bound textures, which mutates
		// loader sources before PMREM generation and can invert the replay sky.
		if ( ! texToWire ) return;
	} else if ( __backgroundNeedsCube && ! __isCubeTextureSource( sourceTex ) ) {
		const cached = __backgroundCubeCache.get( sourceTex );
		if ( cached && cached.isTexture === true ) texToWire = cached;
		else return;
	}
	let changed = false;
	for ( const entry of auxList ) {
		if ( entry && entry.shape === 'background' && entry.artifact ) {
			const artifact = entry.artifact;
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
			}
		}
	}
	if ( changed && renderer ) {
		// Force re-hydration of the cached Background.update mesh material so
		// its bind group rebuilds against the updated artifact._textureRefs.
		// Without this, an async CubeTextureLoader that resolves after the
		// first render leaves the sky quad sampling fallbackCubeTexture forever
		// (Background.js caches the mesh.material in sceneData and never
		// recreates it because our __nodeStub() backgroundCacheKey is stable).
		// Dispose mirrors the PMREM-completion path in __wireEnvironmentPMREM:
		// the next render creates a fresh RenderObject with _nodeBuilderState=null,
		// triggering hydrateNodeBuilderState against the now-correct _textureRefs.
		const bg = renderer._background;
		const sceneData = bg && typeof bg.get === 'function' ? bg.get( scene ) : null;
		if ( sceneData && sceneData.backgroundMesh && sceneData.backgroundMesh.material ) {
			try { sceneData.backgroundMesh.material.dispose(); } catch ( _ ) {}
		}
		try {
			const nc = renderer._nodes && renderer._nodes.nodeBuilderCache;
			if ( nc && typeof nc.clear === 'function' ) nc.clear();
		} catch ( _ ) {}
		if ( renderer._quadCache ) renderer._quadCache.clear();
	}
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

const __backgroundCubeCache = new WeakMap();   // equirect source tex → CubeTexture (ready)
const __backgroundCubePending = new WeakMap(); // equirect source tex → Promise<CubeTexture|null>
const __backgroundCubeTargets = new WeakMap(); // keep CubeRenderTarget alive for its texture
const __backgroundCubeFailed = new WeakSet();

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

async function __generateBackgroundCubeAsync( slimRenderer, sourceTex ) {
	if ( __backgroundCubeFailed.has( sourceTex ) ) return null;
	const fullRenderer = await __getComputeRenderer( slimRenderer );
	if ( ! fullRenderer ) return null;
	try {
		const { CubeRenderTarget } = await import( '/build/three.webgpu.js' );
		const target = new CubeRenderTarget( __cubeSizeForEquirect( sourceTex ) );
		let cubeSource = sourceTex;
		if ( typeof sourceTex.clone === 'function' ) {
			cubeSource = sourceTex.clone();
			cubeSource.image = sourceTex.image;
			cubeSource.flipY = sourceTex.flipY;
			cubeSource.mapping = Slim.EquirectangularReflectionMapping;
			cubeSource.needsUpdate = true;
		}
		target.fromEquirectangularTexture( fullRenderer, cubeSource );
		const cube = target.texture;
		if ( cube && cube.isTexture === true ) {
			cube.name = sourceTex.name ? sourceTex.name + '.cube' : 'background.cube';
			if ( sourceTex.mapping === Slim.EquirectangularRefractionMapping ) cube.mapping = Slim.CubeRefractionMapping;
			else cube.mapping = Slim.CubeReflectionMapping;
			__backgroundCubeTargets.set( sourceTex, target );
			__sharePMREMGPUTexture( slimRenderer, fullRenderer, cube );
			__markSlimTextureInitialized( slimRenderer, cube );
			Slim.registerLiveTexture( cube );
			__backgroundCubeCache.set( sourceTex, cube );
			return cube;
		}
	} catch ( err ) {
		__backgroundCubeFailed.add( sourceTex );
		if ( ! window.__tslpBackgroundCubeWarned ) {
			window.__tslpBackgroundCubeWarned = true;
			console.warn( '[tslp-e2e] background cube generation failed:', err && err.message || err );
		}
	}
	return null;
}

function __kickBackgroundCubeGenAsync( slimRenderer, sourceTex, onReady ) {
	if ( ! slimRenderer || ! sourceTex || sourceTex.isTexture !== true || __isCubeTextureSource( sourceTex ) ) return;
	if ( __backgroundCubeCache.has( sourceTex ) ) { onReady( __backgroundCubeCache.get( sourceTex ) ); return; }
	if ( __backgroundCubePending.has( sourceTex ) ) {
		__backgroundCubePending.get( sourceTex ).then( ( cube ) => { if ( cube ) onReady( cube ); } ).catch( () => {} );
		return;
	}
	if ( ! __textureImageReady( sourceTex ) ) return;
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
	__pmremDiagnostics().generateCalls ++;
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
			} else {
				__sharePMREMGPUTexture( slimRenderer, fullRenderer, pmrem );
				__pmremDiagnostics().generateSuccess ++;
			}
			__pmremCache.set( sourceTex, pmrem );
		}
		return pmrem || null;
	} catch ( err ) {
		__pmremFailed.add( sourceTex );
		__pmremDiagnostics().generateFailed ++;
		// Per-page warn-once: log only the FIRST PMREM failure for the entire
		// page load. Per-texture dedup wasn't reliable because scene.environment
		// gets swapped between renders and per-material envMap iteration creates
		// new texture identities each frame, so each frame produced a fresh warn
		// and the spam (37k+ lines) saturated the Playwright IPC and stalled
		// the whole run. The error itself is still captured in the example's
		// replayErrors via the report's failure pipeline.
		if ( ! window.__tslpPmremWarned ) {
			window.__tslpPmremWarned = true;
			console.warn( '[tslp-e2e] PMREM async generation failed:', err && err.message || err );
		}
		return null;
	}
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
	for ( const group of artifact.uniformPlan || [] ) {
		for ( const t of group.textures || [] ) {
			const src = t && t.source || {};
			if ( src.kind === 'artifact.texture' && ( src.mapping === 306 || src.textureName === 'PMREM.cubeUv' ) ) return true;
		}
	}
	return false;
}

function __artifactPMREMSourceUuids( artifact ) {
	const out = [];
	const seen = new Set();
	for ( const group of artifact && artifact.uniformPlan || [] ) {
		for ( const entry of group.textures || [] ) {
			const source = entry && entry.source || {};
			if ( ! source.textureUuid || ! __isPMREMArtifactTextureSource( source ) || seen.has( source.textureUuid ) ) continue;
			seen.add( source.textureUuid );
			out.push( source.textureUuid );
		}
	}
	return out;
}

function __cachedPMREMForSource( sourceTex ) {
	return __getCachedPMREMForSource( sourceTex );
}

function __pmremTexturesForSources( sources ) {
	const out = [];
	for ( const source of sources || [] ) {
		const pmrem = __getCachedPMREMForSource( source );
		if ( pmrem && pmrem.isTexture === true ) __pushUniqueTexture( out, pmrem );
	}
	return out;
}

function __textureListSignature( textures, count = 0 ) {
	const limit = Math.max( 0, count || ( textures && textures.length ) || 0 );
	return ( textures || [] ).slice( 0, limit ).map( ( texture, index ) => {
		return texture && ( texture.uuid || texture.name || String( index ) ) || String( index );
	} ).join( '|' );
}

function __attachPMREMRefsByOrder( artifact, pmremTextures ) {
	const sourceUuids = __artifactPMREMSourceUuids( artifact );
	if ( sourceUuids.length === 0 ) return false;
	const pmrems = [];
	for ( const texture of pmremTextures || [] ) {
		if ( texture && texture.isTexture === true ) __pushUniqueTexture( pmrems, texture );
	}
	if ( pmrems.length < sourceUuids.length ) return false;
	const refs = artifact._textureRefs instanceof Map ? new Map( artifact._textureRefs ) : new Map();
	let changed = false;
	for ( let i = 0; i < sourceUuids.length; i ++ ) {
		const uuid = sourceUuids[ i ];
		const texture = pmrems[ i ];
		if ( refs.get( uuid ) === texture ) continue;
		refs.set( uuid, texture );
		changed = true;
	}
	if ( changed ) {
		Object.defineProperty( artifact, '_textureRefs', {
			value: refs,
			enumerable: false,
			configurable: true,
			writable: true,
		} );
	}
	return true;
}

function __wireEnvironmentPMREM( renderer, scene ) {
	if ( ! renderer || ! scene ) return;
	__pmremDiagnostics().wireCalls ++;
	const sceneEnvPmrems = __pmremTexturesForSources( __environmentSourceTextures( scene, true ) );
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
				const matEnv = m.envMap && m.envMap.isTexture === true ? m.envMap : null;
				const matPmrem = matEnv ? __getCachedPMREMForSource( matEnv ) : null;
				const pmrems = matPmrem && sourceUuids.length <= 1 ? [ matPmrem ] : sceneEnvPmrems;
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
}

// Kick off async PMREM generation if not already started. onReady is called
// with the pmrem texture once generation completes. The global
// window.__tslpPmremPending counter is incremented until the generation
// finishes so Playwright's freeze-wait condition can include it.
function __kickPMREMGenAsync( slimRenderer, sourceTex, onReady ) {
	if ( ! slimRenderer || ! sourceTex || sourceTex.isTexture !== true ) return;
	__pmremDiagnostics().kickCalls ++;
	if ( __pmremCache.has( sourceTex ) ) { __pmremDiagnostics().cacheHits ++; onReady( __pmremCache.get( sourceTex ) ); return; }
	if ( __pmremPending.has( sourceTex ) ) {
		__pmremDiagnostics().pendingJoins ++;
		__pmremPending.get( sourceTex ).then( ( pmrem ) => { if ( pmrem ) onReady( pmrem ); } ).catch( () => {} );
		return;
	}
	// Defer until the source texture's pixel data has actually landed. Calling
	// PMREMGenerator on a still-loading CubeTexture (image=[]) or HDR
	// (image=null) makes _setSizeFromTexture compute NaN, _init builds an
	// empty _lodMeshes, and _textureToCubeUV throws
	// "Cannot set properties of undefined (setting 'material')" every frame
	// until the loader resolves — the resulting console flood stalls the run
	// over the Playwright IPC. The loader counter keeps the freeze pending in
	// the meantime, so returning without scheduling is safe; the next render
	// after onLoad retries.
	if ( ! __textureImageReady( sourceTex ) ) { __pmremDiagnostics().skippedNotReady ++; return; }
	window.__tslpPmremPending = ( window.__tslpPmremPending | 0 ) + 1;
	const resultPromise = __generatePMREMAsync( slimRenderer, sourceTex ).catch( () => null );
	__pmremPending.set( sourceTex, resultPromise );
	resultPromise.then( ( pmrem ) => {
		if ( pmrem ) {
			try { onReady( pmrem ); } catch ( _ ) {}
		}
	} ).finally( () => {
		window.__tslpPmremPending = Math.max( 0, ( window.__tslpPmremPending | 0 ) - 1 );
	} );
}

// Walk the scene and register every discovered Texture in the runtime's
// live-texture index. Hydrator uses this to relink artifact.texture-kind
// bindings whose textureUuid is dead by matching imageSrc / textureName
// from the captured artifact against currently-loaded textures.
function __indexLiveTextures( scene ) {
	if ( ! scene || typeof scene.traverse !== 'function' ) return;
	const visit = ( tex ) => {
		if ( tex && tex.isTexture === true ) {
			__healTextureImage( tex );
			__rememberLiveTexture( tex );
		}
	};
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
		if ( object && object.isLight === true && object.map && object.map.isTexture === true ) visit( object.map );
		const ms = object && object.material;
		const list = Array.isArray( ms ) ? ms : ms ? [ ms ] : [];
		for ( const m of list ) {
			if ( ! m ) continue;
			for ( const key of __TEXTURE_PROPS ) visit( m[ key ] );
		}
	} );
}

function __prepareSceneForReplay( scene, renderer ) {
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
	if ( scene ) {
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
	__replaceSceneMaterials( scene );
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
let __syncDbgOnce = true;
let __syncDbgCount = 0;
function __syncStorageBuffers( computeNode, fullRenderer, slimRenderer ) {
	try {
		const __DBG_CLOTH = typeof window !== 'undefined' && window.__TSLP_DBG_CLOTH === true;
		const __dbgLimit = __DBG_CLOTH ? 6 : 3;
		const computeList = Array.isArray( computeNode ) ? computeNode : [ computeNode ];
		const device = slimRenderer.backend.device;
		let commandEncoder = null;
		for ( const node of computeList ) {
			let bindGroups;
			try { bindGroups = fullRenderer._bindings.getForCompute( node ); }
			catch ( _ ) { continue; }
			if ( ! bindGroups ) continue;
			let _totalBindings = 0, _storageBindings = 0;
			for ( const bindGroup of bindGroups ) {
				if ( ! bindGroup || ! bindGroup.bindings ) continue;
				for ( const binding of bindGroup.bindings ) {
					_totalBindings++;
					// Storage textures: a compute kernel that writes to a StorageTexture
					// (via textureStore) binds it as a sampled-texture-style binding with
					// .texture being the StorageTexture instance. The slim renderer
					// creates its own empty GPUTexture for the same JS object — make slim
					// share full's GPUTexture so the compute output is visible in slim's
					// render pass.
					if ( binding.isSampledTexture && binding.texture && binding.texture.isStorageTexture === true ) {
						const tex = binding.texture;
						const fullTexData = fullRenderer.backend.get( tex );
						if ( ! fullTexData || ! fullTexData.texture ) {
							if ( __syncDbgCount < __dbgLimit ) console.log( '[tslp-dbg] tex-skip-nofull node=' + ( node && node.name ) + ' tex=' + ( tex.name || '' ) );
							continue;
						}
						const slimTexData = slimRenderer.backend.get( tex );
						if ( ! slimTexData.texture ) {
							// Slim hasn't created a GPU texture yet — pre-seed with full's so
							// when slim's first render hits updateTexture, the initialized
							// short-circuit kicks in (no createTexture call, which would throw
							// "Texture already initialized" against an already-shared resource).
							slimTexData.texture = fullTexData.texture;
							slimTexData.format = fullTexData.format;
							slimTexData.initialized = true;
							slimTexData.version = tex.version;
							slimTexData.generation = ( slimTexData.generation || 0 ) + 1;
							if ( ! slimTexData.bindGroups ) slimTexData.bindGroups = new Set();
							__markSlimTextureInitialized( slimRenderer, tex );
							if ( __syncDbgCount < __dbgLimit ) console.log( '[tslp-dbg] tex-preseed node=' + ( node && node.name ) + ' tex=' + ( tex.name || '<anon>' ) );
						} else if ( slimTexData.texture !== fullTexData.texture ) {
							// Slim already has its own GPUTexture (rendered before compute
							// finished). Copy the full's GPU texture content INTO slim's
							// existing texture — the bind groups and views still point at
							// slim's texture, so this update is visible without invalidation.
							try {
								const fullTex = fullTexData.texture;
								const slimTex = slimTexData.texture;
								const w = fullTex.width;
								const h = fullTex.height;
								const d = fullTex.depthOrArrayLayers || 1;
								const enc = device.createCommandEncoder();
								enc.copyTextureToTexture(
									{ texture: fullTex },
									{ texture: slimTex },
									{ width: w, height: h, depthOrArrayLayers: d }
								);
								device.queue.submit( [ enc.finish() ] );
								if ( __syncDbgCount < __dbgLimit ) console.log( '[tslp-dbg] tex-copy node=' + ( node && node.name ) + ' tex=' + ( tex.name || '<anon>' ) + ' size=' + w + 'x' + h + 'x' + d );
							} catch ( e ) {
								if ( __syncDbgCount < __dbgLimit ) console.log( '[tslp-dbg] tex-copy-fail node=' + ( node && node.name ) + ' err=' + ( e && e.message || e ) );
							}
						} else {
							__markSlimTextureInitialized( slimRenderer, tex );
							if ( __syncDbgCount < __dbgLimit ) console.log( '[tslp-dbg] tex-already-shared node=' + ( node && node.name ) );
						}
						continue;
					}
					if ( ! binding.isStorageBuffer ) {
						if ( __syncDbgCount < __dbgLimit ) console.log( '[tslp-dbg] skip node=' + ( node && node.name ) + ' binding=' + binding.name + ' type=' + ( binding.constructor && binding.constructor.name ) );
						continue;
					}
					_storageBindings++;
					const attr = binding.attribute;
					if ( ! attr ) {
						if ( __syncDbgCount < __dbgLimit ) console.log( '[tslp-dbg] noattr node=' + ( node && node.name ) + ' binding=' + binding.name );
						continue;
					}
					const fullBufData = fullRenderer.backend.get( attr );
					if ( ! fullBufData || ! fullBufData.buffer ) continue;
					const fullBuf = fullBufData.buffer;
					const slimBufData = slimRenderer.backend.get( attr );
					if ( __DBG_CLOTH && __syncDbgCount < __dbgLimit ) {
						const slimAttrCache = slimRenderer._attributes && slimRenderer._attributes.get( attr );
						console.log( '[tslp-dbg-cloth sync-pre] node=' + ( node && node.name ) + ' attr=' + ( attr.name || '<anon>' ) + ' count=' + attr.count + ' itemSize=' + attr.itemSize + ' slimHasAttr=' + !! slimAttrCache + ' slimHasBuf=' + !! slimBufData.buffer + ' fullBufSize=' + fullBuf.size );
					}
					if ( ! slimBufData.buffer ) {
						if ( ! commandEncoder ) commandEncoder = device.createCommandEncoder();
						const newBuf = device.createBuffer( { size: fullBuf.size, usage: fullBuf.usage } );
						commandEncoder.copyBufferToBuffer( fullBuf, 0, newBuf, 0, fullBuf.size );
						slimBufData.buffer = newBuf;
						const slimAttr = slimRenderer._attributes.get( attr );
						if ( slimAttr && slimAttr.version === undefined ) {
							slimAttr.version = 1;
						}
						if ( __syncDbgCount < __dbgLimit ) console.log( '[tslp-dbg] sync node=' + ( node && node.name ) + ' attr=' + attr.name + ' count=' + attr.count + ' create+copy fullBuf=' + fullBuf.size );
					} else if ( slimBufData.buffer !== fullBuf ) {
						const slimBuf = slimBufData.buffer;
						const copySize = Math.min( fullBuf.size, slimBuf.size );
						if ( copySize > 0 ) {
							if ( ! commandEncoder ) commandEncoder = device.createCommandEncoder();
							commandEncoder.copyBufferToBuffer( fullBuf, 0, slimBuf, 0, copySize );
						}
						if ( __syncDbgCount < __dbgLimit ) console.log( '[tslp-dbg] sync node=' + ( node && node.name ) + ' attr=' + attr.name + ' count=' + attr.count + ' copy=' + copySize );
					} else {
						if ( __syncDbgCount < __dbgLimit ) console.log( '[tslp-dbg] sync node=' + ( node && node.name ) + ' attr=' + attr.name + ' count=' + attr.count + ' same' );
					}
				}
			}
			if ( __syncDbgCount < __dbgLimit ) console.log( '[tslp-dbg] sync-summary node=' + ( node && node.name ) + ' totalBindings=' + _totalBindings + ' storageBindings=' + _storageBindings );
		}
		if ( commandEncoder ) device.queue.submit( [ commandEncoder.finish() ] );
		__syncDbgOnce = false;
		__syncDbgCount++;
		if ( __syncDbgCount === 62 ) console.log( '[tslp-dbg] sync complete count=' + __syncDbgCount );
	} catch ( err ) {
		console.warn( '[tslp-e2e] storage buffer sync failed:', err && err.message || err );
	}
}

let __computeRenderer = null;
let __computeRendererInit = null;
let __fullThreeMod = null;
async function __getComputeRenderer( slimRenderer ) {
	if ( __computeRenderer ) return __computeRenderer;
	if ( __computeRendererInit ) return __computeRendererInit;
	__computeRendererInit = ( async () => {
		try {
			const mod = await import( '/build/three.webgpu.js' );
			__fullThreeMod = mod;
			const FullRenderer = mod.WebGPURenderer;
			const device = slimRenderer.backend && slimRenderer.backend.device;
			const r = new FullRenderer( device ? { device } : {} );
			await r.init();
			// Enable shadow map on the full renderer so shadow passes fire when
			// rendering the shadow scene below. The slim renderer's shadowMap
			// flag is cosmetic (shadow code is tree-shaken).
			r.shadowMap.enabled = true;
			__computeRenderer = r;
			return r;
		} catch ( err ) {
			console.warn( '[tslp-e2e] compute renderer init failed:', err && err.message || err );
			return null;
		}
	} )();
	return __computeRendererInit;
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

function __buildShadowScene( userScene ) {
	if ( ! __fullThreeMod ) return null;
	// MeshLambertNodeMaterial samples lights and shadows — without a shadow-
	// sampling material in the scene, three.js's NodeBuilder skips ShadowNode
	// setup and light.shadow.map never allocates. Lambert is the cheapest
	// PCF-shadow-aware material we can stand-in for.
	const { Scene: FullScene, Mesh: FullMesh, MeshLambertMaterial, MeshLambertNodeMaterial } = __fullThreeMod;
	if ( ! FullScene || ! FullMesh || ( ! MeshLambertMaterial && ! MeshLambertNodeMaterial ) ) return null;
	const StandinMaterial = MeshLambertMaterial || MeshLambertNodeMaterial;
	const shadowScene = new FullScene();
	const lightPairs = []; // { src, clone } so we can refresh transforms each render
	const meshPairs = []; // { src, clone } so we can refresh transforms each render
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
		if ( o.isLight === true && o.castShadow === true && o.shadow ) {
			let cloned = null;
			// Build a fresh light of the same type rather than cloning, to avoid
			// any inherited internal state that disables shadow allocation.
			try {
				const FullThree = __fullThreeMod;
				if ( o.isDirectionalLight && FullThree.DirectionalLight ) {
					cloned = new FullThree.DirectionalLight( o.color ? o.color.clone() : 0xffffff, o.intensity || 1 );
				} else if ( o.isSpotLight && FullThree.SpotLight ) {
					cloned = new FullThree.SpotLight( o.color ? o.color.clone() : 0xffffff, o.intensity || 1 );
					if ( o.distance !== undefined ) cloned.distance = o.distance;
					if ( o.angle !== undefined ) cloned.angle = o.angle;
					if ( o.penumbra !== undefined ) cloned.penumbra = o.penumbra;
					if ( o.decay !== undefined ) cloned.decay = o.decay;
				} else if ( o.isPointLight && FullThree.PointLight ) {
					cloned = new FullThree.PointLight( o.color ? o.color.clone() : 0xffffff, o.intensity || 1 );
					if ( o.distance !== undefined ) cloned.distance = o.distance;
					if ( o.decay !== undefined ) cloned.decay = o.decay;
				} else if ( typeof o.clone === 'function' ) {
					cloned = o.clone();
				}
			} catch ( _ ) { cloned = null; }
			if ( cloned ) {
				cloned.castShadow = true;
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
				// Directional / spot lights project shadows toward a target;
				// the target is also an Object3D in the user scene. Clone it
				// and parent under shadowScene to keep the projection correct.
				if ( o.target && o.target.isObject3D ) {
					const tgtClone = o.target.clone();
					if ( o.target.matrixWorld ) {
						o.target.matrixWorld.decompose( tgtClone.position, tgtClone.quaternion, tgtClone.scale );
					}
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
			const standin = new FullMesh( __cloneGeometryForFullRenderer( o.geometry ), new StandinMaterial() );
			standin.castShadow = !! o.castShadow;
			standin.receiveShadow = !! o.receiveShadow;
			// Decompose world matrix onto local position/quaternion/scale —
			// matrixAutoUpdate=true (default) ensures matrixWorld is rebuilt
			// during render's projectObject pass.
			if ( o.matrixWorld ) {
				o.matrixWorld.decompose( standin.position, standin.quaternion, standin.scale );
			}
			standin.frustumCulled = false;
			// Carry alpha-related fields that the depth pass uses.
			if ( o.material && ! Array.isArray( o.material ) ) {
				for ( const key of [ 'side', 'shadowSide', 'alphaTest', 'transparent', 'opacity', 'depthTest', 'depthWrite', 'clipShadows', 'clippingPlanes' ] ) {
					if ( o.material[ key ] !== undefined ) standin.material[ key ] = o.material[ key ];
				}
				if ( o.material.alphaTest ) standin.material.alphaTest = o.material.alphaTest;
				if ( o.material.alphaMap ) standin.material.alphaMap = o.material.alphaMap;
				for ( const key of [ 'alphaTestNode', 'maskNode', 'maskShadowNode', 'castShadowPositionNode', 'castShadowNode' ] ) {
					if ( o.material[ key ] && o.material[ key ].isNode === true ) standin.material[ key ] = o.material[ key ];
				}
			}
			shadowScene.add( standin );
			meshPairs.push( { src: o, clone: standin } );
			meshCount ++;
			if ( standin.castShadow === true ) casterCount ++;
		}
	} );
	if ( meshCount === 0 || lightCount === 0 || casterCount === 0 ) return null;
	shadowScene.__lightPairs = lightPairs;
	shadowScene.__meshPairs = meshPairs;
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
		if ( src.target && clone.target && src.target.matrixWorld ) {
			src.target.matrixWorld.decompose( clone.target.position, clone.target.quaternion, clone.target.scale );
		}
	}
	const meshPairs = shadowScene.__meshPairs || [];
	for ( const { src, clone } of meshPairs ) {
		if ( ! src || ! clone || ! src.matrixWorld ) continue;
		src.matrixWorld.decompose( clone.position, clone.quaternion, clone.scale );
	}
}

function __getOrBuildShadowScene( userScene ) {
	if ( __shadowSceneCache.has( userScene ) ) return __shadowSceneCache.get( userScene );
	const built = __buildShadowScene( userScene );
	__shadowSceneCache.set( userScene, built ); // cache null too, so we don't retry
	return built;
}

// Track per-scene state: whether a shadow render is in flight, and the last
// shadow-scene signature used to detect scene growth or moving shadow casters /
// lights. Animated examples (e.g. a moving spotlight) need their offscreen full
// renderer shadow map refreshed when transforms move, otherwise the slim shader
// samples a stale depth map with a fresh light matrix and over-shadows the scene.
const __shadowState = new WeakMap(); // userScene -> { inflight, signature }
function __signatureMatrix( object ) {
	if ( ! object || ! object.matrixWorld || ! object.matrixWorld.elements ) return '';
	return object.matrixWorld.elements.map( ( value ) => Math.round( value * 1000 ) / 1000 ).join( ',' );
}
function __sceneSignature( scene ) {
	if ( ! scene || typeof scene.traverse !== 'function' ) return null;
	let lights = 0, meshes = 0, casters = 0;
	const parts = [];
	try { scene.updateMatrixWorld( true ); } catch ( _ ) {}
	scene.traverse( ( o ) => {
		if ( ! o ) return;
		if ( o.isLight === true && o.castShadow === true && o.shadow ) {
			lights ++;
			parts.push( 'l' + ( o.uuid || o.id || lights ) + ':' + __signatureMatrix( o ) );
			if ( o.target && o.target.isObject3D ) parts.push( 't' + ( o.target.uuid || o.target.id || lights ) + ':' + __signatureMatrix( o.target ) );
		} else if ( ( o.isMesh === true || o.isSkinnedMesh === true ) && o.geometry && ( o.castShadow === true || o.receiveShadow === true ) ) {
			meshes ++;
			if ( o.castShadow === true ) casters ++;
			parts.push( 'm' + ( o.uuid || o.id || meshes ) + ':' + ( o.castShadow === true ? 'c' : 'r' ) + ':' + __signatureMatrix( o ) );
		}
	} );
	return { lights, meshes, casters, value: lights + ':' + meshes + ':' + casters + ':' + parts.join( '|' ) };
}

async function __probeShadowDepthTexture( fullRenderer, depthTex, light, preferredSize ) {
	if ( ! fullRenderer || ! fullRenderer.backend || typeof fullRenderer.backend.copyTextureToBuffer !== 'function' || ! depthTex ) return null;
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
	const signature = __sceneSignature( userScene );
	if ( ! signature || signature.lights === 0 || signature.meshes === 0 || signature.casters === 0 ) return;
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
	st.inflight = true;
	st.signature = sig;
	st.queuedSignature = '';
	window.__tslpShadowPending = ( window.__tslpShadowPending | 0 ) + 1;
	const _slimRenderer = slimRenderer;
	const _userScene = userScene;
	const _camera = camera;
	__getComputeRenderer( slimRenderer ).then( async ( fullRenderer ) => {
		if ( ! fullRenderer ) return;
		const shadowScene = __getOrBuildShadowScene( _userScene );
		if ( ! shadowScene ) return;
		let shadowRenderCamera = _camera;
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
			await fullRenderer.render( shadowScene, shadowRenderCamera );
			// Second render: the first render may have only built+queued shadow node
			// setup; allocations happen during ShadowNode.updateBefore which fires
			// from the SECOND render once nodeFrame.frameId advances.
			await fullRenderer.render( shadowScene, shadowRenderCamera );
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
					if ( _camera.isArrayCamera === true && Number.isFinite( src.shadow.intensity ) ) src.shadow.intensity = Math.min( src.shadow.intensity, 0.25 );
					let depthTex = src.shadow.map.depthTexture;
					if ( depthTex ) {
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
							slimData.texture = fullData.texture;
							slimData.format = fullData.format;
							slimData.initialized = true;
							slimData.version = depthTex.version;
							slimData.generation = ( slimData.generation || 0 ) + 1;
							if ( ! slimData.bindGroups ) slimData.bindGroups = new Set();
							const tx = _slimRenderer._textures;
							if ( tx && typeof tx.get === 'function' ) {
								const txData = tx.get( depthTex );
								txData.initialized = true;
								txData.version = depthTex.version;
								txData.generation = depthTex.version;
								if ( ! txData.bindGroups ) txData.bindGroups = new Set();
							}
						}
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
		// After shadow map is populated, force one extra slim render so the
		// rebinder sees the live depthTexture and the shadow shows up.
		if ( needsReplay || window.__tslpFrozen ) {
			try { _slimRenderer.render( _userScene, _camera ); } catch ( e ) { console.warn( '[tslp-shadow] forced re-render failed:', e && e.message || e ); }
		}
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

export class WebGPURenderer extends Slim.WebGPURenderer {
	async init() {
		const r = await super.init();
		__patchBindGroupLayoutRefresh( this );
		// Eagerly bring up the full compute renderer so PMREMGenerator's
		// fromScene / fromCubemap / fromEquirectangular / fromTexture can route
		// to it on the user's NEXT (synchronous) call. Examples typically
		// await renderer.init() before constructing PMREMGenerator, so chaining
		// the full-renderer init here means the patched PMREMGenerator methods
		// see __computeRenderer ready when fired. Failure is non-fatal — without
		// the full renderer, PMREMGenerator falls through to the original
		// (slim-throwing) path, matching prior behavior.
		try { await __getComputeRenderer( this ); } catch ( _ ) {}
		return r;
	}
	compile( scene, camera, ...rest ) {
		// __pmremRunning guard: PMREMGenerator drives nested compile/render calls
		// for its internal flat-camera mesh; bypass scene-prep during those.
		if ( __pmremRunning > 0 ) return typeof super.compile === 'function' ? super.compile( scene, camera, ...rest ) : undefined;
		__prepareSceneForReplay( scene, this );
		__flushMaterialTextureRewire( this );
		// Wire PMREM from sync cache BEFORE compile so hydration sees the live
		// prefiltered texture. (Async gen is kicked from render(); compile is
		// typically called only when the app pre-warms shaders, so skip kick.)
		__wireEnvironmentPMREM( this, scene );
		return typeof super.compile === 'function' ? super.compile( scene, camera, ...rest ) : undefined;
	}
	compileAsync( scene, camera, ...rest ) {
		if ( __pmremRunning > 0 ) return typeof super.compileAsync === 'function' ? super.compileAsync( scene, camera, ...rest ) : Promise.resolve();
		__prepareSceneForReplay( scene, this );
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
	render( scene, camera ) {
		if ( __pmremRunning > 0 ) return super.render( scene, camera );
		// Track last scene/camera so post-compute forced renders can use them.
		this._lastScene = scene;
		this._lastCamera = camera;
		__prepareSceneForReplay( scene, this );
		__flushMaterialTextureRewire( this );
		// Wire PMREM from sync cache BEFORE super.render so that hydration
		// (which runs inside super.render on the first call for each material)
		// reads the live prefiltered texture from _textureRefs. Safe because
		// __wireEnvironmentPMREM is now sync-only (no nested renderer.render calls).
		__wireEnvironmentPMREM( this, scene );
		__renderPassNodesForPipeline( this, __collectScenePassNodes( scene ) );
		// Heal any Texture whose colorSpace ended up as undefined (some ad-hoc
		// runtime-created textures skip the constructor that defaults to '').
		// Cheap pre-render sweep; without it Textures.updateTexture throws in
		// ColorManagement.getTransfer( undefined ).
		try { window.__tslpHealColorSpace && window.__tslpHealColorSpace( this ); } catch ( _ ) {}
		// Kick off async shadow-map population on the full renderer (slim has
		// shadow code tree-shaken). On completion the rebinder picks up the
		// live light.shadow.map.depthTexture and the next slim render shows it.
		__kickShadowRenderAsync( this, scene, camera );
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
		for ( const _envTex of __environmentSourceTextures( scene, true ) ) {
			if ( ! _envTex || _envTex.isTexture !== true ) continue;
			__kickPMREMGenAsync( _renderer, _envTex, () => {
				__wireEnvironmentPMREM( _renderer, _scene );
				if ( window.__tslpFrozen ) {
					try { _renderer.render( _scene, _camera ); } catch ( e ) { console.warn( '[tslp-e2e] forced render failed:', e && e.message || e ); }
				}
			} );
		}
		// Per-material envMap PMREM: examples that pass envMap via constructor
		// params (e.g. webgpu_pmrem_cubemap.html: new MeshPhysicalNodeMaterial({envMap:map}))
		// don't set scene.environment, so the path above doesn't fire. Walk every
		// PrecompiledMaterial whose artifact needs PMREM and kick gen for unique
		// envMap cubemaps. Reuses __pmremCache so duplicates are deduped.
		if ( scene ) {
			const _seen = new WeakSet();
			scene.traverse( ( object ) => {
				const mat = object && object.material;
				const list = Array.isArray( mat ) ? mat : mat ? [ mat ] : [];
				for ( const m of list ) {
					if ( ! ( m && m.isPrecompiledMaterial && m.precompiledArtifact ) ) continue;
					if ( ! __artifactNeedsPMREM( m.precompiledArtifact ) ) continue;
					const env = m.envMap;
					if ( ! env || env.isTexture !== true || _seen.has( env ) ) continue;
					_seen.add( env );
					__kickPMREMGenAsync( _renderer, env, () => {
						__wireEnvironmentPMREM( _renderer, _scene );
						if ( window.__tslpFrozen ) {
							try { _renderer.render( _scene, _camera ); } catch ( _ ) {}
						}
					} );
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
				__wireBackgroundTextures( _scene, _renderer );
				if ( window.__tslpFrozen ) {
					try { _renderer.render( _scene, _camera ); } catch ( _ ) {}
				}
			} );
		}
		if ( __backgroundNeedsPMREM ) {
			for ( const _bgSource of _bgSources ) {
				if ( ! _bgSource || _bgSource.isTexture !== true ) continue;
				__kickPMREMGenAsync( _renderer, _bgSource, ( pmrem ) => {
					if ( pmrem ) __wireBackgroundTextures( _scene, _renderer );
					if ( window.__tslpFrozen ) {
						try { _renderer.render( _scene, _camera ); } catch ( _ ) {}
					}
				} );
			}
		}
		return r;
	}
	compute( computeNode, ...rest ) {
		// Precompiled compute nodes: slim renderer handles these directly.
		if ( computeNode && computeNode.isPrecompiledCompute === true ) {
			return super.compute( computeNode, ...rest );
		}
		// Raw TSL compute nodes: slim NodeManager cannot build them.
		// Delegate asynchronously to the shared-device full renderer.
		if ( computeNode && computeNode.isComputeNode === true ) {
			this.computeAsync( computeNode, ...rest ).catch( () => {} );
			return undefined;
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
			window.__tslpComputePending = ( window.__tslpComputePending | 0 ) + 1;
			const _slimRenderer = this;
			return __getComputeRenderer( this ).then( ( r ) => {
				if ( ! r ) return;
				return r.computeAsync( computeNode, ...rest ).then( () => {
					__syncStorageBuffers( computeNode, r, _slimRenderer );
				} );
			} ).catch( ( err ) => {
				console.warn( '[tslp-e2e] compute dispatch failed:', err && err.message || err );
			} ).finally( () => {
				window.__tslpComputePending = Math.max( 0, ( window.__tslpComputePending | 0 ) - 1 );
				// If already frozen and no more computes pending, force one extra
				// render so the GPU buffer updates are visible before the screenshot.
				if ( window.__tslpFrozen && ( window.__tslpComputePending | 0 ) === 0 ) {
					const sc = _slimRenderer._lastScene;
					const cam = _slimRenderer._lastCamera;
					if ( sc && cam ) {
						try { _slimRenderer.render( sc, cam ); } catch ( _ ) {}
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
				__attachTextureRefsWhere( artifact, target.texture, ( source ) => source.kind === 'artifact.texture' && ( source.textureName === 'output' || ! source.textureName ) );
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
			// No render-output artifact registered — let super throw loadAux error.
			console.warn( '[tslp-e2e] _renderOutput pre-populate failed:', err && err.message || err );
		}
		return super._renderOutput( target );
	}
}

function __findPassNodeInGraph( node, depth = 0, seen = new Set() ) {
	if ( ! node || depth > 10 || seen.has( node ) ) return null;
	seen.add( node );
	if ( node.isPassNode === true && node.scene && node.camera ) return node;
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) {}
	for ( const key of keys ) {
		if ( key === 'parent' || key === 'children' || key === '_cache' ) continue;
		let child = null;
		try { child = node[ key ]; } catch ( _ ) { continue; }
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
		let child = null;
		try { child = node[ key ]; } catch ( _ ) { continue; }
		if ( ! child ) continue;
		if ( Array.isArray( child ) ) {
			for ( const item of child ) if ( item && ( typeof item === 'object' || typeof item === 'function' ) ) __collectPassNodesInGraph( item, out, seen, depth + 1 );
		} else if ( typeof child === 'object' || typeof child === 'function' ) {
			__collectPassNodesInGraph( child, out, seen, depth + 1 );
		}
	}
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
	if ( ! renderer || ! passNode || ! passNode.scene || ! passNode.camera ) return;
	try { __prepareSceneForReplay( passNode.scene, renderer ); } catch ( _ ) {}
	__preparePassNodeForReplay( renderer, passNode );
	try {
		if ( typeof passNode.updateBefore === 'function' ) passNode.updateBefore( { renderer } );
		else renderer.render( passNode.scene, passNode.camera );
	} catch ( err ) {
		if ( ! window.__tslpPassRenderWarned ) {
			window.__tslpPassRenderWarned = true;
			console.warn( '[tslp-e2e] RenderPipeline pass render failed:', err && err.message || err );
		}
	}
}

function __renderPassNodesForPipeline( renderer, passNodes ) {
	for ( const passNode of passNodes || [] ) __renderPassNodeForPipeline( renderer, passNode );
}

function __isBloomEffectNode( node ) {
	if ( typeof node === 'function' ) return false;
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
		let child = null;
		try { child = node[ key ]; } catch ( _ ) { continue; }
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
	seen.add( node );
	if ( __isRTTNode( node ) ) {
		if ( ! out.includes( node ) ) out.push( node );
	}
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) {}
	const skip = new Set( [ 'parent', 'children', '_cache', 'scene', 'camera', 'renderer', 'geometry', 'material', 'domElement' ] );
	for ( const key of keys ) {
		if ( skip.has( key ) ) continue;
		let child = null;
		try { child = node[ key ]; } catch ( _ ) { continue; }
		if ( ! child ) continue;
		if ( Array.isArray( child ) ) {
			for ( const item of child ) if ( item && ( typeof item === 'object' || typeof item === 'function' ) ) __collectRTTNodesInGraph( item, out, seen, depth + 1 );
		} else if ( typeof child === 'object' || typeof child === 'function' ) {
			__collectRTTNodesInGraph( child, out, seen, depth + 1 );
		}
	}
	return out;
}

function __makeBloomPrecompiledMaterial( shape, sourceMaterial, name ) {
	const artifact = __cloneAuxArtifact( Slim.loadAux( shape, 'tslp-e2e-bypass' ) );
	__wireLiveNodeSidecarsToArtifact( artifact, sourceMaterial );
	if ( typeof shape === 'string' && shape.startsWith( 'bloom-blur-' ) ) __wireBloomBlurUniforms( artifact, sourceMaterial );
	const material = new Slim.PrecompiledMaterial( artifact );
	material.name = name;
	for ( const key of [ 'colorTexture', 'direction', 'invSize' ] ) {
		if ( sourceMaterial && sourceMaterial[ key ] !== undefined ) material[ key ] = sourceMaterial[ key ];
	}
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
		const material = new FullNodeMaterial();
		material.name = name || sourceMaterial.name || 'Bloom';
		for ( const key of [ 'fragmentNode', 'colorTexture', 'direction', 'invSize' ] ) {
			if ( sourceMaterial[ key ] !== undefined ) material[ key ] = sourceMaterial[ key ];
		}
		for ( const key of [ 'transparent', 'depthTest', 'depthWrite', 'toneMapped', 'blending', 'premultipliedAlpha' ] ) {
			if ( sourceMaterial[ key ] !== undefined ) material[ key ] = sourceMaterial[ key ];
		}
		material.toneMapped = true;
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
let __fullRTTRendererState = null;
const __fullRTTSize = new FullVector2();

function __shareGraphTexturesBetweenRenderers( targetRenderer, sourceRenderer, graphNode ) {
	const byName = __collectGraphTexturesByName( graphNode );
	const seen = new Set();
	for ( const textures of byName.values() ) {
		const list = Array.isArray( textures ) ? textures : [ textures ];
		for ( const texture of list ) {
			if ( ! texture || texture.isTexture !== true || seen.has( texture ) ) continue;
			seen.add( texture );
			__shareGPUTextureEntry( targetRenderer, sourceRenderer, texture );
		}
	}
}

function __fullBloomStrengthScale( bloomNode ) {
	try {
		const byName = __collectGraphTexturesByName( bloomNode && bloomNode.inputNode );
		for ( const name of byName.keys() ) {
			if ( name && name !== 'output' && name !== 'depth' ) return 1;
		}
	} catch ( _ ) {}
	return 0.68;
}

function __renderBloomNodeWithFullRenderer( bloomNode, slimRenderer, fullRenderer, diag ) {
	if ( ! bloomNode || ! slimRenderer || ! fullRenderer ) return false;
	if ( ! bloomNode.__tslpFullHighPassMaterial || ! bloomNode.__tslpFullCompositeMaterial || ! Array.isArray( bloomNode.__tslpFullBlurMaterials ) ) return false;
	let scaledStrengthNode = null;
	let scaledStrengthValue = null;
	try {
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
		return false;
	} finally {
		try {
			if ( __fullRTTRendererState && FullRendererUtils && typeof FullRendererUtils.restoreRendererState === 'function' ) FullRendererUtils.restoreRendererState( fullRenderer, __fullRTTRendererState );
		} catch ( _ ) {}
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
			if ( __renderBloomNodeWithFullRenderer( this, renderer, __computeRenderer, diag ) ) return;
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
	Object.defineProperty( bloomNode, '__tslpBloomUpdatePatched', { value: true, configurable: true } );
}

function __renderBloomNodesForPipeline( renderer, bloomNodes ) {
	for ( const bloomNode of bloomNodes || [] ) {
		if ( __prepareBloomNodeForReplay( bloomNode, null ) ) bloomNode.updateBefore( { renderer } );
	}
}

function __renderRTTNodesForPipeline( renderer, rttNodes ) {
	try {
		const diag = __harnessDiagnostics();
		diag.rtt = diag.rtt || { collected: 0, rendered: 0, failed: 0 };
		diag.rtt.collected += rttNodes && rttNodes.length || 0;
	} catch ( _ ) {}
	for ( const rttNode of rttNodes || [] ) {
		if ( __renderRTTNodeWithFullRenderer( rttNode, renderer, __computeRenderer ) ) {
			try { __harnessDiagnostics().rtt.rendered ++; } catch ( _ ) {}
		} else {
			try { __harnessDiagnostics().rtt.failed ++; } catch ( _ ) {}
		}
	}
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

// RenderPipeline (and PostProcessing which extends it) calls ng("post-process", ...)
// from its _update() method — the same dual-registry problem as _renderOutput.
// Override _update to pre-set _quadMesh.material from Slim.loadAux before ng fires.
export class RenderPipeline extends Slim.RenderPipeline {
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
				// Shape-fallback: returns any registered render-pipeline artifact.
				// outputColorTransform=true wraps the pipeline in renderOutput(), whose
				// artifact carries the final color-space transfer.
				const shape = this.outputColorTransform === true ? 'render-output' : 'post-process';
				let artifact = Slim.loadAux( shape, 'tslp-e2e-bypass' );
				const passNodes = __collectPassNodesInGraph( this.outputNode );
				const rttNodes = __collectRTTNodesInGraph( this.outputNode );
				const bloomNodes = __collectBloomNodesInGraph( this.outputNode );
				__bloomDiagnostics().collected += bloomNodes.length;
				const passNode = passNodes[ 0 ] || null;
				const context = {
					renderPipeline: this,
					onBeforeRenderPipeline: null,
					onAfterRenderPipeline: null,
				};
				for ( const node of passNodes ) __preparePassNodeForReplay( this.renderer, node );
				for ( const node of bloomNodes ) __prepareBloomNodeForReplay( node, context );
				artifact = __attachGraphTextureRefs( artifact, this.outputNode );
				artifact = __attachPassTextureRefs( artifact, passNode );
				artifact = __attachRTTTextureRefs( artifact, rttNodes );
				const mat = new Slim.PrecompiledMaterial( artifact );
				mat.needsUpdate = true;
				this._quadMesh.material = mat;
				// Set up _context so render() can access onBefore/onAfterRenderPipeline.
				context.onBeforeRenderPipeline = ( passNodes.length > 0 || rttNodes.length > 0 || bloomNodes.length > 0 ) ? () => {
						__renderPassNodesForPipeline( this.renderer, passNodes );
						__renderRTTNodesForPipeline( this.renderer, rttNodes );
						__renderBloomNodesForPipeline( this.renderer, bloomNodes );
					} : null;
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
	const exportList = [ ...unique, 'pass' ].join( ', ' );
	return `
// Import the FULL three.js TSL namespace via absolute URL so the replay
// import-map (which redirects 'three/webgpu' to the slim bundle) is bypassed.
import { TSL as __TSL } from '/build/three.webgpu.js';
import { PassNode as __ReplayPassNode } from '/__tslp__/slim-webgpu-replay.js';

// Re-expose every named TSL export so compute kernels (Fn, instancedArray, ...)
// receive genuine TSL node objects whose isComputeNode flag is set correctly.
${ consts }
${ reflectorShim }
const pass = ( scene, camera, options ) => new __ReplayPassNode( __ReplayPassNode.COLOR, scene, camera, options );
export { ${ exportList } };
// Also export the TSL namespace object for code that imports it directly.
export const TSL = __TSL;
`;

}

function inspectorStubModule() {

	return `
export class Inspector {
	constructor() { this.domElement = document.createElement( 'div' ); }
	setRenderer() {}
	init() {}
	begin() {}
	finish() {}
	beginRender() {}
	finishRender() {}
	beginCompute() {}
	finishCompute() {}
	inspect() {}
	copyFramebufferToTexture() {}
	copyTextureToTexture() {}
	createParameters() { const gui = { paramList: { domElement: { style: {} } }, add() { return this; }, addColor() { return this; }, addFolder() { return this; }, name() { return this; }, onChange() { return this; }, step() { return this; }, min() { return this; }, max() { return this; }, open() { return this; }, listen() { return this; } }; return gui; }
	add() {}
	remove() {}
	update() {}
	dispose() {}
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
		if ( url.pathname === '/examples/jsm/inspector/Inspector.js' ) return sendJs( res, inspectorStubModule() );
		if ( url.pathname === '/examples/jsm/libs/stats.module.js' ) return sendJs( res, statsStubModule() );
		if ( url.pathname === '/__tslp__/three.webgpu.slim.js' ) {

			res.setHeader( 'content-type', 'application/javascript; charset=utf-8' );
			res.end( await readFile( SLIM_BUNDLE ) );
			return;

		}

		if ( url.pathname.startsWith( '/__tslp_runtime/' ) ) {

			return sendFile( res, safeResolveUnder( RUNTIME_SRC, url.pathname.slice( '/__tslp_runtime/'.length ) ) );

		}
		if ( url.pathname.startsWith( '/__tslp_plugin/' ) ) {

			return sendFile( res, safeResolveUnder( PLUGIN_SRC, url.pathname.slice( '/__tslp_plugin/'.length ) ) );

		}

		const requestPath = decodeURIComponent( url.pathname );
		const filePath = resolve( threeRepo, '.' + requestPath );
		if ( ! normalize( filePath ).startsWith( normalize( threeRepo + '/' ) ) ) {

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
		if ( filePath.endsWith( '.html' ) && filePath.includes( '/examples/webgpu_' ) ) {

			const requestedMode = url.searchParams.get( '__tslp_mode' );
			const mode = requestedMode === 'replay' ? 'replay' : requestedMode === 'stock' ? 'stock' : 'capture';
			const example = requestPath.split( '/' ).pop();
			buf = Buffer.from( injectHtml( buf.toString( 'utf8' ), example, mode ) );

		}

		res.setHeader( 'access-control-allow-origin', '*' );
		res.setHeader( 'content-type', MIME[ extname( filePath ).toLowerCase() ] || 'application/octet-stream' );
		res.end( buf );

	} catch ( err ) {

		res.statusCode = 500;
		res.end( 'error: ' + ( err && err.message || err ) );

	}

} );

function sendJs( res, code ) {

	res.setHeader( 'access-control-allow-origin', '*' );
	res.setHeader( 'content-type', 'application/javascript; charset=utf-8' );
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
const SETTLE_FRAMES = parseInt( getArg( '--settle-frames=', '8' ), 10 );
const RENDER_POLL_MS = 400;
// Restart the browser more aggressively than wear-and-tear suggests because
// some examples (PMREM-heavy, large GLTF, postprocessing) corrupt the WebGPU
// state in a way that crashes the whole renderer process after 8–11 runs.
// Recreating proactively at 6 sidesteps the crash; the per-example catch
// below handles the residual case where a crash hits before we hit this cap.
const MAX_RUNS_PER_BROWSER = 6;

// Deterministic-time replay support. Animated examples driven by
// `setAnimationLoop` would otherwise sample different animation phases on
// stock/capture/replay. The default target tick is 0: take the first fully
// loaded, settled frame so per-frame mutations like `rotation += 0.005`
// cannot drift while assets and PMREM compile at different speeds. Use
// `--target-tick=60` when deliberately auditing a later animation phase.
// Real-time fetch / XHR are unaffected, so HDR / KTX2 / GLTF loaders still work.
const PRESENT_SETTLE_MS = parseInt( getArg( '--present-settle-ms=', '120' ), 10 );
const ASSET_SETTLE_MS = parseInt( getArg( '--asset-settle-ms=', '250' ), 10 );
const BRIGHT_POLL_MS = parseInt( getArg( '--bright-poll-ms=', '400' ), 10 );

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

function safeExampleName( name ) {

	return name.replace( /[^A-Za-z0-9_.-]/g, '_' );

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

/**
 * Compute PSNR (peak signal-to-noise ratio) between two PNG buffers.
 *
 * PSNR is the de-facto standard for screenshot regression — it scales with
 * actual per-pixel error rather than aggregate channel means, so a scene
 * that renders the right *average* colour but the wrong *shape* fails it.
 * Returns { psnr, width, height } where psnr is in dB (Infinity if identical),
 * or { error: <reason> } when the comparison can't be made.
 *
 * Both screenshots must share dimensions — divergent dimensions usually
 * indicate the canvas resized between capture and replay, which is itself
 * a regression.
 */
async function comparePSNR( page, captureShot, replayShot ) {

	if ( ! captureShot || ! replayShot ) return { error: 'missing screenshot' };
	return await page.evaluate( async ( [ a64, b64 ] ) => {

		const decode = async ( b64 ) => {

			const blob = await ( await fetch( 'data:image/png;base64,' + b64 ) ).blob();
			const bmp = await createImageBitmap( blob );
			const off = new OffscreenCanvas( bmp.width, bmp.height );
			const ctx = off.getContext( '2d' );
			ctx.drawImage( bmp, 0, 0 );
			return { width: bmp.width, height: bmp.height, data: ctx.getImageData( 0, 0, bmp.width, bmp.height ).data };

		};

		try {

			const a = await decode( a64 );
			const b = await decode( b64 );
			if ( a.width !== b.width || a.height !== b.height ) {

				return { error: `dim mismatch capture=${ a.width }x${ a.height } replay=${ b.width }x${ b.height }`, width: a.width, height: a.height };

			}

			let sumSq = 0;
			const px = a.data.length / 4;
			for ( let i = 0; i < a.data.length; i += 4 ) {

				const dr = a.data[ i ] - b.data[ i ];
				const dg = a.data[ i + 1 ] - b.data[ i + 1 ];
				const db = a.data[ i + 2 ] - b.data[ i + 2 ];
				sumSq += dr * dr + dg * dg + db * db;

			}

			const mse = sumSq / ( px * 3 );
			const psnr = mse === 0 ? Infinity : 10 * Math.log10( ( 255 * 255 ) / mse );
			return { psnr: psnr === Infinity ? 'inf' : +psnr.toFixed( 2 ), width: a.width, height: a.height };

		} catch ( err ) {

			return { error: err && err.message || String( err ) };

		}

	}, [ captureShot.toString( 'base64' ), replayShot.toString( 'base64' ) ] );

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
	page.on( 'pageerror', ( e ) => {

		const detail = String( e && ( e.stack || e.message ) || e );
		errors.push( detail );
		if ( process.env.TSLP_DEBUG_TORNADO ) console.error( `[page-error ${ mode }]`, detail );

	} );
	page.on( 'requestfailed', ( req ) => {

		if ( process.env.TSLP_DEBUG_TORNADO ) console.error( `[req-failed ${ mode }]`, req.url(), '->', req.failure() && req.failure().errorText );

	} );
	if ( process.env.TSLP_DEBUG_TORNADO_TRACE ) {
		page.on( 'response', async ( res ) => {

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

		} );
	}
	page.on( 'console', ( m ) => {

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

	} );

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
	const TARGET_TICK = Number.isFinite( targetTick ) ? Math.max( 0, targetTick | 0 ) : 0;
	const FRAME_STEP_MS = 16.6667;
	try {

		stepStartedAt = Date.now();
		// TEMP cloth diagnosis: enable runtime hydrator + harness storage-buffer logs.
		if ( name && name.includes( 'compute_cloth' ) && mode === 'replay' ) {
			await page.addInitScript( () => { globalThis.__TSLP_DBG_CLOTH = true; window.__TSLP_DBG_CLOTH = true; } );
		}
		await page.addInitScript( ( { step, base, freezeAt, quiescentMs, settleFrames } ) => {

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

			// Pending counters for async loaders (HDR/GLTF/MaterialX/Texture/...) and
			// in-flight renderer.compileAsync() promises. The Playwright wait gate
			// requires both === 0 (and 250 ms of quiescence) before screenshotting,
			// so capture doesn't fire mid-cascade for examples like
			// webgpu_loader_materialx that load 20+ assets sequentially.
			w.__tslpLoaderPending = 0;
			w.__tslpCompilePending = 0;
			w.__tslpLoaderLastBusyAt = 0;

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
					const realNow = ( typeof w.__tslpRealNow === 'function' ) ? w.__tslpRealNow() : 0;
					const quiescent = ( lastBusy === 0 ) || ( realNow && ( realNow - lastBusy ) >= quiescentMs );
					const allZero = ( w.__tslpLoaderPending | 0 ) === 0
						 && ( w.__tslpCompilePending | 0 ) === 0
						 && ( w.__tslpPmremPending | 0 ) === 0
						 && ( w.__tslpComputePending | 0 ) === 0;
					if ( quiescent && allZero ) {
						w.__tslpSettleTicks = ( w.__tslpSettleTicks | 0 ) + 1;
						if ( w.__tslpSettleTicks >= settleFrames ) w.__tslpFrozen = true;
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

			// Seed Math.random for deterministic particle/star-field positions.
			// Three's UUID generation also uses Math.random, but capture/replay build
			// different internal helper objects. Keep UUID entropy on a separate stream
			// so user-example random calls stay aligned across both modes.
			let _rngSeed = 42;
			let _uuidSeed = 0x9e3779b9;
			const _nextRng = ( seed ) => ( seed * 1664525 + 1013904223 ) >>> 0;
			w.Math.random = function () {

				let stack = '';
				try { stack = String( new Error().stack || '' ); } catch ( _ ) {}
				if ( stack.indexOf( 'generateUUID' ) !== -1 ) {
					_uuidSeed = _nextRng( _uuidSeed );
					return _uuidSeed / 4294967296;
				}
				_rngSeed = _nextRng( _rngSeed );
				return _rngSeed / 4294967296;

			};

		}, { step: FRAME_STEP_MS, base: 0, freezeAt: TARGET_TICK, quiescentMs: LOADER_QUIESCENT_MS, settleFrames: SETTLE_FRAMES } );
		mark( 'initScriptMs', stepStartedAt );

	} catch ( _ ) { /* older Playwright fallback */ }

	try {

		stepStartedAt = Date.now();
		await page.goto( `http://localhost:${ port }/examples/${ name }?__tslp_mode=${ mode }`, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS } );
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
				{ timeout: LOADER_TIMEOUT_MS },
			);
			mark( 'freezeWaitMs', stepStartedAt );

			// Brief settle so the GPU presents the frozen frame.
			stepStartedAt = Date.now();
			await new Promise( ( r ) => setTimeout( r, PRESENT_SETTLE_MS ) );
			mark( 'presentSettleMs', stepStartedAt );

		} catch ( _ ) {
			mark( 'freezeWaitMs', stepStartedAt );
			timings.freezeTimedOut = true;
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
		if ( mode === 'capture' ) {
			stepStartedAt = Date.now();
			await page.evaluate( async () => {
				if ( typeof window.__tslpFlushCaptureArtifacts === 'function' ) await window.__tslpFlushCaptureArtifacts();
			} );
			mark( 'flushCaptureMs', stepStartedAt );
		}
		const real = errors.filter( ( e ) => ! /favicon|Failed to load resource/i.test( e ) );
		const diagnostics = await page.evaluate( () => window.__tslpHarnessDiagnostics || null ).catch( () => null );
		timings.totalMs = Date.now() - startedAt;
		return { bright: finalBright, shot, errors: real.slice( 0, 5 ), warnings: warnings.slice( 0, 5 ), diagnostics, context, page, timings };

	} catch ( err ) {

		const diagnostics = await page.evaluate( () => window.__tslpHarnessDiagnostics || null ).catch( () => null );
		timings.totalMs = Date.now() - startedAt;
		return { bright: 0, shot: null, errors: [ err && err.message || String( err ) ], warnings: warnings.slice( 0, 5 ), diagnostics, navigationError: true, context, page, timings };

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

function mergeDiagnostics( ...items ) {

	const present = items.filter( Boolean );
	if ( present.length === 0 ) return null;
	const merged = { colorTransferFallbacks: {}, healedNullTextureImages: 0 };
	for ( const item of present ) {

		merged.healedNullTextureImages += item.healedNullTextureImages | 0;
		for ( const [ key, count ] of Object.entries( item.colorTransferFallbacks || {} ) ) {

			merged.colorTransferFallbacks[ key ] = ( merged.colorTransferFallbacks[ key ] || 0 ) + ( count | 0 );

		}

	}
	return merged;

}

async function runOne( browser, name ) {

	captures.delete( name );
	const capture = reuseReferenceShot
		? loadSavedReferenceShot( name )
		: await visitExample( browser, name, 'stock', captureWaitMs );
	await capture.context?.close().catch( () => {} );

	const artifactCapture = replayOnly
		? emptyVisitResult()
		: await visitExample( browser, name, 'capture', captureWaitMs );
	await artifactCapture.context?.close().catch( () => {} );

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
	const blockingCaptureErrors = captureErrors.filter( ( error ) => ! isIgnorableCaptureError( error ) );
	const blockingReplayErrors = replay.errors.filter( ( error ) => ! isIgnorableReplayError( error ) );

	let pixelMetrics;
	if ( capture.shot && replay.shot && capture.bright > 0.005 && replay.bright > 0.005 && replay.page ) {

		pixelMetrics = await comparePSNR( replay.page, capture.shot, replay.shot ).catch( ( err ) => ( { error: err && err.message || String( err ) } ) );

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
		writeFileSync( join( artifactsDir, `${ safe }.user.json` ), JSON.stringify( bucket.user, null, 2 ) );
		writeFileSync( join( artifactsDir, `${ safe }.aux.json` ), JSON.stringify( bucket.aux, null, 2 ) );

	}
	await replay.context.close().catch( () => {} );

	const pixelGate = pixelGateOf( pixelMetrics, psnrThreshold );
	const pixelGateOk = ! pixelGateEnabled || pixelGate.pass !== false;
	const pass = ( userCount > 0 || auxCount > 0 ) && blockingCaptureErrors.length === 0 && replay.bright > 0.005 && blockingReplayErrors.length === 0 && pixelGateOk;

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
		error: pass ? null : summarizeFailure( { userCount, blockingCaptureErrors, replayBright: replay.bright, blockingReplayErrors, pixelGate, pixelGateEnabled } ),
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
		/RenderPassEncoder .* already ended/.test( error );

}

function isIgnorableReplayError( error ) {

	return /Invalid ShaderModule/.test( error ) ||
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

let browser = await chromium.launch( { channel: 'chrome', headless: true, args: BROWSER_ARGS } ).catch( () => null );
if ( ! browser ) browser = await chromium.launch( { headless: true, args: BROWSER_ARGS } );

const report = { total: candidates.length, pass: 0, fail: 0, skip: allExamples.length - candidates.length, details: [] };
let runsSinceRestart = 0;

const reportPath = join( OUT, reportFile );

try {

	for ( let i = 0; i < candidates.length; i ++ ) {

		const name = candidates[ i ];
		const label = `[${ i + 1 }/${ candidates.length }] ${ name }`;

		try {

			if ( runsSinceRestart >= MAX_RUNS_PER_BROWSER ) {

				await browser.close().catch( () => {} );
				browser = await chromium.launch( { channel: 'chrome', headless: true, args: BROWSER_ARGS } ).catch( () => null );
				if ( ! browser ) browser = await chromium.launch( { headless: true, args: BROWSER_ARGS } );
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
				await browser.close().catch( () => {} );
				browser = await chromium.launch( { channel: 'chrome', headless: true, args: BROWSER_ARGS } ).catch( () => null );
				if ( ! browser ) browser = await chromium.launch( { headless: true, args: BROWSER_ARGS } );
				runsSinceRestart = 0;
			}

		}

	}

} finally {

	await browser.close().catch( () => {} );
	server.close();

}

writeFileSync( reportPath, JSON.stringify( report, null, 2 ) );

console.log( '\n═══ e2e summary ═══' );
console.log( `  ${ report.pass } pass, ${ report.fail } fail, ${ report.skip } skip, ${ report.total } candidates` );
console.log( `  report: ${ reportPath }` );
printFailureSummary( report.details );

process.exit( report.fail === 0 ? 0 : 1 );
