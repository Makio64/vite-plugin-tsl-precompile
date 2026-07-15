import { stableJsonStringify } from '@tsl-precompile/contract/stable-json';
import StorageBufferAttribute from 'three/src/renderers/common/StorageBufferAttribute.js';
import StorageInstancedBufferAttribute from 'three/src/renderers/common/StorageInstancedBufferAttribute.js';

import PrecompiledComputeNode from '../precompiled-compute-node.js';
import { resolveTypedArrayCtor } from './typed-arrays.js';
import { createHydrationBindingArtifactView } from './user-attributes.js';
import {
	consumeMaterialComputeDelegation,
	hasMaterialComputeDelegation,
	inspectRuntimeMaterialComputeFamily,
	materialComputeDelegationReference,
	resolveMaterialComputePath,
} from './material-compute-ownership.js';

const controllersByMaterial = new WeakMap();
const hybridGuardsByMaterial = new WeakMap();

export class MaterialComputeHydrationError extends Error {

	constructor( code, message, details = {} ) {

		super( message );
		this.name = 'MaterialComputeHydrationError';
		this.code = code;
		this.details = details;
		this.tslPrecompileMaterialCompute = true;

	}

}

function fail( code, message, details = {} ) {

	throw new MaterialComputeHydrationError( code, message, details );

}

function controllerCacheFor( material ) {

	let cache = controllersByMaterial.get( material );
	if ( ! cache ) {

		cache = new WeakMap();
		controllersByMaterial.set( material, cache );

	}
	return cache;

}

function hybridGuardCacheFor( material ) {

	let cache = hybridGuardsByMaterial.get( material );
	if ( ! cache ) {

		cache = new WeakMap();
		hybridGuardsByMaterial.set( material, cache );

	}
	return cache;

}

function renderBindingRecord( artifact, binding ) {

	if ( binding.kind === 'attribute' ) {

		const attributes = Array.isArray( artifact.attributes ) ? artifact.attributes : artifact.nodeAttributes;
		return Array.isArray( attributes ) ? attributes[ binding.attribute ] || null : null;

	}
	const group = Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan[ binding.group ] : null;
	const ordered = group && Array.isArray( group.orderedBindings ) ? group.orderedBindings[ binding.binding ] : null;
	return ordered && ordered.ref || null;

}

function kernelBindingRecord( artifact, binding ) {

	const group = Array.isArray( artifact && artifact.uniformPlan ) ? artifact.uniformPlan[ binding.group ] : null;
	const ordered = group && Array.isArray( group.orderedBindings ) ? group.orderedBindings[ binding.binding ] : null;
	return ordered && ordered.type === 'storage-buffer' ? ordered.ref || null : null;

}

function isExactUserPath( record ) {

	return Array.isArray( record && record.userPath ) && record.userPath.length > 1;

}

function isStorageAttribute( attribute ) {

	return !! attribute
		&& ( attribute.isStorageBufferAttribute === true || attribute.isStorageInstancedBufferAttribute === true )
		&& attribute.array
		&& ArrayBuffer.isView( attribute.array );

}

function attributeMatchesResource( attribute, resource ) {

	return isStorageAttribute( attribute )
		&& attribute.count === resource.count
		&& attribute.itemSize === resource.itemSize
		&& attribute.array.constructor && attribute.array.constructor.name === resource.arrayType
		&& attribute.array.byteLength === resource.byteLength;

}

function defineAttributeSidecar( record, attribute ) {

	if ( ! record ) return;
	Object.defineProperty( record, '_liveAttribute', {
		value: attribute,
		enumerable: false,
		configurable: true,
		writable: true,
	} );
	Object.defineProperty( record, '_liveAttributeSource', {
		value: 'material-compute-contract',
		enumerable: false,
		configurable: true,
		writable: true,
	} );

}

function snapshotKey( snapshot ) {

	try {

		return stableJsonStringify( snapshot, 'materialComputeResourceSnapshot' );

	} catch ( _ ) {

		return null;

	}

}

function createResourceAttribute( resource, bindings, artifact ) {

	const exactAttributes = [];
	const snapshots = new Map();
	let instanced = null;
	let attributeMetadata = null;
	for ( const binding of bindings ) {

		const record = renderBindingRecord( artifact, binding );
		if ( ! record ) fail(
			'TSLP_MATERIAL_COMPUTE_RENDER_BINDING_MISSING',
			`[tsl-precompile/slim] Material compute ${ binding.resource } does not resolve its serialized render binding.`,
			{ binding },
		);
		if ( binding.kind === 'attribute' ) {

			const nextInstanced = record.instanced === true;
			if ( instanced !== null && instanced !== nextInstanced ) fail(
				'TSLP_MATERIAL_COMPUTE_RESOURCE_CONFLICT',
				`[tsl-precompile/slim] Material compute ${ binding.resource } mixes instanced and non-instanced render attributes.`,
				{ binding },
			);
			instanced = nextInstanced;
			attributeMetadata ||= record;

		}
		if ( isExactUserPath( record ) ) {

			if ( record._liveAttributeSource !== 'userPath-exact' || ! attributeMatchesResource( record._liveAttribute, resource ) ) fail(
				'TSLP_MATERIAL_COMPUTE_EXACT_PATH_MISS',
				`[tsl-precompile/slim] Exact material-compute path ${ JSON.stringify( record.userPath ) } did not resolve ${ binding.resource }.`,
				{ binding, userPath: record.userPath },
			);
			if ( ! exactAttributes.includes( record._liveAttribute ) ) exactAttributes.push( record._liveAttribute );

		}
		if ( Array.isArray( record.arraySnapshot ) ) {

			const key = snapshotKey( record.arraySnapshot );
			if ( key === null ) fail(
				'TSLP_MATERIAL_COMPUTE_RESOURCE_UNRESOLVED',
				`[tsl-precompile/slim] Material compute ${ binding.resource } has an invalid serialized array snapshot.`,
				{ binding },
			);
			snapshots.set( key, record.arraySnapshot );

		}

	}
	if ( exactAttributes.length > 1 ) fail(
		'TSLP_MATERIAL_COMPUTE_RESOURCE_CONFLICT',
		`[tsl-precompile/slim] Exact paths for ${ resource.id } resolve different storage attributes.`,
		{ resource },
	);
	if ( exactAttributes.length === 1 ) return exactAttributes[ 0 ];
	if ( snapshots.size !== 1 ) fail(
		'TSLP_MATERIAL_COMPUTE_RESOURCE_UNRESOLVED',
		`[tsl-precompile/slim] Material compute ${ resource.id } requires one exact serialized initial-state snapshot.`,
		{ resource, snapshotCount: snapshots.size },
	);
	const snapshot = snapshots.values().next().value;
	if ( snapshot.length !== resource.count * resource.itemSize ) fail(
		'TSLP_MATERIAL_COMPUTE_RESOURCE_UNRESOLVED',
		`[tsl-precompile/slim] Material compute ${ resource.id } snapshot length does not match its resource metadata.`,
		{ resource, snapshotLength: snapshot.length },
	);
	const TypedArray = resolveTypedArrayCtor( resource.arrayType );
	const Attribute = instanced === true ? StorageInstancedBufferAttribute : StorageBufferAttribute;
	const attribute = new Attribute( resource.count, resource.itemSize, TypedArray );
	attribute.array.set( snapshot );
	if ( attributeMetadata && typeof attributeMetadata.usage === 'number' && typeof attribute.setUsage === 'function' ) attribute.setUsage( attributeMetadata.usage );
	if ( attributeMetadata && attributeMetadata.normalized === true ) attribute.normalized = true;
	if ( attributeMetadata && typeof attributeMetadata.meshPerAttribute === 'number' ) attribute.meshPerAttribute = attributeMetadata.meshPerAttribute;
	attribute.needsUpdate = true;
	return attribute;

}

function collectRenderBindingsByResource( descriptor ) {

	const byResource = new Map();
	for ( const binding of descriptor.renderBindings ) {

		let bindings = byResource.get( binding.resource );
		if ( ! bindings ) byResource.set( binding.resource, bindings = [] );
		bindings.push( binding );

	}
	return byResource;

}

const KERNEL_LIFECYCLE = Object.freeze( {
	update: Object.freeze( { list: '_liveUpdateNodes', typeMethod: 'getUpdateType', updateMethod: 'update' } ),
	'update-before': Object.freeze( { list: '_liveUpdateBeforeNodes', typeMethod: 'getUpdateBeforeType', updateMethod: 'updateBefore' } ),
	'update-after': Object.freeze( { list: '_liveUpdateAfterNodes', typeMethod: 'getUpdateAfterType', updateMethod: 'updateAfter' } ),
} );

function attachExactKernelLiveUniforms( artifact, graphMaterial, kernelRecord ) {

	for ( const group of Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [] ) {

		for ( const slot of group && Array.isArray( group.slots ) ? group.slots : [] ) {

			const source = slot && slot.source;
			if ( ! source || source.kind !== 'uniform.live' ) continue;
			const node = resolveMaterialComputePath( graphMaterial, source.nodePath );
			if ( ! node ) fail(
				'TSLP_MATERIAL_COMPUTE_LIVE_UNIFORM_MISS',
				`[tsl-precompile/slim] ${ kernelRecord.id } could not resolve exact live uniform path ${ JSON.stringify( source.nodePath ) }.`,
				{ kernelId: kernelRecord.id, nodePath: source.nodePath },
			);
			Object.defineProperty( slot, '_liveNode', {
				value: node,
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
		}

	}
	const scheduled = {
		_liveUpdateNodes: [],
		_liveUpdateBeforeNodes: [],
		_liveUpdateAfterNodes: [],
	};
	for ( const entry of Array.isArray( kernelRecord.updates ) ? kernelRecord.updates : [] ) {

		const config = KERNEL_LIFECYCLE[ entry.phase ];
		const node = resolveMaterialComputePath( graphMaterial, entry.nodePath );
		let updateType = null;
		try { updateType = node && config && typeof node[ config.typeMethod ] === 'function' ? node[ config.typeMethod ]() : null; } catch ( _ ) {}
		if ( ! config || ! node || typeof node.updateReference !== 'function' || typeof node[ config.updateMethod ] !== 'function' || updateType !== entry.updateType ) fail(
			'TSLP_MATERIAL_COMPUTE_LIFECYCLE_MISS',
			`[tsl-precompile/slim] ${ kernelRecord.id } could not reconstruct ${ entry.phase } lifecycle ${ entry.order } from ${ JSON.stringify( entry.nodePath ) }.`,
			{ kernelId: kernelRecord.id, entry, updateType },
		);
		scheduled[ config.list ].push( node );

	}
	artifact._liveUpdateNodes = scheduled._liveUpdateNodes;
	artifact._liveUpdateBeforeNodes = scheduled._liveUpdateBeforeNodes;
	artifact._liveUpdateAfterNodes = scheduled._liveUpdateAfterNodes;

}

function createScheduleAdapter( kernel, updateType ) {

	const reference = {};
	return {
		getUpdateBeforeType() {

			return updateType;

		},
		updateReference() {

			return reference;

		},
		updateBefore( frame ) {

			const renderer = frame && frame.renderer;
			if ( ! renderer || typeof renderer.compute !== 'function' ) fail(
				'TSLP_MATERIAL_COMPUTE_RENDERER_UNAVAILABLE',
				'[tsl-precompile/slim] Scheduled material compute requires renderer.compute().',
				{ kernel: kernel.name || '' },
			);
			Object.defineProperty( kernel, '__tslpMaterialComputeFrame', {
				value: frame,
				enumerable: false,
				configurable: true,
				writable: true,
			} );
			let result;
			try {

				result = renderer.compute( kernel );

			} finally {

				kernel.__tslpMaterialComputeFrame = null;

			}
			if ( result && typeof result.then === 'function' ) fail(
				'TSLP_MATERIAL_COMPUTE_ASYNC_DISPATCH',
				'[tsl-precompile/slim] update-before material compute must dispatch synchronously; renderer.compute() returned a Promise.',
				{ kernel: kernel.name || '' },
			);
			return result;

		},
	};

}

function createController( descriptor, artifact, graphMaterial, material ) {

	const renderBindings = collectRenderBindingsByResource( descriptor );
	const resources = new Map();
	for ( const resource of descriptor.resources ) {

		if ( resource.kind !== 'storage-buffer' ) fail(
			'TSLP_MATERIAL_COMPUTE_RESOURCE_UNSUPPORTED',
			`[tsl-precompile/slim] Compiler-free material compute does not support ${ resource.kind }.`,
			{ resource },
		);
		resources.set( resource.id, createResourceAttribute( resource, renderBindings.get( resource.id ) || [], artifact ) );

	}

	const kernels = new Map();
	for ( const kernelRecord of descriptor.kernels ) {

		const nested = createHydrationBindingArtifactView( kernelRecord.artifact, { resetLiveNodeSidecars: true } );
		attachExactKernelLiveUniforms( nested, graphMaterial, kernelRecord );
		const node = new PrecompiledComputeNode( nested );
		Object.defineProperties( node, {
			__tslpMaterialComputeOwner: { value: material, enumerable: false, configurable: true },
			__tslpMaterialComputeRootArtifact: { value: artifact, enumerable: false, configurable: true },
		} );
		kernels.set( kernelRecord.id, { node, artifact: nested } );

	}
	for ( const binding of descriptor.bindings ) {

		const kernel = kernels.get( binding.kernel );
		const resource = resources.get( binding.resource );
		const record = kernel && kernelBindingRecord( kernel.artifact, binding );
		if ( ! kernel || ! resource || ! record ) fail(
			'TSLP_MATERIAL_COMPUTE_KERNEL_BINDING_MISSING',
			`[tsl-precompile/slim] Material compute ${ binding.kernel } cannot bind ${ binding.resource } at ${ binding.group }:${ binding.binding }.`,
			{ binding },
		);
		defineAttributeSidecar( record, resource );

	}
	const schedule = descriptor.schedule.map( ( entry ) => {

		const kernel = kernels.get( entry.kernel );
		if ( ! kernel ) fail(
			'TSLP_MATERIAL_COMPUTE_SCHEDULE_MISSING',
			`[tsl-precompile/slim] Material compute schedule references missing ${ entry.kernel }.`,
			{ entry },
		);
		return createScheduleAdapter( kernel.node, entry.updateType );

	} );
	return { descriptor, resources, kernels, schedule };

}

function stampRenderResources( controller, artifact ) {

	for ( const binding of controller.descriptor.renderBindings ) {

		const record = renderBindingRecord( artifact, binding );
		const resource = controller.resources.get( binding.resource );
		if ( ! record || ! resource ) fail(
			'TSLP_MATERIAL_COMPUTE_RENDER_BINDING_MISSING',
			`[tsl-precompile/slim] Material compute ${ binding.resource } cannot be attached to its selected render variant.`,
			{ binding },
		);
		if ( isExactUserPath( record ) ) {

			if ( record._liveAttributeSource !== 'userPath-exact' || record._liveAttribute !== resource ) fail(
				'TSLP_MATERIAL_COMPUTE_RESOURCE_CONFLICT',
				`[tsl-precompile/slim] Selected variant resolves ${ binding.resource } to a different exact storage attribute.`,
				{ binding },
			);

		}
		defineAttributeSidecar( record, resource );

	}

}

function removeRawComputeSidecars( artifact ) {

	if ( ! Array.isArray( artifact._liveUpdateBeforeNodes ) ) return;
	artifact._liveUpdateBeforeNodes = artifact._liveUpdateBeforeNodes.filter( ( node ) => ! node || node.isComputeNode !== true || node.isPrecompiledCompute === true );

}

function createHybridDelegationGuard( material, rootArtifact, inspection ) {

	const cadences = new Set( inspection.descriptor.schedule.map( ( entry ) => entry.updateType ) );
	if ( cadences.size !== 1 ) fail(
		'TSLP_MATERIAL_COMPUTE_MIXED_CADENCE_UNSUPPORTED',
		'[tsl-precompile/slim] Hybrid material compute requires one uniform update cadence per delegated transaction.',
		{ cadences: [ ...cadences ] },
	);
	const updateType = cadences.values().next().value;
	return {
		getUpdateBeforeType() { return updateType; },
		updateReference( frame ) {

			const record = materialComputeDelegationReference( material, rootArtifact, inspection.fingerprint );
			if ( ! record || record.consumed === true && updateType !== 'object' ) {

				const stamp = updateType === 'frame' ? 'frameId' : 'renderId';
				if ( ! record
					|| record.consumedType !== updateType
					|| record.consumedStamp !== frame?.[ stamp ]
					|| record.consumedFrame !== frame ) return {};

			}
			return record;

		},
		updateBefore( frame ) {

			if ( ! consumeMaterialComputeDelegation( material, rootArtifact, inspection.fingerprint, updateType, frame ) ) fail(
				'TSLP_MATERIAL_COMPUTE_HYBRID_REQUIRED',
				`[tsl-precompile/slim] Material compute delegation is missing or was already consumed: ${ inspection.descriptor.reasons.join( ', ' ) }. Dispatch and synchronize it again before the next render.`,
				{ reasons: inspection.descriptor.reasons.slice() },
			);

		},
	};

}

/** Hydrate one material-global compute ownership contract into replay nodes. */
export function hydrateMaterialCompute( rootArtifact, artifact, material, graphMaterial = material ) {

	const inspection = inspectRuntimeMaterialComputeFamily( rootArtifact );
	if ( inspection.status === 'none' ) return [];
	if ( ! material ) fail(
		'TSLP_MATERIAL_COMPUTE_OWNER_REQUIRED',
		'[tsl-precompile/slim] A material-owned compute contract requires its runtime material owner.',
	);
	const descriptor = inspection.descriptor;
	if ( ! artifact || ! artifact.materialCompute ) fail(
		'TSLP_MATERIAL_COMPUTE_VARIANT_DIVERGENCE',
		'[tsl-precompile/slim] The selected render variant omitted its material-compute contract.',
	);
	if ( descriptor.mode === 'hybrid-required' ) {

		if ( ! hasMaterialComputeDelegation( material, rootArtifact, inspection.fingerprint ) ) fail(
			'TSLP_MATERIAL_COMPUTE_HYBRID_REQUIRED',
			`[tsl-precompile/slim] Material compute requires explicit full-renderer delegation: ${ descriptor.reasons.join( ', ' ) }. Call await support.dispatchMaterialComputes(scene) before rendering.`,
			{ reasons: descriptor.reasons.slice() },
		);
		const cache = hybridGuardCacheFor( material );
		let cached = cache.get( rootArtifact );
		if ( ! cached || cached.fingerprint !== inspection.fingerprint ) {

			cached = {
				fingerprint: inspection.fingerprint,
				guard: createHybridDelegationGuard( material, rootArtifact, inspection ),
			};
			cache.set( rootArtifact, cached );

		}
		removeRawComputeSidecars( artifact );
		return [ cached.guard ];

	}
	if ( descriptor.mode !== 'precompiled' ) fail(
		'TSLP_MATERIAL_COMPUTE_MODE_UNSUPPORTED',
		`[tsl-precompile/slim] Unsupported material-compute mode ${ JSON.stringify( descriptor.mode ) }.`,
	);
	const cache = controllerCacheFor( material );
	let controller = cache.get( rootArtifact );
	if ( ! controller ) {

		controller = createController( descriptor, artifact, graphMaterial, material );
		cache.set( rootArtifact, controller );

	}
	stampRenderResources( controller, artifact );
	removeRawComputeSidecars( artifact );
	return controller.schedule;

}
