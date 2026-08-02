import { collectArtifactVariantCandidates } from './artifact-variants.js';
import {
	PMREM_SUPPORT_PROFILES,
	pmremRequiredStages,
	pmremSourceInputTopology,
	samePMREMConfig,
	validatePMREMLayoutConfig,
	validatePMREMSupportConfig,
} from './pmrem-config.js';
import {
	vsmMomentsTopology,
	vsmSourceInputTopology,
	validateVSMSupportConfig,
} from './vsm-config.js';
import { stableJsonStringify } from './stable-json.js';

/**
 * Durable descriptor for renderer-owned draw programs whose shaders are
 * captured from a real Three render and replayed without the runtime compiler.
 *
 * The descriptor deliberately carries semantic roles rather than captured
 * object UUIDs. UUIDs remain extraction evidence inside `uniformPlan`; the
 * slim binder uses the semantic address to attach the current pass resource to
 * every captured family member.
 */
export const INTERNAL_PASS_SCHEMA = 'internal-pass@1';

const PMREM_BLUR_UNIFORMS = Object.freeze( [ 'samples', 'latitudinal', 'd-theta', 'mip-int', 'pole-axis' ] );
const VSM_UNIFORMS = Object.freeze( [ 'blur-samples', 'radius', 'map-size' ] );
const VSM_UNIFORM_SOURCE_KINDS = Object.freeze( {
	'blur-samples': 'light.shadowBlurSamples',
	radius: 'light.shadowRadius',
	'map-size': 'light.shadowMapSize',
	'depth-layer': 'uniform.live',
} );

export const INTERNAL_PASS_STAGE_DEFINITIONS = deepFreeze( {
	pmrem: {
		cubemap: {
			shape: 'pmrem-cubemap',
			requiredUniforms: [],
			optionalUniforms: [],
			requiredInputs: { source: 'texture' },
			optionalInputs: {},
		},
		equirect: {
			shape: 'pmrem-equirect',
			requiredUniforms: [],
			optionalUniforms: [],
			requiredInputs: { source: 'texture' },
			optionalInputs: {},
		},
		blur: {
			shape: 'pmrem-blur',
			requiredUniforms: PMREM_BLUR_UNIFORMS,
			optionalUniforms: [],
			requiredInputs: { 'env-map': 'texture', weights: 'buffer' },
			optionalInputs: {},
		},
		ggx: {
			shape: 'pmrem-ggx',
			requiredUniforms: [ 'roughness', 'mip-int' ],
			optionalUniforms: [],
			requiredInputs: { 'env-map': 'texture' },
			optionalInputs: {},
		},
	},
	'shadow-vsm': {
		vertical: {
			shape: 'shadow-vsm-vertical',
			requiredUniforms: VSM_UNIFORMS,
			optionalUniforms: [ 'depth-layer' ],
			uniformSourceKinds: VSM_UNIFORM_SOURCE_KINDS,
			requiredInputs: { 'shadow-depth': 'texture' },
			optionalInputs: {},
		},
		horizontal: {
			shape: 'shadow-vsm-horizontal',
			requiredUniforms: VSM_UNIFORMS,
			optionalUniforms: [ 'depth-layer' ],
			uniformSourceKinds: VSM_UNIFORM_SOURCE_KINDS,
			requiredInputs: { 'vsm-vertical': 'texture' },
			optionalInputs: {},
		},
	},
} );

export const INTERNAL_PASS_FAMILIES = Object.freeze( Object.keys( INTERNAL_PASS_STAGE_DEFINITIONS ) );
export const INTERNAL_PASS_STAGES = deepFreeze( Object.fromEntries(
	Object.entries( INTERNAL_PASS_STAGE_DEFINITIONS ).map( ( [ family, stages ] ) => [ family, Object.keys( stages ) ] )
) );
export const INTERNAL_PASS_SHAPES = Object.freeze( Object.values( INTERNAL_PASS_STAGE_DEFINITIONS )
	.flatMap( ( stages ) => Object.values( stages ).map( ( stage ) => stage.shape ) ) );
export const INTERNAL_PASS_FAMILY_REQUIREMENTS = deepFreeze( {
	pmrem: {
		requiredStages: [ 'ggx' ],
		oneOfStages: [ 'cubemap', 'equirect', 'blur' ],
		requiredAuxiliaryShapes: [],
	},
	'shadow-vsm': {
		requiredStages: [ 'vertical', 'horizontal' ],
		oneOfStages: [],
		requiredAuxiliaryShapes: [ 'shadow-depth' ],
	},
} );

const TEXTURE_DIMENSIONS = new Set( [ '2d', '2d-array', 'cube', 'cube-array', '3d' ] );
const INPUT_KINDS = new Set( [ 'texture', 'buffer' ] );
const UNIFORM_VALUE_TYPES = new Set( [
	'number', 'float', 'f32', 'int', 'i32', 'uint', 'u32', 'bool',
	'vec2', 'vec3', 'vec4', 'color', 'mat3', 'mat4',
] );
const BUFFER_ARRAY_TYPES = Object.freeze( {
	Float32Array: Object.freeze( { elementType: 'f32', bytes: 4 } ),
} );
const TEXTURE_TOPOLOGY_KEYS = new Set( [
	'dimension',
	'format',
	'internalFormat',
	'type',
	'sampleType',
	'samplingMode',
	'samplerType',
	'colorSpace',
	'layers',
	'samples',
	'depth',
	'stencil',
	'multiview',
	'comparison',
] );
const BUFFER_TOPOLOGY_KEYS = new Set( [ 'arrayType', 'elementType', 'count', 'itemSize', 'stride', 'byteLength' ] );
const RESOURCE_EDGE_TOPOLOGY_KEYS = Object.freeze( [
	'dimension',
	'format',
	'internalFormat',
	'type',
	'sampleType',
	'samplingMode',
	'samplerType',
	'colorSpace',
	'layers',
	'samples',
	'multiview',
] );
const VSM_TOPOLOGY_KEYS = Object.freeze( [
	...RESOURCE_EDGE_TOPOLOGY_KEYS,
	'depth',
	'stencil',
	'comparison',
] );

export class InternalPassContractError extends Error {

	constructor( code, message, issues = [] ) {

		super( message );
		this.name = 'InternalPassContractError';
		this.code = code;
		this.issues = issues;
		this.tslPrecompileInternalPass = true;

	}

}

export function internalPassShape( family, stage ) {

	return INTERNAL_PASS_STAGE_DEFINITIONS[ family ]?.[ stage ]?.shape || null;

}

export function getInternalPassStageDefinition( family, stage ) {

	return INTERNAL_PASS_STAGE_DEFINITIONS[ family ]?.[ stage ] || null;

}

/**
 * Validate the stage inventory of one renderer-owned internal-pass family.
 * Callers that know the exact operation being captured should pass
 * `expectedStages`; otherwise the contract's minimum viable family is used.
 *
 * @param {string} family
 * @param {Iterable<string>} stages
 * @param {{ expectedStages?: Iterable<string>, profile?: string, config?: Object }} [options]
 * @return {Array<{code:string,path:string,message:string}>}
 */
export function validateInternalPassFamilyStages( family, stages, options = {} ) {

	const issues = [];
	const requirement = INTERNAL_PASS_FAMILY_REQUIREMENTS[ family ];
	if ( ! requirement ) {

		return [ issue(
			'internal-pass.family',
			'internalPass.family',
			`Unknown internal pass family ${ JSON.stringify( family ) }.`,
		) ];

	}
	let present;
	if ( typeof stages === 'string' ) {

		return [ issue(
			'internal-pass.family.stages',
			'internalPass.stages',
			'internal-pass family stages must be an iterable of stage names, not one string.',
		) ];

	}
	try {

		present = new Set( stages || [] );

	} catch ( _ ) {

		return [ issue(
			'internal-pass.family.stages',
			'internalPass.stages',
			'internal-pass family stages must be iterable.',
		) ];

	}
	for ( const stage of present ) {

		if ( typeof stage !== 'string' || ! getInternalPassStageDefinition( family, stage ) ) issues.push( issue(
			'internal-pass.family.stage',
			'internalPass.stages',
			`Stage ${ JSON.stringify( stage ) } does not belong to internal pass family ${ JSON.stringify( family ) }.`,
		) );

	}
	let explicit = null;
	if ( options.expectedStages !== undefined ) {

		if ( typeof options.expectedStages === 'string' ) {

			issues.push( issue(
				'internal-pass.family.expected-stages',
				'internalPass.expectedStages',
				'internal-pass expected family stages must be an iterable of stage names, not one string.',
			) );
			explicit = [];

		} else try {

			explicit = [ ...new Set( options.expectedStages || [] ) ];

		} catch ( _ ) {

			issues.push( issue(
				'internal-pass.family.expected-stages',
				'internalPass.expectedStages',
				'internal-pass expected family stages must be iterable.',
			) );
			explicit = [];

		}
		if ( explicit.length === 0 ) issues.push( issue(
			'internal-pass.family.expected-stages-empty',
			'internalPass.expectedStages',
			'internal-pass expected family stages must not be empty.',
		) );

	}
	const profile = options.profile || options.config?.profile || null;
	let profileStages = null;
	if ( family === 'pmrem' && profile !== null ) {

		profileStages = pmremRequiredStages( profile );
		if ( profileStages.length === 0 ) issues.push( issue(
			'internal-pass.family.profile',
			'internalPass.config.profile',
			`PMREM family profile must be one of ${ PMREM_SUPPORT_PROFILES.join( ', ' ) }.`,
		) );

	}
	const required = explicit || profileStages || requirement.requiredStages;
	for ( const stage of required ) {

		if ( ! getInternalPassStageDefinition( family, stage ) ) {

			issues.push( issue(
				'internal-pass.family.expected-stage',
				'internalPass.expectedStages',
				`Expected stage ${ JSON.stringify( stage ) } does not belong to internal pass family ${ JSON.stringify( family ) }.`,
			) );
			continue;

		}
		if ( ! present.has( stage ) ) issues.push( issue(
			'internal-pass.family.missing-stage',
			'internalPass.stages',
			`Internal pass family ${ JSON.stringify( family ) } is missing expected stage ${ JSON.stringify( stage ) }.`,
		) );

	}
	if ( explicit === null && profileStages === null && requirement.oneOfStages.length > 0 &&
		! requirement.oneOfStages.some( ( stage ) => present.has( stage ) ) ) issues.push( issue(
		'internal-pass.family.missing-source-stage',
		'internalPass.stages',
		`Internal pass family ${ JSON.stringify( family ) } requires at least one source stage (${ requirement.oneOfStages.join( ', ' ) }).`,
	) );
	if ( profileStages && profileStages.length > 0 ) {

		const allowed = new Set( profileStages );
		for ( const stage of present ) {

			if ( typeof stage === 'string' && getInternalPassStageDefinition( family, stage ) && ! allowed.has( stage ) ) issues.push( issue(
				'internal-pass.family.profile-stage',
				'internalPass.stages',
				`Stage ${ JSON.stringify( stage ) } is not valid for PMREM profile ${ JSON.stringify( profile ) }.`,
			) );

		}

	}
	return issues;

}

/**
 * Assert that the expected stage inventory is complete before any member is
 * persisted or registered. This prevents a partial family from becoming a
 * durable production input merely because another capture POST succeeded.
 *
 * @param {string} family
 * @param {Iterable<string>} stages
 * @param {{ expectedStages?: Iterable<string>, profile?: string, config?: Object }} [options]
 * @return {Set<string>}
 */
export function assertInternalPassFamilyStages( family, stages, options = {} ) {

	let present;
	try {

		present = new Set( stages || [] );

	} catch ( _ ) {

		const issues = validateInternalPassFamilyStages( family, stages, options );
		throw new InternalPassContractError(
			'TSLP_INTERNAL_PASS_FAMILY_INCOMPLETE',
			`[tsl-precompile/internal-pass] incomplete ${ family } family: ${ issues[ 0 ].message }`,
			issues,
		);

	}
	const issues = validateInternalPassFamilyStages( family, present, options );
	if ( issues.length > 0 ) throw new InternalPassContractError(
		'TSLP_INTERNAL_PASS_FAMILY_INCOMPLETE',
		`[tsl-precompile/internal-pass] incomplete ${ family } family: ${ issues[ 0 ].message }`,
		issues,
	);
	return present;

}

/**
 * Validate a group of persisted family members, including each artifact's
 * semantic addresses, duplicate stages, shared configuration, and minimum
 * stage completeness.
 *
 * @param {Iterable<Object>} artifacts
 * @param {{ family?: string, expectedStages?: Iterable<string>, profile?: string, config?: Object }} [options]
 * @return {Array<{code:string,path:string,message:string}>}
 */
export function validateInternalPassFamily( artifacts, options = {} ) {

	const issues = [];
	let values;
	try {

		values = [ ...( artifacts || [] ) ];

	} catch ( _ ) {

		return [ issue(
			'internal-pass.family.artifacts',
			'internalPass.artifacts',
			'internal-pass family artifacts must be iterable.',
		) ];

	}
	const stages = [];
	const seenStages = new Set();
	const descriptorsByStage = new Map();
	let family = options.family || null;
	let configIdentity = null;
	let familyConfig = null;
	for ( let index = 0; index < values.length; index ++ ) {

		const wrapped = values[ index ];
		const artifact = isRecord( wrapped?.artifact ) && isRecord( wrapped.artifact.internalPass )
			? wrapped.artifact
			: wrapped;
		const path = `internalPass.artifacts[${ index }]`;
		if ( ! isRecord( artifact ) ) {

			issues.push( issue( 'internal-pass.family.artifact', path, `${ path } must be an artifact object.` ) );
			continue;

		}
		const descriptor = artifact.internalPass;
		const descriptorIssues = validateInternalPassDescriptor( descriptor, artifact );
		for ( const entry of descriptorIssues ) issues.push( {
			...entry,
			path: `${ path }.${ entry.path }`,
		} );
		if ( ! isRecord( descriptor ) ) continue;
		if ( family === null && typeof descriptor.family === 'string' ) family = descriptor.family;
		if ( family !== descriptor.family ) issues.push( issue(
			'internal-pass.family.mismatch',
			`${ path }.internalPass.family`,
			`Expected internal pass family ${ JSON.stringify( family ) }, found ${ JSON.stringify( descriptor.family ) }.`,
		) );
		if ( typeof descriptor.stage === 'string' ) {

			stages.push( descriptor.stage );
			if ( seenStages.has( descriptor.stage ) ) issues.push( issue(
				'internal-pass.family.duplicate-stage',
				`${ path }.internalPass.stage`,
				`Internal pass family ${ JSON.stringify( family ) } contains duplicate stage ${ JSON.stringify( descriptor.stage ) }.`,
			) );
			seenStages.add( descriptor.stage );
			if ( ! descriptorsByStage.has( descriptor.stage ) ) descriptorsByStage.set( descriptor.stage, descriptor );

		}
		let nextConfigIdentity;
		try {

			nextConfigIdentity = stableJsonStringify( descriptor.config ?? null, 'internalPass.config' );

		} catch ( _ ) {

			continue; // Descriptor validation already owns the detailed config issue.

		}
		if ( configIdentity === null ) {

			configIdentity = nextConfigIdentity;
			familyConfig = descriptor.config ?? null;

		}
		else if ( configIdentity !== nextConfigIdentity ) issues.push( issue(
			'internal-pass.family.config-mismatch',
			`${ path }.internalPass.config`,
			'Every internal-pass family member must use the same canonical config.',
		) );

	}
	if ( values.length === 0 || family === null ) issues.push( issue(
		'internal-pass.family.empty',
		'internalPass.artifacts',
		'Internal-pass family contains no identifiable artifacts.',
	) );
	if ( family !== null ) {

		issues.push( ...validateInternalPassFamilyStages( family, stages, {
			...options,
			...( options.config === undefined && familyConfig !== null ? { config: familyConfig } : {} ),
		} ) );
		validateInternalPassFamilyEdges( family, descriptorsByStage, issues );

	}
	return issues;

}

export function assertInternalPassFamily( artifacts, options = {} ) {

	let values;
	try {

		values = [ ...( artifacts || [] ) ];

	} catch ( _ ) {

		const issues = validateInternalPassFamily( artifacts, options );
		throw new InternalPassContractError(
			'TSLP_INTERNAL_PASS_FAMILY_INVALID',
			`[tsl-precompile/internal-pass] invalid internal-pass family: ${ issues[ 0 ].message }`,
			issues,
		);

	}
	const issues = validateInternalPassFamily( values, options );
	if ( issues.length > 0 ) throw new InternalPassContractError(
		'TSLP_INTERNAL_PASS_FAMILY_INVALID',
		`[tsl-precompile/internal-pass] invalid internal-pass family: ${ issues[ 0 ].message }`,
		issues,
	);
	return values;

}

/**
 * Validate one `internal-pass@1` descriptor. When an artifact is supplied, the
 * semantic addresses must resolve exactly once in every authoritative variant
 * member and the artifact shape must match the family/stage definition.
 *
 * @param {*} descriptor
 * @param {?Object} [artifact=null]
 * @return {Array<{code:string,path:string,message:string}>}
 */
export function validateInternalPassDescriptor( descriptor, artifact = null ) {

	const issues = [];
	if ( ! isRecord( descriptor ) ) {

		issues.push( issue( 'internal-pass.descriptor', 'internalPass', 'internalPass must be a plain object.' ) );
		return issues;

	}
	if ( descriptor.schema !== INTERNAL_PASS_SCHEMA ) {

		issues.push( issue(
			'internal-pass.schema',
			'internalPass.schema',
			`internalPass.schema must equal ${ JSON.stringify( INTERNAL_PASS_SCHEMA ) }.`,
		) );

	}
	const definition = getInternalPassStageDefinition( descriptor.family, descriptor.stage );
	if ( ! definition ) {

		issues.push( issue(
			'internal-pass.stage',
			'internalPass.stage',
			`Unknown internal pass family/stage ${ JSON.stringify( descriptor.family ) }/${ JSON.stringify( descriptor.stage ) }.`,
		) );

	}
	const expectedShape = definition && definition.shape;
	if ( typeof descriptor.shape !== 'string' || descriptor.shape.length === 0 ) {

		issues.push( issue( 'internal-pass.shape', 'internalPass.shape', 'internalPass.shape must be a non-empty string.' ) );

	} else if ( expectedShape && descriptor.shape !== expectedShape ) {

		issues.push( issue(
			'internal-pass.shape-stage',
			'internalPass.shape',
			`internalPass.shape must be ${ JSON.stringify( expectedShape ) } for ${ descriptor.family }/${ descriptor.stage }.`,
		) );

	}
	if ( descriptor.family === 'pmrem' ) {

		issues.push( ...validatePMREMSupportConfig( descriptor.config, 'internalPass.config' ) );
		const allowedStages = pmremRequiredStages( descriptor.config?.profile );
		if ( definition && allowedStages.length > 0 && ! allowedStages.includes( descriptor.stage ) ) issues.push( issue(
			'internal-pass.pmrem.profile-stage',
			'internalPass.stage',
			`PMREM stage ${ JSON.stringify( descriptor.stage ) } is not valid for profile ${ JSON.stringify( descriptor.config?.profile ) }.`,
		) );

	} else if ( descriptor.family === 'shadow-vsm' ) {

		issues.push( ...validateVSMSupportConfig( descriptor.config, 'internalPass.config' ) );

	} else if ( descriptor.config !== undefined ) validatePlainConfig( descriptor.config, issues );

	const uniforms = validateUniformDescriptors( descriptor.uniforms, definition, issues );
	const inputs = validateInputDescriptors( descriptor.inputs, definition, issues );
	validateOutputDescriptor( descriptor.output, issues );
	validateRoleUniqueness( uniforms, inputs, issues );
	validateAddressUniqueness( uniforms, inputs, issues );
	if ( descriptor.family === 'pmrem' ) validatePMREMDescriptorConfigAgreement( descriptor, artifact, inputs, issues );
	if ( descriptor.family === 'shadow-vsm' ) validateVSMDescriptorConfigAgreement( descriptor, inputs, issues );

	if ( artifact && isRecord( artifact ) ) validateArtifactAddresses( artifact, descriptor, uniforms, inputs, issues );
	else if ( artifact !== null && artifact !== undefined ) {

		issues.push( issue( 'internal-pass.artifact', 'artifact', 'artifact must be an object when supplied.' ) );

	}
	return issues;

}

/**
 * Assert and return an artifact's descriptor.
 *
 * @param {Object} artifact
 * @return {Object}
 */
export function assertInternalPassArtifact( artifact ) {

	if ( ! isRecord( artifact ) ) throw new InternalPassContractError(
		'TSLP_INTERNAL_PASS_ARTIFACT_INVALID',
		'[tsl-precompile/internal-pass] expected an artifact object.',
		[ issue( 'internal-pass.artifact', 'artifact', 'artifact must be an object.' ) ],
	);
	const issues = validateInternalPassDescriptor( artifact.internalPass, artifact );
	if ( issues.length > 0 ) throw new InternalPassContractError(
		'TSLP_INTERNAL_PASS_DESCRIPTOR_INVALID',
		`[tsl-precompile/internal-pass] invalid internalPass descriptor: ${ issues[ 0 ].message }`,
		issues,
	);
	return artifact.internalPass;

}

function validateUniformDescriptors( value, definition, issues ) {

	if ( ! Array.isArray( value ) ) {

		issues.push( issue( 'internal-pass.uniforms', 'internalPass.uniforms', 'internalPass.uniforms must be an array.' ) );
		return [];

	}
	const allowedRoles = new Set( [
		...( definition?.requiredUniforms || [] ),
		...( definition?.optionalUniforms || [] ),
	] );
	const descriptors = [];
	for ( let index = 0; index < value.length; index ++ ) {

		const descriptor = value[ index ];
		const path = `internalPass.uniforms[${ index }]`;
		if ( ! isRecord( descriptor ) ) {

			issues.push( issue( 'internal-pass.uniform', path, `${ path } must be an object.` ) );
			continue;

		}
		validateRoleAndAddress( descriptor, path, issues );
		if ( ! UNIFORM_VALUE_TYPES.has( descriptor.valueType ) ) issues.push( issue(
			'internal-pass.uniform.value-type',
			`${ path }.valueType`,
			`${ path }.valueType must be a supported scalar/vector/matrix type.`,
		) );
		if ( definition && ! allowedRoles.has( descriptor.role ) ) issues.push( issue(
			'internal-pass.uniform.role',
			`${ path }.role`,
			`Uniform role ${ JSON.stringify( descriptor.role ) } is not valid for this internal pass stage.`,
		) );
		descriptors.push( descriptor );

	}
	for ( const role of definition?.requiredUniforms || [] ) {

		if ( ! descriptors.some( ( descriptor ) => descriptor.role === role ) ) issues.push( issue(
			'internal-pass.uniform.required',
			'internalPass.uniforms',
			`Required internal-pass uniform role ${ JSON.stringify( role ) } is missing.`,
		) );

	}
	return descriptors;

}

function validateInputDescriptors( value, definition, issues ) {

	if ( ! Array.isArray( value ) ) {

		issues.push( issue( 'internal-pass.inputs', 'internalPass.inputs', 'internalPass.inputs must be an array.' ) );
		return [];

	}
	const allowedInputs = {
		...( definition?.requiredInputs || {} ),
		...( definition?.optionalInputs || {} ),
	};
	const descriptors = [];
	for ( let index = 0; index < value.length; index ++ ) {

		const descriptor = value[ index ];
		const path = `internalPass.inputs[${ index }]`;
		if ( ! isRecord( descriptor ) ) {

			issues.push( issue( 'internal-pass.input', path, `${ path } must be an object.` ) );
			continue;

		}
		validateRoleAndAddress( descriptor, path, issues );
		if ( ! INPUT_KINDS.has( descriptor.kind ) ) issues.push( issue(
			'internal-pass.input.kind',
			`${ path }.kind`,
			`${ path }.kind must be "texture" or "buffer".`,
		) );
		const expectedKind = allowedInputs[ descriptor.role ];
		if ( definition && expectedKind === undefined ) issues.push( issue(
			'internal-pass.input.role',
			`${ path }.role`,
			`Input role ${ JSON.stringify( descriptor.role ) } is not valid for this internal pass stage.`,
		) );
		else if ( expectedKind !== undefined && descriptor.kind !== expectedKind ) issues.push( issue(
			'internal-pass.input.role-kind',
			`${ path }.kind`,
			`Input role ${ JSON.stringify( descriptor.role ) } must have kind ${ JSON.stringify( expectedKind ) }.`,
		) );
		if ( descriptor.kind === 'texture' ) validateTextureTopology( descriptor.topology, `${ path }.topology`, issues, false );
		else if ( descriptor.kind === 'buffer' ) validateBufferTopology( descriptor.topology, `${ path }.topology`, issues );
		descriptors.push( descriptor );

	}
	for ( const [ role, kind ] of Object.entries( definition?.requiredInputs || {} ) ) {

		if ( ! descriptors.some( ( descriptor ) => descriptor.role === role && descriptor.kind === kind ) ) issues.push( issue(
			'internal-pass.input.required',
			'internalPass.inputs',
			`Required internal-pass ${ kind } input role ${ JSON.stringify( role ) } is missing.`,
		) );

	}
	return descriptors;

}

function validateOutputDescriptor( value, issues ) {

	if ( ! isRecord( value ) ) {

		issues.push( issue( 'internal-pass.output', 'internalPass.output', 'internalPass.output must be an object.' ) );
		return;

	}
	validateTextureTopology( value.topology, 'internalPass.output.topology', issues, true );

}

function validateRoleAndAddress( descriptor, path, issues ) {

	for ( const property of [ 'role', 'group', 'binding' ] ) {

		if ( typeof descriptor[ property ] !== 'string' || descriptor[ property ].length === 0 ) issues.push( issue(
			`internal-pass.${ property }`,
			`${ path }.${ property }`,
			`${ path }.${ property } must be a non-empty string.`,
		) );

	}
	if ( typeof descriptor.role === 'string' && ! /^[a-z][a-z0-9-]*$/.test( descriptor.role ) ) issues.push( issue(
		'internal-pass.role-spelling',
		`${ path }.role`,
		`${ path }.role must use canonical lower-kebab-case spelling.`,
	) );

}

function validateRoleUniqueness( uniforms, inputs, issues ) {

	const seen = new Map();
	for ( const [ kind, descriptors ] of [ [ 'uniform', uniforms ], [ 'input', inputs ] ] ) {

		for ( const descriptor of descriptors ) {

			if ( typeof descriptor.role !== 'string' || descriptor.role.length === 0 ) continue;
			const previous = seen.get( descriptor.role );
			if ( previous ) issues.push( issue(
				'internal-pass.role-duplicate',
				`internalPass.${ kind === 'uniform' ? 'uniforms' : 'inputs' }`,
				`Semantic role ${ JSON.stringify( descriptor.role ) } is declared more than once (${ previous } and ${ kind }).`,
			) );
			else seen.set( descriptor.role, kind );

		}

	}

}

function validateAddressUniqueness( uniforms, inputs, issues ) {

	const namespaces = [
		[ 'uniform', uniforms ],
		[ 'texture', inputs.filter( ( descriptor ) => descriptor.kind === 'texture' ) ],
		[ 'buffer', inputs.filter( ( descriptor ) => descriptor.kind === 'buffer' ) ],
	];
	for ( const [ namespace, descriptors ] of namespaces ) {

		const seen = new Map();
		for ( const descriptor of descriptors ) {

			if ( typeof descriptor.group !== 'string' || descriptor.group.length === 0 ||
				typeof descriptor.binding !== 'string' || descriptor.binding.length === 0 ) continue;
			const address = `${ descriptor.group }\u0000${ descriptor.binding }`;
			const previous = seen.get( address );
			if ( previous ) issues.push( issue(
				'internal-pass.address-duplicate',
				`internalPass.${ namespace === 'uniform' ? 'uniforms' : 'inputs' }`,
				`${ namespace } roles ${ JSON.stringify( previous ) } and ${ JSON.stringify( descriptor.role ) } both address ${ JSON.stringify( `${ descriptor.group }/${ descriptor.binding }` ) }.`,
			) );
			else seen.set( address, descriptor.role );

		}

	}

}

function validateTextureTopology( topology, path, issues, output ) {

	if ( ! isRecord( topology ) ) {

		issues.push( issue( 'internal-pass.topology', path, `${ path } must be an object.` ) );
		return;

	}
	validateKnownKeys( topology, TEXTURE_TOPOLOGY_KEYS, path, issues );
	if ( ! TEXTURE_DIMENSIONS.has( topology.dimension ) ) issues.push( issue(
		'internal-pass.topology.dimension',
		`${ path }.dimension`,
		`${ path }.dimension must be one of ${ [ ...TEXTURE_DIMENSIONS ].join( ', ' ) }.`,
	) );
	for ( const property of [ 'layers', 'samples' ] ) {

		if ( topology[ property ] !== undefined && ( ! Number.isSafeInteger( topology[ property ] ) || topology[ property ] <= 0 ) ) issues.push( issue(
			'internal-pass.topology.integer',
			`${ path }.${ property }`,
			`${ path }.${ property } must be a positive integer when present.`,
		) );

	}
	for ( const property of [ 'depth', 'stencil', 'multiview', 'comparison' ] ) {

		if ( topology[ property ] !== undefined && typeof topology[ property ] !== 'boolean' ) issues.push( issue(
			'internal-pass.topology.boolean',
			`${ path }.${ property }`,
			`${ path }.${ property } must be boolean when present.`,
		) );

	}
	if ( output && typeof topology.depth !== 'boolean' ) issues.push( issue(
		'internal-pass.output.depth',
		`${ path }.depth`,
		'Internal-pass output topology must state whether it owns a depth attachment.',
	) );
	for ( const property of [
		'format',
		'internalFormat',
		'type',
		'sampleType',
		'samplingMode',
		'samplerType',
		'colorSpace',
	] ) {

		const value = topology[ property ];
		if ( value !== undefined && ! isScalarOrNull( value ) ) issues.push( issue(
			'internal-pass.topology.scalar',
			`${ path }.${ property }`,
			`${ path }.${ property } must be a scalar or null when present.`,
		) );

	}

}

function validateBufferTopology( topology, path, issues ) {

	if ( ! isRecord( topology ) ) {

		issues.push( issue( 'internal-pass.buffer.topology', path, `${ path } must be an object.` ) );
		return;

	}
	validateKnownKeys( topology, BUFFER_TOPOLOGY_KEYS, path, issues );
	const arrayInfo = BUFFER_ARRAY_TYPES[ topology.arrayType ];
	if ( ! arrayInfo ) issues.push( issue(
		'internal-pass.buffer.array-type',
		`${ path }.arrayType`,
		`${ path }.arrayType must be one of ${ Object.keys( BUFFER_ARRAY_TYPES ).join( ', ' ) }.`,
	) );
	if ( topology.elementType !== undefined && arrayInfo && topology.elementType !== arrayInfo.elementType ) issues.push( issue(
		'internal-pass.buffer.element-type',
		`${ path }.elementType`,
		`${ path }.elementType must agree with ${ topology.arrayType } (${ arrayInfo.elementType }).`,
	) );
	if ( ! Number.isSafeInteger( topology.byteLength ) || topology.byteLength <= 0 ) issues.push( issue(
		'internal-pass.buffer.integer',
		`${ path }.byteLength`,
		`${ path }.byteLength must be a positive integer.`,
	) );
	else if ( arrayInfo && topology.byteLength % arrayInfo.bytes !== 0 ) issues.push( issue(
		'internal-pass.buffer.byte-alignment',
		`${ path }.byteLength`,
		`${ path }.byteLength must be divisible by the ${ topology.arrayType } element width.`,
	) );
	const explicitLayoutFields = [ 'count', 'itemSize', 'stride' ];
	const explicitLayoutCount = explicitLayoutFields.filter( ( property ) => topology[ property ] !== undefined ).length;
	if ( explicitLayoutCount !== 0 && explicitLayoutCount !== explicitLayoutFields.length ) issues.push( issue(
		'internal-pass.buffer.layout-fields',
		path,
		`${ path } must provide count, itemSize, and stride together when an explicit logical layout is present.`,
	) );
	for ( const property of explicitLayoutFields ) {

		if ( topology[ property ] !== undefined && ( ! Number.isSafeInteger( topology[ property ] ) || topology[ property ] <= 0 ) ) issues.push( issue(
			'internal-pass.buffer.integer',
			`${ path }.${ property }`,
			`${ path }.${ property } must be a positive integer when present.`,
		) );

	}
	if ( Number.isSafeInteger( topology.stride ) && Number.isSafeInteger( topology.itemSize ) && topology.stride < topology.itemSize ) issues.push( issue(
		'internal-pass.buffer.stride',
		`${ path }.stride`,
		`${ path }.stride must be greater than or equal to itemSize.`,
	) );
	if ( arrayInfo &&
		Number.isSafeInteger( topology.count ) &&
		Number.isSafeInteger( topology.stride ) &&
		Number.isSafeInteger( topology.byteLength ) &&
		topology.byteLength !== topology.count * topology.stride * arrayInfo.bytes ) issues.push( issue(
		'internal-pass.buffer.byte-length',
		`${ path }.byteLength`,
		`${ path }.byteLength must equal count × stride × element byte width.`,
	) );

}

function validateKnownKeys( value, allowed, path, issues ) {

	for ( const key of Object.keys( value ) ) {

		if ( ! allowed.has( key ) ) issues.push( issue(
			'internal-pass.topology-field',
			`${ path }.${ key }`,
			`${ path } contains unknown field ${ JSON.stringify( key ) }; bump the schema before adding topology axes.`,
		) );

	}

}

function validatePlainConfig( config, issues ) {

	if ( ! isRecord( config ) ) {

		issues.push( issue( 'internal-pass.config', 'internalPass.config', 'internalPass.config must be a plain JSON object when present.' ) );
		return;

	}
	try {

		stableJsonStringify( config, 'internalPass.config' );

	} catch ( error ) {

		issues.push( issue(
			'internal-pass.config-json',
			'internalPass.config',
			`internalPass.config must be canonical JSON data: ${ error && error.message || String( error ) }`,
		) );

	}

}

function validatePMREMDescriptorConfigAgreement( descriptor, artifact, inputs, issues ) {

	const config = descriptor.config;
	if ( ! isRecord( config ) ) return;
	const sourceInput = inputs.find( ( input ) => input && input.role === 'source' && input.kind === 'texture' );
	if ( sourceInput && isRecord( config.source ) ) {

		const expected = pmremSourceInputTopology( config.source );
		if ( expected && ! sameResourceTopology( sourceInput.topology, expected, RESOURCE_EDGE_TOPOLOGY_KEYS ) ) issues.push( issue(
			'internal-pass.pmrem.source-topology',
			'internalPass.inputs',
			'PMREM source input topology must agree with internalPass.config.source.',
		) );

	}
	if ( ! artifact || ! isRecord( artifact ) ) return;
	if ( artifact.replayConfig === undefined ) {

		issues.push( issue(
			'internal-pass.pmrem.replay-config',
			'artifact.replayConfig',
			'PMREM artifacts must carry replayConfig matching internalPass.config.layout.',
		) );
		return;

	}
	const replayIssues = validatePMREMLayoutConfig( artifact.replayConfig, 'artifact.replayConfig' );
	issues.push( ...replayIssues );
	if ( replayIssues.length === 0 && ! samePMREMConfig( artifact.replayConfig, config.layout ) ) issues.push( issue(
		'internal-pass.pmrem.replay-config-mismatch',
		'artifact.replayConfig',
		'PMREM artifact replayConfig must equal internalPass.config.layout.',
	) );

}

function validateVSMDescriptorConfigAgreement( descriptor, inputs, issues ) {

	const config = descriptor.config;
	if ( ! isRecord( config ) ) return;
	const input = inputs.find( ( candidate ) => candidate && candidate.kind === 'texture' );
	const expectedInput = descriptor.stage === 'vertical'
		? vsmSourceInputTopology( config )
		: vsmMomentsTopology( config );
	if ( input && expectedInput &&
		! sameResourceTopology( input.topology, expectedInput, VSM_TOPOLOGY_KEYS ) ) issues.push( issue(
		'internal-pass.vsm.input-topology',
		'internalPass.inputs',
		`VSM ${ descriptor.stage } input topology must agree with internalPass.config.`,
	) );
	const expectedOutput = vsmMomentsTopology( config );
	if ( expectedOutput && ! sameResourceTopology(
		descriptor.output?.topology,
		expectedOutput,
		VSM_TOPOLOGY_KEYS,
	) ) issues.push( issue(
		'internal-pass.vsm.output-topology',
		'internalPass.output.topology',
		`VSM ${ descriptor.stage } output topology must agree with internalPass.config.moments.`,
	) );

}

function validateInternalPassFamilyEdges( family, descriptorsByStage, issues ) {

	if ( family === 'shadow-vsm' ) {

		validateFamilyTextureEdge(
			descriptorsByStage.get( 'vertical' ),
			descriptorsByStage.get( 'horizontal' ),
			'vsm-vertical',
			'shadow-vsm vertical output',
			issues,
		);

	}
	if ( family === 'pmrem' ) {

		const sourceProducer = descriptorsByStage.get( 'equirect' ) || descriptorsByStage.get( 'cubemap' );
		const producer = sourceProducer || descriptorsByStage.get( 'blur' );
		const consumer = descriptorsByStage.get( 'ggx' );
		if ( producer && consumer ) validateFamilyTextureEdge(
			producer,
			consumer,
			'env-map',
			sourceProducer ? 'PMREM source conversion output' : 'PMREM scene blur output',
			issues,
		);

	}

}

function validateFamilyTextureEdge( producer, consumer, inputRole, producerLabel, issues ) {

	if ( ! isRecord( producer ) || ! isRecord( consumer ) ) return;
	const input = Array.isArray( consumer.inputs )
		? consumer.inputs.find( ( candidate ) => candidate && candidate.kind === 'texture' && candidate.role === inputRole )
		: null;
	const outputTopology = producer.output?.topology;
	if ( ! input || ! isRecord( outputTopology ) || ! isRecord( input.topology ) ) return;
	if ( sameResourceTopology( outputTopology, input.topology, RESOURCE_EDGE_TOPOLOGY_KEYS ) ) return;
	issues.push( issue(
		'internal-pass.family.edge-topology',
		`internalPass.${ consumer.stage }.inputs.${ inputRole }.topology`,
		`${ producerLabel } topology does not match ${ consumer.stage } input ${ JSON.stringify( inputRole ) }.`,
	) );

}

function sameResourceTopology( left, right, keys ) {

	if ( ! isRecord( left ) || ! isRecord( right ) ) return false;
	for ( const key of keys ) {

		const leftHas = Object.prototype.hasOwnProperty.call( left, key );
		const rightHas = Object.prototype.hasOwnProperty.call( right, key );
		if ( leftHas !== rightHas || leftHas && left[ key ] !== right[ key ] ) return false;

	}
	return true;

}

function validateArtifactAddresses( artifact, descriptor, uniforms, inputs, issues ) {

	if ( descriptor.shape && artifact.materialShape !== descriptor.shape ) issues.push( issue(
		'internal-pass.artifact-shape',
		'artifact.materialShape',
		`Artifact materialShape ${ JSON.stringify( artifact.materialShape ) } does not match internal pass shape ${ JSON.stringify( descriptor.shape ) }.`,
	) );
	const candidates = collectArtifactVariantCandidates( artifact );
	if ( candidates.length === 0 ) {

		issues.push( issue( 'internal-pass.artifact-family', 'artifact', 'Artifact family has no authoritative members.' ) );
		return;

	}
	for ( let index = 0; index < candidates.length; index ++ ) {

		const candidate = candidates[ index ];
		const candidatePath = `artifactFamily[${ index }]`;
		if ( candidate.internalPass !== undefined ) {

			try {

				if ( stableJsonStringify( candidate.internalPass, 'candidate.internalPass' ) !== stableJsonStringify( descriptor, 'artifact.internalPass' ) ) issues.push( issue(
					'internal-pass.variant-descriptor',
					`${ candidatePath }.internalPass`,
					'Every variant-local internalPass descriptor must equal the family descriptor.',
				) );

			} catch ( _ ) {

				issues.push( issue(
					'internal-pass.variant-descriptor-json',
					`${ candidatePath }.internalPass`,
					'Variant-local internalPass descriptor must be canonical JSON.',
				) );

			}

		}
		for ( const uniform of uniforms ) validateUniformAddress( candidate, uniform, descriptor, candidatePath, issues );
		for ( const input of inputs ) {

			if ( input.kind === 'texture' ) validateTextureAddress( candidate, input, candidatePath, issues );
			else if ( input.kind === 'buffer' ) validateBufferAddress( candidate, input, candidatePath, issues );

		}

	}

}

function validateUniformAddress( candidate, uniform, passDescriptor, candidatePath, issues ) {

	const matches = findPlanEntries( candidate, uniform.group, 'slots', uniform.binding );
	if ( matches.length !== 1 ) {

		issues.push( addressIssue( 'uniform', uniform, candidatePath, matches.length ) );
		return;

	}
	const slot = matches[ 0 ];
	const definition = getInternalPassStageDefinition( passDescriptor.family, passDescriptor.stage );
	const expectedSourceKind = definition?.uniformSourceKinds?.[ uniform.role ] || 'uniform.live';
	if ( slot.source?.kind !== expectedSourceKind ) issues.push( issue(
		'internal-pass.uniform.source-kind',
		`${ candidatePath }.uniformPlan`,
		`Uniform role ${ JSON.stringify( uniform.role ) } must address a ${ expectedSourceKind } slot, found ${ JSON.stringify( slot.source?.kind ) }.`,
	) );

}

function validateTextureAddress( candidate, descriptor, candidatePath, issues ) {

	const matches = findPlanEntries( candidate, descriptor.group, 'textures', descriptor.binding );
	if ( matches.length !== 1 ) {

		issues.push( addressIssue( 'texture', descriptor, candidatePath, matches.length ) );
		return;

	}
	const source = matches[ 0 ].source || {};
	if ( source.kind !== 'artifact.texture' && source.kind !== 'depth.texture' ) issues.push( issue(
		'internal-pass.texture.source-kind',
		`${ candidatePath }.uniformPlan`,
		`Texture role ${ JSON.stringify( descriptor.role ) } must address artifact.texture or depth.texture evidence, found ${ JSON.stringify( source.kind ) }.`,
	) );
	if ( typeof source.textureUuid !== 'string' || source.textureUuid.length === 0 ) issues.push( issue(
		'internal-pass.texture.uuid-evidence',
		`${ candidatePath }.uniformPlan`,
		`Texture role ${ JSON.stringify( descriptor.role ) } must retain captured textureUuid evidence in uniformPlan.`,
	) );

}

function validateBufferAddress( candidate, descriptor, candidatePath, issues ) {

	const matches = [];
	const plan = Array.isArray( candidate.uniformPlan ) ? candidate.uniformPlan : [];
	for ( const group of plan ) {

		if ( group?.name !== descriptor.group ) continue;
		const orderedBindings = Array.isArray( group?.orderedBindings ) ? group.orderedBindings : [];
		for ( const binding of orderedBindings ) {

			if ( binding?.type !== 'buffer-uniform' || ! binding.ref ) continue;
			if ( entryBindingName( binding.ref ) === descriptor.binding ) matches.push( binding.ref );

		}

	}
	if ( matches.length !== 1 ) {

		issues.push( addressIssue( 'buffer', descriptor, candidatePath, matches.length ) );
		return;

	}
	const expectedByteLength = descriptor.topology?.byteLength;
	if ( Number.isSafeInteger( expectedByteLength ) && matches[ 0 ].byteLength !== expectedByteLength ) issues.push( issue(
		'internal-pass.buffer.plan-byte-length',
		`${ candidatePath }.uniformPlan`,
		`Buffer role ${ JSON.stringify( descriptor.role ) } expects byteLength ${ expectedByteLength }, found ${ JSON.stringify( matches[ 0 ].byteLength ) }.`,
	) );

}

function findPlanEntries( artifact, groupName, listName, bindingName ) {

	const matches = [];
	const plan = Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [];
	for ( const group of plan ) {

		if ( group?.name !== groupName ) continue;
		const entries = Array.isArray( group?.[ listName ] ) ? group[ listName ] : [];
		for ( const entry of entries ) {

			if ( entryBindingName( entry ) === bindingName ) matches.push( entry );

		}

	}
	return matches;

}

function entryBindingName( entry ) {

	return entry?.name ?? entry?.binding ?? entry?.bindingName ?? null;

}

function addressIssue( kind, descriptor, candidatePath, count ) {

	return issue(
		`internal-pass.${ kind }.address`,
		`${ candidatePath }.uniformPlan`,
		`${ kind } role ${ JSON.stringify( descriptor.role ) } address ${ JSON.stringify( `${ descriptor.group }/${ descriptor.binding }` ) } resolved ${ count } entries; exactly one is required.`,
	);

}

function issue( code, path, message ) {

	return { code, path, message };

}

function isRecord( value ) {

	if ( ! value || typeof value !== 'object' || Array.isArray( value ) ) return false;
	const prototype = Object.getPrototypeOf( value );
	return prototype === Object.prototype || prototype === null;

}

function isScalarOrNull( value ) {

	return value === null || typeof value === 'string' || typeof value === 'number' && Number.isFinite( value ) || typeof value === 'boolean';

}

function deepFreeze( value ) {

	if ( ! value || typeof value !== 'object' || Object.isFrozen( value ) ) return value;
	for ( const child of Object.values( value ) ) deepFreeze( child );
	return Object.freeze( value );

}
