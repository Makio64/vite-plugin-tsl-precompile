import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	createPMREMLayoutConfig,
	createPMREMSourceTopology,
	createPMREMSourceTopologyKey,
	createPMREMSupportConfig,
	pmremProfileForSource,
	pmremRequiredStages,
	validatePMREMLayoutConfig,
	validatePMREMSourceTopology,
	validatePMREMSupportConfig,
} from '@tsl-precompile/contract/pmrem-config';

const EQUIRECTANGULAR_REFLECTION_MAPPING = 303;
const EQUIRECTANGULAR_REFRACTION_MAPPING = 304;
const CUBE_REFLECTION_MAPPING = 301;
const REPEAT_WRAPPING = 1000;
const CLAMP_TO_EDGE_WRAPPING = 1001;
const MIRRORED_REPEAT_WRAPPING = 1002;
const NEAREST_FILTER = 1003;
const LINEAR_FILTER = 1006;
const LINEAR_MIPMAP_LINEAR_FILTER = 1008;
const UNSIGNED_BYTE_TYPE = 1009;
const INT_TYPE = 1013;
const UNSIGNED_INT_TYPE = 1014;
const FLOAT_TYPE = 1015;
const HALF_FLOAT_TYPE = 1016;

function equirectTexture( overrides = {} ) {

	return {
		isTexture: true,
		isCubeTexture: false,
		mapping: EQUIRECTANGULAR_REFLECTION_MAPPING,
		type: UNSIGNED_BYTE_TYPE,
		minFilter: LINEAR_MIPMAP_LINEAR_FILTER,
		magFilter: LINEAR_FILTER,
		wrapS: CLAMP_TO_EDGE_WRAPPING,
		wrapT: CLAMP_TO_EDGE_WRAPPING,
		...overrides,
	};

}

function cubeTexture( overrides = {} ) {

	return {
		isTexture: true,
		isCubeTexture: true,
		mapping: CUBE_REFLECTION_MAPPING,
		type: UNSIGNED_BYTE_TYPE,
		minFilter: LINEAR_MIPMAP_LINEAR_FILTER,
		magFilter: LINEAR_FILTER,
		...overrides,
	};

}

test( 'PMREM source topology normalizes equivalent filterable color textures', () => {

	const uint8Texture = equirectTexture( {
		format: 1023,
		internalFormat: 'rgba8unorm-srgb',
		colorSpace: 'srgb',
		channel: 3,
		flipY: true,
		isRenderTargetTexture: true,
		wrapS: REPEAT_WRAPPING,
		wrapT: MIRRORED_REPEAT_WRAPPING,
	} );
	const halfFloatTexture = equirectTexture( {
		type: HALF_FLOAT_TYPE,
		format: 1028,
		internalFormat: 'r16float',
		colorSpace: 'srgb-linear',
		channel: 0,
		flipY: false,
		isRenderTargetTexture: false,
		mapping: EQUIRECTANGULAR_REFRACTION_MAPPING,
	} );
	const uint8 = createPMREMSourceTopology( uint8Texture );
	const halfFloat = createPMREMSourceTopology( halfFloatTexture );
	assert.deepEqual( uint8, {
		kind: 'equirect',
		dimension: '2d',
		componentType: 'f32',
		sampleType: 'float',
		samplingMode: 'sample-level',
		samplerType: 'filtering',
		wrapS: null,
		wrapT: null,
		float32Filterable: null,
		samples: 1,
	} );
	assert.deepEqual( halfFloat, uint8 );
	assert.equal(
		createPMREMSourceTopologyKey( uint8Texture ),
		createPMREMSourceTopologyKey( halfFloatTexture ),
	);
	assert.deepEqual( validatePMREMSourceTopology( uint8, 'texture-equirect' ), [] );

} );

test( 'PMREM Float32 topology records and requires the device filtering capability', () => {

	const filterableFloat = createPMREMSourceTopology(
		equirectTexture( { type: FLOAT_TYPE } ),
		'texture-equirect',
		{ float32Filterable: true },
	);
	assert.equal( filterableFloat.sampleType, 'float' );
	assert.equal( filterableFloat.samplingMode, 'sample-level' );
	assert.equal( filterableFloat.samplerType, 'filtering' );
	assert.equal( filterableFloat.float32Filterable, true );

	const rendererFilterableFloat = createPMREMSourceTopology(
		equirectTexture( { type: FLOAT_TYPE } ),
		'texture-equirect',
		{ renderer: { hasFeature: ( feature ) => feature === 'float32-filterable' } },
	);
	assert.deepEqual( rendererFilterableFloat, filterableFloat );

	const manualFloat = createPMREMSourceTopology(
		equirectTexture( {
			type: FLOAT_TYPE,
			wrapS: REPEAT_WRAPPING,
			wrapT: MIRRORED_REPEAT_WRAPPING,
		} ),
		'texture-equirect',
		{ float32Filterable: false },
	);
	assert.equal( manualFloat.sampleType, 'unfilterable-float' );
	assert.equal( manualFloat.samplingMode, 'manual-linear' );
	assert.equal( manualFloat.samplerType, 'none' );
	assert.equal( manualFloat.float32Filterable, false );
	assert.equal( manualFloat.wrapS, 'repeat' );
	assert.equal( manualFloat.wrapT, 'mirror' );
	assert.deepEqual( validatePMREMSourceTopology( filterableFloat, 'texture-equirect' ), [] );
	assert.deepEqual( validatePMREMSourceTopology( manualFloat, 'texture-equirect' ), [] );
	assert.notEqual(
		createPMREMSourceTopologyKey(
			equirectTexture( { type: FLOAT_TYPE } ),
			'texture-equirect',
			{ float32Filterable: true },
		),
		createPMREMSourceTopologyKey(
			equirectTexture( { type: FLOAT_TYPE } ),
			'texture-equirect',
			{ float32Filterable: false },
		),
	);
	assert.throws(
		() => createPMREMSourceTopology( equirectTexture( { type: FLOAT_TYPE } ) ),
		/require an initialized renderer or an explicit float32Filterable capability/,
	);
	assert.throws(
		() => createPMREMSourceTopology(
			cubeTexture( { type: FLOAT_TYPE } ),
			'texture-cubemap',
			{ float32Filterable: false },
		),
		/FloatType cubemaps require the WebGPU float32-filterable feature/,
	);

} );

test( 'PMREM filter branches retain wrapping only when WGSL bakes it in', () => {

	const filterableRepeat = createPMREMSourceTopology( equirectTexture( {
		wrapS: REPEAT_WRAPPING,
		wrapT: MIRRORED_REPEAT_WRAPPING,
	} ) );
	const filterableClamp = createPMREMSourceTopology( equirectTexture() );
	assert.deepEqual( filterableRepeat, filterableClamp );
	assert.equal(
		createPMREMSourceTopologyKey( equirectTexture( {
			wrapS: REPEAT_WRAPPING,
			wrapT: MIRRORED_REPEAT_WRAPPING,
		} ) ),
		createPMREMSourceTopologyKey( equirectTexture() ),
	);

	const loadRepeat = createPMREMSourceTopology( equirectTexture( {
		minFilter: NEAREST_FILTER,
		magFilter: NEAREST_FILTER,
		wrapS: REPEAT_WRAPPING,
		wrapT: MIRRORED_REPEAT_WRAPPING,
	} ) );
	assert.equal( loadRepeat.samplingMode, 'load' );
	assert.equal( loadRepeat.samplerType, 'none' );
	assert.equal( loadRepeat.wrapS, 'repeat' );
	assert.equal( loadRepeat.wrapT, 'mirror' );
	assert.notEqual(
		createPMREMSourceTopologyKey( equirectTexture( {
			minFilter: NEAREST_FILTER,
			magFilter: NEAREST_FILTER,
			wrapS: REPEAT_WRAPPING,
			wrapT: MIRRORED_REPEAT_WRAPPING,
		} ) ),
		createPMREMSourceTopologyKey( equirectTexture( {
			minFilter: NEAREST_FILTER,
			magFilter: NEAREST_FILTER,
		} ) ),
	);

	const manualClampKey = createPMREMSourceTopologyKey(
		equirectTexture( { type: FLOAT_TYPE } ),
		'texture-equirect',
		{ float32Filterable: false },
	);
	const manualRepeatKey = createPMREMSourceTopologyKey(
		equirectTexture( {
			type: FLOAT_TYPE,
			wrapS: REPEAT_WRAPPING,
			wrapT: MIRRORED_REPEAT_WRAPPING,
		} ),
		'texture-equirect',
		{ float32Filterable: false },
	);
	assert.notEqual( manualClampKey, manualRepeatKey );

} );

test( 'PMREM accepts nearest integer equirect sources and rejects invalid integer paths', () => {

	for ( const [ type, componentType, sampleType ] of [
		[ INT_TYPE, 'i32', 'sint' ],
		[ UNSIGNED_INT_TYPE, 'u32', 'uint' ],
	] ) {

		const topology = createPMREMSourceTopology( equirectTexture( {
			type,
			minFilter: NEAREST_FILTER,
			magFilter: NEAREST_FILTER,
		} ) );
		assert.equal( topology.componentType, componentType );
		assert.equal( topology.sampleType, sampleType );
		assert.equal( topology.samplingMode, 'load' );
		assert.equal( topology.samplerType, 'none' );
		assert.deepEqual( validatePMREMSourceTopology( topology, 'texture-equirect' ), [] );

	}
	assert.throws(
		() => createPMREMSourceTopology( equirectTexture( { type: INT_TYPE } ) ),
		/integer equirectangular sources require NearestFilter/,
	);
	assert.throws(
		() => createPMREMSourceTopology( cubeTexture( {
			type: UNSIGNED_INT_TYPE,
			minFilter: NEAREST_FILTER,
			magFilter: NEAREST_FILTER,
		} ) ),
		/integer cubemap sources are unsupported/,
	);

} );

test( 'PMREM source mapping and texture dimension must agree', () => {

	assert.throws(
		() => createPMREMSourceTopology( equirectTexture(), 'texture-cubemap' ),
		/mapping selects "texture-equirect"/,
	);
	assert.throws(
		() => createPMREMSourceTopology( cubeTexture( { isCubeTexture: false } ) ),
		/cubemap mapping requires a CubeTexture binding/,
	);
	assert.throws(
		() => createPMREMSourceTopology( equirectTexture( { isCubeTexture: true } ) ),
		/equirectangular mapping requires a 2D texture binding/,
	);
	assert.equal(
		pmremProfileForSource( equirectTexture( { mapping: EQUIRECTANGULAR_REFRACTION_MAPPING } ) ),
		'texture-equirect',
	);
	assert.throws(
		() => pmremProfileForSource( equirectTexture( { mapping: 300 } ) ),
		/expected a cubemap or equirectangular texture/,
	);

} );

test( 'PMREM source topology rejects incompatible sample-count inputs', () => {

	assert.throws(
		() => createPMREMSourceTopology(
			equirectTexture(),
			'texture-equirect',
			{ primarySamples: 4 },
		),
		/requires a single-sampled source binding/,
	);
	assert.throws(
		() => createPMREMSourceTopology(
			equirectTexture(),
			'texture-equirect',
			{ renderer: {
				backend: {
					utils: {
						getTextureSampleData: () => ( { primarySamples: 4 } ),
					},
				},
			} },
		),
		/requires a single-sampled source binding/,
	);

} );

test( 'PMREM support configs keep operation profiles and stage inventories exact', () => {

	const layout = createPMREMLayoutConfig( 64 );
	const equirect = createPMREMSupportConfig( layout, 'texture-equirect', equirectTexture() );
	const cubemap = createPMREMSupportConfig( layout, 'texture-cubemap', cubeTexture() );
	const scene = createPMREMSupportConfig( layout, 'scene' );

	assert.deepEqual( pmremRequiredStages( equirect.profile ), [ 'equirect', 'ggx' ] );
	assert.deepEqual( pmremRequiredStages( cubemap.profile ), [ 'cubemap', 'ggx' ] );
	assert.deepEqual( pmremRequiredStages( scene.profile ), [ 'blur', 'ggx' ] );
	assert.deepEqual( validatePMREMSupportConfig( equirect ), [] );
	assert.deepEqual( validatePMREMSupportConfig( cubemap ), [] );
	assert.deepEqual( validatePMREMSupportConfig( scene ), [] );
	assert.equal( Object.hasOwn( scene, 'source' ), false );

} );

test( 'PMREM support validation rejects profile/source drift and malformed fields', () => {

	const layout = createPMREMLayoutConfig( 64 );
	const support = createPMREMSupportConfig( layout, 'texture-equirect', equirectTexture() );
	const mismatchedProfile = {
		...support,
		profile: 'texture-cubemap',
	};
	const mismatchCodes = validatePMREMSupportConfig( mismatchedProfile ).map( ( issue ) => issue.code );
	assert.ok( mismatchCodes.includes( 'pmrem.source.kind' ) );
	assert.ok( mismatchCodes.includes( 'pmrem.source.dimension' ) );

	const sceneWithSource = {
		...createPMREMSupportConfig( layout, 'scene' ),
		source: support.source,
	};
	assert.ok(
		validatePMREMSupportConfig( sceneWithSource )
			.some( ( issue ) => issue.code === 'pmrem.support.source-unexpected' ),
	);

	const missingSource = {
		schema: support.schema,
		profile: support.profile,
		layout: support.layout,
	};
	assert.ok(
		validatePMREMSupportConfig( missingSource )
			.some( ( issue ) => issue.code === 'pmrem.source' ),
	);

	const malformedSource = {
		...support,
		source: {
			...support.source,
			samples: 4,
			unexpected: true,
		},
	};
	const malformedCodes = validatePMREMSupportConfig( malformedSource ).map( ( issue ) => issue.code );
	assert.ok( malformedCodes.includes( 'pmrem.config-field' ) );
	assert.ok( malformedCodes.includes( 'pmrem.source.samples' ) );

} );

test( 'PMREM layout supports large safe power-of-two atlas dimensions', () => {

	const cubeSize = 2 ** 50;
	const layout = createPMREMLayoutConfig( cubeSize );
	assert.deepEqual( layout, {
		schema: 'pmrem-layout@1',
		cubeSize,
		lodMax: 50,
		target: {
			width: 3 * cubeSize,
			height: 4 * cubeSize,
		},
	} );
	assert.equal( Number.isSafeInteger( layout.target.width ), true );
	assert.equal( Number.isSafeInteger( layout.target.height ), true );
	assert.deepEqual( validatePMREMLayoutConfig( layout ), [] );
	assert.throws(
		() => createPMREMLayoutConfig( cubeSize + 4 ),
		/power-of-two integer/,
	);

} );
