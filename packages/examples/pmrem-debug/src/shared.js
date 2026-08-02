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
	PerspectiveCamera,
	PlaneGeometry,
	Scene,
	SphereGeometry,
	SRGBColorSpace,
} from 'three';
import { WebGPURenderer, MeshBasicNodeMaterial, MeshPhysicalNodeMaterial, MeshStandardNodeMaterial, PMREMGenerator } from 'three/webgpu';
import { bindAuxByName, registerLiveTexture } from '@tsl-precompile/runtime';

const CAPTURE_ENDPOINT = window.__TSLP_E2E?.captureEndpoint || '/__tsl-precompile/capture';
const IS_E2E_REPLAY = window.__TSLP_E2E?.mode === 'replay';
const SHARED_DIRECTIONAL_LIGHT_INTENSITY = 0.45;
const SHARED_ENVIRONMENT_INTENSITY = 1.25;

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
		const material = new MeshBasicNodeMaterial( { color: colors[ i ], side: BackSide } );
		const mesh = new Mesh( new PlaneGeometry( 5, 5 ), material );
		mesh.position.set( ...positions[ i ] );
		mesh.lookAt( 0, 0, 0 );
		scene.add( mesh );
		attachPrecompileSource( material, mesh, scene );
		if ( ! IS_E2E_REPLAY ) {
			// Capture names are part of the durable artifact identity, so the
			// transform requires literal arguments at every call site.
			if ( i === 0 ) material.precompile( 'pmrem-debug-env-face-0' );
			else if ( i === 1 ) material.precompile( 'pmrem-debug-env-face-1' );
			else if ( i === 2 ) material.precompile( 'pmrem-debug-env-face-2' );
			else material.precompile( 'pmrem-debug-env-face-3' );
		}
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

async function makeFromSceneTarget( renderer ) {
	const envScene = new Scene();
	envScene.background = new Color( 0x161b28 );
	addEnvironmentSceneObjects( envScene );

	const pmrem = new PMREMGenerator( renderer );
	const target = pmrem.fromScene( envScene, 0.02, 0.1, 20, { size: 64 } );
	target.texture.name = 'pmrem-debug-from-scene-texture';
	registerLiveTexture( target.texture );
	pmrem.dispose();
	return target;
}

function makeTextureTarget( renderer, sourceTexture, mode ) {
	const pmrem = new PMREMGenerator( renderer );
	const target = mode === 'cubemap'
		? pmrem.fromCubemap( sourceTexture )
		: pmrem.fromEquirectangular( sourceTexture );
	target.texture.name = `pmrem-debug-${ mode }-texture`;
	registerLiveTexture( target.texture );
	pmrem.dispose();
	return target;
}

function applyEnvironment( scene, environmentTexture, backgroundTexture, mode ) {
	scene.environment = environmentTexture;
	scene.background = mode === 'from-scene' ? new Color( 0x14171c ) : backgroundTexture;
	scene.environmentIntensity = SHARED_ENVIRONMENT_INTENSITY;
	scene.backgroundIntensity = 0.85;
	scene.backgroundBlurriness = mode === 'cubemap' ? 0.25 : 0.1;
	scene.backgroundRotation.y = mode === 'cubemap' ? 0.7 : 0.25;
}

export async function runPMREMDebugExample( {
	mode = 'equirect',
	title = `${ MODES[ mode ]?.label || mode } PMREM`,
} = {} ) {
	if ( ! MODES[ mode ] ) throw new Error( `[pmrem-debug] unknown mode: ${ mode }` );
	globalThis.__TSLP_SITE_DOMAIN__ = null;
	setHud( title, mode, 'starting' );

	const renderer = new WebGPURenderer( { antialias: true } );
	renderer.setPixelRatio( Math.min( 2, window.devicePixelRatio || 1 ) );
	renderer.setSize( window.innerWidth, window.innerHeight );
	renderer.setClearColor( 0x14171c );
	document.body.appendChild( renderer.domElement );

	await renderer.init();

	// Keep the compiler/capture helpers out of production. Vite folds this
	// branch away in a source-slim build; the raw batch capture harness has no
	// import.meta.env and therefore still exercises the development branch.
	let captureRuntime = null;
	let captureThree = null;
	if ( import.meta.env?.PROD !== true && ! IS_E2E_REPLAY ) {

		[ captureRuntime, captureThree ] = await Promise.all( [
			import( '@tsl-precompile/runtime' ),
			// Auxiliary PMREM capture must use Three's WebGPU PMREMGenerator;
			// the root `three` export is the WebGL ShaderMaterial implementation.
			import( 'three/webgpu' ),
		] );
		captureRuntime.installPrecompileMarker( captureThree, { devEndpoint: CAPTURE_ENDPOINT } );
		captureRuntime.setDevRenderer( renderer );

	}

	const scene = new Scene();
	const camera = new PerspectiveCamera( 45, window.innerWidth / window.innerHeight, 0.1, 50 );
	camera.position.set( 3.3, 1.8, 4.2 );
	camera.lookAt( 0, 0, 0 );

	let environmentSource = null;
	let environmentTarget;
	if ( mode === 'from-scene' ) {

		environmentTarget = await makeFromSceneTarget( renderer );

	} else {

		environmentSource = mode === 'cubemap' ? makeCubeTexture() : makeEquirectTexture();
		// This explicit call is the production proof: `three/webgpu` resolves to
		// the compiler-free PMREMGenerator, which replays generated
		// internal-pass artifacts instead of relying on renderer internals.
		environmentTarget = makeTextureTarget( renderer, environmentSource, mode );

	}

	const pmremReplayReceipt = {
		type: 'pmrem',
		mode,
		generated: Boolean( environmentTarget?.texture ),
		isPMREMTexture: environmentTarget?.texture?.isPMREMTexture === true,
		width: environmentTarget?.width,
		height: environmentTarget?.height,
		renderFrames: 0,
		outputBound: false,
	};
	globalThis.__TSLP_SITE_DOMAIN__ = pmremReplayReceipt;
	applyEnvironment( scene, environmentTarget.texture, environmentSource, mode );
	if ( import.meta.env?.PROD === true && scene.background?.isTexture === true ) {

		bindAuxByName(
			scene.background,
			'background',
			mode === 'cubemap' ? 'pmrem-debug-background-cubemap' : 'pmrem-debug-background-equirect',
		);

	}

	scene.add( new AmbientLight( 0xffffff, 0.03 ) );
	// These names deliberately span every route. The atlas UUID, dimensions,
	// and addressing scalars form one live relation, so recapture must merge
	// topology-equivalent environments without freezing route-owned values.
	const light = new DirectionalLight( 0xffffff, SHARED_DIRECTIONAL_LIGHT_INTENSITY );
	light.position.set( 3, 4, 2 );
	scene.add( light );

	const objects = addSceneGeometry( scene, {
		transmission: mode === 'transmission',
	} );

	// Context-free .precompile() markers are intentionally claimed only by an
	// author-visible render. Drive that render before awaiting auxiliary PMREM
	// capture; otherwise the marker wait and the auxiliary sweep deadlock.
	if ( captureRuntime && ! IS_E2E_REPLAY ) renderer.render( scene, camera );

	const auxResults = captureRuntime ? await captureRuntime.precompileAuxiliary( renderer, scene, camera, {
		devEndpoint: CAPTURE_ENDPOINT,
		three: captureThree,
		threeVersion: globalThis.__TSLP_THREE_PACKAGE_VERSION__ || String( captureThree.REVISION ).match( /^\d+/ )[ 0 ],
		// A CubeUV result does not retain the fromScene request that produced
		// it, so declare this route's durable atlas layout explicitly.
		pmremSceneSizes: mode === 'from-scene' ? [ 64 ] : [],
		backgroundName: mode === 'from-scene'
			? undefined
			: mode === 'cubemap'
				? 'pmrem-debug-background-cubemap'
				: 'pmrem-debug-background-equirect',
	} ).catch( ( err ) => {
		console.warn( '[pmrem-debug] auxiliary capture failed:', err );
		return [ { shape: 'aux', ok: false, error: err && err.message || String( err ) } ];
	} ) : [];

	const auxSummary = auxResults.map( ( r ) => `${ r.shape }:${ r.ok ? 'ok' : 'err' }` ).join( ', ' ) || 'no aux';
	setHud( title, mode, `rendering - ${ auxSummary }` );

	renderer.setAnimationLoop( () => {
		objects.metalSphere.rotation.y = 0;
		objects.roughSphere.rotation.y = 0;
		renderer.render( scene, camera );
		pmremReplayReceipt.renderFrames += 1;
		pmremReplayReceipt.outputBound = scene.environment === environmentTarget.texture &&
			scene.environment?.isPMREMTexture === true;
	} );

	window.addEventListener( 'resize', () => {
		camera.aspect = window.innerWidth / window.innerHeight;
		camera.updateProjectionMatrix();
		renderer.setSize( window.innerWidth, window.innerHeight );
	} );

	window.addEventListener( 'pagehide', () => {
		// Stop rendering before releasing the environment target. Site live
		// routes run inside a reusable iframe, so unload can overlap an already
		// queued animation callback.
		renderer.setAnimationLoop( null );
		environmentTarget.dispose();
		renderer.dispose();
	}, { once: true } );
}
