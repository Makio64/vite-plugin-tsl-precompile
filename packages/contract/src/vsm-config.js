import { stableJsonStringify } from './stable-json.js';

export const VSM_SUPPORT_SCHEMA = 'shadow-vsm-support@1';
export const VSM_SUPPORT_PROFILE = '2d';
export const VSM_REQUIRED_STAGES = deepFreeze( [ 'vertical', 'horizontal' ] );

// Three r185 creates both VSM moment targets as RG/HalfFloat render targets.
// Keep the constants local so the shared contract has no dependency on Three.
const RG_FORMAT = 1030;
const HALF_FLOAT_TYPE = 1016;
const CONFIG_KEYS = new Set( [ 'schema', 'profile', 'source', 'moments' ] );
const SOURCE_KEYS = new Set( [
	'dimension',
	'sampleType',
	'samplingMode',
	'samplerType',
	'samples',
	'depth',
	'comparison',
] );
const MOMENTS_KEYS = new Set( [
	'dimension',
	'format',
	'type',
	'sampleType',
	'samplingMode',
	'samplerType',
	'samples',
	'depth',
	'comparison',
] );

/**
 * Canonical Three r185 VSM blur family selector.
 *
 * Map size, light type, blur radius, and sample count are live uniforms. They
 * do not alter WGSL or the bind-group layout and therefore must not fragment
 * the artifact family. Native WebGPU depth bindings and compatibility-mode
 * float depth bindings are distinct because their bind-group sample types
 * differ.
 */
export function createVSMSupportConfig( options = {} ) {

	const compatibilityMode = resolveCompatibilityMode( options );
	const config = {
		schema: VSM_SUPPORT_SCHEMA,
		profile: VSM_SUPPORT_PROFILE,
		source: {
			dimension: '2d',
			sampleType: compatibilityMode ? 'unfilterable-float' : 'depth',
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
	};
	const issues = validateVSMSupportConfig( config );
	if ( issues.length > 0 ) throw new TypeError( `createVSMSupportConfig: ${ issues[ 0 ].message }` );
	return config;

}

export function vsmRequiredStages() {

	return [ ...VSM_REQUIRED_STAGES ];

}

export function vsmSourceInputTopology( config ) {

	return cloneTopology( config?.source );

}

export function vsmMomentsTopology( config ) {

	return cloneTopology( config?.moments );

}

export function validateVSMSupportConfig( value, path = 'internalPass.config' ) {

	const issues = [];
	if ( ! isRecord( value ) ) return [ issue( 'vsm.support', path, `${ path } must be a plain object.` ) ];
	validateExactKeys( value, CONFIG_KEYS, path, issues );
	if ( value.schema !== VSM_SUPPORT_SCHEMA ) issues.push( issue(
		'vsm.support.schema',
		`${ path }.schema`,
		`${ path }.schema must equal ${ JSON.stringify( VSM_SUPPORT_SCHEMA ) }.`,
	) );
	if ( value.profile !== VSM_SUPPORT_PROFILE ) issues.push( issue(
		'vsm.support.profile',
		`${ path }.profile`,
		`${ path }.profile must equal ${ JSON.stringify( VSM_SUPPORT_PROFILE ) }.`,
	) );
	validateSourceTopology( value.source, `${ path }.source`, issues );
	validateMomentsTopology( value.moments, `${ path }.moments`, issues );
	return issues;

}

export function sameVSMConfig( left, right ) {

	try {

		return stableJsonStringify( left, 'vsmConfig' ) === stableJsonStringify( right, 'vsmConfig' );

	} catch ( _ ) {

		return false;

	}

}

function validateSourceTopology( value, path, issues ) {

	if ( ! isRecord( value ) ) {

		issues.push( issue( 'vsm.source', path, `${ path } must be a plain object.` ) );
		return;

	}
	validateExactKeys( value, SOURCE_KEYS, path, issues );
	validateLiteral( value, 'dimension', '2d', path, issues );
	if ( value.sampleType !== 'depth' && value.sampleType !== 'unfilterable-float' ) issues.push( issue(
		'vsm.source.sample-type',
		`${ path }.sampleType`,
		`${ path }.sampleType must be depth or unfilterable-float.`,
	) );
	validateLiteral( value, 'samplingMode', 'load', path, issues );
	validateLiteral( value, 'samplerType', 'none', path, issues );
	validateLiteral( value, 'samples', 1, path, issues );
	validateLiteral( value, 'depth', true, path, issues );
	validateLiteral( value, 'comparison', false, path, issues );

}

function validateMomentsTopology( value, path, issues ) {

	if ( ! isRecord( value ) ) {

		issues.push( issue( 'vsm.moments', path, `${ path } must be a plain object.` ) );
		return;

	}
	validateExactKeys( value, MOMENTS_KEYS, path, issues );
	validateLiteral( value, 'dimension', '2d', path, issues );
	validateLiteral( value, 'format', RG_FORMAT, path, issues );
	validateLiteral( value, 'type', HALF_FLOAT_TYPE, path, issues );
	validateLiteral( value, 'sampleType', 'float', path, issues );
	validateLiteral( value, 'samplingMode', 'sample-implicit', path, issues );
	validateLiteral( value, 'samplerType', 'filtering', path, issues );
	validateLiteral( value, 'samples', 1, path, issues );
	validateLiteral( value, 'depth', false, path, issues );
	validateLiteral( value, 'comparison', false, path, issues );

}

function resolveCompatibilityMode( options ) {

	if ( typeof options?.compatibilityMode === 'boolean' ) return options.compatibilityMode;
	return options?.renderer?.backend?.compatibilityMode === true;

}

function validateLiteral( value, property, expected, path, issues ) {

	if ( value?.[ property ] !== expected ) issues.push( issue(
		`vsm.topology.${ property }`,
		`${ path }.${ property }`,
		`${ path }.${ property } must equal ${ JSON.stringify( expected ) }.`,
	) );

}

function validateExactKeys( value, allowed, path, issues ) {

	for ( const key of Object.keys( value ) ) {

		if ( ! allowed.has( key ) ) issues.push( issue(
			'vsm.config-field',
			`${ path }.${ key }`,
			`${ path } contains unknown field ${ JSON.stringify( key ) }.`,
		) );

	}
	for ( const key of allowed ) {

		if ( ! Object.prototype.hasOwnProperty.call( value, key ) ) issues.push( issue(
			'vsm.config-field-missing',
			`${ path }.${ key }`,
			`${ path } is missing required field ${ JSON.stringify( key ) }.`,
		) );

	}

}

function cloneTopology( value ) {

	return isRecord( value ) ? JSON.parse( JSON.stringify( value ) ) : null;

}

function isRecord( value ) {

	return !! value && typeof value === 'object' && ! Array.isArray( value );

}

function issue( code, path, message ) {

	return { code, path, message };

}

function deepFreeze( value ) {

	if ( ! value || typeof value !== 'object' || Object.isFrozen( value ) ) return value;
	for ( const child of Object.values( value ) ) deepFreeze( child );
	return Object.freeze( value );

}
