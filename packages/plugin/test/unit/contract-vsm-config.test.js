import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	VSM_REQUIRED_STAGES,
	VSM_SUPPORT_PROFILE,
	VSM_SUPPORT_SCHEMA,
	createVSMSupportConfig,
	sameVSMConfig,
	validateVSMSupportConfig,
	vsmMomentsTopology,
	vsmRequiredStages,
	vsmSourceInputTopology,
} from '@tsl-precompile/contract/vsm-config';

const RG_FORMAT = 1030;
const HALF_FLOAT_TYPE = 1016;

test( 'VSM support config exposes the exact native WebGPU semantic family', () => {

	const config = createVSMSupportConfig();
	assert.deepEqual( config, {
		schema: VSM_SUPPORT_SCHEMA,
		profile: VSM_SUPPORT_PROFILE,
		source: {
			dimension: '2d',
			sampleType: 'depth',
			samplingMode: 'load',
			samplerType: 'none',
			samples: 1,
			depth: true,
			comparison: false,
		},
		moments: {
			dimension: '2d',
			format: RG_FORMAT,
			type: HALF_FLOAT_TYPE,
			sampleType: 'float',
			samplingMode: 'sample-implicit',
			samplerType: 'filtering',
			samples: 1,
			depth: false,
			comparison: false,
		},
	} );
	assert.deepEqual( validateVSMSupportConfig( config ), [] );
	assert.deepEqual( vsmRequiredStages(), [ 'vertical', 'horizontal' ] );
	assert.deepEqual( VSM_REQUIRED_STAGES, [ 'vertical', 'horizontal' ] );

	const mutableStages = vsmRequiredStages();
	mutableStages.pop();
	assert.deepEqual( vsmRequiredStages(), [ 'vertical', 'horizontal' ] );

} );

test( 'VSM semantic identity dedupes live shadow values and object key order', () => {

	const baseline = createVSMSupportConfig();
	const withLiveValues = createVSMSupportConfig( {
		mapSize: { width: 4096, height: 2048 },
		radius: 17,
		blurSamples: 32,
		lightType: 'PointLight',
		renderer: {
			backend: { compatibilityMode: false },
			shadowMap: { type: 'VSMShadowMap' },
		},
	} );
	assert.deepEqual( withLiveValues, baseline );
	assert.equal( sameVSMConfig( baseline, withLiveValues ), true );

	const reordered = {
		moments: {
			comparison: false,
			depth: false,
			samples: 1,
			samplerType: 'filtering',
			samplingMode: 'sample-implicit',
			sampleType: 'float',
			type: HALF_FLOAT_TYPE,
			format: RG_FORMAT,
			dimension: '2d',
		},
		source: {
			comparison: false,
			depth: true,
			samples: 1,
			samplerType: 'none',
			samplingMode: 'load',
			sampleType: 'depth',
			dimension: '2d',
		},
		profile: VSM_SUPPORT_PROFILE,
		schema: VSM_SUPPORT_SCHEMA,
	};
	assert.equal( sameVSMConfig( baseline, reordered ), true );
	assert.deepEqual( Object.keys( withLiveValues ).sort(), [ 'moments', 'profile', 'schema', 'source' ] );

} );

test( 'VSM compatibility mode selects an unfilterable-float depth source family', () => {

	const native = createVSMSupportConfig();
	const explicitCompatibility = createVSMSupportConfig( { compatibilityMode: true } );
	const rendererCompatibility = createVSMSupportConfig( {
		renderer: { backend: { compatibilityMode: true } },
	} );
	const explicitNativeOverride = createVSMSupportConfig( {
		compatibilityMode: false,
		renderer: { backend: { compatibilityMode: true } },
	} );

	assert.equal( native.source.sampleType, 'depth' );
	assert.equal( explicitCompatibility.source.sampleType, 'unfilterable-float' );
	assert.deepEqual( rendererCompatibility, explicitCompatibility );
	assert.deepEqual( explicitNativeOverride, native );
	assert.deepEqual( explicitCompatibility.moments, native.moments );
	assert.deepEqual( validateVSMSupportConfig( explicitCompatibility ), [] );
	assert.equal( sameVSMConfig( native, explicitCompatibility ), false );

} );

test( 'VSM validation rejects unknown, missing, and tampered semantic fields', () => {

	const valid = createVSMSupportConfig();
	const cases = [
		{
			value: { ...valid, schema: 'shadow-vsm-support@0' },
			codes: [ 'vsm.support.schema' ],
		},
		{
			value: { ...valid, profile: 'cube' },
			codes: [ 'vsm.support.profile' ],
		},
		{
			value: { ...valid, unexpected: true },
			codes: [ 'vsm.config-field' ],
		},
		{
			value: { schema: valid.schema, profile: valid.profile, moments: valid.moments },
			codes: [ 'vsm.config-field-missing', 'vsm.source' ],
		},
		{
			value: {
				...valid,
				source: { ...valid.source, sampleType: 'float', comparison: true },
			},
			codes: [ 'vsm.source.sample-type', 'vsm.topology.comparison' ],
		},
		{
			value: {
				...valid,
				source: {
					...valid.source,
					samplingMode: 'sample-level',
					samplerType: 'filtering',
					samples: 4,
					depth: false,
				},
			},
			codes: [
				'vsm.topology.samplingMode',
				'vsm.topology.samplerType',
				'vsm.topology.samples',
				'vsm.topology.depth',
			],
		},
		{
			value: {
				...valid,
				moments: {
					...valid.moments,
					format: 1023,
					type: 1009,
					sampleType: 'unfilterable-float',
					unexpected: true,
				},
			},
			codes: [
				'vsm.config-field',
				'vsm.topology.format',
				'vsm.topology.type',
				'vsm.topology.sampleType',
			],
		},
	];

	for ( const { value, codes } of cases ) {

		const issues = validateVSMSupportConfig( value, 'artifact.internalPass.config' );
		const actualCodes = issues.map( ( issue ) => issue.code );
		for ( const code of codes ) assert.ok(
			actualCodes.includes( code ),
			`expected ${ code } in ${ actualCodes.join( ', ' ) }`,
		);
		assert.ok( issues.every( ( issue ) => issue.path.startsWith( 'artifact.internalPass.config' ) ) );
		assert.equal( sameVSMConfig( valid, value ), false );

	}
	assert.deepEqual( validateVSMSupportConfig( null ), [ {
		code: 'vsm.support',
		path: 'internalPass.config',
		message: 'internalPass.config must be a plain object.',
	} ] );

} );

test( 'VSM topology projections are exact defensive clones', () => {

	const native = createVSMSupportConfig();
	const compatibility = createVSMSupportConfig( { compatibilityMode: true } );
	const nativeSource = vsmSourceInputTopology( native );
	const compatibilitySource = vsmSourceInputTopology( compatibility );
	const moments = vsmMomentsTopology( native );

	assert.deepEqual( nativeSource, native.source );
	assert.deepEqual( compatibilitySource, compatibility.source );
	assert.deepEqual( moments, native.moments );
	assert.notEqual( nativeSource, native.source );
	assert.notEqual( moments, native.moments );
	assert.equal( nativeSource.sampleType, 'depth' );
	assert.equal( compatibilitySource.sampleType, 'unfilterable-float' );

	nativeSource.sampleType = 'unfilterable-float';
	moments.format = 0;
	assert.equal( native.source.sampleType, 'depth' );
	assert.equal( native.moments.format, RG_FORMAT );
	assert.notEqual( vsmSourceInputTopology( native ), nativeSource );
	assert.notEqual( vsmMomentsTopology( native ), moments );

	assert.equal( vsmSourceInputTopology( null ), null );
	assert.equal( vsmSourceInputTopology( { source: [] } ), null );
	assert.equal( vsmMomentsTopology( undefined ), null );
	assert.equal( vsmMomentsTopology( { moments: 'invalid' } ), null );

} );
