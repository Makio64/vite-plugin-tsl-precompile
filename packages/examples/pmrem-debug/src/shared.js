import {
	AmbientLight,
	BackSide,
	BoxGeometry,
	CanvasTexture,
	Color,
	CubeTexture,
	DirectionalLight,
	EquirectangularReflectionMapping,
	CubeReflectionMapping,
	Mesh,
	MeshBasicMaterial,
	PerspectiveCamera,
	PlaneGeometry,
	Scene,
	SphereGeometry,
	SRGBColorSpace,
} from 'three';
import { WebGPURenderer, MeshPhysicalNodeMaterial, MeshStandardNodeMaterial, PMREMGenerator } from 'three/webgpu';
import { installPrecompileMarker, precompileAuxiliary, registerLiveTexture, setDevRenderer } from '@tsl-precompile/runtime';
import * as THREE from 'three';

const CAPTURE_ENDPOINT = window.__TSLP_E2E?.captureEndpoint || '/__tsl-precompile/capture';
const IS_E2E_REPLAY = window.__TSLP_E2E?.mode === 'replay';

const MODES = {
	equirect: { label: 'Equirect', page: 'equirect.html' },
	cubemap: { label: 'Cubemap', page: 'cubemap.html' },
	'from-scene': { label: 'From scene', page: 'from-scene.html' },
	transmission: { label: 'Transmission', page: 'transmission.html' },
};

function setHud( title, mode, status ) {
	const hud = document.getElementById( 'hud' );
	if ( ! hud ) return;

	hud.innerHTML = `
		<div class="hud-title">${ title }</div>
		<div class="hud-status">${ MODES[ mode ].label } - ${ status }</div>
		<nav class="hud-links" aria-label="PMREM scenes">
			${ Object.entries( MODES ).map( ( [ key, item ] ) => `<a href="${ item.page }" ${ key === mode ? 'aria-current="page"' : '' }>${ item.label }</a>` ).join( '' ) }
		</nav>
	`;
}

function attachPrecompileSource( material, object, scene ) {
	material.__tslpPrecompileObject = object;
	material.__tslpPrecompileScene = scene;
}

function makeStripeCanvas( width, height, stops ) {
	const canvas = document.createElement( 'canvas' );
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext( '2d' );
	const gradient = ctx.createLinearGradient( 0, 0, width, height );
	for ( const [ at, color ] of stops ) gradient.addColorStop( at, color );
	ctx.fillStyle = gradient;
	ctx.fillRect( 0, 0, width, height );

	ctx.fillStyle = 'rgba(255,255,255,0.22)';
	for ( let x = 0; x < width; x += width / 8 ) ctx.fillRect( x, 0, 2, height );
	for ( let y = 0; y < height; y += height / 4 ) ctx.fillRect( 0, y, width, 2 );

	return canvas;
}

function makeEquirectTexture() {
	const texture = new CanvasTexture( makeStripeCanvas( 128, 64, [
		[ 0, '#163d7a' ],
		[ 0.22, '#16a6b8' ],
		[ 0.52, '#f3cf58' ],
		[ 0.78, '#e75f42' ],
		[ 1, '#23174f' ],
	] ) );
	texture.name = 'pmrem-debug-equirect-source';
	texture.mapping = EquirectangularReflectionMapping;
	texture.colorSpace = SRGBColorSpace;
	texture.needsUpdate = true;
	registerLiveTexture( texture );
	return texture;
}

function makeFaceCanvas( colorA, colorB ) {
	return makeStripeCanvas( 64, 64, [
		[ 0, colorA ],
		[ 0.55, colorB ],
		[ 1, '#10131b' ],
	] );
}

function makeCubeTexture() {
	const texture = new CubeTexture( [
		makeFaceCanvas( '#fa5c51', '#ffe071' ),
		makeFaceCanvas( '#2755ff', '#89f0ff' ),
		makeFaceCanvas( '#42c86b', '#f5ff8b' ),
		makeFaceCanvas( '#8c55ff', '#ff98e8' ),
		makeFaceCanvas( '#f2932f', '#ffe0b0' ),
		makeFaceCanvas( '#0e1d38', '#53a7ff' ),
	] );
	texture.name = 'pmrem-debug-cube-source';
	texture.mapping = CubeReflectionMapping;
	texture.colorSpace = SRGBColorSpace;
	texture.needsUpdate = true;
	registerLiveTexture( texture );
	return texture;
}

function addEnvironmentSceneObjects( scene ) {
	const colors = [ 0xff5b4a, 0x4ed0ff, 0xffde67, 0x75d56b ];
	const positions = [
		[ - 4, 0, - 3 ],
		[ 4, 1.5, - 2 ],
		[ - 3, 3, 3 ],
		[ 3, - 1, 2 ],
	];

	for ( let i = 0; i < colors.length; i += 1 ) {
		const material = new MeshBasicMaterial( { color: colors[ i ], side: BackSide } );
		const mesh = new Mesh( new PlaneGeometry( 5, 5 ), material );
		mesh.position.set( ...positions[ i ] );
		mesh.lookAt( 0, 0, 0 );
		scene.add( mesh );
	}
}

function addSceneGeometry( scene, { transmission = false } = {} ) {
	const floorMaterial = new MeshStandardNodeMaterial( {
		color: new Color( 0x46515f ),
		roughness: 0.78,
		metalness: 0.0,
	} );
	const floor = new Mesh( new PlaneGeometry( 8, 8 ), floorMaterial );
	floor.name = 'pmrem-debug-floor';
	floor.rotation.x = - Math.PI / 2;
	floor.position.y = - 0.8;
	scene.add( floor );
	attachPrecompileSource( floorMaterial, floor, scene );
	if ( ! IS_E2E_REPLAY ) floorMaterial.precompile( 'pmrem-debug-floor' );

	const metalMaterial = new MeshStandardNodeMaterial( {
		color: new Color( 0xf6d66a ),
		roughness: 0.18,
		metalness: 1.0,
	} );
	const metalSphere = new Mesh( new SphereGeometry( 0.58, 64, 32 ), metalMaterial );
	metalSphere.name = 'pmrem-debug-metal-sphere';
	metalSphere.position.set( - 0.85, 0, 0 );
	scene.add( metalSphere );
	attachPrecompileSource( metalMaterial, metalSphere, scene );
	if ( ! IS_E2E_REPLAY ) metalMaterial.precompile( 'pmrem-debug-metal' );

	const roughMaterial = new MeshStandardNodeMaterial( {
		color: new Color( 0x7bb2ff ),
		roughness: 0.62,
		metalness: 0.85,
	} );
	const roughSphere = new Mesh( new SphereGeometry( 0.58, 64, 32 ), roughMaterial );
	roughSphere.name = 'pmrem-debug-rough-sphere';
	roughSphere.position.set( 0.85, 0, 0 );
	scene.add( roughSphere );
	attachPrecompileSource( roughMaterial, roughSphere, scene );
	if ( ! IS_E2E_REPLAY ) roughMaterial.precompile( 'pmrem-debug-rough' );

	if ( transmission ) {
		const glassMaterial = new MeshPhysicalNodeMaterial( {
			color: new Color( 0xc7efff ),
			roughness: 0.05,
			metalness: 0.0,
			transmission: 1.0,
			thickness: 0.55,
			ior: 1.45,
			transparent: true,
		} );
		const glass = new Mesh( new BoxGeometry( 0.95, 0.95, 0.95 ), glassMaterial );
		glass.name = 'pmrem-debug-transmission-box';
		glass.position.set( 0, 0.02, 0.65 );
		scene.add( glass );
		attachPrecompileSource( glassMaterial, glass, scene );
		if ( ! IS_E2E_REPLAY ) glassMaterial.precompile( 'pmrem-debug-transmission' );
	}

	return { metalSphere, roughSphere };
}

async function makeFromSceneTexture( renderer ) {
	const envScene = new Scene();
	envScene.background = new Color( 0x161b28 );
	addEnvironmentSceneObjects( envScene );

	const pmrem = new PMREMGenerator( renderer );
	const target = pmrem.fromScene( envScene, 0.02, 0.1, 20, { size: 64 } );
	target.texture.name = 'pmrem-debug-from-scene-texture';
	registerLiveTexture( target.texture );
	pmrem.dispose();
	return target.texture;
}

function applyEnvironment( scene, texture, mode ) {
	scene.environment = texture;
	scene.background = mode === 'from-scene' ? new Color( 0x14171c ) : texture;
	scene.environmentIntensity = mode === 'transmission' ? 1.6 : 1.25;
	scene.backgroundIntensity = 0.85;
	scene.backgroundBlurriness = mode === 'cubemap' ? 0.25 : 0.1;
	scene.backgroundRotation.y = mode === 'cubemap' ? 0.7 : 0.25;
}

export async function runPMREMDebugExample( {
	mode = 'equirect',
	title = `${ MODES[ mode ]?.label || mode } PMREM`,
} = {} ) {
	if ( ! MODES[ mode ] ) throw new Error( `[pmrem-debug] unknown mode: ${ mode }` );
	setHud( title, mode, 'starting' );

	const renderer = new WebGPURenderer( { antialias: true } );
	renderer.setPixelRatio( Math.min( 2, window.devicePixelRatio || 1 ) );
	renderer.setSize( window.innerWidth, window.innerHeight );
	renderer.setClearColor( 0x14171c );
	document.body.appendChild( renderer.domElement );

	await renderer.init();

	installPrecompileMarker( THREE, { devEndpoint: CAPTURE_ENDPOINT } );
	setDevRenderer( renderer );

	const scene = new Scene();
	const camera = new PerspectiveCamera( 45, window.innerWidth / window.innerHeight, 0.1, 50 );
	camera.position.set( 3.3, 1.8, 4.2 );
	camera.lookAt( 0, 0, 0 );

	let environmentTexture;
	if ( mode === 'cubemap' ) environmentTexture = makeCubeTexture();
	else if ( mode === 'from-scene' ) environmentTexture = await makeFromSceneTexture( renderer );
	else environmentTexture = makeEquirectTexture();

	applyEnvironment( scene, environmentTexture, mode );

	scene.add( new AmbientLight( 0xffffff, 0.03 ) );
	const light = new DirectionalLight( 0xffffff, mode === 'transmission' ? 1.2 : 0.45 );
	light.position.set( 3, 4, 2 );
	scene.add( light );

	const objects = addSceneGeometry( scene, { transmission: mode === 'transmission' } );

	const auxResults = await precompileAuxiliary( renderer, scene, camera, {
		devEndpoint: CAPTURE_ENDPOINT,
		three: THREE,
		threeVersion: globalThis.__TSLP_THREE_PACKAGE_VERSION__ || String( THREE.REVISION ).match( /^\d+/ )[ 0 ],
	} ).catch( ( err ) => {
		console.warn( '[pmrem-debug] auxiliary capture failed:', err );
		return [ { shape: 'aux', ok: false, error: err && err.message || String( err ) } ];
	} );

	const auxSummary = auxResults.map( ( r ) => `${ r.shape }:${ r.ok ? 'ok' : 'err' }` ).join( ', ' ) || 'no aux';
	setHud( title, mode, `rendering - ${ auxSummary }` );

	renderer.setAnimationLoop( () => {
		objects.metalSphere.rotation.y = 0;
		objects.roughSphere.rotation.y = 0;
		renderer.render( scene, camera );
	} );

	window.addEventListener( 'resize', () => {
		camera.aspect = window.innerWidth / window.innerHeight;
		camera.updateProjectionMatrix();
		renderer.setSize( window.innerWidth, window.innerHeight );
	} );
}
