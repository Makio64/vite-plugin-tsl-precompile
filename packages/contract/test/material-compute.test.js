import assert from 'node:assert/strict';
import test from 'node:test';

import {
	MATERIAL_COMPUTE_DEFERRED_NODES_PROPERTY,
	MATERIAL_COMPUTE_VERSION,
	attachDeferredMaterialComputeNodes,
	findMaterialComputeNodePath,
	hasUnresolvedMaterialComputeTexture,
	inspectMaterialComputeFamily,
	isSerializableMaterialComputeTextureSource,
	validateMaterialComputeDescriptor,
} from '@tsl-precompile/contract/material-compute';

// Material-global compute is the part of the contract that decides whether a
// captured artifact can be replayed without the compiler at all. Every check
// here is fail-closed by design: when the validator cannot *prove* a descriptor
// is replayable it must say so, because the failure mode of guessing wrong is a
// scene that renders with stale compute state and no error anywhere.

// One fully-serialized compute kernel. In precompiled mode the kernel's own
// `updates` list must account for every lifecycle node its artifact declares,
// so the zero counts in `meta` are what make an empty `updates` list legal.
function kernel( index ) {

	return {
		id: `kernel:${ index }`,
		nodePath: [ 'colorNode' ],
		artifact: {
			kind: 'compute',
			cacheKey: index + 1,
			computeShader: '@compute fn main() {}',
			bindings: [],
			uniformPlan: [],
			dispatchSize: 64,
			workgroupSize: [ 64, 1, 1 ],
			meta: { updateNodes: 0, updateBeforeNodes: 0, updateAfterNodes: 0 },
		},
		updates: [],
	};

}

// A descriptor the validator accepts end to end: one kernel, carrying its own
// compute artifact, scheduled into the single update-before slot the owning
// artifact declares. `precompiled` mode only holds when the schedule covers
// every slot exactly, so the owner's `meta.updateBeforeNodes` has to agree.
function descriptor( overrides = {} ) {

	return {
		version: MATERIAL_COMPUTE_VERSION,
		mode: 'precompiled',
		resources: [],
		kernels: [ kernel( 0 ) ],
		bindings: [],
		renderBindings: [],
		schedule: [ { kernel: 'kernel:0', phase: 'update-before', order: 0, updateType: 'frame' } ],
		reasons: [],
		...overrides,
	};

}

// Owning artifact that declares exactly the one update-before slot the fixture
// schedule fills.
const OWNER = Object.freeze( { artifact: { meta: { updateBeforeNodes: 1 } } } );

function codes( issues ) {

	return issues.map( ( item ) => item.code );

}

test( 'a non-object descriptor fails immediately with one typed issue', () => {

	for ( const value of [ null, 'x', 7, [] ] ) {

		const issues = validateMaterialComputeDescriptor( value );
		assert.deepEqual( codes( issues ), [ 'material-compute.type' ], `${ JSON.stringify( value ) } must fail as a type error` );
		assert.equal( issues[ 0 ].path, 'materialCompute' );

	}

} );

test( 'the returned issue list is frozen so a caller cannot edit findings away', () => {

	const issues = validateMaterialComputeDescriptor( null );
	assert.throws( () => issues.push( {} ), TypeError );

} );

test( 'a complete precompiled descriptor validates clean', () => {

	assert.deepEqual( validateMaterialComputeDescriptor( descriptor(), OWNER ), [] );

} );

test( 'precompiled mode requires the schedule to cover every update-before slot exactly', () => {

	assert.ok(
		codes( validateMaterialComputeDescriptor( descriptor(), { artifact: { meta: { updateBeforeNodes: 2 } } } ) )
			.includes( 'material-compute.mode.schedule-topology' ),
		'a schedule that skips a slot cannot claim to be fully precompiled',
	);
	assert.ok(
		codes( validateMaterialComputeDescriptor( descriptor(), {} ) ).includes( 'material-compute.mode.schedule-topology' ),
		'with no declared slot count there is no proof of coverage',
	);
	assert.ok(
		codes( validateMaterialComputeDescriptor( descriptor( { schedule: [] } ), OWNER ) ).includes( 'material-compute.schedule.empty' ),
	);

} );

test( 'a declared kernel that never runs is rejected', () => {

	const issues = validateMaterialComputeDescriptor( descriptor( { schedule: [ { kernel: 'kernel:0', phase: 'update-before', order: 0 } ], kernels: [
		...descriptor().kernels,
		kernel( 1 ),
	] } ), OWNER );
	assert.ok( codes( issues ).includes( 'material-compute.kernel.unscheduled' ) );

} );

test( 'a null kernel artifact is allowed only when the mode admits the compiler', () => {

	const nullArtifact = descriptor().kernels.map( ( kernel ) => ( { ...kernel, artifact: null } ) );
	assert.ok(
		codes( validateMaterialComputeDescriptor( descriptor( { kernels: nullArtifact } ), OWNER ) ).includes( 'material-compute.kernel.artifact' ),
		'precompiled mode with no compute artifact has nothing to replay',
	);
	assert.ok(
		! codes( validateMaterialComputeDescriptor(
			descriptor( { kernels: nullArtifact, mode: 'hybrid-required', reasons: [ 'closure-hidden-compute' ] } ),
			OWNER,
		) ).includes( 'material-compute.kernel.artifact' ),
	);

} );

test( 'a kernel artifact must be a real compute artifact routed under its own cache key', () => {

	const broken = ( artifact ) => codes( validateMaterialComputeDescriptor(
		descriptor( { kernels: descriptor().kernels.map( ( kernel ) => ( { ...kernel, artifact } ) ) } ),
		OWNER,
	) );
	assert.ok( broken( { kind: 'render', cacheKey: 1, computeShader: 'x', bindings: [], uniformPlan: [] } ).includes( 'material-compute.kernel.kind' ) );
	assert.ok( broken( { kind: 'compute', cacheKey: 1, computeShader: '  ', bindings: [], uniformPlan: [] } ).includes( 'material-compute.kernel.shader' ) );
	assert.ok( broken( { kind: 'compute', cacheKey: 1, computeShader: 'x', bindings: null, uniformPlan: [] } ).includes( 'material-compute.kernel.bindings' ) );
	assert.ok( broken( { kind: 'compute', cacheKey: 99, computeShader: 'x', bindings: [], uniformPlan: [] } ).includes( 'material-compute.kernel.cache-key' ) );

} );

test( 'schedule order must be unique and monotonic', () => {

	const twoKernels = [
		...descriptor().kernels,
		kernel( 1 ),
	];
	const issues = validateMaterialComputeDescriptor( descriptor( {
		kernels: twoKernels,
		schedule: [
			{ kernel: 'kernel:0', phase: 'update-before', order: 0 },
			{ kernel: 'kernel:1', phase: 'update-before', order: 0, updateType: 'frame' },
		],
	} ), { artifact: { meta: { updateBeforeNodes: 2 } } } );
	assert.ok( codes( issues ).includes( 'material-compute.schedule.duplicate' ) );

} );

test( 'a schedule entry must reference a declared kernel and the update-before phase', () => {

	const unknown = validateMaterialComputeDescriptor( descriptor( {
		schedule: [ { kernel: 'kernel:9', phase: 'update-before', order: 0, updateType: 'frame' } ],
	} ), OWNER );
	assert.ok( codes( unknown ).includes( 'material-compute.schedule.kernel' ) );

	const wrongPhase = validateMaterialComputeDescriptor( descriptor( {
		schedule: [ { kernel: 'kernel:0', phase: 'update-after', order: 0, updateType: 'frame' } ],
	} ), OWNER );
	assert.ok( codes( wrongPhase ).includes( 'material-compute.schedule.phase' ) );

} );

test( 'issue paths are rooted at the caller-supplied path so the artifact validator can forward them', () => {

	const issues = validateMaterialComputeDescriptor( 'nope', { path: 'variants.k1.materialCompute' } );
	assert.equal( issues[ 0 ].path, 'variants.k1.materialCompute' );

} );

test( 'an unversioned or wrongly-versioned descriptor fails closed', () => {

	assert.ok( codes( validateMaterialComputeDescriptor( descriptor( { version: 'material-compute@0' } ) ) ).includes( 'material-compute.version' ) );
	assert.ok( codes( validateMaterialComputeDescriptor( descriptor( { version: undefined } ) ) ).includes( 'material-compute.version' ) );

} );

test( 'an unknown mode is rejected rather than treated as precompiled', () => {

	assert.ok( codes( validateMaterialComputeDescriptor( descriptor( { mode: 'maybe' } ) ) ).includes( 'material-compute.mode' ) );

} );

test( 'every collection field must actually be an array', () => {

	for ( const field of [ 'resources', 'kernels', 'bindings', 'renderBindings', 'schedule', 'reasons' ] ) {

		const issues = validateMaterialComputeDescriptor( descriptor( { [ field ]: {} } ) );
		assert.ok( issues.length > 0, `${ field } must be validated as an array` );
		assert.ok( issues.some( ( item ) => item.path.includes( field ) ), `${ field } must be named in the issue path` );

	}

} );

test( 'hybrid-required mode must explain itself and precompiled mode must not', () => {

	assert.ok(
		codes( validateMaterialComputeDescriptor( descriptor( { mode: 'hybrid-required' } ), OWNER ) ).includes( 'material-compute.reason.mode' ),
		'a hybrid fallback with no stated reason is unreviewable',
	);
	assert.ok(
		codes( validateMaterialComputeDescriptor( descriptor( { reasons: [ 'why' ] } ), OWNER ) ).includes( 'material-compute.reason.mode' ),
		'a precompiled descriptor that carries reasons is self-contradictory',
	);
	assert.deepEqual(
		validateMaterialComputeDescriptor( descriptor( { mode: 'hybrid-required', reasons: [ 'closure-hidden-compute' ] } ), OWNER ),
		[],
	);

} );

test( 'reasons must be canonically sorted and free of duplicates', () => {

	assert.ok( codes( validateMaterialComputeDescriptor( descriptor( {
		mode: 'hybrid-required',
		reasons: [ 'b', 'a' ],
	} ) ) ).includes( 'material-compute.reason.order' ), 'unsorted reasons make two equal descriptors fingerprint differently' );

	assert.ok( codes( validateMaterialComputeDescriptor( descriptor( {
		mode: 'hybrid-required',
		reasons: [ 'a', 'a' ],
	} ) ) ).includes( 'material-compute.reason.duplicate' ) );

	assert.ok( codes( validateMaterialComputeDescriptor( descriptor( {
		mode: 'hybrid-required',
		reasons: [ '' ],
	} ) ) ).includes( 'material-compute.reason' ) );

} );

test( 'resource ids are positional so a reordered list cannot silently rebind', () => {

	const issues = validateMaterialComputeDescriptor( descriptor( {
		resources: [ { id: 'resource:1', kind: 'storage-buffer' } ],
	} ) );
	assert.ok( codes( issues ).includes( 'material-compute.resource.id' ) );

} );

test( 'an unknown resource kind is rejected', () => {

	const issues = validateMaterialComputeDescriptor( descriptor( {
		resources: [ { id: 'resource:0', kind: 'quantum-buffer' } ],
	} ) );
	assert.ok( codes( issues ).includes( 'material-compute.resource.kind' ) );

} );

test( 'kernel ids are positional and precompiled mode requires an exact node path', () => {

	const wrongId = validateMaterialComputeDescriptor( descriptor( {
		kernels: [ { id: 'kernel:7', nodePath: [ 'colorNode' ], artifact: null } ],
	} ) );
	assert.ok( codes( wrongId ).includes( 'material-compute.kernel.id' ) );

	const noPath = validateMaterialComputeDescriptor( descriptor( {
		kernels: [ { id: 'kernel:0', nodePath: null, artifact: null } ],
	} ) );
	assert.ok(
		codes( noPath ).includes( 'material-compute.mode.kernel-node-path' ),
		'without a path the runtime cannot find the node to replace',
	);

} );

test( 'a texture source is serializable only when it can be rebuilt without the capture process', () => {

	assert.equal( isSerializableMaterialComputeTextureSource( null, { kind: 'builtin.dfgLUT' } ), true );
	assert.equal( isSerializableMaterialComputeTextureSource( {}, { kind: 'builtin.ltcTexture' } ), false, 'LTC needs its tables committed' );
	assert.equal( isSerializableMaterialComputeTextureSource( { ltcTextures: [] }, { kind: 'builtin.ltcTexture' } ), true );

	const complete = { kind: 'artifact.texture', snapshot: { width: 2, height: 2, data: [ 0, 0, 0, 0 ] } };
	assert.equal( isSerializableMaterialComputeTextureSource( {}, complete ), true );

	for ( const snapshot of [
		{ width: 0, height: 2, data: [] },
		{ width: 2, height: 0, data: [] },
		{ width: 2, height: 2 },
		{ width: 2.5, height: 2, data: [] },
	] ) {

		assert.equal(
			isSerializableMaterialComputeTextureSource( {}, { kind: 'artifact.texture', snapshot } ),
			false,
			`${ JSON.stringify( snapshot ) } must not be treated as replayable`,
		);

	}

	assert.equal( isSerializableMaterialComputeTextureSource( {}, null ), false );

} );

test( 'a sampled texture with no serializable source is reported as unresolved', () => {

	const artifact = {
		bindings: [ { bindings: [ { kind: 'sampled-texture' } ] } ],
		uniformPlan: [ { orderedBindings: [ { ref: { source: { kind: 'artifact.texture' } } } ] } ],
	};
	assert.equal( hasUnresolvedMaterialComputeTexture( artifact ), true );

	artifact.uniformPlan[ 0 ].orderedBindings[ 0 ].ref.source.snapshot = { width: 1, height: 1, data: [ 0 ] };
	assert.equal( hasUnresolvedMaterialComputeTexture( artifact ), false );

} );

test( 'a storage-texture write target is not treated as an unresolved read', () => {

	const artifact = {
		bindings: [ { bindings: [ { kind: 'sampled-texture', store: true } ] } ],
		uniformPlan: [ { orderedBindings: [ {} ] } ],
	};
	assert.equal( hasUnresolvedMaterialComputeTexture( artifact ), false );

} );

test( 'an artifact with no bindings has nothing unresolved', () => {

	assert.equal( hasUnresolvedMaterialComputeTexture( null ), false );
	assert.equal( hasUnresolvedMaterialComputeTexture( {} ), false );

} );

test( 'a family with no compute descriptor reports none rather than guessing', () => {

	const result = inspectMaterialComputeFamily( { cacheKey: 'k' } );
	assert.equal( result.status, 'none' );
	assert.equal( result.descriptor, null );

} );

test( 'a family where only some variants carry compute fails closed as partial', () => {

	const result = inspectMaterialComputeFamily( {
		cacheKey: 'k1',
		variants: {
			k1: { cacheKey: 'k1', materialCompute: descriptor() },
			k2: { cacheKey: 'k2' },
		},
	} );
	assert.equal( result.status, 'divergent' );
	assert.equal( result.reason, 'partial-family' );

} );

test( 'a family whose variants carry different descriptors cannot share one controller', () => {

	const result = inspectMaterialComputeFamily( {
		cacheKey: 'k1',
		variants: {
			k1: { cacheKey: 'k1', materialCompute: descriptor() },
			k2: { cacheKey: 'k2', materialCompute: descriptor( { mode: 'hybrid-required', reasons: [ 'x' ] } ) },
		},
	} );
	assert.equal( result.status, 'divergent' );
	assert.equal( result.reason, 'non-uniform-family' );

} );

test( 'a uniform family reports one shared descriptor and a stable fingerprint', () => {

	const build = () => ( {
		cacheKey: 'k1',
		variants: {
			k1: { cacheKey: 'k1', materialCompute: descriptor() },
			k2: { cacheKey: 'k2', materialCompute: descriptor() },
		},
	} );
	const first = inspectMaterialComputeFamily( build() );
	const second = inspectMaterialComputeFamily( build() );
	assert.equal( first.status, 'uniform' );
	assert.equal( first.candidateCount, 2 );
	assert.equal( first.fingerprint, second.fingerprint, 'the fingerprint must not depend on process identity' );
	assert.ok( Object.isFrozen( first ) );

} );

test( 'an unfingerprintable family fails closed instead of throwing at the caller', () => {

	const cyclic = descriptor();
	cyclic.self = cyclic;
	const result = inspectMaterialComputeFamily( { cacheKey: 'k', materialCompute: cyclic } );
	assert.equal( result.status, 'divergent' );
	assert.equal( result.reason, 'unfingerprintable-family' );

} );

test( 'a compute node reachable from a material root resolves to its exact path', () => {

	const target = { isComputeNode: true };
	const material = { colorNode: { child: { deeper: target } } };
	assert.deepEqual( findMaterialComputeNodePath( material, target ), [ 'colorNode', 'child', 'deeper' ] );

} );

test( 'an unreachable compute node returns null so extraction fails closed', () => {

	assert.equal( findMaterialComputeNodePath( { colorNode: {} }, { isComputeNode: true } ), null );
	assert.equal( findMaterialComputeNodePath( null, {} ), null );
	assert.equal( findMaterialComputeNodePath( {}, null ), null );

} );

test( 'path search survives a cyclic graph', () => {

	const target = { isComputeNode: true };
	const loop = { name: 'loop' };
	loop.self = loop;
	loop.found = target;
	assert.deepEqual( findMaterialComputeNodePath( { colorNode: loop }, target ), [ 'colorNode', 'found' ] );

} );

test( 'deferred compute nodes are published once, in order, on a non-enumerable slot', () => {

	const root = {};
	const first = { isComputeNode: true };
	const second = { isComputeNode: true };
	assert.deepEqual( attachDeferredMaterialComputeNodes( root, [ first, second ] ), [ first, second ] );
	attachDeferredMaterialComputeNodes( root, [ first ] );
	assert.deepEqual( root[ MATERIAL_COMPUTE_DEFERRED_NODES_PROPERTY ], [ first, second ], 'republishing must not duplicate' );
	assert.ok( ! Object.keys( root ).includes( MATERIAL_COMPUTE_DEFERRED_NODES_PROPERTY ), 'the slot must stay non-enumerable' );

} );

test( 'already-precompiled and non-compute nodes are not published', () => {

	const root = {};
	assert.deepEqual( attachDeferredMaterialComputeNodes( root, [
		{ isComputeNode: true, isPrecompiledCompute: true },
		{ isComputeNode: false },
		null,
	] ), [] );
	assert.equal( root[ MATERIAL_COMPUTE_DEFERRED_NODES_PROPERTY ], undefined );

} );

test( 'publishing onto a missing root is a no-op rather than a throw', () => {

	assert.deepEqual( attachDeferredMaterialComputeNodes( null, [ { isComputeNode: true } ] ), [] );
	assert.deepEqual( attachDeferredMaterialComputeNodes( {}, null ), [] );

} );
