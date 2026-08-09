import assert from 'node:assert/strict';
import test from 'node:test';

import {
	RENDER_BINDING_OWNER_KINDS,
	createBackgroundCaptureTargetTopologyKey,
	createRenderObjectContextSelector,
	createSceneRenderTopologySelector,
	describeBackgroundCaptureTargetTopology,
	describeRenderObjectContext,
	describeSceneRenderTopology,
	isRenderBindingOwnerKind,
	projectRenderObjectContextSelector,
	resolveArtifactSourceBindingOwner,
} from '@tsl-precompile/contract/render-selector';

// Selectors decide which captured shader serves a given draw. Two directions
// of failure:
//
//   over-specific -> capture and replay produce different selectors for the
//                    same draw, no artifact matches, and the frame falls back
//                    to live compilation (or renders wrong).
//   under-specific -> two genuinely different draws collide onto one artifact.
//
// The projection profiles exist to remove axes that provably cannot change a
// given auxiliary pass's WGSL. Each profile test below pins both what it drops
// and what it must keep.

function selectorOf( descriptor ) {

	return JSON.stringify( descriptor );

}

function baseDescriptor( overrides = {} ) {

	return {
		version: 'render-object-selector@1',
		renderer: { reversedDepthBuffer: true, shadowMap: { type: 1 }, contextNode: 'ctx', backend: { compatibilityMode: false } },
		target: { surface: 'canvas', sampleCount: 4, depth: true, stencil: false, activeCubeFace: 2, activeMipmapLevel: 1, colors: [ { kind: 'view', name: 'a', colorSpace: 'srgb-linear' } ] },
		mrt: { outputs: [ 'color' ] },
		scene: { fog: 'linear', environment: 'env', environmentNode: 'envNode' },
		lights: [ 'dir', 'point' ],
		camera: { kind: 'perspective' },
		object: { geometry: 'box' },
		material: { type: 'MeshPhysicalNodeMaterial', fog: true },
		clipping: { planes: 0 },
		...overrides,
	};

}

test( 'binding-owner kinds are a closed set', () => {

	assert.equal( isRenderBindingOwnerKind( RENDER_BINDING_OWNER_KINDS.MATERIAL ), true );
	assert.equal( isRenderBindingOwnerKind( RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER ), true );
	assert.equal( isRenderBindingOwnerKind( 'anything-else' ), false );
	assert.equal( isRenderBindingOwnerKind( undefined ), false );

} );

test( 'a source-local binding owner overrides the artifact-wide default', () => {

	const artifact = { bindingOwner: RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER };
	assert.equal(
		resolveArtifactSourceBindingOwner( artifact, { bindingOwner: RENDER_BINDING_OWNER_KINDS.MATERIAL } ),
		RENDER_BINDING_OWNER_KINDS.MATERIAL,
	);
	assert.equal( resolveArtifactSourceBindingOwner( artifact, {} ), RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER );

} );

test( 'binding ownership defaults to the material and ignores unknown spellings', () => {

	assert.equal( resolveArtifactSourceBindingOwner( null, null ), RENDER_BINDING_OWNER_KINDS.MATERIAL );
	assert.equal(
		resolveArtifactSourceBindingOwner( { bindingOwner: 'typo' }, { bindingOwner: 'also-typo' } ),
		RENDER_BINDING_OWNER_KINDS.MATERIAL,
		'an unrecognised owner must not silently become a new ownership mode',
	);

} );

test( 'a missing render object yields an empty selector rather than a fabricated one', () => {

	assert.equal( describeRenderObjectContext( null ), null );
	assert.equal( createRenderObjectContextSelector( null ), '' );

} );

test( 'an unknown projection profile is returned unchanged so adapters opt in one at a time', () => {

	const selector = selectorOf( baseDescriptor() );
	assert.equal( projectRenderObjectContextSelector( selector, 'some-future-pass' ), selector );

} );

test( 'a non-string or malformed selector is passed through without throwing', () => {

	assert.equal( projectRenderObjectContextSelector( null, 'background' ), '' );
	assert.equal( projectRenderObjectContextSelector( 42, 'background' ), '' );
	assert.equal( projectRenderObjectContextSelector( '', 'background' ), '' );
	assert.equal( projectRenderObjectContextSelector( 'not json', 'background' ), 'not json' );
	assert.equal( projectRenderObjectContextSelector( '{"version":"other@1"}', 'background' ), '{"version":"other@1"}' );

} );

test( 'the ordinary-material profile only canonicalizes; it drops no topology axis', () => {

	const projected = JSON.parse( projectRenderObjectContextSelector( selectorOf( baseDescriptor() ), null ) );
	for ( const key of [ 'renderer', 'target', 'mrt', 'scene', 'lights', 'camera', 'object', 'material', 'clipping' ] ) {

		assert.ok( key in projected, `${ key } is shader topology for an ordinary material` );

	}

} );

test( 'the ordinary-material profile is stable across every equivalent spelling of one draw', () => {

	const shuffled = { clipping: { planes: 0 }, version: 'render-object-selector@1', ...baseDescriptor() };
	assert.equal(
		projectRenderObjectContextSelector( selectorOf( baseDescriptor() ), null ),
		projectRenderObjectContextSelector( selectorOf( shuffled ), null ),
	);

} );

test( 'scene-independent profiles drop scene and lights but keep the object and material', () => {

	for ( const profile of [ 'background', 'shadow-depth', 'render-output', 'cube-render-target' ] ) {

		const projected = JSON.parse( projectRenderObjectContextSelector( selectorOf( baseDescriptor() ), profile ) );
		assert.equal( projected.scene, undefined, `${ profile } does not consume scene topology` );
		assert.deepEqual( projected.lights, [], `${ profile } does not consume scene lighting` );
		assert.ok( projected.object, `${ profile } still depends on object topology` );

	}

} );

test( 'the mesh-basic profile drops only the two environment axes it cannot consume', () => {

	const projected = JSON.parse( projectRenderObjectContextSelector( selectorOf( baseDescriptor() ), 'mesh-basic' ) );
	assert.equal( projected.scene.environment, undefined );
	assert.equal( projected.scene.environmentNode, undefined );
	assert.equal( projected.scene.fog, 'linear', 'MeshBasic still respects fog' );
	assert.deepEqual( projected.lights, [ 'dir', 'point' ], 'the mesh-basic profile is not scene independent' );

} );

test( 'fullscreen profiles drop the global MRT because they install an explicit fragmentNode', () => {

	for ( const profile of [ 'post-process', 'render-output' ] ) {

		const projected = JSON.parse( projectRenderObjectContextSelector( selectorOf( baseDescriptor() ), profile ) );
		assert.equal( projected.mrt, undefined, `${ profile } ignores renderer.getMRT()` );
		assert.equal( projected.renderer.reversedDepthBuffer, undefined, `${ profile } runs after depth projection` );

	}

} );

test( 'fullscreen profiles drop adapter-owned attachment identity but keep the material', () => {

	const projected = JSON.parse( projectRenderObjectContextSelector( selectorOf( baseDescriptor() ), 'post-process' ) );
	assert.equal( projected.target.surface, undefined );
	assert.equal( projected.target.depth, undefined );
	assert.equal( projected.target.stencil, undefined );
	assert.equal( projected.material.fog, undefined, 'NodeMaterial fog default is not consumed by a fullscreen quad' );
	assert.equal( projected.material.type, 'MeshPhysicalNodeMaterial', 'material identity is still selected on' );

} );

test( 'render-output additionally drops shadow filtering, which post-process does not', () => {

	const renderOutput = JSON.parse( projectRenderObjectContextSelector( selectorOf( baseDescriptor() ), 'render-output' ) );
	const postProcess = JSON.parse( projectRenderObjectContextSelector( selectorOf( baseDescriptor() ), 'post-process' ) );
	assert.equal( renderOutput.renderer.shadowMap, undefined, 'the output transform runs after shadow filtering completes' );
	assert.deepEqual( postProcess.renderer.shadowMap, { type: 1 } );

} );

test( 'the cube-render-target profile is invariant across face and mip', () => {

	const face2 = baseDescriptor();
	const face5 = baseDescriptor( { target: { ...baseDescriptor().target, activeCubeFace: 5, activeMipmapLevel: 3 } } );
	assert.equal(
		projectRenderObjectContextSelector( selectorOf( face2 ), 'cube-render-target' ),
		projectRenderObjectContextSelector( selectorOf( face5 ), 'cube-render-target' ),
		'one cube shader serves every mutable face and mip',
	);

} );

test( 'the background profile is invariant across surface label, MSAA, face, and linear color spaces', () => {

	const canvasPass = baseDescriptor();
	const cubeFacePass = baseDescriptor( {
		target: {
			surface: 'output-intermediate',
			sampleCount: 1,
			depth: true,
			stencil: false,
			activeCubeFace: 4,
			activeMipmapLevel: 2,
			colors: [ { kind: 'cube-view', name: 'a', colorSpace: '' } ],
		},
	} );
	assert.equal(
		projectRenderObjectContextSelector( selectorOf( canvasPass ), 'background' ),
		projectRenderObjectContextSelector( selectorOf( cubeFacePass ), 'background' ),
		'a cube face is still a 2D color attachment for the draw',
	);

} );

test( 'the background profile still separates genuinely different attachment formats', () => {

	const rgba8 = baseDescriptor( { target: { colors: [ { format: 'rgba8unorm' } ] } } );
	const rgba16 = baseDescriptor( { target: { colors: [ { format: 'rgba16float' } ] } } );
	assert.notEqual(
		projectRenderObjectContextSelector( selectorOf( rgba8 ), 'background' ),
		projectRenderObjectContextSelector( selectorOf( rgba16 ), 'background' ),
	);

} );

test( 'projection is idempotent, so a re-signed selector matches the first one', () => {

	for ( const profile of [ null, 'background', 'shadow-depth', 'post-process', 'render-output', 'cube-render-target', 'mesh-basic' ] ) {

		const once = projectRenderObjectContextSelector( selectorOf( baseDescriptor() ), profile );
		assert.equal( projectRenderObjectContextSelector( once, profile ), once, `${ profile } must be idempotent` );

	}

} );

test( 'scene topology records branch-forming shape, not live values', () => {

	assert.equal( describeSceneRenderTopology( null ), null );
	const withNodeFog = describeSceneRenderTopology( { fogNode: {}, fog: { isFog: true } } );
	assert.equal( withNodeFog.fog, 'node', 'a fog node outranks the legacy fog object' );

	const selector = createSceneRenderTopologySelector( { fogNode: {} } );
	assert.equal( typeof selector, 'string' );
	assert.equal( createSceneRenderTopologySelector( { fogNode: {} } ), selector, 'the selector must be deterministic' );

} );

test( 'the background capture target key is deterministic and topology-only', () => {

	const target = { texture: { format: 'rgba8unorm' }, depthTexture: null };
	const first = createBackgroundCaptureTargetTopologyKey( null, target );
	const second = createBackgroundCaptureTargetTopologyKey( null, { ...target, uuid: 'session-1' } );
	assert.equal( first, second, 'a capture-session uuid is not target topology' );
	assert.match( first, /background-capture-target@1/ );

} );

test( 'the background capture descriptor accepts a single texture or a textures array identically', () => {

	const single = describeBackgroundCaptureTargetTopology( null, { texture: { format: 'rgba8unorm' } } );
	const asArray = describeBackgroundCaptureTargetTopology( null, { textures: [ { format: 'rgba8unorm' } ] } );
	assert.deepEqual( single, asArray );

} );

test( 'a null render target still produces a well-formed descriptor', () => {

	const descriptor = describeBackgroundCaptureTargetTopology( null, null );
	assert.equal( descriptor.version, 'background-capture-target@1' );
	assert.equal( typeof createBackgroundCaptureTargetTopologyKey( null, null ), 'string' );

} );
