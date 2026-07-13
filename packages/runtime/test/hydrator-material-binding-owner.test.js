import test from 'node:test';
import assert from 'node:assert/strict';
import { BufferAttribute } from 'three/src/core/BufferAttribute.js';
import StorageBufferAttribute from 'three/src/renderers/common/StorageBufferAttribute.js';
import { DataTexture } from 'three/src/textures/DataTexture.js';
import { VideoTexture } from 'three/src/textures/VideoTexture.js';

import { hydrateNodeBuilderState } from '../src/hydrator.js';
import { MATERIAL_BINDING_OWNER_UNAVAILABLE } from '../src/hydrate/material-binding-owner.js';
import PrecompiledMaterial from '../src/_vendor-PrecompiledMaterial.js';
import { createReplayShadowMaterial } from '../src/slim-replay-shadow-material.js';
import { clearLiveUniformRegistryForTests, registerLiveUniformNode } from '../src/slim-support/live-uniform-registry.js';

function texture( name ) {

	const value = new DataTexture();
	value.name = name;
	return value;

}

function shadowArtifact( overrides = {} ) {

	return {
		name: 'owned-shadow',
		materialShape: 'shadow-depth',
		bindingOwner: 'shadow-caster',
		vertexShader: 'vertex',
		fragmentShader: [
			'@group(0) @binding(1) var mapSampler : sampler;',
			'@group(0) @binding(2) var mapTexture : texture_2d<f32>;',
			'@group(0) @binding(3) var graphSampler : sampler;',
			'@group(0) @binding(4) var graphTexture : texture_2d<f32>;',
		].join( '\n' ),
		bindings: [ {
			name: 'object',
			bindings: [
				{ name: 'object', kind: 'uniform-buffer', visibility: 7, byteLength: 16 },
				{ name: 'mapSampler', kind: 'sampler', visibility: 2 },
				{ name: 'mapTexture', kind: 'sampled-texture', visibility: 2, textureType: '2d' },
				{ name: 'graphSampler', kind: 'sampler', visibility: 2 },
				{ name: 'graphTexture', kind: 'sampled-texture', visibility: 2, textureType: '2d' },
			],
		} ],
		uniformPlan: [ {
			name: 'object',
			shared: false,
			byteLength: 16,
			slots: [
				{ offset: 0, dtype: 'number', source: { kind: 'material.alphaTest', property: 'alphaTest', valueSnapshot: { type: 'number', data: 0 } } },
				{ offset: 4, dtype: 'number', source: { kind: 'material.opacity', property: 'opacity', bindingOwner: 'render-material', valueSnapshot: { type: 'number', data: 1 } } },
			],
			textures: [
				{ name: 'mapSampler', source: { kind: 'material.map', property: 'map' } },
				{ name: 'mapTexture', source: { kind: 'material.map', property: 'map' } },
				{ name: 'graphSampler', source: { kind: 'artifact.texture', textureUuid: 'captured-graph' } },
				{ name: 'graphTexture', source: { kind: 'artifact.texture', textureUuid: 'captured-graph' } },
			],
		} ],
		...overrides,
	};

}

function replayFixture( artifact ) {

	const staleMap = texture( 'stale override map' );
	const casterMap = texture( 'caster map' );
	const graphTexture = texture( 'caster graph texture' );
	graphTexture.uuid = 'captured-graph';
	const caster = {
		alphaTest: 0.625,
		opacity: 0.875,
		map: casterMap,
		castShadowNode: { isNode: true, value: graphTexture },
	};
	const base = new PrecompiledMaterial( artifact );
	base.isShadowPassMaterial = true;
	base.alphaTest = 0.125;
	base.opacity = 0.25;
	base.map = staleMap;
	const material = createReplayShadowMaterial( base, caster );
	const object = { material: caster, geometry: { attributes: {} } };
	const renderObject = { material, object, group: null };
	return { base, caster, casterMap, graphTexture, material, object, renderObject, staleMap };

}

test( 'shadow owner overlay keeps generated updater fast path with mixed owners', () => {

	const artifact = shadowArtifact( {
		bindings: [ { name: 'object', bindings: [ { name: 'object', kind: 'uniform-buffer', visibility: 7, byteLength: 16 } ] } ],
		uniformPlan: [ {
			name: 'object', shared: false, byteLength: 16,
			slots: [
				{ offset: 0, dtype: 'number', source: { kind: 'material.alphaTest', property: 'alphaTest' } },
				{ offset: 4, dtype: 'number', source: { kind: 'material.opacity', property: 'opacity', bindingOwner: 'render-material' } },
			],
			textures: [],
		} ],
	} );
	let generatedCalls = 0;
	Object.defineProperty( artifact, '_generatedUpdateGroup', {
		value( _frame, material, view ) {

			generatedCalls ++;
			view.setFloat32( 0, material.alphaTest, true );
			view.setFloat32( 4, material.opacity, true );

		},
	} );
	const fixture = replayFixture( artifact );
	const state = hydrateNodeBuilderState( artifact, fixture.material, fixture.object, { renderObject: fixture.renderObject } );
	const uniformBuffer = state.bindings[ 0 ].bindings[ 0 ];
	const frame = { material: fixture.material, object: fixture.object, renderObject: fixture.renderObject };
	state.updateNodes[ 0 ].update( frame );
	const view = new DataView( uniformBuffer.buffer.buffer );
	assert.equal( generatedCalls, 1 );
	assert.equal( view.getFloat32( 0, true ), fixture.caster.alphaTest );
	assert.equal( view.getFloat32( 4, true ), fixture.base.opacity );

	fixture.caster.alphaTest = 0.75;
	fixture.base.opacity = 0.375;
	state.updateNodes[ 0 ].update( frame );
	assert.equal( view.getFloat32( 0, true ), 0.75 );
	assert.equal( view.getFloat32( 4, true ), 0.375 );

} );

test( 'legacy shadow graph lookup reads the live shared override behind a graph-free replay material', () => {

	const artifact = shadowArtifact();
	delete artifact.bindingOwner;
	const fixture = replayFixture( artifact );
	fixture.base.colorNode = fixture.caster.castShadowNode;
	const replay = createReplayShadowMaterial( fixture.base, fixture.caster );
	assert.equal( replay.colorNode, undefined );
	const renderObject = { material: replay, object: fixture.object, group: null };
	const state = hydrateNodeBuilderState( artifact, replay, fixture.object, { renderObject } );
	assert.equal( state.bindings[ 0 ].bindings[ 3 ].texture, fixture.graphTexture );
	assert.equal( state.bindings[ 0 ].bindings[ 4 ].texture, fixture.graphTexture );
	const nextGraphTexture = texture( 'next legacy graph texture' );
	fixture.base.colorNode.value = nextGraphTexture;
	const frame = {
		frameId: 2, renderId: 2, material: replay, object: fixture.object, renderObject,
		renderer: { backend: new WeakMap(), getRenderTarget: () => null },
	};
	for ( const node of state.updateBeforeNodes ) node.updateBefore( frame );
	assert.equal( state.bindings[ 0 ].bindings[ 3 ].texture, nextGraphTexture );
	assert.equal( state.bindings[ 0 ].bindings[ 4 ].texture, nextGraphTexture );

} );

test( 'render-material sources stay live on the renderer-owned shadow override', () => {

	const artifact = shadowArtifact( {
		bindings: [ { name: 'object', bindings: [ { name: 'object', kind: 'uniform-buffer', visibility: 7, byteLength: 16 } ] } ],
		uniformPlan: [ {
			name: 'object', shared: false, byteLength: 16,
			slots: [
				{ offset: 0, dtype: 'number', source: { kind: 'material.opacity', property: 'opacity', bindingOwner: 'render-material' } },
			],
			textures: [],
		} ],
	} );
	Object.defineProperty( artifact, '_generatedUpdateGroup', {
		value( _frame, material, view ) {

			view.setFloat32( 0, material.opacity, true );

		},
	} );
	const fixture = replayFixture( artifact );
	const state = hydrateNodeBuilderState( artifact, fixture.material, fixture.object, { renderObject: fixture.renderObject } );
	const uniformBuffer = state.bindings[ 0 ].bindings[ 0 ];
	const frame = { material: fixture.material, object: fixture.object, renderObject: fixture.renderObject };

	fixture.base.opacity = 0.625;
	assert.equal( createReplayShadowMaterial( fixture.base, fixture.caster ), fixture.material, 'next draw reuses the stable caster replay material' );
	state.updateNodes[ 0 ].update( frame );
	assert.equal( new DataView( uniformBuffer.buffer.buffer ).getFloat32( 0, true ), fixture.base.opacity );

} );

test( 'shadow frame stamping keeps overlay-local skeleton and instance buffer resolvers live', () => {

	const artifact = shadowArtifact( {
		bindings: [ {
			name: 'object',
			bindings: [
				{ name: 'object', kind: 'uniform-buffer', visibility: 7, byteLength: 16 },
				{ name: 'UniformBuffer_bones', kind: 'uniform-buffer', visibility: 1, byteLength: 16 },
			],
		} ],
		uniformPlan: [ {
			name: 'object', shared: false, byteLength: 16,
			slots: [ { offset: 0, dtype: 'number', source: { kind: 'material.alphaTest', property: 'alphaTest' } } ],
			textures: [],
			orderedBindings: [ {
				type: 'buffer-uniform',
				ref: { name: 'UniformBuffer_bones', byteLength: 16, valueSnapshot: [ 0, 0, 0, 0 ] },
			} ],
		} ],
	} );
	const fixture = replayFixture( artifact );
	fixture.object.skeleton = { boneMatrices: new Float32Array( [ 1, 2, 3, 4 ] ) };
	const state = hydrateNodeBuilderState( artifact, fixture.material, fixture.object, { renderObject: fixture.renderObject } );
	const frame = { frameId: 1, material: fixture.material, object: fixture.object, renderObject: fixture.renderObject };
	state.updateNodes[ 0 ].update( frame );
	const bones = state.bindings[ 0 ].bindings[ 1 ];
	bones.update();
	assert.deepEqual( Array.from( bones.buffer ), [ 1, 2, 3, 4 ] );
	assert.equal( fixture.material.__tslpCurrentFrame, frame, 'overlay-local live array resolver sees the frame' );
	assert.equal( fixture.base.__tslpCurrentFrame, frame, 'render-material owner sees the frame' );
	assert.equal( fixture.caster.__tslpCurrentFrame, frame, 'caster-owned sources see the frame' );

} );

test( 'caster graph attributes and storage buffers stay local to each hydrated shadow state', () => {

	const artifact = shadowArtifact( {
		bindings: [ {
			name: 'object',
			bindings: [ { name: 'graphStorage', kind: 'storage-buffer', visibility: 1, access: 'read_write' } ],
		} ],
		uniformPlan: [ {
			name: 'object', shared: false, byteLength: 0, slots: [], textures: [],
			orderedBindings: [ { type: 'storage-buffer', ref: {
				name: 'graphStorage', itemSize: 4, count: 1, arrayType: 'Float32Array', userPath: [ 'colorNode' ],
			} } ],
		} ],
		attributes: [ {
			name: 'graphPosition', source: 'node', type: 'vec3', itemSize: 3, count: 1,
			arrayType: 'Float32Array', storage: false, userPath: [ 'positionNode' ],
		} ],
	} );
	const node = ( attribute ) => ( {
		isNode: true,
		attribute,
		value: attribute,
		traverse( callback ) { callback( this ); },
	} );
	const attributeA = new BufferAttribute( new Float32Array( [ 1, 2, 3 ] ), 3 );
	const attributeB = new BufferAttribute( new Float32Array( [ 4, 5, 6 ] ), 3 );
	const storageA = new StorageBufferAttribute( new Float32Array( [ 1, 2, 3, 4 ] ), 4 );
	const storageB = new StorageBufferAttribute( new Float32Array( [ 5, 6, 7, 8 ] ), 4 );
	Object.defineProperty( artifact.attributes[ 0 ], '_liveAttribute', { value: attributeA } );
	Object.defineProperty( artifact.uniformPlan[ 0 ].orderedBindings[ 0 ].ref, '_liveAttribute', { value: storageA } );
	Object.freeze( artifact.attributes[ 0 ] );
	Object.freeze( artifact.attributes );
	Object.freeze( artifact.uniformPlan[ 0 ].orderedBindings[ 0 ].ref );
	Object.freeze( artifact.uniformPlan[ 0 ].orderedBindings[ 0 ] );
	Object.freeze( artifact.uniformPlan[ 0 ].orderedBindings );
	Object.freeze( artifact.uniformPlan[ 0 ] );
	Object.freeze( artifact.uniformPlan );
	Object.freeze( artifact );
	const casterA = { positionNode: node( attributeA ), colorNode: node( storageA ) };
	const casterB = { positionNode: node( attributeB ), colorNode: node( storageB ) };
	const base = new PrecompiledMaterial( artifact );
	base.isShadowPassMaterial = true;
	const replayA = createReplayShadowMaterial( base, casterA );
	const replayB = createReplayShadowMaterial( base, casterB );
	const objectA = { material: casterA, geometry: { attributes: {} } };
	const objectB = { material: casterB, geometry: { attributes: {} } };
	const stateA = hydrateNodeBuilderState( artifact, replayA, objectA, {
		renderObject: { material: replayA, object: objectA, group: null },
	} );
	const stateB = hydrateNodeBuilderState( artifact, replayB, objectB, {
		renderObject: { material: replayB, object: objectB, group: null },
	} );
	const casterWithoutGraphPaths = {};
	const replayWithoutGraphPaths = createReplayShadowMaterial( base, casterWithoutGraphPaths );
	const objectWithoutGraphPaths = { material: casterWithoutGraphPaths, geometry: { attributes: {} } };
	const fallbackState = hydrateNodeBuilderState( artifact, replayWithoutGraphPaths, objectWithoutGraphPaths, {
		renderObject: { material: replayWithoutGraphPaths, object: objectWithoutGraphPaths, group: null },
	} );

	assert.deepEqual( {
		attributeA: stateA.nodeAttributes[ 0 ].node.attribute === attributeA,
		attributeB: stateB.nodeAttributes[ 0 ].node.attribute === attributeB,
		storageA: stateA.bindings[ 0 ].bindings[ 0 ].attribute === storageA,
		storageB: stateB.bindings[ 0 ].bindings[ 0 ].attribute === storageB,
		attributeFallbackIsForeign: fallbackState.nodeAttributes[ 0 ].node.attribute === attributeA,
		storageFallbackIsForeign: fallbackState.bindings[ 0 ].bindings[ 0 ].attribute === storageA,
	}, {
		attributeA: true,
		attributeB: true,
		storageA: true,
		storageB: true,
		attributeFallbackIsForeign: false,
		storageFallbackIsForeign: false,
	} );

} );

test( 'caster uniform.live node paths replace artifact-global live sidecars per hydrated state', () => {

	const artifact = shadowArtifact( {
		bindings: [ { name: 'object', bindings: [ { name: 'object', kind: 'uniform-buffer', visibility: 7, byteLength: 16 } ] } ],
		uniformPlan: [ {
			name: 'object', shared: false, byteLength: 16, textures: [],
			slots: [ {
				offset: 0, dtype: 'number',
				source: {
					kind: 'uniform.live', liveNodeId: 0,
					nodePath: [ 'castShadowNode', 'uniform' ],
					valueSnapshot: { type: 'number', data: 0 },
				},
			} ],
		} ],
	} );
	const uniformA = { isNode: true, isUniformNode: true, value: 1 };
	const uniformB = { isNode: true, isUniformNode: true, value: 9 };
	let updatesA = 0;
	let updatesB = 0;
	const updateNode = ( uniform, update ) => ( {
		isNode: true,
		uniform,
		getUpdateType: () => 'object',
		updateReference() { return this; },
		update,
	} );
	const casterA = { castShadowNode: updateNode( uniformA, () => updatesA ++ ) };
	const casterB = { castShadowNode: updateNode( uniformB, () => updatesB ++ ) };
	const rootSlot = artifact.uniformPlan[ 0 ].slots[ 0 ];
	Object.defineProperty( rootSlot, '_liveNode', { value: uniformA, configurable: true } );
	Object.defineProperty( rootSlot, '__tslpLiveSidecarOverlay', { value: true, configurable: true } );
	const base = new PrecompiledMaterial( artifact );
	base.isShadowPassMaterial = true;
	const hydrate = ( caster ) => {

		const replay = createReplayShadowMaterial( base, caster );
		const object = { material: caster, geometry: { attributes: {} } };
		const renderObject = { material: replay, object, group: null };
		const state = hydrateNodeBuilderState( artifact, replay, object, { renderObject } );
		const frame = { material: replay, object, renderObject };
		state.updateNodes[ state.updateNodes.length - 1 ].update( frame );
		return { state, frame };

	};
	const stateA = hydrate( casterA );
	const stateB = hydrate( casterB );
	const value = ( entry ) => new DataView( entry.state.bindings[ 0 ].bindings[ 0 ].buffer.buffer ).getFloat32( 0, true );
	assert.equal( value( stateA ), 1 );
	assert.equal( value( stateB ), 9 );
	assert.equal( rootSlot._liveNode, uniformA, 'shared artifact sidecar stays untouched' );
	for ( const node of stateB.state.updateNodes ) node.update( stateB.frame );
	assert.equal( updatesA, 0 );
	assert.equal( updatesB, 1, 'only the exact caster update graph is scheduled' );

	uniformB.value = 12;
	stateB.state.updateNodes[ stateB.state.updateNodes.length - 1 ].update( stateB.frame );
	assert.equal( value( stateB ), 12 );

} );

test( 'mixed propertyless uniform.live slots bind from their exact caster and render-material graphs', () => {

	const casterSource = Object.freeze( {
		kind: 'uniform.live', liveNodeId: 0,
		nodePath: [ 'castGraph', 'uniform' ],
		valueSnapshot: { type: 'number', data: - 1 },
	} );
	const baseSource = Object.freeze( {
		kind: 'uniform.live', liveNodeId: 1,
		bindingOwner: 'render-material',
		nodePath: [ 'baseGraph', 'uniform' ],
		valueSnapshot: { type: 'number', data: - 2 },
	} );
	const casterSlot = Object.freeze( { offset: 0, dtype: 'number', source: casterSource } );
	const baseSlot = Object.freeze( { offset: 4, dtype: 'number', source: baseSource } );
	const artifact = shadowArtifact( {
		bindings: [ { name: 'object', bindings: [ { name: 'object', kind: 'uniform-buffer', visibility: 7, byteLength: 16 } ] } ],
		uniformPlan: [ {
			name: 'object', shared: false, byteLength: 16, textures: [],
			slots: [ casterSlot, baseSlot ],
		} ],
	} );
	let generatedCalls = 0;
	Object.defineProperty( artifact, '_generatedUpdateGroup', { value( _frame, _material, view ) {

		generatedCalls ++;
		view.setFloat32( 0, - 1, true );
		view.setFloat32( 4, - 2, true );

	} } );
	const casterUniform = { isNode: true, isUniformNode: true, value: 11 };
	const baseUniform = { isNode: true, isUniformNode: true, value: 22 };
	let casterUpdates = 0;
	let baseUpdates = 0;
	const graph = ( uniform, update ) => ( {
		isNode: true, uniform,
		getUpdateType: () => 'object',
		updateReference() { return this; },
		update,
	} );
	const caster = { castGraph: graph( casterUniform, () => casterUpdates ++ ) };
	const base = new PrecompiledMaterial( artifact );
	base.isShadowPassMaterial = true;
	base.baseGraph = graph( baseUniform, () => baseUpdates ++ );
	const replay = createReplayShadowMaterial( base, caster );
	const object = { material: caster, geometry: { attributes: {} } };
	const renderObject = { material: replay, object, group: null };
	const state = hydrateNodeBuilderState( artifact, replay, object, { renderObject } );
	const frame = { material: replay, object, renderObject };
	for ( const node of state.updateNodes ) node.update( frame );
	const view = new DataView( state.bindings[ 0 ].bindings[ 0 ].buffer.buffer );
	assert.equal( view.getFloat32( 0, true ), 11 );
	assert.equal( view.getFloat32( 4, true ), 22 );
	assert.equal( casterUpdates, 1 );
	assert.equal( baseUpdates, 1 );
	assert.equal( generatedCalls, 1 );
	assert.equal( Object.prototype.hasOwnProperty.call( casterSlot, '_liveNode' ), false );
	assert.equal( Object.prototype.hasOwnProperty.call( baseSlot, '_liveNode' ), false );

	casterUniform.value = 13;
	baseUniform.value = 24;
	for ( const node of state.updateNodes ) node.update( frame );
	assert.equal( view.getFloat32( 0, true ), 13 );
	assert.equal( view.getFloat32( 4, true ), 24 );
	assert.equal( casterUpdates, 2 );
	assert.equal( baseUpdates, 2 );
	assert.equal( generatedCalls, 2 );

} );

test( 'signed caster hydration rejects unscoped closure-uniform registry candidates', () => {

	clearLiveUniformRegistryForTests();
	const foreign = registerLiveUniformNode( { isUniformNode: true, value: 1 } );
	const intended = registerLiveUniformNode( { isUniformNode: true, value: 1 } );
	const artifact = shadowArtifact( {
		bindings: [ { name: 'object', bindings: [ { name: 'object', kind: 'uniform-buffer', visibility: 7, byteLength: 16 } ] } ],
		uniformPlan: [ {
			name: 'object', shared: false, byteLength: 16, textures: [],
			slots: [ {
				offset: 0, dtype: 'number',
				source: {
					kind: 'uniform.live', liveNodeId: 0,
					bindingOwner: 'render-material',
					valueSnapshot: { type: 'number', data: - 7 },
				},
			} ],
		} ],
	} );
	Object.defineProperty( artifact.uniformPlan[ 0 ].slots[ 0 ], '_liveNode', { value: foreign } );
	const caster = { castShadowNode: { isNode: true } };
	const base = new PrecompiledMaterial( artifact );
	base.isShadowPassMaterial = true;
	const replay = createReplayShadowMaterial( base, caster );
	const object = { material: caster, geometry: { attributes: {} } };
	const renderObject = { material: replay, object, group: null };
	const state = hydrateNodeBuilderState( artifact, replay, object, { renderObject } );
	foreign.value = 3;
	intended.value = 9;
	for ( const node of state.updateNodes ) node.update( { material: replay, object, renderObject } );
	const view = new DataView( state.bindings[ 0 ].bindings[ 0 ].buffer.buffer );
	assert.equal( view.getFloat32( 0, true ), - 7, 'unproven artifact/global identities fall back to the captured snapshot' );
	clearLiveUniformRegistryForTests();

} );

test( 'caster graph wiring never schedules non-Node update methods such as VideoTexture.update', () => {

	const artifact = shadowArtifact( { bindings: [], uniformPlan: [] } );
	const caster = { map: new VideoTexture( {} ) };
	const base = new PrecompiledMaterial( artifact );
	base.isShadowPassMaterial = true;
	const replay = createReplayShadowMaterial( base, caster );
	const object = { material: caster, geometry: { attributes: {} } };
	const state = hydrateNodeBuilderState( artifact, replay, object, {
		renderObject: { material: replay, object, group: null },
	} );
	assert.equal( state.updateNodes.some( ( node ) => node && node.isVideoTexture === true ), false );
	assert.ok( state.updateNodes.every( ( node ) => typeof node.getUpdateType === 'function' && typeof node.updateReference === 'function' ) );

} );

test( 'selected shadow variant rewiring never mutates frozen source or unselected family plans', () => {

	const selectedSlot = {
		offset: 0, dtype: 'number',
		source: {
			kind: 'uniform.live', liveNodeId: 0,
			nodePath: [ 'castShadowNode', 'uniform' ],
			valueSnapshot: { type: 'number', data: 0 },
		},
	};
	Object.freeze( selectedSlot.source );
	Object.freeze( selectedSlot );
	const selected = shadowArtifact( {
		cacheKey: 'selected',
		bindings: [ { name: 'object', bindings: [ { name: 'object', kind: 'uniform-buffer', visibility: 7, byteLength: 16 } ] } ],
		uniformPlan: [ { name: 'object', shared: false, byteLength: 16, textures: [], slots: [ selectedSlot ] } ],
	} );
	const unselectedSlot = { ...selectedSlot, source: { ...selectedSlot.source, nodePath: [ 'otherNode', 'uniform' ] } };
	const unselected = shadowArtifact( {
		cacheKey: 'unselected',
		uniformPlan: [ { name: 'object', shared: false, byteLength: 16, textures: [], slots: [ unselectedSlot ] } ],
	} );
	Object.freeze( unselectedSlot );
	const family = shadowArtifact( {
		cacheKey: 'root',
		bindings: [],
		uniformPlan: [],
		variants: { selected, unselected },
	} );
	const uniform = { isNode: true, isUniformNode: true, value: 6.5 };
	const caster = { castShadowNode: { isNode: true, uniform } };
	const base = new PrecompiledMaterial( family );
	base.isShadowPassMaterial = true;
	const replay = createReplayShadowMaterial( base, caster );
	const object = { material: caster, geometry: { attributes: {} } };
	const renderObject = { material: replay, object, group: null };
	const state = hydrateNodeBuilderState( family, replay, object, { cacheKey: 'selected', renderObject } );
	state.updateNodes[ state.updateNodes.length - 1 ].update( { material: replay, object, renderObject } );
	assert.equal( new DataView( state.bindings[ 0 ].bindings[ 0 ].buffer.buffer ).getFloat32( 0, true ), 6.5 );
	assert.equal( Object.prototype.hasOwnProperty.call( selectedSlot, '_liveNode' ), false );
	assert.equal( Object.prototype.hasOwnProperty.call( unselectedSlot, '_liveNode' ), false );

} );

test( 'frozen caster light sources retain selected identity links in the state-local artifact view', () => {

	const source = Object.freeze( {
		kind: 'light.distance',
		lightIdentity: 0,
		lightIndex: 0,
		lightUuid: 'captured-light',
		valueSnapshot: { type: 'number', data: - 1 },
	} );
	const artifact = shadowArtifact( {
		bindings: [ { name: 'render', bindings: [ { name: 'render', kind: 'uniform-buffer', visibility: 7, byteLength: 16 } ] } ],
		uniformPlan: [ {
			name: 'render', shared: false, byteLength: 16, textures: [],
			slots: [ { offset: 0, dtype: 'number', source } ],
		} ],
		lightIdentities: [ {
			captureUuid: 'captured-light',
			captureIndex: 0,
			type: 'PointLight',
			snapshot: { position: [ 9, 0, 0 ], distance: 9 },
		} ],
	} );
	const caster = {};
	const base = new PrecompiledMaterial( artifact );
	base.isShadowPassMaterial = true;
	const replay = createReplayShadowMaterial( base, caster );
	const object = { material: caster, geometry: { attributes: {} } };
	const renderObject = { material: replay, object, group: null };
	const state = hydrateNodeBuilderState( artifact, replay, object, { renderObject } );
	const wrongIndex = {
		isLight: true, isPointLight: true, uuid: 'runtime-wrong', distance: 1,
		matrixWorld: { elements: [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ] },
	};
	const identityMatch = {
		isLight: true, isPointLight: true, uuid: 'runtime-match', distance: 9,
		matrixWorld: { elements: [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 9, 0, 0, 1 ] },
	};
	const scene = { traverse( visit ) { visit( wrongIndex ); visit( identityMatch ); } };
	state.updateNodes[ 0 ].update( { scene, material: replay, object, renderObject } );
	const view = new DataView( state.bindings[ 0 ].bindings[ 0 ].buffer.buffer );
	assert.equal( view.getFloat32( 0, true ), 9 );
	assert.equal( Object.prototype.hasOwnProperty.call( source, 'lightIdentityRecord' ), false );

} );

test( 'aux-style shadow hydration routes scalar, map, sampler, and custom graph texture to caster', () => {

	const artifact = shadowArtifact();
	const fixture = replayFixture( artifact );
	const state = hydrateNodeBuilderState( artifact, fixture.material, fixture.object, { renderObject: fixture.renderObject } );
	const [ uniformBuffer, mapSampler, mapTexture, graphSampler, graphTexture ] = state.bindings[ 0 ].bindings;
	assert.equal( mapSampler.texture, fixture.casterMap );
	assert.equal( mapTexture.texture, fixture.casterMap );
	assert.equal( graphSampler.texture, fixture.graphTexture );
	assert.equal( graphTexture.texture, fixture.graphTexture );
	assert.notEqual( mapTexture.texture, fixture.staleMap );

	const frame = {
		frameId: 1,
		renderId: 1,
		material: fixture.material,
		object: fixture.object,
		renderObject: fixture.renderObject,
		renderer: { backend: new WeakMap(), getRenderTarget: () => null },
	};
	state.updateNodes[ 0 ].update( frame );
	const view = new DataView( uniformBuffer.buffer.buffer );
	assert.equal( view.getFloat32( 0, true ), fixture.caster.alphaTest );
	assert.equal( view.getFloat32( 4, true ), fixture.base.opacity );

	const nextMap = texture( 'next caster map' );
	const nextGraphTexture = texture( 'next caster graph texture' );
	fixture.caster.map = nextMap;
	fixture.caster.castShadowNode.value = nextGraphTexture;
	frame.frameId ++;
	frame.renderId ++;
	for ( const node of state.updateBeforeNodes ) node.updateBefore( frame );
	assert.equal( mapSampler.texture, nextMap );
	assert.equal( mapTexture.texture, nextMap );
	assert.equal( graphSampler.texture, nextGraphTexture );
	assert.equal( graphTexture.texture, nextGraphTexture );

} );

test( 'same-property mixed ownership falls back to per-slot generic writes', () => {

	const artifact = shadowArtifact( {
		bindings: [ { name: 'object', bindings: [ { name: 'object', kind: 'uniform-buffer', visibility: 7, byteLength: 16 } ] } ],
		uniformPlan: [ {
			name: 'object', shared: false, byteLength: 16, textures: [],
			slots: [
				{ offset: 0, dtype: 'number', source: { kind: 'material.opacity', property: 'opacity' } },
				{ offset: 4, dtype: 'number', source: { kind: 'material.opacity', property: 'opacity', bindingOwner: 'render-material' } },
			],
		} ],
	} );
	let generatedCalls = 0;
	Object.defineProperty( artifact, '_generatedUpdateGroup', { value() { generatedCalls ++; } } );
	const fixture = replayFixture( artifact );
	const state = hydrateNodeBuilderState( artifact, fixture.material, fixture.object, { renderObject: fixture.renderObject } );
	const uniformBuffer = state.bindings[ 0 ].bindings[ 0 ];
	state.updateNodes[ 0 ].update( { material: fixture.material, object: fixture.object, renderObject: fixture.renderObject } );
	const view = new DataView( uniformBuffer.buffer.buffer );
	assert.equal( generatedCalls, 0 );
	assert.equal( view.getFloat32( 0, true ), fixture.caster.opacity );
	assert.equal( view.getFloat32( 4, true ), fixture.base.opacity );

} );

test( 'signed shadow ownership fails closed without an exact array group; legacy artifacts keep fallback', () => {

	const artifact = shadowArtifact( { bindings: [], uniformPlan: [] } );
	const base = new PrecompiledMaterial( artifact );
	base.isShadowPassMaterial = true;
	const object = { material: [ {}, {} ], geometry: { attributes: {} } };
	assert.throws(
		() => hydrateNodeBuilderState( artifact, base, object, { renderObject: { material: base, object, group: null } } ),
		( error ) => error && error.code === MATERIAL_BINDING_OWNER_UNAVAILABLE,
	);

	const legacy = { ...artifact };
	delete legacy.bindingOwner;
	const legacyBase = new PrecompiledMaterial( legacy );
	legacyBase.isShadowPassMaterial = true;
	assert.doesNotThrow( () => hydrateNodeBuilderState( legacy, legacyBase, object, { renderObject: { material: legacyBase, object, group: null } } ) );

} );
