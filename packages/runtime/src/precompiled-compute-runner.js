/**
 * Public, compiler-free runner for one standalone compute artifact.
 *
 * The runner does not create a second WebGPU dispatch path. It binds the
 * exact public `compute-bindings@1` locations on a private artifact view, then
 * delegates to the existing PrecompiledComputeNode → slim NodeManager →
 * hydrator → renderer pipeline. GPU resources remain caller-owned.
 */
import { validateComputeBindingsDescriptor } from '@tsl-precompile/contract/compute-bindings';

import PrecompiledComputeNode from './precompiled-compute-node.js';
import { assertArtifactShaderLanguageForRenderer } from './hydrate/shader-language-routing.js';

const ERROR_PREFIX = '[tsl-precompile/compute]';

function fail( code, message, details = {} ) {

	const error = new Error( `${ ERROR_PREFIX } ${ message }` );
	error.name = 'PrecompiledComputeRunnerError';
	error.code = code;
	error.details = details;
	throw error;

}

function isRecord( value ) {

	return !! value && typeof value === 'object' && ! Array.isArray( value );

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

function cloneArtifactBindings( artifact ) {

	const recordClones = new WeakMap();
	const clonePlanRecord = ( record ) => {

		if ( ! isRecord( record ) ) return record;
		let cloned = recordClones.get( record );
		if ( ! cloned ) {

			// Generated artifacts may be deeply frozen. Keep the private plan
			// clone mutable at the one field the binder replaces.
			cloned = Object.prototype.hasOwnProperty.call( record, 'source' )
				? cloneRecord( record, { source: record.source } )
				: cloneRecord( record );
			recordClones.set( record, cloned );

		}
		return cloned;

	};
	const uniformPlan = Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan.map( ( group ) => {

		if ( ! isRecord( group ) ) return group;
		const replacements = {};
		if ( Array.isArray( group.slots ) ) replacements.slots = group.slots.map( clonePlanRecord );
		if ( Array.isArray( group.storageBuffers ) ) replacements.storageBuffers = group.storageBuffers.map( clonePlanRecord );
		if ( Array.isArray( group.textures ) ) replacements.textures = group.textures.map( clonePlanRecord );
		if ( Array.isArray( group.orderedBindings ) ) replacements.orderedBindings = group.orderedBindings.map( ( binding ) => {

			if ( ! isRecord( binding ) ) return binding;
			return binding.ref && isRecord( binding.ref )
				? cloneRecord( binding, { ref: clonePlanRecord( binding.ref ) } )
				: cloneRecord( binding );

		} );
		return cloneRecord( group, replacements );

	} ) : artifact.uniformPlan;
	const bindings = Array.isArray( artifact.bindings ) ? artifact.bindings.map( ( group ) => {

		if ( ! isRecord( group ) ) return group;
		return cloneRecord( group, {
			bindings: Array.isArray( group.bindings ) ? group.bindings.map( clonePlanRecord ) : group.bindings,
		} );

	} ) : artifact.bindings;
	const replacements = { bindings, uniformPlan };
	if ( artifact._textureRefs instanceof Map ) replacements._textureRefs = new Map( artifact._textureRefs );
	const bound = cloneRecord( artifact, replacements );
	if ( ! Object.prototype.hasOwnProperty.call( bound, '_textureRefs' ) ) Object.defineProperty( bound, '_textureRefs', {
		value: new Map(),
		enumerable: false,
		configurable: true,
		writable: false,
	} );
	return bound;

}

function normalizeArtifactInput( input ) {

	let module = input;
	if ( isRecord( input ) && ! isRecord( input.artifact ) && isRecord( input.default ) && isRecord( input.default.artifact ) ) module = input.default;
	if ( isRecord( module ) && isRecord( module.artifact ) ) return {
		artifact: module.artifact,
		updateGroup: typeof module.updateGroup === 'function' ? module.updateGroup : null,
	};
	return { artifact: input, updateGroup: null };

}

function assertSlimRenderer( renderer ) {

	const slim = renderer && (
		renderer.__TSLP_SLIM__ === true
		|| renderer.constructor && renderer.constructor.__TSLP_SLIM__ === true
	);
	if ( ! slim || typeof renderer.compute !== 'function' || typeof renderer.computeAsync !== 'function' ) fail(
		'TSLP_COMPUTE_RENDERER_INVALID',
		'createPrecompiledComputeRunner() requires an initialized-capable slim WebGPURenderer with compute() and computeAsync().',
	);

}

function validateArtifact( artifact ) {

	if ( ! isRecord( artifact ) || artifact.kind !== 'compute' || typeof artifact.computeShader !== 'string' || artifact.computeShader.length === 0 ) fail(
		'TSLP_COMPUTE_ARTIFACT_INVALID',
		'expected a standalone compute artifact (or generated module containing one).',
	);
	if ( ! isRecord( artifact.computeBindings ) ) fail(
		'TSLP_COMPUTE_BINDINGS_MISSING',
		'artifact.computeBindings must be a compute-bindings@1 descriptor.',
	);
	const errors = validateComputeBindingsDescriptor( artifact.computeBindings, { artifact } );
	if ( errors.length > 0 ) fail(
		'TSLP_COMPUTE_BINDINGS_INVALID',
		`invalid computeBindings descriptor: ${ errors[ 0 ].message }`,
		{ errors },
	);

}

function resourceKeys( resources ) {

	if ( ! isRecord( resources ) ) fail(
		'TSLP_COMPUTE_RESOURCES_INVALID',
		'resources must be an object keyed by computeBindings.entries[].key.',
	);
	return Object.keys( resources );

}

function validateResourceKeys( descriptor, resources ) {

	const expected = new Set( descriptor.entries.map( ( entry ) => entry.key ) );
	for ( const key of resourceKeys( resources ) ) {

		if ( ! expected.has( key ) ) fail(
			'TSLP_COMPUTE_RESOURCE_UNKNOWN',
			`resource ${ JSON.stringify( key ) } is not declared by artifact.computeBindings.`,
			{ key },
		);

	}
	for ( const key of expected ) {

		if ( ! Object.prototype.hasOwnProperty.call( resources, key ) ) fail(
			'TSLP_COMPUTE_RESOURCE_MISSING',
			`missing required compute resource ${ JSON.stringify( key ) }.`,
			{ key },
		);

	}

}

function mismatch( entry, reason ) {

	fail(
		'TSLP_COMPUTE_RESOURCE_MISMATCH',
		`resource ${ JSON.stringify( entry.key ) } does not satisfy ${ entry.target }: ${ reason }`,
		{ entry, reason },
	);

}

function validateStorageBuffer( entry, resource ) {

	if ( ! resource || (
		resource.isStorageBufferAttribute !== true
		&& resource.isStorageInstancedBufferAttribute !== true
	) || ! ArrayBuffer.isView( resource.array ) ) mismatch( entry, 'expected a StorageBufferAttribute-like object with typed-array storage' );
	if ( resource.count !== entry.count ) mismatch( entry, `count must be ${ entry.count }` );
	if ( resource.itemSize !== entry.itemSize ) mismatch( entry, `itemSize must be ${ entry.itemSize }` );
	if ( resource.array.constructor.name !== entry.arrayType ) mismatch( entry, `array type must be ${ entry.arrayType }` );
	if ( resource.array.byteLength !== entry.byteLength ) mismatch( entry, `byteLength must be ${ entry.byteLength }` );

}

function textureDimension( texture ) {

	if ( texture && texture.isCubeTexture === true ) return 'cube';
	if ( texture && ( texture.isData3DTexture === true || texture.is3DTexture === true || texture.isTexture3D === true ) ) return '3d';
	if ( texture && ( texture.isDataArrayTexture === true || texture.isArrayTexture === true || texture.isCompressedArrayTexture === true ) ) return '2d-array';
	return '2d';

}

function validateTexture( entry, resource, storage ) {

	if ( ! resource || resource.isTexture !== true ) mismatch( entry, 'expected a Three Texture' );
	if ( storage && resource.isStorageTexture !== true ) mismatch( entry, 'expected a caller-owned StorageTexture' );
	const dimension = textureDimension( resource );
	if ( dimension !== entry.textureType ) mismatch( entry, `texture dimension must be ${ entry.textureType }, got ${ dimension }` );

}

function isUniformHolder( resource ) {

	return isRecord( resource )
		&& Object.prototype.hasOwnProperty.call( resource, 'value' )
		&& resource.isColor !== true
		&& resource.isVector2 !== true
		&& resource.isVector3 !== true
		&& resource.isVector4 !== true
		&& resource.isMatrix3 !== true
		&& resource.isMatrix4 !== true;

}

function uniformValue( resource ) {

	return isUniformHolder( resource ) ? resource.value : resource;

}

function hasFiniteFields( value, fields ) {

	return !! value && fields.every( ( field ) => Number.isFinite( value[ field ] ) );

}

function validateUniform( entry, resource ) {

	const value = uniformValue( resource );
	const dtype = entry.dtype;
	if ( dtype === 'number' || dtype === 'float' || dtype === 'f32' ) {

		if ( ! Number.isFinite( value ) ) mismatch( entry, `${ dtype } requires a finite number` );
		return;

	}
	if ( dtype === 'int' || dtype === 'i32' || dtype === 'uint' || dtype === 'u32' ) {

		if ( ! Number.isSafeInteger( value ) ) mismatch( entry, `${ dtype } requires a safe integer` );
		return;

	}
	if ( dtype === 'bool' ) {

		if ( typeof value !== 'boolean' ) mismatch( entry, 'bool requires a boolean' );
		return;

	}
	if ( dtype === 'vec2' && hasFiniteFields( value, [ 'x', 'y' ] ) ) return;
	if ( dtype === 'vec3' && hasFiniteFields( value, [ 'x', 'y', 'z' ] ) ) return;
	if ( dtype === 'vec4' && hasFiniteFields( value, [ 'x', 'y', 'z', 'w' ] ) ) return;
	if ( dtype === 'color' && hasFiniteFields( value, [ 'r', 'g', 'b' ] ) ) return;
	if ( dtype === 'mat3' && value && value.elements && value.elements.length >= 9 ) return;
	if ( dtype === 'mat4' && value && value.elements && value.elements.length >= 16 ) return;
	mismatch( entry, `unsupported or invalid ${ dtype } uniform value` );

}

function validateResource( entry, resource ) {

	if ( entry.target === 'storage-buffer' ) validateStorageBuffer( entry, resource );
	else if ( entry.target === 'storage-texture' ) validateTexture( entry, resource, true );
	else if ( entry.target === 'sampled-texture' ) validateTexture( entry, resource, false );
	else if ( entry.target === 'sampler' ) {

		if ( ! resource || resource.isTexture !== true ) mismatch( entry, 'sampler bindings accept the texture whose sampler state should be used' );

	} else if ( entry.target === 'uniform-slot' ) validateUniform( entry, resource );

}

function defineHiddenSidecar( record, property, value ) {

	Object.defineProperty( record, property, {
		value,
		enumerable: false,
		configurable: true,
		writable: true,
	} );

}

function defineUniformSidecar( slot, resource ) {

	const holder = isUniformHolder( resource ) ? resource : { value: resource };
	defineHiddenSidecar( slot, '_liveNode', holder );
	defineHiddenSidecar( slot, '__tslpLiveSidecarOverlay', true );

}

function bindingLocation( artifact, entry ) {

	const descriptorGroup = artifact.bindings[ entry.group ];
	const planGroup = artifact.uniformPlan[ entry.group ];
	return {
		descriptor: descriptorGroup.bindings[ entry.binding ],
		ordered: planGroup.orderedBindings[ entry.binding ],
		planGroup,
	};

}

function bindStorageBuffer( artifact, entry, resource ) {

	const { descriptor, ordered, planGroup } = bindingLocation( artifact, entry );
	const names = new Set( [ descriptor.name, ordered.ref && ordered.ref.name ].filter( Boolean ) );
	const records = new Set( [ ordered.ref ] );
	for ( const record of planGroup.storageBuffers || [] ) {

		if ( records.has( record ) || names.has( record && record.name ) ) records.add( record );

	}
	for ( const record of records ) if ( isRecord( record ) ) defineHiddenSidecar( record, '_liveAttribute', resource );

}

function bindTexture( artifact, entry, resource ) {

	const { descriptor, ordered, planGroup } = bindingLocation( artifact, entry );
	const names = new Set( [ descriptor.name, ordered.ref && ordered.ref.name ].filter( Boolean ) );
	const records = new Set( [ ordered.ref ] );
	for ( const record of planGroup.textures || [] ) {

		if ( records.has( record ) || names.has( record && record.name ) ) records.add( record );

	}
	const textureType = entry.textureType || descriptor.textureType || textureDimension( resource );
	const source = Object.freeze( {
		kind: 'artifact.texture',
		textureUuid: resource.uuid,
		textureType,
	} );
	for ( const record of records ) if ( isRecord( record ) ) record.source = source;
	artifact._textureRefs.set( resource.uuid, resource );

}

function bindResources( artifact, resources ) {

	const descriptor = artifact.computeBindings;
	validateResourceKeys( descriptor, resources );
	for ( const entry of descriptor.entries ) validateResource( entry, resources[ entry.key ] );

	const bound = cloneArtifactBindings( artifact );
	for ( const entry of descriptor.entries ) {

		const resource = resources[ entry.key ];
		if ( entry.target === 'uniform-slot' ) {

			defineUniformSidecar( bound.uniformPlan[ entry.group ].slots[ entry.slot ], resource );

		} else if ( entry.target === 'storage-buffer' ) {

			bindStorageBuffer( bound, entry, resource );

		} else {

			bindTexture( bound, entry, resource );

		}

	}
	return bound;

}

class PrecompiledComputeRunner {

	constructor( renderer, artifact, resources ) {

		this.renderer = renderer;
		this.artifact = artifact;
		this.resources = resources;
		this.node = new PrecompiledComputeNode( artifact );
		Object.defineProperty( this.node, '__tslpMaterialComputeOwner', {
			value: Object.create( null ),
			enumerable: false,
			configurable: false,
			writable: false,
		} );
		this.disposed = false;

	}

	dispatch( dispatchSize ) {

		this._assertActive();
		return arguments.length > 0
			? this.renderer.compute( this.node, dispatchSize )
			: this.renderer.compute( this.node );

	}

	dispatchAsync( dispatchSize ) {

		this._assertActive();
		return arguments.length > 0
			? this.renderer.computeAsync( this.node, dispatchSize )
			: this.renderer.computeAsync( this.node );

	}

	dispose() {

		if ( this.disposed ) return;
		this.disposed = true;
		this.node.dispose();

	}

	_assertActive() {

		if ( this.disposed ) fail( 'TSLP_COMPUTE_RUNNER_DISPOSED', 'cannot dispatch a disposed compute runner.' );

	}

}

/**
 * Bind caller-owned resources to a generated standalone compute artifact.
 * Resource identities are fixed for the runner lifetime; mutate their
 * contents (or a uniform `{ value }` holder), or create a new runner to bind a
 * different resource object.
 */
export function createPrecompiledComputeRunner( renderer, artifactOrModule, resources ) {

	assertSlimRenderer( renderer );
	const { artifact, updateGroup } = normalizeArtifactInput( artifactOrModule );
	validateArtifact( artifact );
	assertArtifactShaderLanguageForRenderer( artifact, renderer );
	const boundArtifact = bindResources( artifact, resources );
	if ( updateGroup ) Object.defineProperty( boundArtifact, '_generatedUpdateGroup', {
		value: updateGroup,
		enumerable: false,
		configurable: true,
		writable: false,
	} );
	return new PrecompiledComputeRunner( renderer, boundArtifact, resources );

}

export default createPrecompiledComputeRunner;
