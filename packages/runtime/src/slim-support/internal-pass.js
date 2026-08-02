/**
 * Semantic binder for captured renderer-owned draw programs.
 *
 * Capture persists exact WGSL and binding evidence. This module creates one
 * replay-local artifact view and maps stable `internal-pass@1` roles onto the
 * captured plan without rewriting shader bytes, durable descriptors, or hash
 * fields. Runtime-only state is carried exclusively by non-enumerable
 * sidecars.
 */

import { assertInternalPassArtifact } from '@tsl-precompile/contract/internal-pass';
import { collectArtifactVariantCandidates } from '@tsl-precompile/contract/artifact-variants';

import PrecompiledMaterial from '../_vendor-PrecompiledMaterial.js';

const ERROR_PREFIX = '[tsl-precompile/internal-pass]';

export class InternalPassBindingError extends Error {

	constructor( code, message, details = {} ) {

		super( `${ ERROR_PREFIX } ${ message }` );
		this.name = 'InternalPassBindingError';
		this.code = code;
		this.details = details;
		this.tslPrecompileInternalPass = true;

	}

}

/**
 * Clone and bind one captured internal-pass artifact.
 *
 * `bindings` is intentionally role-keyed:
 *
 * ```
 * {
 *   uniforms: { roughness: 0.25 },
 *   textures: { 'env-map': renderTarget.texture },
 *   buffers: { weights: Float32Array.from( weights ) },
 * }
 * ```
 *
 * A uniform or buffer value may be a zero-argument resolver. Texture changes
 * use `setTexture()` so the shared replay-local `_textureRefs` map changes
 * synchronously before Three's per-draw artifact-texture rebinder runs.
 *
 * @param {Object} artifact
 * @param {Object} [bindings]
 * @return {InternalPassBindingController}
 */
export function bindInternalPassArtifact( artifact, bindings = {} ) {

	let descriptor;
	try {

		descriptor = assertInternalPassArtifact( artifact );

	} catch ( cause ) {

		throw bindingError(
			'TSLP_INTERNAL_PASS_ARTIFACT_INVALID',
			cause && cause.message || 'Artifact does not satisfy internal-pass@1.',
			{ cause, issues: cause && cause.issues || [] },
		);

	}

	const replayArtifact = cloneInternalPassArtifact( artifact );
	const replayDescriptor = replayArtifact.internalPass || descriptor;
	const members = collectArtifactVariantCandidates( replayArtifact );
	const textureRefs = ensureTextureRefs( replayArtifact );
	const uniformStates = new Map();
	const textureStates = new Map();
	const bufferStates = new Map();

	for ( const uniform of replayDescriptor.uniforms ) {

		const state = createUniformState( uniform );
		for ( const member of members ) {

			const slot = requirePlanEntry( member, uniform, 'slots', 'uniform' );
			attachLiveUniformNode( slot, state.node );

		}
		uniformStates.set( uniform.role, state );

	}

	for ( const input of replayDescriptor.inputs ) {

		if ( input.kind === 'texture' ) {

			const uuids = new Set();
			for ( const member of members ) {

				const entry = requirePlanEntry( member, input, 'textures', 'texture' );
				attachInternalPassTextureBinding( entry );
				const uuid = entry.source && entry.source.textureUuid;
				if ( typeof uuid !== 'string' || uuid.length === 0 ) throw bindingError(
					'TSLP_INTERNAL_PASS_TEXTURE_EVIDENCE_MISSING',
					`Texture role ${ JSON.stringify( input.role ) } has no captured textureUuid evidence.`,
					{ role: input.role, group: input.group, binding: input.binding },
				);
				uuids.add( uuid );

			}
			textureStates.set( input.role, { descriptor: input, uuids, value: null } );

		} else if ( input.kind === 'buffer' ) {

			const state = createBufferState( input );
			for ( const member of members ) {

				const entry = requireBufferEntry( member, input );
				attachLiveBufferResolver( entry, state );

			}
			bufferStates.set( input.role, state );

		}

	}

	const controller = {
		artifact: replayArtifact,
		descriptor: replayDescriptor,
		material: null,
		setUniform( role, value ) {

			const state = requireRole( uniformStates, role, 'uniform' );
			state.value = value;
			return this;

		},
		setTexture( role, texture ) {

			const state = requireRole( textureStates, role, 'texture' );
			if ( texture !== null && texture !== undefined && ( typeof texture !== 'object' || texture.isTexture !== true ) ) throw bindingError(
				'TSLP_INTERNAL_PASS_TEXTURE_INVALID',
				`Texture role ${ JSON.stringify( role ) } requires a Three Texture or null.`,
				{ role, value: texture },
			);
			state.value = texture || null;
			for ( const uuid of state.uuids ) {

				if ( state.value ) textureRefs.set( uuid, state.value );
				else textureRefs.delete( uuid );

			}
			return this;

		},
		setBuffer( role, value ) {

			const state = requireRole( bufferStates, role, 'buffer' );
			if ( typeof value !== 'function' ) packBufferValue( value, state.descriptor, role, state );
			state.value = value;
			return this;

		},
	};

	applyInitialBindings( controller, bindings );
	return controller;

}

/**
 * Bind an artifact and instantiate its replay material.
 *
 * `opts.PrecompiledMaterial` is an injection seam for tests and integrations
 * that wrap the runtime class. The returned controller remains the owner of
 * semantic updates; `controller.material` is the instantiated material.
 *
 * @param {Object} artifact
 * @param {Object} [bindings]
 * @param {{PrecompiledMaterial?: Function, name?: string}} [opts]
 * @return {InternalPassBindingController}
 */
export function createInternalPassMaterial( artifact, bindings = {}, opts = {} ) {

	const controller = bindInternalPassArtifact( artifact, bindings );
	const Material = opts.PrecompiledMaterial || PrecompiledMaterial;
	if ( typeof Material !== 'function' ) throw bindingError(
		'TSLP_INTERNAL_PASS_MATERIAL_CONSTRUCTOR_INVALID',
		'opts.PrecompiledMaterial must be a constructor.',
	);
	const material = new Material( controller.artifact );
	material.name = opts.name || controller.descriptor.shape;
	controller.material = material;
	return controller;

}

/**
 * Binding-only clone used by the public controller and focused tests.
 * Shader strings, hashes, generated updater closures, and other envelope
 * fields retain their exact descriptors and values.
 */
export function cloneInternalPassArtifact( artifact ) {

	if ( ! isRecord( artifact ) ) throw bindingError(
		'TSLP_INTERNAL_PASS_ARTIFACT_INVALID',
		'cloneInternalPassArtifact() requires an artifact object.',
	);
	const clonedMembers = new WeakMap();
	const cloneMember = ( member ) => {

		if ( ! isRecord( member ) ) return member;
		const existing = clonedMembers.get( member );
		if ( existing ) return existing;

		const recordClones = new WeakMap();
		const clonePlanRecord = ( record ) => {

			if ( ! isRecord( record ) ) return record;
			let clone = recordClones.get( record );
			if ( clone ) return clone;
			clone = cloneRecord( record );
			recordClones.set( record, clone );
			return clone;

		};
		const uniformPlan = Array.isArray( member.uniformPlan ) ? member.uniformPlan.map( ( group ) => {

			if ( ! isRecord( group ) ) return group;
			const replacements = {};
			for ( const listName of [ 'slots', 'textures', 'samplers', 'storageBuffers', 'bufferUniforms' ] ) {

				if ( Array.isArray( group[ listName ] ) ) replacements[ listName ] = group[ listName ].map( clonePlanRecord );

			}
			if ( Array.isArray( group.orderedBindings ) ) replacements.orderedBindings = group.orderedBindings.map( ( binding ) => {

				if ( ! isRecord( binding ) ) return binding;
				return binding.ref && isRecord( binding.ref )
					? cloneRecord( binding, { ref: clonePlanRecord( binding.ref ) } )
					: cloneRecord( binding );

			} );
			return cloneRecord( group, replacements );

		} ) : member.uniformPlan;
		const bindings = Array.isArray( member.bindings ) ? member.bindings.map( ( group ) => (
			isRecord( group )
				? cloneRecord( group, {
					bindings: Array.isArray( group.bindings ) ? group.bindings.map( clonePlanRecord ) : group.bindings,
				} )
				: group
		) ) : member.bindings;
		const variants = isRecord( member.variants )
			? Object.fromEntries( Object.entries( member.variants ).map( ( [ key, variant ] ) => [ key, cloneMember( variant ) ] ) )
			: member.variants;
		const replacements = { bindings, uniformPlan, variants };
		if ( member._textureRefs instanceof Map ) replacements._textureRefs = new Map( member._textureRefs );
		const clone = cloneRecord( member, replacements );
		clonedMembers.set( member, clone );
		return clone;

	};
	const clone = cloneMember( artifact );
	ensureTextureRefs( clone );
	return clone;

}

function applyInitialBindings( controller, bindings ) {

	if ( bindings === undefined || bindings === null ) return;
	if ( ! isRecord( bindings ) ) throw bindingError(
		'TSLP_INTERNAL_PASS_BINDINGS_INVALID',
		'bindings must be an object with optional uniforms, textures, and buffers maps.',
	);
	for ( const key of Object.keys( bindings ) ) {

		if ( key !== 'uniforms' && key !== 'textures' && key !== 'buffers' ) throw bindingError(
			'TSLP_INTERNAL_PASS_BINDINGS_FIELD_UNKNOWN',
			`Unknown bindings field ${ JSON.stringify( key ) }.`,
			{ field: key },
		);

	}
	for ( const [ section, setter ] of [
		[ 'uniforms', 'setUniform' ],
		[ 'textures', 'setTexture' ],
		[ 'buffers', 'setBuffer' ],
	] ) {

		const values = bindings[ section ];
		if ( values === undefined ) continue;
		if ( ! isRecord( values ) ) throw bindingError(
			'TSLP_INTERNAL_PASS_BINDINGS_SECTION_INVALID',
			`bindings.${ section } must be an object keyed by semantic role.`,
			{ section },
		);
		for ( const [ role, value ] of Object.entries( values ) ) controller[ setter ]( role, value );

	}

}

function createUniformState( descriptor ) {

	const state = { descriptor, value: undefined, node: null };
	const node = {};
	Object.defineProperty( node, 'value', {
		get() {

			return resolveLiveValue( state.value );

		},
		set( value ) {

			state.value = value;

		},
		enumerable: true,
		configurable: false,
	} );
	state.node = node;
	return state;

}

function attachLiveUniformNode( slot, liveNode ) {

	Object.defineProperty( slot, '_liveNode', {
		value: liveNode,
		enumerable: false,
		configurable: true,
		writable: true,
	} );
	Object.defineProperty( slot, '__tslpLiveSidecarOverlay', {
		value: true,
		enumerable: false,
		configurable: true,
		writable: true,
	} );
	Object.defineProperty( slot, '__tslpInternalPassSidecar', {
		value: true,
		enumerable: false,
		configurable: true,
		writable: true,
	} );

}

function attachInternalPassTextureBinding( entry ) {

	Object.defineProperty( entry, '__tslpInternalPassTextureBinding', {
		value: true,
		enumerable: false,
		configurable: true,
		writable: true,
	} );

}

function createBufferState( descriptor ) {

	const state = {
		descriptor,
		value: undefined,
		packed: new Float32Array( descriptor.topology.byteLength / 4 ),
	};
	state.resolve = () => {

		const value = resolveLiveValue( state.value );
		if ( value === undefined || value === null ) return null;
		return packBufferValue( value, descriptor, descriptor.role, state );

	};
	return state;

}

function attachLiveBufferResolver( entry, state ) {

	Object.defineProperty( entry, '_liveArrayResolver', {
		value: state.resolve,
		enumerable: false,
		configurable: true,
		writable: true,
	} );
	Object.defineProperty( entry, '_liveArray', {
		get: state.resolve,
		enumerable: false,
		configurable: true,
	} );

}

function packBufferValue( input, descriptor, role, state ) {

	const topology = descriptor.topology;
	const values = normalizeNumericArray( input, role );
	const physicalLength = topology.byteLength / 4;
	const hasExplicitLayout = Number.isSafeInteger( topology.count ) &&
		Number.isSafeInteger( topology.itemSize ) &&
		Number.isSafeInteger( topology.stride );
	const logicalLength = hasExplicitLayout ? topology.count * topology.itemSize : null;
	// Three's scalar NodeUniformBuffer arrays use one f32 per 16-byte WGSL
	// uniform slot. Compact internal-pass descriptors predate explicit logical
	// layout fields, so accept only that exact legacy layout (or the complete
	// packed array) instead of guessing from any divisor of the byte length.
	let inferredStride = null;
	if ( ! hasExplicitLayout && physicalLength % 4 === 0 && values.length === physicalLength / 4 ) inferredStride = 4;
	if ( values.length !== physicalLength && values.length !== logicalLength && inferredStride === null ) throw bindingError(
		'TSLP_INTERNAL_PASS_BUFFER_LENGTH_MISMATCH',
		`Buffer role ${ JSON.stringify( role ) } expects ${ logicalLength === null ? 'a scalar array that evenly packs into' : `${ logicalLength } logical values or` } ${ physicalLength } packed values, received ${ values.length }.`,
		{ role, logicalLength, physicalLength, actualLength: values.length },
	);
	let packed = state.packed;
	if ( !( packed instanceof Float32Array ) || packed.length !== physicalLength ) packed = state.packed = new Float32Array( physicalLength );
	packed.fill( 0 );
	if ( values.length === physicalLength ) {

		for ( let index = 0; index < physicalLength; index ++ ) packed[ index ] = finiteBufferValue( values[ index ], role, index );

	} else if ( hasExplicitLayout ) {

		for ( let item = 0; item < topology.count; item ++ ) {

			for ( let component = 0; component < topology.itemSize; component ++ ) {

				const sourceIndex = item * topology.itemSize + component;
				packed[ item * topology.stride + component ] = finiteBufferValue( values[ sourceIndex ], role, sourceIndex );

			}

		}

	} else {

		for ( let index = 0; index < values.length; index ++ ) {

			packed[ index * inferredStride ] = finiteBufferValue( values[ index ], role, index );

		}

	}
	return packed;

}

function normalizeNumericArray( value, role ) {

	if ( Array.isArray( value ) || ArrayBuffer.isView( value ) && !( value instanceof DataView ) ) return value;
	throw bindingError(
		'TSLP_INTERNAL_PASS_BUFFER_INVALID',
		`Buffer role ${ JSON.stringify( role ) } requires an Array or typed array.`,
		{ role, value },
	);

}

function finiteBufferValue( value, role, index ) {

	const number = Number( value );
	if ( ! Number.isFinite( number ) ) throw bindingError(
		'TSLP_INTERNAL_PASS_BUFFER_VALUE_INVALID',
		`Buffer role ${ JSON.stringify( role ) } contains a non-finite value at index ${ index }.`,
		{ role, index, value },
	);
	return number;

}

function resolveLiveValue( value ) {

	return typeof value === 'function' ? value() : value;

}

function requireRole( states, role, kind ) {

	const state = states.get( role );
	if ( ! state ) throw bindingError(
		'TSLP_INTERNAL_PASS_ROLE_UNKNOWN',
		`Unknown ${ kind } role ${ JSON.stringify( role ) }.`,
		{ role, kind, availableRoles: [ ...states.keys() ] },
	);
	return state;

}

function requirePlanEntry( artifact, descriptor, listName, kind ) {

	const matches = [];
	for ( const group of artifact.uniformPlan || [] ) {

		if ( group && group.name !== descriptor.group ) continue;
		for ( const entry of group && group[ listName ] || [] ) {

			if ( entryBindingName( entry ) === descriptor.binding ) matches.push( entry );

		}

	}
	if ( matches.length !== 1 ) throw bindingError(
		'TSLP_INTERNAL_PASS_BINDING_ADDRESS_MISMATCH',
		`${ kind } role ${ JSON.stringify( descriptor.role ) } address ${ JSON.stringify( `${ descriptor.group }/${ descriptor.binding }` ) } resolved ${ matches.length } entries.`,
		{ role: descriptor.role, kind, group: descriptor.group, binding: descriptor.binding, count: matches.length },
	);
	return matches[ 0 ];

}

function requireBufferEntry( artifact, descriptor ) {

	const matches = [];
	for ( const group of artifact.uniformPlan || [] ) {

		if ( group && group.name !== descriptor.group ) continue;
		for ( const binding of group && group.orderedBindings || [] ) {

			if ( binding && binding.type === 'buffer-uniform' &&
				binding.ref &&
				entryBindingName( binding.ref ) === descriptor.binding ) matches.push( binding.ref );

		}

	}
	if ( matches.length !== 1 ) throw bindingError(
		'TSLP_INTERNAL_PASS_BINDING_ADDRESS_MISMATCH',
		`buffer role ${ JSON.stringify( descriptor.role ) } address ${ JSON.stringify( `${ descriptor.group }/${ descriptor.binding }` ) } resolved ${ matches.length } entries.`,
		{ role: descriptor.role, kind: 'buffer', group: descriptor.group, binding: descriptor.binding, count: matches.length },
	);
	return matches[ 0 ];

}

function ensureTextureRefs( artifact ) {

	if ( artifact._textureRefs instanceof Map ) return artifact._textureRefs;
	const refs = new Map();
	Object.defineProperty( artifact, '_textureRefs', {
		value: refs,
		enumerable: false,
		configurable: true,
		writable: true,
	} );
	return refs;

}

function entryBindingName( entry ) {

	return entry && ( entry.name ?? entry.binding ?? entry.bindingName ) || null;

}

function replaceDescriptorValue( descriptors, source, property, value ) {

	const current = Object.getOwnPropertyDescriptor( source, property );
	descriptors[ property ] = {
		value,
		enumerable: current ? current.enumerable : true,
		configurable: true,
		writable: true,
	};

}

function cloneRecord( source, replacements = null ) {

	if ( ! isRecord( source ) ) return source;
	const descriptors = Object.getOwnPropertyDescriptors( source );
	for ( const [ property, value ] of Object.entries( replacements || {} ) ) replaceDescriptorValue( descriptors, source, property, value );
	return Object.create( Object.getPrototypeOf( source ), descriptors );

}

function isRecord( value ) {

	return !! value && typeof value === 'object' && ! Array.isArray( value );

}

function bindingError( code, message, details = {} ) {

	return new InternalPassBindingError( code, message, details );

}

/**
 * @typedef {Object} InternalPassBindingController
 * @property {Object} artifact
 * @property {Object} descriptor
 * @property {?Object} material
 * @property {(role:string, value:*) => InternalPassBindingController} setUniform
 * @property {(role:string, value:Object|null) => InternalPassBindingController} setTexture
 * @property {(role:string, value:Array|ArrayBufferView|Function) => InternalPassBindingController} setBuffer
 */
