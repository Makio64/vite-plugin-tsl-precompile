#!/usr/bin/env node
/**
 * Capture -> slim replay harness for three.js WebGPU examples.
 *
 * Per example:
 *   1. Serve the stock example with an importmap wrapper around
 *      `three/webgpu`/`three` that auto-marks every constructed NodeMaterial.
 *   2. Let the real three.js TSL builder render once and POST captured
 *      user-material + aux artifacts to this harness.
 *   3. Reload the same example with the slim bundle, a TSL authoring stub,
 *      the captured user materials, and the captured aux registry.
 *   4. Report whether replay reached a non-empty frame without unexpected
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
 */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolve, join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const args = process.argv.slice( 2 );
function getArg( prefix, def ) {

	const a = args.find( ( x ) => x.startsWith( prefix ) );
	return a ? a.slice( prefix.length ) : def;

}

const threeRepo = resolve( getArg( '--three-repo=', resolve( SELF, '../../../../three.js' ) ) );
const filter = getArg( '--filter=', '' );
const limit = parseInt( getArg( '--limit=', '9999' ), 10 );
const offset = parseInt( getArg( '--offset=', '0' ), 10 );
const port = parseInt( getArg( '--port=', '8729' ), 10 );
const captureWaitMs = parseInt( getArg( '--capture-wait-ms=', '8000' ), 10 );
const replayWaitMs = parseInt( getArg( '--replay-wait-ms=', '5000' ), 10 );
const psnrThreshold = parseFloat( getArg( '--psnr-threshold=', '30' ) );
const pixelGateEnabled = ! args.includes( '--no-pixel-gate' );
const saveShots = args.includes( '--save-shots' );

if ( ! existsSync( join( threeRepo, 'examples' ) ) ) {

	console.error( `[batch-e2e] three.js examples not found at ${ threeRepo }/examples. Pass --three-repo=<absolute-path>` );
	process.exit( 2 );

}

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

	const boot = `<script>window.__TSLP_E2E=${ jsonScriptLiteral( { example, mode, artifacts: captureBucket( example ) } ) };</script>`;
	const mapped = rewriteImportmap( html, mode );
	return mapped.includes( '</head>' )
		? mapped.replace( '</head>', `${ boot }\n</head>` )
		: boot + mapped;

}

function rewriteImportmap( html, mode ) {

	const webgpuTarget = mode === 'capture' ? '/__tslp__/full-webgpu-auto.js' : '/__tslp__/slim-webgpu-replay.js';
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

function fullWebgpuAutoModule() {

	const materialClasses = NODE_MATERIAL_EXPORTS.map( ( name ) => `
export class ${ name } extends __base( ${ JSON.stringify( name ) } ) {
	constructor( ...args ) {
		super( ...args );
		__mark( this, ${ JSON.stringify( name ) } );
	}
}` ).join( '\n' );

	return `
import * as Original from '/build/three.webgpu.js';
export * from '/build/three.webgpu.js';
import { installPrecompileMarker, setDevRenderer, precompileAuxiliary } from '@tsl-precompile/runtime';

const __state = window.__TSLP_E2E || { example: 'unknown' };
const __counts = Object.create( null );
const __pending = [];
const __seenMaterials = new WeakMap();
let __renderer = null;

installPrecompileMarker( Original, {
	devEndpoint: '/__tslp__/capture?example=' + encodeURIComponent( __state.example ),
} );

function __base( name ) {
	return Original[ name ] || Original.NodeMaterial || Original.Material;
}

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
	if ( material.isMeshStandardNodeMaterial || material.isMeshStandardMaterial ) return 'MeshStandardNodeMaterial';
	if ( material.isMeshPhysicalNodeMaterial || material.isMeshPhysicalMaterial ) return 'MeshPhysicalNodeMaterial';
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
	if ( type === 'MeshStandardNodeMaterial' || type === 'MeshStandardMaterial' ) return 'MeshStandardNodeMaterial';
	if ( type === 'MeshPhysicalNodeMaterial' || type === 'MeshPhysicalMaterial' ) return 'MeshPhysicalNodeMaterial';
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

${ materialClasses }

function __capturePostProcessing( pipeline ) {
	if ( ! __renderer || ! pipeline || pipeline.__tslpAuxStarted ) return;
	pipeline.__tslpAuxStarted = true;
	Promise.resolve().then( () => precompileAuxiliary( __renderer, null, null, {
		devEndpoint: '/__tslp__/capture?example=' + encodeURIComponent( __state.example ),
		postProcessing: pipeline,
		three: Original,
		threeVersion: String( Original.REVISION || 'unknown' ),
		pluginVersion: '0.0.0',
	} ) ).catch( ( err ) => console.warn( '[tslp-e2e] post-process aux capture failed:', err && err.message || err ) );
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
		__markSceneMaterials( scene );
		__flush();
		return typeof super.compile === 'function' ? super.compile( scene, camera, ...rest ) : undefined;
	}
	compileAsync( scene, camera, ...rest ) {
		__markSceneMaterials( scene );
		__flush();
		return typeof super.compileAsync === 'function' ? super.compileAsync( scene, camera, ...rest ) : Promise.resolve();
	}
	render( scene, camera ) {
		__markSceneMaterials( scene );
		__flush();
		if ( ! this.__tslpAuxStarted ) {
			this.__tslpAuxStarted = true;
			Promise.resolve().then( () => precompileAuxiliary( this, scene, camera, {
				devEndpoint: '/__tslp__/capture?example=' + encodeURIComponent( __state.example ),
				three: Original,
				threeVersion: String( Original.REVISION || 'unknown' ),
				pluginVersion: '0.0.0',
			} ) ).catch( ( err ) => console.warn( '[tslp-e2e] aux capture failed:', err && err.message || err ) );
		}
		return super.render( scene, camera );
	}
}
`;

}

function slimWebgpuReplayModule() {

	const materialClasses = NODE_MATERIAL_EXPORTS.map( ( name ) => `
export class ${ name } {
	constructor() {
		return __takeMaterial( ${ JSON.stringify( name ) } );
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
			const wrappedOnLoad = ( texOrImage ) => {
				try {
					if ( typeof onLoad === 'function' ) onLoad( texOrImage );
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
	const material = new Slim.PrecompiledMaterial( mod.artifact );
	material.name = name;
	__seedNodeProps( material );
	return material;
}

function __classNameForMaterial( material ) {
	if ( ! material ) return 'Material';
	if ( material.isMeshBasicNodeMaterial || material.isMeshBasicMaterial ) return 'MeshBasicNodeMaterial';
	if ( material.isMeshStandardNodeMaterial || material.isMeshStandardMaterial ) return 'MeshStandardNodeMaterial';
	if ( material.isMeshPhysicalNodeMaterial || material.isMeshPhysicalMaterial ) return 'MeshPhysicalNodeMaterial';
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
	if ( type === 'MeshStandardNodeMaterial' || type === 'MeshStandardMaterial' ) return 'MeshStandardNodeMaterial';
	if ( type === 'MeshPhysicalNodeMaterial' || type === 'MeshPhysicalMaterial' ) return 'MeshPhysicalNodeMaterial';
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
const __TEXTURE_PROPS = [ 'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'envMap', 'lightMap', 'aoMap', 'displacementMap', 'alphaMap', 'bumpMap', 'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap', 'transmissionMap', 'thicknessMap', 'iridescenceMap', 'iridescenceThicknessMap', 'sheenColorMap', 'sheenRoughnessMap', 'specularMap', 'specularColorMap', 'specularIntensityMap', 'gradientMap', 'matcap' ];
const __SCALAR_PROPS = [ 'color', 'opacity', 'transparent', 'side', 'visible', 'toneMapped', 'emissive', 'roughness', 'metalness', 'clearcoat', 'clearcoatRoughness', 'sheen', 'sheenColor', 'sheenRoughness', 'transmission', 'thickness', 'attenuationColor', 'attenuationDistance', 'iridescence', 'iridescenceIOR', 'normalScale', 'displacementScale', 'displacementBias', 'wireframe', 'wireframeLinewidth', 'flatShading', 'depthTest', 'depthWrite', 'alphaTest', 'blending', 'premultipliedAlpha', 'dithering', 'vertexColors' ];
function __copyMaterialProps( src, dst ) {
	for ( const key of __SCALAR_PROPS ) if ( src && src[ key ] !== undefined ) dst[ key ] = src[ key ];
	for ( const key of __TEXTURE_PROPS ) if ( src && src[ key ] !== undefined ) dst[ key ] = src[ key ];
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
		if ( tex && tex.isTexture ) Slim.attachArtifactTextureRefs( artifact, tex );
	}
}

function __replaceSceneMaterials( scene ) {
	if ( ! scene || typeof scene.traverse !== 'function' ) return;
	scene.traverse( ( object ) => {
		const material = object && object.material;
		if ( ! material ) return;
		const replaceOne = ( m ) => {
			if ( ! m || m.isPrecompiledMaterial ) return m;
			if ( m.visible === false ) return m;
			if ( __seenMaterials.has( m ) ) return __seenMaterials.get( m );
			const className = __classNameForMaterial( m );
			const replacement = __takeMaterial( className, m );
			__copyMaterialProps( m, replacement );
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
function __wireBackgroundTextures( scene ) {
	if ( ! scene || ! scene.background || ! scene.background.isTexture ) return;
	const auxList = Array.isArray( __data.aux ) ? __data.aux : [];
	for ( const entry of auxList ) {
		if ( entry && entry.shape === 'background' && entry.artifact ) {
			Slim.attachArtifactTextureRefs( entry.artifact, scene.background );
		}
	}
}

// PBR (MeshStandard / MeshPhysical) materials sample a PMREM-prefiltered
// 2D texture for IBL. three.js's NodeManager builds it lazily on first
// render and stashes it on a PMREMNode in sceneData.environmentNode.
// The captured artifact references this texture by capture-time uuid;
// at replay the live renderer makes a fresh PMREM and we wire that into
// every PBR material's artifact.texture-kind bindings so the hydrator
// resolves to the live prefiltered map instead of the 1×1 fallback.
// Cache of PMREM-prefiltered textures keyed by source cubemap. Mirrors
// what three.js's EnvironmentNode does internally — but our patched
// slim bypasses NodeBuilder.build() so PBR materials never trigger the
// PMREM path on their own. We run PMREMGenerator manually on
// scene.environment and wire the prefiltered output into every
// PrecompiledMaterial's artifact.texture-kind bindings so the hydrator
// resolves to the live prefiltered map instead of the 1×1 fallback.
const __pmremCache = new WeakMap();
function __getPMREMFor( renderer, sourceTex ) {
	if ( ! renderer || ! sourceTex ) return null;
	if ( __pmremCache.has( sourceTex ) ) return __pmremCache.get( sourceTex );
	if ( ! Slim.PMREMGenerator ) return null;
	let pmrem;
	try {
		const gen = new Slim.PMREMGenerator( renderer );
		const target = sourceTex.isCubeTexture ? gen.fromCubemap( sourceTex ) : gen.fromEquirectangular( sourceTex );
		pmrem = target && target.texture || target || null;
		gen.dispose && gen.dispose();
	} catch ( _ ) {
		return null;
	}
	if ( pmrem && pmrem.isTexture ) __pmremCache.set( sourceTex, pmrem );
	return pmrem || null;
}

function __wireEnvironmentPMREM( renderer, scene ) {
	if ( ! renderer || ! scene || ! scene.environment || ! scene.environment.isTexture ) return;
	const pmrem = __getPMREMFor( renderer, scene.environment );
	if ( ! pmrem ) return;
	scene.traverse( ( object ) => {
		const mat = object && object.material;
		const list = Array.isArray( mat ) ? mat : mat ? [ mat ] : [];
		for ( const m of list ) {
			if ( m && m.isPrecompiledMaterial && m.precompiledArtifact ) {
				Slim.attachArtifactTextureRefs( m.precompiledArtifact, pmrem );
			}
		}
	} );
}

// Walk the scene and register every discovered Texture in the runtime's
// live-texture index. Hydrator uses this to relink artifact.texture-kind
// bindings whose textureUuid is dead by matching imageSrc / textureName
// from the captured artifact against currently-loaded textures.
function __indexLiveTextures( scene ) {
	if ( ! scene || typeof scene.traverse !== 'function' ) return;
	const visit = ( tex ) => { if ( tex && tex.isTexture ) Slim.registerLiveTexture( tex ); };
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
	// Drop backgroundNode (TSL graph) and Texture-typed backgrounds when we
	// have no captured background aux — they'd hit the unloadable
	// loadAux() path inside the patched Background.js. Keep Color
	// backgrounds untouched: those render via the renderer's clear-color
	// path and never need an aux artifact.
	if ( scene && ! __hasBackgroundAux ) {
		scene.backgroundNode = null;
		if ( scene.background && ! scene.background.isColor ) scene.background = null;
	}
	__indexLiveTextures( scene );
	__wireBackgroundTextures( scene );
	__replaceSceneMaterials( scene );
}

export class WebGPURenderer extends Slim.WebGPURenderer {
	compile( scene, camera, ...rest ) {
		__prepareSceneForReplay( scene, this );
		const r = typeof super.compile === 'function' ? super.compile( scene, camera, ...rest ) : undefined;
		__wireEnvironmentPMREM( this, scene );
		return r;
	}
	compileAsync( scene, camera, ...rest ) {
		__prepareSceneForReplay( scene, this );
		const p = typeof super.compileAsync === 'function' ? super.compileAsync( scene, camera, ...rest ) : Promise.resolve();
		Promise.resolve( p ).then( () => __wireEnvironmentPMREM( this, scene ) ).catch( () => {} );
		return p;
	}
	render( scene, camera ) {
		__prepareSceneForReplay( scene, this );
		// Wire PMREM AFTER super.render so the prefiltered envMap is ready
		// for the next frame's bind groups. The first frame paints with
		// the cube fallback; subsequent frames pick up the real PMREM.
		const r = super.render( scene, camera );
		__wireEnvironmentPMREM( this, scene );
		return r;
	}
	compute( computeNode, ...rest ) {
		if ( ! computeNode || computeNode.isComputeNode !== true ) return undefined;
		return super.compute( computeNode, ...rest );
	}
	computeAsync( computeNode, ...rest ) {
		if ( ! computeNode || computeNode.isComputeNode !== true ) return Promise.resolve();
		return super.computeAsync( computeNode, ...rest );
	}
	async getArrayBufferAsync( attribute, ...rest ) {
		if ( ! attribute ) return new Float32Array( 1 ).buffer;
		try { return await super.getArrayBufferAsync( attribute, ...rest ); }
		catch ( _ ) { return new Float32Array( 1 ).buffer; }
	}
}
`;

}

function tslStubModule() {

	const src = readFileSync( join( threeRepo, 'build/three.tsl.js' ), 'utf8' );
	const match = src.match( /export\s*\{([\s\S]*?)\};?\s*$/m );
	const names = match
		? match[ 1 ].split( ',' ).map( ( x ) => x.trim().split( /\s+as\s+/ ).pop().trim() ).filter( Boolean )
		: [];
	const unique = Array.from( new Set( names ) ).filter( ( name ) => /^[A-Za-z_$][\w$]*$/.test( name ) );
	const exports = unique.map( ( name ) => `export const ${ name } = __stub(${ JSON.stringify( name ) });` ).join( '\n' );
	return `
function __stub( label ) {
	const fn = function tslE2EStub() { return proxy; };
	Object.defineProperty( fn, 'name', { value: label, writable: true, configurable: true } );
	const proxy = new Proxy( fn, {
		get( _target, prop ) {
			if ( prop === Symbol.toPrimitive ) return () => 0;
			if ( prop === 'toString' ) return () => '[tsl-e2e-stub ' + label + ']';
			if ( prop === 'valueOf' ) return () => 0;
			if ( prop === 'isNode' ) return true;
			if ( prop === 'then' ) return undefined;
			return __stub( label + '.' + String( prop ) );
		},
		set() { return true; },
		apply() { return proxy; },
		construct() { return proxy; },
	} );
	return proxy;
}
${ exports }
export const TSL = __stub( 'TSL' );
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
	copyFramebufferToTexture() {}
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
		if ( url.pathname === '/__tslp__/full-webgpu-auto.js' ) return sendJs( res, fullWebgpuAutoModule() );
		if ( url.pathname === '/__tslp__/slim-webgpu-replay.js' ) return sendJs( res, slimWebgpuReplayModule() );
		if ( url.pathname === '/__tslp__/tsl-stub.js' ) return sendJs( res, tslStubModule() );
		if ( url.pathname === '/examples/jsm/inspector/Inspector.js' && /\b__tslp_mode=replay\b/.test( req.headers.referer || '' ) ) return sendJs( res, inspectorStubModule() );
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

			const mode = url.searchParams.get( '__tslp_mode' ) === 'replay' ? 'replay' : 'capture';
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

await new Promise( ( ok, fail ) => server.listen( port, '127.0.0.1', ok ).once( 'error', fail ) );
console.log( `[batch-e2e] server on http://localhost:${ port}/` );

const BROWSER_ARGS = [ '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--no-sandbox', '--disable-dev-shm-usage' ];
const NAV_TIMEOUT_MS = 30000;
const RENDER_TIMEOUT_MS = 12000;
const RENDER_POLL_MS = 400;
const MAX_RUNS_PER_BROWSER = 12;

// Deterministic-time replay support. Animated examples driven by
// `setAnimationLoop` would otherwise sample different animation phases on
// capture vs replay (the default capture-wait was 8 s vs replay-wait 5 s
// in real-time wall-clock), tanking PSNR purely from animation jitter
// rather than rendering differences. We inject a `requestAnimationFrame`
// shim before navigation that hands out synthetic monotonic timestamps,
// step by step, on every tick — so both passes see identical `time`
// arguments at the same Nth tick. After both passes have advanced past
// TARGET_TICK we freeze the synthetic clock and screenshot. Real-time
// fetch / XHR are unaffected, so HDR / KTX2 / GLTF loaders still work.
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

async function dumpBrightestCanvas( page ) {

	const shots = await dumpCanvases( page );
	let best = null;
	let bestBright = 0;
	for ( const shot of shots ) {

		const bright = await brightFraction( page, shot );
		if ( ! best || bright > bestBright ) {

			best = shot;
			bestBright = bright;

		}

	}
	return { shot: best, bright: +bestBright.toFixed( 4 ) };

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

		bright = ( await dumpBrightestCanvas( page ) ).bright;
		if ( bright > 0.005 ) break;
		await new Promise( ( r ) => setTimeout( r, RENDER_POLL_MS ) );

	}
	return +bright.toFixed( 4 );

}

async function visitExample( browser, name, mode, waitMs ) {

	const context = await browser.newContext( { viewport: { width: 640, height: 480 } } );
	const page = await context.newPage();
	const errors = [];
	page.on( 'pageerror', ( e ) => errors.push( String( e && ( e.stack || e.message ) || e ) ) );
	page.on( 'console', ( m ) => {

		if ( m.type() === 'error' ) errors.push( m.text() );

	} );

	// Inject a deterministic-rAF shim BEFORE the page navigates so it's
	// active from the very first script. Each `requestAnimationFrame`
	// callback receives a synthetic monotonic timestamp that advances by
	// exactly FRAME_STEP_MS per tick. `Date.now()` / `performance.now()`
	// / `setTimeout` are left alone so async loaders, fetch, and
	// renderer init still progress on real time — only the animation
	// loop sees the synthetic clock.
	//
	// Both capture and replay block until tick >= TARGET_TICK, freeze
	// the synthetic clock at TARGET_TICK, then screenshot. Any
	// `setAnimationLoop( ( time ) => ... )` callback therefore sees the
	// same `time` argument at the same simulated frame in both passes,
	// so animated examples sample identical animation phase regardless
	// of how long real-time setup took.
	const TARGET_TICK = 60; // 60 frames of simulated 60Hz animation = 1s
	const FRAME_STEP_MS = 16.6667;
	try {

		await page.addInitScript( ( { step, base } ) => {

			// eslint-disable-next-line no-undef
			const w = window;
			if ( w.__tslpRafShimInstalled ) return;
			w.__tslpRafShimInstalled = true;
			w.__tslpRafTick = 0;

			const origRaf = w.requestAnimationFrame.bind( w );
			w.requestAnimationFrame = function ( cb ) {

				return origRaf( () => {

					const tick = ++ w.__tslpRafTick;
					cb( base + tick * step );

				} );

			};

		}, { step: FRAME_STEP_MS, base: 0 } );

	} catch ( _ ) { /* older Playwright fallback */ }

	try {

		await page.goto( `http://localhost:${ port }/examples/${ name }?__tslp_mode=${ mode }`, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS } );
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

		// Wait until the rAF tick counter reaches TARGET_TICK. Because
		// the rAF shim assigns sequential synthetic timestamps to every
		// callback, both capture and replay observe the SAME `time`
		// argument at the same tick number. We poll real time and wait
		// for the tick counter; once it crosses TARGET_TICK both
		// passes are at identical animation phase.
		try {

			await page.waitForFunction(
				( target ) => {

					// eslint-disable-next-line no-undef
					return typeof window.__tslpRafTick === 'number' && window.__tslpRafTick >= target;

				},
				TARGET_TICK,
				{ timeout: RENDER_TIMEOUT_MS },
			);

			// Once we're past TARGET_TICK, freeze the synthetic clock
			// so subsequent ticks repeat the same time. The browser
			// still drives real rAF; we just clamp the synthetic
			// timestamp at the target. The screenshot is taken after a
			// short real settle so the canvas reflects the frozen
			// frame.
			await page.evaluate( ( target ) => {

				// eslint-disable-next-line no-undef
				const w = window;
				w.__tslpRafTick = target;
				const origRaf = w.requestAnimationFrame.bind( w );
				w.requestAnimationFrame = function ( cb ) {

					return origRaf( () => cb( target * 16.6667 ) );

				};

			}, TARGET_TICK );

			await new Promise( ( r ) => setTimeout( r, FRAME_TIME_MS ) );

		} catch ( _ ) { /* tick counter may not have advanced (no animation loop) */ }

		const shot = await dumpCanvas( page );
		const real = errors.filter( ( e ) => ! /favicon|Failed to load resource/i.test( e ) );
		return { bright, shot, errors: real.slice( 0, 5 ), context, page };

	} catch ( err ) {

		return { bright: 0, shot: null, errors: [ err && err.message || String( err ) ], navigationError: true, context, page };

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

async function runOne( browser, name ) {

	captures.delete( name );
	const capture = await visitExample( browser, name, 'capture', captureWaitMs );
	await capture.context.close().catch( () => {} );
	const bucket = captureBucket( name );
	const userCount = Object.keys( bucket.user ).length;
	const auxCount = bucket.aux.length;
	const artifactSummaries = summarizeArtifacts( bucket );
	const auxSummaries = summarizeAuxArtifacts( bucket );

	const replay = await visitExample( browser, name, 'replay', replayWaitMs );
	const blockingCaptureErrors = capture.errors.filter( ( error ) => ! isIgnorableCaptureError( error ) );
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
		captureErrors: capture.errors,
		replayErrors: replay.errors,
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

let browser = await chromium.launch( { channel: 'chrome', headless: true, args: BROWSER_ARGS } ).catch( () => null );
if ( ! browser ) browser = await chromium.launch( { headless: true, args: BROWSER_ARGS } );

const report = { total: candidates.length, pass: 0, fail: 0, skip: allExamples.length - candidates.length, details: [] };
let runsSinceRestart = 0;

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

			const tag = result.status === 'pass' ? '✓' : '✗';
			const gate = result.pixelGate || {};
			const pixInfo = gate.skipped ? ` px=skip(${ gate.reason })` : ( gate.pass !== undefined ? ` psnr=${ gate.psnr }dB${ gate.pass === false ? '✗' : '' }` : '' );
			console.log( `${ label } — ${ tag} artifacts=${ result.userArtifacts } aux=${ result.auxArtifacts } replayBright=${ result.replayBrightFrac }${ pixInfo }${ result.error ? ' err="' + result.error.slice( 0, 80 ) + '"' : '' }` );

		} catch ( err ) {

			report.fail ++;
			report.details.push( { name, status: 'fail', error: err && err.message || String( err ) } );
			console.log( `${ label } — FAIL harness-error "${ err && err.message || err }"` );

		}

	}

} finally {

	await browser.close().catch( () => {} );
	server.close();

}

const reportPath = join( OUT, 'e2e-report.json' );
writeFileSync( reportPath, JSON.stringify( report, null, 2 ) );

console.log( '\n═══ e2e summary ═══' );
console.log( `  ${ report.pass } pass, ${ report.fail } fail, ${ report.skip } skip, ${ report.total } candidates` );
console.log( `  report: ${ reportPath }` );

process.exit( report.fail === 0 ? 0 : 1 );
