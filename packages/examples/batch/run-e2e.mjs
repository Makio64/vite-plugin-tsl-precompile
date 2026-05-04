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
 *   node packages/examples/batch/run-e2e.mjs --filter=ocean --port=8729 --port-retries=20
 *   node packages/examples/batch/run-e2e.mjs --filter=ocean --target-tick=60
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
const verboseConsole = args.includes( '--verbose' ) || process.env.TSLP_E2E_VERBOSE === '1' || !! process.env.TSLP_DEBUG_TORNADO_VERBOSE;
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
	const dbgInstance = mode === 'replay' && /instance_path/.test( example );
	const boot = `<script>window.__TSLP_E2E=${ jsonScriptLiteral( { example, mode, artifacts: bucket } ) };${ dbgInstance ? 'window.__TSLP_DBG_INSTANCE=true;' : '' }</script>`;
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

	const extraImports = [
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
const __postProcessingPipelines = new Set();
const __auxPromises = new Set();
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
	const n = ( __counts[ className ] || 0 ) + 1;
	__counts[ className ] = n;
	const name = __state.example + ':' + className + ':' + n;
	material.name = material.name || name;
	__seenMaterials.set( material, name );
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

function __classNameForMaterial( material ) {
	if ( ! material ) return 'Material';
	if ( material.isMeshBasicNodeMaterial || material.isMeshBasicMaterial ) return 'MeshBasicNodeMaterial';
	if ( material.isMeshPhysicalNodeMaterial || material.isMeshPhysicalMaterial ) return 'MeshPhysicalNodeMaterial';
	if ( material.isMeshStandardNodeMaterial || material.isMeshStandardMaterial ) return 'MeshStandardNodeMaterial';
	if ( material.isMeshLambertNodeMaterial || material.isMeshLambertMaterial ) return 'MeshLambertNodeMaterial';
	if ( material.isMeshPhongNodeMaterial || material.isMeshPhongMaterial ) return 'MeshPhongNodeMaterial';
	if ( material.isMeshToonNodeMaterial || material.isMeshToonMaterial ) return 'MeshToonNodeMaterial';
	if ( material.isMeshNormalNodeMaterial || material.isMeshNormalMaterial ) return 'MeshNormalNodeMaterial';
	if ( material.isMeshMatcapNodeMaterial || material.isMeshMatcapMaterial ) return 'MeshMatcapNodeMaterial';
	if ( material.isLineBasicNodeMaterial || material.isLineBasicMaterial ) return 'LineBasicNodeMaterial';
	if ( material.isPointsNodeMaterial || material.isPointsMaterial ) return 'PointsNodeMaterial';
	if ( material.isSpriteNodeMaterial || material.isSpriteMaterial ) return 'SpriteNodeMaterial';
	const type = material.type || '';
	if ( type === 'MeshBasicNodeMaterial' || type === 'MeshBasicMaterial' ) return 'MeshBasicNodeMaterial';
	if ( type === 'MeshPhysicalNodeMaterial' || type === 'MeshPhysicalMaterial' ) return 'MeshPhysicalNodeMaterial';
	if ( type === 'MeshStandardNodeMaterial' || type === 'MeshStandardMaterial' ) return 'MeshStandardNodeMaterial';
	if ( type === 'MeshLambertNodeMaterial' || type === 'MeshLambertMaterial' ) return 'MeshLambertNodeMaterial';
	if ( type === 'MeshPhongNodeMaterial' || type === 'MeshPhongMaterial' ) return 'MeshPhongNodeMaterial';
	if ( type === 'MeshToonNodeMaterial' || type === 'MeshToonMaterial' ) return 'MeshToonNodeMaterial';
	if ( type === 'MeshNormalNodeMaterial' || type === 'MeshNormalMaterial' ) return 'MeshNormalNodeMaterial';
	if ( type === 'MeshMatcapNodeMaterial' || type === 'MeshMatcapMaterial' ) return 'MeshMatcapNodeMaterial';
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
	if ( __renderer && __lastScene && __lastCamera ) {
		__trackAuxCapture( precompileAuxiliary( __renderer, __lastScene, __lastCamera, __auxOpts() ), 'aux capture' );
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
		__markSceneMaterials( scene );
		return typeof super.compile === 'function' ? super.compile( scene, camera, ...rest ) : undefined;
	}
	compileAsync( scene, camera, ...rest ) {
		if ( __pmremRunning > 0 ) return typeof super.compileAsync === 'function' ? super.compileAsync( scene, camera, ...rest ) : Promise.resolve();
		__lastScene = scene;
		__lastCamera = camera;
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
		const mat = __takeMaterial( ${ JSON.stringify( name ) } );
		if ( params && typeof params === 'object' ) {
			for ( const key in params ) {
				if ( params[ key ] !== undefined ) __assignParam( mat, key, params[ key ] );
			}
		}
		return mat;
	}
}` ).join( '\n' );

	return `
import * as Slim from '/__tslp__/three.webgpu.slim.js';
export * from '/__tslp__/three.webgpu.slim.js';

const __state = window.__TSLP_E2E || { example: 'unknown', artifacts: { user: {}, aux: [] } };
const __data = __state.artifacts || { user: {}, aux: [] };
const __counts = Object.create( null );
const __usedArtifactNames = new Set();
const __seenMaterials = new WeakMap();
const __hasBackgroundAux = Array.isArray( __data.aux ) && __data.aux.some( ( entry ) => entry && entry.shape === 'background' );
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
			const useFull = fullRenderer && fullRenderer !== slimRenderer && slimRenderer && slimRenderer.backend;
			if ( useFull ) this._renderer = fullRenderer;
			try {
				const target = orig.apply( this, args );
				if ( useFull && target && target.texture && target.texture.isTexture ) {
					__sharePMREMGPUTexture( slimRenderer, fullRenderer, target.texture );
					// Self-cache: __wireEnvironmentPMREM does __pmremCache.get(scene.environment)
					// where scene.environment IS this PMREM texture. Identity-map it so the
					// existing wiring path picks it up without needing a separate source key.
					__pmremCache.set( target.texture, target.texture );
				}
				return target;
			} finally {
				if ( useFull ) this._renderer = slimRenderer;
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
			const txData = tx.get( pmrem );
			txData.initialized = true;
			txData.version = pmrem.version;
			txData.generation = pmrem.version;
			// bindGroups tracks which bind-groups reference this texture for
			// invalidation on update. Must be a Set; created empty since we're
			// registering the texture as already uploaded.
			if ( ! txData.bindGroups ) txData.bindGroups = new Set();
		}
	} catch ( shareErr ) {
		console.warn( '[tslp-e2e] PMREM GPU share failed:', shareErr && shareErr.message || shareErr );
	}
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
					if ( tex && tex.isTexture ) Slim.registerLiveTexture( tex );
				}
			};
			const tex = origLoad.call( this, url, wrappedOnLoad, onProgress, onError );
			if ( tex && tex.isTexture ) {
				if ( ! tex.name && typeof url === 'string' ) tex.name = url.split( '/' ).pop().split( '?' )[ 0 ];
				Slim.registerLiveTexture( tex );
			}
			return tex;
		};
	}
} )();

function __nodeStub() {
	const fn = function tslReplayNodeStub() { return proxy; };
	const proxy = new Proxy( fn, {
		get( _target, prop ) {
			if ( prop === Symbol.toPrimitive ) return () => 0;
			if ( prop === 'then' ) return undefined;
			if ( prop === 'isNode' ) return true;
			if ( prop === 'toVar' ) return () => proxy;
			return proxy;
		},
		apply() { return proxy; },
		construct() { return proxy; },
	} );
	return proxy;
}

function __seedNodeProps( material ) {
	const stub = __nodeStub();
	for ( const key of [ 'colorNode', 'normalNode', 'positionNode', 'outputNode', 'roughnessNode', 'metalnessNode', 'emissiveNode', 'opacityNode', 'alphaTestNode' ] ) {
		if ( material[ key ] === undefined ) material[ key ] = stub;
	}
}

// Collect StorageBufferNode.value attributes by walking a node tree via traverse().
// Only picks up nodes with isStorageBufferNode to avoid vertex-attribute nodes
// (BufferAttributeNode wrapping storage) — those are handled separately.
function __collectStorageBufAttrs( rootNode, results ) {
	if ( ! rootNode || typeof rootNode.traverse !== 'function' ) return;
	rootNode.traverse( ( n ) => {
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
	if ( typeof rootNode.traverse !== 'function' ) return;
	rootNode.traverse( ( n ) => {
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

function __takeMaterial( className, sourceMaterial = null ) {
	const n = ( __counts[ className ] || 0 ) + 1;
	__counts[ className ] = n;
	let name = __state.example + ':' + className + ':' + n;
	let mod = __data.user && __data.user[ name ];
	if ( ! mod || ! mod.artifact ) {
		const allKeys = Object.keys( __data.user || {} );
		const unusedKeys = allKeys.filter( ( key ) => ! __usedArtifactNames.has( key ) );
		const type = sourceMaterial && sourceMaterial.type || '';
		const typeNeedle = type.replace( /Material$/, 'NodeMaterial' );
		const findType = ( keys ) => keys.find( ( key ) => typeNeedle && key.includes( ':' + typeNeedle + ':' ) );
		const findCompatible = ( keys ) => keys.find( ( key ) => /:(MeshBasic|MeshLambert|MeshStandard)NodeMaterial:/.test( key ) );
		const findClass = ( keys ) => keys.find( ( key ) => key.includes( ':' + className + ':' ) );
		const fallbackName = findType( unusedKeys ) || findType( allKeys ) ||
			( className === 'Line2NodeMaterial' ? findCompatible( unusedKeys ) || findCompatible( allKeys ) : null ) ||
			findClass( unusedKeys ) || findClass( allKeys ) ||
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
	const material = new Slim.PrecompiledMaterial( mod.artifact );
	material.name = name;
	__seedNodeProps( material );
	return material;
}

function __classNameForMaterial( material ) {
	if ( ! material ) return 'Material';
	if ( material.isMeshBasicNodeMaterial || material.isMeshBasicMaterial ) return 'MeshBasicNodeMaterial';
	if ( material.isMeshPhysicalNodeMaterial || material.isMeshPhysicalMaterial ) return 'MeshPhysicalNodeMaterial';
	if ( material.isMeshStandardNodeMaterial || material.isMeshStandardMaterial ) return 'MeshStandardNodeMaterial';
	if ( material.isMeshLambertNodeMaterial || material.isMeshLambertMaterial ) return 'MeshLambertNodeMaterial';
	if ( material.isMeshPhongNodeMaterial || material.isMeshPhongMaterial ) return 'MeshPhongNodeMaterial';
	if ( material.isMeshToonNodeMaterial || material.isMeshToonMaterial ) return 'MeshToonNodeMaterial';
	if ( material.isMeshNormalNodeMaterial || material.isMeshNormalMaterial ) return 'MeshNormalNodeMaterial';
	if ( material.isMeshMatcapNodeMaterial || material.isMeshMatcapMaterial ) return 'MeshMatcapNodeMaterial';
	if ( material.isLineBasicNodeMaterial || material.isLineBasicMaterial ) return 'LineBasicNodeMaterial';
	if ( material.isPointsNodeMaterial || material.isPointsMaterial ) return 'PointsNodeMaterial';
	if ( material.isSpriteNodeMaterial || material.isSpriteMaterial ) return 'SpriteNodeMaterial';
	const type = material.type || '';
	if ( type === 'MeshBasicNodeMaterial' || type === 'MeshBasicMaterial' ) return 'MeshBasicNodeMaterial';
	if ( type === 'MeshPhysicalNodeMaterial' || type === 'MeshPhysicalMaterial' ) return 'MeshPhysicalNodeMaterial';
	if ( type === 'MeshStandardNodeMaterial' || type === 'MeshStandardMaterial' ) return 'MeshStandardNodeMaterial';
	if ( type === 'MeshLambertNodeMaterial' || type === 'MeshLambertMaterial' ) return 'MeshLambertNodeMaterial';
	if ( type === 'MeshPhongNodeMaterial' || type === 'MeshPhongMaterial' ) return 'MeshPhongNodeMaterial';
	if ( type === 'MeshToonNodeMaterial' || type === 'MeshToonMaterial' ) return 'MeshToonNodeMaterial';
	if ( type === 'MeshNormalNodeMaterial' || type === 'MeshNormalMaterial' ) return 'MeshNormalNodeMaterial';
	if ( type === 'MeshMatcapNodeMaterial' || type === 'MeshMatcapMaterial' ) return 'MeshMatcapNodeMaterial';
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
	for ( const key of [ 'colorNode', 'normalNode', 'positionNode', 'outputNode', 'roughnessNode', 'metalnessNode', 'emissiveNode', 'opacityNode', 'alphaTestNode', 'vertexNode' ] ) {
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
	for ( const key of __TEXTURE_PROPS ) {
		const tex = sourceMaterial[ key ];
		if ( tex && tex.isTexture ) __attachArtifactTextureRefsWhere( artifact, tex, ( source ) => ! __isPMREMArtifactTextureSource( source ) );
	}
}

function __isPMREMArtifactTextureSource( source ) {
	return !! ( source && source.kind === 'artifact.texture' && ( source.mapping === 306 || source.textureName === 'PMREM.cubeUv' ) );
}

function __attachArtifactTextureRefsWhere( artifact, texture, predicate ) {
	if ( ! artifact || ! texture || ! texture.isTexture || typeof predicate !== 'function' ) return artifact;
	const refs = artifact._textureRefs instanceof Map ? new Map( artifact._textureRefs ) : new Map();
	let changed = false;
	for ( const group of artifact.uniformPlan || [] ) {
		for ( const entry of group.textures || [] ) {
			const source = entry && entry.source || {};
			if ( source.kind !== 'artifact.texture' || ! source.textureUuid ) continue;
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
	return artifact;
}

const __wiredPCMaterials = new WeakSet();

function __replaceSceneMaterials( scene ) {
	if ( ! scene || typeof scene.traverse !== 'function' ) return;
	scene.traverse( ( object ) => {
		const material = object && object.material;
		if ( ! material ) return;
		const replaceOne = ( m ) => {
			if ( ! m ) return m;
			// Materials intercepted at constructor time come back as PrecompiledMaterial
			// directly. Wire live compute attributes (positionNode, colorNode...) into
			// the artifact plan entries now — before hydrateNodeBuilderState is first
			// called in the upcoming super.render.
			if ( m.isPrecompiledMaterial ) {
				if ( m.precompiledArtifact && ! __wiredPCMaterials.has( m ) ) {
					__wireComputeAttrsToArtifact( m.precompiledArtifact, m );
					__wiredPCMaterials.add( m );
				}
				return m;
			}
			if ( m.visible === false ) return m;
			if ( __seenMaterials.has( m ) ) return __seenMaterials.get( m );
			const className = __classNameForMaterial( m );
			const replacement = __takeMaterial( className, m );
			__copyMaterialProps( m, replacement );
			__copyMaterialNodeProps( m, replacement );
			__wireMaterialTextures( m, replacement );
			__seenMaterials.set( m, replacement );
			return replacement;
		};
		object.material = Array.isArray( material ) ? material.map( replaceOne ) : replaceOne( material );
	} );
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
function __findTextureInNode( node, depth = 0, seen = new Set() ) {
	if ( ! node || depth > 6 || seen.has( node ) ) return null;
	seen.add( node );
	if ( node.isTexture ) return node;
	for ( const key of [ 'value', '_value', 'texture', '_texture' ] ) {
		const v = node[ key ];
		if ( v && v.isTexture ) return v;
	}
	for ( const key of [ 'node', 'aNode', 'bNode', 'uvNode', 'levelNode', 'sourceNode' ] ) {
		const child = node[ key ];
		if ( child ) {
			const found = __findTextureInNode( child, depth + 1, seen );
			if ( found ) return found;
		}
	}
	return null;
}

// Captured before scene.backgroundNode is replaced by __prepareSceneForReplay.
// Holds the user's source cubemap when the example uses scene.backgroundNode =
// pmremTexture(map, ...) (or similar) without ever assigning scene.background.
let __capturedBackgroundSource = null;

// Tracks the last texture wired into each background artifact's _textureRefs
// so we only invalidate the cached background material (and the renderer's
// quad cache) when the source actually changes — typically when an async
// CubeTextureLoader / TextureLoader resolves AFTER the first render has
// already cached bindings against fallbackCubeTexture.
const __lastWiredBgTex = new WeakMap();

// True iff a Texture's pixel source has actually arrived from its async loader.
// CubeTexture: image is a 6-element array of HTMLImageElement / ImageBitmap.
// 2D textures: image is a single HTMLImageElement / ImageBitmap / HTMLCanvasElement.
// DataTexture: image carries .data (typed array) — these are sync, always ready.
// HDR / equirect via RGBELoader / TextureLoader: image is set on onLoad.
function __textureImageReady( texture ) {
	if ( ! texture || ! texture.isTexture ) return false;
	const img = texture.image;
	if ( img === null || img === undefined ) return false;
	if ( Array.isArray( img ) ) {
		if ( img.length === 0 ) return false;
		for ( const face of img ) if ( ! face ) return false;
		return true;
	}
	// DataTexture / Data3DTexture / RenderTargetTexture: synchronous shape.
	return true;
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
		};
	}
	return diag.pmrem;
}

function __healTextureImage( texture ) {
	if ( ! texture || ! texture.isTexture ) return;
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

function __wireBackgroundTextures( scene, renderer ) {
	const auxList = Array.isArray( __data.aux ) ? __data.aux : [];
	// Pick a source cubemap: prefer scene.background (legacy path) but fall
	// back to a node-graph-recovered source for the backgroundNode-only path
	// (e.g. webgpu_pmrem_cubemap.html does scene.backgroundNode = pmremTexture(map)
	// and never sets scene.background).
	let sourceTex = ( scene && scene.background && scene.background.isTexture ) ? scene.background : null;
	if ( ! sourceTex && __capturedBackgroundSource && __capturedBackgroundSource.isTexture ) {
		sourceTex = __capturedBackgroundSource;
	}
	if ( ! sourceTex ) return;
	// Guard: if the texture is async-loading (CubeTextureLoader, RGBELoader,
	// TextureLoader) and its image hasn't arrived yet, skip wiring. Otherwise
	// three.js's Textures.updateTexture → getTransfer( image ) throws when
	// image is undefined, leaving the sky quad rendering fallback white forever
	// (the cached bind group sticks to whatever was wired on first render).
	// On the next frame after the loader resolves, the WeakMap lookup is still
	// undefined for this artifact, so the wire fires fresh with image populated.
	// CubeTexture image is an array of 6; consider it ready only if all six are present.
	if ( ! __textureImageReady( sourceTex ) ) return;
	let texToWire = sourceTex;
	if ( __backgroundNeedsPMREM ) {
		const cached = __pmremCache.get( sourceTex );
		if ( cached && cached.isTexture ) texToWire = cached;
	}
	let changed = false;
	for ( const entry of auxList ) {
		if ( entry && entry.shape === 'background' && entry.artifact ) {
			if ( __lastWiredBgTex.get( entry.artifact ) !== texToWire ) {
				Slim.attachArtifactTextureRefs( entry.artifact, texToWire );
				__lastWiredBgTex.set( entry.artifact, texToWire );
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
const __pmremWiredArtifacts = new WeakSet(); // artifacts already wired
let __pmremNoRendererWarned = false;  // dedup the global "no compute renderer" warning

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
		const target = sourceTex.isCubeTexture
			? gen.fromCubemap( sourceTex )
			: gen.fromEquirectangular( sourceTex );
		const pmrem = target && target.texture || null;
		gen.dispose && gen.dispose();
		if ( pmrem && pmrem.isTexture ) {
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

function __wireEnvironmentPMREM( renderer, scene ) {
	if ( ! renderer || ! scene ) return;
	__pmremDiagnostics().wireCalls ++;
	const sceneEnvPmrem = ( scene.environment && scene.environment.isTexture )
		? __pmremCache.get( scene.environment )
		: null;
	let wiredCount = 0;
	scene.traverse( ( object ) => {
		const mat = object && object.material;
		const list = Array.isArray( mat ) ? mat : mat ? [ mat ] : [];
		for ( const m of list ) {
			if ( m && m.isPrecompiledMaterial && m.precompiledArtifact ) {
				const artifact = m.precompiledArtifact;
				if ( ! __pmremWiredArtifacts.has( artifact ) ) {
					// Prefer per-material envMap PMREM (set by examples that pass
					// envMap via constructor params), fall back to scene.environment.
					const matEnv = m.envMap && m.envMap.isTexture ? m.envMap : null;
					const matPmrem = matEnv ? __pmremCache.get( matEnv ) : null;
					const pmrem = matPmrem || sceneEnvPmrem;
					if ( ! pmrem ) {
						if ( __artifactNeedsPMREM( artifact ) ) __pmremDiagnostics().wireNoPmrem ++;
						continue;
					}
					__pmremWiredArtifacts.add( artifact ); // mark checked regardless
					const needsPmrem = __artifactNeedsPMREM( artifact );
					if ( needsPmrem ) {
						__pmremDiagnostics().wireNeedsPmrem ++;
						__attachArtifactTextureRefsWhere( artifact, pmrem, __isPMREMArtifactTextureSource );
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
					}
				} else {
					__pmremDiagnostics().wireAlreadyWired ++;
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
	if ( ! slimRenderer || ! sourceTex || ! sourceTex.isTexture ) return;
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
		if ( tex && tex.isTexture ) {
			__healTextureImage( tex );
			Slim.registerLiveTexture( tex );
		}
	};
	if ( scene.background && scene.background.isTexture ) visit( scene.background );
	if ( scene.environment && scene.environment.isTexture ) visit( scene.environment );
	scene.traverse( ( object ) => {
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
	// falls through the legacy branches).  We therefore:
	//   • If __hasBackgroundAux: replace the live TSL graph with a stub proxy
	//     so Background.js enters its isNode branch.  hashNodeGraphSync detects
	//     the stub-proxy shape and returns the sentinel hash; loadAux's shape-
	//     fallback then returns the single registered background artifact.
	//   • If no background aux: null out backgroundNode so Background.js falls
	//     through to the renderer's clear-color path (old behaviour).
	// Color backgrounds are left intact in both cases — they use the clear-
	// color path and bypass loadAux entirely.
	if ( scene ) {
		// Recover the source texture from scene.backgroundNode BEFORE we replace
		// it with a stub, so the PMREM wiring path can reach it later. Examples
		// like webgpu_pmrem_cubemap.html only set scene.backgroundNode (a real
		// PMREMNode in e2e mode); without this, the cubemap reference is lost.
		if ( __hasBackgroundAux && scene.backgroundNode ) {
			const recovered = __findTextureInNode( scene.backgroundNode );
			if ( recovered ) __capturedBackgroundSource = recovered;
		}
		if ( __hasBackgroundAux ) {
			// Replace with a stub so Background.js enters the isNode branch and
			// calls loadAux, which will shape-fallback to the captured artifact.
			scene.backgroundNode = __nodeStub();
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

function __buildShadowScene( userScene ) {
	if ( ! __fullThreeMod ) return null;
	// MeshLambertNodeMaterial samples lights and shadows — without a shadow-
	// sampling material in the scene, three.js's NodeBuilder skips ShadowNode
	// setup and light.shadow.map never allocates. Lambert is the cheapest
	// PCF-shadow-aware material we can stand-in for.
	const { Scene: FullScene, Mesh: FullMesh, MeshLambertNodeMaterial } = __fullThreeMod;
	if ( ! FullScene || ! FullMesh || ! MeshLambertNodeMaterial ) return null;
	const StandinMaterial = MeshLambertNodeMaterial;
	const shadowScene = new FullScene();
	const lightPairs = []; // { src, clone } so we can refresh transforms each render
	const meshPairs = []; // { src, clone } so we can refresh transforms each render
	let meshCount = 0;
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
						if ( typeof o.shadow.camera.left === 'number' ) cloned.shadow.camera.left = o.shadow.camera.left;
						if ( typeof o.shadow.camera.right === 'number' ) cloned.shadow.camera.right = o.shadow.camera.right;
						if ( typeof o.shadow.camera.top === 'number' ) cloned.shadow.camera.top = o.shadow.camera.top;
						if ( typeof o.shadow.camera.bottom === 'number' ) cloned.shadow.camera.bottom = o.shadow.camera.bottom;
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
			const standin = new FullMesh( o.geometry, new StandinMaterial() );
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
				if ( o.material.alphaTest ) standin.material.alphaTest = o.material.alphaTest;
				if ( o.material.alphaMap ) standin.material.alphaMap = o.material.alphaMap;
				if ( o.material.transparent ) standin.material.transparent = true;
			}
			shadowScene.add( standin );
			meshPairs.push( { src: o, clone: standin } );
			meshCount ++;
		}
	} );
	if ( meshCount === 0 || lightCount === 0 ) return null;
	shadowScene.__lightPairs = lightPairs;
	shadowScene.__meshPairs = meshPairs;
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
// (lights+meshes) count used to detect scene growth (e.g. async glTF load adds
// the dragons after the first render). When the count changes we rebuild and
// re-kick so the new geometry casts shadows too.
const __shadowState = new WeakMap(); // userScene -> { inflight, signature }
function __sceneSignature( scene ) {
	if ( ! scene || typeof scene.traverse !== 'function' ) return '';
	let lights = 0, meshes = 0;
	scene.traverse( ( o ) => {
		if ( ! o ) return;
		if ( o.isLight === true && o.castShadow === true && o.shadow ) lights ++;
		else if ( ( o.isMesh === true || o.isSkinnedMesh === true ) && o.geometry && ( o.castShadow === true || o.receiveShadow === true ) ) meshes ++;
	} );
	return lights + ':' + meshes;
}
function __kickShadowRenderAsync( slimRenderer, userScene, camera ) {
	if ( ! userScene || ! camera ) return;
	const sig = __sceneSignature( userScene );
	if ( sig === '' || sig.startsWith( '0:' ) || sig.endsWith( ':0' ) ) return;
	let st = __shadowState.get( userScene );
	if ( ! st ) { st = { inflight: false, signature: '' }; __shadowState.set( userScene, st ); }
	if ( st.inflight ) return;
	if ( st.signature === sig ) return; // already populated for this configuration
	// New or grown scene: discard cached shadow-scene so __buildShadowScene
	// re-walks and picks up the freshly-added meshes (e.g. glTF children).
	__shadowSceneCache.delete( userScene );
	st.inflight = true;
	st.signature = sig;
	window.__tslpShadowPending = ( window.__tslpShadowPending | 0 ) + 1;
	const _slimRenderer = slimRenderer;
	const _userScene = userScene;
	const _camera = camera;
	__getComputeRenderer( slimRenderer ).then( async ( fullRenderer ) => {
		if ( ! fullRenderer ) return;
		const shadowScene = __getOrBuildShadowScene( _userScene );
		if ( ! shadowScene ) return;
		__refreshShadowScene( _userScene, shadowScene );
		// Match the slim renderer's shadow-map type so PCF vs VSM matches.
		try {
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
			await fullRenderer.render( shadowScene, _camera );
			// Second render: the first render may have only built+queued shadow node
			// setup; allocations happen during ShadowNode.updateBefore which fires
			// from the SECOND render once nodeFrame.frameId advances.
			await fullRenderer.render( shadowScene, _camera );
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
					const depthTex = src.shadow.map.depthTexture;
					if ( depthTex ) {
						const fullData = fullRenderer.backend.get( depthTex );
						const slimData = _slimRenderer.backend.get( depthTex );
						if ( fullData && fullData.texture && slimData && ! slimData.texture ) {
							slimData.texture = fullData.texture;
							slimData.format = fullData.format;
							slimData.initialized = true;
							slimData.version = depthTex.version;
							slimData.generation = ( slimData.generation || 0 ) + 1;
							if ( ! slimData.bindGroups ) slimData.bindGroups = new Set();
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
		// After shadow map is populated, force one extra slim render so the
		// rebinder sees the live depthTexture and the shadow shows up.
		if ( window.__tslpFrozen ) {
			try { _slimRenderer.render( _userScene, _camera ); } catch ( e ) { console.warn( '[tslp-shadow] forced re-render failed:', e && e.message || e ); }
		}
	} );
}

export class WebGPURenderer extends Slim.WebGPURenderer {
	async init() {
		const r = await super.init();
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
		// Wire PMREM from sync cache BEFORE compile so hydration sees the live
		// prefiltered texture. (Async gen is kicked from render(); compile is
		// typically called only when the app pre-warms shaders, so skip kick.)
		__wireEnvironmentPMREM( this, scene );
		return typeof super.compile === 'function' ? super.compile( scene, camera, ...rest ) : undefined;
	}
	compileAsync( scene, camera, ...rest ) {
		if ( __pmremRunning > 0 ) return typeof super.compileAsync === 'function' ? super.compileAsync( scene, camera, ...rest ) : Promise.resolve();
		__prepareSceneForReplay( scene, this );
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
		// Wire PMREM from sync cache BEFORE super.render so that hydration
		// (which runs inside super.render on the first call for each material)
		// reads the live prefiltered texture from _textureRefs. Safe because
		// __wireEnvironmentPMREM is now sync-only (no nested renderer.render calls).
		__wireEnvironmentPMREM( this, scene );
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
		const _envTex = scene && scene.environment;
		if ( _envTex && _envTex.isTexture ) {
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
					if ( ! env || ! env.isTexture || _seen.has( env ) ) continue;
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
		const _bgFromScene = ( scene && scene.background && scene.background.isTexture &&
			( scene.background.isCubeTexture || scene.background.mapping === 301 ) )
			? scene.background : null;
		const _bgFromCaptured = ( __capturedBackgroundSource && __capturedBackgroundSource.isTexture &&
			( __capturedBackgroundSource.isCubeTexture || __capturedBackgroundSource.mapping === 301 ) )
			? __capturedBackgroundSource : null;
		const _bgSource = _bgFromScene || _bgFromCaptured;
		if ( _bgSource && __backgroundNeedsPMREM ) {
			__kickPMREMGenAsync( _renderer, _bgSource, ( pmrem ) => {
				const auxList = Array.isArray( __data.aux ) ? __data.aux : [];
				for ( const entry of auxList ) {
					if ( entry && entry.shape === 'background' && entry.artifact ) {
						__attachArtifactTextureRefsWhere( entry.artifact, pmrem, __isPMREMArtifactTextureSource );
					}
				}
				// Clear renderer's internal quad cache so Background.js re-creates
				// its PrecompiledMaterial with fresh _textureRefs on next frame.
				if ( _renderer._quadCache ) _renderer._quadCache.clear();
				if ( window.__tslpFrozen ) {
					try { _renderer.render( _scene, _camera ); } catch ( _ ) {}
				}
			} );
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
				const artifact = Slim.loadAux( 'render-output', 'tslp-e2e-bypass' );
				const mat = new Slim.PrecompiledMaterial(
					Slim.attachArtifactTextureRefs( artifact, target.texture )
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
				// Shape-fallback: returns any registered post-process artifact.
				const artifact = Slim.loadAux( 'post-process', 'tslp-e2e-bypass' );
				const mat = new Slim.PrecompiledMaterial( artifact );
				mat.needsUpdate = true;
				this._quadMesh.material = mat;
				// Set up _context so render() can access onBefore/onAfterRenderPipeline.
				this._context = {
					renderPipeline: this,
					onBeforeRenderPipeline: null,
					onAfterRenderPipeline: null,
				};
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
	const unique = Array.from( new Set( names ) ).filter( ( name ) => /^[A-Za-z_$][\w$]*$/.test( name ) );
	const consts = unique.map( ( name ) => `const ${ name } = __TSL[ '${ name }' ];` ).join( '\n' );
	const exportList = unique.join( ', ' );
	return `
// Import the FULL three.js TSL namespace via absolute URL so the replay
// import-map (which redirects 'three/webgpu' to the slim bundle) is bypassed.
import { TSL as __TSL } from '/build/three.webgpu.js';

// Re-expose every named TSL export so compute kernels (Fn, instancedArray, ...)
// receive genuine TSL node objects whose isComputeNode flag is set correctly.
${ consts }
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

		const filePath = resolve( threeRepo, '.' + url.pathname );
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
			const example = url.pathname.split( '/' ).pop();
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
const SETTLE_FRAMES = 30;
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
const FRAME_TIME_MS = 1000;
const ASSET_SETTLE_MS = 1500;

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

	const deadline = Date.now() + timeoutMs;
	let bright = 0;
	while ( Date.now() < deadline ) {

		bright = await canvasBrightFractionInPage( page );
		if ( bright > 0.005 ) break;
		await new Promise( ( r ) => setTimeout( r, RENDER_POLL_MS ) );

	}
	return +bright.toFixed( 4 );

}

async function visitExample( browser, name, mode, waitMs ) {

	const context = await browser.newContext( { viewport: { width: 640, height: 480 } } );
	const page = await context.newPage();
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

		// TEMP debug flag — fires hydrator console logs only for instance_path replay.
		if ( name && name.includes( 'instance_path' ) && mode === 'replay' ) {
			await page.addInitScript( () => { globalThis.__TSLP_DBG_INSTANCE = true; } );
		}
		// TEMP cloth diagnosis: enable runtime hydrator + harness storage-buffer logs.
		if ( name && name.includes( 'compute_cloth' ) && mode === 'replay' ) {
			await page.addInitScript( () => { globalThis.__TSLP_DBG_CLOTH = true; window.__TSLP_DBG_CLOTH = true; } );
		}
		await page.addInitScript( ( { step, base, freezeAt, quiescentMs, settleFrames } ) => {

			// eslint-disable-next-line no-undef
			const w = window;
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
						 && ( w.__tslpComputePending | 0 ) === 0
						 && ( w.__tslpShadowPending | 0 ) === 0;
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
						const val = Reflect.get( target, prop, receiver );
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

			// Seed Math.random for deterministic particle/star-field
			// positions — capture and replay must produce identical geometry.
			let _rngSeed = 42;
			w.Math.random = function () {

				_rngSeed = ( _rngSeed * 1664525 + 1013904223 ) >>> 0;
				return _rngSeed / 4294967296;

			};

		}, { step: FRAME_STEP_MS, base: 0, freezeAt: TARGET_TICK, quiescentMs: LOADER_QUIESCENT_MS, settleFrames: SETTLE_FRAMES } );

	} catch ( _ ) { /* older Playwright fallback */ }

	try {

		await page.goto( `http://localhost:${ port }/examples/${ name }?__tslp_mode=${ mode }`, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS } );

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
		const bright = await waitForFrame( page, mode === 'capture' ? RENDER_TIMEOUT_MS : Math.max( waitMs, RENDER_TIMEOUT_MS ) );

		// Additional real-time settle so aux capture (Promise chains)
		// and post-init scene mutations have time to complete.
		await new Promise( ( r ) => setTimeout( r, ASSET_SETTLE_MS ) );

		// Wait until the init-script rAF wrapper reaches TARGET_TICK and
		// self-freezes. The freeze happens
		// atomically inside the wrapper (no Playwright round-trip race),
		// so stock/capture/replay screenshot the same settled animation phase.
		try {

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

			// Brief settle so the GPU presents the frozen frame.
			await new Promise( ( r ) => setTimeout( r, FRAME_TIME_MS ) );

		} catch ( _ ) { /* tick counter may not have advanced (no animation loop) */ }

		const shot = await dumpCanvas( page );
		// Re-measure bright from the final screenshot PNG — WebGPU canvas pixels
		// are often not readable via 2D-context drawImage during the animation loop
		// (the compositing pipeline lags), so the waitForFrame poll may see 0 even
		// when the canvas has content. The Playwright screenshot always captures the
		// composited frame, so computing brightness from it gives the true value.
		const shotBright = shot ? await brightFraction( page, shot ) : 0;
		const finalBright = Math.max( bright, shotBright );
		if ( mode === 'capture' ) {
			await page.evaluate( async () => {
				if ( typeof window.__tslpFlushCaptureArtifacts === 'function' ) await window.__tslpFlushCaptureArtifacts();
			} );
		}
		const real = errors.filter( ( e ) => ! /favicon|Failed to load resource/i.test( e ) );
		const diagnostics = await page.evaluate( () => window.__tslpHarnessDiagnostics || null ).catch( () => null );
		return { bright: finalBright, shot, errors: real.slice( 0, 5 ), warnings: warnings.slice( 0, 5 ), diagnostics, context, page };

	} catch ( err ) {

		const diagnostics = await page.evaluate( () => window.__tslpHarnessDiagnostics || null ).catch( () => null );
		return { bright: 0, shot: null, errors: [ err && err.message || String( err ) ], warnings: warnings.slice( 0, 5 ), diagnostics, navigationError: true, context, page };

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
	const capture = await visitExample( browser, name, 'stock', captureWaitMs );
	await capture.context.close().catch( () => {} );
	const artifactCapture = await visitExample( browser, name, 'capture', captureWaitMs );
	await artifactCapture.context.close().catch( () => {} );
	const bucket = captureBucket( name );
	const userCount = Object.keys( bucket.user ).length;
	const auxCount = bucket.aux.length;
	const artifactSummaries = summarizeArtifacts( bucket );
	const auxSummaries = summarizeAuxArtifacts( bucket );

	const replay = await visitExample( browser, name, 'replay', replayWaitMs );
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
		const safe = name.replace( /[^A-Za-z0-9_.-]/g, '_' );
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

	return /Invalid ShaderModule/.test( error );

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
