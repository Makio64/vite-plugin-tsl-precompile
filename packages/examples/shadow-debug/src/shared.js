import {
	AmbientLight,
	BasicShadowMap,
	BoxGeometry,
	Color,
	DirectionalLight,
	Group,
	PCFShadowMap,
	PCFSoftShadowMap,
	PerspectiveCamera,
	PlaneGeometry,
	PointLight,
	Scene,
	SphereGeometry,
	SpotLight,
	VSMShadowMap,
} from 'three';
import { WebGPURenderer, Mesh, MeshStandardNodeMaterial } from 'three/webgpu';

const SHADOW_TYPES = {
	basic: { label: 'Basic', value: BasicShadowMap },
	pcf: { label: 'PCF', value: PCFShadowMap },
	'pcf-soft': { label: 'PCF Soft', value: PCFSoftShadowMap },
	vsm: { label: 'VSM', value: VSMShadowMap },
};

const LIGHT_LABELS = {
	directional: 'Directional',
	spot: 'Spot',
	point: 'Point',
};

const CAPTURE_ENDPOINT = window.__TSLP_E2E?.captureEndpoint || '/__tsl-precompile/capture';
const IS_E2E = !! window.__TSLP_E2E;
const IS_E2E_REPLAY = window.__TSLP_E2E?.mode === 'replay';

function shadowKindFromLocation( fallback ) {
	const requested = new URLSearchParams( window.location.search ).get( 'shadow' );
	return SHADOW_TYPES[ requested ] ? requested : fallback;
}

function setHud( title, shadowKind, status ) {
	const hud = document.getElementById( 'hud' );
	if ( ! hud ) return;

	const links = [
		[ 'directional.html', 'Directional' ],
		[ 'spot.html', 'Spot' ],
		[ 'point.html', 'Point' ],
		[ 'vsm.html', 'VSM' ],
	];
	const current = window.location.pathname.split( '/' ).pop();

	hud.innerHTML = `
		<div class="hud-title">${ title }</div>
		<div class="hud-status">${ SHADOW_TYPES[ shadowKind ].label } shadow map - ${ status }</div>
		<nav class="hud-links" aria-label="Debug scenes">
				${ links.map( ( [ href, label ] ) => `<a href="${ href }" ${ current === href ? 'aria-current="page"' : '' }>${ label }</a>` ).join( '' ) }
			${ Object.entries( SHADOW_TYPES ).map( ( [ key, item ] ) => `<a href="?shadow=${ key }" ${ shadowKind === key ? 'aria-current="page"' : '' }>${ item.label }</a>` ).join( '' ) }
		</nav>
	`;
}

function makeMaterial( color, roughness = 0.55 ) {
	return new MeshStandardNodeMaterial( {
		color: new Color( color ),
		roughness,
		metalness: 0.0,
	} );
}

function attachPrecompileSource( material, object, scene ) {
	material.__tslpPrecompileObject = object;
	material.__tslpPrecompileScene = scene;
}

function precompileShadowMaterial( material, object, scene, lightKind, role ) {

	attachPrecompileSource( material, object, scene );

	// Point-light shadow shaders have a different topology even when Three's
	// private material cache key collides with directional/spot captures. Keep
	// each light family under an explicit, build-time name so signed artifacts
	// never need to merge divergent payloads behind that private key.
	if ( role === 'floor' ) {

		if ( lightKind === 'point' ) material.precompile( 'shadow-debug-point-floor' );
		else if ( lightKind === 'spot' ) material.precompile( 'shadow-debug-spot-floor' );
		else material.precompile( 'shadow-debug-directional-floor' );

	} else if ( role === 'cube' ) {

		if ( lightKind === 'point' ) material.precompile( 'shadow-debug-point-cube' );
		else if ( lightKind === 'spot' ) material.precompile( 'shadow-debug-spot-cube' );
		else material.precompile( 'shadow-debug-directional-cube' );

	} else {

		if ( lightKind === 'point' ) material.precompile( 'shadow-debug-point-sphere' );
		else if ( lightKind === 'spot' ) material.precompile( 'shadow-debug-spot-sphere' );
		else material.precompile( 'shadow-debug-directional-sphere' );

	}

}

function addDebugGeometry( scene, lightKind ) {
	const group = new Group();
	group.name = 'shadow-casters';

	const floorMaterial = makeMaterial( 0x9b927f, 0.7 );
	const floor = new Mesh(
		new PlaneGeometry( 8, 8 ),
		floorMaterial,
	);
	floor.name = 'floor';
	floor.rotation.x = - Math.PI / 2;
	floor.receiveShadow = true;
	scene.add( floor );
	if ( ! IS_E2E_REPLAY ) {
		precompileShadowMaterial( floorMaterial, floor, scene, lightKind, 'floor' );
	}

	const cubeMaterial = makeMaterial( 0xd77f47, 0.45 );
	const cube = new Mesh(
		new BoxGeometry( 1, 1, 1 ),
		cubeMaterial,
	);
	cube.name = 'cube';
	cube.position.set( - 0.85, 0.75, 0 );
	cube.castShadow = true;
	cube.receiveShadow = true;
	group.add( cube );
	if ( ! IS_E2E_REPLAY ) {
		precompileShadowMaterial( cubeMaterial, cube, scene, lightKind, 'cube' );
	}

	const sphereMaterial = makeMaterial( 0x72a7d8, 0.35 );
	const sphere = new Mesh(
		new SphereGeometry( 0.5, 32, 16 ),
		sphereMaterial,
	);
	sphere.name = 'sphere';
	sphere.position.set( 0.85, 0.75, 0.15 );
	sphere.castShadow = true;
	sphere.receiveShadow = true;
	group.add( sphere );
	if ( ! IS_E2E_REPLAY ) {
		precompileShadowMaterial( sphereMaterial, sphere, scene, lightKind, 'sphere' );
	}

	scene.add( group );
	return group;
}

function configureLightShadow( light, mapSize = 1024 ) {
	light.castShadow = true;
	light.shadow.mapSize.set( mapSize, mapSize );
	light.shadow.bias = - 0.0002;
	light.shadow.normalBias = 0.02;
	light.shadow.radius = 2;
	light.shadow.intensity = 0.45;
	if ( 'blurSamples' in light.shadow ) light.shadow.blurSamples = 8;
}

function makeLight( lightKind, scene ) {
	const target = new Group();
	target.name = `${ lightKind }-target`;
	target.position.set( 0, 0, 0 );
	scene.add( target );

	if ( lightKind === 'directional' ) {
		const light = new DirectionalLight( 0xffffff, 3.2 );
		light.name = 'debug-directional-light';
		light.position.set( 3, 5, 2.5 );
		light.target = target;
		configureLightShadow( light );
		light.shadow.camera.near = 0.5;
		light.shadow.camera.far = 12;
		light.shadow.camera.left = - 4;
		light.shadow.camera.right = 4;
		light.shadow.camera.top = 4;
		light.shadow.camera.bottom = - 4;
		scene.add( light );
		return light;
	}

	if ( lightKind === 'spot' ) {
		const light = new SpotLight( 0xffffff, 180, 10, Math.PI / 5, 0.25, 1.5 );
		light.name = 'debug-spot-light';
		light.position.set( 2.5, 4.5, 2.5 );
		light.target = target;
		configureLightShadow( light );
		light.shadow.camera.near = 0.5;
		light.shadow.camera.far = 12;
		scene.add( light );
		return light;
	}

	const light = new PointLight( 0xffffff, 65, 8, 1.5 );
	light.name = 'debug-point-light';
	light.position.set( 0, 3.2, 2.2 );
	configureLightShadow( light, 512 );
	light.shadow.camera.near = 0.25;
	light.shadow.camera.far = 8;
	scene.add( light );
	return light;
}

export async function runShadowDebugExample( {
	lightKind = 'directional',
	shadowKind: requestedShadowKind = 'pcf',
	title = `${ LIGHT_LABELS[ lightKind ] } shadow`,
	} = {} ) {
	const shadowKind = shadowKindFromLocation( requestedShadowKind );
	setHud( title, shadowKind, 'starting' );

	const renderer = new WebGPURenderer( { antialias: true } );
	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type = SHADOW_TYPES[ shadowKind ].value;
	renderer.setPixelRatio( Math.min( 2, window.devicePixelRatio || 1 ) );
	renderer.setSize( window.innerWidth, window.innerHeight );
	renderer.setClearColor( 0x14171c );
	document.body.appendChild( renderer.domElement );

	await renderer.init();

	// Capture-only helpers must not make the production renderer retain the
	// broad Three namespace. Vite folds this branch away in a slim source build;
	// the raw batch harness has no import.meta.env and still exercises capture.
	let captureRuntime = null;
	let captureThree = null;
	if ( import.meta.env?.PROD !== true ) {

		[ captureRuntime, captureThree ] = await Promise.all( [
			import( '@tsl-precompile/runtime' ),
			import( 'three' ),
		] );
		captureRuntime.installPrecompileMarker( captureThree, { devEndpoint: CAPTURE_ENDPOINT } );
		captureRuntime.setDevRenderer( renderer );

	}

	const scene = new Scene();

	const camera = new PerspectiveCamera( 45, window.innerWidth / window.innerHeight, 0.1, 50 );
	camera.position.set( 4, 3, 5 );
	camera.lookAt( 0, 0.5, 0 );

	scene.add( new AmbientLight( 0xffffff, 0.08 ) );
	const casters = addDebugGeometry( scene, lightKind );
	makeLight( lightKind, scene );

	const auxResults = captureRuntime ? await captureRuntime.precompileAuxiliary( renderer, scene, camera, {
		devEndpoint: CAPTURE_ENDPOINT,
		three: captureThree,
		threeVersion: globalThis.__TSLP_THREE_PACKAGE_VERSION__ || String( captureThree.REVISION ).match( /^\d+/ )[ 0 ],
	} ).catch( ( err ) => {
		console.warn( '[shadow-debug] auxiliary capture failed:', err );
		return [ { shape: 'aux', ok: false, error: err && err.message || String( err ) } ];
	} ) : [];

	const auxSummary = auxResults.map( ( r ) => `${ r.shape }:${ r.ok ? 'ok' : 'err' }` ).join( ', ' ) || 'no aux';
	setHud( title, shadowKind, IS_E2E ? 'rendering' : `rendering - ${ auxSummary }` );

	function tick() {
		casters.rotation.y = 0;
		renderer.render( scene, camera );
	}

	renderer.setAnimationLoop( tick );

	window.addEventListener( 'resize', () => {
		camera.aspect = window.innerWidth / window.innerHeight;
		camera.updateProjectionMatrix();
		renderer.setSize( window.innerWidth, window.innerHeight );
	} );
}
