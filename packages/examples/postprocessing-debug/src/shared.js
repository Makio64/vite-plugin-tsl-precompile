import {
	AmbientLight,
	BoxGeometry,
	Color,
	DirectionalLight,
	Group,
	HalfFloatType,
	PerspectiveCamera,
	PlaneGeometry,
	ReinhardToneMapping,
	RenderTarget,
	Scene,
	SphereGeometry,
} from 'three';
import { WebGPURenderer, Mesh, MeshStandardNodeMaterial, RenderPipeline } from 'three/webgpu';
import {
	mrt,
	normalView,
	output,
	pass,
	renderOutput,
	texture,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { bindPostprocessAuxByName, POSTPROCESS_AUX_NAMES } from './postprocess-aux.js';
import { recordLiveRouteFrame } from './site-status.js';

// Ordered easiest → most complex. Each page mirrors the matching upstream
// three.js `webgpu_postprocessing*` example so a failing page maps directly
// to an upstream regression.
const EFFECTS = {
	passthrough: { label: 'Passthrough', page: 'passthrough.html' },
	bloom: { label: 'Bloom', page: 'bloom.html' },
	fxaa: { label: 'FXAA', page: 'fxaa.html' },
	gtao: { label: 'GTAO', page: 'gtao.html' },
};

const CAPTURE_ENDPOINT = window.__TSLP_E2E?.captureEndpoint || '/__tsl-precompile/capture';
const IS_E2E = !! window.__TSLP_E2E;
const IS_E2E_REPLAY = window.__TSLP_E2E?.mode === 'replay';
const IS_PRODUCTION_BUILD = import.meta.env?.PROD === true;

function setHud( title, effect, status ) {

	const hud = document.getElementById( 'hud' );
	if ( ! hud ) return;

	hud.innerHTML = `
		<div class="hud-title">${ title }</div>
		<div class="hud-status">${ EFFECTS[ effect ].label } — ${ status }</div>
		<nav class="hud-links" aria-label="Postprocessing scenes">
			${ Object.entries( EFFECTS ).map( ( [ key, item ] ) => `<a href="${ item.page }" ${ key === effect ? 'aria-current="page"' : '' }>${ item.label }</a>` ).join( '' ) }
		</nav>
	`;

}

function makeMaterial( color, { roughness = 0.5, metalness = 0.0, emissive = 0x000000, emissiveIntensity = 1 } = {} ) {

	return new MeshStandardNodeMaterial( {
		color: new Color( color ),
		roughness,
		metalness,
		emissive: new Color( emissive ),
		emissiveIntensity,
	} );

}

function addDebugGeometry( scene, markMaterials ) {

	const group = new Group();
	group.name = 'postprocessing-debug-objects';

	const floorMaterial = makeMaterial( 0x8a8f96, { roughness: 0.85 } );
	const floor = new Mesh( new PlaneGeometry( 12, 12 ), floorMaterial );
	floor.name = 'floor';
	floor.rotation.x = - Math.PI / 2;
	floor.position.y = - 0.5;
	scene.add( floor );

	const cubeMaterial = makeMaterial( 0xd96a3c, { roughness: 0.35 } );
	const cube = new Mesh( new BoxGeometry( 1, 1, 1 ), cubeMaterial );
	cube.name = 'cube';
	cube.position.set( - 1.1, 0, 0 );
	group.add( cube );

	// Bright emissive sphere so the bloom page actually shows a glow.
	const sphereMaterial = makeMaterial( 0x101418, { roughness: 0.25, emissive: 0x33aaff, emissiveIntensity: 4 } );
	const sphere = new Mesh( new SphereGeometry( 0.6, 48, 24 ), sphereMaterial );
	sphere.name = 'sphere';
	sphere.position.set( 1.0, 0.1, 0.2 );
	group.add( sphere );

	if ( ! IS_E2E_REPLAY ) markMaterials( {
		floor: floorMaterial,
		cube: cubeMaterial,
		sphere: sphereMaterial,
	} );

	scene.add( group );
	return group;

}

function makeLights( scene ) {

	scene.add( new AmbientLight( 0xffffff, 0.15 ) );
	const light = new DirectionalLight( 0xffffff, 2.6 );
	light.name = 'debug-directional-light';
	light.position.set( 3, 5, 2 );
	scene.add( light );

}

function buildOutputNode( effect, scene, camera ) {

	const scenePass = pass( scene, camera );

	if ( effect === 'passthrough' ) {

		// Bare PassNode → screen. Mirrors webgpu_postprocessing.html's
		// `scenePass.getTextureNode()` path with zero effect nodes.
		return scenePass.getTextureNode();

	}

	if ( effect === 'bloom' ) {

		// Mirrors webgpu_postprocessing_bloom.html.
		const scenePassColor = scenePass.getTextureNode( 'output' );
		const bloomPass = bloom( scenePassColor );
		return renderOutput( scenePassColor.add( bloomPass ) );

	}

	if ( effect === 'gtao' ) {

		// Mirrors GTAONode's documented usage: a single MRT pass exposing
		// color + view normals + depth, then `ao(depth, normal, camera)`.
		scenePass.setMRT( mrt( {
			output,
			normal: normalView,
		} ) );
		const scenePassColor = scenePass.getTextureNode( 'output' );
		const scenePassNormal = scenePass.getTextureNode( 'normal' );
		const scenePassDepth = scenePass.getTextureNode( 'depth' );
		const aoPass = ao( scenePassDepth, scenePassNormal, camera );
		return scenePassColor.mul( aoPass.getTextureNode().r );

	}

	throw new Error( `[postprocessing-debug] unknown effect: ${ effect }` );

}

function makeFxaaPipelines( renderer, scene, camera ) {

	const scenePass = pass( scene, camera );
	const colorPipeline = new RenderPipeline( renderer );
	colorPipeline.outputNode = scenePass.getTextureNode( 'output' );

	// FXAA requires an sRGB input. Three's `fxaa( renderOutput( pass ) )`
	// shorthand inserts a hidden RTT node, which is not an authored render
	// stage and therefore has no independently named artifact to replay. Make
	// that stage explicit: the first compiled pipeline performs the output
	// transform into a stable texture; the second compiled pipeline runs FXAA.
	const colorTarget = new RenderTarget( 1, 1, {
		depthBuffer: false,
		type: HalfFloatType,
	} );
	colorTarget.texture.name = 'postprocessing-debug-fxaa-color';

	const effectPipeline = new RenderPipeline( renderer );
	effectPipeline.outputColorTransform = false;
	effectPipeline.outputNode = fxaa( texture( colorTarget.texture ) );

	return { colorPipeline, colorTarget, effectPipeline };

}

function resizeFxaaTarget( renderer, stages ) {

	if ( ! stages ) return;
	const pixelRatio = renderer.getPixelRatio();
	stages.colorTarget.setSize(
		Math.max( 1, Math.floor( window.innerWidth * pixelRatio ) ),
		Math.max( 1, Math.floor( window.innerHeight * pixelRatio ) ),
	);

}

async function preparePipeline( capture, renderer, scene, camera, pipeline, name, renderPipelineTarget = null ) {

	if ( IS_PRODUCTION_BUILD || IS_E2E_REPLAY ) {

		await bindPostprocessAuxByName( pipeline.outputNode, name );
		return [ { shape: 'post-process', ok: true } ];

	}
	return capture.runtime.precompileAuxiliary( renderer, scene, camera, {
		devEndpoint: CAPTURE_ENDPOINT,
		three: capture.three,
		threeVersion: globalThis.__TSLP_THREE_PACKAGE_VERSION__ || String( capture.three.REVISION ).match( /^\d+/ )[ 0 ],
		postProcessing: pipeline,
		postProcessingName: name,
		renderPipeline: pipeline,
		...( renderPipelineTarget ? { renderPipelineTarget } : {} ),
	} ).catch( ( err ) => {

		console.warn( '[postprocessing-debug] auxiliary capture failed:', err );
		return [ { shape: 'aux', ok: false, error: err && err.message || String( err ) } ];

	} );

}

export async function runPostProcessingDebugExample( {
	effect = 'passthrough',
	title = `${ EFFECTS[ effect ]?.label || effect } postprocessing`,
	markMaterials,
} = {} ) {

	if ( ! EFFECTS[ effect ] ) throw new Error( `[postprocessing-debug] unknown effect: ${ effect }` );
	if ( typeof markMaterials !== 'function' ) throw new TypeError( '[postprocessing-debug] markMaterials must be a function.' );
	setHud( title, effect, 'starting' );

	const renderer = new WebGPURenderer( { antialias: false } );
	renderer.setPixelRatio( Math.min( 2, window.devicePixelRatio || 1 ) );
	renderer.setSize( window.innerWidth, window.innerHeight );
	renderer.setClearColor( 0x14171c );
	if ( effect === 'bloom' ) renderer.toneMapping = ReinhardToneMapping;
	document.body.appendChild( renderer.domElement );

	await renderer.init();

	let capture = null;
	if ( ! IS_PRODUCTION_BUILD && ! IS_E2E_REPLAY ) {

		const { setupCaptureRuntime } = await import( './capture-runtime.js' );
		capture = await setupCaptureRuntime( renderer, CAPTURE_ENDPOINT );

	}

	const scene = new Scene();
	const camera = new PerspectiveCamera( 45, window.innerWidth / window.innerHeight, 0.1, 50 );
	camera.position.set( 3.2, 2.0, 4.5 );
	camera.lookAt( 0, 0, 0 );

	makeLights( scene );
	const objects = addDebugGeometry( scene, markMaterials );

	let postProcessing;
	let fxaaStages = null;
	if ( effect === 'fxaa' ) {

		fxaaStages = makeFxaaPipelines( renderer, scene, camera );
		resizeFxaaTarget( renderer, fxaaStages );
		postProcessing = fxaaStages.effectPipeline;

	} else {

		postProcessing = new RenderPipeline( renderer );
		if ( effect === 'bloom' ) postProcessing.outputColorTransform = false;
		postProcessing.outputNode = buildOutputNode( effect, scene, camera );

	}

	const auxResults = [];
	if ( fxaaStages ) {

		auxResults.push( ...await preparePipeline(
			capture,
			renderer,
			scene,
			camera,
			fxaaStages.colorPipeline,
			POSTPROCESS_AUX_NAMES.fxaaColor,
			fxaaStages.colorTarget,
		) );

	}
	auxResults.push( ...await preparePipeline(
		capture,
		renderer,
		scene,
		camera,
		postProcessing,
		POSTPROCESS_AUX_NAMES[ effect ],
	) );

	const auxSummary = IS_E2E ? 'ready' : auxResults.map( ( r ) => `${ r.shape }:${ r.ok ? 'ok' : 'err' }` ).join( ', ' ) || 'no aux';
	setHud( title, effect, `rendering — ${ auxSummary }` );

	renderer.setAnimationLoop( () => {

		objects.rotation.y = 0;
		if ( fxaaStages ) {

			const currentTarget = renderer.getRenderTarget();
			try {

				renderer.setRenderTarget( fxaaStages.colorTarget );
				fxaaStages.colorPipeline.render();

			} finally {

				renderer.setRenderTarget( currentTarget );

			}

		}
		postProcessing.render();
		recordLiveRouteFrame();

	} );

	window.addEventListener( 'resize', () => {

		camera.aspect = window.innerWidth / window.innerHeight;
		camera.updateProjectionMatrix();
		renderer.setSize( window.innerWidth, window.innerHeight );
		resizeFxaaTarget( renderer, fxaaStages );

	} );

}
