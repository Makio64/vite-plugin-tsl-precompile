import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DataTexture } from 'three/src/textures/DataTexture.js';

import { registerArtifact, getArtifact } from '../src/artifact-loader.js';
import { getDFGLUT } from '../src/dfg-lut.js';
import { hydrateNodeBuilderState, registerLiveTexture, clearLiveTextureIndex } from '../src/hydrator.js';
import { __applyPrecompiled, catalogueArtifactTextureRefs, collectLiveMaterialTextures } from '../src/apply-precompiled.js';
import PrecompiledMaterial from '../src/_vendor-PrecompiledMaterial.js';
import { PrecompiledComputeNode } from '../src/precompiled-compute-node.js';
import {
	wireViewportTextureRefs,
	setupViewportTextureClasses,
	registerAuxArtifact,
	loadAux,
	attachMRTTextureRefs,
	__resetAuxRegistryForTests,
} from '../src/aux-loader.js';
import {
	PassNode,
	mrt,
	mix,
	step,
	texture,
	normalWorld,
	screenUV,
} from '../src/slim-stubs.js';

test( 'runtime artifact registry round-trips a module', () => {

	const mod = { __hash: 'hash-a', artifact: { vertexShader: 'v', fragmentShader: 'f' } };
	registerArtifact( 'mat-a', mod );
	assert.equal( getArtifact( 'mat-a' ), mod );

} );

test( 'runtime hydrator returns a NodeBuilderState-shaped object', () => {

	const state = hydrateNodeBuilderState( {
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		bindings: [],
		nodeAttributes: [],
	} );

	assert.equal( state.vertexShader, 'vertex' );
	assert.equal( state.fragmentShader, 'fragment' );
	assert.deepEqual( state.createBindings(), [] );
	assert.equal( typeof state.getUnknownRendererProbe, 'function' );

} );

test( 'runtime hydrator rehydrates JSON node attributes with storage-buffer fallbacks', () => {

	const state = hydrateNodeBuilderState( {
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		attributes: [
			{ name: 'nodeAttribute0', type: 'vec3', source: 'node', count: 4, itemSize: 3, arrayType: 'Float32Array' },
		],
		bindings: [],
		uniformPlan: [],
	} );

	const nodeAttribute = state.nodeAttributes[ 0 ];
	assert.equal( nodeAttribute.node.attribute.isStorageBufferAttribute, true );
	assert.equal( nodeAttribute.node.attribute.itemSize, 3 );
	assert.equal( nodeAttribute.node.attribute.count, 4 );

} );

test( 'runtime hydrator rehydrates uniform-buffer descriptors and updates UBO bytes', () => {

	const artifact = {
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		attributes: [ { name: 'position', type: 'vec3' } ],
		bindings: [ {
			name: 'render',
			bindings: [
				{ name: 'render', kind: 'uniform-buffer', visibility: 7, byteLength: 80 },
			],
		} ],
		uniformPlan: [ {
			name: 'render',
			shared: true,
			byteLength: 80,
			slots: [
				{ offset: 0, dtype: 'number', source: { kind: 'frame.time' } },
				{ offset: 16, dtype: 'mat4', source: { kind: 'camera.projectionMatrix' } },
			],
		} ],
	};

	const state = hydrateNodeBuilderState( artifact );
	assert.deepEqual( state.nodeAttributes, [ { name: 'position', type: 'vec3' } ] );
	assert.equal( state.bindings.length, 1 );
	assert.equal( state.bindings[ 0 ].bindings.length, 1 );

	const uniformBuffer = state.bindings[ 0 ].bindings[ 0 ];
	assert.equal( uniformBuffer.isUniformBuffer, true );
	assert.equal( uniformBuffer.groupNode.shared, true );

	state.updateNodes[ 0 ].update( {
		time: 1.25,
		camera: {
			projectionMatrix: { elements: new Array( 16 ).fill( 0 ).map( ( _, i ) => i + 1 ) },
		},
	} );

	const view = new DataView( uniformBuffer.buffer.buffer );
	assert.equal( view.getFloat32( 0, true ), 1.25 );
	assert.equal( view.getFloat32( 16, true ), 1 );
	assert.equal( view.getFloat32( 16 + 15 * 4, true ), 16 );
	assert.equal( uniformBuffer.groupNode.version, 1 );

} );

test( 'runtime hydrator seeds regular uniform buffers from valueSnapshot', () => {

	const artifact = {
		vertexShader: '',
		fragmentShader: '',
		bindings: [ { name: 'object', bindings: [ { name: 'object', kind: 'uniform-buffer', visibility: 7, byteLength: 80 } ] } ],
		uniformPlan: [ {
			name: 'object',
			byteLength: 80,
			slots: [
				{ offset: 0, dtype: 'mat4', source: { kind: 'object.worldMatrix', valueSnapshot: { type: 'mat4', data: new Array( 16 ).fill( 0 ).map( ( _, i ) => i + 1 ) } } },
			],
		} ],
	};

	const state = hydrateNodeBuilderState( artifact );
	const ub = state.bindings[ 0 ].bindings[ 0 ];
	const view = new DataView( ub.buffer.buffer );
	assert.equal( view.getFloat32( 0, true ), 1 );
	assert.equal( view.getFloat32( 15 * 4, true ), 16 );

} );

test( 'runtime hydrator rehydrates sampled texture and sampler descriptors', () => {

	const map = { isTexture: true, addEventListener() {}, removeEventListener() {}, version: 0 };
	const state = hydrateNodeBuilderState( {
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		bindings: [ {
			name: 'object',
			bindings: [
				{ name: 'nodeSampler0', kind: 'sampler', visibility: 2 },
				{ name: 'nodeTexture0', kind: 'sampled-texture', visibility: 2, textureType: '2d' },
			],
		} ],
		uniformPlan: [ {
			name: 'object',
			shared: false,
			slots: [],
			textures: [
				{ name: 'nodeSampler0', source: { kind: 'material.map', property: 'map' } },
				{ name: 'nodeTexture0', source: { kind: 'material.map', property: 'map' } },
			],
		} ],
	}, { map } );

	const [ sampler, texture ] = state.bindings[ 0 ].bindings;
	assert.equal( sampler.isSampler, true );
	assert.equal( texture.isSampledTexture, true );
	assert.equal( sampler.texture, map );
	assert.equal( texture.texture, map );

} );

test( 'runtime DFG LUT uses the renderer source-module DataTexture class', () => {

	const lut = getDFGLUT();
	assert.ok( lut instanceof DataTexture );
	assert.equal( lut.isDataTexture, true );
	assert.equal( lut.image.width, 16 );
	assert.equal( lut.image.height, 16 );
	assert.equal( lut.image.data.length, 16 * 16 * 2 );

} );

test( 'runtime hydrator rehydrates artifact.texture snapshots', () => {

	const snapshot = { width: 2, height: 1, arrayType: 'Uint8Array', data: [ 255, 0, 0, 255, 0, 255, 0, 255 ] };
	const artifact = {
		vertexShader: '',
		fragmentShader: '',
		bindings: [ {
			name: 'object',
			bindings: [
				{ name: 'nodeSampler0', kind: 'sampler', visibility: 2 },
				{ name: 'nodeTexture0', kind: 'sampled-texture', visibility: 2, textureType: '2d' },
			],
		} ],
		uniformPlan: [ {
			name: 'object',
			slots: [],
			textures: [
				{ name: 'nodeSampler0', source: { kind: 'artifact.texture', textureUuid: 'tex-a', snapshot } },
				{ name: 'nodeTexture0', source: { kind: 'artifact.texture', textureUuid: 'tex-a', snapshot } },
			],
		} ],
	};

	const state = hydrateNodeBuilderState( artifact );
	const [ sampler, texture ] = state.bindings[ 0 ].bindings;
	assert.equal( sampler.texture, texture.texture );
	assert.equal( texture.texture.isDataTexture, true );
	assert.equal( texture.texture.image.width, 2 );
	assert.equal( texture.texture.image.data[ 0 ], 255 );
	assert.equal( texture.texture.image.data[ 4 ], 0 );
	assert.equal( texture.texture.image.data[ 5 ], 255 );

} );

test( 'runtime hydrator uses live color render-target texture refs for plain texture_2d bindings', () => {

	const renderTargetTexture = {
		isTexture: true,
		isRenderTargetTexture: true,
		uuid: 'rt-tex',
		renderTarget: { samples: 4 },
		addEventListener() {},
		removeEventListener() {},
		version: 0,
	};
	const artifact = {
		vertexShader: '',
		fragmentShader: '@group(1) @binding(0) var nodeUniform0 : texture_2d<f32>;\n@group(1) @binding(1) var nodeUniform0_sampler : sampler;',
		bindings: [ {
			name: 'object',
			bindings: [
				{ name: 'nodeUniform0_sampler', kind: 'sampler', visibility: 2 },
				{ name: 'nodeUniform0', kind: 'sampled-texture', visibility: 2, textureType: '2d' },
			],
		} ],
		uniformPlan: [ {
			name: 'object',
			slots: [],
			textures: [
				{ name: 'nodeUniform0_sampler', source: { kind: 'artifact.texture', textureUuid: 'rt-tex' } },
				{ name: 'nodeUniform0', source: { kind: 'artifact.texture', textureUuid: 'rt-tex' } },
			],
		} ],
	};
	Object.defineProperty( artifact, '_textureRefs', { value: new Map( [ [ 'rt-tex', renderTargetTexture ] ] ) } );

	const state = hydrateNodeBuilderState( artifact );
	const [ sampler, texture ] = state.bindings[ 0 ].bindings;
	assert.equal( sampler.texture, renderTargetTexture );
	assert.equal( texture.texture, renderTargetTexture );

} );

test( 'runtime hydrator uses depth fallback for depth texture bindings', () => {

	const state = hydrateNodeBuilderState( {
		vertexShader: '',
		fragmentShader: '@group(1) @binding(0) var shadowTex : texture_depth_2d;\n@group(1) @binding(1) var shadowSampler : sampler_comparison;',
		bindings: [ {
			name: 'object',
			bindings: [
				{ name: 'shadowTex', kind: 'sampled-texture', visibility: 2, textureType: '2d' },
				{ name: 'shadowSampler', kind: 'sampler', visibility: 2 },
			],
		} ],
		uniformPlan: [ { name: 'object', slots: [], textures: [] } ],
	} );

	const [ texture, sampler ] = state.bindings[ 0 ].bindings;
	assert.equal( texture.texture.isDepthTexture, true );
	assert.equal( sampler.texture.isDepthTexture, true );

} );

test( 'runtime hydrator does not bind color shadow maps into depth texture slots', () => {

	const state = hydrateNodeBuilderState( {
		vertexShader: '',
		fragmentShader: '@group(1) @binding(0) var shadowTex : texture_depth_2d;',
		bindings: [ {
			name: 'object',
			bindings: [
				{ name: 'shadowTex', kind: 'sampled-texture', visibility: 2, textureType: '2d' },
			],
		} ],
		uniformPlan: [ {
			name: 'object',
			slots: [],
			textures: [ { name: 'shadowTex', source: { kind: 'depth.texture', lightIndex: 0 } } ],
		} ],
	} );

	const [ textureBinding ] = state.bindings[ 0 ].bindings;
	const depthFallback = textureBinding.texture;
	const colorShadowTarget = { isTexture: true, isDepthTexture: false };
	const scene = {
		traverse( visit ) {

			visit( { isLight: true, castShadow: true, shadow: { map: { texture: colorShadowTarget } } } );

		},
	};

	state.updateBeforeNodes[ 0 ].updateBefore( { scene } );

	assert.equal( textureBinding.texture, depthFallback );
	assert.notEqual( textureBinding.texture, colorShadowTarget );

} );

test( 'runtime hydrator uses 3D fallback for texture_3d bindings', () => {

	const state = hydrateNodeBuilderState( {
		vertexShader: '',
		fragmentShader: '@group(1) @binding(0) var volumeTex : texture_3d<f32>;',
		bindings: [ {
			name: 'object',
			bindings: [
				{ name: 'volumeTex', kind: 'sampled-texture', visibility: 2, textureType: '3d' },
			],
		} ],
		uniformPlan: [ { name: 'object', slots: [], textures: [] } ],
	} );

	const [ texture ] = state.bindings[ 0 ].bindings;
	assert.equal( texture.isSampled3DTexture, true );
	assert.equal( texture.isSampledTexture3D, true );
	assert.equal( texture.texture.isData3DTexture, true );
	assert.equal( texture.texture.image.depth, 1 );

} );

test( '__applyPrecompiled wraps a material and preserves common texture slots', () => {

	const map = { uuid: 'map-a' };
	const normalMap = { uuid: 'normal-a' };
	const source = {
		name: 'water',
		color: { r: 0, g: 0.2, b: 1 },
		roughness: 0.4,
		map,
		normalMap,
		normalScale: { x: 1, y: 1 },
	};
	const wrapped = __applyPrecompiled( source, {
		__hash: 'sha256:mat',
		name: 'water',
		update() {},
		updateGroup() {},
		artifact: {
			__hash: 'sha256:mat',
			uniformPlan: [],
			vertexShader: 'v',
			fragmentShader: 'f',
		},
	}, 'sha256:mat' );

	assert.equal( wrapped.isPrecompiledMaterial, true );
	assert.equal( wrapped.name, 'water' );
	assert.equal( wrapped.roughness, 0.4 );
	assert.equal( wrapped.map, map );
	assert.equal( wrapped.normalMap, normalMap );
	assert.equal( wrapped.normalScale, source.normalScale );
	assert.equal( wrapped.customProgramCacheKey(), 'tslp:sha256:mat' );
	assert.equal( typeof wrapped.precompiledArtifact._generatedUpdate, 'function' );
	assert.equal( typeof wrapped.precompiledArtifact._generatedUpdateGroup, 'function' );

} );

test( 'PrecompiledMaterial derives distinct program keys from shader content', () => {

	const a = new PrecompiledMaterial( { uniformPlan: [], vertexShader: 'v', fragmentShader: 'f-a' } );
	const b = new PrecompiledMaterial( { uniformPlan: [], vertexShader: 'v', fragmentShader: 'f-b' } );
	assert.notEqual( a.customProgramCacheKey(), b.customProgramCacheKey() );
	assert.match( a.customProgramCacheKey(), /^tslp:/ );

} );

test( 'PrecompiledMaterial attaches an inert MRT stub when artifact.mrtOutputCount > 1', () => {

	// Single-target artifact: no MRT stub.
	const single = new PrecompiledMaterial( { uniformPlan: [], vertexShader: 'v', fragmentShader: 'f', mrtOutputCount: 1 } );
	assert.equal( single.mrtNode, undefined, 'single-target artifact must not attach an MRT stub' );

	// Multi-target artifact: MRT stub present, with N output entries and an
	// MRTNode-shaped surface (id, isMRTNode, getBlendMode, has, get, merge).
	const mrt = new PrecompiledMaterial( { uniformPlan: [], vertexShader: 'v', fragmentShader: 'f', mrtOutputCount: 3 } );
	assert.ok( mrt.mrtNode, 'multi-target artifact must attach an MRT stub' );
	assert.equal( mrt.mrtNode.isMRTNode, true );
	assert.equal( mrt.mrtNode.isNode, true );
	assert.equal( typeof mrt.mrtNode.id, 'string' );
	assert.equal( Object.keys( mrt.mrtNode.outputNodes ).length, 3 );
	assert.equal( mrt.mrtNode.has( 'output0' ), true );
	assert.equal( mrt.mrtNode.has( 'unknown' ), false );
	assert.deepEqual( mrt.mrtNode.getBlendMode(), { blending: 0 } );

	// Two multi-target materials get distinct stub ids so RenderContexts.get()
	// keys them into distinct render contexts.
	const mrt2 = new PrecompiledMaterial( { uniformPlan: [], vertexShader: 'v', fragmentShader: 'f', mrtOutputCount: 2 } );
	assert.notEqual( mrt.mrtNode.id, mrt2.mrtNode.id );

} );

test( 'PrecompiledMaterial honors captured mrtOutputNames and mrtBlendModes', () => {

	// When the artifact carries the captured per-output names + blend modes,
	// the stub uses them so three.js's pipeline cache key matches what the
	// fragment shader expects (no more hardcoded NoBlending). Names like
	// `output`/`normal`/`mask` are real three.js MRT pass conventions.
	const mat = new PrecompiledMaterial( {
		uniformPlan: [],
		vertexShader: 'v',
		fragmentShader: 'f',
		mrtOutputCount: 2,
		mrtOutputNames: [ 'output', 'normal' ],
		mrtBlendModes: { output: 1 /* NormalBlending */, normal: 0 /* NoBlending */ },
	} );
	assert.deepEqual( Object.keys( mat.mrtNode.outputNodes ).sort(), [ 'normal', 'output' ] );
	assert.equal( mat.mrtNode.has( 'output' ), true );
	assert.equal( mat.mrtNode.has( 'normal' ), true );
	assert.equal( mat.mrtNode.has( 'output0' ), false, 'must not synthesize output0 when names provided' );
	assert.deepEqual( mat.mrtNode.getBlendMode( 'output' ), { blending: 1 } );
	assert.deepEqual( mat.mrtNode.getBlendMode( 'normal' ), { blending: 0 } );
	assert.deepEqual( mat.mrtNode.getBlendMode( 'unknown' ), { blending: 0 }, 'unknown name falls back to NoBlending' );

	// Length mismatch between outputCount and outputNames falls back to synthetic names.
	const fallback = new PrecompiledMaterial( {
		uniformPlan: [],
		vertexShader: 'v',
		fragmentShader: 'f',
		mrtOutputCount: 3,
		mrtOutputNames: [ 'just-one' ],
	} );
	assert.equal( fallback.mrtNode.has( 'output0' ), true );
	assert.equal( fallback.mrtNode.has( 'output2' ), true );
	assert.equal( fallback.mrtNode.has( 'just-one' ), false );

} );

test( '__applyPrecompiled forwards mrtNode from source material when artifact has none', () => {

	const sourceMrt = { isMRTNode: true, id: 'user-mrt', outputNodes: { a: {}, b: {} } };
	const source = { name: 'mrt-mat', mrtNode: sourceMrt };
	const wrapped = __applyPrecompiled( source, {
		__hash: 'sha256:mrt-fwd',
		name: 'mrt-fwd',
		artifact: {
			__hash: 'sha256:mrt-fwd',
			uniformPlan: [],
			vertexShader: 'v',
			fragmentShader: 'f',
			// no mrtOutputCount on the artifact — propagation must come from source
		},
	}, 'sha256:mrt-fwd' );
	assert.equal( wrapped.mrtNode, sourceMrt );

} );

test( '__applyPrecompiled prefers artifact-driven mrtNode over source.mrtNode', () => {

	const sourceMrt = { isMRTNode: true, id: 'user-mrt', outputNodes: { a: {} } };
	const source = { name: 'mrt-mat', mrtNode: sourceMrt };
	const wrapped = __applyPrecompiled( source, {
		__hash: 'sha256:mrt-art',
		name: 'mrt-art',
		artifact: {
			__hash: 'sha256:mrt-art',
			uniformPlan: [],
			vertexShader: 'v',
			fragmentShader: 'f',
			mrtOutputCount: 4,
		},
	}, 'sha256:mrt-art' );
	// Constructor's stub wins; we must not overwrite a baked stub.
	assert.notEqual( wrapped.mrtNode, sourceMrt );
	assert.equal( wrapped.mrtNode.isMRTNode, true );
	assert.equal( Object.keys( wrapped.mrtNode.outputNodes ).length, 4 );

} );

test( 'runtime hydrator prefers generated per-group updater when attached', () => {

	const artifact = {
		vertexShader: '', fragmentShader: '',
		bindings: [ { name: 'object', bindings: [ { name: 'object', kind: 'uniform-buffer', visibility: 7, byteLength: 16 } ] } ],
		uniformPlan: [ {
			name: 'object',
			shared: false,
			byteLength: 16,
			slots: [
				{ offset: 0, dtype: 'number', source: { kind: 'material.opacity', property: 'opacity', valueSnapshot: { type: 'number', data: 0 } } },
			],
		} ],
	};
	let calledGroup = null;
	Object.defineProperty( artifact, '_generatedUpdateGroup', {
		value( frame, material, view, byteOffset, groupName ) {

			calledGroup = groupName;
			view.setFloat32( byteOffset, material.opacity, true );

		},
		enumerable: false,
	} );

	const state = hydrateNodeBuilderState( artifact, { opacity: 0.625 } );
	const ub = state.bindings[ 0 ].bindings[ 0 ];
	state.updateNodes[ state.updateNodes.length - 1 ].update( { time: 0, camera: null } );

	const view = new DataView( ub.buffer.buffer );
	assert.equal( calledGroup, 'object' );
	assert.equal( view.getFloat32( 0, true ), 0.625 );

} );

test( 'PrecompiledComputeNode exposes the slim compute fast-path flags', () => {

	const artifact = { kind: 'compute', computeShader: 'cs', uniformPlan: [], dispatchSize: 32 };
	const node = new PrecompiledComputeNode( artifact );

	assert.equal( node.isNode, true );
	assert.equal( node.isComputeNode, true );
	assert.equal( node.isPrecompiledCompute, true );
	assert.equal( node.precompiledArtifact, artifact );
	assert.equal( node.count, 32 );
	assert.equal( node.getUpdateType(), 'none' );

} );

test( 'hydrator: storage-buffer descriptor produces a StorageBuffer binding', () => {

	const artifact = {
		vertexShader: '',
		fragmentShader: '',
		computeShader: 'cs',
		bindings: [ {
			name: 'compute',
			bindings: [
				{ name: 'particles', kind: 'storage-buffer', visibility: 4, byteLength: 192, access: 'read_write' },
			],
		} ],
		uniformPlan: [ {
			name: 'compute',
			shared: false,
			slots: [],
			textures: [],
			storageBuffers: [
				{ name: 'particles', access: 'read_write', visibility: 4, arrayType: 'Float32Array', count: 16, itemSize: 3 },
			],
		} ],
	};

	const state = hydrateNodeBuilderState( artifact );
	assert.equal( state.bindings.length, 1 );
	const sb = state.bindings[ 0 ].bindings[ 0 ];
	assert.equal( sb.isStorageBuffer, true, 'binding must be StorageBuffer' );
	assert.equal( sb.visibility, 4 );

} );

test( 'hydrator: storage-buffer seeded from _liveArray matches in-process data', () => {

	const liveArray = new Float32Array( [ 1, 2, 3, 4, 5, 6 ] );
	const liveAttr = { array: liveArray, count: 2, itemSize: 3, isStorageBufferAttribute: true };

	const sbEntry = { name: 'verts', access: 'read_write', visibility: 4, arrayType: 'Float32Array', count: 2, itemSize: 3 };
	Object.defineProperty( sbEntry, '_liveArray', { value: liveArray, enumerable: false } );
	Object.defineProperty( sbEntry, '_liveAttribute', { value: liveAttr, enumerable: false } );

	const artifact = {
		vertexShader: '', fragmentShader: '', computeShader: 'cs',
		bindings: [ {
			name: 'g',
			bindings: [ { name: 'verts', kind: 'storage-buffer', visibility: 4, byteLength: 24, access: 'read_write' } ],
		} ],
		uniformPlan: [ {
			name: 'g', shared: false, slots: [], textures: [],
			storageBuffers: [ sbEntry ],
		} ],
	};

	const state = hydrateNodeBuilderState( artifact );
	const sb = state.bindings[ 0 ].bindings[ 0 ];
	assert.equal( sb.isStorageBuffer, true );
	// _liveAttribute was provided — hydrator should use it directly
	assert.equal( sb.attribute, liveAttr );

} );

test( 'hydrator: uniform.live reads _liveNode.value when present', () => {

	const liveNode = { value: 42.5 };

	const artifact = {
		vertexShader: '', fragmentShader: '',
		bindings: [ { name: 'render', bindings: [ { name: 'render', kind: 'uniform-buffer', visibility: 7, byteLength: 16 } ] } ],
		uniformPlan: [ {
			name: 'render',
			shared: true,
			byteLength: 16,
			slots: [
				{ offset: 0, dtype: 'number', source: { kind: 'uniform.live', valueSnapshot: { type: 'number', data: 0 } } },
			],
		} ],
	};

	// Attach _liveNode to the slot as the hydrator does for in-process flows
	Object.defineProperty( artifact.uniformPlan[ 0 ].slots[ 0 ], '_liveNode', { value: liveNode, enumerable: false } );

	const state = hydrateNodeBuilderState( artifact );
	const ub = state.bindings[ 0 ].bindings[ 0 ];

	state.updateNodes[ state.updateNodes.length - 1 ].update( { time: 0, camera: null } );

	const view = new DataView( ub.buffer.buffer );
	assert.equal( view.getFloat32( 0, true ), 42.5, 'must read live value 42.5 from _liveNode.value' );

} );

test( 'hydrator: uniform.live falls back to snapshot when _liveNode absent', () => {

	const artifact = {
		vertexShader: '', fragmentShader: '',
		bindings: [ { name: 'render', bindings: [ { name: 'render', kind: 'uniform-buffer', visibility: 7, byteLength: 16 } ] } ],
		uniformPlan: [ {
			name: 'render',
			shared: true,
			byteLength: 16,
			slots: [
				{ offset: 0, dtype: 'number', source: { kind: 'uniform.live', valueSnapshot: { type: 'number', data: 7.77 } } },
			],
		} ],
	};

	const state = hydrateNodeBuilderState( artifact );
	const ub = state.bindings[ 0 ].bindings[ 0 ];

	state.updateNodes[ state.updateNodes.length - 1 ].update( { time: 0, camera: null } );

	const view = new DataView( ub.buffer.buffer );
	assert.ok( Math.abs( view.getFloat32( 0, true ) - 7.77 ) < 0.001, 'must fall back to snapshot 7.77' );

} );

test( 'hydrator: _liveUpdateNodes run before the snapshot updater', () => {

	const liveNode = { value: 0 };
	let liveUpdateCount = 0;

	// Fake live update node that writes to liveNode.value each frame
	const liveUpdateNode = {
		getUpdateType() { return 'object'; },
		updateReference() { return this; },
		update( frame ) { liveNode.value = frame.time * 10; liveUpdateCount ++; },
	};

	const artifact = {
		vertexShader: '', fragmentShader: '',
		bindings: [ { name: 'render', bindings: [ { name: 'render', kind: 'uniform-buffer', visibility: 7, byteLength: 16 } ] } ],
		uniformPlan: [ {
			name: 'render', shared: true, byteLength: 16,
			slots: [
				{ offset: 0, dtype: 'number', source: { kind: 'uniform.live', valueSnapshot: { type: 'number', data: 0 } } },
			],
		} ],
	};

	Object.defineProperty( artifact.uniformPlan[ 0 ].slots[ 0 ], '_liveNode', { value: liveNode, enumerable: false } );
	Object.defineProperty( artifact, '_liveUpdateNodes', { value: [ liveUpdateNode ], enumerable: false } );

	const state = hydrateNodeBuilderState( artifact );
	// _liveUpdateNode must be the FIRST updateNode; precompiled updater is last
	assert.equal( state.updateNodes[ 0 ], liveUpdateNode, 'live update node must come first' );

	// Simulate the renderer calling updateNodes in order
	for ( const node of state.updateNodes ) node.update( { time: 2.5, camera: null } );

	const ub = state.bindings[ 0 ].bindings[ 0 ];
	const view = new DataView( ub.buffer.buffer );
	assert.equal( view.getFloat32( 0, true ), 25, 'must write liveNode.value = time * 10 = 25' );
	assert.equal( liveUpdateCount, 1 );

} );

test( 'hydrator: _textureRefs used for in-process artifact.texture resolution', () => {

	const tex = { isTexture: true, uuid: 'tex-uuid-a', addEventListener() {}, removeEventListener() {}, version: 0 };
	const textureRefs = new Map( [ [ 'tex-uuid-a', tex ] ] );

	const artifact = {
		vertexShader: '', fragmentShader: '',
		bindings: [ { name: 'obj', bindings: [ { name: 'myTex', kind: 'sampled-texture', visibility: 2, textureType: '2d' } ] } ],
		uniformPlan: [ {
			name: 'obj', shared: false, slots: [],
			textures: [ { name: 'myTex', source: { kind: 'artifact.texture', textureUuid: 'tex-uuid-a' } } ],
		} ],
	};
	Object.defineProperty( artifact, '_textureRefs', { value: textureRefs, enumerable: false } );

	const state = hydrateNodeBuilderState( artifact );
	const binding = state.bindings[ 0 ].bindings[ 0 ];
	assert.equal( binding.texture, tex, '_textureRefs UUID lookup must return the in-process texture' );

} );

test( 'hydrator: object3d.userData float reads from frame.object.userData per draw', () => {

	const artifact = {
		vertexShader: '', fragmentShader: '',
		bindings: [ { name: 'object', bindings: [ { name: 'object', kind: 'uniform-buffer', visibility: 7, byteLength: 16 } ] } ],
		uniformPlan: [ {
			name: 'object',
			shared: false,
			byteLength: 16,
			slots: [
				{ offset: 0, dtype: 'number', source: { kind: 'object3d.userData', property: 'rotation', uniformType: 'float' } },
			],
		} ],
	};

	const state = hydrateNodeBuilderState( artifact );
	const ub = state.bindings[ 0 ].bindings[ 0 ];
	const updateNode = state.updateNodes[ state.updateNodes.length - 1 ];

	// Simulate first object at rotation 0.5
	updateNode.update( { time: 0, camera: null, object: { userData: { rotation: 0.5 } } } );
	const view = new DataView( ub.buffer.buffer );
	assert.ok( Math.abs( view.getFloat32( 0, true ) - 0.5 ) < 0.0001, 'first draw rotation must be 0.5' );

	// Simulate second object at rotation 1.25 (per-sprite live value)
	updateNode.update( { time: 0, camera: null, object: { userData: { rotation: 1.25 } } } );
	assert.ok( Math.abs( view.getFloat32( 0, true ) - 1.25 ) < 0.0001, 'second draw rotation must be 1.25' );

	// Simulate object with no userData key — must not produce NaN
	updateNode.update( { time: 0, camera: null, object: { userData: {} } } );
	assert.equal( view.getFloat32( 0, true ), 0, 'missing userData key must default to 0' );

} );

test( 'hydrator: object3d.userData falls back to snapshot when object is absent', () => {

	const artifact = {
		vertexShader: '', fragmentShader: '',
		bindings: [ { name: 'object', bindings: [ { name: 'object', kind: 'uniform-buffer', visibility: 7, byteLength: 16 } ] } ],
		uniformPlan: [ {
			name: 'object',
			shared: false,
			byteLength: 16,
			slots: [
				{ offset: 0, dtype: 'number', source: { kind: 'object3d.userData', property: 'rotation', uniformType: 'float', valueSnapshot: { type: 'number', data: 3.14 } } },
			],
		} ],
	};

	const state = hydrateNodeBuilderState( artifact );
	const ub = state.bindings[ 0 ].bindings[ 0 ];
	const updateNode = state.updateNodes[ state.updateNodes.length - 1 ];

	// No object in frame — should use snapshot fallback
	updateNode.update( { time: 0, camera: null } );
	const view = new DataView( ub.buffer.buffer );
	assert.ok( Math.abs( view.getFloat32( 0, true ) - 3.14 ) < 0.001, 'must fall back to snapshot 3.14' );

} );

test( 'wireViewportTextureRefs: silently no-ops before setupViewportTextureClasses', () => {

	const artifact = {
		vertexShader: '@group(1) @binding(0) var nodeUniform20 : texture_depth_2d;',
		fragmentShader: '',
		uniformPlan: [ {
			name: 'object',
			slots: [],
			textures: [
				{ name: 'nodeUniform20', source: { kind: 'artifact.texture', textureUuid: 'vp-a', mapping: 300 } },
			],
		} ],
	};

	const result = wireViewportTextureRefs( artifact );
	assert.equal( result, artifact, 'should return same artifact object' );
	assert.ok( ! ( artifact._textureRefs instanceof Map ), '_textureRefs should not be set before setupViewportTextureClasses' );

} );

test( 'wireViewportTextureRefs: wires DepthTexture for texture_depth_2d bindings after setup', () => {

	function DepthTextureStub( w, h ) { this.w = w; this.h = h; this.isDepthTexture = true; this.needsUpdate = false; }
	function FramebufferTextureStub( w, h ) { this.w = w; this.h = h; this.isFramebufferTexture = true; this.needsUpdate = false; }

	setupViewportTextureClasses( { DepthTexture: DepthTextureStub, FramebufferTexture: FramebufferTextureStub } );

	const uuid = 'vp-depth-a';
	const artifact = {
		vertexShader: `@group(1) @binding(0) var nodeUniform20 : texture_depth_2d;`,
		fragmentShader: '',
		uniformPlan: [ {
			name: 'object',
			slots: [],
			textures: [
				{ name: 'nodeUniform20', source: { kind: 'artifact.texture', textureUuid: uuid, mapping: 300 } },
			],
		} ],
	};

	wireViewportTextureRefs( artifact );
	assert.ok( artifact._textureRefs instanceof Map, '_textureRefs must be a Map' );
	const tex = artifact._textureRefs.get( uuid );
	assert.ok( tex, 'must have a fallback texture for the UUID' );
	assert.ok( tex.isDepthTexture, 'depth binding must produce a DepthTexture fallback' );
	assert.ok( ! tex.isFramebufferTexture, 'depth fallback must NOT have isFramebufferTexture' );

} );

test( 'wireViewportTextureRefs: wires FramebufferTexture for texture_2d bindings', () => {

	function DepthTextureStub( w, h ) { this.w = w; this.h = h; this.isDepthTexture = true; this.needsUpdate = false; }
	function FramebufferTextureStub( w, h ) { this.w = w; this.h = h; this.isFramebufferTexture = true; this.needsUpdate = false; }
	setupViewportTextureClasses( { DepthTexture: DepthTextureStub, FramebufferTexture: FramebufferTextureStub } );

	const uuid = 'vp-color-b';
	const artifact = {
		vertexShader: `@group(1) @binding(0) var viewportTex : texture_2d<f32>;`,
		fragmentShader: '',
		uniformPlan: [ {
			name: 'object',
			slots: [],
			textures: [
				{ name: 'viewportTex', source: { kind: 'artifact.texture', textureUuid: uuid, mapping: 300 } },
			],
		} ],
	};

	wireViewportTextureRefs( artifact );
	const tex = artifact._textureRefs && artifact._textureRefs.get( uuid );
	assert.ok( tex, 'must have a fallback texture' );
	assert.ok( tex.isFramebufferTexture, 'color viewport binding must produce a FramebufferTexture' );
	assert.ok( ! tex.isDepthTexture, 'FramebufferTexture must not be a depth texture' );

} );

test( 'registerAuxArtifact: automatically wires viewport texture fallbacks on registration', () => {

	__resetAuxRegistryForTests();

	function DepthTextureStub( w, h ) { this.w = w; this.h = h; this.isDepthTexture = true; this.needsUpdate = false; }
	function FramebufferTextureStub( w, h ) { this.w = w; this.h = h; this.isFramebufferTexture = true; this.needsUpdate = false; }
	setupViewportTextureClasses( { DepthTexture: DepthTextureStub, FramebufferTexture: FramebufferTextureStub } );

	const uuid = 'vp-reg-c';
	const artifact = {
		vertexShader: `@group(1) @binding(0) var nodeUniform20 : texture_depth_2d;`,
		fragmentShader: '',
		uniformPlan: [ {
			name: 'object',
			slots: [],
			textures: [
				{ name: 'nodeUniform20', source: { kind: 'artifact.texture', textureUuid: uuid, mapping: 300 } },
			],
		} ],
	};

	registerAuxArtifact( 'background', 'hash-bg-1', artifact );
	const stored = loadAux( 'background', 'hash-bg-1' );

	assert.ok( stored._textureRefs instanceof Map, 'registered artifact must have _textureRefs' );
	const tex = stored._textureRefs.get( uuid );
	assert.ok( tex && tex.isDepthTexture, 'depth viewport binding must be pre-wired as DepthTexture on registration' );

} );

test( 'hydrator: NodeUniformBuffer seeded from valueSnapshot', () => {

	const snap = [ 1.5, 2.5, 3.5, 4.5 ];
	const ubEntry = { name: 'postProcessUBO', byteLength: 16, arrayType: 'Float32Array', valueSnapshot: snap, visibility: 3 };

	const artifact = {
		vertexShader: '', fragmentShader: '',
		bindings: [ { name: 'postProcessUBO', bindings: [ { name: 'postProcessUBO', kind: 'uniform-buffer', visibility: 3, byteLength: 16 } ] } ],
		uniformPlan: [ {
			name: 'postProcessUBO', shared: false, slots: [],
			textures: [],
			orderedBindings: [ { type: 'buffer-uniform', ref: ubEntry } ],
		} ],
	};

	const state = hydrateNodeBuilderState( artifact );
	const ub = state.bindings[ 0 ].bindings[ 0 ];
	const view = new DataView( ub.buffer.buffer );
	assert.ok( Math.abs( view.getFloat32( 0, true ) - 1.5 ) < 0.001, 'seed[0] = 1.5' );
	assert.ok( Math.abs( view.getFloat32( 4, true ) - 2.5 ) < 0.001, 'seed[1] = 2.5' );
	assert.ok( Math.abs( view.getFloat32( 8, true ) - 3.5 ) < 0.001, 'seed[2] = 3.5' );
	assert.ok( Math.abs( view.getFloat32( 12, true ) - 4.5 ) < 0.001, 'seed[3] = 4.5' );

} );

test( 'hydrator: builtin.ltcTexture resolves a 64x64 HalfFloat DataTexture from artifact.ltcTextures', () => {

	// Simulate half-float LTC data: 64*64*4 = 16384 uint16 values
	// Use non-zero values so we can verify the data reaches the texture.
	const ltcData = new Array( 64 * 64 * 4 ).fill( 0 );
	ltcData[ 0 ] = 15360; // half-float 1.0
	ltcData[ 1 ] = 0;
	ltcData[ 2 ] = 0;
	ltcData[ 3 ] = 15360; // half-float 1.0

	const artifact = {
		vertexShader: '',
		fragmentShader: '',
		bindings: [ {
			name: 'scene',
			bindings: [
				{ name: 'ltcTex1', kind: 'sampled-texture', visibility: 2, textureType: '2d' },
				{ name: 'ltcTex1_sampler', kind: 'sampler', visibility: 2 },
			],
		} ],
		uniformPlan: [ {
			name: 'scene',
			shared: false,
			slots: [],
			textures: [
				{
					name: 'ltcTex1',
					bindingKind: 'sampled-texture',
					textureType: '2d',
					visibility: 2,
					source: { kind: 'builtin.ltcTexture', ltcIndex: 0 },
				},
				{
					name: 'ltcTex1_sampler',
					bindingKind: 'sampler',
					textureType: '2d',
					visibility: 2,
					source: { kind: 'builtin.ltcTexture', ltcIndex: 0 },
				},
			],
		} ],
		ltcTextures: [ ltcData ],
	};

	const state = hydrateNodeBuilderState( artifact );
	assert.equal( state.bindings.length, 1 );
	const bindings = state.bindings[ 0 ].bindings;
	const texBinding = bindings.find( b => b.isSampledTexture );
	assert.ok( texBinding, 'must produce a SampledTexture binding' );
	const tex = texBinding.texture;
	assert.ok( tex && tex.isDataTexture, 'bound texture must be a DataTexture' );
	// HalfFloatType = 1016
	assert.equal( tex.type, 1016, 'LTC texture must use HalfFloatType (1016)' );
	assert.equal( tex.image.width, 64 );
	assert.equal( tex.image.height, 64 );
	assert.ok( tex.image.data instanceof Uint16Array, 'data must be Uint16Array for half-float' );
	assert.equal( tex.image.data[ 0 ], 15360, 'first half-float value must survive round-trip' );

} );

test( 'hydrator: builtin.ltcTexture caches texture per ltcIndex to avoid re-allocation', () => {

	const ltcData = new Array( 64 * 64 * 4 ).fill( 0 );

	const artifact = {
		vertexShader: '', fragmentShader: '',
		// Include real bindings so resolveTextureBinding is actually invoked.
		bindings: [ {
			name: 'g',
			bindings: [
				{ name: 'ltc1', kind: 'sampled-texture', visibility: 2, textureType: '2d' },
				{ name: 'ltc2', kind: 'sampled-texture', visibility: 2, textureType: '2d' },
			],
		} ],
		uniformPlan: [ {
			name: 'g', shared: false, slots: [],
			textures: [
				{ name: 'ltc1', bindingKind: 'sampled-texture', textureType: '2d', visibility: 2,
				  source: { kind: 'builtin.ltcTexture', ltcIndex: 0 } },
				{ name: 'ltc2', bindingKind: 'sampled-texture', textureType: '2d', visibility: 2,
				  source: { kind: 'builtin.ltcTexture', ltcIndex: 0 } },
			],
		} ],
		ltcTextures: [ ltcData ],
	};

	hydrateNodeBuilderState( artifact );
	// Hydrate again — cache must already exist and not grow.
	hydrateNodeBuilderState( artifact );
	// Both hydrations share the _ltcTextureCache on the artifact.
	assert.ok( artifact._ltcTextureCache instanceof Map, 'must create _ltcTextureCache' );
	assert.equal( artifact._ltcTextureCache.size, 1, 'only one unique index 0' );

} );

// ─────────────────────────────────────────────────────────────────────────────
// Task mrt-pass-aux: PassNode.setMRT + getTexture stubs
// ─────────────────────────────────────────────────────────────────────────────

test( 'slim-stubs: PassNode.setMRT stores the mrt descriptor and returns this', () => {

	const pass = new PassNode( PassNode.COLOR, null, null );
	const mrtDescriptor = { isNode: true, outputNodes: { output: {}, normal: {} } };
	const result = pass.setMRT( mrtDescriptor );

	assert.equal( result, pass, 'setMRT must return this for chaining' );
	assert.equal( pass._mrt, mrtDescriptor, 'setMRT must store mrtNode in _mrt' );

} );

test( 'slim-stubs: PassNode.getTexture returns an inert node stub', () => {

	const pass = new PassNode();
	const tex = pass.getTexture( 'output' );

	assert.ok( tex, 'getTexture must return a value' );
	// The returned stub must support chaining (node-like property access)
	assert.ok( tex.isNode, 'stub must have isNode = true' );
	// Must not throw on further property access
	assert.doesNotThrow( () => tex.xy, 'chained property access must not throw' );

} );

test( 'slim-stubs: PassNode chaining: setMRT returns this, getTexture is chainable', () => {

	const pass = new PassNode();
	const mrtDesc = { isNode: true };
	assert.equal( pass.setMRT( mrtDesc ).setSize( 512, 512 ), pass, 'chaining setMRT().setSize() must return pass' );

} );

// ─────────────────────────────────────────────────────────────────────────────
// Task mrt-tsl-stub-leak: TSL function exports from slim-stubs.js
// ─────────────────────────────────────────────────────────────────────────────

test( 'slim-stubs: mrt() returns an inert node stub without throwing', () => {

	const result = mrt( { output: {}, normal: {} } );
	assert.ok( result, 'mrt() must return a value' );
	assert.ok( result.isNode, 'mrt() result must have isNode=true' );
	// Must be chainable without throwing
	assert.doesNotThrow( () => result.mul( 2 ), 'mrt result must be chainable' );

} );

test( 'slim-stubs: mix() returns an inert node stub without throwing', () => {

	assert.doesNotThrow( () => mix( {}, {}, 0.5 ), 'mix() must not throw' );
	const result = mix( {}, {}, 0.5 );
	assert.ok( result, 'mix() must return a value' );

} );

test( 'slim-stubs: step() returns an inert node stub without throwing', () => {

	assert.doesNotThrow( () => step( 0.5, {} ), 'step() must not throw' );

} );

test( 'slim-stubs: texture() returns an inert node stub without throwing', () => {

	assert.doesNotThrow( () => texture( {} ), 'texture() must not throw' );

} );

test( 'slim-stubs: normalWorld is an inert node stub with isNode=true', () => {

	assert.ok( normalWorld, 'normalWorld must be exported' );
	assert.ok( normalWorld.isNode, 'normalWorld must have isNode=true' );

} );

test( 'slim-stubs: screenUV is an inert node stub, chainable for .mul()', () => {

	assert.ok( screenUV, 'screenUV must be exported' );
	assert.ok( screenUV.isNode, 'screenUV must have isNode=true' );
	// screenUV.mul(40) is a common pattern in examples
	assert.doesNotThrow( () => screenUV.mul( 40 ), 'screenUV.mul() must not throw' );

} );

// ─────────────────────────────────────────────────────────────────────────────
// Task mrt-pass-aux: attachMRTTextureRefs in aux-loader
// ─────────────────────────────────────────────────────────────────────────────

test( 'aux-loader: attachMRTTextureRefs wires render-target textures by name', () => {

	const outputTex = { isTexture: true, uuid: 'mrt-output-uuid' };
	const normalTex = { isTexture: true, uuid: 'mrt-normal-uuid' };

	// Simulate an MRT artifact with two texture bindings
	const artifact = {
		vertexShader: '',
		fragmentShader: '',
		uniformPlan: [ {
			name: 'object',
			slots: [],
			textures: [
				{ name: 'output', source: { kind: 'artifact.texture', textureUuid: 'captured-output-uuid' } },
				{ name: 'normal', source: { kind: 'artifact.texture', textureUuid: 'captured-normal-uuid' } },
			],
		} ],
		mrt: { outputNames: [ 'output', 'normal' ] },
	};

	// Simulate a render target with two textures
	const renderTarget = {
		textures: [ outputTex, normalTex ],
	};

	attachMRTTextureRefs( artifact, renderTarget );

	assert.ok( artifact._textureRefs instanceof Map, '_textureRefs must be set' );
	assert.equal( artifact._textureRefs.get( 'captured-output-uuid' ), outputTex, 'output texture must be wired to index 0' );
	assert.equal( artifact._textureRefs.get( 'captured-normal-uuid' ), normalTex, 'normal texture must be wired to index 1' );

} );

test( 'aux-loader: attachMRTTextureRefs handles missing renderTarget gracefully', () => {

	const artifact = {
		uniformPlan: [ { name: 'object', slots: [], textures: [] } ],
		mrt: { outputNames: [] },
	};

	assert.doesNotThrow( () => attachMRTTextureRefs( artifact, null ) );
	assert.doesNotThrow( () => attachMRTTextureRefs( null, {} ) );

} );

// ─────────────────────────────────────────────────────────────────────────────
// Task storage-texture-3d: Storage3DTexture / StorageArrayTexture binding
// ─────────────────────────────────────────────────────────────────────────────

test( 'storage-texture: resolves Storage3DTexture binding by textureName', async () => {

	clearLiveTextureIndex();

	// Simulate a Storage3DTexture created at runtime with .name = 'cloud'.
	// Import lazily to avoid top-level ESM issues in the test file.
	const { default: Storage3DTexture } = await import( 'three/src/renderers/common/Storage3DTexture.js' );
	const cloudTex = new Storage3DTexture( 128, 128, 128 );
	cloudTex.name = 'cloud';

	// Give the microtask queue a tick so the prototype-patch setter can call
	// registerLiveTexture (it defers via Promise.resolve().then(...)).
	await new Promise( resolve => setTimeout( resolve, 0 ) );

	const artifact = {
		vertexShader: '',
		fragmentShader: '@group(1) @binding(0) var cloud : texture_3d<f32>;',
		computeShader: '',
		bindings: [ {
			name: 'compute',
			bindings: [
				{ name: 'cloud', kind: 'sampled-texture', visibility: 4, textureType: '3d' },
			],
		} ],
		uniformPlan: [ {
			name: 'compute',
			shared: false,
			slots: [],
			textures: [
				{
					name: 'cloud',
					bindingKind: 'sampled-texture',
					textureType: '3d',
					access: 'readOnly',
					visibility: 4,
					source: { kind: 'artifact.texture', textureUuid: 'dead-uuid-cloud', textureName: 'cloud' },
				},
			],
		} ],
	};

	const state = hydrateNodeBuilderState( artifact );
	assert.equal( state.bindings.length, 1 );
	const binding = state.bindings[ 0 ].bindings[ 0 ];
	assert.ok( binding.isSampled3DTexture, 'must produce a Sampled3DTexture binding' );
	assert.ok( binding.isSampledTexture3D, 'isSampledTexture3D must also be true' );
	assert.equal( binding.texture, cloudTex, 'must resolve to the live Storage3DTexture registered by name' );
	assert.ok( binding.texture.is3DTexture, 'resolved texture must be a 3D texture' );

	clearLiveTextureIndex();

} );

test( 'storage-texture: falls back to blank Storage3DTexture when not registered', () => {

	clearLiveTextureIndex();

	// No live Storage3DTexture is registered — hydrator must fall back to a
	// white 1×1×1 Data3DTexture (the module-level fallback3DTexture).
	const artifact = {
		vertexShader: '',
		fragmentShader: '@group(1) @binding(0) var cloud : texture_3d<f32>;',
		computeShader: '',
		bindings: [ {
			name: 'compute',
			bindings: [
				{ name: 'cloud', kind: 'sampled-texture', visibility: 4, textureType: '3d' },
			],
		} ],
		uniformPlan: [ {
			name: 'compute',
			shared: false,
			slots: [],
			textures: [
				{
					name: 'cloud',
					bindingKind: 'sampled-texture',
					textureType: '3d',
					access: 'readOnly',
					visibility: 4,
					source: { kind: 'artifact.texture', textureUuid: 'dead-uuid-cloud-2', textureName: 'cloud-unknown' },
				},
			],
		} ],
	};

	const state = hydrateNodeBuilderState( artifact );
	const binding = state.bindings[ 0 ].bindings[ 0 ];
	assert.ok( binding.isSampled3DTexture, 'must still produce a Sampled3DTexture binding' );
	assert.ok( binding.isSampledTexture3D, 'isSampledTexture3D must also be true' );
	// When no named texture matches, the fallback is the module-level fallback3DTexture
	// which is a Data3DTexture (isData3DTexture = true).
	assert.ok( binding.texture && ( binding.texture.is3DTexture || binding.texture.isData3DTexture ), 'fallback must still be a 3D texture' );

} );

// ─────────────────────────────────────────────────────────────────────────────
// Anonymous DataTexture fallback for trivial-zeros snapshots — covers the
// webgpu_compute_audio case where analyserTexture is captured before any audio
// playback. The captured snapshot is all-zeros, but a unique live DataTexture
// of matching shape exists; the hydrator should bind the live one.
// ─────────────────────────────────────────────────────────────────────────────

test( 'hydrator: anonymous DataTexture by shape replaces trivial-zeros snapshot', async () => {

	clearLiveTextureIndex();

	const { DataTexture, RedFormat, UnsignedByteType } = await import( 'three' );
	const live = new DataTexture( new Uint8Array( 1024 ), 1024, 1, RedFormat, UnsignedByteType );
	live.needsUpdate = true;

	// The prototype-patched setter defers registration via Promise.resolve().then(...).
	await new Promise( resolve => setTimeout( resolve, 0 ) );

	const snapshot = {
		width: 1024,
		height: 1,
		arrayType: 'Uint8Array',
		data: new Array( 1024 ).fill( 0 ),
		format: RedFormat,
		type: UnsignedByteType,
		flipY: false,
	};
	const artifact = {
		vertexShader: '',
		fragmentShader: '@group(1) @binding(0) var nodeUniform0 : texture_2d<f32>;',
		bindings: [ {
			name: 'object',
			bindings: [
				{ name: 'nodeUniform0', kind: 'sampled-texture', visibility: 2, textureType: '2d' },
			],
		} ],
		uniformPlan: [ {
			name: 'object',
			slots: [],
			textures: [
				{ name: 'nodeUniform0', source: { kind: 'artifact.texture', textureUuid: 'dead-uuid-audio', snapshot } },
			],
		} ],
	};

	const state = hydrateNodeBuilderState( artifact );
	const binding = state.bindings[ 0 ].bindings[ 0 ];
	assert.equal( binding.texture, live, 'must bind the live anonymous DataTexture, not a snapshot copy' );

	clearLiveTextureIndex();

} );

test( 'hydrator: anonymous DataTexture fallback skipped when snapshot has real data', async () => {

	clearLiveTextureIndex();

	const { DataTexture, RedFormat, UnsignedByteType } = await import( 'three' );
	const live = new DataTexture( new Uint8Array( 4 ), 2, 1, RedFormat, UnsignedByteType );
	live.needsUpdate = true;
	await new Promise( resolve => setTimeout( resolve, 0 ) );

	// Snapshot has > 1% non-zero bytes — not trivial, must use snapshot.
	const snapshot = {
		width: 2,
		height: 1,
		arrayType: 'Uint8Array',
		data: [ 255, 128, 64, 32 ],
		format: RedFormat,
		type: UnsignedByteType,
	};
	const artifact = {
		vertexShader: '',
		fragmentShader: '@group(1) @binding(0) var nodeUniform0 : texture_2d<f32>;',
		bindings: [ {
			name: 'object',
			bindings: [
				{ name: 'nodeUniform0', kind: 'sampled-texture', visibility: 2, textureType: '2d' },
			],
		} ],
		uniformPlan: [ {
			name: 'object',
			slots: [],
			textures: [
				{ name: 'nodeUniform0', source: { kind: 'artifact.texture', textureUuid: 'dead-uuid-static', snapshot } },
			],
		} ],
	};

	const state = hydrateNodeBuilderState( artifact );
	const binding = state.bindings[ 0 ].bindings[ 0 ];
	assert.notEqual( binding.texture, live, 'snapshot has real data — must not collapse to live texture' );
	assert.equal( binding.texture.image.data[ 0 ], 255 );

	clearLiveTextureIndex();

} );

test( 'hydrator: anonymous DataTexture fallback bails on shape ambiguity', async () => {

	clearLiveTextureIndex();

	const { DataTexture, RedFormat, UnsignedByteType } = await import( 'three' );
	const liveA = new DataTexture( new Uint8Array( 1024 ), 1024, 1, RedFormat, UnsignedByteType );
	liveA.needsUpdate = true;
	const liveB = new DataTexture( new Uint8Array( 1024 ), 1024, 1, RedFormat, UnsignedByteType );
	liveB.needsUpdate = true;
	await new Promise( resolve => setTimeout( resolve, 0 ) );

	const snapshot = {
		width: 1024,
		height: 1,
		arrayType: 'Uint8Array',
		data: new Array( 1024 ).fill( 0 ),
		format: RedFormat,
		type: UnsignedByteType,
	};
	const artifact = {
		vertexShader: '',
		fragmentShader: '@group(1) @binding(0) var nodeUniform0 : texture_2d<f32>;',
		bindings: [ {
			name: 'object',
			bindings: [
				{ name: 'nodeUniform0', kind: 'sampled-texture', visibility: 2, textureType: '2d' },
			],
		} ],
		uniformPlan: [ {
			name: 'object',
			slots: [],
			textures: [
				{ name: 'nodeUniform0', source: { kind: 'artifact.texture', textureUuid: 'dead-uuid-ambig', snapshot } },
			],
		} ],
	};

	const state = hydrateNodeBuilderState( artifact );
	const binding = state.bindings[ 0 ].bindings[ 0 ];
	assert.notEqual( binding.texture, liveA, 'ambiguous shape — must not pick liveA' );
	assert.notEqual( binding.texture, liveB, 'ambiguous shape — must not pick liveB' );
	assert.equal( binding.texture.isDataTexture, true, 'falls back to a snapshot DataTexture' );

	clearLiveTextureIndex();

} );

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1: Node-graph texture cataloguing — `material.colorNode = texture(t)`
// must be picked up so the hydrator's UUID lookup hits the live Texture
// instead of falling through to the 1×1 white fallback.
// ─────────────────────────────────────────────────────────────────────────────

test( 'collectLiveMaterialTextures: catalogues hardcoded property textures', () => {

	const map = { isTexture: true, uuid: 'tex-map' };
	const envMap = { isTexture: true, uuid: 'tex-env' };
	const out = collectLiveMaterialTextures( { map, envMap } );

	assert.equal( out.size, 2 );
	assert.equal( out.get( 'tex-map' ), map );
	assert.equal( out.get( 'tex-env' ), envMap );

} );

test( 'collectLiveMaterialTextures: walks TextureNodes embedded in colorNode', () => {

	// material.colorNode = texture(myTex) shape: top-level node IS a TextureNode.
	const tex = { isTexture: true, uuid: 'tex-color-node' };
	const colorNode = { isTextureNode: true, value: tex };
	const out = collectLiveMaterialTextures( { colorNode } );

	assert.equal( out.size, 1 );
	assert.equal( out.get( 'tex-color-node' ), tex );

} );

test( 'collectLiveMaterialTextures: walks TextureNodes buried inside node.traverse()', () => {

	// material.colorNode = mix(texture(a), texture(b), 0.5) shape: a wrapper
	// node whose .traverse() visits child nodes.
	const texA = { isTexture: true, uuid: 'tex-a' };
	const texB = { isTexture: true, uuid: 'tex-b' };
	const childA = { isTextureNode: true, value: texA };
	const childB = { isTextureNode: true, value: texB };
	const colorNode = {
		isNode: true,
		traverse( cb ) {

			cb( childA );
			cb( childB );

		},
	};
	const out = collectLiveMaterialTextures( { colorNode } );

	assert.equal( out.size, 2 );
	assert.equal( out.get( 'tex-a' ), texA );
	assert.equal( out.get( 'tex-b' ), texB );

} );

test( 'collectLiveMaterialTextures: deduplicates a texture present in both a property slot and a node graph', () => {

	const tex = { isTexture: true, uuid: 'tex-shared' };
	const out = collectLiveMaterialTextures( {
		map: tex,
		colorNode: { isTextureNode: true, value: tex },
	} );

	assert.equal( out.size, 1 );
	assert.equal( out.get( 'tex-shared' ), tex );

} );

test( 'catalogueArtifactTextureRefs: stamps node-graph TextureNode uuids onto _textureRefs', () => {

	// The artifact's uniformPlan claims two textureUuids — one matches a
	// hardcoded `material.map`, the other only exists inside `colorNode`.
	const mapTex = { isTexture: true, uuid: 'uuid-map' };
	const nodeTex = { isTexture: true, uuid: 'uuid-node' };
	const sourceMaterial = {
		map: mapTex,
		colorNode: { isTextureNode: true, value: nodeTex },
	};
	const artifact = {
		uniformPlan: [ {
			name: 'object',
			textures: [
				{ name: 'mapTex', source: { kind: 'artifact.texture', textureUuid: 'uuid-map' } },
				{ name: 'colorNodeTex', source: { kind: 'artifact.texture', textureUuid: 'uuid-node' } },
			],
		} ],
	};

	const added = catalogueArtifactTextureRefs( artifact, sourceMaterial );

	assert.equal( added, 2 );
	assert.ok( artifact._textureRefs instanceof Map );
	assert.equal( artifact._textureRefs.get( 'uuid-map' ), mapTex );
	assert.equal( artifact._textureRefs.get( 'uuid-node' ), nodeTex, 'node-graph TextureNode uuid must be catalogued' );

} );
