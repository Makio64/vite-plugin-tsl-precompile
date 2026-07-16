import { MATERIAL_TEXTURE_PROPS } from './texture-props.js';
import { collectArtifactDynamicBindings, dynamicBindingDescriptor, validateDynamicBindingSource } from './dynamic-bindings.js';
import { collectArtifactVariantCandidates, createArtifactVariantPayloadFingerprint } from './artifact-variants.js';
import { validateArtifactLightIdentities } from './light-identities.js';
import { validateComputeBindingsDescriptor } from './compute-bindings.js';
import { validateMaterialComputeDescriptor } from './material-compute.js';
import { RENDER_BINDING_OWNER_KINDS, isRenderBindingOwnerKind } from './render-selector.js';
import { stableJsonStringify } from './stable-json.js';
import {
	isInstanceMatrixAttributeDescriptor,
	isRangeAttributeDescriptor,
} from './attribute-generators.js';

export const KIND_STATUS = Object.freeze( {
	CODEGEN: 'codegen',
	RUNTIME_TEXTURE: 'runtime-texture',
	RUNTIME_DYNAMIC: 'runtime-dynamic',
	BLOCKED: 'blocked',
	ALIAS: 'alias',
} );

// Serializable binding descriptors that the runtime hydrator can allocate.
// Keep this list in lockstep with hydrate/kinds/runtime-binding-dispatcher.js;
// validation must reject a descriptor the runtime would otherwise skip.
export const RUNTIME_BINDING_KINDS = Object.freeze( [
	'uniform-buffer',
	'sampled-texture',
	'sampler',
	'storage-buffer',
] );

const RUNTIME_BINDING_KIND_SET = new Set( RUNTIME_BINDING_KINDS );

export const BLOCKED_KINDS = Object.freeze( {
	'builtin.dfgLUT': 'IBL DFG LUT — resolved by the hydrator (getDFGLUT()). Not a UBO slot kind.',
	'builtin.ltcTexture': 'Area-light LTC texture — resolved by the hydrator from artifact.ltcTextures. Not a UBO slot kind.',
	'artifact.texture': 'Artifact-level texture — resolved by the hydrator via _textureRefs / material UUID scan. Not a UBO slot kind.',
	'depth.texture': 'Shadow depth texture (light.shadow.map.depthTexture) — resolved by the hydrator per-frame via the lightIndex baked into the source. Not a UBO slot kind.',
	'viewport.texture': 'Viewport-mip framebuffer texture (KHR_materials_transmission glass) — resolved by the hydrator via createViewportTextureRebinder, which drives a real ViewportTextureNode per render. Not a UBO slot kind.',
	'reflector.texture': 'Reflector render-target texture — resolved by the hydrator via createReflectorTextureRebinder, which binds the live ReflectorBaseNode render target per render. Not a UBO slot kind.',
	'unsupported': 'Extractor flagged this texture binding as unsupported (no source identified). The hydrator substitutes a 1×1 white fallback. Not a UBO slot kind.',
	'scene.overrideMaterial': 'scene.overrideMaterial context is out of scope for v1.',
} );

export const LIGHT_SLOT_KINDS = Object.freeze( [
	'light.colorScaled',
	'light.distance',
	'light.decay',
	'light.coneCos',
	'light.penumbraCos',
	'light.position',
	'light.viewPosition',
	'light.targetPosition',
	'light.halfWidth',
	'light.halfHeight',
	'light.shadowMatrix',
	'light.shadowModelMatrix',
	'light.shadowBias',
	'light.shadowNormalBias',
	'light.shadowRadius',
	'light.shadowIntensity',
	'light.shadowBlurSamples',
	'light.shadowCameraNear',
	'light.shadowCameraFar',
	'light.shadowMapSize',
] );

const CODEGEN_SLOT_KINDS = [
	'camera.projectionMatrix',
	'camera.projectionMatrixInverse',
	'camera.viewMatrix',
	'camera.worldMatrix',
	'camera.position',
	'camera.near',
	'camera.far',
	'object.worldMatrix',
	'object.worldMatrixInverse',
	'object.normalMatrix',
	'object.modelViewMatrix',
	'object.modelNormalViewMatrix',
	'object.scale',
	'object.radius',
	'object3d.worldMatrix',
	'object3d.normalMatrix',
	'object3d.modelViewMatrix',
	'object3d.position',
	'object3d.scale',
	'object3d.viewPosition',
	'object3d.direction',
	'object3d.radius',
	'object3d.nodeUniform',
	'object3d.userData',
	'velocity.currentProjectionMatrix',
	'velocity.previousProjectionMatrix',
	'velocity.previousCameraViewMatrix',
	'velocity.previousModelWorldMatrix',
	'frame.time',
	'frame.deltaTime',
	'frame.frameId',
	'renderer.dpr',
	'renderer.size',
	'renderer.halfHeight',
	'renderer.viewport',
	'renderer.toneMappingExposure',
	'scene.fog.color',
	'scene.fog.near',
	'scene.fog.far',
	'scene.fog.density',
	'scene.environmentIntensity',
	'scene.backgroundIntensity',
	'scene.backgroundBlurriness',
	'scene.backgroundRotation',
	...LIGHT_SLOT_KINDS,
	'constant',
	'uniform.constant',
	'uniform.live',
];

const LEGACY_ALIASES = Object.freeze( {
	time: 'frame.time',
	deltaTime: 'frame.deltaTime',
	frameId: 'frame.frameId',
} );

const MATERIAL_COLOR_KINDS = [
	'material.color',
	'material.emissive',
	'material.specular',
	'material.specularColor',
	'material.sheenColor',
	'material.attenuationColor',
];

const MATERIAL_SCALAR_KINDS = [
	'material.scalar',
	'material.opacity',
	'material.alphaTest',
	'material.roughness',
	'material.metalness',
	'material.ior',
	'material.emissiveIntensity',
	'material.aoMapIntensity',
	'material.lightMapIntensity',
	'material.envMapIntensity',
	'material.specularIntensity',
	'material.shininess',
	'material.size',
	'material.rotation',
	'material.clearcoat',
	'material.clearcoatRoughness',
	'material.sheen',
	'material.sheenRoughness',
	'material.transmission',
	'material.thickness',
	'material.attenuationDistance',
	'material.iridescence',
	'material.iridescenceIOR',
	'material.anisotropy',
	'material.anisotropyRotation',
	'material.dispersion',
	'material.reflectivity',
	'material.refractionRatio',
	'material.bumpScale',
	'material.displacementScale',
	'material.displacementBias',
	'material.linewidth',
	'material.scale',
	'material.dashSize',
	'material.gapSize',
	'material.dashOffset',
];

const MATERIAL_VECTOR_KINDS = [
	'material.normalScale',
	'material.clearcoatNormalScale',
];

function defineKinds( out, kinds, status, meta = {} ) {

	for ( const kind of kinds ) {

		out[ kind ] = Object.freeze( { kind, status, ...meta } );

	}

}

const kinds = {};
defineKinds( kinds, CODEGEN_SLOT_KINDS, KIND_STATUS.CODEGEN, { codegen: 'emit-updater' } );
defineKinds( kinds, MATERIAL_COLOR_KINDS, KIND_STATUS.CODEGEN, { codegen: 'emit-updater', value: 'color' } );
defineKinds( kinds, MATERIAL_SCALAR_KINDS, KIND_STATUS.CODEGEN, { codegen: 'emit-updater', value: 'f32' } );
defineKinds( kinds, MATERIAL_VECTOR_KINDS, KIND_STATUS.CODEGEN, { codegen: 'emit-updater', value: 'vec2' } );
for ( const [ kind, target ] of Object.entries( LEGACY_ALIASES ) ) {

	kinds[ kind ] = Object.freeze( { kind, status: KIND_STATUS.ALIAS, target, codegen: 'emit-updater' } );

}
for ( const [ kind, reason ] of Object.entries( BLOCKED_KINDS ) ) {

	kinds[ kind ] = Object.freeze( { kind, status: KIND_STATUS.BLOCKED, reason } );

}
kinds[ 'storage.buffer' ] = Object.freeze( {
	kind: 'storage.buffer',
	status: KIND_STATUS.RUNTIME_DYNAMIC,
	runtime: 'hydrator/storage-buffer',
} );
for ( const prop of MATERIAL_TEXTURE_PROPS ) {

	const kind = `material.${ prop }`;
	kinds[ kind ] = Object.freeze( { kind, status: KIND_STATUS.RUNTIME_TEXTURE, runtime: 'hydrator/material-texture', property: prop } );
	const matrixKind = `${ kind }.matrix`;
	kinds[ matrixKind ] = Object.freeze( { kind: matrixKind, status: KIND_STATUS.CODEGEN, codegen: 'emit-updater', property: prop, value: 'mat3' } );

}

export const KINDS = Object.freeze( kinds );

export const CODEGEN_KINDS = Object.freeze(
	Object.keys( KINDS ).filter( ( kind ) => KINDS[ kind ].status === KIND_STATUS.CODEGEN || KINDS[ kind ].status === KIND_STATUS.ALIAS )
);

export const RUNTIME_TEXTURE_KINDS = Object.freeze(
	Object.keys( KINDS ).filter( ( kind ) => KINDS[ kind ].status === KIND_STATUS.RUNTIME_TEXTURE )
);

function dynamicKindInfo( kind ) {

	if ( typeof kind !== 'string' || kind.length === 0 ) return null;
	if ( Object.prototype.hasOwnProperty.call( KINDS, kind ) ) return KINDS[ kind ];
	if ( USER_KINDS.has( kind ) ) return USER_KINDS.get( kind );

	if ( kind.startsWith( 'material.' ) && ! kind.endsWith( '.matrix' ) ) {

		return Object.freeze( {
			kind,
			status: KIND_STATUS.CODEGEN,
			codegen: 'emit-updater',
			property: kind.slice( 'material.'.length ),
			dynamic: true,
		} );

	}

	if ( kind.startsWith( 'object3d.' ) ) {

		return Object.freeze( {
			kind,
			status: KIND_STATUS.BLOCKED,
			reason: `Object3DNode scope "${ kind.slice( 'object3d.'.length ) }" is not mapped yet.`,
			dynamic: true,
		} );

	}

	return null;

}

/**
 * User-extensible kind registry. Keyed by `kind` (e.g. `custom.myEffect`).
 * Mutable at module scope so `registerKind()` can extend the system without
 * forking. `dynamicKindInfo()` consults this after the built-in `KINDS` table.
 *
 * @type {Map<string, Readonly<Object>>}
 */
const USER_KINDS = new Map();

const VALID_REGISTER_STATUSES = new Set( [
	KIND_STATUS.CODEGEN,
	KIND_STATUS.RUNTIME_TEXTURE,
	KIND_STATUS.RUNTIME_DYNAMIC,
] );

function descriptorsEqual( a, b ) {

	if ( a === b ) return true;
	if ( ! a || ! b ) return false;
	const ka = Object.keys( a ).sort();
	const kb = Object.keys( b ).sort();
	if ( ka.length !== kb.length ) return false;
	for ( let i = 0; i < ka.length; i ++ ) {

		if ( ka[ i ] !== kb[ i ] ) return false;
		if ( a[ ka[ i ] ] !== b[ kb[ i ] ] ) return false;

	}
	return true;

}

/**
 * Register a custom `source.kind` so the extractor → codegen → runtime
 * pipeline accepts it.
 *
 * The closed built-in registry covers the standard three.js TSL surface; this
 * lets adopters with custom TSL nodes (or third-party libraries that emit
 * binding kinds we don't know about) plug into the system without forking the
 * contract package. `validateArtifact()` consults this after the built-in
 * table, so registered custom kinds pass validation everywhere — dev capture,
 * build verify, runtime hydrator.
 *
 * Re-registering the same kind with the same descriptor is a no-op (idempotent
 * across module reloads). Re-registering with a *different* descriptor throws
 * — the system enforces "one descriptor per kind."
 *
 * @param {Object} entry
 * @param {string} entry.kind   - the `source.kind` string the extractor emits (e.g. `custom.myEffect`)
 * @param {string} entry.status - one of `'codegen'`, `'runtime-texture'`, `'runtime-dynamic'`
 * @param {string} [entry.codegen] - codegen emitter id (when status === 'codegen')
 * @param {string} [entry.runtime] - runtime resolver id (when status starts with 'runtime')
 * @param {string} [entry.reason]  - optional human-facing description
 * @param {Object} [entry...]      - additional descriptor fields surfaced via `kindInfo()`
 * @return {Readonly<Object>} the frozen descriptor that's now resolvable via `kindInfo(entry.kind)`
 * @throws {TypeError} on invalid shape
 * @throws {Error} when re-registering an existing kind with a different descriptor
 */
export function registerKind( entry ) {

	if ( ! entry || typeof entry !== 'object' ) {

		throw new TypeError( 'registerKind: entry object is required.' );

	}
	const { kind } = entry;
	if ( typeof kind !== 'string' || kind.length === 0 ) {

		throw new TypeError( 'registerKind: entry.kind must be a non-empty string.' );

	}
	if ( ! VALID_REGISTER_STATUSES.has( entry.status ) ) {

		throw new TypeError(
			`registerKind: entry.status must be one of ${ JSON.stringify( [ ...VALID_REGISTER_STATUSES ] ) } (got ${ JSON.stringify( entry.status ) }).`
		);

	}
	if ( Object.prototype.hasOwnProperty.call( KINDS, kind ) ) {

		throw new Error( `registerKind: cannot override built-in kind ${ JSON.stringify( kind ) }; built-in descriptors are immutable.` );

	}
	const descriptor = Object.freeze( { ...entry } );
	const existing = USER_KINDS.get( kind );
	if ( existing ) {

		if ( descriptorsEqual( existing, descriptor ) ) return existing;
		throw new Error( `registerKind: kind ${ JSON.stringify( kind ) } is already registered with a different descriptor.` );

	}
	USER_KINDS.set( kind, descriptor );
	return descriptor;

}

/**
 * Remove a user-registered kind. Built-in kinds cannot be unregistered.
 * Returns `true` when an entry was removed, `false` when the kind wasn't
 * user-registered.
 *
 * Mostly a test helper / explicit teardown for adopters that hot-swap their
 * custom node sets at dev time.
 *
 * @param {string} kind
 * @return {boolean}
 */
export function unregisterKind( kind ) {

	if ( typeof kind !== 'string' ) return false;
	return USER_KINDS.delete( kind );

}

/**
 * Snapshot of user-registered kinds (frozen). Useful for diagnostics.
 *
 * @return {Readonly<Array<Object>>}
 */
export function listRegisteredKinds() {

	return Object.freeze( [ ...USER_KINDS.values() ] );

}

export function kindInfo( kind ) {

	return dynamicKindInfo( kind );

}

export function isKnownKind( kind ) {

	return kindInfo( kind ) !== null;

}

export function isBlockedKind( kind ) {

	const info = kindInfo( kind );
	return info ? info.status === KIND_STATUS.BLOCKED : false;

}

export function blockedKindReason( kind ) {

	const info = kindInfo( kind );
	return info && info.status === KIND_STATUS.BLOCKED ? info.reason : null;

}

export function collectArtifactSourceKinds( input ) {

	const artifact = input && input.artifact && typeof input.artifact === 'object' ? input.artifact : input;
	const out = new Set();
	const plan = artifact && Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [];
	for ( const group of plan ) {

		for ( const slot of group && Array.isArray( group.slots ) ? group.slots : [] ) {

			const kind = slot && slot.source && slot.source.kind;
			if ( typeof kind === 'string' && kind.length > 0 ) out.add( kind );

		}
		for ( const texture of group && Array.isArray( group.textures ) ? group.textures : [] ) {

			const kind = texture && texture.source && texture.source.kind;
			if ( typeof kind === 'string' && kind.length > 0 ) out.add( kind );

		}
		for ( const storageBuffer of group && Array.isArray( group.storageBuffers ) ? group.storageBuffers : [] ) {

			const kind = storageBuffer && storageBuffer.source && storageBuffer.source.kind;
			if ( typeof kind === 'string' && kind.length > 0 ) out.add( kind );

		}

	}
	return Object.freeze( [ ...out ].sort() );

}

function validationError( code, message, path = '' ) {

	return { code, message, path };

}

function validateArtifactAttributes( artifact, label, errors ) {

	for ( const listName of [ 'attributes', 'nodeAttributes' ] ) {

		const attributes = artifact[ listName ];
		if ( attributes === undefined ) continue;
		if ( ! Array.isArray( attributes ) ) {

			errors.push( validationError( `artifact.${ listName }`, `${ label}: ${ listName } must be an array when present`, listName ) );
			continue;

		}
		for ( let index = 0; index < attributes.length; index ++ ) {

			const entry = attributes[ index ];
			if ( ! entry || typeof entry !== 'object' || Array.isArray( entry ) ) continue;
			const path = `${ listName }[${ index }]`;
			if ( entry.arrayGenerator !== undefined && ! isRangeAttributeDescriptor( entry ) ) errors.push( validationError(
				'attribute.arrayGenerator',
				`${ label}: ${ path } has an invalid or non-exclusive range@1 descriptor`,
				`${ path }.arrayGenerator`,
			) );
			if ( entry.objectAttribute !== undefined && ! isInstanceMatrixAttributeDescriptor( entry ) ) errors.push( validationError(
				'attribute.objectAttribute',
				`${ label}: ${ path } has an invalid or non-exclusive instance-matrix@1 descriptor`,
				`${ path }.objectAttribute`,
			) );

		}

	}

}

function validateRuntimeBindings( artifact, label, errors ) {

	if ( artifact.bindings === undefined ) return;
	if ( ! Array.isArray( artifact.bindings ) ) {

		errors.push( validationError( 'artifact.bindings', `${ label}: artifact.bindings must be an array when present`, 'bindings' ) );
		return;

	}
	for ( let groupIndex = 0; groupIndex < artifact.bindings.length; groupIndex ++ ) {

		const group = artifact.bindings[ groupIndex ];
		const groupPath = `bindings[${ groupIndex }]`;
		if ( ! group || typeof group !== 'object' || Array.isArray( group ) ) {

			errors.push( validationError( 'bindings.group', `${ label}: ${ groupPath } must be an object`, groupPath ) );
			continue;

		}
		if ( ! Array.isArray( group.bindings ) ) {

			errors.push( validationError( 'bindings.entries', `${ label}: ${ groupPath }.bindings must be an array`, `${ groupPath }.bindings` ) );
			continue;

		}
		for ( let bindingIndex = 0; bindingIndex < group.bindings.length; bindingIndex ++ ) {

			const binding = group.bindings[ bindingIndex ];
			const bindingPath = `${ groupPath }.bindings[${ bindingIndex }]`;
			if ( ! binding || typeof binding !== 'object' || Array.isArray( binding ) ) {

				errors.push( validationError( 'bindings.entry', `${ label}: ${ bindingPath } must be an object`, bindingPath ) );
				continue;

			}
			if ( typeof binding.kind !== 'string' || binding.kind.length === 0 ) {

				errors.push( validationError( 'binding.kind.type', `${ label}: ${ bindingPath }.kind must be a non-empty string`, `${ bindingPath }.kind` ) );
			} else if ( ! RUNTIME_BINDING_KIND_SET.has( binding.kind ) ) {

				errors.push( validationError(
					'binding.kind.unknown',
					`${ label}: unsupported runtime binding kind "${ binding.kind }" at ${ bindingPath }.kind; expected one of ${ RUNTIME_BINDING_KINDS.join( ', ' ) }`,
					`${ bindingPath }.kind`,
				) );

			}

		}

	}

}

function dynamicBindingKey( entry ) {

	return `${ entry && entry.kind }|${ entry && entry.group }|${ entry && entry.binding }`;

}

function stableSerializableValue( value, seen = new Set() ) {

	if ( value === null || typeof value !== 'object' ) return JSON.stringify( value );
	if ( seen.has( value ) ) return '<cycle>';
	seen.add( value );
	let result;
	if ( Array.isArray( value ) ) {

		result = `[${ value.map( ( item ) => stableSerializableValue( item, seen ) ).join( ',' ) }]`;

	} else {

		result = `{${ Object.keys( value ).sort().map( ( key ) => `${ JSON.stringify( key ) }:${ stableSerializableValue( value[ key ], seen ) }` ).join( ',' ) }}`;

	}
	seen.delete( value );
	return result;

}

function validateDynamicBindingEntry( entry, index, label, errors ) {

	const path = `dynamicBindings[${ index }]`;
	if ( ! entry || typeof entry !== 'object' || Array.isArray( entry ) ) {

		errors.push( validationError( 'dynamicBindings.entry', `${ label }: ${ path } must be an object`, path ) );
		return false;

	}
	for ( const field of [ 'kind', 'target', 'phase', 'owner', 'resolver', 'group' ] ) {

		if ( typeof entry[ field ] !== 'string' || entry[ field ].length === 0 ) {

			errors.push( validationError( 'dynamicBindings.field', `${ label }: ${ path }.${ field } must be a non-empty string`, `${ path }.${ field }` ) );

		}

	}
	if ( ! Object.prototype.hasOwnProperty.call( entry, 'binding' ) || ( entry.binding !== null && typeof entry.binding !== 'string' ) ) {

		errors.push( validationError( 'dynamicBindings.field', `${ label }: ${ path }.binding must be a string or null`, `${ path }.binding` ) );

	}
	if ( ! entry.source || typeof entry.source !== 'object' || Array.isArray( entry.source ) ) {

		errors.push( validationError( 'dynamicBindings.source', `${ label }: ${ path }.source must be an object`, `${ path }.source` ) );

	} else if ( entry.source.kind !== entry.kind ) {

		errors.push( validationError( 'dynamicBindings.source-kind', `${ label }: ${ path }.source.kind must match ${ path }.kind`, `${ path }.source.kind` ) );

	}
	if ( entry.source && typeof entry.source === 'object' && ! Array.isArray( entry.source ) ) {

		for ( const dynamicError of validateDynamicBindingSource( entry.source ) ) {

			errors.push( validationError(
				dynamicError.code,
				`${ label }: ${ dynamicError.message } at ${ path }.source`,
				`${ path }.source.${ dynamicError.field }`,
			) );

		}

	}
	if ( entry.target === 'uniform-slot' ) {

		if ( ! Object.prototype.hasOwnProperty.call( entry, 'offset' ) || ( entry.offset !== null && ! Number.isFinite( entry.offset ) ) ) {

			errors.push( validationError( 'dynamicBindings.offset', `${ label }: ${ path }.offset must be a finite number or null for a uniform slot`, `${ path }.offset` ) );

		}

	} else if ( entry.target === 'sampled-texture' || entry.target === 'sampler' || entry.target === 'storage-texture' ) {

		if ( ! Object.prototype.hasOwnProperty.call( entry, 'textureType' ) || ( entry.textureType !== null && typeof entry.textureType !== 'string' ) ) {

			errors.push( validationError( 'dynamicBindings.textureType', `${ label }: ${ path }.textureType must be a string or null for a texture binding`, `${ path }.textureType` ) );

		}

	}

	const descriptor = dynamicBindingDescriptor( entry.kind );
	if ( ! descriptor ) {

		errors.push( validationError( 'dynamicBindings.kind.unknown', `${ label }: ${ path }.kind is not a registered dynamic binding kind`, `${ path }.kind` ) );

	} else {

		for ( const field of [ 'target', 'phase', 'owner', 'resolver' ] ) {

			if ( entry[ field ] !== descriptor[ field ] ) {

				errors.push( validationError(
					'dynamicBindings.descriptor',
					`${ label }: ${ path }.${ field } must be ${ JSON.stringify( descriptor[ field ] ) } for kind ${ JSON.stringify( entry.kind ) }`,
					`${ path }.${ field }`,
				) );

			}

		}

	}
	return true;

}

function compareDynamicBindingEntry( stored, computed, index, label, errors ) {

	const path = `dynamicBindings[${ index }]`;
	for ( const field of [ 'kind', 'target', 'phase', 'owner', 'resolver', 'group', 'binding', 'offset', 'textureType' ] ) {

		if ( Object.prototype.hasOwnProperty.call( computed, field ) && stored[ field ] !== computed[ field ] ) {

			errors.push( validationError(
				'dynamicBindings.mismatch',
				`${ label }: ${ path }.${ field } does not match the descriptor implied by uniformPlan`,
				`${ path }.${ field }`,
			) );

		}

	}
	if ( stableSerializableValue( stored.source ) !== stableSerializableValue( computed.source ) ) {

		errors.push( validationError(
			'dynamicBindings.mismatch',
			`${ label }: ${ path }.source does not match the source descriptor implied by uniformPlan`,
			`${ path }.source`,
		) );

	}

}

export function isArtifactModule( value ) {

	return !! ( value && typeof value === 'object' && ! Array.isArray( value ) && value.artifact && typeof value.artifact === 'object' );

}

export function isArtifactCollection( input, opts = {} ) {

	if ( Array.isArray( input ) ) return input.length > 0 ? input.every( isArtifactModule ) : opts.allowEmpty === true;
	if ( ! input || typeof input !== 'object' || Array.isArray( input ) || input.artifact ) return false;
	const values = Object.values( input );
	return values.length > 0 ? values.every( isArtifactModule ) : opts.allowEmpty === true;

}

function validateArtifactCollection( input, opts, label ) {

	const errors = [];
	const warnings = [];
	const sourceKinds = new Set();
	const entries = Array.isArray( input ) ? input.map( ( value, index ) => [ index, value ] ) : Object.entries( input );
	for ( const [ key, value ] of entries ) {

		const entryLabel = `${ label }[${ JSON.stringify( key ) }]`;
		const result = validateArtifact( value, { ...opts, label: entryLabel } );
		for ( const error of result.errors ) errors.push( error );
		for ( const warning of result.warnings ) warnings.push( warning );
		for ( const kind of result.sourceKinds ) sourceKinds.add( kind );

	}

	return {
		ok: errors.length === 0,
		errors,
		warnings,
		sourceKinds: Object.freeze( [ ...sourceKinds ].sort() ),
	};

}

export function validateArtifact( input, opts = {} ) {

	const label = opts.label || input && ( input.__name || input.name ) || '<artifact>';
	const errors = [];
	const warnings = [];

	if ( isArtifactCollection( input, { allowEmpty: opts.allowEmptyCollection === true } ) ) return validateArtifactCollection( input, opts, label );

	const artifact = input && input.artifact && typeof input.artifact === 'object' ? input.artifact : input;

	if ( ! artifact || typeof artifact !== 'object' || Array.isArray( artifact ) ) {

		errors.push( validationError( 'artifact.type', `${ label }: artifact must be an object` ) );
		return { ok: false, errors, warnings, sourceKinds: [] };

	}

	if ( artifact.bindingOwner !== undefined ) {

		const bindingOwnerOnCompute = artifact.kind === 'compute' || typeof artifact.computeShader === 'string' && artifact.computeShader.trim().length > 0;
		if ( ! isRenderBindingOwnerKind( artifact.bindingOwner ) ) {

			errors.push( validationError(
				'artifact.bindingOwner',
				`${ label }: bindingOwner must be one of ${ Object.values( RENDER_BINDING_OWNER_KINDS ).join( ', ' ) }`,
				'bindingOwner',
			) );

		} else if ( bindingOwnerOnCompute ) {

			errors.push( validationError(
				'artifact.bindingOwner.compute',
				`${ label }: bindingOwner is only valid on render artifacts`,
				'bindingOwner',
			) );

		} else if ( artifact.bindingOwner === RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER && artifact.materialShape !== 'shadow-depth' ) {

			errors.push( validationError(
				'artifact.bindingOwner.materialShape',
				`${ label }: shadow-caster binding ownership is only valid for materialShape "shadow-depth"`,
				'bindingOwner',
			) );

		}

	}

	if ( ! Array.isArray( artifact.uniformPlan ) ) {

		errors.push( validationError( 'artifact.uniformPlan', `${ label}: artifact.uniformPlan must be an array`, 'uniformPlan' ) );

	}

	if ( artifact.renderContextSelectors !== undefined ) {

		if ( ! Array.isArray( artifact.renderContextSelectors ) ) {

			errors.push( validationError( 'artifact.renderContextSelectors', `${ label }: renderContextSelectors must be an array when present`, 'renderContextSelectors' ) );

		} else {

			if ( artifact.renderContextSelectors.length === 0 ) errors.push( validationError( 'artifact.renderContextSelectors.empty', `${ label }: renderContextSelectors must not be empty when present`, 'renderContextSelectors' ) );
			const seenSelectors = new Set();
			let previousSelector = null;
			for ( let index = 0; index < artifact.renderContextSelectors.length; index ++ ) {

				const selector = artifact.renderContextSelectors[ index ];
				const path = `renderContextSelectors[${ index }]`;
				if ( typeof selector !== 'string' || selector.length === 0 ) {

					errors.push( validationError( 'artifact.renderContextSelector', `${ label }: ${ path } must be a non-empty canonical string`, path ) );
					continue;

				}
				if ( seenSelectors.has( selector ) ) errors.push( validationError( 'artifact.renderContextSelector.duplicate', `${ label }: ${ path } duplicates an earlier selector`, path ) );
				if ( previousSelector !== null && selector < previousSelector ) errors.push( validationError( 'artifact.renderContextSelector.order', `${ label }: renderContextSelectors must be sorted canonically`, path ) );
				seenSelectors.add( selector );
				try {

					const descriptor = JSON.parse( selector );
					if ( ! descriptor || descriptor.version !== 'render-object-selector@1' ) throw new Error( 'version' );
					if ( stableJsonStringify( descriptor, path ) !== selector ) errors.push( validationError( 'artifact.renderContextSelector.canonical', `${ label }: ${ path } is not canonical stable JSON`, path ) );

				} catch ( _ ) {

					errors.push( validationError( 'artifact.renderContextSelector.format', `${ label }: ${ path } must encode a render-object-selector@1 descriptor`, path ) );

				}
				previousSelector = selector;

			}

		}

	}

	const hasComputeShader = typeof artifact.computeShader === 'string' && artifact.computeShader.trim().length > 0;
	const isCompute = artifact.kind === 'compute' || hasComputeShader;
	if ( isCompute ) {

		if ( ! hasComputeShader ) errors.push( validationError( 'artifact.computeShader', `${ label}: compute artifact is missing a non-empty computeShader`, 'computeShader' ) );

	} else {

		if ( 'computeShader' in artifact && typeof artifact.computeShader !== 'string' ) errors.push( validationError( 'artifact.computeShader', `${ label}: computeShader must be a string when present`, 'computeShader' ) );
		if ( 'vertexShader' in artifact && typeof artifact.vertexShader !== 'string' ) errors.push( validationError( 'artifact.vertexShader', `${ label}: vertexShader must be a string`, 'vertexShader' ) );
		if ( 'fragmentShader' in artifact && typeof artifact.fragmentShader !== 'string' ) errors.push( validationError( 'artifact.fragmentShader', `${ label}: fragmentShader must be a string`, 'fragmentShader' ) );
		if ( opts.requireShaders === true && ( typeof artifact.vertexShader !== 'string' || artifact.vertexShader.trim().length === 0 ) ) {

			errors.push( validationError( 'artifact.vertexShader', `${ label}: render artifact is missing a non-empty vertexShader`, 'vertexShader' ) );

		}
		if ( opts.requireShaders === true && ( typeof artifact.fragmentShader !== 'string' || artifact.fragmentShader.trim().length === 0 ) ) {

			errors.push( validationError( 'artifact.fragmentShader', `${ label}: render artifact is missing a non-empty fragmentShader`, 'fragmentShader' ) );

		}

	}
	validateArtifactAttributes( artifact, label, errors );
	validateRuntimeBindings( artifact, label, errors );
	if ( artifact.computeBindings !== undefined ) {

		if ( ! isCompute ) errors.push( validationError(
			'compute-bindings.owner',
			`${ label }: computeBindings is only valid on compute artifacts`,
			'computeBindings',
		) );

		for ( const computeBindingError of validateComputeBindingsDescriptor( artifact.computeBindings, { artifact } ) ) errors.push( validationError(
			computeBindingError.code,
			`${ label }: ${ computeBindingError.message }`,
			computeBindingError.path,
		) );

	}
	if ( artifact.materialCompute !== undefined ) {

		if ( isCompute ) errors.push( validationError(
			'material-compute.owner',
			`${ label }: materialCompute is only valid on render artifacts`,
			'materialCompute',
		) );

		for ( const materialComputeError of validateMaterialComputeDescriptor( artifact.materialCompute, { artifact } ) ) errors.push( validationError(
			materialComputeError.code,
			`${ label }: ${ materialComputeError.message }`,
			materialComputeError.path,
		) );

	}
	for ( const lightIdentityError of validateArtifactLightIdentities( artifact ) ) errors.push( validationError(
		lightIdentityError.code,
		`${ label }: ${ lightIdentityError.message }`,
		lightIdentityError.path,
	) );

	const sourceKinds = [];
	if ( Array.isArray( artifact.uniformPlan ) ) {

		for ( let groupIndex = 0; groupIndex < artifact.uniformPlan.length; groupIndex ++ ) {

			const group = artifact.uniformPlan[ groupIndex ];
			const groupPath = `uniformPlan[${ groupIndex }]`;
			if ( ! group || typeof group !== 'object' || Array.isArray( group ) ) {

				errors.push( validationError( 'uniformPlan.group', `${ label}: ${ groupPath} must be an object`, groupPath ) );
				continue;

			}
			for ( const key of [ 'slots', 'textures', 'storageBuffers' ] ) {

				if ( group[ key ] !== undefined && ! Array.isArray( group[ key ] ) ) {

					errors.push( validationError( `uniformPlan.${ key }`, `${ label}: ${ groupPath}.${ key } must be an array when present`, `${ groupPath}.${ key }` ) );

				}

			}
			const lists = [
				[ 'slots', group.slots ],
				[ 'textures', group.textures ],
				[ 'storageBuffers', group.storageBuffers ],
			];
			for ( const [ listName, list ] of lists ) {

				if ( ! Array.isArray( list ) ) continue;
				for ( let itemIndex = 0; itemIndex < list.length; itemIndex ++ ) {

					const item = list[ itemIndex ];
					const source = item && item.source;
					const kind = source && source.kind;
					if ( kind === undefined ) continue;
					const itemPath = `${ groupPath}.${ listName }[${ itemIndex }].source.kind`;
					if ( typeof kind !== 'string' || kind.length === 0 ) {

						errors.push( validationError( 'source.kind.type', `${ label}: ${ itemPath } must be a non-empty string`, itemPath ) );
						continue;

					}
					sourceKinds.push( kind );
					if ( ! isKnownKind( kind ) ) {

						errors.push( validationError( 'source.kind.unknown', `${ label}: unknown source.kind "${ kind }" at ${ itemPath }`, itemPath ) );

					}
					for ( const dynamicError of validateDynamicBindingSource( source ) ) {

						const sourcePath = `${ groupPath}.${ listName }[${ itemIndex }].source`;
						errors.push( validationError(
							dynamicError.code,
							`${ label}: ${ dynamicError.message } at ${ sourcePath }`,
							`${ sourcePath }.${ dynamicError.field }`
						) );

					}
					const sourceBindingOwnerOnCompute = artifact.kind === 'compute' || typeof artifact.computeShader === 'string' && artifact.computeShader.trim().length > 0;
					if ( source.bindingOwner !== undefined && sourceBindingOwnerOnCompute ) {

						const sourcePath = `${ groupPath }.${ listName }[${ itemIndex }].source.bindingOwner`;
						errors.push( validationError(
							'source.bindingOwner.compute',
							`${ label }: source binding ownership is only valid on render artifacts`,
							sourcePath,
						) );

					} else if ( source.bindingOwner === RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER && artifact.materialShape !== 'shadow-depth' ) {

						const sourcePath = `${ groupPath }.${ listName }[${ itemIndex }].source.bindingOwner`;
						errors.push( validationError(
							'source.bindingOwner.materialShape',
							`${ label }: shadow-caster source ownership is only valid for materialShape "shadow-depth"`,
							sourcePath,
						) );

					}

				}

			}

		}

	}

	if ( artifact.dynamicBindings !== undefined && ! Array.isArray( artifact.dynamicBindings ) ) {

		errors.push( validationError( 'artifact.dynamicBindings', `${ label }: artifact.dynamicBindings must be an array when present`, 'dynamicBindings' ) );

	}
	if ( Array.isArray( artifact.dynamicBindings ) ) {

		for ( let index = 0; index < artifact.dynamicBindings.length; index ++ ) validateDynamicBindingEntry( artifact.dynamicBindings[ index ], index, label, errors );

	}

	// Convergence guard: if the artifact ships a frozen `dynamicBindings`
	// section, assert it matches the live collector. This is the dev↔build
	// extractor convergence canary — when a node-harness re-extraction
	// produces a different `dynamicBindings` shape than the dev capture
	// originally stamped, `pnpm verify` fails with a specific kind-set diff
	// instead of silently shipping stale descriptors.
	if ( Array.isArray( artifact.uniformPlan ) && Array.isArray( artifact.dynamicBindings ) && opts.strictDynamicBindings !== false ) {

		const computed = collectArtifactDynamicBindings( artifact );
		const storedByKey = new Map();
		const computedByKey = new Map( computed.map( ( entry ) => [ dynamicBindingKey( entry ), entry ] ) );
		for ( let index = 0; index < artifact.dynamicBindings.length; index ++ ) {

			const entry = artifact.dynamicBindings[ index ];
			if ( ! entry || typeof entry !== 'object' || Array.isArray( entry ) ) continue;
			const key = dynamicBindingKey( entry );
			if ( storedByKey.has( key ) ) {

				errors.push( validationError( 'dynamicBindings.duplicate', `${ label }: dynamicBindings has duplicate entry "${ key }"`, `dynamicBindings[${ index }]` ) );

			} else {

				storedByKey.set( key, { entry, index } );

			}

		}

		for ( const [ key, computedEntry ] of computedByKey ) {

			if ( ! storedByKey.has( key ) ) {

				errors.push( validationError(
					'dynamicBindings.missing',
					`${ label }: dynamicBindings is missing entry "${ key }" that the uniformPlan implies`,
					'dynamicBindings',
				) );

			} else {

				const stored = storedByKey.get( key );
				compareDynamicBindingEntry( stored.entry, computedEntry, stored.index, label, errors );

			}

		}
		for ( const key of storedByKey.keys() ) {

			if ( ! computedByKey.has( key ) ) {

				errors.push( validationError(
					'dynamicBindings.stale',
					`${ label }: dynamicBindings has stale entry "${ key }" that the uniformPlan no longer produces`,
					'dynamicBindings',
				) );

			}

		}

	}

	if ( artifact.materialCompute && Array.isArray( artifact.materialCompute.kernels ) ) {

		for ( let index = 0; index < artifact.materialCompute.kernels.length; index ++ ) {

			const nested = artifact.materialCompute.kernels[ index ] && artifact.materialCompute.kernels[ index ].artifact;
			if ( ! nested || typeof nested !== 'object' || Array.isArray( nested ) ) continue;
			const nestedPath = `materialCompute.kernels[${ index }].artifact`;
			const result = validateArtifact( nested, { ...opts, label: `${ label }.${ nestedPath }` } );
			for ( const error of result.errors ) errors.push( {
				...error,
				path: error.path ? `${ nestedPath }.${ error.path }` : nestedPath,
			} );
			for ( const warning of result.warnings ) warnings.push( warning );
			for ( const kind of result.sourceKinds ) sourceKinds.push( kind );

		}

	}

	if ( artifact.variants !== undefined ) {

		if ( ! artifact.variants || typeof artifact.variants !== 'object' || Array.isArray( artifact.variants ) ) {

			errors.push( validationError( 'artifact.variants', `${ label }: variants must be an object when present`, 'variants' ) );

		} else {

			for ( const [ key, variant ] of Object.entries( artifact.variants ) ) {

				const variantPath = `variants.${ key }`;
				if ( ! variant || variant.cacheKey === undefined || variant.cacheKey === null || String( variant.cacheKey ) !== key ) {

					errors.push( validationError( 'artifact.variant.cacheKey', `${ label}: ${ variantPath }.cacheKey must match its family key`, `${ variantPath }.cacheKey` ) );

				}
				const result = validateArtifact( variant, { ...opts, label: `${ label}.${ variantPath }` } );
				for ( const error of result.errors ) errors.push( {
					...error,
					path: error.path ? `${ variantPath }.${ error.path }` : variantPath,
				} );
				for ( const warning of result.warnings ) warnings.push( warning );
				for ( const kind of result.sourceKinds ) sourceKinds.push( kind );

			}
			validateSignedArtifactFamily( artifact, label, errors );

		}

	}

	return {
		ok: errors.length === 0,
		errors,
		warnings,
		sourceKinds: Object.freeze( [ ...new Set( sourceKinds ) ].sort() ),
	};

}

function validateSignedArtifactFamily( artifact, label, errors ) {

	const candidates = collectArtifactVariantCandidates( artifact );
	const signed = candidates.filter( ( candidate ) => Array.isArray( candidate.renderContextSelectors ) && candidate.renderContextSelectors.length > 0 );
	if ( signed.length === 0 ) return;
	if ( signed.length !== candidates.length ) {

		errors.push( validationError(
			'artifact.renderContextSelectors.partial-family',
			`${ label }: signed artifact families require renderContextSelectors on the root and every variant`,
			'variants',
		) );

	}

	const selectorPayloads = new Map();
	for ( const candidate of signed ) {

		let fingerprint;
		try {

			fingerprint = createArtifactVariantPayloadFingerprint( candidate );

		} catch ( error ) {

			errors.push( validationError( 'artifact.variant.serializable', `${ label}: signed variant payload is not serializable (${ error.message })`, 'variants' ) );
			continue;

		}
		for ( const selector of candidate.renderContextSelectors ) {

			if ( typeof selector !== 'string' || selector.length === 0 ) continue;
			const existing = selectorPayloads.get( selector );
			if ( existing !== undefined && existing !== fingerprint ) {

				errors.push( validationError(
					'artifact.renderContextSelector.collision',
					`${ label}: one renderContextSelector identifies divergent variant payloads`,
					'variants',
				) );

			} else {

				selectorPayloads.set( selector, fingerprint );

			}

		}

	}

}

export function assertValidArtifact( input, opts = {} ) {

	const result = validateArtifact( input, opts );
	if ( ! result.ok ) {

		const message = result.errors.map( ( error ) => error.message ).join( '\n' );
		throw new Error( message );

	}
	return input;

}
