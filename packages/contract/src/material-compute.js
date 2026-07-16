import { collectArtifactVariantCandidates } from './artifact-variants.js';
import { stableJsonStringify } from './stable-json.js';

/**
 * Variant-local material-owned compute contract.
 *
 * A render artifact may carry one of these descriptors when its exact
 * NodeBuilderState scheduled raw ComputeNodes in `updateBeforeNodes`. The
 * descriptor embeds the already-extracted compute artifacts and relates
 * their GPU resources to render-side bindings without serializing process-
 * local UUIDs or relying on same-shape guesses.
 *
 * Runtime consumers may hydrate `precompiled` kernels directly. They must
 * require an explicit, successful full-renderer delegation transaction for
 * `hybrid-required` descriptors before rendering.
 *
 * @module Contract.MaterialCompute
 */

export const MATERIAL_COMPUTE_VERSION = 'material-compute@1';

// Deferred Fn() roots (most notably NodeMaterial.geometryNode) create their
// output nodes only while a full NodeBuilder executes the JavaScript closure.
// Keep the exact builder result on the live root under one private property so
// capture can serialize a normal material property path and hybrid replay can
// publish the equivalent retained node at that same path. Graph normalization
// deliberately ignores private node properties, so this evidence never changes
// source identity.
export const MATERIAL_COMPUTE_DEFERRED_NODES_PROPERTY = '_tslpMaterialComputeNodes';

const MATERIAL_COMPUTE_NODE_PATH_SKIP_KEYS = new Set( [
	'parent', 'children', 'scene', 'camera', 'renderer', 'geometry', '_cache',
	'domElement', 'sourceMaterial', 'constructor', '__proto__', 'prototype',
] );
const MATERIAL_COMPUTE_NODE_PATH_MAX_DEPTH = 24;

export const MATERIAL_COMPUTE_MODES = Object.freeze( [
	'precompiled',
	'hybrid-required',
] );

export const MATERIAL_COMPUTE_RESOURCE_KINDS = Object.freeze( [
	'storage-buffer',
	'storage-texture',
] );

export const MATERIAL_COMPUTE_STORAGE_TEXTURE_TYPES = Object.freeze( [
	'2d',
	'2d-array',
	'3d',
] );

export const MATERIAL_COMPUTE_RENDER_BINDING_KINDS = Object.freeze( [
	'attribute',
	'storage-buffer',
	'storage-texture',
] );

export const MATERIAL_COMPUTE_UPDATE_TYPES = Object.freeze( [
	'frame',
	'render',
	'object',
] );

export const MATERIAL_COMPUTE_LIFECYCLE_PHASES = Object.freeze( [
	'update',
	'update-before',
	'update-after',
] );

export const MATERIAL_COMPUTE_ACCESS_MODES = Object.freeze( [
	'readOnly',
	'writeOnly',
	'readWrite',
] );

const MODE_SET = new Set( MATERIAL_COMPUTE_MODES );
const RESOURCE_KIND_SET = new Set( MATERIAL_COMPUTE_RESOURCE_KINDS );
const STORAGE_TEXTURE_TYPE_SET = new Set( MATERIAL_COMPUTE_STORAGE_TEXTURE_TYPES );
const RENDER_BINDING_KIND_SET = new Set( MATERIAL_COMPUTE_RENDER_BINDING_KINDS );
const UPDATE_TYPE_SET = new Set( MATERIAL_COMPUTE_UPDATE_TYPES );
const LIFECYCLE_PHASE_SET = new Set( MATERIAL_COMPUTE_LIFECYCLE_PHASES );
const ACCESS_MODE_SET = new Set( MATERIAL_COMPUTE_ACCESS_MODES );

/**
 * Find one exact own-property path from a material's public `*Node` roots to a
 * live node. This mirrors the extractor's fail-closed identity walk and is
 * exported so render observation can prove whether a ComputeNode is genuinely
 * closure-hidden before publishing deferred evidence.
 *
 * @param {?Object} material
 * @param {?Object} target
 * @return {?Array<string>}
 */
export function findMaterialComputeNodePath( material, target ) {

	if ( ! material || ! target || typeof material !== 'object' ) return null;
	const rootKeys = Object.getOwnPropertyNames( material ).filter( ( key ) => key.endsWith( 'Node' ) ).sort();
	for ( const rootKey of rootKeys ) {

		let root = null;
		try { root = material[ rootKey ]; } catch ( _ ) { continue; }
		if ( ! root || ( typeof root !== 'object' && typeof root !== 'function' ) ) continue;
		const suffix = findMaterialComputeObjectPath( root, target );
		if ( suffix ) return [ rootKey, ...suffix ];

	}
	return null;

}

function findMaterialComputeObjectPath( root, target ) {

	if ( root === target ) return [];
	const seen = new Set();
	const visit = ( value, depth ) => {

		if ( value === target ) return [];
		if ( ! value || ( typeof value !== 'object' && typeof value !== 'function' ) ) return null;
		if ( seen.has( value ) || depth >= MATERIAL_COMPUTE_NODE_PATH_MAX_DEPTH ) return null;
		seen.add( value );

		let keys = [];
		try { keys = Object.getOwnPropertyNames( value ).sort(); } catch ( _ ) { return null; }
		for ( const key of keys ) {

			if ( MATERIAL_COMPUTE_NODE_PATH_SKIP_KEYS.has( key ) || key === 'length' ) continue;
			let child = null;
			try { child = value[ key ]; } catch ( _ ) { continue; }
			if ( child === target ) return [ key ];
			if ( ! child || ( typeof child !== 'object' && typeof child !== 'function' ) ) continue;
			const suffix = visit( child, depth + 1 );
			if ( suffix ) return [ key, ...suffix ];

		}
		return null;

	};
	return visit( root, 0 );

}

/**
 * Publish exact raw ComputeNodes on one deferred material root. Existing live
 * identities are retained in insertion order; a second builder variant thus
 * gets a different path and the material-compute family correctly fails closed
 * instead of pretending variant-local nodes share one runtime identity.
 *
 * @param {?Object} rootNode
 * @param {Array<Object>} nodes
 * @return {ReadonlyArray<Object>}
 */
export function attachDeferredMaterialComputeNodes( rootNode, nodes ) {

	if ( ! rootNode || ( typeof rootNode !== 'object' && typeof rootNode !== 'function' ) ) return Object.freeze( [] );
	const candidates = Array.isArray( nodes ) ? nodes.filter( ( node ) => (
		node && node.isComputeNode === true && node.isPrecompiledCompute !== true
	) ) : [];
	if ( candidates.length === 0 ) return Object.freeze( [] );

	let published = null;
	try { published = rootNode[ MATERIAL_COMPUTE_DEFERRED_NODES_PROPERTY ]; } catch ( _ ) { return Object.freeze( [] ); }
	if ( ! Array.isArray( published ) ) {

		published = [];
		try {

			Object.defineProperty( rootNode, MATERIAL_COMPUTE_DEFERRED_NODES_PROPERTY, {
				value: published,
				enumerable: false,
				configurable: true,
			} );

		} catch ( _ ) { return Object.freeze( [] ); }

	}
	for ( const node of candidates ) if ( ! published.includes( node ) ) published.push( node );
	return Object.freeze( candidates.slice() );

}

/**
 * Bridge closure-hidden raw ComputeNodes from one exact NodeBuilderState onto
 * a single deferred Fn() material root. Multiple deferred roots are ambiguous
 * and remain unmodified so extraction continues to fail closed.
 *
 * @param {?Object} material
 * @param {?Object} state
 * @return {ReadonlyArray<Array<string>>}
 */
export function attachDeferredMaterialComputeStatePaths( material, state ) {

	if ( ! material || ! state ) return Object.freeze( [] );
	const computeNodes = [ ...new Set( ( Array.isArray( state.updateBeforeNodes ) ? state.updateBeforeNodes : [] ).filter( ( node ) => (
		node && node.isComputeNode === true && node.isPrecompiledCompute !== true
	) ) ) ];
	const unresolved = computeNodes.filter( ( node ) => findMaterialComputeNodePath( material, node ) === null );
	if ( unresolved.length === 0 ) return Object.freeze( [] );

	const deferredRoots = [];
	for ( const rootKey of Object.getOwnPropertyNames( material ).filter( ( key ) => key.endsWith( 'Node' ) ).sort() ) {

		let root = null;
		try { root = material[ rootKey ]; } catch ( _ ) { continue; }
		const callNode = root && root.isVarNode === true ? root.node : root;
		if ( callNode && callNode.isShaderCallNodeInternal === true && typeof callNode.shaderNode?.jsFunc === 'function' ) deferredRoots.push( callNode );

	}
	if ( deferredRoots.length !== 1 ) return Object.freeze( [] );
	attachDeferredMaterialComputeNodes( deferredRoots[ 0 ], unresolved );
	return Object.freeze( unresolved.map( ( node ) => findMaterialComputeNodePath( material, node ) ).filter( Boolean ) );

}

function issue( code, message, path ) {

	return Object.freeze( { code, message, path } );

}

function isRecord( value ) {

	return !! value && typeof value === 'object' && ! Array.isArray( value );

}

function isIndex( value ) {

	return Number.isSafeInteger( value ) && value >= 0;

}

function requireArray( descriptor, field, errors, root ) {

	if ( Array.isArray( descriptor[ field ] ) ) return descriptor[ field ];
	errors.push( issue(
		`material-compute.${ field }`,
		`${ root }.${ field } must be an array`,
		`${ root }.${ field }`,
	) );
	return [];

}

function numericId( value, prefix ) {

	if ( typeof value !== 'string' ) return - 1;
	const match = new RegExp( `^${ prefix }:(\\d+)$` ).exec( value );
	return match ? Number( match[ 1 ] ) : - 1;

}

function compareTuple( left, right ) {

	const length = Math.max( left.length, right.length );
	for ( let index = 0; index < length; index ++ ) {

		const a = left[ index ];
		const b = right[ index ];
		if ( a === b ) continue;
		return a < b ? - 1 : 1;

	}
	return 0;

}

function renderBindingTuple( entry ) {

	const rank = MATERIAL_COMPUTE_RENDER_BINDING_KINDS.indexOf( entry && entry.kind );
	return [
		numericId( entry && entry.resource, 'resource' ),
		rank,
		entry && entry.group !== undefined ? entry.group : - 1,
		entry && entry.binding !== undefined ? entry.binding : - 1,
		entry && entry.attribute !== undefined ? entry.attribute : - 1,
	];

}

function computeBindingTuple( entry ) {

	return [
		numericId( entry && entry.kernel, 'kernel' ),
		entry && entry.group !== undefined ? entry.group : - 1,
		entry && entry.binding !== undefined ? entry.binding : - 1,
		numericId( entry && entry.resource, 'resource' ),
	];

}

function validateCanonicalOrder( entries, tupleFor, code, root, errors ) {

	let previous = null;
	const keys = new Set();
	for ( let index = 0; index < entries.length; index ++ ) {

		const tuple = tupleFor( entries[ index ] );
		const key = JSON.stringify( tuple );
		const path = `${ root }[${ index }]`;
		if ( keys.has( key ) ) errors.push( issue( `${ code }.duplicate`, `${ path } duplicates an earlier entry`, path ) );
		if ( previous && compareTuple( previous, tuple ) > 0 ) errors.push( issue( `${ code }.order`, `${ root } must be in canonical order`, path ) );
		keys.add( key );
		previous = tuple;

	}

}

function validateKernelArtifact( artifact, mode, path, expectedCacheKey, errors ) {

	if ( artifact === null ) {

		if ( mode !== 'hybrid-required' ) errors.push( issue(
			'material-compute.kernel.artifact',
			`${ path } may be null only when mode is "hybrid-required"`,
			path,
		) );
		return;

	}
	if ( ! isRecord( artifact ) ) {

		errors.push( issue( 'material-compute.kernel.artifact', `${ path } must be a compute artifact or null`, path ) );
		return;

	}
	if ( artifact.kind !== 'compute' ) errors.push( issue(
		'material-compute.kernel.kind',
		`${ path }.kind must be "compute"`,
		`${ path }.kind`,
	) );
	if ( typeof artifact.computeShader !== 'string' || artifact.computeShader.trim().length === 0 ) errors.push( issue(
		'material-compute.kernel.shader',
		`${ path }.computeShader must be a non-empty string`,
		`${ path }.computeShader`,
	) );
	if ( ! Array.isArray( artifact.bindings ) ) errors.push( issue(
		'material-compute.kernel.bindings',
		`${ path }.bindings must be an array`,
		`${ path }.bindings`,
	) );
	if ( ! Array.isArray( artifact.uniformPlan ) ) errors.push( issue(
		'material-compute.kernel.uniformPlan',
		`${ path }.uniformPlan must be an array`,
		`${ path }.uniformPlan`,
	) );
	if ( artifact.cacheKey !== expectedCacheKey ) errors.push( issue(
		'material-compute.kernel.cache-key',
		`${ path }.cacheKey must be ${ expectedCacheKey } for canonical nested routing`,
		`${ path }.cacheKey`,
	) );
	if ( ! validDispatchSize( artifact.dispatchSize ) ) errors.push( issue(
		'material-compute.kernel.dispatch-size',
		`${ path }.dispatchSize must be a positive integer or a one-to-three element positive-integer array`,
		`${ path }.dispatchSize`,
	) );
	if ( ! validWorkgroupSize( artifact.workgroupSize ) ) errors.push( issue(
		'material-compute.kernel.workgroup-size',
		`${ path }.workgroupSize must be a three-element positive-integer array`,
		`${ path }.workgroupSize`,
	) );

}

function validateKernelUpdates( kernel, mode, path, errors ) {

	const updates = Array.isArray( kernel.updates ) ? kernel.updates : [];
	if ( ! Array.isArray( kernel.updates ) ) errors.push( issue(
		'material-compute.kernel.updates',
		`${ path }.updates must be an array`,
		`${ path }.updates`,
	) );
	const nextOrderByPhase = new Map( MATERIAL_COMPUTE_LIFECYCLE_PHASES.map( ( phase ) => [ phase, 0 ] ) );
	let previousPhaseRank = - 1;
	let previousOrder = - 1;
	const phasePathKeys = new Set();
	for ( let index = 0; index < updates.length; index ++ ) {

		const entry = updates[ index ];
		const entryPath = `${ path }.updates[${ index }]`;
		if ( ! isRecord( entry ) ) {

			errors.push( issue( 'material-compute.kernel.update', `${ entryPath } must be an object`, entryPath ) );
			continue;

		}
		const phaseRank = MATERIAL_COMPUTE_LIFECYCLE_PHASES.indexOf( entry.phase );
		if ( ! LIFECYCLE_PHASE_SET.has( entry.phase ) ) errors.push( issue(
			'material-compute.kernel.update.phase',
			`${ entryPath }.phase must be one of ${ MATERIAL_COMPUTE_LIFECYCLE_PHASES.join( ', ' ) }`,
			`${ entryPath }.phase`,
		) );
		if ( ! isIndex( entry.order ) ) errors.push( issue(
			'material-compute.kernel.update.order',
			`${ entryPath }.order must be a non-negative integer`,
			`${ entryPath }.order`,
		) );
		if ( phaseRank >= 0 && isIndex( entry.order ) ) {

			const expectedOrder = nextOrderByPhase.get( entry.phase );
			if ( entry.order !== expectedOrder ) errors.push( issue(
				'material-compute.kernel.update.order',
				`${ path }.updates must use contiguous order within ${ entry.phase }`,
				`${ entryPath }.order`,
			) );
			nextOrderByPhase.set( entry.phase, expectedOrder + 1 );
			if ( phaseRank < previousPhaseRank || phaseRank === previousPhaseRank && entry.order <= previousOrder ) errors.push( issue(
				'material-compute.kernel.update.canonical-order',
				`${ path }.updates must be in canonical phase/order sequence`,
				entryPath,
			) );
			previousPhaseRank = phaseRank;
			previousOrder = entry.order;

		}
		if ( ! validUserPath( entry.nodePath ) ) errors.push( issue(
			'material-compute.kernel.update.node-path',
			`${ entryPath }.nodePath must be an exact material graph path`,
			`${ entryPath }.nodePath`,
		) );
		if ( ! UPDATE_TYPE_SET.has( entry.updateType ) ) errors.push( issue(
			'material-compute.kernel.update.update-type',
			`${ entryPath }.updateType must be one of ${ MATERIAL_COMPUTE_UPDATE_TYPES.join( ', ' ) }`,
			`${ entryPath }.updateType`,
		) );
		const pathKey = `${ entry.phase }|${ JSON.stringify( entry.nodePath ) }`;
		if ( phasePathKeys.has( pathKey ) ) errors.push( issue(
			'material-compute.kernel.update.duplicate',
			`${ entryPath } duplicates a node already scheduled in ${ entry.phase }`,
			entryPath,
		) );
		phasePathKeys.add( pathKey );

	}
	if ( mode !== 'precompiled' || ! isRecord( kernel.artifact ) ) return;
	const countFields = Object.freeze( {
		update: 'updateNodes',
		'update-before': 'updateBeforeNodes',
		'update-after': 'updateAfterNodes',
	} );
	for ( const phase of MATERIAL_COMPUTE_LIFECYCLE_PHASES ) {

		const field = countFields[ phase ];
		const expected = kernel.artifact.meta && kernel.artifact.meta[ field ];
		const actual = updates.filter( ( entry ) => entry && entry.phase === phase ).length;
		if ( ! Number.isSafeInteger( expected ) || expected !== actual ) errors.push( issue(
			'material-compute.mode.kernel-update-coverage',
			`${ path }.updates must cover all ${ field } entries in precompiled mode`,
			`${ path }.updates`,
		) );

	}

}

function bindingDescriptorAt( artifact, group, binding ) {

	const groupDescriptor = artifact && Array.isArray( artifact.bindings ) ? artifact.bindings[ group ] : null;
	return groupDescriptor && Array.isArray( groupDescriptor.bindings ) ? groupDescriptor.bindings[ binding ] : null;

}

function orderedBindingAt( artifact, group, binding ) {

	const groupDescriptor = artifact && Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan[ group ] : null;
	return groupDescriptor && Array.isArray( groupDescriptor.orderedBindings ) ? groupDescriptor.orderedBindings[ binding ] : null;

}

function validDispatchSize( value ) {

	if ( Number.isSafeInteger( value ) ) return value > 0;
	return Array.isArray( value )
		&& value.length > 0
		&& value.length <= 3
		&& value.every( ( item ) => Number.isSafeInteger( item ) && item > 0 );

}

function validWorkgroupSize( value ) {

	return Array.isArray( value )
		&& value.length === 3
		&& value.every( ( item ) => Number.isSafeInteger( item ) && item > 0 );

}

function validateStorageBufferMetadata( resource, path, errors ) {

	if ( typeof resource.arrayType !== 'string' || resource.arrayType.length === 0 ) errors.push( issue(
		'material-compute.resource.array-type',
		`${ path }.arrayType must be a non-empty typed-array constructor name`,
		`${ path }.arrayType`,
	) );
	if ( ! isIndex( resource.count ) ) errors.push( issue(
		'material-compute.resource.count',
		`${ path }.count must be a non-negative integer`,
		`${ path }.count`,
	) );
	if ( ! Number.isSafeInteger( resource.itemSize ) || resource.itemSize <= 0 ) errors.push( issue(
		'material-compute.resource.item-size',
		`${ path }.itemSize must be a positive integer`,
		`${ path }.itemSize`,
	) );
	if ( ! isIndex( resource.byteLength ) ) errors.push( issue(
		'material-compute.resource.byte-length',
		`${ path }.byteLength must be a non-negative integer`,
		`${ path }.byteLength`,
	) );

}

function validateStorageTextureMetadata( resource, path, errors ) {

	if ( ! STORAGE_TEXTURE_TYPE_SET.has( resource.textureType ) ) errors.push( issue(
		'material-compute.resource.texture-type',
		`${ path }.textureType must be one of ${ MATERIAL_COMPUTE_STORAGE_TEXTURE_TYPES.join( ', ' ) }`,
		`${ path }.textureType`,
	) );

}

function validateResourceBindingDescriptor( descriptor, ordered, resource, entry, path, mode, errors ) {

	if ( ! descriptor ) {

		errors.push( issue(
			'material-compute.binding.location',
			`${ path } does not identify a binding in the kernel artifact`,
			`${ path }.binding`,
		) );
		return;

	}
	if ( resource.kind === 'storage-buffer' ) {

		if ( descriptor.kind !== 'storage-buffer' || ! ordered || ordered.type !== 'storage-buffer' ) errors.push( issue(
			'material-compute.binding.kind',
			`${ path } does not identify an exact storage-buffer binding`,
			path,
		) );
		if ( descriptor.access !== null && descriptor.access !== undefined && descriptor.access !== entry.access ) errors.push( issue(
			'material-compute.binding.access-mismatch',
			`${ path }.access must match the nested compute binding descriptor`,
			`${ path }.access`,
		) );
		if ( mode === 'precompiled' && ! ACCESS_MODE_SET.has( descriptor.access ) ) errors.push( issue(
			'material-compute.binding.access-unproven',
			`${ path }.access must be proven by the nested compute binding descriptor in precompiled mode`,
			`${ path }.access`,
		) );
		const ref = ordered && ordered.ref;
		for ( const field of [ 'arrayType', 'count', 'itemSize' ] ) {

			if ( ref && ref[ field ] !== resource[ field ] ) errors.push( issue(
				`material-compute.binding.${ field }-mismatch`,
				`${ path } resource ${ field } must match the nested compute uniform plan`,
				path,
			) );

		}
		if ( Number.isSafeInteger( descriptor.byteLength ) && descriptor.byteLength !== resource.byteLength ) errors.push( issue(
			'material-compute.binding.byte-length-mismatch',
			`${ path } resource byteLength must match the nested compute binding descriptor`,
			path,
		) );

	} else if ( resource.kind === 'storage-texture' ) {

		if ( descriptor.kind !== 'sampled-texture' || descriptor.store !== true ) errors.push( issue(
			'material-compute.binding.kind',
			`${ path } does not identify a storage texture binding`,
			path,
		) );
		if ( ! ACCESS_MODE_SET.has( descriptor.access ) ) errors.push( issue(
			'material-compute.binding.access-unproven',
			`${ path }.access must be proven by the nested storage-texture binding descriptor`,
			`${ path }.access`,
		) );
		else if ( descriptor.access !== entry.access ) errors.push( issue(
			'material-compute.binding.access-mismatch',
			`${ path }.access must match the nested storage-texture binding descriptor`,
			`${ path }.access`,
		) );

	}

}

function validUserPath( value ) {

	return Array.isArray( value )
		&& value.length > 0
		&& value.every( ( segment ) => typeof segment === 'string' && segment.length > 0 );

}

function validStorageUserPath( value ) {

	// Storage ownership paths must reach the exact `.attribute` / `.value`
	// leaf. A root-only material slot still needs a same-shape tree search and
	// therefore is not sufficient proof for compiler-free resource ownership.
	return validUserPath( value ) && value.length > 1;

}

function exactArraySnapshot( value, resource ) {

	const expectedLength = resource.count * resource.itemSize;
	return Number.isSafeInteger( expectedLength )
		&& Array.isArray( value )
		&& value.length === expectedLength;

}

function renderBindingProvidesInitialState( ownerArtifact, entry, resource ) {

	if ( ! ownerArtifact || ! entry || ! resource || resource.kind !== 'storage-buffer' ) return false;
	if ( entry.kind === 'attribute' ) {

		const attribute = Array.isArray( ownerArtifact.attributes ) ? ownerArtifact.attributes[ entry.attribute ] : null;
		return !! attribute && ( validStorageUserPath( attribute.userPath ) || exactArraySnapshot( attribute.arraySnapshot, resource ) );

	}
	if ( entry.kind === 'storage-buffer' ) {

		const ordered = orderedBindingAt( ownerArtifact, entry.group, entry.binding );
		const ref = ordered && ordered.ref;
		return !! ref && ( validStorageUserPath( ref.userPath ) || exactArraySnapshot( ref.arraySnapshot, resource ) );

	}
	return false;

}

function hasUnresolvedLiveUniform( artifact ) {

	for ( const group of artifact && Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [] ) {

		for ( const slot of group && Array.isArray( group.slots ) ? group.slots : [] ) {

			const source = slot && slot.source;
			if ( source && source.kind === 'uniform.live' && ! validUserPath( source.nodePath ) ) return true;

		}

	}
	return false;

}

/** Whether one sampled compute source can be rebuilt without process-local identity. */
export function isSerializableMaterialComputeTextureSource( artifact, source ) {

	if ( ! source || typeof source !== 'object' ) return false;
	if ( source.kind === 'builtin.dfgLUT' ) return true;
	if ( source.kind === 'builtin.ltcTexture' ) return Array.isArray( artifact && artifact.ltcTextures );
	const snapshot = source.kind === 'artifact.texture' && source.snapshot;
	return !! snapshot
		&& Number.isSafeInteger( snapshot.width ) && snapshot.width > 0
		&& Number.isSafeInteger( snapshot.height ) && snapshot.height > 0
		&& Array.isArray( snapshot.data );

}

/** Detect a sampled texture/sampler that would fall through to a shape-only runtime texture. */
export function hasUnresolvedMaterialComputeTexture( artifact ) {

	const descriptorGroups = Array.isArray( artifact && artifact.bindings ) ? artifact.bindings : [];
	const planGroups = Array.isArray( artifact && artifact.uniformPlan ) ? artifact.uniformPlan : [];
	for ( let group = 0; group < descriptorGroups.length; group ++ ) {

		const descriptors = Array.isArray( descriptorGroups[ group ] && descriptorGroups[ group ].bindings ) ? descriptorGroups[ group ].bindings : [];
		const ordered = Array.isArray( planGroups[ group ] && planGroups[ group ].orderedBindings ) ? planGroups[ group ].orderedBindings : [];
		for ( let binding = 0; binding < descriptors.length; binding ++ ) {

			const descriptor = descriptors[ binding ];
			if ( ! descriptor || descriptor.kind !== 'sampled-texture' && descriptor.kind !== 'sampler' ) continue;
			if ( descriptor.kind === 'sampled-texture' && descriptor.store === true ) continue;
			const source = ordered[ binding ] && ordered[ binding ].ref && ordered[ binding ].ref.source;
			if ( ! isSerializableMaterialComputeTextureSource( artifact, source ) ) return true;

		}

	}
	return false;

}

function materialComputeRenderBindingRecord( artifact, entry ) {

	if ( ! artifact || ! entry ) return null;
	if ( entry.kind === 'attribute' ) {

		const attributes = Array.isArray( artifact.attributes ) ? artifact.attributes : artifact.nodeAttributes;
		return Array.isArray( attributes ) ? attributes[ entry.attribute ] || null : null;

	}
	const ordered = orderedBindingAt( artifact, entry.group, entry.binding );
	return ordered && ordered.ref || null;

}

function materialComputeInitialStateFingerprint( artifact, descriptor ) {

	const proofs = [];
	for ( const binding of Array.isArray( descriptor && descriptor.renderBindings ) ? descriptor.renderBindings : [] ) {

		const record = materialComputeRenderBindingRecord( artifact, binding );
		proofs.push( {
			resource: binding && binding.resource || null,
			kind: binding && binding.kind || null,
			userPath: record && Array.isArray( record.userPath ) ? record.userPath : null,
			arraySnapshot: record && Array.isArray( record.arraySnapshot ) ? record.arraySnapshot : null,
			instanced: record && record.instanced === true,
			normalized: record && record.normalized === true,
			usage: record && Number.isFinite( record.usage ) ? record.usage : null,
			meshPerAttribute: record && Number.isFinite( record.meshPerAttribute ) ? record.meshPerAttribute : null,
		} );

	}
	return proofs;

}

/**
 * Inspect material-global compute ownership before selecting one render
 * variant. The first runtime implementation can share one controller only
 * when every authoritative variant carries the exact same descriptor and
 * serialized initial-state proof.
 */
export function inspectMaterialComputeFamily( artifact ) {

	const candidates = collectArtifactVariantCandidates( artifact );
	const descriptors = candidates.map( ( candidate ) => candidate && candidate.materialCompute );
	const present = descriptors.filter( ( descriptor ) => descriptor !== undefined );
	if ( present.length === 0 ) return Object.freeze( {
		status: 'none',
		descriptor: null,
		fingerprint: null,
		candidateCount: candidates.length,
	} );
	if ( present.length !== descriptors.length ) return Object.freeze( {
		status: 'divergent',
		descriptor: null,
		fingerprint: null,
		candidateCount: candidates.length,
		reason: 'partial-family',
	} );

	const fingerprints = new Map();
	for ( let index = 0; index < candidates.length; index ++ ) {

		const candidate = candidates[ index ];
		const descriptor = descriptors[ index ];
		let fingerprint;
		try {

			fingerprint = stableJsonStringify( {
				descriptor,
				initialState: materialComputeInitialStateFingerprint( candidate, descriptor ),
			}, 'materialComputeFamily' );

		} catch ( _ ) {

			return Object.freeze( {
				status: 'divergent',
				descriptor: null,
				fingerprint: null,
				candidateCount: candidates.length,
				reason: 'unfingerprintable-family',
			} );

		}
		if ( ! fingerprints.has( fingerprint ) ) fingerprints.set( fingerprint, descriptor );

	}
	if ( fingerprints.size !== 1 ) return Object.freeze( {
		status: 'divergent',
		descriptor: null,
		fingerprint: null,
		candidateCount: candidates.length,
		reason: 'non-uniform-family',
	} );
	const [ fingerprint, descriptor ] = fingerprints.entries().next().value;
	return Object.freeze( {
		status: 'uniform',
		descriptor,
		fingerprint,
		candidateCount: candidates.length,
	} );

}

/**
 * Validate one optional `material-compute@1` descriptor.
 *
 * Returned paths are rooted at `materialCompute` by default so the generic
 * artifact validator can forward them without translating a second schema.
 *
 * @param {*} value
 * @param {Object} [opts]
 * @param {?Object} [opts.artifact] owning render artifact/variant
 * @param {string} [opts.path='materialCompute']
 * @return {ReadonlyArray<{code:string,message:string,path:string}>}
 */
export function validateMaterialComputeDescriptor( value, opts = {} ) {

	const root = opts.path || 'materialCompute';
	const ownerArtifact = opts.artifact || null;
	const errors = [];
	if ( ! isRecord( value ) ) return Object.freeze( [ issue(
		'material-compute.type',
		`${ root } must be an object`,
		root,
	) ] );

	if ( value.version !== MATERIAL_COMPUTE_VERSION ) errors.push( issue(
		'material-compute.version',
		`${ root }.version must be ${ JSON.stringify( MATERIAL_COMPUTE_VERSION ) }`,
		`${ root }.version`,
	) );
	if ( ! MODE_SET.has( value.mode ) ) errors.push( issue(
		'material-compute.mode',
		`${ root }.mode must be one of ${ MATERIAL_COMPUTE_MODES.join( ', ' ) }`,
		`${ root }.mode`,
	) );

	const resources = requireArray( value, 'resources', errors, root );
	const kernels = requireArray( value, 'kernels', errors, root );
	const bindings = requireArray( value, 'bindings', errors, root );
	const renderBindings = requireArray( value, 'renderBindings', errors, root );
	const schedule = requireArray( value, 'schedule', errors, root );
	const reasons = requireArray( value, 'reasons', errors, root );
	const resourceById = new Map();
	const kernelById = new Map();
	let previousReason = null;
	const reasonSet = new Set();
	for ( let index = 0; index < reasons.length; index ++ ) {

		const reason = reasons[ index ];
		const path = `${ root }.reasons[${ index }]`;
		if ( typeof reason !== 'string' || reason.length === 0 ) {

			errors.push( issue( 'material-compute.reason', `${ path } must be a non-empty string`, path ) );
			continue;

		}
		if ( reasonSet.has( reason ) ) errors.push( issue( 'material-compute.reason.duplicate', `${ path } duplicates an earlier reason`, path ) );
		if ( previousReason !== null && reason < previousReason ) errors.push( issue( 'material-compute.reason.order', `${ root }.reasons must be sorted canonically`, path ) );
		reasonSet.add( reason );
		previousReason = reason;

	}
	if ( value.mode === 'precompiled' && reasons.length > 0 ) errors.push( issue(
		'material-compute.reason.mode',
		`${ root }.reasons must be empty in precompiled mode`,
		`${ root }.reasons`,
	) );
	if ( value.mode === 'hybrid-required' && reasons.length === 0 ) errors.push( issue(
		'material-compute.reason.mode',
		`${ root }.reasons must explain why hybrid mode is required`,
		`${ root }.reasons`,
	) );

	for ( let index = 0; index < resources.length; index ++ ) {

		const resource = resources[ index ];
		const path = `${ root }.resources[${ index }]`;
		if ( ! isRecord( resource ) ) {

			errors.push( issue( 'material-compute.resource', `${ path } must be an object`, path ) );
			continue;

		}
		const expectedId = `resource:${ index }`;
		if ( resource.id !== expectedId ) errors.push( issue(
			'material-compute.resource.id',
			`${ path }.id must be ${ JSON.stringify( expectedId ) }`,
			`${ path }.id`,
		) );
		if ( ! RESOURCE_KIND_SET.has( resource.kind ) ) errors.push( issue(
			'material-compute.resource.kind',
			`${ path }.kind must be one of ${ MATERIAL_COMPUTE_RESOURCE_KINDS.join( ', ' ) }`,
			`${ path }.kind`,
		) );
		if ( resource.kind === 'storage-buffer' ) validateStorageBufferMetadata( resource, path, errors );
		if ( resource.kind === 'storage-texture' ) validateStorageTextureMetadata( resource, path, errors );
		if ( typeof resource.id === 'string' ) resourceById.set( resource.id, resource );

	}

	for ( let index = 0; index < kernels.length; index ++ ) {

		const kernel = kernels[ index ];
		const path = `${ root }.kernels[${ index }]`;
		if ( ! isRecord( kernel ) ) {

			errors.push( issue( 'material-compute.kernel', `${ path } must be an object`, path ) );
			continue;

		}
		const expectedId = `kernel:${ index }`;
		if ( kernel.id !== expectedId ) errors.push( issue(
			'material-compute.kernel.id',
			`${ path }.id must be ${ JSON.stringify( expectedId ) }`,
			`${ path }.id`,
		) );
		if ( kernel.nodePath !== null && ! validUserPath( kernel.nodePath ) ) errors.push( issue(
			'material-compute.kernel.node-path',
			`${ path }.nodePath must be an exact material graph path or null`,
			`${ path }.nodePath`,
		) );
		if ( value.mode === 'precompiled' && ! validUserPath( kernel.nodePath ) ) errors.push( issue(
			'material-compute.mode.kernel-node-path',
			`${ path }.nodePath is required in precompiled mode`,
			`${ path }.nodePath`,
		) );
		validateKernelArtifact( kernel.artifact, value.mode, `${ path }.artifact`, index + 1, errors );
		validateKernelUpdates( kernel, value.mode, path, errors );
		if ( typeof kernel.id === 'string' ) kernelById.set( kernel.id, kernel );

	}

	const computeBindingLocations = new Set();
	const computeBoundResources = new Set();
	const firstBoundResources = new Set();
	let nextFirstBoundResource = 0;
	for ( let index = 0; index < bindings.length; index ++ ) {

		const entry = bindings[ index ];
		const path = `${ root }.bindings[${ index }]`;
		if ( ! isRecord( entry ) ) {

			errors.push( issue( 'material-compute.binding', `${ path } must be an object`, path ) );
			continue;

		}
		const kernel = kernelById.get( entry.kernel );
		const resource = resourceById.get( entry.resource );
		if ( ! kernel ) errors.push( issue( 'material-compute.binding.kernel', `${ path }.kernel must reference a declared kernel`, `${ path }.kernel` ) );
		if ( ! resource ) errors.push( issue( 'material-compute.binding.resource', `${ path }.resource must reference a declared resource`, `${ path }.resource` ) );
		if ( ! isIndex( entry.group ) ) errors.push( issue( 'material-compute.binding.group', `${ path }.group must be a non-negative integer`, `${ path }.group` ) );
		if ( ! isIndex( entry.binding ) ) errors.push( issue( 'material-compute.binding.binding', `${ path }.binding must be a non-negative integer`, `${ path }.binding` ) );
		if ( ! ACCESS_MODE_SET.has( entry.access ) ) errors.push( issue(
			'material-compute.binding.access',
			`${ path }.access must be one of ${ MATERIAL_COMPUTE_ACCESS_MODES.join( ', ' ) }`,
			`${ path }.access`,
		) );
		const location = `${ entry.kernel }|${ entry.group }|${ entry.binding }`;
		if ( computeBindingLocations.has( location ) ) errors.push( issue(
			'material-compute.binding.location-duplicate',
			`${ path } conflicts with another resource at the same kernel binding location`,
			path,
		) );
		computeBindingLocations.add( location );
		if ( resource ) {

			computeBoundResources.add( resource.id );
			if ( ! firstBoundResources.has( resource.id ) ) {

				const expectedResource = `resource:${ nextFirstBoundResource ++ }`;
				if ( resource.id !== expectedResource ) errors.push( issue(
					'material-compute.binding.resource-order',
					`${ path }.resource must introduce ${ JSON.stringify( expectedResource ) } before later resources`,
					`${ path }.resource`,
				) );
				firstBoundResources.add( resource.id );

			}

		}
		if ( kernel && kernel.artifact && isIndex( entry.group ) && isIndex( entry.binding ) ) {

			const descriptor = bindingDescriptorAt( kernel.artifact, entry.group, entry.binding );
			const ordered = orderedBindingAt( kernel.artifact, entry.group, entry.binding );
			if ( resource ) validateResourceBindingDescriptor( descriptor, ordered, resource, entry, path, value.mode, errors );

		}

	}
	validateCanonicalOrder( bindings, computeBindingTuple, 'material-compute.binding', `${ root }.bindings`, errors );

	const renderBindingLocations = new Set();
	for ( let index = 0; index < renderBindings.length; index ++ ) {

		const entry = renderBindings[ index ];
		const path = `${ root }.renderBindings[${ index }]`;
		if ( ! isRecord( entry ) ) {

			errors.push( issue( 'material-compute.render-binding', `${ path } must be an object`, path ) );
			continue;

		}
		const resource = resourceById.get( entry.resource );
		if ( ! resource ) errors.push( issue( 'material-compute.render-binding.resource', `${ path }.resource must reference a declared resource`, `${ path }.resource` ) );
		if ( ! RENDER_BINDING_KIND_SET.has( entry.kind ) ) errors.push( issue(
			'material-compute.render-binding.kind',
			`${ path }.kind must be one of ${ MATERIAL_COMPUTE_RENDER_BINDING_KINDS.join( ', ' ) }`,
			`${ path }.kind`,
		) );
		if ( entry.kind === 'attribute' ) {

			if ( ! isIndex( entry.attribute ) ) errors.push( issue( 'material-compute.render-binding.attribute', `${ path }.attribute must be a non-negative integer`, `${ path }.attribute` ) );
			if ( resource && resource.kind !== 'storage-buffer' ) errors.push( issue(
				'material-compute.render-binding.resource-kind',
				`${ path } can map an attribute only to a storage-buffer resource`,
				path,
			) );
			const location = `attribute|${ entry.attribute }`;
			if ( renderBindingLocations.has( location ) ) errors.push( issue(
				'material-compute.render-binding.location-duplicate',
				`${ path } conflicts with another resource at the same render attribute location`,
				path,
			) );
			renderBindingLocations.add( location );
			const attribute = ownerArtifact && Array.isArray( ownerArtifact.attributes ) && isIndex( entry.attribute ) ? ownerArtifact.attributes[ entry.attribute ] : null;
			if ( ownerArtifact && ! attribute ) errors.push( issue( 'material-compute.render-binding.location', `${ path } does not identify a render attribute`, `${ path }.attribute` ) );
			if ( attribute && resource && resource.kind === 'storage-buffer' ) {

				if ( attribute.storage !== true ) errors.push( issue(
					'material-compute.render-binding.attribute-storage',
					`${ path } must identify a storage-backed render attribute`,
					`${ path }.attribute`,
				) );
				for ( const field of [ 'arrayType', 'count', 'itemSize' ] ) if ( attribute[ field ] !== resource[ field ] ) errors.push( issue(
					`material-compute.render-binding.${ field }-mismatch`,
					`${ path } resource ${ field } must match the render attribute`,
					`${ path }.attribute`,
				) );

			}

		} else if ( RENDER_BINDING_KIND_SET.has( entry.kind ) ) {

			if ( ! isIndex( entry.group ) ) errors.push( issue( 'material-compute.render-binding.group', `${ path }.group must be a non-negative integer`, `${ path }.group` ) );
			if ( ! isIndex( entry.binding ) ) errors.push( issue( 'material-compute.render-binding.binding', `${ path }.binding must be a non-negative integer`, `${ path }.binding` ) );
			if ( resource && entry.kind !== resource.kind ) errors.push( issue(
				'material-compute.render-binding.resource-kind',
				`${ path }.kind must match resource kind ${ JSON.stringify( resource.kind ) }`,
				`${ path }.kind`,
			) );
			const location = `binding|${ entry.group }|${ entry.binding }`;
			if ( renderBindingLocations.has( location ) ) errors.push( issue(
				'material-compute.render-binding.location-duplicate',
				`${ path } conflicts with another resource at the same render binding location`,
				path,
			) );
			renderBindingLocations.add( location );
			if ( ownerArtifact && isIndex( entry.group ) && isIndex( entry.binding ) ) {

				const descriptor = bindingDescriptorAt( ownerArtifact, entry.group, entry.binding );
				const ordered = orderedBindingAt( ownerArtifact, entry.group, entry.binding );
				if ( ! descriptor ) errors.push( issue( 'material-compute.render-binding.location', `${ path } does not identify a render binding`, `${ path }.binding` ) );
				else if ( entry.kind === 'storage-buffer' && ( descriptor.kind !== 'storage-buffer' || ! ordered || ordered.type !== 'storage-buffer' ) ) errors.push( issue(
					'material-compute.render-binding.descriptor-kind',
					`${ path } expected a storage-buffer descriptor, got ${ JSON.stringify( descriptor.kind ) }`,
					path,
				) );
				else if ( entry.kind === 'storage-texture' && ( descriptor.kind !== 'sampled-texture' || descriptor.store !== true ) ) errors.push( issue(
					'material-compute.render-binding.descriptor-kind',
					`${ path } expected a storage-texture descriptor`,
					path,
				) );
				else if ( entry.kind === 'storage-buffer' && resource && Number.isSafeInteger( descriptor.byteLength ) && descriptor.byteLength !== resource.byteLength ) errors.push( issue(
					'material-compute.render-binding.byte-length-mismatch',
					`${ path } resource byteLength must match the render binding descriptor`,
					path,
				) );
				if ( entry.kind === 'storage-buffer' && resource && ordered && ordered.ref ) for ( const field of [ 'arrayType', 'count', 'itemSize' ] ) {

					if ( ordered.ref[ field ] !== resource[ field ] ) errors.push( issue(
						`material-compute.render-binding.${ field }-mismatch`,
						`${ path } resource ${ field } must match the render uniform plan`,
						path,
					) );

				}

			}

		}

	}
	validateCanonicalOrder( renderBindings, renderBindingTuple, 'material-compute.render-binding', `${ root }.renderBindings`, errors );

	let previousOrder = - 1;
	const scheduleOrders = new Set();
	const scheduledKernels = new Set();
	let nextScheduledKernel = 0;
	for ( let index = 0; index < schedule.length; index ++ ) {

		const entry = schedule[ index ];
		const path = `${ root }.schedule[${ index }]`;
		if ( ! isRecord( entry ) ) {

			errors.push( issue( 'material-compute.schedule', `${ path } must be an object`, path ) );
			continue;

		}
		if ( ! kernelById.has( entry.kernel ) ) errors.push( issue( 'material-compute.schedule.kernel', `${ path }.kernel must reference a declared kernel`, `${ path }.kernel` ) );
		if ( entry.phase !== 'update-before' ) errors.push( issue( 'material-compute.schedule.phase', `${ path }.phase must be "update-before"`, `${ path }.phase` ) );
		if ( ! isIndex( entry.order ) ) errors.push( issue( 'material-compute.schedule.order', `${ path }.order must be a non-negative integer`, `${ path }.order` ) );
		else if ( entry.order <= previousOrder ) errors.push( issue( 'material-compute.schedule.order', `${ root }.schedule must preserve unique updateBeforeNodes order`, `${ path }.order` ) );
		if ( ! UPDATE_TYPE_SET.has( entry.updateType ) ) errors.push( issue(
			'material-compute.schedule.update-type',
			`${ path }.updateType must be one of ${ MATERIAL_COMPUTE_UPDATE_TYPES.join( ', ' ) }`,
			`${ path }.updateType`,
		) );
		if ( scheduleOrders.has( entry.order ) ) errors.push( issue( 'material-compute.schedule.duplicate', `${ path } duplicates an earlier update-before order`, path ) );
		scheduleOrders.add( entry.order );
		if ( kernelById.has( entry.kernel ) ) {

			if ( scheduledKernels.has( entry.kernel ) ) errors.push( issue(
				'material-compute.schedule.kernel-duplicate',
				`${ path }.kernel repeats a kernel already scheduled by Three's de-duplicated update-before list`,
				`${ path }.kernel`,
			) );
			else {

				const expectedKernel = `kernel:${ nextScheduledKernel ++ }`;
				if ( entry.kernel !== expectedKernel ) errors.push( issue(
					'material-compute.schedule.kernel-order',
					`${ path }.kernel must introduce ${ JSON.stringify( expectedKernel ) } before later kernels`,
					`${ path }.kernel`,
				) );
				scheduledKernels.add( entry.kernel );

			}

		}
		if ( isIndex( entry.order ) ) previousOrder = entry.order;

	}
	if ( schedule.length === 0 ) errors.push( issue(
		'material-compute.schedule.empty',
		`${ root }.schedule must contain at least one exact update-before entry`,
		`${ root }.schedule`,
	) );
	for ( const kernelId of kernelById.keys() ) {

		if ( ! scheduledKernels.has( kernelId ) ) errors.push( issue(
			'material-compute.kernel.unscheduled',
			`${ root } kernel ${ JSON.stringify( kernelId ) } is not present in the exact schedule`,
			`${ root }.schedule`,
		) );

	}
	if ( value.mode === 'precompiled' ) {

		const renderedResources = new Set( renderBindings.map( ( entry ) => entry && entry.resource ) );
		const exactUpdateBeforeCount = ownerArtifact && ownerArtifact.meta && ownerArtifact.meta.updateBeforeNodes;
		if ( ! Number.isSafeInteger( exactUpdateBeforeCount ) || exactUpdateBeforeCount !== schedule.length
			|| schedule.some( ( entry, index ) => ! entry || entry.order !== index ) ) errors.push( issue(
			'material-compute.mode.schedule-topology',
			`${ root }.mode must be "hybrid-required" unless the serialized schedule covers every update-before slot exactly`,
			`${ root }.mode`,
		) );
		for ( let kernelIndex = 0; kernelIndex < kernels.length; kernelIndex ++ ) {

			const kernel = kernels[ kernelIndex ];
			if ( kernel && kernel.artifact && hasUnresolvedLiveUniform( kernel.artifact ) ) errors.push( issue(
				'material-compute.mode.live-uniform',
				`${ root }.mode must be "hybrid-required" when ${ kernel.id } contains an unresolved live uniform`,
				`${ root }.mode`,
			) );
			if ( kernel && kernel.artifact && hasUnresolvedMaterialComputeTexture( kernel.artifact ) ) errors.push( issue(
				'material-compute.mode.texture-source',
				`${ root }.mode must be "hybrid-required" when ${ kernel.id } has no serializable sampled-texture source`,
				`${ root }.mode`,
			) );
			const groups = kernel && kernel.artifact && Array.isArray( kernel.artifact.bindings ) ? kernel.artifact.bindings : [];
			for ( let group = 0; group < groups.length; group ++ ) {

				const descriptors = Array.isArray( groups[ group ] && groups[ group ].bindings ) ? groups[ group ].bindings : [];
				for ( let binding = 0; binding < descriptors.length; binding ++ ) {

					const descriptor = descriptors[ binding ];
					const storage = descriptor && ( descriptor.kind === 'storage-buffer' || descriptor.kind === 'sampled-texture' && descriptor.store === true );
					if ( storage && ! computeBindingLocations.has( `${ kernel && kernel.id }|${ group }|${ binding }` ) ) errors.push( issue(
						'material-compute.mode.compute-binding',
						`${ root }.mode must be "hybrid-required" when ${ kernel && kernel.id } storage binding ${ group }:${ binding } has no exact resource ownership`,
						`${ root }.mode`,
					) );

				}

			}

		}
		for ( let index = 0; index < resources.length; index ++ ) {

			const resource = resources[ index ];
			if ( resource && resource.kind === 'storage-texture' ) errors.push( issue(
				'material-compute.mode.storage-texture',
				`${ root }.mode must be "hybrid-required" while storage-texture hydration is unsupported`,
				`${ root }.mode`,
			) );
			if ( resource && typeof resource.id === 'string' && ! renderedResources.has( resource.id ) ) errors.push( issue(
				'material-compute.mode.render-binding',
				`${ root }.mode must be "hybrid-required" when resource ${ JSON.stringify( resource.id ) } has no exact render binding`,
				`${ root }.mode`,
			) );
			if ( resource && typeof resource.id === 'string' && ! computeBoundResources.has( resource.id ) ) errors.push( issue(
				'material-compute.mode.compute-binding',
				`${ root }.mode must be "hybrid-required" when resource ${ JSON.stringify( resource.id ) } has no exact compute binding`,
				`${ root }.mode`,
			) );
			if ( resource && resource.kind === 'storage-buffer' && ! renderBindings.some( ( entry ) =>
				entry && entry.resource === resource.id && renderBindingProvidesInitialState( ownerArtifact, entry, resource )
			) ) errors.push( issue(
				'material-compute.mode.initial-state',
				`${ root }.mode must be "hybrid-required" when resource ${ JSON.stringify( resource.id ) } has no serialized initial-state proof`,
				`${ root }.mode`,
			) );

		}

	}

	return Object.freeze( errors );

}
