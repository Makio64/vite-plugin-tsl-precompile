import { MATERIAL_TEXTURE_PROPS } from './texture-props.js';

export const DYNAMIC_BINDING_TARGET = Object.freeze( {
	UNIFORM_SLOT: 'uniform-slot',
	SAMPLED_TEXTURE: 'sampled-texture',
	STORAGE_TEXTURE: 'storage-texture',
	SAMPLER: 'sampler',
} );

export const DYNAMIC_BINDING_PHASE = Object.freeze( {
	CODEGEN_UPDATE: 'codegen-update',
	HYDRATE: 'hydrate',
	UPDATE_BEFORE: 'update-before',
	LATE_REBIND: 'late-rebind',
} );

function freezeDescriptor( descriptor ) {

	return Object.freeze( {
		...descriptor,
		required: Object.freeze( [ ...descriptor.required || [] ] ),
		optional: Object.freeze( [ ...descriptor.optional || [] ] ),
	} );

}

function textureDescriptor( kind, property ) {

	return freezeDescriptor( {
		kind,
		target: DYNAMIC_BINDING_TARGET.SAMPLED_TEXTURE,
		phase: DYNAMIC_BINDING_PHASE.LATE_REBIND,
		owner: 'material',
		resolver: 'hydrator/material-texture',
		required: [ 'property' ],
		optional: [ 'textureUuid', 'textureName', 'imageSrc', 'snapshot', 'matrix' ],
		property,
	} );

}

function materialMatrixDescriptor( kind, property ) {

	return freezeDescriptor( {
		kind,
		target: DYNAMIC_BINDING_TARGET.UNIFORM_SLOT,
		phase: DYNAMIC_BINDING_PHASE.CODEGEN_UPDATE,
		owner: 'material',
		resolver: 'emit-updater/material-texture-matrix',
		required: [ 'property' ],
		optional: [ 'valueSnapshot' ],
		property,
	} );

}

const exactDescriptors = {
	'uniform.live': freezeDescriptor( {
		kind: 'uniform.live',
		target: DYNAMIC_BINDING_TARGET.UNIFORM_SLOT,
		phase: DYNAMIC_BINDING_PHASE.UPDATE_BEFORE,
		owner: 'material',
		resolver: 'hydrator/live-node',
		required: [],
		optional: [ 'name', 'property', 'valueType', 'valueSnapshot' ],
	} ),
	'object3d.userData': freezeDescriptor( {
		kind: 'object3d.userData',
		target: DYNAMIC_BINDING_TARGET.UNIFORM_SLOT,
		phase: DYNAMIC_BINDING_PHASE.UPDATE_BEFORE,
		owner: 'object3d',
		resolver: 'hydrator/object-user-data',
		required: [ 'property' ],
		optional: [ 'uniformType', 'valueSnapshot' ],
	} ),
	'artifact.texture': freezeDescriptor( {
		kind: 'artifact.texture',
		target: DYNAMIC_BINDING_TARGET.SAMPLED_TEXTURE,
		phase: DYNAMIC_BINDING_PHASE.LATE_REBIND,
		owner: 'artifact',
		resolver: 'hydrator/artifact-texture',
		required: [],
		optional: [ 'textureUuid', 'textureName', 'imageSrc', 'snapshot', 'mapping', 'textureType', 'textureDimension', 'generateMipmaps', 'colorSpace', 'flipY' ],
	} ),
	'depth.texture': freezeDescriptor( {
		kind: 'depth.texture',
		target: DYNAMIC_BINDING_TARGET.SAMPLED_TEXTURE,
		phase: DYNAMIC_BINDING_PHASE.UPDATE_BEFORE,
		owner: 'light-or-material-graph',
		resolver: 'hydrator/shadow-depth-rebinder',
		required: [],
		optional: [ 'lightIndex', 'lightUuid', 'textureUuid', 'fromMaterialGraph', 'vsm' ],
	} ),
	'viewport.texture': freezeDescriptor( {
		kind: 'viewport.texture',
		target: DYNAMIC_BINDING_TARGET.SAMPLED_TEXTURE,
		phase: DYNAMIC_BINDING_PHASE.UPDATE_BEFORE,
		owner: 'renderer',
		resolver: 'hydrator/viewport-texture-rebinder',
		required: [],
		optional: [ 'generateMipmaps', 'isDepth', 'textureType', 'textureDimension' ],
	} ),
	'reflector.texture': freezeDescriptor( {
		kind: 'reflector.texture',
		target: DYNAMIC_BINDING_TARGET.SAMPLED_TEXTURE,
		phase: DYNAMIC_BINDING_PHASE.UPDATE_BEFORE,
		owner: 'reflector',
		resolver: 'hydrator/reflector-texture-rebinder',
		required: [],
		optional: [ 'reflectorIndex', 'textureUuid' ],
	} ),
	'builtin.dfgLUT': freezeDescriptor( {
		kind: 'builtin.dfgLUT',
		target: DYNAMIC_BINDING_TARGET.SAMPLED_TEXTURE,
		phase: DYNAMIC_BINDING_PHASE.HYDRATE,
		owner: 'runtime',
		resolver: 'hydrator/dfg-lut',
		required: [],
		optional: [],
	} ),
	'builtin.ltcTexture': freezeDescriptor( {
		kind: 'builtin.ltcTexture',
		target: DYNAMIC_BINDING_TARGET.SAMPLED_TEXTURE,
		phase: DYNAMIC_BINDING_PHASE.HYDRATE,
		owner: 'runtime',
		resolver: 'hydrator/ltc-texture',
		required: [ 'ltcIndex' ],
		optional: [ 'magFilter', 'minFilter', 'wrapS', 'wrapT' ],
	} ),
};

for ( const prop of MATERIAL_TEXTURE_PROPS ) {

	exactDescriptors[ `material.${ prop }` ] = textureDescriptor( `material.${ prop }`, prop );
	exactDescriptors[ `material.${ prop }.matrix` ] = materialMatrixDescriptor( `material.${ prop }.matrix`, prop );

}

export const DYNAMIC_BINDING_DESCRIPTORS = Object.freeze( exactDescriptors );

const PREFIX_DESCRIPTORS = Object.freeze( [
	freezeDescriptor( {
		prefix: 'camera.',
		target: DYNAMIC_BINDING_TARGET.UNIFORM_SLOT,
		phase: DYNAMIC_BINDING_PHASE.CODEGEN_UPDATE,
		owner: 'camera',
		resolver: 'emit-updater/camera',
		required: [],
		optional: [ 'valueSnapshot' ],
	} ),
	freezeDescriptor( {
		prefix: 'object.',
		target: DYNAMIC_BINDING_TARGET.UNIFORM_SLOT,
		phase: DYNAMIC_BINDING_PHASE.CODEGEN_UPDATE,
		owner: 'object',
		resolver: 'emit-updater/object',
		required: [],
		optional: [ 'valueSnapshot' ],
	} ),
	freezeDescriptor( {
		prefix: 'object3d.',
		target: DYNAMIC_BINDING_TARGET.UNIFORM_SLOT,
		phase: DYNAMIC_BINDING_PHASE.UPDATE_BEFORE,
		owner: 'object3d',
		resolver: 'emit-updater-or-hydrator/object3d',
		required: [],
		optional: [ 'property', 'uniformType', 'valueSnapshot' ],
	} ),
	freezeDescriptor( {
		prefix: 'frame.',
		target: DYNAMIC_BINDING_TARGET.UNIFORM_SLOT,
		phase: DYNAMIC_BINDING_PHASE.CODEGEN_UPDATE,
		owner: 'frame',
		resolver: 'emit-updater/frame',
		required: [],
		optional: [ 'valueSnapshot' ],
	} ),
	freezeDescriptor( {
		prefix: 'renderer.',
		target: DYNAMIC_BINDING_TARGET.UNIFORM_SLOT,
		phase: DYNAMIC_BINDING_PHASE.CODEGEN_UPDATE,
		owner: 'renderer',
		resolver: 'emit-updater/renderer',
		required: [],
		optional: [ 'valueSnapshot' ],
	} ),
	freezeDescriptor( {
		prefix: 'scene.',
		target: DYNAMIC_BINDING_TARGET.UNIFORM_SLOT,
		phase: DYNAMIC_BINDING_PHASE.CODEGEN_UPDATE,
		owner: 'scene',
		resolver: 'emit-updater/scene',
		required: [],
		optional: [ 'valueSnapshot' ],
	} ),
	freezeDescriptor( {
		prefix: 'light.',
		target: DYNAMIC_BINDING_TARGET.UNIFORM_SLOT,
		phase: DYNAMIC_BINDING_PHASE.UPDATE_BEFORE,
		owner: 'light',
		resolver: 'emit-updater/light',
		required: [],
		optional: [ 'lightIndex', 'lightUuid', 'property', 'valueSnapshot' ],
	} ),
	freezeDescriptor( {
		prefix: 'material.',
		target: DYNAMIC_BINDING_TARGET.UNIFORM_SLOT,
		phase: DYNAMIC_BINDING_PHASE.CODEGEN_UPDATE,
		owner: 'material',
		resolver: 'emit-updater/material',
		required: [ 'property' ],
		optional: [ 'valueSnapshot' ],
	} ),
] );

export function dynamicBindingDescriptor( kind ) {

	if ( typeof kind !== 'string' || kind.length === 0 ) return null;
	if ( Object.prototype.hasOwnProperty.call( DYNAMIC_BINDING_DESCRIPTORS, kind ) ) return DYNAMIC_BINDING_DESCRIPTORS[ kind ];
	for ( const descriptor of PREFIX_DESCRIPTORS ) {

		if ( kind.startsWith( descriptor.prefix ) ) return freezeDescriptor( { ...descriptor, kind } );

	}
	return null;

}

export function isDynamicBindingKind( kind ) {

	return dynamicBindingDescriptor( kind ) !== null;

}

export function validateDynamicBindingSource( source ) {

	const kind = source && source.kind;
	const descriptor = dynamicBindingDescriptor( kind );
	if ( ! descriptor ) return [];
	const errors = [];
	for ( const field of descriptor.required ) {

		if ( source[ field ] === undefined || source[ field ] === null || source[ field ] === '' ) {

			errors.push( {
				code: 'dynamic-binding.required',
				kind,
				field,
				message: `${ kind } source is missing required field "${ field }"`,
			} );

		}

	}
	return errors;

}
