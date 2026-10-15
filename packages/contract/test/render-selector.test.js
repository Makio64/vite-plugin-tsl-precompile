import assert from 'node:assert/strict';
import test from 'node:test';
import { stableJsonStringify } from '../src/stable-json.js';

import {
	RENDER_BINDING_OWNER_KINDS,
	MATERIAL_SHADER_FAMILY,
	createShadowCasterTopologySelector,
	createBackgroundCaptureTargetTopologyKey,
	createRenderObjectContextSelector,
	createProjectedRenderObjectContextSelector,
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

test( 'authored material families distinguish custom shadow graphs after compiler removal', () => {

	const caster = family => ( {
		colorNode: { isNode: true }, castShadowNode: { isNode: true },
		[ MATERIAL_SHADER_FAMILY ]: family,
	} );
	assert.notEqual( createShadowCasterTopologySelector( caster( 'text' ) ), createShadowCasterTopologySelector( caster( 'projector' ) ) );
	const live = caster( 'text' );
	live.colorNode.children = [ { value: 0.7 } ];
	assert.equal( createShadowCasterTopologySelector( live ), createShadowCasterTopologySelector( caster( 'text' ) ),
		'live graph internals and inert replay roots share the authored family identity' );
	assert.equal( JSON.parse( createShadowCasterTopologySelector( {} ) ).shaderFamily, undefined );

} );

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

test( 'direct live projection matches the serialized path across profiles and scalar boundaries', () => {

	const profiles = [ null, undefined, '', 'mesh-basic', 'background', 'shadow-depth', 'post-process', 'render-output', 'cube-render-target', 'future-profile' ];
	for ( const value of [ undefined, null, false, true, 0, - 0, 1, 4, NaN, Infinity, '"\\\nΩ', {}, Symbol(), 1n ] ) {

		const texture = Object.freeze( { isTexture: true, format: value, type: 1016, colorSpace: 'srgb-linear' } );
		const target = Object.freeze( { texture, textures: [ texture ], isCubeRenderTarget: true, samples: 4 } );
		const renderer = Object.freeze( {
			backend: { isWebGPUBackend: true }, shadowMap: { enabled: true, type: value }, reversedDepthBuffer: true,
			getRenderTarget: () => target, getOutputRenderTarget: () => null,
			getActiveCubeFace: () => 2, getActiveMipmapLevel: () => 1,
		} );
		const renderObject = Object.freeze( {
			renderer, material: Object.freeze( { side: value, fog: true } ), camera: { isPerspectiveCamera: true },
			scene: Object.freeze( { environment: texture, environmentNode: { isNode: true }, fog: { isFog: true } } ),
			context: { textures: [ texture ], sampleCount: 4, depth: true, stencil: true },
			object: { geometry: { attributes: {
				position: { itemSize: value, normalized: false, offset: 1, data: { stride: 8 } },
				__range0: { itemSize: 4, normalized: false },
			} } },
		} );
		const raw = createRenderObjectContextSelector( renderObject );
		assert.equal( raw, stableJsonStringify( describeRenderObjectContext( renderObject ) ), 'live construction preserves canonical bytes' );
		for ( const profile of profiles ) {

			assert.equal( createProjectedRenderObjectContextSelector( renderObject, renderer, profile ), projectRenderObjectContextSelector( raw, profile ) );
			assert.equal( createProjectedRenderObjectContextSelector( null, renderer, profile ), '' );

		}

	}

} );

test( 'live canonical selectors preserve MRT ordering, rich topology and getter observations', () => {

	for ( const backendKind of [ 'isWebGPUBackend', 'isWebGLBackend' ] ) for ( const ids of [ true, false ] ) {

		const reads = [];
		const texture = { isTexture: true, isRenderTargetTexture: true, type: 1016, format: 1023, colorSpace: 'srgb-linear', name: 'z', channel: 1, mapping: 300 };
		const source = { alphaMap: texture, map: texture, side: 2, alphaTest: 0.1, colorNode: { isNode: true }, positionNode: { isNode: true } };
		const renderObject = {
			renderer: { backend: { [ backendKind ]: true, compatibilityMode: true }, shadowMap: { enabled: true, type: 2 }, logarithmicDepthBuffer: true },
			context: { textures: [ texture ], depthTexture: { isDepthTexture: true }, mrt: {
				outputNodes: Object.fromEntries( [ 'z', 'a', '10', '2', '__proto__', 'toJSON', 'Ω' ].map( name => [ name, {} ] ) ),
				getBlendMode( name ) { reads.push( name ); return name === 'a' ? { blending: 2 } : 1; },
			} },
			material: { isShadowPassMaterial: true, fog: false, ...source },
			sourceMaterial: source,
			scene: { environment: texture, fog: { isFogExp2: true }, overrideMaterial: { isShadowPassMaterial: true } },
			lightsNode: { lights: [
				{ ...( ids ? { id: 3 } : {} ), type: 'SpotLight', castShadow: true, map: texture, shadow: { camera: { isPerspectiveCamera: true } } },
				{ ...( ids ? { id: 1 } : {} ), type: 'AmbientLight', userData: { tslPrecompileId: 'stable' } },
			] },
			camera: { isPerspectiveCamera: true, isArrayCamera: true, cameras: [ {}, {} ] },
			object: { isSkinnedMesh: true, skeleton: { bones: [ {}, {} ] }, instanceMatrix: { count: 7 }, geometry: {
				index: {}, attributes: { z: { itemSize: 2, normalized: true }, a: { itemSize: 3, normalized: false, offset: 1, data: { stride: 8 } } },
				morphAttributes: { position: [ { itemSize: 3 } ] }, morphTargetsRelative: true,
			} },
		};
		const expected = stableJsonStringify( describeRenderObjectContext( renderObject ) );
		const expectedReads = reads.splice( 0 );
		assert.equal( createRenderObjectContextSelector( renderObject ), expected );
		assert.deepEqual( reads.splice( 0 ), expectedReads, 'canonicalization does not reorder renderer callbacks' );
		for ( const profile of [ null, 'background', 'shadow-depth', 'post-process', 'render-output', 'cube-render-target', 'mesh-basic', 'future' ] ) {

			assert.equal( createProjectedRenderObjectContextSelector( renderObject, renderObject.renderer, profile ), projectRenderObjectContextSelector( expected, profile ) );

		}

	}

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

test( 'unlit mesh-basic selectors ignore scene lights while lit custom graphs remain strict', () => {

	const first = baseDescriptor();
	first.material.lights = false;
	const second = structuredClone( first );
	second.lights.reverse();
	const project = descriptor => projectRenderObjectContextSelector( selectorOf( descriptor ), 'mesh-basic' );
	assert.equal( project( first ), project( second ) );
	assert.deepEqual( JSON.parse( project( first ) ).lights, [] );
	first.material.lights = second.material.lights = true;
	assert.notEqual( project( first ), project( second ) );

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

test( 'an explicit environment node outranks the raw scene texture in live and saved selectors', () => {

	const cube = { isTexture: true, isCubeTexture: true, type: 1009, mapping: 301 };
	const cubeUV = { isTexture: true, isRenderTargetTexture: true, type: 1016, mapping: 306 };
	const environmentNode = { isNode: true };
	assert.deepEqual(
		describeSceneRenderTopology( { environment: cube, environmentNode } ),
		describeSceneRenderTopology( { environment: cubeUV, environmentNode } ),
	);
	assert.notDeepEqual(
		describeSceneRenderTopology( { environment: cube } ),
		describeSceneRenderTopology( { environment: cubeUV } ),
		'without an explicit node, raw environment shape still selects the shader',
	);
	const saved = texture => selectorOf( baseDescriptor( { scene: {
		environment: describeSceneRenderTopology( { environment: texture } ).environment,
		environmentNode: true,
	} } ) );
	assert.equal( projectRenderObjectContextSelector( saved( cube ) ), projectRenderObjectContextSelector( saved( cubeUV ) ) );
	assert.equal( describeSceneRenderTopology( { environment: cube, environmentNode: {} } ).environmentNode, false,
		'non-node values do not override NodeManager environment selection' );

} );

test( 'the background capture target key is deterministic and topology-only', () => {

	const target = { texture: { format: 'rgba8unorm' }, depthTexture: null };
	const first = createBackgroundCaptureTargetTopologyKey( null, target );
	const second = createBackgroundCaptureTargetTopologyKey( null, { ...target, uuid: 'session-1' } );
	assert.equal( first, second, 'a capture-session uuid is not target topology' );
	assert.match( first, /background-capture-target@1/ );

} );

test( 'scene selector fast encoding preserves canonical bytes for every scalar and texture kind', () => {

	const scene = { fog: { isFog: true }, fogNode: null, environmentNode: {}, overrideMaterial: { isShadowPassMaterial: true } };
	const check = () => assert.equal( createSceneRenderTopologySelector( scene ), stableJsonStringify( describeSceneRenderTopology( scene ) ) );
	const properties = [ 'format', 'internalFormat', 'type', 'colorSpace', 'compareFunction', 'mapping', 'channel', 'magFilter', 'minFilter', 'wrapS', 'wrapT', 'wrapR' ];
	for ( const property of properties ) for ( const value of [ undefined, null, false, true, 0, - 0, 1.5, '', '"\\\n☃', NaN, Infinity, {}, () => {}, Symbol( 'unsupported' ), 1n ] ) {

		scene.environment = { isTexture: true, [ property ]: value };
		check();

	}
	for ( const kind of [ 'isTexture', 'isCubeTexture', 'isDataArrayTexture', 'isData3DTexture', 'isDepthTexture', 'isVideoTexture', 'isCompressedArrayTexture', 'isCompressedCubeTexture', 'isCompressedTexture', 'isStorageTexture', 'isRenderTargetTexture' ] ) {

		const texture = { [ kind ]: true, ...Object.fromEntries( properties.map( ( name, index ) => [ name, index ] ) ) };
		for ( const environment of [ texture, { texture: { ...texture, isTexture: true } } ] ) {

			scene.environment = environment;
			check();

		}

	}
	for ( const fog of [ null, {}, { isFog: true }, { isFogExp2: true } ] ) for ( const fogNode of [ null, {} ] ) for ( const overrideMaterial of [ null, {}, { isShadowPassMaterial: true } ] ) {

		Object.assign( scene, { fog, fogNode, overrideMaterial, environment: null, environmentNode: null } );
		check();

	}
	assert.equal( createSceneRenderTopologySelector( null ), 'null' );

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
