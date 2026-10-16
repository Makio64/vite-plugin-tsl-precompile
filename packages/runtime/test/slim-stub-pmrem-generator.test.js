import test from 'node:test';
import assert from 'node:assert/strict';

import { Color } from 'three/src/math/Color.js';
import { Vector3 } from 'three/src/math/Vector3.js';
import { Scene } from 'three/src/scenes/Scene.js';
import { CubeTexture } from 'three/src/textures/CubeTexture.js';
import { Texture } from 'three/src/textures/Texture.js';
import {
	CubeReflectionMapping,
	EquirectangularReflectionMapping,
	HalfFloatType,
	REVISION,
	RGBAFormat,
} from 'three/src/constants.js';

import PMREMGenerator, { createPMREMReplayConfig } from '../src/slim-stub-pmrem-generator.js';

// These schedules mirror the r186 CubeUV-atlas generator. On r187dev the module's default export is
// the cube render-target generator, covered by slim-stub-cube-pmrem-generator.test.js.
const PMREM_ATLAS = REVISION === '186' ? {} : { skip: `three r${ REVISION } uses cube PMREM (see slim-stub-cube-pmrem-generator.test.js)` };
import NativePMREMGenerator from 'three/src/renderers/common/extras/PMREMGenerator.js';
import {
	__resetAuxRegistryForTests,
	registerAuxArtifact,
} from '../src/aux-loader.js';
import { hashPlainConfigSync } from '../src/graph-hash.js';
import { RUNTIME_SLIM_THREE_PACKAGE_VERSION } from '../src/slim-source-policy.js';
import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';
import {
	createPMREMSupportConfig,
	PMREM_SPHERICAL_GAUSSIAN_BLUR,
	pmremRequiredStages,
	pmremSourceInputTopology,
} from '@tsl-precompile/contract/pmrem-config';

function fakeRenderer() {

	let target = null;
	let clearColor = new Color( 0x123456 );
	let clearAlpha = 0.25;
	return {
		autoClear: true,
		isWebGLRenderer: false,
		renders: [],
		clears: [],
		hasInitialized: () => true,
		getRenderTarget: () => target,
		getActiveCubeFace: () => 0,
		getActiveMipmapLevel: () => 0,
		getClearColor( value ) { return value.copy( clearColor ); },
		getClearAlpha: () => clearAlpha,
		setClearColor( value, alpha = clearAlpha ) {

			clearColor = value && value.isColor ? value.clone() : new Color( value );
			clearAlpha = alpha;

		},
		setRenderTarget( next ) { target = next; },
		render( object, camera ) {

			const name = object && object.material && object.material.name || 'scene';
			const artifact = object?.material?.precompiledArtifact;
			const descriptor = artifact?.internalPass;
			this.renders.push( {
				name,
				target,
				background: object && object.isScene ? object.background : undefined,
				clearColor: clearColor.clone(),
				clearAlpha,
				uniforms: Object.fromEntries( ( descriptor?.uniforms || [] ).map( ( entry ) => {

					const group = artifact.uniformPlan.find( ( group ) => group.name === entry.group );
					return [ entry.role, group.slots.find( ( slot ) => slot.name === entry.binding )._liveNode.value ];

				} ) ),
				textures: [ ...( artifact?._textureRefs?.values() || [] ) ],
				viewport: target?.viewport?.toArray(),
				direction: object && object.isScene && camera
					? camera.getWorldDirection( new Vector3() ).toArray()
					: null,
			} );
			if ( this.throwOnMaterialName === name ) throw new Error( `forced ${ name } failure` );

		},
		clear() {

			this.clears.push( { color: clearColor.clone(), alpha: clearAlpha } );

		},
	};

}

function planGroup( stage ) {

	const textureBinding = stage === 'blur' ? 'blurEnvMap' : stage === 'ggx' ? 'nodeUniform2' : 'nodeUniform0';
	const slotsByStage = {
		cubemap: [],
		equirect: [],
		blur: [
			[ 'blurSigma', 'number' ],
			[ 'blurMipInt', 'number' ],
		],
		ggx: [
			[ 'nodeUniform0', 'number' ],
			[ 'nodeUniform1', 'number' ],
		],
	};
	return {
		name: 'object',
		slots: ( slotsByStage[ stage ] || [] ).map( ( [ name, dtype ] ) => ( {
			name,
			dtype,
			source: { kind: 'uniform.live', value: dtype === 'vec3' ? [ 0, 1, 0 ] : 0 },
		} ) ),
		textures: [ {
			name: textureBinding,
			bindingKind: 'sampled-texture',
			textureType: stage === 'cubemap' ? 'cube' : '2d',
			source: { kind: 'artifact.texture', textureUuid: `${ stage }-texture` },
		} ],
		orderedBindings: [],
		bufferUniforms: [],
	};

}

function internalDescriptor( stage, config ) {

	const uniformRoles = {
		cubemap: [],
		equirect: [],
		blur: [
			[ 'sigma', 'blurSigma', 'float' ],
			[ 'mip-int', 'blurMipInt', 'float' ],
		],
		ggx: [
			[ 'roughness', 'nodeUniform0', 'float' ],
			[ 'mip-int', 'nodeUniform1', 'float' ],
		],
	};
	const textureBinding = stage === 'blur' ? 'blurEnvMap' : stage === 'ggx' ? 'nodeUniform2' : 'nodeUniform0';
	const sourceStage = stage === 'equirect' || stage === 'cubemap';
	const sourceTopology = sourceStage
		? pmremSourceInputTopology( config.source )
		: { dimension: '2d' };
	const inputs = [ {
		role: sourceStage ? 'source' : 'env-map',
		kind: 'texture',
		group: 'object',
		binding: textureBinding,
		topology: sourceTopology,
	} ];
	return {
		schema: 'internal-pass@1',
		family: 'pmrem',
		stage,
		shape: `pmrem-${ stage }`,
		config,
		uniforms: ( uniformRoles[ stage ] || [] ).map( ( [ role, binding, valueType ] ) => ( {
			role,
			group: 'object',
			binding,
			valueType,
		} ) ),
		inputs,
		output: { topology: { dimension: '2d', format: RGBAFormat, type: HalfFloatType, depth: false } },
	};

}

function registerPMREMFixture( replayConfig, profile, sourceTexture = null ) {

	const supportConfig = createPMREMSupportConfig( replayConfig, profile, sourceTexture, {
		...( profile === 'scene' ? { blur: PMREM_SPHERICAL_GAUSSIAN_BLUR } : {} ),
	} );
	const hash = hashPlainConfigSync( supportConfig, {
		shape: 'pmrem',
		threeVersion: RUNTIME_SLIM_THREE_PACKAGE_VERSION,
		pluginVersion: ARTIFACT_TOOLCHAIN_VERSION,
	} );
	for ( const stage of pmremRequiredStages( profile ) ) {

		registerAuxArtifact( `pmrem-${ stage }`, hash, {
			version: 3,
			materialShape: `pmrem-${ stage }`,
			vertexShader: `vertex:${ stage }`,
			fragmentShader: `fragment:${ stage }`,
			bindings: [],
			uniformPlan: [ planGroup( stage ) ],
			replayConfig,
			internalPass: internalDescriptor( stage, supportConfig ),
		}, {
			threeVersion: RUNTIME_SLIM_THREE_PACKAGE_VERSION,
			pluginVersion: ARTIFACT_TOOLCHAIN_VERSION,
		} );

	}

}

test( 'slim PMREM generator stays constructible and compile hints stay graph-free', async () => {

	const renderer = fakeRenderer();
	const generator = new PMREMGenerator( renderer );
	assert.equal( generator._renderer, renderer );
	await assert.doesNotReject( generator.compileCubemapShader() );
	await assert.doesNotReject( generator.compileEquirectangularShader() );
	assert.doesNotThrow( () => generator.dispose() );

} );

test( 'slim PMREM generator schedules captured source and GGX passes without a full renderer', PMREM_ATLAS, () => {

	__resetAuxRegistryForTests();
	const config = createPMREMReplayConfig( 32 );
	const renderer = fakeRenderer();
	const generator = new PMREMGenerator( renderer );
	const source = new Texture( { width: 128, height: 64 } );
	source.mapping = EquirectangularReflectionMapping;
	registerPMREMFixture( config, 'texture-equirect', source );

	try {

		const target = generator.fromEquirectangular( source );
		assert.equal( target.texture.isPMREMTexture, true );
		assert.equal( target.texture.mapping, 306 );
		assert.equal( target.width, 336 );
		assert.equal( target.height, 128 );
		assert.equal( renderer.renders[ 0 ].name, 'PMREM_equirect' );
		assert.ok( renderer.renders.filter( ( draw ) => draw.name === 'PMREM_ggx' ).length > 0 );
		assert.equal( renderer.renders.some( ( draw ) => draw.name === 'PMREM_blur' ), false );
		target.dispose();

	} finally {

		generator.dispose();
		source.dispose();
		__resetAuxRegistryForTests();

	}

} );

test( 'slim PMREM selects distinct equirect and cubemap support at the same atlas layout', PMREM_ATLAS, () => {

	__resetAuxRegistryForTests();
	const config = createPMREMReplayConfig( 32 );
	const equirect = new Texture( { width: 128, height: 64 } );
	equirect.mapping = EquirectangularReflectionMapping;
	const cubemap = new CubeTexture( Array.from( { length: 6 }, () => ( { width: 32, height: 32 } ) ) );
	cubemap.mapping = CubeReflectionMapping;
	registerPMREMFixture( config, 'texture-equirect', equirect );
	registerPMREMFixture( config, 'texture-cubemap', cubemap );
	const renderer = fakeRenderer();
	const generator = new PMREMGenerator( renderer );

	try {

		const equirectTarget = generator.fromEquirectangular( equirect );
		const cubeTarget = generator.fromCubemap( cubemap );
		assert.equal( renderer.renders.some( ( draw ) => draw.name === 'PMREM_equirect' ), true );
		assert.equal( renderer.renders.some( ( draw ) => draw.name === 'PMREM_cubemap' ), true );
		assert.equal(
			[ ...generator._passControllers.keys() ].filter( ( key ) => key.startsWith( 'ggx:' ) ).length,
			2,
			'same-layout source profiles must retain independent GGX controllers',
		);
		equirectTarget.dispose();
		cubeTarget.dispose();

	} finally {

		generator.dispose();
		equirect.dispose();
		cubemap.dispose();
		__resetAuxRegistryForTests();

	}

} );

test( 'slim PMREM fromScene uses the native face order and clears solid backgrounds without a live material', PMREM_ATLAS, () => {

	__resetAuxRegistryForTests();
	const config = createPMREMReplayConfig( 32 );
	registerPMREMFixture( config, 'scene' );
	const renderer = fakeRenderer();
	const generator = new PMREMGenerator( renderer );
	const scene = new Scene();
	scene.background = new Color( 0x336699 );

	try {

		const target = generator.fromScene( scene, 0, 0.1, 100, { size: 32 } );
		const sceneDraws = renderer.renders.filter( ( draw ) => draw.name === 'scene' );
		assert.equal( sceneDraws.length, 6 );
		assert.deepEqual(
			sceneDraws.map( ( draw ) => draw.direction.map( ( value ) => {

				const rounded = Math.round( value );
				return Object.is( rounded, - 0 ) ? 0 : rounded;

			} ) ),
			[
				[ 1, 0, 0 ],
				[ 0, - 1, 0 ],
				[ 0, 0, 1 ],
				[ - 1, 0, 0 ],
				[ 0, 1, 0 ],
				[ 0, 0, - 1 ],
			],
		);
		assert.ok( sceneDraws.every( ( draw ) => draw.background === null ) );
		assert.ok( sceneDraws.every( ( draw ) => draw.clearColor.equals( scene.background ) ) );
		assert.ok( sceneDraws.every( ( draw ) => draw.clearAlpha === 1 ) );
		assert.equal( renderer.clears[ 0 ].color.getHex(), 0x336699 );
		assert.equal( renderer.clears[ 0 ].alpha, 1 );
		assert.equal( scene.background.getHex(), 0x336699 );
		assert.equal( renderer.getClearColor( new Color() ).getHex(), 0x123456 );
		assert.equal( renderer.getClearAlpha(), 0.25 );
		target.dispose();

	} finally {

		generator.dispose();
		__resetAuxRegistryForTests();

	}

} );

test( 'slim PMREM fromScene selects the scene blur family when sigma is nonzero', PMREM_ATLAS, () => {

	__resetAuxRegistryForTests();
	const config = createPMREMReplayConfig( 32 );
	registerPMREMFixture( config, 'scene' );
	const renderer = fakeRenderer();
	const generator = new PMREMGenerator( renderer );
	const scene = new Scene();

	try {

		const target = generator.fromScene( scene, 0.02, 0.1, 100, { size: 32 } );
		const draws = renderer.renders.filter( ( draw ) => draw.name === 'PMREM_blur' );
		assert.equal( draws.length, 2 );
		assert.deepEqual( draws.map( ( draw ) => draw.uniforms ), [
			{ sigma: 0.02 / Math.SQRT2, 'mip-int': 5 },
			{ sigma: 0.02 / Math.SQRT2, 'mip-int': 5 },
		] );
		assert.equal( draws[ 0 ].target, generator._pingPongRenderTarget );
		assert.equal( draws[ 1 ].target, target );
		assert.deepEqual( draws[ 0 ].textures, [ target.texture ] );
		assert.deepEqual( draws[ 1 ].textures, [ generator._pingPongRenderTarget.texture ] );
		assert.deepEqual( draws.map( ( draw ) => draw.viewport ), [ [ 0, 0, 96, 64 ], [ 0, 0, 96, 64 ] ] );
		assert.equal( renderer.renders.some( ( draw ) => draw.name === 'PMREM_ggx' ), true );
		target.dispose();

	} finally {

		generator.dispose();
		__resetAuxRegistryForTests();

	}

} );

test( 'slim scene blur schedules the native spherical Gaussian passes and clamps large radii', PMREM_ATLAS, () => {

	for ( const sigma of [ 0.02, Math.PI, 10, Infinity ] ) {

		const target = {};
		const pingPong = {};
		const schedules = [ NativePMREMGenerator.prototype, PMREMGenerator.prototype ].map( ( prototype ) => {

			const draws = [];
			prototype._blur.call( {
				_pingPongRenderTarget: pingPong,
				_blurPass: ( ...args ) => draws.push( args ),
			}, target, 1, 2, sigma );
			return draws;

		} );
		assert.deepEqual( schedules[ 1 ], schedules[ 0 ], `native pass parity at sigma ${ sigma }` );
		assert.deepEqual( schedules[ 1 ], [
			[ target, pingPong, 1, 2, Math.min( sigma, Math.PI ) / Math.SQRT2 ],
			[ pingPong, target, 2, 2, Math.min( sigma, Math.PI ) / Math.SQRT2 ],
		] );

	}

} );

test( 'slim PMREM atlas attributes and every vertex match native r186 geometry', PMREM_ATLAS, () => {

	__resetAuxRegistryForTests();
	const layout = createPMREMReplayConfig( 64 );
	registerPMREMFixture( layout, 'scene' );
	const renderer = fakeRenderer();
	const generators = [ new NativePMREMGenerator( renderer ), new PMREMGenerator( renderer ) ];
	const targets = [];
	try {

		for ( const generator of generators ) {

			generator._setSize( 64 );
			generator._activeReplayOwner = new Scene();
			const target = generator._allocateTarget( false );
			targets.push( target );
			generator._init( target );

		}
		assert.deepEqual( generators[ 1 ]._sizeLods, generators[ 0 ]._sizeLods );
		assert.equal( generators[ 1 ]._lodMeshes.length, generators[ 0 ]._lodMeshes.length );
		for ( const [ lod, nativeMesh ] of generators[ 0 ]._lodMeshes.entries() ) {

			const actual = generators[ 1 ]._lodMeshes[ lod ].geometry.attributes;
			const expected = nativeMesh.geometry.attributes;
			assert.deepEqual( Object.keys( actual ).sort(), [ 'outputDirection', 'position' ] );
			for ( const name of Object.keys( expected ) ) {

				assert.equal( actual[ name ].itemSize, expected[ name ].itemSize );
				assert.deepEqual( actual[ name ].array, expected[ name ].array, `${ name } at lod ${ lod }` );

			}

		}

	} finally {

		for ( const generator of generators ) generator.dispose();
		for ( const target of targets ) target.dispose();
		__resetAuxRegistryForTests();

	}

} );

test( 'slim PMREM restores renderer autoClear when a captured GGX draw fails', PMREM_ATLAS, () => {

	__resetAuxRegistryForTests();
	const config = createPMREMReplayConfig( 32 );
	const renderer = fakeRenderer();
	renderer.throwOnMaterialName = 'PMREM_ggx';
	const generator = new PMREMGenerator( renderer );
	const source = new Texture( { width: 128, height: 64 } );
	source.mapping = EquirectangularReflectionMapping;
	registerPMREMFixture( config, 'texture-equirect', source );

	try {

		assert.throws( () => generator.fromEquirectangular( source ), /forced PMREM_ggx failure/ );
		assert.equal( renderer.autoClear, true );
		assert.equal( renderer.getRenderTarget(), null );

	} finally {

		generator.dispose();
		source.dispose();
		__resetAuxRegistryForTests();

	}

} );
