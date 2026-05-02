import { test } from 'node:test';
import assert from 'node:assert/strict';

import { registerArtifact, getArtifact } from '../src/artifact-loader.js';
import { hydrateNodeBuilderState } from '../src/hydrator.js';
import { __applyPrecompiled } from '../src/apply-precompiled.js';
import PrecompiledMaterial from '../src/_vendor-PrecompiledMaterial.js';
import { PrecompiledComputeNode } from '../src/precompiled-compute-node.js';
import {
	wireViewportTextureRefs,
	setupViewportTextureClasses,
	registerAuxArtifact,
	loadAux,
	__resetAuxRegistryForTests,
} from '../src/aux-loader.js';

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
