import { stableJsonStringify } from './stable-json.js';

export const PMREM_LAYOUT_SCHEMA = 'pmrem-layout@1';
export const PMREM_SUPPORT_SCHEMA = 'pmrem-support@1';

export const PMREM_PROFILE_STAGE_REQUIREMENTS = deepFreeze( {
	'texture-equirect': [ 'equirect', 'ggx' ],
	'texture-cubemap': [ 'cubemap', 'ggx' ],
	scene: [ 'blur', 'ggx' ],
} );

export const PMREM_SUPPORT_PROFILES = Object.freeze( Object.keys( PMREM_PROFILE_STAGE_REQUIREMENTS ) );

const SUPPORT_PROFILE_SET = new Set( PMREM_SUPPORT_PROFILES );
const LAYOUT_KEYS = new Set( [ 'schema', 'cubeSize', 'lodMax', 'target' ] );
const TARGET_KEYS = new Set( [ 'width', 'height' ] );
const SUPPORT_KEYS = new Set( [ 'schema', 'profile', 'layout', 'source' ] );
const SOURCE_KEYS = new Set( [
	'kind',
	'dimension',
	'componentType',
	'sampleType',
	'samplingMode',
	'samplerType',
	'wrapS',
	'wrapT',
	'float32Filterable',
	'samples',
] );

// Three r185 constants used by WGSLNodeBuilder's texture branch selection.
// They are intentionally local contract vocabulary rather than imports from
// Three: the contract package must stay renderer-independent.
const CUBE_MAPPINGS = new Set( [ 301, 302 ] );
const EQUIRECT_MAPPINGS = new Set( [ 303, 304 ] );
const REPEAT_WRAPPING = 1000;
const CLAMP_TO_EDGE_WRAPPING = 1001;
const MIRRORED_REPEAT_WRAPPING = 1002;
const NEAREST_FILTER = 1003;
const NEAREST_MIPMAP_LINEAR_FILTER = 1005;
const LINEAR_FILTER = 1006;
const LINEAR_MIPMAP_NEAREST_FILTER = 1007;
const LINEAR_MIPMAP_LINEAR_FILTER = 1008;
const UNSIGNED_BYTE_TYPE = 1009;
const INT_TYPE = 1013;
const UNSIGNED_INT_TYPE = 1014;
const FLOAT_TYPE = 1015;
const FILTERED_TEXTURE_FILTERS = new Set( [
	LINEAR_FILTER,
	LINEAR_MIPMAP_NEAREST_FILTER,
	NEAREST_MIPMAP_LINEAR_FILTER,
	LINEAR_MIPMAP_LINEAR_FILTER,
] );
const WRAP_NAMES = Object.freeze( {
	[ REPEAT_WRAPPING ]: 'repeat',
	[ CLAMP_TO_EDGE_WRAPPING ]: 'clamp',
	[ MIRRORED_REPEAT_WRAPPING ]: 'mirror',
} );
const COMPONENT_TYPES = new Set( [ 'f32', 'i32', 'u32' ] );
const SAMPLE_TYPES = new Set( [ 'float', 'unfilterable-float', 'sint', 'uint' ] );
const SAMPLING_MODES = new Set( [ 'sample-implicit', 'sample-level', 'manual-linear', 'load' ] );
const SAMPLER_TYPES = new Set( [ 'filtering', 'none' ] );

/**
 * Canonical compiled atlas layout shared by capture, artifact validation, and
 * the compiler-free PMREM scheduler.
 */
export function createPMREMLayoutConfig( cubeSize ) {

	const size = Number( cubeSize );
	if ( ! isPowerOfTwoInteger( size ) || size < 16 ) {

		throw new RangeError( `createPMREMLayoutConfig: cubeSize must be a power-of-two integer >= 16, received ${ cubeSize }.` );

	}
	const lodMax = Math.log2( size );
	return {
		schema: PMREM_LAYOUT_SCHEMA,
		cubeSize: size,
		lodMax,
		target: {
			width: 3 * Math.max( size, 16 * 7 ),
			height: 4 * size,
		},
	};

}

/**
 * Return the operation profile selected by a real PMREM source texture.
 */
export function pmremProfileForSource( texture ) {

	const mapping = safeRead( texture, 'mapping' );
	if ( CUBE_MAPPINGS.has( mapping ) ) return 'texture-cubemap';
	if ( EQUIRECT_MAPPINGS.has( mapping ) ) return 'texture-equirect';
	throw new TypeError( 'pmremProfileForSource: expected a cubemap or equirectangular texture.' );

}

/**
 * Canonical Three r185 WGSL/bind-layout selector for a PMREM source. Raw
 * texture metadata is deliberately normalized away. For example, Uint8 and
 * HalfFloat sampled-color equirect textures share one family when they take
 * the same WGSL sampling branch, while Float32 textures on devices without
 * `float32-filterable` select a distinct manual-filter family.
 */
export function createPMREMSourceTopology(
	texture,
	profile = pmremProfileForSource( texture ),
	options = {},
) {

	if ( ! texture || safeRead( texture, 'isTexture' ) !== true ) {

		throw new TypeError( 'createPMREMSourceTopology: expected a Three Texture.' );

	}
	if ( profile !== 'texture-equirect' && profile !== 'texture-cubemap' ) {

		throw new TypeError( `createPMREMSourceTopology: unsupported texture profile ${ JSON.stringify( profile ) }.` );

	}
	const inferredProfile = pmremProfileForSource( texture );
	if ( inferredProfile !== profile ) throw new TypeError(
		`createPMREMSourceTopology: texture mapping selects ${ JSON.stringify( inferredProfile ) }, not ${ JSON.stringify( profile ) }.`,
	);
	assertPMREMSourceDimension( texture, profile );
	if ( safeRead( texture, 'isDepthTexture' ) === true ) {

		throw new TypeError( 'createPMREMSourceTopology: PMREM does not support depth texture sources.' );

	}
	if ( safeRead( texture, 'compareFunction' ) !== undefined && safeRead( texture, 'compareFunction' ) !== null ) {

		throw new TypeError( 'createPMREMSourceTopology: PMREM source textures cannot use comparison sampling.' );

	}

	const type = safeRead( texture, 'type' ) ?? UNSIGNED_BYTE_TYPE;
	const componentType = type === INT_TYPE ? 'i32' : type === UNSIGNED_INT_TYPE ? 'u32' : 'f32';
	const float32Filterable = type === FLOAT_TYPE
		? resolveFloat32Filterable( options )
		: null;
	const sampleType = componentType === 'i32'
		? 'sint'
		: componentType === 'u32'
			? 'uint'
			: type === FLOAT_TYPE && float32Filterable === false
				? 'unfilterable-float'
				: 'float';
	const samples = resolvePrimarySamples( texture, options );
	if ( samples !== 1 ) throw new TypeError(
		`createPMREMSourceTopology: PMREM requires a single-sampled source binding; Three resolved ${ samples } primary samples.`,
	);

	const minFilter = safeRead( texture, 'minFilter' ) ?? LINEAR_MIPMAP_LINEAR_FILTER;
	const magFilter = safeRead( texture, 'magFilter' ) ?? LINEAR_FILTER;
	const nearestOnly = minFilter === NEAREST_FILTER && magFilter === NEAREST_FILTER;
	const filteredTexture = FILTERED_TEXTURE_FILTERS.has( minFilter ) || FILTERED_TEXTURE_FILTERS.has( magFilter );
	const unfilterable = componentType !== 'f32' ||
		type === FLOAT_TYPE && float32Filterable === false ||
		nearestOnly;
	const dimension = profile === 'texture-cubemap' ? 'cube' : '2d';

	if ( componentType !== 'f32' && profile === 'texture-cubemap' ) throw new TypeError(
		'createPMREMSourceTopology: integer cubemap sources are unsupported because Three binds their required cube sampler as filtering.',
	);
	if ( componentType !== 'f32' && ! nearestOnly ) throw new TypeError(
		'createPMREMSourceTopology: integer equirectangular sources require NearestFilter for both minFilter and magFilter.',
	);
	if ( profile === 'texture-cubemap' && sampleType === 'unfilterable-float' ) throw new TypeError(
		'createPMREMSourceTopology: FloatType cubemaps require the WebGPU float32-filterable feature.',
	);

	let samplingMode;
	let samplerType;
	let wrapS = null;
	let wrapT = null;
	if ( profile === 'texture-cubemap' ) {

		samplingMode = unfilterable ? 'sample-level' : 'sample-implicit';
		samplerType = 'filtering';

	} else if ( ! unfilterable ) {

		samplingMode = 'sample-level';
		samplerType = 'filtering';

	} else {

		samplingMode = filteredTexture ? 'manual-linear' : 'load';
		samplerType = 'none';
		wrapS = normalizeWrap( safeRead( texture, 'wrapS' ) ?? CLAMP_TO_EDGE_WRAPPING, 'wrapS' );
		wrapT = normalizeWrap( safeRead( texture, 'wrapT' ) ?? CLAMP_TO_EDGE_WRAPPING, 'wrapT' );

	}

	return {
		kind: profile === 'texture-cubemap' ? 'cubemap' : 'equirect',
		dimension,
		componentType,
		sampleType,
		samplingMode,
		samplerType,
		wrapS,
		wrapT,
		float32Filterable,
		samples,
	};

}

/**
 * Durable family identity. Unlike the atlas layout alone, this separates
 * same-size source textures whose WGSL or binding layout differs.
 */
export function createPMREMSupportConfig( layout, profile, sourceTexture = null, options = {} ) {

	const layoutIssues = validatePMREMLayoutConfig( layout );
	if ( layoutIssues.length > 0 ) throw new TypeError( `createPMREMSupportConfig: ${ layoutIssues[ 0 ].message }` );
	if ( ! SUPPORT_PROFILE_SET.has( profile ) ) {

		throw new TypeError( `createPMREMSupportConfig: unsupported profile ${ JSON.stringify( profile ) }.` );

	}
	const source = profile === 'scene' ? null : createPMREMSourceTopology( sourceTexture, profile, options );
	return {
		schema: PMREM_SUPPORT_SCHEMA,
		profile,
		layout: cloneJson( layout ),
		...( source ? { source } : {} ),
	};

}

export function pmremRequiredStages( profile ) {

	const stages = PMREM_PROFILE_STAGE_REQUIREMENTS[ profile ];
	return stages ? [ ...stages ] : [];

}

export function createPMREMSourceTopologyKey(
	texture,
	profile = pmremProfileForSource( texture ),
	options = {},
) {

	return stableJsonStringify( createPMREMSourceTopology( texture, profile, options ), 'pmremSourceTopology' );

}

export function pmremSourceInputTopology( source ) {

	if ( ! source || typeof source !== 'object' || Array.isArray( source ) ) return null;
	return compactObject( {
		dimension: source.dimension,
		sampleType: source.sampleType,
		samples: source.samples,
		comparison: false,
	} );

}

export function validatePMREMLayoutConfig( value, path = 'internalPass.config.layout' ) {

	const issues = [];
	if ( ! isRecord( value ) ) return [ issue( 'pmrem.layout', path, `${ path } must be a plain object.` ) ];
	validateExactKeys( value, LAYOUT_KEYS, path, issues );
	if ( value.schema !== PMREM_LAYOUT_SCHEMA ) issues.push( issue(
		'pmrem.layout.schema',
		`${ path }.schema`,
		`${ path }.schema must equal ${ JSON.stringify( PMREM_LAYOUT_SCHEMA ) }.`,
	) );
	const cubeSize = value.cubeSize;
	if ( ! isPowerOfTwoInteger( cubeSize ) || cubeSize < 16 ) issues.push( issue(
		'pmrem.layout.cube-size',
		`${ path }.cubeSize`,
		`${ path }.cubeSize must be a power-of-two integer >= 16.`,
	) );
	if ( ! Number.isSafeInteger( value.lodMax ) || value.lodMax < 4 ||
		Number.isSafeInteger( cubeSize ) && value.lodMax !== Math.log2( cubeSize ) ) issues.push( issue(
		'pmrem.layout.lod-max',
		`${ path }.lodMax`,
		`${ path }.lodMax must equal log2(cubeSize).`,
	) );
	if ( ! isRecord( value.target ) ) issues.push( issue(
		'pmrem.layout.target',
		`${ path }.target`,
		`${ path }.target must be a plain object.`,
	) );
	else {

		validateExactKeys( value.target, TARGET_KEYS, `${ path }.target`, issues );
		const expectedWidth = Number.isSafeInteger( cubeSize ) ? 3 * Math.max( cubeSize, 16 * 7 ) : null;
		const expectedHeight = Number.isSafeInteger( cubeSize ) ? 4 * cubeSize : null;
		if ( ! Number.isSafeInteger( value.target.width ) || value.target.width <= 0 ||
			expectedWidth !== null && value.target.width !== expectedWidth ) issues.push( issue(
			'pmrem.layout.target-width',
			`${ path }.target.width`,
			`${ path }.target.width must equal 3 * max(cubeSize, 112).`,
		) );
		if ( ! Number.isSafeInteger( value.target.height ) || value.target.height <= 0 ||
			expectedHeight !== null && value.target.height !== expectedHeight ) issues.push( issue(
			'pmrem.layout.target-height',
			`${ path }.target.height`,
			`${ path }.target.height must equal 4 * cubeSize.`,
		) );

	}
	return issues;

}

export function validatePMREMSupportConfig( value, path = 'internalPass.config' ) {

	const issues = [];
	if ( ! isRecord( value ) ) return [ issue( 'pmrem.support', path, `${ path } must be a plain object.` ) ];
	validateExactKeys( value, SUPPORT_KEYS, path, issues );
	if ( value.schema !== PMREM_SUPPORT_SCHEMA ) issues.push( issue(
		'pmrem.support.schema',
		`${ path }.schema`,
		`${ path }.schema must equal ${ JSON.stringify( PMREM_SUPPORT_SCHEMA ) }.`,
	) );
	if ( ! SUPPORT_PROFILE_SET.has( value.profile ) ) issues.push( issue(
		'pmrem.support.profile',
		`${ path }.profile`,
		`${ path }.profile must be one of ${ PMREM_SUPPORT_PROFILES.join( ', ' ) }.`,
	) );
	issues.push( ...validatePMREMLayoutConfig( value.layout, `${ path }.layout` ) );
	if ( value.profile === 'scene' ) {

		if ( Object.prototype.hasOwnProperty.call( value, 'source' ) ) issues.push( issue(
			'pmrem.support.source-unexpected',
			`${ path }.source`,
			`${ path }.source must be omitted for the scene profile.`,
		) );

	} else {

		issues.push( ...validatePMREMSourceTopology( value.source, value.profile, `${ path }.source` ) );

	}
	return issues;

}

export function validatePMREMSourceTopology( value, profile, path = 'internalPass.config.source' ) {

	const issues = [];
	if ( ! isRecord( value ) ) return [ issue( 'pmrem.source', path, `${ path } must be a plain object.` ) ];
	validateExactKeys( value, SOURCE_KEYS, path, issues );
	const expectedKind = profile === 'texture-cubemap' ? 'cubemap' : 'equirect';
	const expectedDimension = profile === 'texture-cubemap' ? 'cube' : '2d';
	if ( value.kind !== expectedKind ) issues.push( issue(
		'pmrem.source.kind',
		`${ path }.kind`,
		`${ path }.kind must equal ${ JSON.stringify( expectedKind ) } for profile ${ JSON.stringify( profile ) }.`,
	) );
	if ( value.dimension !== expectedDimension ) issues.push( issue(
		'pmrem.source.dimension',
		`${ path }.dimension`,
		`${ path }.dimension must equal ${ JSON.stringify( expectedDimension ) }.`,
	) );
	validateEnumField( value, 'componentType', COMPONENT_TYPES, path, issues );
	validateEnumField( value, 'sampleType', SAMPLE_TYPES, path, issues );
	validateEnumField( value, 'samplingMode', SAMPLING_MODES, path, issues );
	validateEnumField( value, 'samplerType', SAMPLER_TYPES, path, issues );
	for ( const property of [ 'wrapS', 'wrapT' ] ) {

		if ( value[ property ] !== null && ! [ 'repeat', 'clamp', 'mirror' ].includes( value[ property ] ) ) issues.push( issue(
			'pmrem.source.wrap',
			`${ path }.${ property }`,
			`${ path }.${ property } must be repeat, clamp, mirror, or null.`,
		) );

	}
	if ( value.float32Filterable !== null && typeof value.float32Filterable !== 'boolean' ) issues.push( issue(
		'pmrem.source.float32-filterable',
		`${ path }.float32Filterable`,
		`${ path }.float32Filterable must be boolean or null.`,
	) );
	if ( value.samples !== 1 ) issues.push( issue(
		'pmrem.source.samples',
		`${ path }.samples`,
		`${ path }.samples must equal 1.`,
	) );
	validatePMREMSourceCombination( value, profile, path, issues );
	return issues;

}

export function samePMREMConfig( left, right ) {

	try {

		return stableJsonStringify( left, 'pmremConfig' ) === stableJsonStringify( right, 'pmremConfig' );

	} catch ( _ ) {

		return false;

	}

}

function assertPMREMSourceDimension( texture, profile ) {

	const cube = safeRead( texture, 'isCubeTexture' ) === true;
	if ( profile === 'texture-cubemap' && ! cube ) throw new TypeError(
		'createPMREMSourceTopology: a cubemap mapping requires a CubeTexture binding.',
	);
	if ( profile === 'texture-equirect' && cube ) throw new TypeError(
		'createPMREMSourceTopology: an equirectangular mapping requires a 2D texture binding.',
	);
	for ( const flag of [
		'isDataArrayTexture',
		'isCompressedArrayTexture',
		'isData3DTexture',
		'isStorageTexture',
	] ) {

		if ( safeRead( texture, flag ) === true ) throw new TypeError(
			`createPMREMSourceTopology: ${ flag } sources are not valid PMREM 2D/cube bindings.`,
		);

	}

}

function resolveFloat32Filterable( options ) {

	if ( typeof options?.float32Filterable === 'boolean' ) return options.float32Filterable;
	const renderer = options?.renderer;
	if ( renderer && typeof renderer.hasFeature === 'function' ) {

		let value;
		try {

			value = renderer.hasFeature( 'float32-filterable' );

		} catch ( error ) {

			throw new TypeError(
				`createPMREMSourceTopology: cannot read float32-filterable from the initialized renderer: ${ error && error.message || String( error ) }`,
			);

		}
		if ( typeof value === 'boolean' ) return value;

	}
	throw new TypeError(
		'createPMREMSourceTopology: FloatType sources require an initialized renderer or an explicit float32Filterable capability.',
	);

}

function resolvePrimarySamples( texture, options ) {

	const renderer = options?.renderer;
	const getTextureSampleData = renderer?.backend?.utils?.getTextureSampleData;
	if ( typeof getTextureSampleData === 'function' ) {

		const data = getTextureSampleData.call( renderer.backend.utils, texture );
		if ( Number.isSafeInteger( data?.primarySamples ) && data.primarySamples > 0 ) return data.primarySamples;
		throw new TypeError( 'createPMREMSourceTopology: renderer returned invalid texture sample data.' );

	}
	if ( Number.isSafeInteger( options?.primarySamples ) && options.primarySamples > 0 ) return options.primarySamples;
	const renderTargetSamples = safeRead( safeRead( texture, 'renderTarget' ), 'samples' );
	if ( Number.isSafeInteger( renderTargetSamples ) && renderTargetSamples > 0 ) {

		// WebGPUUtils samples the resolved color texture for multisampled render
		// targets, so its primarySamples remains one.
		return safeRead( texture, 'isDepthTexture' ) === true ? renderTargetSamples : 1;

	}
	return 1;

}

function normalizeWrap( value, property ) {

	const normalized = WRAP_NAMES[ value ];
	if ( ! normalized ) throw new TypeError(
		`createPMREMSourceTopology: texture.${ property } must use Repeat, ClampToEdge, or MirroredRepeat wrapping.`,
	);
	return normalized;

}

function validateEnumField( value, property, allowed, path, issues ) {

	if ( ! allowed.has( value[ property ] ) ) issues.push( issue(
		`pmrem.source.${ property }`,
		`${ path }.${ property }`,
		`${ path }.${ property } must be one of ${ [ ...allowed ].join( ', ' ) }.`,
	) );

}

function validatePMREMSourceCombination( value, profile, path, issues ) {

	const isCube = profile === 'texture-cubemap';
	const isInteger = value.componentType === 'i32' || value.componentType === 'u32';
	const expectsWrap = ! isCube && ( value.samplingMode === 'manual-linear' || value.samplingMode === 'load' );
	if ( isCube && isInteger ) issues.push( issue(
		'pmrem.source.integer-cube',
		`${ path }.componentType`,
		'Integer cubemap PMREM sources are unsupported.',
	) );
	if ( value.componentType === 'i32' && value.sampleType !== 'sint' ||
		value.componentType === 'u32' && value.sampleType !== 'uint' ||
		value.componentType === 'f32' && ! [ 'float', 'unfilterable-float' ].includes( value.sampleType ) ) issues.push( issue(
		'pmrem.source.sample-type',
		`${ path }.sampleType`,
		`${ path }.sampleType does not agree with componentType.`,
	) );
	if ( value.float32Filterable !== null && value.componentType !== 'f32' ) issues.push( issue(
		'pmrem.source.float32-component',
		`${ path }.float32Filterable`,
		`${ path }.float32Filterable is only valid for Float32 component sources.`,
	) );
	if ( value.float32Filterable === false && value.sampleType !== 'unfilterable-float' ||
		value.float32Filterable !== false && value.sampleType === 'unfilterable-float' ) issues.push( issue(
		'pmrem.source.float32-sample-type',
		`${ path }.sampleType`,
		`${ path }.sampleType does not agree with float32Filterable.`,
	) );
	if ( isCube ) {

		if ( ! [ 'sample-implicit', 'sample-level' ].includes( value.samplingMode ) ||
			value.samplerType !== 'filtering' ) issues.push( issue(
			'pmrem.source.cube-sampling',
			`${ path }.samplingMode`,
			'Cubemap PMREM sources require implicit/level sampling with a filtering sampler.',
		) );

	} else if ( value.samplingMode === 'sample-implicit' ) issues.push( issue(
		'pmrem.source.equirect-sampling',
		`${ path }.samplingMode`,
		'Equirectangular PMREM sources do not use implicit sampling.',
	) );
	if ( ! isCube && value.samplingMode === 'sample-level' &&
		( value.sampleType !== 'float' || value.samplerType !== 'filtering' ) ) issues.push( issue(
		'pmrem.source.equirect-filtering',
		`${ path }.samplingMode`,
		'Equirectangular sample-level PMREM sources require a filterable float texture and filtering sampler.',
	) );
	if ( value.samplingMode === 'manual-linear' && value.sampleType !== 'unfilterable-float' ) issues.push( issue(
		'pmrem.source.manual-filtering',
		`${ path }.samplingMode`,
		'Manual-linear PMREM sampling is only valid for unfilterable Float32 sources.',
	) );
	const hasWrap = value.wrapS !== null || value.wrapT !== null;
	if ( expectsWrap && ( value.wrapS === null || value.wrapT === null ) ||
		! expectsWrap && hasWrap ) issues.push( issue(
		'pmrem.source.wrap-mode',
		`${ path }.wrapS`,
		'PMREM wrapping must be present only for manual-linear/load equirectangular sampling.',
	) );
	if ( ( value.samplerType === 'none' ) !== expectsWrap ) issues.push( issue(
		'pmrem.source.sampler-mode',
		`${ path }.samplerType`,
		'PMREM samplerType must agree with the selected sampling mode.',
	) );

}

function isPowerOfTwoInteger( value ) {

	return Number.isSafeInteger( value ) && value > 0 && Number.isInteger( Math.log2( value ) );

}

function validateExactKeys( value, allowed, path, issues ) {

	for ( const key of Object.keys( value ) ) {

		if ( ! allowed.has( key ) ) issues.push( issue(
			'pmrem.config-field',
			`${ path }.${ key }`,
			`${ path } contains unknown field ${ JSON.stringify( key ) }.`,
		) );

	}
	for ( const key of allowed ) {

		if ( key === 'source' ) continue;
		if ( ! Object.prototype.hasOwnProperty.call( value, key ) ) issues.push( issue(
			'pmrem.config-field-missing',
			`${ path }.${ key }`,
			`${ path } is missing required field ${ JSON.stringify( key ) }.`,
		) );

	}

}

function compactObject( value ) {

	return Object.fromEntries( Object.entries( value ).filter( ( [ , entry ] ) => entry !== undefined ) );

}

function cloneJson( value ) {

	return JSON.parse( JSON.stringify( value ) );

}

function safeRead( value, key ) {

	try {

		return value && value[ key ];

	} catch ( _ ) {

		return undefined;

	}

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
