import test from 'node:test';
import assert from 'node:assert/strict';
import * as Three from 'three';

import { disposeShadowMapsWithFullRenderer, populateShadowMapsWithFullRenderer } from '../src/slim-support/shadow-fallback.js';

const TEST_GPU_DEVICE = { queue: { onSubmittedWorkDone: async () => {} } };

function makeDataMap() {

	const map = new WeakMap();
	return {
		get( key ) {

			let value = map.get( key );
			if ( ! value ) {

				value = {};
				map.set( key, value );

			}
			return value;

		},
	};

}

function fakeRenderer( { populateShadows = false, device = TEST_GPU_DEVICE, reversedDepthBuffer = false } = {} ) {

	const backendData = makeDataMap();
	const textureData = makeDataMap();
	let renderTarget = { name: 'previous-target' };
	let shadowSerial = 0;
	const renderer = {
		reversedDepthBuffer,
		backend: {
			device,
			get: ( value ) => backendData.get( value ),
		},
		_textures: { get: ( value ) => textureData.get( value ) },
		shadowMap: { enabled: false, type: Three.PCFShadowMap, transmitted: false },
		renderCalls: [],
		getRenderTarget: () => renderTarget,
		setRenderTarget: ( value ) => { renderTarget = value; },
		async render( scene, camera ) {

			this.renderCalls.push( { scene, camera, target: renderTarget } );
			if ( ! populateShadows ) return;
			scene.traverse( ( light ) => {

				if ( light.isLight !== true || light.castShadow !== true || ! light.shadow ) return;
				if ( light.shadow.autoUpdate === false && light.shadow.needsUpdate !== true ) return;
				if ( ! light.shadow.map ) {

					const depthTexture = new Three.DepthTexture( 32, 32 );
					depthTexture.name = `depth-${ ++ shadowSerial }`;
					light.shadow.map = { depthTexture };
					light.shadow.matrix.__shadowFallbackTest = shadowSerial;
					const data = backendData.get( depthTexture );
					data.texture = { label: depthTexture.name, depthOrArrayLayers: light.isPointLight ? 6 : 1 };
					data.format = 'depth24plus';

				}
				light.shadow.needsUpdate = false;

			} );

		},
	};
	return renderer;

}

function makeShadowScene( material = new Three.MeshLambertMaterial() ) {

	const scene = new Three.Scene();
	const mesh = new Three.Mesh( new Three.BoxGeometry( 1, 1, 1 ), material );
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	const light = new Three.DirectionalLight( 0xffffff, 2 );
	light.castShadow = true;
	light.position.set( 2, 4, 3 );
	scene.add( mesh, light, light.target );
	const camera = new Three.PerspectiveCamera( 50, 1, 0.1, 20 );
	camera.position.z = 5;
	scene.add( camera );
	scene.updateMatrixWorld( true );
	return { scene, mesh, light, camera };

}

function trackDispose( value ) {

	let calls = 0;
	const original = value && typeof value.dispose === 'function' ? value.dispose.bind( value ) : null;
	value.dispose = () => {

		calls ++;
		if ( original ) original();

	};
	return () => calls;

}

function proxyResources( fullRenderer ) {

	const proxyScene = fullRenderer.renderCalls[ 0 ].scene;
	let mesh = null;
	let light = null;
	proxyScene.traverse( ( object ) => {

		if ( object.isMesh === true && ! mesh ) mesh = object;
		if ( object.isLight === true && object.castShadow === true && ! light ) light = object;

	} );
	return { proxyScene, mesh, light, renderTarget: fullRenderer.renderCalls[ 0 ].target };

}

test( 'populateShadowMapsWithFullRenderer mirrors a standard light/caster and shares its depth GPU texture', async () => {

	const { scene, light, camera } = makeShadowScene();
	const slim = fakeRenderer();
	const full = fakeRenderer( { populateShadows: true } );
	const previousTarget = full.getRenderTarget();

	const result = await populateShadowMapsWithFullRenderer( {
		scene,
		camera,
		slimRenderer: slim,
		fullRenderer: full,
		threeFullModule: Three,
		cache: new WeakMap(),
	} );

	assert.equal( result.rendered, true );
	assert.equal( result.complete, true );
	assert.equal( result.lightsPopulated, 1 );
	assert.equal( result.castersMirrored, 1 );
	assert.equal( result.receiversMirrored, 1 );
	assert.equal( result.texturesShared, 1 );
	assert.deepEqual( result.unsupported, [] );
	assert.equal( full.renderCalls.length, 2, 'the full renderer gets both lazy shadow warm-up renders' );
	assert.notEqual( full.renderCalls[ 0 ].scene, scene, 'the full renderer sees a full-native proxy scene' );
	assert.equal( full.getRenderTarget(), previousTarget, 'the caller-owned full renderer target is restored' );
	assert.ok( light.shadow.map && light.shadow.map.depthTexture );
	const depthTexture = light.shadow.map.depthTexture;
	assert.equal( slim.backend.get( depthTexture ).texture, full.backend.get( depthTexture ).texture );
	assert.equal( slim.backend.get( depthTexture ).__tslpSharedShadowGPUTexture, full.backend.get( depthTexture ).texture );

} );

test( 'populateShadowMapsWithFullRenderer explicitly populates a new static shadow map', async () => {

	const { scene, light, camera } = makeShadowScene();
	light.shadow.autoUpdate = false;
	light.shadow.needsUpdate = false;
	const full = fakeRenderer( { populateShadows: true } );

	const result = await populateShadowMapsWithFullRenderer( {
		scene,
		camera,
		slimRenderer: fakeRenderer(),
		fullRenderer: full,
		threeFullModule: Three,
		cache: new WeakMap(),
	} );

	assert.equal( result.complete, true );
	assert.equal( result.lightsPopulated, 1 );
	assert.ok( light.shadow.map && light.shadow.map.depthTexture );

} );

test( 'populateShadowMapsWithFullRenderer de-duplicates unchanged state and invalidates every copied shadow input', async () => {

	const { scene, mesh, light, camera } = makeShadowScene();
	const slim = fakeRenderer();
	const full = fakeRenderer( { populateShadows: true } );
	const cache = new WeakMap();
	const opts = { scene, camera, slimRenderer: slim, fullRenderer: full, threeFullModule: Three, cache };
	light.shadow.autoUpdate = false;

	const first = await populateShadowMapsWithFullRenderer( opts );
	const proxyScene = full.renderCalls[ 0 ].scene;
	const second = await populateShadowMapsWithFullRenderer( opts );

	assert.equal( first.complete, true );
	assert.equal( second.reused, true );
	assert.equal( full.renderCalls.length, 2, 'unchanged state does not rerender shadows' );

	mesh.position.x = 2;
	scene.updateMatrixWorld( true );
	const moved = await populateShadowMapsWithFullRenderer( opts );
	assert.equal( moved.complete, true );
	assert.equal( moved.proxyReused, true );
	assert.equal( full.renderCalls.length, 4 );
	assert.equal( full.renderCalls[ 2 ].scene, proxyScene, 'motion refreshes the cached proxy instead of rebuilding it' );

	light.shadow.camera.far = 47;
	const shadowCameraChanged = await populateShadowMapsWithFullRenderer( opts );
	assert.equal( shadowCameraChanged.complete, true );
	assert.equal( shadowCameraChanged.proxyReused, true );
	assert.equal( full.renderCalls.length, 6, 'shadow-camera projection changes cannot reuse stale maps' );
	let proxyLight = null;
	full.renderCalls[ 4 ].scene.traverse( ( object ) => {

		if ( object.isDirectionalLight === true ) proxyLight = object;

	} );
	assert.equal( proxyLight.shadow.camera.far, 47 );

	mesh.material.transparent = true;
	mesh.material.opacity = 0.4;
	const materialChanged = await populateShadowMapsWithFullRenderer( opts );
	assert.equal( materialChanged.complete, true );
	assert.equal( materialChanged.proxyReused, false, 'copied material state rebuilds the proxy material' );
	assert.equal( full.renderCalls.length, 8 );

} );

test( 'shadow fallback disposes the previous owned proxy on topology rebuild and restores source shadow references', async () => {

	const { scene, mesh, light, camera } = makeShadowScene();
	const original = {
		map: light.shadow.map,
		camera: light.shadow.camera,
		matrix: light.shadow.matrix,
	};
	const full = fakeRenderer( { populateShadows: true } );
	const cache = new Map();
	const opts = { scene, camera, slimRenderer: fakeRenderer(), fullRenderer: full, threeFullModule: Three, cache };

	await populateShadowMapsWithFullRenderer( opts );
	const first = proxyResources( full );
	const geometryDisposes = trackDispose( first.mesh.geometry );
	const materialDisposes = trackDispose( first.mesh.material );
	const shadowDisposes = trackDispose( first.light.shadow );
	const targetDisposes = trackDispose( first.renderTarget );

	mesh.material.transparent = true;
	mesh.material.opacity = 0.5;
	await populateShadowMapsWithFullRenderer( opts );

	assert.equal( geometryDisposes(), 1 );
	assert.equal( materialDisposes(), 1 );
	assert.equal( shadowDisposes(), 1 );
	assert.equal( targetDisposes(), 1 );
	assert.notEqual( full.renderCalls[ 2 ].target, first.renderTarget );

	assert.equal( disposeShadowMapsWithFullRenderer( { scene, cache } ), true );
	assert.equal( light.shadow.map, original.map );
	assert.equal( light.shadow.camera, original.camera );
	assert.equal( light.shadow.matrix, original.matrix );
	assert.equal( disposeShadowMapsWithFullRenderer( { scene, cache } ), false, 'disposal is idempotent after cache removal' );

} );

test( 'shadow fallback never disposes caller-mapped materials or caller-owned render targets', async () => {

	const source = new Three.MeshLambertMaterial();
	source.positionNode = { isNode: true };
	const mapped = new Three.MeshLambertMaterial();
	mapped.positionNode = source.positionNode;
	const mappedDisposes = trackDispose( mapped );
	const callerTarget = new Three.RenderTarget( 8, 8 );
	const targetDisposes = trackDispose( callerTarget );
	const { scene, light, camera } = makeShadowScene( source );
	const external = {
		map: { external: 'map' },
		camera: { external: 'camera' },
		matrix: { external: 'matrix' },
	};
	const cache = new Map();
	await populateShadowMapsWithFullRenderer( {
		scene,
		camera,
		slimRenderer: fakeRenderer(),
		fullRenderer: fakeRenderer( { populateShadows: true } ),
		threeFullModule: Three,
		resolveShadowMaterial: () => mapped,
		renderTarget: callerTarget,
		cache,
	} );

	light.shadow.map = external.map;
	light.shadow.camera = external.camera;
	light.shadow.matrix = external.matrix;
	assert.equal( disposeShadowMapsWithFullRenderer( { scene, cache } ), true );
	assert.equal( mappedDisposes(), 0 );
	assert.equal( targetDisposes(), 0 );
	assert.equal( light.shadow.map, external.map, 'caller replacement is not overwritten during cleanup' );
	assert.equal( light.shadow.camera, external.camera );
	assert.equal( light.shadow.matrix, external.matrix );

} );

test( 'shadow fallback releases cached ownership when the full renderer or module changes', async () => {

	const { scene, camera } = makeShadowScene();
	const slim = fakeRenderer();
	const firstFull = fakeRenderer( { populateShadows: true } );
	const cache = new Map();
	await populateShadowMapsWithFullRenderer( { scene, camera, slimRenderer: slim, fullRenderer: firstFull, threeFullModule: Three, cache } );
	const first = proxyResources( firstFull );
	const geometryDisposes = trackDispose( first.mesh.geometry );
	const shadowDisposes = trackDispose( first.light.shadow );
	const targetDisposes = trackDispose( first.renderTarget );
	const secondFull = fakeRenderer( { populateShadows: true } );
	const secondModule = { ...Three };

	const result = await populateShadowMapsWithFullRenderer( {
		scene,
		camera,
		slimRenderer: slim,
		fullRenderer: secondFull,
		threeFullModule: secondModule,
		cache,
	} );

	assert.equal( result.complete, true );
	assert.equal( geometryDisposes(), 1 );
	assert.equal( shadowDisposes(), 1 );
	assert.equal( targetDisposes(), 1 );

} );

test( 'shadow fallback cleans resources allocated before a partial proxy-build failure', async () => {

	const geometries = [];
	const materials = [];
	const shadows = [];
	class TrackingGeometry extends Three.BufferGeometry {

		constructor() { super(); this.disposeCalls = 0; geometries.push( this ); }
		dispose() { this.disposeCalls ++; super.dispose(); }

	}
	class TrackingMaterial extends Three.MeshLambertMaterial {

		constructor( ...args ) { super( ...args ); this.disposeCalls = 0; materials.push( this ); }
		dispose() { this.disposeCalls ++; super.dispose(); }

	}
	class TrackingDirectionalLight extends Three.DirectionalLight {

		constructor( ...args ) {

			super( ...args );
			const originalDispose = this.shadow.dispose.bind( this.shadow );
			this.shadow.disposeCalls = 0;
			this.shadow.dispose = () => { this.shadow.disposeCalls ++; originalDispose(); };
			shadows.push( this.shadow );

		}

	}
	const Full = { ...Three, BufferGeometry: TrackingGeometry, MeshLambertMaterial: TrackingMaterial, DirectionalLight: TrackingDirectionalLight };
	const { scene, camera } = makeShadowScene();
	const invalid = new Three.Mesh( new Three.BufferGeometry(), new Three.MeshLambertMaterial() );
	invalid.geometry.setAttribute( 'position', { itemSize: 3, array: null } );
	invalid.castShadow = true;
	scene.add( invalid );
	const full = fakeRenderer( { populateShadows: true } );

	const result = await populateShadowMapsWithFullRenderer( {
		scene,
		camera,
		slimRenderer: fakeRenderer(),
		fullRenderer: full,
		threeFullModule: Full,
		cache: new Map(),
	} );

	assert.equal( result.complete, false );
	assert.equal( full.renderCalls.length, 0 );
	assert.ok( geometries.length >= 2 );
	assert.ok( geometries.every( ( geometry ) => geometry.disposeCalls === 1 ) );
	assert.ok( materials.length >= 2 );
	assert.ok( materials.every( ( material ) => material.disposeCalls === 1 ) );
	assert.equal( shadows.length, 1 );
	assert.equal( shadows[ 0 ].disposeCalls, 1 );

} );

test( 'populateShadowMapsWithFullRenderer refreshes auto-updating shadows even when object state is unchanged', async () => {

	const { scene, camera } = makeShadowScene();
	const slim = fakeRenderer();
	const full = fakeRenderer( { populateShadows: true } );
	const opts = { scene, camera, slimRenderer: slim, fullRenderer: full, threeFullModule: Three, cache: new WeakMap() };

	const first = await populateShadowMapsWithFullRenderer( opts );
	const second = await populateShadowMapsWithFullRenderer( opts );

	assert.equal( first.complete, true );
	assert.equal( second.complete, true );
	assert.equal( second.reused, false );
	assert.equal( second.proxyReused, true );
	assert.equal( full.renderCalls.length, 4, 'autoUpdate preserves per-call shadow rendering for dynamic uniforms' );

} );

test( 'dispose during an in-flight populate serializes immediate repopulation behind cleanup', async () => {

	const { scene, camera } = makeShadowScene();
	const slim = fakeRenderer();
	const full = fakeRenderer( { populateShadows: true } );
	const cache = new Map();
	const originalRender = full.render.bind( full );
	let releaseFirstRender = null;
	let announceFirstRender = null;
	const firstRenderEntered = new Promise( ( resolve ) => { announceFirstRender = resolve; } );
	const firstRenderGate = new Promise( ( resolve ) => { releaseFirstRender = resolve; } );
	let renderInvocations = 0;
	let activeRenders = 0;
	let maxActiveRenders = 0;
	full.render = async ( ...args ) => {

		renderInvocations ++;
		activeRenders ++;
		maxActiveRenders = Math.max( maxActiveRenders, activeRenders );
		if ( renderInvocations === 1 ) {

			announceFirstRender();
			await firstRenderGate;

		}
		try {

			return await originalRender( ...args );

		} finally {

			activeRenders --;

		}

	};
	const opts = { scene, camera, slimRenderer: slim, fullRenderer: full, threeFullModule: Three, cache };
	const firstPopulate = populateShadowMapsWithFullRenderer( opts );
	await firstRenderEntered;
	const disposal = disposeShadowMapsWithFullRenderer( { scene, cache } );
	assert.ok( disposal && typeof disposal.then === 'function' );
	const repopulate = populateShadowMapsWithFullRenderer( opts );
	await Promise.resolve();
	assert.equal( renderInvocations, 1, 'the replacement state cannot start while the disposed state is rendering' );

	releaseFirstRender();
	const [ first, disposed, replacement ] = await Promise.all( [ firstPopulate, disposal, repopulate ] );
	assert.equal( first.complete, false );
	assert.equal( disposed, true );
	assert.equal( replacement.complete, true );
	assert.equal( maxActiveRenders, 1 );
	assert.equal( renderInvocations, 4, 'two warm-up renders finish before the replacement performs its two renders' );

} );

test( 'populateShadowMapsWithFullRenderer ignores casters hidden by an ancestor', async () => {

	const { scene, mesh, camera } = makeShadowScene();
	const hidden = new Three.Group();
	hidden.visible = false;
	scene.add( hidden );
	hidden.add( mesh );
	const full = fakeRenderer( { populateShadows: true } );

	const result = await populateShadowMapsWithFullRenderer( {
		scene,
		camera,
		slimRenderer: fakeRenderer(),
		fullRenderer: full,
		threeFullModule: Three,
		cache: new WeakMap(),
	} );

	assert.equal( result.rendered, false );
	assert.equal( result.castersMirrored, 0 );
	assert.equal( full.renderCalls.length, 0 );

} );

test( 'populateShadowMapsWithFullRenderer fails closed for an opaque node-displaced caster', async () => {

	const material = new Three.MeshLambertMaterial();
	material.positionNode = { isNode: true };
	const { scene, camera } = makeShadowScene( material );
	const slim = fakeRenderer();
	const full = fakeRenderer( { populateShadows: true } );

	const result = await populateShadowMapsWithFullRenderer( {
		scene,
		camera,
		slimRenderer: slim,
		fullRenderer: full,
		threeFullModule: Three,
		cache: new WeakMap(),
	} );

	assert.equal( result.rendered, false );
	assert.equal( full.renderCalls.length, 0 );
	assert.ok( result.unsupported.some( ( entry ) => entry.reason === 'opaque-shadow-material' && entry.detail === 'positionNode' ) );

} );

test( 'populateShadowMapsWithFullRenderer fails closed for morphing caster state it cannot mirror', async () => {

	const { scene, mesh, camera } = makeShadowScene();
	const positions = mesh.geometry.getAttribute( 'position' );
	mesh.geometry.morphAttributes.position = [ positions.clone() ];
	mesh.updateMorphTargets();
	const full = fakeRenderer( { populateShadows: true } );

	const result = await populateShadowMapsWithFullRenderer( {
		scene,
		camera,
		slimRenderer: fakeRenderer(),
		fullRenderer: full,
		threeFullModule: Three,
		cache: new WeakMap(),
	} );

	assert.equal( result.rendered, false );
	assert.equal( full.renderCalls.length, 0 );
	assert.ok( result.unsupported.some( ( entry ) => entry.reason === 'morph-shadow-caster' ) );

} );

test( 'populateShadowMapsWithFullRenderer accepts an explicit full material for a node-displaced caster', async () => {

	const material = new Three.MeshLambertMaterial();
	material.positionNode = { isNode: true, label: 'terrain-displacement' };
	const mapped = new Three.MeshLambertMaterial();
	mapped.positionNode = material.positionNode;
	const { scene, camera } = makeShadowScene( material );
	const slim = fakeRenderer();
	const full = fakeRenderer( { populateShadows: true } );

	const result = await populateShadowMapsWithFullRenderer( {
		scene,
		camera,
		slimRenderer: slim,
		fullRenderer: full,
		threeFullModule: Three,
		resolveShadowMaterial: ( source ) => source === material ? mapped : null,
		cache: new WeakMap(),
	} );

	assert.equal( result.complete, true );
	let proxyCaster = null;
	full.renderCalls[ 0 ].scene.traverse( ( object ) => {

		if ( object.isMesh === true && object.castShadow === true ) proxyCaster = object;

	} );
	assert.ok( proxyCaster );
	assert.equal( proxyCaster.material, mapped );
	assert.equal( proxyCaster.material.positionNode, material.positionNode );

} );

test( 'populateShadowMapsWithFullRenderer exposes the precompiled wrapper to the full-material mapper', async () => {

	const source = new Three.MeshLambertMaterial();
	source.positionNode = { isNode: true, label: 'retained-source-node' };
	const wrapper = { isPrecompiledMaterial: true, __tslpSourceMaterial: source };
	const { scene, camera } = makeShadowScene( wrapper );
	const full = fakeRenderer( { populateShadows: true } );
	let mapperContext = null;

	const result = await populateShadowMapsWithFullRenderer( {
		scene,
		camera,
		slimRenderer: fakeRenderer(),
		fullRenderer: full,
		threeFullModule: Three,
		resolveShadowMaterial( material, _object, context ) {

			mapperContext = context;
			return context.originalMaterial === wrapper ? material : null;

		},
		cache: new WeakMap(),
	} );

	assert.equal( result.complete, true );
	assert.equal( mapperContext.originalMaterial, wrapper );
	assert.equal( mapperContext.threeFullModule, Three );

} );

test( 'populateShadowMapsWithFullRenderer reports custom, VSM, and transmitted shadows without approximations', async () => {

	const custom = makeShadowScene();
	custom.light.shadow.shadowNode = { isShadowBaseNode: true };
	const customFull = fakeRenderer( { populateShadows: true } );
	const customResult = await populateShadowMapsWithFullRenderer( {
		scene: custom.scene,
		camera: custom.camera,
		slimRenderer: fakeRenderer(),
		fullRenderer: customFull,
		threeFullModule: Three,
		cache: new WeakMap(),
	} );

	assert.equal( customResult.rendered, false );
	assert.equal( customFull.renderCalls.length, 0 );
	assert.ok( customResult.unsupported.some( ( entry ) => entry.reason === 'custom-shadow-node' ) );

	const vsm = makeShadowScene();
	const vsmSlim = fakeRenderer();
	vsmSlim.shadowMap.type = Three.VSMShadowMap;
	const vsmFull = fakeRenderer( { populateShadows: true } );
	const vsmResult = await populateShadowMapsWithFullRenderer( {
		scene: vsm.scene,
		camera: vsm.camera,
		slimRenderer: vsmSlim,
		fullRenderer: vsmFull,
		threeFullModule: Three,
		cache: new WeakMap(),
	} );

	assert.equal( vsmResult.rendered, false );
	assert.equal( vsmFull.renderCalls.length, 0 );
	assert.ok( vsmResult.unsupported.some( ( entry ) => entry.reason === 'vsm-shadow-map' ) );

	const transmitted = makeShadowScene();
	const transmittedSlim = fakeRenderer();
	transmittedSlim.shadowMap.transmitted = true;
	const transmittedFull = fakeRenderer( { populateShadows: true } );
	const transmittedResult = await populateShadowMapsWithFullRenderer( {
		scene: transmitted.scene,
		camera: transmitted.camera,
		slimRenderer: transmittedSlim,
		fullRenderer: transmittedFull,
		threeFullModule: Three,
		cache: new WeakMap(),
	} );

	assert.equal( transmittedResult.rendered, false );
	assert.equal( transmittedFull.renderCalls.length, 0 );
	assert.ok( transmittedResult.unsupported.some( ( entry ) => entry.reason === 'transmitted-shadow-map' ) );

} );

test( 'populateShadowMapsWithFullRenderer rejects incompatible renderer devices and depth conventions', async () => {

	const differentDevice = makeShadowScene();
	const differentDeviceResult = await populateShadowMapsWithFullRenderer( {
		scene: differentDevice.scene,
		camera: differentDevice.camera,
		slimRenderer: fakeRenderer( { device: { queue: TEST_GPU_DEVICE.queue } } ),
		fullRenderer: fakeRenderer( { populateShadows: true, device: { queue: TEST_GPU_DEVICE.queue } } ),
		threeFullModule: Three,
		cache: new WeakMap(),
	} );

	assert.equal( differentDeviceResult.rendered, false );
	assert.ok( differentDeviceResult.unsupported.some( ( entry ) => entry.reason === 'gpu-device-mismatch' ) );

	const reversed = makeShadowScene();
	const reversedResult = await populateShadowMapsWithFullRenderer( {
		scene: reversed.scene,
		camera: reversed.camera,
		slimRenderer: fakeRenderer(),
		fullRenderer: fakeRenderer( { populateShadows: true, reversedDepthBuffer: true } ),
		threeFullModule: Three,
		cache: new WeakMap(),
	} );

	assert.equal( reversedResult.rendered, false );
	assert.ok( reversedResult.unsupported.some( ( entry ) => entry.reason === 'reversed-depth-mismatch' ) );

} );
