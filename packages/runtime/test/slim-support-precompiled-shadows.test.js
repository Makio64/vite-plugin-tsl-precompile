import assert from 'node:assert/strict';
import test from 'node:test';

import { PerspectiveCamera } from 'three/src/cameras/PerspectiveCamera.js';
import { Color } from 'three/src/math/Color.js';
import { Scene } from 'three/src/scenes/Scene.js';
import { DirectionalLight } from 'three/src/lights/DirectionalLight.js';
import {
	VSMShadowMap,
	WebGPUCoordinateSystem,
} from 'three/src/constants.js';

import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';
import {
	createVSMSupportConfig,
	vsmMomentsTopology,
	vsmSourceInputTopology,
} from '@tsl-precompile/contract/vsm-config';
import {
	__resetAuxRegistryForTests,
	registerAuxArtifact,
} from '../src/aux-loader.js';
import { hashPlainConfigSync } from '../src/graph-hash.js';
import { RUNTIME_SLIM_THREE_PACKAGE_VERSION } from '../src/slim-source-policy.js';
import { createPrecompiledShadowSupport } from '../src/slim-support/precompiled-shadows.js';

const HASH_OPTIONS = Object.freeze( {
	threeVersion: RUNTIME_SLIM_THREE_PACKAGE_VERSION,
	pluginVersion: ARTIFACT_TOOLCHAIN_VERSION,
} );

function vsmArtifact( stage, config = createVSMSupportConfig() ) {

	const vertical = stage === 'vertical';
	const inputRole = vertical ? 'shadow-depth' : 'vsm-vertical';
	const inputBinding = vertical ? 'nodeUniform1' : 'nodeUniform2';
	return {
		version: 3,
		materialShape: `shadow-vsm-${ stage }`,
		vertexShader: `vertex:${ stage }`,
		fragmentShader: `fragment:${ stage }`,
		bindings: [],
		uniformPlan: [
			{
				name: 'render',
				slots: [
					{ name: 'nodeUniform0', dtype: 'number', source: { kind: 'light.shadowBlurSamples' } },
					{ name: 'nodeUniform3', dtype: 'number', source: { kind: 'light.shadowRadius' } },
					{ name: 'nodeUniform4', dtype: 'vec2', source: { kind: 'light.shadowMapSize' } },
				],
				textures: [],
			},
			{
				name: 'object',
				slots: [],
				textures: [ {
					name: inputBinding,
					bindingKind: 'sampled-texture',
					textureType: '2d',
					source: {
						kind: vertical ? 'depth.texture' : 'artifact.texture',
						textureUuid: `captured-${ inputRole }`,
					},
				} ],
			},
		],
		internalPass: {
			schema: 'internal-pass@1',
			family: 'shadow-vsm',
			stage,
			shape: `shadow-vsm-${ stage }`,
			config,
			uniforms: [
				{ role: 'blur-samples', group: 'render', binding: 'nodeUniform0', valueType: 'float' },
				{ role: 'radius', group: 'render', binding: 'nodeUniform3', valueType: 'float' },
				{ role: 'map-size', group: 'render', binding: 'nodeUniform4', valueType: 'vec2' },
			],
			inputs: [ {
				role: inputRole,
				kind: 'texture',
				group: 'object',
				binding: inputBinding,
				topology: vertical
					? vsmSourceInputTopology( config )
					: vsmMomentsTopology( config ),
			} ],
			output: {
				topology: vsmMomentsTopology( config ),
			},
		},
	};

}

function registerFixtures( _light, _signatureLights = [ _light ] ) {

	const depthArtifact = () => ( {
		version: 3,
		materialShape: 'shadow-depth',
		cacheKey: 'depth-cache',
		vertexShader: 'depth vertex',
		fragmentShader: 'depth fragment',
		bindings: [],
		uniformPlan: [],
	} );
	registerAuxArtifact( 'shadow-depth', 'depth-fixture', depthArtifact(), HASH_OPTIONS );
	// Multi-route builds can contain several shadow-depth config hashes. They
	// are merged by the authoritative shadow registry; a unique-shape lookup
	// alone would reject this otherwise valid fixture as ambiguous.
	registerAuxArtifact( 'shadow-depth', 'depth-fixture-duplicate', depthArtifact(), HASH_OPTIONS );
	const config = createVSMSupportConfig();
	const configHash = hashPlainConfigSync( config, {
		...HASH_OPTIONS,
		shape: 'shadow-vsm',
	} );
	for ( const stage of [ 'vertical', 'horizontal' ] ) {

		registerAuxArtifact( `shadow-vsm-${ stage }`, configHash, vsmArtifact( stage, config ), HASH_OPTIONS );

	}

}

function fakeRenderer() {

	let renderTarget = null;
	let renderObjectFunction = null;
	let mrt = null;
	let clearColor = new Color( 0x123456 );
	let clearAlpha = 0.5;
	let scissorTest = true;
	const callerRenderObjectFunction = () => {};
	renderObjectFunction = callerRenderObjectFunction;
	return {
		autoClear: false,
		toneMapping: 1,
		toneMappingExposure: 2,
		outputColorSpace: 'test',
		coordinateSystem: WebGPUCoordinateSystem,
		reversedDepthBuffer: false,
		shadowMap: { enabled: true, type: VSMShadowMap },
		renders: [],
		callerRenderObjectFunction,
		getRenderTarget: () => renderTarget,
		getActiveCubeFace: () => 0,
		getActiveMipmapLevel: () => 0,
		getRenderObjectFunction: () => renderObjectFunction,
		getPixelRatio: () => 1,
		getMRT: () => mrt,
		getClearColor( target ) { return target.copy( clearColor ); },
		getClearAlpha: () => clearAlpha,
		getScissorTest: () => scissorTest,
		setRenderTarget( value ) { renderTarget = value; },
		setRenderObjectFunction( value ) { renderObjectFunction = value; },
		setPixelRatio() {},
		setMRT( value ) { mrt = value; },
		setClearColor( value, alpha = clearAlpha ) {

			clearColor = value && value.isColor ? value.clone() : new Color( value );
			clearAlpha = alpha;

		},
		setScissorTest( value ) { scissorTest = value; },
		render( object ) {

			this.renders.push( {
				kind: object && object.isScene ? 'shadow-depth' : object && object.material && object.material.name,
				target: renderTarget && renderTarget.texture && renderTarget.texture.name,
				renderObjectFunction,
			} );

		},
		renderObject() {},
	};

}

test( 'captured VSM replay owns depth → vertical → horizontal on the slim renderer', () => {

	__resetAuxRegistryForTests();
	const scene = new Scene();
	const camera = new PerspectiveCamera();
	const light = new DirectionalLight();
	light.castShadow = true;
	light.shadow.mapSize.set( 32, 32 );
	light.position.set( 3, 5, 2 );
	light.target.position.set( - 1, 0, 1 );
	scene.add( light, light.target );
	const updateMatrixWorld = scene.updateMatrixWorld;
	let sceneWorldUpdates = 0;
	scene.updateMatrixWorld = function ( ...args ) {

		sceneWorldUpdates ++;
		return updateMatrixWorld.apply( this, args );

	};
	registerFixtures( light );
	const renderer = fakeRenderer();
	const support = createPrecompiledShadowSupport( { renderer } );

	try {

		const result = support.populateShadowMaps( scene, camera );
		assert.deepEqual(
			renderer.renders.map( ( render ) => [ render.kind, render.target ] ),
			[
				[ 'shadow-depth', 'ShadowMap' ],
				[ 'VSMVertical', 'VSMVertical' ],
				[ 'VSMHorizontal', 'VSMHorizontal' ],
			],
		);
		assert.equal( renderer.renders[ 1 ].renderObjectFunction, renderer.callerRenderObjectFunction );
		assert.equal( renderer.renders[ 2 ].renderObjectFunction, renderer.callerRenderObjectFunction );
		assert.equal( result.complete, true );
		assert.equal( result.rendered, true );
		assert.equal( result.lights, 1 );
		assert.ok( sceneWorldUpdates > 0 );
		assert.equal( camera.coordinateSystem, WebGPUCoordinateSystem );
		assert.equal( light.shadow.camera.coordinateSystem, WebGPUCoordinateSystem );
		assert.ok( light.shadow.map && light.shadow.map.depthTexture );
		assert.equal( light.shadow.mapPass.texture.name, 'VSMHorizontal' );
		assert.equal( light.shadow.__tslpVsmShadowTexture, light.shadow.mapPass.texture );
		assert.equal( light.shadow.needsUpdate, false );

		renderer.renders.length = 0;
		light.shadow.autoUpdate = false;
		const cached = support.populateShadowMaps( scene, camera );
		assert.equal( cached.rendered, false );
		assert.deepEqual( renderer.renders, [] );

		const staleMap = light.shadow.map;
		let staleMapDisposed = 0;
		staleMap.addEventListener( 'dispose', () => { staleMapDisposed ++; } );
		light.shadow.mapSize.set( 64, 64 );
		registerFixtures( light );
		renderer.renders.length = 0;
		const rebuilt = support.populateShadowMaps( scene, camera );
		assert.equal( rebuilt.rendered, true, 'a resized state must render even for a static light' );
		assert.equal( staleMapDisposed, 1 );
		assert.equal( light.shadow.map, staleMap );
		assert.equal( light.shadow.map.width, 64 );
		assert.equal( light.shadow.mapPass.width, 64 );

		support.dispose();
		assert.equal( light.shadow.map, null );
		assert.equal( light.shadow.mapPass, null );
		assert.equal( light.shadow.__tslpVsmShadowTexture, null );
		assert.throws(
			() => support.populateShadowMaps( scene, camera ),
			( error ) => error && error.code === 'SHADOW_SUPPORT_DISPOSED',
		);

	} finally {

		support.dispose();
		light.dispose();
		__resetAuxRegistryForTests();

	}

} );

test( 'captured VSM replay fails layered non-point shadow topology closed', () => {

	__resetAuxRegistryForTests();
	const scene = new Scene();
	const camera = new PerspectiveCamera();
	const light = new DirectionalLight();
	light.castShadow = true;
	light.shadow.getViewportCount = () => 2;
	scene.add( light, light.target );
	const renderer = fakeRenderer();
	const support = createPrecompiledShadowSupport( { renderer } );

	try {

		const result = support.populateShadowMaps( scene, camera );
		assert.equal( result.complete, false );
		assert.equal( result.rendered, false );
		assert.equal( result.unsupported.length, 1 );
		assert.match( result.unsupported[ 0 ].reason, /Layered or multi-viewport VSM/ );
		assert.deepEqual( renderer.renders, [] );

	} finally {

		support.dispose();
		light.dispose();
		__resetAuxRegistryForTests();

	}

} );

test( 'captured VSM replay renders ordinary lights in a mixed unsupported scene family', () => {

	__resetAuxRegistryForTests();
	const scene = new Scene();
	const camera = new PerspectiveCamera();
	const ordinary = new DirectionalLight();
	ordinary.castShadow = true;
	ordinary.shadow.mapSize.set( 32, 32 );
	const layered = new DirectionalLight();
	layered.castShadow = true;
	layered.shadow.mapSize.set( 64, 64 );
	layered.shadow.getViewportCount = () => 2;
	scene.add( ordinary, ordinary.target, layered, layered.target );
	registerFixtures( ordinary, [ ordinary, layered ] );
	const renderer = fakeRenderer();
	const support = createPrecompiledShadowSupport( { renderer } );

	try {

		const result = support.populateShadowMaps( scene, camera );
		assert.equal( result.complete, false );
		assert.equal( result.rendered, true );
		assert.equal( result.lights, 1 );
		assert.equal( result.unsupported.length, 1 );
		assert.equal( result.unsupported[ 0 ].light, layered );
		assert.deepEqual(
			renderer.renders.map( ( render ) => render.kind ),
			[ 'shadow-depth', 'VSMVertical', 'VSMHorizontal' ],
		);
		assert.ok( ordinary.shadow.map );
		assert.equal( layered.shadow.map, null );

	} finally {

		support.dispose();
		ordinary.dispose();
		layered.dispose();
		__resetAuxRegistryForTests();

	}

} );

test( 'captured VSM replay releases a removed light immediately', () => {

	__resetAuxRegistryForTests();
	const scene = new Scene();
	const camera = new PerspectiveCamera();
	const light = new DirectionalLight();
	light.castShadow = true;
	light.shadow.mapSize.set( 32, 32 );
	scene.add( light, light.target );
	registerFixtures( light );
	const renderer = fakeRenderer();
	const support = createPrecompiledShadowSupport( { renderer } );

	try {

		support.populateShadowMaps( scene, camera );
		const ownedMap = light.shadow.map;
		let disposed = 0;
		ownedMap.addEventListener( 'dispose', () => { disposed ++; } );
		scene.remove( light, light.target );
		const empty = support.populateShadowMaps( scene, camera );
		assert.equal( empty.complete, true );
		assert.equal( empty.rendered, false );
		assert.equal( disposed, 1 );
		assert.equal( light.shadow.map, null );
		assert.equal( light.shadow.mapPass, null );
		assert.equal( light.shadow.__tslpVsmShadowTexture, null );

	} finally {

		support.dispose();
		light.dispose();
		__resetAuxRegistryForTests();

	}

} );

test( 'captured VSM replay retains states owned by another active scene', () => {

	__resetAuxRegistryForTests();
	const camera = new PerspectiveCamera();
	const firstScene = new Scene();
	const firstLight = new DirectionalLight();
	firstLight.castShadow = true;
	firstLight.shadow.mapSize.set( 32, 32 );
	firstScene.add( firstLight, firstLight.target );
	const secondScene = new Scene();
	const secondLight = new DirectionalLight();
	secondLight.castShadow = true;
	secondLight.shadow.mapSize.set( 32, 32 );
	secondScene.add( secondLight, secondLight.target );
	registerFixtures( firstLight );
	const renderer = fakeRenderer();
	const support = createPrecompiledShadowSupport( { renderer } );

	try {

		support.populateShadowMaps( firstScene, camera );
		const firstMap = firstLight.shadow.map;
		let firstMapDisposed = 0;
		firstMap.addEventListener( 'dispose', () => { firstMapDisposed ++; } );
		support.populateShadowMaps( secondScene, camera );
		assert.equal( firstMapDisposed, 0 );
		assert.equal( firstLight.shadow.map, firstMap );
		assert.ok( secondLight.shadow.map );

	} finally {

		support.dispose();
		firstLight.dispose();
		secondLight.dispose();
		__resetAuxRegistryForTests();

	}

} );
