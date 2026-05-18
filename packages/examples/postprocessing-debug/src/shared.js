import {
	AmbientLight,
	BoxGeometry,
	Color,
	DirectionalLight,
	Group,
	PerspectiveCamera,
	PlaneGeometry,
	ReinhardToneMapping,
	Scene,
	SphereGeometry,
} from 'three';
import { WebGPURenderer, Mesh, MeshStandardNodeMaterial, PostProcessing } from 'three/webgpu';
import {
	mrt,
	normalView,
	output,
	pass,
	renderOutput,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { installPrecompileMarker, precompileAuxiliary, setDevRenderer } from '@tsl-precompile/runtime';
import * as THREE_GPU from 'three/webgpu';

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

function addDebugGeometry( scene ) {

	const group = new Group();
	group.name = 'postprocessing-debug-objects';

	const floorMaterial = makeMaterial( 0x8a8f96, { roughness: 0.85 } );
	if ( ! IS_E2E_REPLAY ) floorMaterial.precompile( 'postprocessing-debug-floor' );
	const floor = new Mesh( new PlaneGeometry( 12, 12 ), floorMaterial );
	floor.name = 'floor';
	floor.rotation.x = - Math.PI / 2;
	floor.position.y = - 0.5;
	scene.add( floor );

	const cubeMaterial = makeMaterial( 0xd96a3c, { roughness: 0.35 } );
	if ( ! IS_E2E_REPLAY ) cubeMaterial.precompile( 'postprocessing-debug-cube' );
	const cube = new Mesh( new BoxGeometry( 1, 1, 1 ), cubeMaterial );
	cube.name = 'cube';
	cube.position.set( - 1.1, 0, 0 );
	group.add( cube );

	// Bright emissive sphere so the bloom page actually shows a glow.
	const sphereMaterial = makeMaterial( 0x101418, { roughness: 0.25, emissive: 0x33aaff, emissiveIntensity: 4 } );
	if ( ! IS_E2E_REPLAY ) sphereMaterial.precompile( 'postprocessing-debug-sphere' );
	const sphere = new Mesh( new SphereGeometry( 0.6, 48, 24 ), sphereMaterial );
	sphere.name = 'sphere';
	sphere.position.set( 1.0, 0.1, 0.2 );
	group.add( sphere );

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

	if ( effect === 'fxaa' ) {

		// Mirrors webgpu_postprocessing_fxaa.html — FXAA runs after the
		// output color transform, so feed it `renderOutput( pass )`.
		const outputPass = renderOutput( scenePass );
		return fxaa( outputPass );

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

export async function runPostProcessingDebugExample( { effect = 'passthrough', title = `${ EFFECTS[ effect ]?.label || effect } postprocessing` } = {} ) {

	if ( ! EFFECTS[ effect ] ) throw new Error( `[postprocessing-debug] unknown effect: ${ effect }` );
	setHud( title, effect, 'starting' );

	const renderer = new WebGPURenderer( { antialias: false } );
	renderer.setPixelRatio( Math.min( 2, window.devicePixelRatio || 1 ) );
	renderer.setSize( window.innerWidth, window.innerHeight );
	renderer.setClearColor( 0x14171c );
	if ( effect === 'bloom' ) renderer.toneMapping = ReinhardToneMapping;
	document.body.appendChild( renderer.domElement );

	await renderer.init();

	installPrecompileMarker( THREE_GPU, { devEndpoint: CAPTURE_ENDPOINT } );
	setDevRenderer( renderer );

	const scene = new Scene();
	const camera = new PerspectiveCamera( 45, window.innerWidth / window.innerHeight, 0.1, 50 );
	camera.position.set( 3.2, 2.0, 4.5 );
	camera.lookAt( 0, 0, 0 );

	makeLights( scene );
	const objects = addDebugGeometry( scene );

	const postProcessing = new PostProcessing( renderer );
	// FXAA and Bloom need the captured graph to own the color transform so the
	// slim replay can bind one post-process artifact that includes the effect.
	if ( effect === 'fxaa' || effect === 'bloom' ) postProcessing.outputColorTransform = false;
	postProcessing.outputNode = buildOutputNode( effect, scene, camera );

	const skipReplayAuxCapture = IS_E2E_REPLAY && effect === 'bloom';
	const auxResults = skipReplayAuxCapture ? [ { shape: 'replay', ok: true } ] : await precompileAuxiliary( renderer, scene, camera, {
		devEndpoint: CAPTURE_ENDPOINT,
		three: THREE_GPU,
		threeVersion: String( THREE_GPU.REVISION ).match( /^\d+/ )[ 0 ],
		pluginVersion: '0.0.0',
		postProcessing,
		renderPipeline: postProcessing,
	} ).catch( ( err ) => {

		console.warn( '[postprocessing-debug] auxiliary capture failed:', err );
		return [ { shape: 'aux', ok: false, error: err && err.message || String( err ) } ];

	} );

	const auxSummary = IS_E2E ? 'ready' : auxResults.map( ( r ) => `${ r.shape }:${ r.ok ? 'ok' : 'err' }` ).join( ', ' ) || 'no aux';
	setHud( title, effect, `rendering — ${ auxSummary }` );

	renderer.setAnimationLoop( () => {

		objects.rotation.y = 0;
		postProcessing.render();

	} );

	window.addEventListener( 'resize', () => {

		camera.aspect = window.innerWidth / window.innerHeight;
		camera.updateProjectionMatrix();
		renderer.setSize( window.innerWidth, window.innerHeight );

	} );

}
