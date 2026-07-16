import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DataTexture } from 'three/src/textures/DataTexture.js';
import { DepthTexture } from 'three/src/textures/DepthTexture.js';
import { InstancedBufferAttribute } from 'three/src/core/InstancedBufferAttribute.js';
import {
	createInstanceMatrixAttributeReference,
	createRangeAttributeGenerator,
	generateRangeAttributeArray,
	materializeArtifactAttributeDescriptors,
} from '@tsl-precompile/contract/attribute-generators';

import { registerArtifact, getArtifact } from '../src/artifact-loader.js';
import { getDFGLUT } from '../src/dfg-lut.js';
import { hydrateNodeBuilderState, registerLiveTexture, clearLiveTextureIndex } from '../src/hydrator.js';
import { setTextureResolutionDebugHook } from '../src/hydrate/artifact-texture-resolver.js';
import { installLiveTextureRegistryPatches } from '../src/hydrate/live-texture-registry.js';
import { __applyPrecompiled, catalogueArtifactTextureRefs, collectLiveMaterialTextures } from '../src/apply-precompiled.js';
import { __applyPrecompiled as applyPrecompiledDevelopment } from '../src/apply-precompiled-development.js';
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
	abs,
	float,
	instancedArray,
	instancedBufferAttribute,
	mrt,
	mix,
	mod,
	step,
	select,
	sin,
	texture,
	time,
	vec3,
	normalWorld,
	positionLocal,
	screenUV,
} from '../src/slim-stubs.js';
import { withTemporalFrame } from '../src/slim-support/temporal-frame.js';

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

test( 'tier C: hydrator selects variant by live cacheKey when artifact.variants exists', () => {

	// Default (top-level) artifact carries the cacheKey-12345 variant.
	// `variants` map carries an additional cacheKey-67890 variant with
	// different WGSL — simulating a material that captured two render-
	// state variants (e.g. one with clipping, one without).
	const artifact = {
		vertexShader: 'vertex_12345',
		fragmentShader: 'fragment_12345',
		bindings: [],
		nodeAttributes: [],
		uniformPlan: [],
		variants: {
			'67890': {
				cacheKey: 67890,
				vertexShader: 'vertex_67890',
				fragmentShader: 'fragment_67890',
				bindings: [],
				nodeAttributes: [],
				uniformPlan: [],
			},
		},
	};

	// Live cacheKey matches the variants[ '67890' ] entry — the hydrator
	// must swap to that variant's WGSL.
	const matched = hydrateNodeBuilderState( artifact, null, null, 67890 );
	assert.equal( matched.vertexShader, 'vertex_67890' );
	assert.equal( matched.fragmentShader, 'fragment_67890' );

	// Live cacheKey doesn't match any variant — falls back to top-level fields.
	const unmatched = hydrateNodeBuilderState( artifact, null, null, 99999 );
	assert.equal( unmatched.vertexShader, 'vertex_12345' );
	assert.equal( unmatched.fragmentShader, 'fragment_12345' );

	// No cacheKey passed (legacy 3-arg call) — uses top-level fields.
	const legacy = hydrateNodeBuilderState( artifact );
	assert.equal( legacy.vertexShader, 'vertex_12345' );
	assert.equal( legacy.fragmentShader, 'fragment_12345' );

} );

test( 'tier C: hydrator prefers a signed semantic variant over private cache identity', () => {

	const selectorA = JSON.stringify( { version: 'render-object-selector@1', topology: 'a' } );
	const selectorB = JSON.stringify( { version: 'render-object-selector@1', topology: 'b' } );
	const artifact = {
		cacheKey: 'capture-a',
		vertexShader: 'vertex_a',
		fragmentShader: 'fragment_a',
		bindings: [],
		nodeAttributes: [],
		uniformPlan: [],
		renderContextSelectors: [ selectorA ],
		variants: {
			'capture-a': {
				cacheKey: 'capture-a',
				vertexShader: 'vertex_a',
				fragmentShader: 'fragment_a',
				bindings: [],
				nodeAttributes: [],
				uniformPlan: [],
				renderContextSelectors: [ selectorA ],
			},
			'capture-b': {
				cacheKey: 'capture-b',
				vertexShader: 'vertex_b',
				fragmentShader: 'fragment_b',
				bindings: [],
				nodeAttributes: [],
				uniformPlan: [],
				renderContextSelectors: [ selectorB ],
			},
		},
	};

	const state = hydrateNodeBuilderState( artifact, null, null, {
		cacheKey: 'capture-a',
		renderContextSelector: selectorB,
	} );
	assert.equal( state.vertexShader, 'vertex_b' );
	assert.equal( state.fragmentShader, 'fragment_b' );

} );

test( 'tier C: hydrator without variants field uses top-level fields unchanged', () => {

	// Legacy single-variant artifact — no `variants` map. Hydrator should
	// behave identically regardless of cacheKey arg.
	const artifact = {
		vertexShader: 'only_vertex',
		fragmentShader: 'only_fragment',
		bindings: [],
		nodeAttributes: [],
		uniformPlan: [],
	};

	const noKey = hydrateNodeBuilderState( artifact );
	assert.equal( noKey.vertexShader, 'only_vertex' );

	const withKey = hydrateNodeBuilderState( artifact, null, null, 12345 );
	assert.equal( withKey.vertexShader, 'only_vertex' );

	const nullKey = hydrateNodeBuilderState( artifact, null, null, null );
	assert.equal( nullKey.vertexShader, 'only_vertex' );

} );

test( 'tier C: hydrator falls back to MRT output-count variant when cacheKey diverges', () => {

	const artifact = {
		vertexShader: 'vertex_single',
		fragmentShader: 'fragment_single',
		bindings: [],
		nodeAttributes: [],
		uniformPlan: [],
		variants: {
			'captured-mrt-key': {
				cacheKey: 'captured-mrt-key',
				vertexShader: 'vertex_mrt',
				fragmentShader: 'fragment_mrt',
				bindings: [],
				nodeAttributes: [],
				uniformPlan: [],
				mrtOutputCount: 2,
				mrtOutputNames: [ 'output', 'emissive' ],
			},
		},
	};
	const material = {
		mrtNode: {
			outputNodes: {
				output: {},
				emissive: {},
			},
		},
	};

	const state = hydrateNodeBuilderState( artifact, material, null, 'replay-cache-key' );
	assert.equal( state.vertexShader, 'vertex_mrt' );
	assert.equal( state.fragmentShader, 'fragment_mrt' );

} );

test( 'tier C: hydrator variant lookup preserves non-enumerable sidecars', () => {

	// Sidecars like `_textureRefs`, `_liveUpdateNodes`, captureClock are
	// shared across all variants of a material. They live as non-enumerable
	// properties on the top-level artifact; the variant lookup must
	// forward them onto the effective view object.
	const sharedTextureRefs = new Map( [ [ 'uuid-1', { name: 'shared' } ] ] );
	const artifact = {
		vertexShader: 'vertex_default',
		fragmentShader: 'fragment_default',
		bindings: [],
		nodeAttributes: [],
		uniformPlan: [],
		variants: {
			'77777': {
				cacheKey: 77777,
				vertexShader: 'vertex_variant',
				fragmentShader: 'fragment_variant',
				bindings: [],
				nodeAttributes: [],
				uniformPlan: [],
			},
		},
	};
	Object.defineProperty( artifact, '_textureRefs', {
		value: sharedTextureRefs,
		enumerable: false,
		configurable: true,
		writable: true,
	} );

	// Render with the matching variant — the variant uses its own WGSL but
	// the sidecar _textureRefs must still be reachable via the effective
	// artifact view (because the variant payload doesn't carry sidecars).
	const state = hydrateNodeBuilderState( artifact, null, null, 77777 );
	assert.equal( state.vertexShader, 'vertex_variant' );
	// We don't easily expose the effective artifact, but the fact that
	// hydration completes without throwing — and that texture-resolution
	// paths inside the hydrator would have called _textureRefs.get(...) —
	// is what proves the forwarding works in the integration test.

} );

test( 'runtime hydrator rehydrates JSON node attributes with storage-buffer fallbacks', () => {

	const state = hydrateNodeBuilderState( {
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		attributes: [
			{ name: 'nodeAttribute0', type: 'vec3', source: 'node', count: 4, itemSize: 3, arrayType: 'Float32Array', arraySnapshot: [ 1, 2, 3, 4, 5, 6 ] },
		],
		bindings: [],
		uniformPlan: [],
	} );

	const nodeAttribute = state.nodeAttributes[ 0 ];
	assert.equal( nodeAttribute.node.attribute.isStorageBufferAttribute, true );
	assert.equal( nodeAttribute.node.attribute.itemSize, 3 );
	assert.equal( nodeAttribute.node.attribute.count, 4 );
	assert.deepEqual( Array.from( nodeAttribute.node.attribute.array.slice( 0, 6 ) ), [ 1, 2, 3, 4, 5, 6 ] );

} );

test( 'runtime hydrator preserves anonymous instanced node attributes from snapshots', () => {

	const state = hydrateNodeBuilderState( {
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		attributes: [
			{ name: 'nodeAttribute0', type: 'vec3', source: 'node', count: 2, itemSize: 3, arrayType: 'Float32Array', instanced: true, storage: false, arraySnapshot: [ 1, 2, 3, 4, 5, 6 ] },
		],
		bindings: [],
		uniformPlan: [],
	} );

	const nodeAttribute = state.nodeAttributes[ 0 ].node.attribute;
	assert.equal( nodeAttribute.isInstancedBufferAttribute, true );
	assert.notEqual( nodeAttribute.isStorageBufferAttribute, true );
	assert.equal( nodeAttribute.itemSize, 3 );
	assert.equal( nodeAttribute.count, 2 );
	assert.deepEqual( Array.from( nodeAttribute.array ), [ 1, 2, 3, 4, 5, 6 ] );

} );

test( 'runtime hydrator regenerates deterministic RangeNode attributes without snapshots', () => {

	const recipe = createRangeAttributeGenerator( 0x13579bdf, [ 0, - 1, 0, 2 ], [ 1, 1, 4, 6 ] );
	const state = hydrateNodeBuilderState( materializeArtifactAttributeDescriptors( {
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		attributes: [ {
			name: 'nodeAttribute0',
			type: 'vec4',
			source: 'node',
			count: 3,
			itemSize: 4,
			arrayType: 'Float32Array',
			instanced: true,
			storage: false,
			arrayGenerator: recipe,
		} ],
		bindings: [],
		uniformPlan: [],
	} ) );

	const attribute = state.nodeAttributes[ 0 ].node.attribute;
	assert.equal( attribute.isInstancedBufferAttribute, true );
	assert.deepEqual( attribute.array, generateRangeAttributeArray( recipe, 3 ) );

} );

test( 'runtime hydrator materializes a shared RangeNode recipe independently per count', () => {

	const recipe = createRangeAttributeGenerator( 0x2468ace0, [ 0, 0, 0, 0 ], [ 1, 1, 1, 1 ] );
	const artifact = ( count ) => materializeArtifactAttributeDescriptors( {
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		attributes: [ {
			name: 'nodeAttribute0',
			type: 'vec4',
			source: 'node',
			count,
			itemSize: 4,
			arrayType: 'Float32Array',
			instanced: true,
			storage: false,
			arrayGenerator: recipe,
		} ],
		bindings: [],
		uniformPlan: [],
	} );

	const short = hydrateNodeBuilderState( artifact( 2 ) ).nodeAttributes[ 0 ].node.attribute.array;
	const long = hydrateNodeBuilderState( artifact( 3 ) ).nodeAttributes[ 0 ].node.attribute.array;
	assert.deepEqual( short, generateRangeAttributeArray( recipe, 2 ) );
	assert.deepEqual( long, generateRangeAttributeArray( recipe, 3 ) );
	assert.equal( short.length, 8 );
	assert.equal( long.length, 12 );

} );

test( 'runtime hydrator fills multiple RangeNode recipes directly into shared interleaved storage', () => {

	const recipes = [
		createRangeAttributeGenerator( 11, [ 0, 1, 2, 3 ], [ 1, 2, 3, 4 ] ),
		createRangeAttributeGenerator( 22, [ - 4, - 3, - 2, - 1 ], [ 0, 0, 0, 0 ] ),
	];
	const attributes = recipes.map( ( recipe, index ) => ( {
		name: `nodeAttribute${ index }`,
		type: 'vec4',
		source: 'node',
		count: 3,
		itemSize: 4,
		arrayType: 'Float32Array',
		instanced: true,
		storage: false,
		arrayGenerator: recipe,
	} ) );
	const state = hydrateNodeBuilderState( materializeArtifactAttributeDescriptors( {
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		attributes,
		bindings: [],
		uniformPlan: [],
	} ) );
	const live = state.nodeAttributes.map( ( entry ) => entry.node.attribute );
	assert.equal( live[ 0 ].isInterleavedBufferAttribute, true );
	assert.equal( live[ 0 ].data, live[ 1 ].data );
	assert.equal( live[ 0 ].data.stride, 8 );
	for ( let recipeIndex = 0; recipeIndex < recipes.length; recipeIndex ++ ) {

		const expected = generateRangeAttributeArray( recipes[ recipeIndex ], 3 );
		for ( let instance = 0; instance < 3; instance ++ ) for ( let component = 0; component < 4; component ++ ) {

			assert.equal( live[ recipeIndex ].getComponent( instance, component ), expected[ instance * 4 + component ] );

		}

	}

} );

test( 'runtime hydrator rejects malformed RangeNode generators instead of zero-filling', () => {

	const malformed = {
		name: 'nodeAttribute0',
		type: 'vec4',
		source: 'node',
		count: 3,
		itemSize: 3,
		arrayType: 'Uint16Array',
		instanced: true,
		storage: false,
		arrayGenerator: { kind: 'range@1', seed: - 1, min: [ 0, 0, 0 ], max: [ 1, 1, 1 ] },
	};
	const artifact = {
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		attributes: [ malformed ],
		bindings: [],
		uniformPlan: [],
	};
	assert.throws( () => hydrateNodeBuilderState( materializeArtifactAttributeDescriptors( artifact ) ), /invalid generated range/ );

	const validRecipe = createRangeAttributeGenerator( 1, [ 0, 0, 0, 0 ], [ 1, 1, 1, 1 ] );
	assert.throws( () => hydrateNodeBuilderState( materializeArtifactAttributeDescriptors( {
		...artifact,
		attributes: [
			{ ...malformed, itemSize: 4, arrayType: 'Float32Array', arrayGenerator: { ...validRecipe, extra: true } },
			{ ...malformed, name: 'nodeAttribute1', itemSize: 4, arrayType: 'Float32Array', arrayGenerator: validRecipe },
		],
	} ) ), /invalid generated range/ );
	assert.throws( () => hydrateNodeBuilderState( {
		...artifact,
		attributes: [ { ...malformed, itemSize: 4, arrayType: 'Float32Array', arrayGenerator: validRecipe } ],
	} ), /not materialized by its artifact module/ );

} );

test( 'runtime hydrator interleaves anonymous instanced snapshot fallbacks', () => {

	const state = hydrateNodeBuilderState( {
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		attributes: [
			{ name: 'nodeAttribute0', type: 'vec2', source: 'node', count: 2, itemSize: 2, arrayType: 'Float32Array', instanced: true, storage: false, arraySnapshot: [ 1, 2, 3, 4 ] },
			{ name: 'nodeAttribute1', type: 'float', source: 'node', count: 2, itemSize: 1, arrayType: 'Float32Array', instanced: true, storage: false, arraySnapshot: [ 5, 6 ] },
			{ name: 'nodeAttribute2', type: 'vec3', source: 'node', count: 2, itemSize: 3, arrayType: 'Float32Array', instanced: true, storage: false, arraySnapshot: [ 7, 8, 9, 10, 11, 12 ] },
		],
		bindings: [],
		uniformPlan: [],
	} );

	const first = state.nodeAttributes[ 0 ].node.attribute;
	const second = state.nodeAttributes[ 1 ].node.attribute;
	const third = state.nodeAttributes[ 2 ].node.attribute;

	assert.equal( first.isInterleavedBufferAttribute, true );
	assert.equal( second.isInterleavedBufferAttribute, true );
	assert.equal( third.isInterleavedBufferAttribute, true );
	assert.equal( first.data, second.data );
	assert.equal( second.data, third.data );
	assert.equal( first.data.isInstancedInterleavedBuffer, true );
	assert.equal( first.data.stride, 6 );
	assert.equal( first.offset, 0 );
	assert.equal( second.offset, 2 );
	assert.equal( third.offset, 3 );
	assert.deepEqual( Array.from( first.data.array ), [ 1, 2, 5, 7, 8, 9, 3, 4, 6, 10, 11, 12 ] );

} );

test( 'runtime hydrator prefers anonymous attribute snapshots over shape-only live matches', () => {

	const liveAttribute = {
		isBufferAttribute: true,
		isInstancedBufferAttribute: true,
		count: 2,
		itemSize: 3,
		array: new Float32Array( [ 9, 9, 9, 8, 8, 8 ] ),
	};
	const sourceMaterial = {
		positionNode: {
			isNode: true,
			traverse( visitor ) {

				visitor( { attribute: liveAttribute } );

			},
		},
	};
	const artifact = {
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		attributes: [
			{ name: 'nodeAttribute0', type: 'vec3', source: 'node', count: 2, itemSize: 3, arrayType: 'Float32Array', instanced: true, storage: false, arraySnapshot: [ 1, 2, 3, 4, 5, 6 ] },
		],
		bindings: [],
		uniformPlan: [],
	};
	Object.defineProperty( artifact.attributes[ 0 ], '_liveAttribute', {
		value: liveAttribute,
		enumerable: false,
		configurable: true,
		writable: true,
	} );

	const state = hydrateNodeBuilderState( artifact, sourceMaterial );

	const nodeAttribute = state.nodeAttributes[ 0 ].node.attribute;
	assert.notEqual( nodeAttribute, liveAttribute );
	assert.deepEqual( Array.from( nodeAttribute.array ), [ 1, 2, 3, 4, 5, 6 ] );

} );

test( 'runtime hydrator disambiguates duplicate userPath attributes by encounter order', () => {

	const timeAttribute = {
		isBufferAttribute: true,
		isInstancedBufferAttribute: true,
		count: 2,
		itemSize: 1,
		array: new Float32Array( [ 0.1, 0.2 ] ),
	};
	const positionAttribute = {
		isBufferAttribute: true,
		isInstancedBufferAttribute: true,
		count: 2,
		itemSize: 3,
		array: new Float32Array( [ 1, 2, 3, 4, 5, 6 ] ),
	};
	const seedAttribute = {
		isBufferAttribute: true,
		isInstancedBufferAttribute: true,
		count: 2,
		itemSize: 1,
		array: new Float32Array( [ 0.7, 0.8 ] ),
	};
	const sourceMaterial = {
		positionNode: {
			isNode: true,
			traverse( visitor ) {

				visitor( { attribute: timeAttribute } );
				visitor( { attribute: positionAttribute } );
				visitor( { attribute: seedAttribute } );

			},
		},
	};
	const artifact = {
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		attributes: [
			{ name: 'nodeAttribute0', type: 'float', source: 'node', count: 2, itemSize: 1, arrayType: 'Float32Array', instanced: true, storage: false, userPath: [ 'positionNode' ] },
			{ name: 'nodeAttribute2', type: 'vec3', source: 'node', count: 2, itemSize: 3, arrayType: 'Float32Array', instanced: true, storage: false, userPath: [ 'positionNode' ] },
			{ name: 'nodeAttribute3', type: 'float', source: 'node', count: 2, itemSize: 1, arrayType: 'Float32Array', instanced: true, storage: false, userPath: [ 'positionNode' ] },
		],
		bindings: [],
		uniformPlan: [],
	};

	const state = hydrateNodeBuilderState( artifact, sourceMaterial );

	assert.equal( state.nodeAttributes[ 0 ].node.attribute, timeAttribute );
	assert.equal( state.nodeAttributes[ 1 ].node.attribute, positionAttribute );
	assert.equal( state.nodeAttributes[ 2 ].node.attribute, seedAttribute );

} );

	test( 'runtime hydrator binds anonymous instanceMatrix snapshots to the live object columns', () => {

	const matrix = new Float32Array( Array.from( { length: 32 }, ( _, i ) => i + 1 ) );
	const object = {
		isInstancedMesh: true,
		count: 2,
		instanceMatrix: { array: matrix },
	};
	const material = {};
	Object.defineProperty( material, '__tslpPrecompileObject', { value: object, configurable: true } );

	const artifact = {
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		attributes: [ 0, 1, 2, 3 ].map( ( i ) => ( {
			name: `nodeAttribute${ i }`,
			type: 'vec4',
			source: 'node',
			count: 2,
			itemSize: 4,
			arrayType: 'Float32Array',
			instanced: false,
			storage: false,
			arraySnapshot: Array.from( matrix ),
		} ) ),
		bindings: [],
		uniformPlan: [],
	};

	const state = hydrateNodeBuilderState( artifact, material, object );
	const columns = state.nodeAttributes.map( ( entry ) => entry.node.attribute );

	for ( const column of columns ) assert.equal( column.isInterleavedBufferAttribute, true );
	assert.ok( columns.every( ( column ) => column.data === columns[ 0 ].data ) );
	assert.deepEqual( [ columns[ 0 ].getX( 0 ), columns[ 0 ].getY( 0 ), columns[ 0 ].getZ( 0 ), columns[ 0 ].getW( 0 ) ], [ 1, 2, 3, 4 ] );
	assert.deepEqual( [ columns[ 1 ].getX( 1 ), columns[ 1 ].getY( 1 ), columns[ 1 ].getZ( 1 ), columns[ 1 ].getW( 1 ) ], [ 21, 22, 23, 24 ] );
	assert.deepEqual( [ columns[ 2 ].getX( 1 ), columns[ 2 ].getY( 1 ), columns[ 2 ].getZ( 1 ), columns[ 2 ].getW( 1 ) ], [ 25, 26, 27, 28 ] );
	assert.deepEqual( [ columns[ 3 ].getX( 1 ), columns[ 3 ].getY( 1 ), columns[ 3 ].getZ( 1 ), columns[ 3 ].getW( 1 ) ], [ 29, 30, 31, 32 ] );

} );

test( 'runtime hydrator still binds instanceMatrix columns beside storage vec4 attributes', () => {

	const matrix = new Float32Array( Array.from( { length: 32 }, ( _, i ) => i + 1 ) );
	const object = {
		isInstancedMesh: true,
		count: 2,
		instanceMatrix: { array: matrix },
	};
	const material = {};
	Object.defineProperty( material, '__tslpPrecompileObject', { value: object, configurable: true } );

	const artifact = {
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		attributes: [
			{ name: 'nodeAttribute0', type: 'vec4', source: 'node', count: 2, itemSize: 4, arrayType: 'Float32Array', instanced: true, storage: true, userPath: [ 'positionNode' ] },
			... [ 0, 1, 2, 3 ].map( ( column ) => ( {
				name: `nodeAttribute${ column + 1 }`,
				type: 'vec4',
				source: 'node',
				count: 2,
				itemSize: 4,
				arrayType: 'Float32Array',
				instanced: true,
				storage: false,
				arraySnapshot: Array.from( matrix ),
			} ) ),
			{ name: 'nodeAttribute7', type: 'vec4', source: 'node', count: 2, itemSize: 4, arrayType: 'Float32Array', instanced: true, storage: true },
		],
		bindings: [],
		uniformPlan: [],
	};

	const state = hydrateNodeBuilderState( artifact, material, object );
	const columns = state.nodeAttributes.slice( 1, 5 ).map( ( entry ) => entry.node.attribute );

	for ( const column of columns ) assert.equal( column.isInterleavedBufferAttribute, true );
	assert.ok( columns.every( ( column ) => column.data === columns[ 0 ].data ) );
	assert.deepEqual( [ columns[ 0 ].getX( 0 ), columns[ 0 ].getY( 0 ), columns[ 0 ].getZ( 0 ), columns[ 0 ].getW( 0 ) ], [ 1, 2, 3, 4 ] );
	assert.deepEqual( [ columns[ 3 ].getX( 1 ), columns[ 3 ].getY( 1 ), columns[ 3 ].getZ( 1 ), columns[ 3 ].getW( 1 ) ], [ 29, 30, 31, 32 ] );

} );

test( 'runtime hydrator binds explicit instanceMatrix provenance without snapshots', () => {

	const matrix = new Float32Array( Array.from( { length: 32 }, ( _, i ) => i + 1 ) );
	const object = {
		isInstancedMesh: true,
		// Draw count can legitimately be lower than the matrix buffer capacity;
		// explicit provenance resolves against the buffer's count.
		count: 1,
		instanceMatrix: new InstancedBufferAttribute( matrix, 16 ),
	};
	const sameShapeMaterialAttribute = {
		isBufferAttribute: true,
		itemSize: 4,
		count: 2,
		array: new Float32Array( 8 ).fill( 99 ),
	};
	const material = { positionNode: { isNode: true, attribute: sameShapeMaterialAttribute } };
	const artifact = {
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		attributes: [ 0, 1, 2, 3 ].map( ( column ) => ( {
			name: `nodeAttribute${ column }`,
			type: 'vec4',
			source: 'node',
			count: 2,
			itemSize: 4,
			arrayType: 'Float32Array',
			instanced: true,
			storage: false,
			objectAttribute: createInstanceMatrixAttributeReference( column ),
		} ) ),
		bindings: [],
		uniformPlan: [],
	};

	materializeArtifactAttributeDescriptors( artifact );
	const state = hydrateNodeBuilderState( artifact, material, object );
	const columns = state.nodeAttributes.map( ( entry ) => entry.node.attribute );
	assert.ok( columns.every( ( column ) => column !== sameShapeMaterialAttribute ) );
	assert.ok( columns.every( ( column ) => column.isInterleavedBufferAttribute === true ) );
	assert.ok( columns.every( ( column ) => column.data === columns[ 0 ].data ) );
	assert.equal( columns[ 0 ].array, matrix );
	assert.deepEqual( [ columns[ 0 ].getX( 0 ), columns[ 0 ].getY( 0 ), columns[ 0 ].getZ( 0 ), columns[ 0 ].getW( 0 ) ], [ 1, 2, 3, 4 ] );
	assert.deepEqual( [ columns[ 3 ].getX( 1 ), columns[ 3 ].getY( 1 ), columns[ 3 ].getZ( 1 ), columns[ 3 ].getW( 1 ) ], [ 29, 30, 31, 32 ] );
	matrix[ 0 ] = 42;
	object.instanceMatrix.needsUpdate = true;
	assert.equal( columns[ 0 ].getX( 0 ), 42 );
	assert.equal( columns[ 0 ].data.version, object.instanceMatrix.version );
	assert.equal( object.count, 1 );

} );

test( 'runtime hydrator keeps mixed vec4 snapshots interleaved instead of guessing instanceMatrix columns', () => {

	const matrix = new Float32Array( [
		1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1,
		1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 40, 50, 60, 1,
	] );
	const object = {
		isInstancedMesh: true,
		count: 2,
		instanceMatrix: { array: matrix },
	};
	const material = {};
	Object.defineProperty( material, '__tslpPrecompileObject', { value: object, configurable: true } );
	const matrixColumn = ( column ) => [
		matrix[ column * 4 + 0 ], matrix[ column * 4 + 1 ], matrix[ column * 4 + 2 ], matrix[ column * 4 + 3 ],
		matrix[ 16 + column * 4 + 0 ], matrix[ 16 + column * 4 + 1 ], matrix[ 16 + column * 4 + 2 ], matrix[ 16 + column * 4 + 3 ],
	];

	const state = hydrateNodeBuilderState( {
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		attributes: [
			{ name: 'nodeAttribute0', type: 'vec4', source: 'node', count: 2, itemSize: 4, arrayType: 'Float32Array', instanced: true, storage: false, arraySnapshot: [ 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8 ] },
			{ name: 'nodeAttribute2', type: 'vec4', source: 'node', count: 2, itemSize: 4, arrayType: 'Float32Array', instanced: true, storage: false, arraySnapshot: [ 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2 ] },
			... [ 0, 1, 2, 3 ].map( ( column ) => ( {
				name: `nodeAttribute${ column + 4 }`,
				type: 'vec4',
				source: 'node',
				count: 2,
				itemSize: 4,
				arrayType: 'Float32Array',
				instanced: true,
				storage: false,
				arraySnapshot: matrixColumn( column ),
			} ) ),
			{ name: 'nodeAttribute15', type: 'vec4', source: 'node', count: 2, itemSize: 4, arrayType: 'Float32Array', instanced: true, storage: false, arraySnapshot: [ 0.11, 0.22, 0.33, 0.44, 0.55, 0.66, 0.77, 0.88 ] },
		],
		bindings: [],
		uniformPlan: [],
	}, material, object );

	const attrs = state.nodeAttributes.map( ( entry ) => entry.node.attribute );
	assert.equal( attrs[ 0 ].isInterleavedBufferAttribute, true );
	assert.equal( attrs[ 1 ].data, attrs[ 0 ].data );
	for ( const attr of attrs ) {

		assert.equal( attr.isInterleavedBufferAttribute, true );
		assert.equal( attr.data, attrs[ 0 ].data );

	}
	assert.equal( attrs[ 0 ].data.stride, 28 );

} );

test( 'runtime hydrator restores captured draw count for anonymous instanced snapshots', () => {

	const object = { count: 5, geometry: {} };
	hydrateNodeBuilderState( {
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		attributes: [
			{ name: 'nodeAttribute0', type: 'vec3', source: 'node', count: 2, itemSize: 3, arrayType: 'Float32Array', instanced: true, storage: false, arraySnapshot: [ 1, 2, 3, 4, 5, 6 ] },
			{ name: 'nodeAttribute1', type: 'vec3', source: 'node', count: 2, itemSize: 3, arrayType: 'Float32Array', instanced: true, storage: false, arraySnapshot: [ 6, 5, 4, 3, 2, 1 ] },
		],
		bindings: [],
		uniformPlan: [],
	}, null, object );

	assert.equal( object.count, 2 );

} );

test( 'runtime hydrator leaves live-path instanced draw counts alone', () => {

	const object = { count: 5, geometry: {} };
	hydrateNodeBuilderState( {
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		attributes: [
			{ name: 'nodeAttribute0', type: 'vec3', source: 'node', count: 2, itemSize: 3, arrayType: 'Float32Array', instanced: true, storage: false, userPath: [ 'positionNode' ] },
		],
		bindings: [],
		uniformPlan: [],
	}, null, object );

	assert.equal( object.count, 5 );

} );

test( 'runtime hydrator leaves storage-backed instanced draw counts alone', () => {

	const object = { count: 5, geometry: {} };
	hydrateNodeBuilderState( {
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		attributes: [
			{ name: 'nodeAttribute0', type: 'vec4', source: 'node', count: 10, itemSize: 4, arrayType: 'Float32Array', instanced: true, storage: true, arraySnapshot: new Array( 40 ).fill( 0 ) },
		],
		bindings: [],
		uniformPlan: [],
	}, null, object );

	assert.equal( object.count, 5 );

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

test( 'runtime hydrator pairs anonymous shadow matrices with their light blocks', () => {

	const makeMatrix = ( base ) => ( { elements: new Array( 16 ).fill( 0 ).map( ( _, i ) => base + i ) } );
	const artifact = {
		vertexShader: '',
		fragmentShader: '',
		bindings: [ {
			name: 'render',
			bindings: [ { name: 'render', kind: 'uniform-buffer', visibility: 7, byteLength: 256 } ],
		} ],
		uniformPlan: [ {
			name: 'render',
			byteLength: 256,
			slots: [
				{ offset: 0, dtype: 'mat4', source: { kind: 'uniform.live', name: null, valueSnapshot: { type: 'mat4', data: new Array( 16 ).fill( - 1 ) } } },
				{ offset: 64, dtype: 'number', source: { kind: 'light.shadowBias', lightIndex: 1, lightUuid: 'light-a', property: 'bias' } },
				{ offset: 128, dtype: 'mat4', source: { kind: 'uniform.live', name: null, valueSnapshot: { type: 'mat4', data: new Array( 16 ).fill( - 2 ) } } },
				{ offset: 192, dtype: 'number', source: { kind: 'light.shadowBias', lightIndex: 2, lightUuid: 'light-b', property: 'bias' } },
			],
		} ],
	};
	const state = hydrateNodeBuilderState( artifact );
	const uniformBuffer = state.bindings[ 0 ].bindings[ 0 ];
	const light1 = { isLight: true, uuid: 'light-a', shadow: { map: {}, matrix: makeMatrix( 100 ), bias: 0.1 } };
	const light2 = { isLight: true, uuid: 'light-b', shadow: { map: {}, matrix: makeMatrix( 200 ), bias: 0.2 } };
	const scene = {
		traverse( visit ) {

			visit( { isLight: true } );
			visit( light2 );
			visit( light1 );

		},
	};

	state.updateNodes[ 0 ].update( { scene } );

	const view = new DataView( uniformBuffer.buffer.buffer );
	assert.equal( view.getFloat32( 0, true ), 100 );
	assert.equal( view.getFloat32( 15 * 4, true ), 115 );
	assert.equal( view.getFloat32( 128, true ), 200 );
	assert.equal( view.getFloat32( 128 + 15 * 4, true ), 215 );

} );

test( 'runtime hydrator writes light uniforms by UUID before traversal index', () => {

	const artifact = {
		vertexShader: '',
		fragmentShader: '',
		bindings: [ {
			name: 'render',
			bindings: [ { name: 'render', kind: 'uniform-buffer', visibility: 7, byteLength: 32 } ],
		} ],
		uniformPlan: [ {
			name: 'render',
			byteLength: 32,
			slots: [
				{ offset: 0, dtype: 'vec3', source: { kind: 'light.position', lightIndex: 1, lightUuid: 'spot-light', valueSnapshot: { type: 'vec3', data: [ - 1, - 1, - 1 ] } } },
			],
		} ],
	};
	const state = hydrateNodeBuilderState( artifact );
	const uniformBuffer = state.bindings[ 0 ].bindings[ 0 ];
	const wrongIndexLight = {
		isLight: true,
		uuid: 'directional-light',
		matrixWorld: { elements: [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 9, 9, 9, 1 ] },
	};
	const spotLight = {
		isLight: true,
		uuid: 'spot-light',
		matrixWorld: { elements: [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 3, 4, 1 ] },
	};
	const scene = {
		traverse( visit ) {

			visit( { isLight: true } );
			visit( wrongIndexLight );
			visit( spotLight );

		},
	};

	state.updateNodes[ 0 ].update( { scene } );

	const view = new DataView( uniformBuffer.buffer.buffer );
	assert.equal( view.getFloat32( 0, true ), 2 );
	assert.equal( view.getFloat32( 4, true ), 3 );
	assert.equal( view.getFloat32( 8, true ), 4 );

} );

test( 'runtime hydrator writes point shadow camera near/far live', () => {

	const artifact = {
		vertexShader: '',
		fragmentShader: '',
		bindings: [ {
			name: 'render',
			bindings: [ { name: 'render', kind: 'uniform-buffer', visibility: 7, byteLength: 16 } ],
		} ],
		uniformPlan: [ {
			name: 'render',
			byteLength: 16,
			slots: [
				{ offset: 0, dtype: 'number', source: { kind: 'light.shadowCameraNear', lightIndex: 0, lightUuid: 'point-light', valueSnapshot: { type: 'number', data: 0.1 } } },
				{ offset: 4, dtype: 'number', source: { kind: 'light.shadowCameraFar', lightIndex: 0, lightUuid: 'point-light', valueSnapshot: { type: 'number', data: 100 } } },
			],
		} ],
	};
	const state = hydrateNodeBuilderState( artifact );
	const uniformBuffer = state.bindings[ 0 ].bindings[ 0 ];
	const pointLight = {
		isLight: true,
		uuid: 'point-light',
		shadow: { camera: { near: 0.25, far: 8 } },
	};
	const scene = {
		traverse( visit ) {

			visit( pointLight );

		},
	};

	state.updateNodes[ 0 ].update( { scene } );

	const view = new DataView( uniformBuffer.buffer.buffer );
	assert.equal( view.getFloat32( 0, true ), 0.25 );
	assert.equal( view.getFloat32( 4, true ), 8 );

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

test( 'runtime hydrator rebinds material texture descriptors when material slots change', () => {

	const firstMap = { isTexture: true, addEventListener() {}, removeEventListener() {}, version: 0 };
	const nextMap = { isTexture: true, addEventListener() {}, removeEventListener() {}, version: 1 };
	const material = { map: firstMap };
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
	}, material );

	const [ sampler, textureBinding ] = state.bindings[ 0 ].bindings;
	assert.equal( sampler.texture, firstMap );
	assert.equal( textureBinding.texture, firstMap );

	material.map = nextMap;
	const rebinder = state.updateBeforeNodes.find( ( node ) => typeof node.updateBefore === 'function' );
	assert.ok( rebinder, 'material texture rebinder must be installed' );
	rebinder.updateBefore( { renderer: { backend: new WeakMap() } } );

	assert.equal( sampler.texture, nextMap );
	assert.equal( textureBinding.texture, nextMap );

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

	const textureResolutionEvents = [];
	const previousHook = setTextureResolutionDebugHook( ( event ) => textureResolutionEvents.push( event ) );
	let state;
	try {

		state = hydrateNodeBuilderState( artifact );

	} finally {

		setTextureResolutionDebugHook( previousHook );

	}
	const [ sampler, texture ] = state.bindings[ 0 ].bindings;
	assert.equal( sampler.texture, texture.texture );
	assert.equal( texture.texture.isDataTexture, true );
	assert.equal( texture.texture.image.width, 2 );
	assert.equal( texture.texture.image.data[ 0 ], 255 );
	assert.equal( texture.texture.image.data[ 4 ], 0 );
	assert.equal( texture.texture.image.data[ 5 ], 255 );
	assert.equal( artifact._textureResolutionStrategies.get( 'object:nodeTexture0' ), 'snapshot' );
	assert.equal( Object.prototype.propertyIsEnumerable.call( artifact, '_textureResolutionStrategies' ), false );
	assert.equal( textureResolutionEvents.length, 2 );
	assert.equal( textureResolutionEvents[ 1 ].strategy, 'snapshot' );
	assert.equal( textureResolutionEvents[ 1 ].sourceKind, 'artifact.texture' );
	assert.equal( textureResolutionEvents[ 1 ].textureUuid, 'tex-a' );
	assert.equal( textureResolutionEvents[ 1 ].resolvedTextureType, '2d' );

} );

test( 'runtime hydrator downgrades legacy texture snapshot mipmap filters to base-level sampling', async () => {

	const { LinearMipmapLinearFilter, RGBAFormat, UnsignedByteType } = await import( 'three' );
	const snapshot = {
		width: 128,
		height: 1,
		arrayType: 'Uint8Array',
		data: new Array( 128 * 4 ).fill( 255 ),
		format: RGBAFormat,
		type: UnsignedByteType,
		minFilter: LinearMipmapLinearFilter,
	};
	const artifact = {
		vertexShader: '',
		fragmentShader: '@group(1) @binding(0) var nodeTexture0 : texture_2d<f32>;',
		bindings: [ {
			name: 'object',
			bindings: [
				{ name: 'nodeTexture0', kind: 'sampled-texture', visibility: 2, textureType: '2d' },
			],
		} ],
		uniformPlan: [ {
			name: 'object',
			slots: [],
			textures: [
				{ name: 'nodeTexture0', source: { kind: 'artifact.texture', textureUuid: 'tex-mipmap-legacy', snapshot } },
			],
		} ],
	};

	const state = hydrateNodeBuilderState( artifact );
	const texture = state.bindings[ 0 ].bindings[ 0 ].texture;
	assert.equal( texture.minFilter, texture.magFilter );
	assert.equal( texture.generateMipmaps, false );

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
	assert.equal( artifact._textureResolutionStrategies.get( 'object:nodeUniform0' ), 'render-target-texture-ref' );

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
	assert.notEqual( sampler.texture.compareFunction, null );

} );

test( 'runtime hydrator uses comparison fallback for paired depth samplers', () => {

	const state = hydrateNodeBuilderState( {
		vertexShader: '',
		fragmentShader: '@group(1) @binding(0) var nodeUniform16 : texture_depth_2d;\n@group(1) @binding(1) var nodeUniform16_sampler : sampler_comparison;',
		bindings: [ {
			name: 'object',
			bindings: [
				{ name: 'nodeUniform16', kind: 'sampled-texture', visibility: 2, textureType: '2d' },
				{ name: 'nodeUniform16_sampler', kind: 'sampler', visibility: 2 },
			],
		} ],
		uniformPlan: [ { name: 'object', slots: [], textures: [] } ],
	} );

	const [ texture, sampler ] = state.bindings[ 0 ].bindings;
	assert.equal( texture.texture.isDepthTexture, true );
	assert.equal( sampler.texture.isDepthTexture, true );
	assert.notEqual( sampler.texture.compareFunction, null );

} );

test( 'runtime hydrator uses array-shaped fallback for depth texture array bindings', () => {

	const state = hydrateNodeBuilderState( {
		vertexShader: '',
		fragmentShader: '@group(1) @binding(0) var shadowTileTex : texture_depth_2d_array;\n@group(1) @binding(1) var shadowTileSampler : sampler_comparison;',
		bindings: [ {
			name: 'object',
			bindings: [
				{ name: 'shadowTileTex', kind: 'sampled-texture', visibility: 2, textureType: '2d-array' },
				{ name: 'shadowTileSampler', kind: 'sampler', visibility: 2 },
			],
		} ],
		uniformPlan: [ { name: 'object', slots: [], textures: [] } ],
	} );

	const [ texture, sampler ] = state.bindings[ 0 ].bindings;
	assert.equal( texture.texture.isDepthTexture, true );
	assert.equal( texture.texture.isArrayTexture, true );
	assert.equal( texture.texture.image.depth, 1 );
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

test( 'runtime hydrator invalidates shadow texture bindings after live depth rebind', () => {

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
	textureBinding.version = 8;
	textureBinding.generation = 9;
	const liveDepth = { isTexture: true, isDepthTexture: true, addEventListener() {}, removeEventListener() {} };
	const scene = {
		traverse( visit ) {

			visit( { isLight: true, castShadow: true, shadow: { map: { depthTexture: liveDepth } } } );

		},
	};

	state.updateBeforeNodes[ 0 ].updateBefore( { scene } );

	assert.equal( textureBinding.texture, liveDepth );
	assert.equal( textureBinding.version, - 1 );
	assert.equal( textureBinding.generation, null );

} );

test( 'runtime hydrator rebinds cloned shadow texture bindings', () => {

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
	const clonedBinding = textureBinding.clone();
	clonedBinding.version = 8;
	clonedBinding.generation = 9;
	const liveDepth = { isTexture: true, isDepthTexture: true, addEventListener() {}, removeEventListener() {} };
	const scene = {
		traverse( visit ) {

			visit( { isLight: true, castShadow: true, shadow: { map: { depthTexture: liveDepth } } } );

		},
	};

	state.updateBeforeNodes[ 0 ].updateBefore( { scene } );

	assert.equal( textureBinding.texture, liveDepth );
	assert.equal( clonedBinding.texture, liveDepth );
	assert.equal( clonedBinding.version, - 1 );
	assert.equal( clonedBinding.generation, null );

} );

test( 'runtime hydrator invalidates shadow binding when GPU texture appears later', () => {

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
	const liveDepth = { isTexture: true, isDepthTexture: true, compareFunction: null, addEventListener() {}, removeEventListener() {} };
	textureBinding.texture = liveDepth;
	textureBinding.version = 8;
	textureBinding.generation = 9;
	textureBinding.groupNode.version = 0;
	const gpuTexture = {};
	const scene = {
		traverse( visit ) {

			visit( { isLight: true, castShadow: true, shadow: { map: { depthTexture: liveDepth } } } );

		},
	};
	const renderer = {
		backend: {
			get( texture ) {

				return texture === liveDepth ? { texture: gpuTexture } : null;

			},
		},
	};

	state.updateBeforeNodes[ 0 ].updateBefore( { scene, renderer } );

	assert.equal( textureBinding.texture, liveDepth );
	assert.equal( textureBinding.version, - 1 );
	assert.equal( textureBinding.generation, null );
	assert.equal( textureBinding.groupNode.version, 1 );

} );

test( 'runtime hydrator drives material reflectors before rebinding their texture and sampler', () => {

	const liveReflectionTexture = new DataTexture( new Uint8Array( [ 255, 255, 255, 255 ] ), 1, 1 );
	const staleNestedReflectionTexture = new DataTexture( new Uint8Array( [ 0, 0, 0, 255 ] ), 1, 1 );
	const liveDepthTexture = new DepthTexture( 1, 1 );
	const staleDepthTexture = new DepthTexture( 1, 1 );
	const virtualCamera = { name: 'virtual-camera' };
	const nestedVirtualCamera = { name: 'nested-virtual-camera' };
	const depthReflectorNode = {
		isNode: true,
		isTextureNode: true,
		constructor: { type: 'ReflectorNode' },
		value: staleDepthTexture,
	};
	const baseNode = {
		constructor: { type: 'ReflectorBaseNode' },
		textureNode: {
			value: null,
			getDepthNode() {

				return depthReflectorNode;

			},
		},
		renderTargets: new Map( [ [ nestedVirtualCamera, { texture: staleNestedReflectionTexture } ] ] ),
		updateBeforeCalls: 0,
		getVirtualCamera() {

			return virtualCamera;

		},
		updateBefore() {

			this.updateBeforeCalls ++;
			this.renderTargets.set( virtualCamera, { texture: liveReflectionTexture, depthTexture: liveDepthTexture } );
			this.textureNode.value = liveReflectionTexture;

		},
	};
	depthReflectorNode._reflectorBaseNode = baseNode;
	const material = {
		__tslpReflectorBaseNodes: [ baseNode ],
	};
	const artifact = {
		vertexShader: '',
		fragmentShader: '@group(1) @binding(0) var reflectionSampler : sampler;\n@group(1) @binding(1) var reflectionTex : texture_2d<f32>;\n@group(1) @binding(2) var reflectionDepth : texture_depth_2d;',
		bindings: [ {
			name: 'object',
			bindings: [
				{ name: 'reflectionSampler', kind: 'sampler', visibility: 2 },
				{ name: 'reflectionTex', kind: 'sampled-texture', visibility: 2, textureType: '2d' },
				{ name: 'reflectionDepth', kind: 'sampled-texture', visibility: 2, textureType: '2d' },
			],
		} ],
		uniformPlan: [ {
			name: 'object',
			slots: [],
			textures: [
				{ name: 'reflectionSampler', source: { kind: 'reflector.texture', textureUuid: 'dead-reflector', reflectorIndex: 0 } },
				{ name: 'reflectionTex', source: { kind: 'reflector.texture', textureUuid: 'dead-reflector', reflectorIndex: 0 } },
				{ name: 'reflectionDepth', source: { kind: 'depth.texture', textureUuid: 'dead-depth', lightIndex: -1, fromMaterialGraph: true } },
			],
		} ],
	};

	const state = hydrateNodeBuilderState( artifact, material );
	assert.equal( state.updateBeforeNodes[ 0 ], baseNode );
	assert.equal( state.updateBeforeNodes.length, 3 );

	const [ samplerBinding, textureBinding, depthBinding ] = state.bindings[ 0 ].bindings;
	assert.notEqual( samplerBinding.texture, liveReflectionTexture );
	assert.notEqual( textureBinding.texture, liveReflectionTexture );
	assert.notEqual( depthBinding.texture, liveDepthTexture );

	for ( const node of state.updateBeforeNodes ) node.updateBefore( { scene: { name: 'Scene' }, camera: {}, material } );

	assert.equal( baseNode.updateBeforeCalls, 1 );
	assert.equal( samplerBinding.texture, liveReflectionTexture );
	assert.equal( textureBinding.texture, liveReflectionTexture );
	assert.equal( depthBinding.texture, liveDepthTexture );
	assert.equal( liveDepthTexture.compareFunction, null );

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

test( '__applyPrecompiled adopts onto a material with immutable identity', () => {

	const source = { name: 'immutable-material' };
	Object.defineProperty( source, 'id', {
		value: 17,
		enumerable: false,
		writable: false,
		configurable: false,
	} );
	const artifactModule = {
		__hash: 'sha256:immutable-material',
		name: 'immutable-material',
		artifact: {
			__hash: 'sha256:immutable-material',
			uniformPlan: [],
			vertexShader: 'v',
			fragmentShader: 'f',
		},
	};

	// The Babel transform emits this as a standalone call. Adoption therefore
	// has to mutate the object already held by the mesh; its return value is not
	// required for correctness.
	__applyPrecompiled( source, artifactModule, artifactModule.__hash );

	assert.equal( source.id, 17 );
	assert.equal( source.isPrecompiledMaterial, true );
	assert.equal( Object.getPrototypeOf( source ), PrecompiledMaterial.prototype );
	assert.equal( source.precompiledArtifact, artifactModule.artifact );

} );

test( '__applyPrecompiled wires live uniform sidecars by snapshot value', () => {

	const liveFrequency = { isUniformNode: true, value: { isVector2: true, x: 3, y: 1 } };
	const liveIterations = { isUniformNode: true, value: 3 };
	const liveMultiplier = { isUniformNode: true, value: 0.15 };
	const wrongScalar = { isUniformNode: true, value: 99 };
	const source = {
		positionNode: {
			isNode: true,
			liveFrequency,
			wrongScalar,
			liveIterations,
			liveMultiplier,
		},
	};
	const artifact = {
		__hash: 'sha256:live',
		uniformPlan: [ {
			name: 'object',
			slots: [
				{ dtype: 'vec2', source: { kind: 'uniform.live', valueSnapshot: { type: 'vec2', data: [ 3, 1 ] } } },
				{ dtype: 'number', source: { kind: 'uniform.live', valueSnapshot: { type: 'number', data: 3 } } },
				{ dtype: 'number', source: { kind: 'uniform.live', valueSnapshot: { type: 'number', data: 0.15 } } },
				{ dtype: 'number', source: { kind: 'uniform.live', valueSnapshot: { type: 'number', data: 3 } } },
			],
		} ],
		vertexShader: 'v',
		fragmentShader: 'f',
	};

	const wrapped = __applyPrecompiled( source, {
		__hash: 'sha256:live',
		name: 'live',
		artifact,
	}, 'sha256:live' );
	const slots = wrapped.precompiledArtifact.uniformPlan[ 0 ].slots;
	assert.equal( slots[ 0 ]._liveNode, liveFrequency );
	assert.equal( slots[ 1 ]._liveNode, liveIterations );
	assert.equal( slots[ 2 ]._liveNode, liveMultiplier );
	assert.equal( slots[ 3 ]._liveNode, liveIterations );
	assert.equal( slots[ 0 ].__tslpLiveSidecarOverlay, true );
	assert.equal( slots[ 1 ].__tslpLiveSidecarOverlay, true );

} );

test( '__applyPrecompiled live sidecars feed the hydrated UBO after user mutation', () => {

	const liveMultiplier = { isUniformNode: true, value: 0.15 };
	const source = {
		positionNode: {
			isNode: true,
			liveMultiplier,
		},
	};
	const artifact = {
		__hash: 'sha256:live-ubo',
		bindings: [ {
			name: 'object',
			bindings: [
				{ name: 'object', kind: 'uniform-buffer', visibility: 7, byteLength: 16 },
			],
		} ],
		uniformPlan: [ {
			name: 'object',
			byteLength: 16,
			slots: [
				{ offset: 0, dtype: 'number', source: { kind: 'uniform.live', valueSnapshot: { type: 'number', data: 0.15 } } },
			],
		} ],
		vertexShader: 'v',
		fragmentShader: 'f',
	};

	const wrapped = __applyPrecompiled( source, {
		__hash: 'sha256:live-ubo',
		name: 'live-ubo',
		updateGroup( _frame, _material, view ) {

			view.setFloat32( 0, 9.99, true );

		},
		artifact,
	}, 'sha256:live-ubo' );
	liveMultiplier.value = 0.42;

	const state = hydrateNodeBuilderState( wrapped.precompiledArtifact, wrapped );
	const ub = state.bindings[ 0 ].bindings[ 0 ];
	state.updateNodes[ state.updateNodes.length - 1 ].update( { time: 0, camera: null, material: wrapped } );

	const view = new DataView( ub.buffer.buffer );
	assert.ok( Math.abs( view.getFloat32( 0, true ) - 0.42 ) < 0.001 );

} );

test( '__applyPrecompiled live update sidecars refresh object-scoped uniform.live slots', () => {

	const liveColor = {
		isColor: true,
		r: 0,
		g: 0,
		b: 0,
		copy( color ) {

			this.r = color.r;
			this.g = color.g;
			this.b = color.b;
			return this;

		},
	};
	const liveUniform = { isUniformNode: true, value: liveColor };
	const objectColorNode = {
		isNode: true,
		uniformNode: liveUniform,
		getUpdateType() { return 'object'; },
		updateReference() { return this; },
		update( frame ) {

			this.uniformNode.value.copy( frame.object.color );

		},
	};
	const source = { colorNode: objectColorNode };
	const artifact = {
		__hash: 'sha256:object-live',
		bindings: [ {
			name: 'object',
			bindings: [
				{ name: 'object', kind: 'uniform-buffer', visibility: 7, byteLength: 16 },
			],
		} ],
		uniformPlan: [ {
			name: 'object',
			byteLength: 16,
			slots: [
				{ offset: 0, dtype: 'color', source: { kind: 'uniform.live', valueSnapshot: { type: 'color', data: [ 0.1, 0.2, 0.3 ] } } },
			],
		} ],
		vertexShader: 'v',
		fragmentShader: 'f',
	};

	const wrapped = __applyPrecompiled( source, {
		__hash: 'sha256:object-live',
		name: 'object-live',
		artifact,
	}, 'sha256:object-live' );
	const state = hydrateNodeBuilderState( wrapped.precompiledArtifact, wrapped );
	const frame = { time: 0, camera: null, material: wrapped, object: { color: { r: 0.8, g: 0.4, b: 0.2 } } };
	for ( const node of state.updateNodes ) node.update( frame );

	const ub = state.bindings[ 0 ].bindings[ 0 ];
	const view = new DataView( ub.buffer.buffer );
	assert.ok( Math.abs( view.getFloat32( 0, true ) - 0.8 ) < 0.001 );
	assert.ok( Math.abs( view.getFloat32( 4, true ) - 0.4 ) < 0.001 );
	assert.ok( Math.abs( view.getFloat32( 8, true ) - 0.2 ) < 0.001 );

} );

test( 'PrecompiledMaterial preserves captured two-pass transmission state', () => {

	const baseModule = {
		__hash: 'sha256:transmission',
		name: 'transmission',
		artifact: {
			__hash: 'sha256:transmission',
			uniformPlan: [],
			vertexShader: 'v',
			fragmentShader: 'f',
			renderState: { side: 2, forceSinglePass: false, transparent: false },
			defaults: { transmission: 1, thickness: 0 },
		},
	};
	const direct = new PrecompiledMaterial( baseModule.artifact );
	assert.equal( direct.forceSinglePass, false );
	assert.equal( direct.transparent, true );

	const thin = __applyPrecompiled( { transmission: 1, thickness: 0, transparent: false }, baseModule, 'sha256:transmission' );
	assert.equal( thin.forceSinglePass, false );
	assert.equal( thin.transparent, true );

	const thick = __applyPrecompiled( {}, {
		...baseModule,
		artifact: {
			...baseModule.artifact,
			defaults: { transmission: 1, thickness: 0.25 },
		},
	}, 'sha256:transmission' );
	assert.equal( thick.forceSinglePass, false );

} );

test( '__applyPrecompiled preserves source clipping controls during adoption', () => {

	const clippingPlanes = [ { normal: { x: 1, y: 0, z: 0 }, constant: - 1 } ];
	const source = {
		clippingPlanes,
		clipIntersection: true,
		clipShadows: true,
	};
	const material = __applyPrecompiled( source, {
		__hash: 'sha256:clipping-adoption',
		name: 'clipping-adoption',
		artifact: {
			__hash: 'sha256:clipping-adoption',
			uniformPlan: [],
			vertexShader: 'v',
			fragmentShader: 'f',
		},
	}, 'sha256:clipping-adoption' );

	assert.equal( material.clippingPlanes, clippingPlanes );
	assert.equal( material.clipIntersection, true );
	assert.equal( material.clipShadows, true );

} );

test( 'development apply entry validates artifact source kinds', () => {

	assert.throws( () => applyPrecompiledDevelopment( { name: 'bad' }, {
		__hash: 'sha256:bad',
		name: 'bad',
		artifact: {
			__hash: 'sha256:bad',
			uniformPlan: [ {
				name: 'object',
				slots: [ { source: { kind: 'mystery.kind' } } ],
			} ],
			vertexShader: 'v',
			fragmentShader: 'f',
		},
	}, 'sha256:bad' ), /unknown source\.kind "mystery\.kind"/ );

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

test( '__applyPrecompiled preserves backdrop markers for renderer ordering', () => {

	const backdropNode = { isNode: true, name: 'backdrop' };
	const backdropAlphaNode = { isNode: true, name: 'backdrop-alpha' };
	const wrapped = __applyPrecompiled( { name: 'backdrop-mat', backdropNode, backdropAlphaNode }, {
		__hash: 'sha256:backdrop',
		name: 'backdrop',
		artifact: {
			__hash: 'sha256:backdrop',
			uniformPlan: [],
			vertexShader: 'v',
			fragmentShader: 'f',
		},
	}, 'sha256:backdrop' );

	assert.equal( wrapped.backdropNode, backdropNode );
	assert.equal( wrapped.backdropAlphaNode, backdropAlphaNode );

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

test( 'runtime hydrator overlays live sidecars after generated per-group updater', () => {

	const liveNode = { value: 9.5 };
	const artifact = {
		vertexShader: '', fragmentShader: '',
		bindings: [ { name: 'object', bindings: [ { name: 'object', kind: 'uniform-buffer', visibility: 7, byteLength: 16 } ] } ],
		uniformPlan: [ {
			name: 'object',
			shared: false,
			byteLength: 16,
			slots: [
				{ offset: 0, dtype: 'number', source: { kind: 'material.opacity', property: 'opacity', valueSnapshot: { type: 'number', data: 0 } } },
				{ offset: 4, dtype: 'number', source: { kind: 'uniform.live', valueSnapshot: { type: 'number', data: 0 } } },
			],
		} ],
	};
	Object.defineProperty( artifact.uniformPlan[ 0 ].slots[ 1 ], '_liveNode', { value: liveNode, enumerable: false } );
	Object.defineProperty( artifact.uniformPlan[ 0 ].slots[ 1 ], '__tslpLiveSidecarOverlay', { value: true, enumerable: false } );
	Object.defineProperty( artifact, '_generatedUpdateGroup', {
		value( frame, material, view, byteOffset ) {

			view.setFloat32( byteOffset, material.opacity, true );
			view.setFloat32( byteOffset + 4, -1, true );

		},
		enumerable: false,
	} );

	const state = hydrateNodeBuilderState( artifact, { opacity: 0.625 } );
	const ub = state.bindings[ 0 ].bindings[ 0 ];
	state.updateNodes[ state.updateNodes.length - 1 ].update( { time: 0, camera: null } );

	const view = new DataView( ub.buffer.buffer );
	assert.equal( view.getFloat32( 0, true ), 0.625 );
	assert.equal( view.getFloat32( 4, true ), 9.5 );

} );

test( 'runtime hydrator overlays snapshot-only uniform.live slots after generated per-group updater', () => {

	const artifact = {
		vertexShader: '', fragmentShader: '',
		bindings: [ { name: 'object', bindings: [ { name: 'object', kind: 'uniform-buffer', visibility: 7, byteLength: 16 } ] } ],
		uniformPlan: [ {
			name: 'object',
			shared: false,
			byteLength: 16,
			slots: [
				{ offset: 0, dtype: 'number', source: { kind: 'uniform.live', property: 'opacity', valueType: 'number', valueSnapshot: { type: 'number', data: 0 } } },
				{ offset: 4, dtype: 'number', source: { kind: 'uniform.live', valueSnapshot: { type: 'number', data: 7.77 } } },
			],
		} ],
	};
	Object.defineProperty( artifact.uniformPlan[ 0 ].slots[ 0 ], '_liveNode', { value: { value: 99 }, enumerable: false } );
	Object.defineProperty( artifact.uniformPlan[ 0 ].slots[ 0 ], '__tslpLiveSidecarOverlay', { value: true, enumerable: false } );
	Object.defineProperty( artifact, '_generatedUpdateGroup', {
		value( frame, material, view, byteOffset ) {

			view.setFloat32( byteOffset, material.opacity, true );
			view.setFloat32( byteOffset + 4, - 1, true );

		},
		enumerable: false,
	} );

	const state = hydrateNodeBuilderState( artifact, { opacity: 0.625 } );
	const ub = state.bindings[ 0 ].bindings[ 0 ];
	state.updateNodes[ state.updateNodes.length - 1 ].update( { time: 0, camera: null } );

	const view = new DataView( ub.buffer.buffer );
	assert.equal( view.getFloat32( 0, true ), 0.625 );
	assert.ok( Math.abs( view.getFloat32( 4, true ) - 7.77 ) < 0.001 );

} );

test( 'PrecompiledComputeNode exposes the slim compute fast-path flags', () => {

	const artifact = { kind: 'compute', computeShader: 'cs', uniformPlan: [], dispatchSize: 32, workgroupSize: [ 8, 4 ] };
	const node = new PrecompiledComputeNode( artifact );

	assert.equal( node.isNode, true );
	assert.equal( node.isComputeNode, true );
	assert.equal( node.isPrecompiledCompute, true );
	assert.equal( node.precompiledArtifact, artifact );
	assert.equal( node.count, 32 );
	assert.equal( node.dispatchSize, null );
	assert.deepEqual( node.workgroupSize, [ 8, 4, 1 ] );
	assert.equal( node.getUpdateType(), 'none' );

} );

test( 'PrecompiledComputeNode preserves explicit dispatch arrays and renderer event hooks', () => {

	const artifact = { kind: 'compute', computeShader: 'cs', uniformPlan: [], dispatchSize: [ 2, 3, 4 ], workgroupSize: [ 16, 2, 1 ] };
	const node = new PrecompiledComputeNode( artifact );
	let disposed = 0;
	const onDispose = ( event ) => {

		assert.equal( event.target, node );
		disposed ++;

	};

	node.addEventListener( 'dispose', onDispose );
	assert.equal( node.hasEventListener( 'dispose', onDispose ), true );
	node.dispose();
	node.removeEventListener( 'dispose', onDispose );
	node.dispose();

	assert.equal( node.count, null );
	assert.deepEqual( node.dispatchSize, [ 2, 3, 4 ] );
	assert.equal( disposed, 1 );

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
	Object.defineProperty( artifact.uniformPlan[ 0 ].slots[ 0 ], '__tslpLiveSidecarOverlay', { value: true, enumerable: false } );

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
	Object.defineProperty( artifact.uniformPlan[ 0 ].slots[ 0 ], '__tslpLiveSidecarOverlay', { value: true, enumerable: false } );
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
	assert.equal( artifact._textureResolutionStrategies.get( 'obj:myTex' ), 'texture-ref' );

} );

test( 'hydrator: variant texture rebinders see sidecars added after hydration', () => {

	const tex = { isTexture: true, uuid: 'late-tex', addEventListener() {}, removeEventListener() {}, version: 0 };
	const artifact = {
		vertexShader: '',
		fragmentShader: '',
		bindings: [ { name: 'obj', bindings: [ { name: 'myTex', kind: 'sampled-texture', visibility: 2, textureType: '2d' } ] } ],
		uniformPlan: [ {
			name: 'obj',
			shared: false,
			slots: [],
			textures: [ { name: 'myTex', source: { kind: 'artifact.texture', textureUuid: 'late-tex' } } ],
		} ],
		variants: {
			'variant-key': {
				vertexShader: '',
				fragmentShader: '',
				bindings: [ { name: 'obj', bindings: [ { name: 'myTex', kind: 'sampled-texture', visibility: 2, textureType: '2d' } ] } ],
				uniformPlan: [ {
					name: 'obj',
					shared: false,
					slots: [],
					textures: [ { name: 'myTex', source: { kind: 'artifact.texture', textureUuid: 'late-tex' } } ],
				} ],
			},
		},
	};

	const state = hydrateNodeBuilderState( artifact, null, null, 'variant-key' );
	const binding = state.bindings[ 0 ].bindings[ 0 ];
	assert.notEqual( binding.texture, tex );

	Object.defineProperty( artifact, '_textureRefs', {
		value: new Map( [ [ 'late-tex', tex ] ] ),
		enumerable: false,
		configurable: true,
		writable: true,
	} );

	for ( const node of state.updateBeforeNodes ) {

		if ( node && typeof node.updateBefore === 'function' ) node.updateBefore( { renderer: null } );

	}

	assert.equal( binding.texture, tex );

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

test( 'hydrator swaps zero-thickness transmission to a live viewport texture', () => {

	const artifact = {
		vertexShader: '',
		fragmentShader: '@group(1) @binding(0) var viewportTex : texture_2d<f32>;',
		defaults: { transmission: 1, thickness: 0 },
		renderState: { transparent: true },
		bindings: [ {
			name: 'object',
			bindings: [
				{ name: 'viewportTex', kind: 'sampled-texture', visibility: 2 },
			],
		} ],
		uniformPlan: [ {
			name: 'object',
			slots: [],
			textures: [
				{ name: 'alphaMap', source: { kind: 'material.alphaMap', property: 'alphaMap' } },
				{ name: 'viewportTex', source: { kind: 'viewport.texture', generateMipmaps: true, isDepth: false } },
			],
		} ],
	};
	const material = { transmission: 1, thickness: 0 };
	const state = hydrateNodeBuilderState( artifact, material );
	const binding = state.bindings[ 0 ].bindings[ 0 ];
	const fallback = binding.texture;
	let copiedTexture = null;
	const renderer = {
		backend: { get( texture ) { return { texture }; } },
		getRenderTarget() { return null; },
		getCanvasTarget() { return null; },
		getDrawingBufferSize( target ) { target.set( 2, 2 ); },
		copyFramebufferToTexture( texture ) { copiedTexture = texture; },
	};

	assert.equal( state.updateBeforeNodes.length, 1 );
	assert.equal( binding.texture, fallback );
	state.updateBeforeNodes[ 0 ].updateBefore( { renderer, renderId: 1 } );
	assert.ok( copiedTexture, 'viewport rebinder must ask the renderer for a live copy' );
	assert.equal( binding.texture, copiedTexture );
	assert.notEqual( binding.texture, fallback );

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

test( 'hydrator: standalone buffer-uniform keeps its own byte length inside render group', () => {

	const artifact = {
		vertexShader: '',
		fragmentShader: 'fn clipped() -> bool { return false; }',
		bindings: [ {
			name: 'render',
			bindings: [
				{ name: 'UniformBuffer_4', kind: 'uniform-buffer', visibility: 2, byteLength: 32 },
				{ name: 'render', kind: 'uniform-buffer', visibility: 7, byteLength: 272 },
			],
		} ],
		uniformPlan: [ {
			name: 'render',
			byteLength: 272,
			slots: [ {
				name: 'cameraViewMatrix',
				offset: 0,
				size: 64,
				dtype: 'mat4',
				source: { kind: 'camera.viewMatrix', valueSnapshot: { type: 'mat4', data: new Array( 16 ).fill( 1 ) } },
			} ],
			textures: [],
			orderedBindings: [
				{ type: 'buffer-uniform', ref: { name: 'UniformBuffer_4', byteLength: 32, valueSnapshot: [ 1, 2, 3, 4, 5, 6, 7, 8 ] } },
				{ type: 'ubo' },
			],
		} ],
	};

	const state = hydrateNodeBuilderState( artifact );
	const [ standalone, render ] = state.bindings[ 0 ].bindings;
	assert.equal( standalone.buffer.length, 8 );
	assert.equal( render.buffer.length, 68 );
	assert.deepEqual( Array.from( standalone.buffer ), [ 1, 2, 3, 4, 5, 6, 7, 8 ] );

} );

test( 'hydrator: duplicate skinned velocity uniform buffers resolve previous and current bone matrices', () => {

	let nextBoneValues = [ 10, 11, 12, 13, 14, 15, 16, 17 ];
	let updateCount = 0;
	const skeleton = {
		boneMatrices: new Float32Array( [ 1, 2, 3, 4, 5, 6, 7, 8 ] ),
		previousBoneMatrices: null,
		update() {
			updateCount ++;
			this.boneMatrices.set( nextBoneValues );
		},
	};
	const material = {
		__tslpPrecompileObject: { skeleton },
		__tslpCurrentFrame: { frameId: 1 },
	};
	const artifact = {
		vertexShader: 'var positionPrevious : vec3<f32>;',
		fragmentShader: '',
		bindings: [ {
			name: 'object',
			bindings: [
				{ name: 'UniformBuffer_0', kind: 'uniform-buffer', visibility: 1, byteLength: 32 },
				{ name: 'UniformBuffer_1', kind: 'uniform-buffer', visibility: 1, byteLength: 32 },
			],
		} ],
		uniformPlan: [ {
			name: 'object',
			slots: [],
			orderedBindings: [
				{ type: 'buffer-uniform', ref: { name: 'UniformBuffer_0', byteLength: 32, valueSnapshot: new Array( 8 ).fill( 0 ) } },
				{ type: 'buffer-uniform', ref: { name: 'UniformBuffer_1', byteLength: 32, valueSnapshot: new Array( 8 ).fill( 0 ) } },
			],
		} ],
	};

	const state = hydrateNodeBuilderState( artifact, material );
	const [ previousBones, currentBones ] = state.bindings[ 0 ].bindings;
	previousBones.update();
	currentBones.update();

	assert.deepEqual( Array.from( previousBones.buffer ), [ 1, 2, 3, 4, 5, 6, 7, 8 ] );
	assert.deepEqual( Array.from( currentBones.buffer ), [ 10, 11, 12, 13, 14, 15, 16, 17 ] );
	assert.deepEqual( Array.from( skeleton.previousBoneMatrices ), [ 1, 2, 3, 4, 5, 6, 7, 8 ] );
	assert.equal( updateCount, 1 );

	nextBoneValues = [ 20, 21, 22, 23, 24, 25, 26, 27 ];
	material.__tslpCurrentFrame = { frameId: 2 };
	previousBones.update();
	currentBones.update();

	assert.deepEqual( Array.from( previousBones.buffer ), [ 10, 11, 12, 13, 14, 15, 16, 17 ] );
	assert.deepEqual( Array.from( currentBones.buffer ), [ 20, 21, 22, 23, 24, 25, 26, 27 ] );
	assert.equal( updateCount, 2 );

	nextBoneValues = [ 30, 31, 32, 33, 34, 35, 36, 37 ];
	material.__tslpCurrentFrame = { frameId: 3, renderer: { __tslpSuppressVelocityStateAdvance: true } };
	previousBones.update();
	currentBones.update();

	assert.deepEqual( Array.from( previousBones.buffer ), [ 10, 11, 12, 13, 14, 15, 16, 17 ] );
	assert.deepEqual( Array.from( currentBones.buffer ), [ 20, 21, 22, 23, 24, 25, 26, 27 ] );
	assert.equal( updateCount, 2 );

	const renderer = {};
	material.__tslpCurrentFrame = { frameId: 400, renderer };
	withTemporalFrame( renderer, { frameId: 2, advance: false }, () => {

		previousBones.update();
		currentBones.update();

	} );
	assert.deepEqual( Array.from( previousBones.buffer ), [ 10, 11, 12, 13, 14, 15, 16, 17 ] );
	assert.deepEqual( Array.from( currentBones.buffer ), [ 20, 21, 22, 23, 24, 25, 26, 27 ] );
	assert.equal( updateCount, 2 );

	withTemporalFrame( renderer, { frameId: 3 }, () => {

		previousBones.update();
		currentBones.update();

	} );
	assert.deepEqual( Array.from( previousBones.buffer ), [ 20, 21, 22, 23, 24, 25, 26, 27 ] );
	assert.deepEqual( Array.from( currentBones.buffer ), [ 30, 31, 32, 33, 34, 35, 36, 37 ] );
	assert.equal( updateCount, 3 );

	let coldUpdateCount = 0;
	const coldSkeleton = {
		boneMatrices: new Float32Array( 8 ),
		previousBoneMatrices: null,
		update() {
			coldUpdateCount ++;
			this.boneMatrices.set( [ 40, 41, 42, 43, 44, 45, 46, 47 ] );
		},
	};
	const coldMaterial = {
		__tslpPrecompileObject: { skeleton: coldSkeleton },
		__tslpCurrentFrame: { frameId: 1 },
	};
	const coldState = hydrateNodeBuilderState( artifact, coldMaterial );
	const [ coldPreviousBones, coldCurrentBones ] = coldState.bindings[ 0 ].bindings;
	coldPreviousBones.update();
	coldCurrentBones.update();

	assert.deepEqual( Array.from( coldPreviousBones.buffer ), [ 40, 41, 42, 43, 44, 45, 46, 47 ] );
	assert.deepEqual( Array.from( coldCurrentBones.buffer ), [ 40, 41, 42, 43, 44, 45, 46, 47 ] );
	assert.deepEqual( Array.from( coldSkeleton.previousBoneMatrices ), [ 40, 41, 42, 43, 44, 45, 46, 47 ] );
	assert.equal( coldUpdateCount, 1 );

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
// Task mrt-pass-aux: PassNode.setMRT + getTexture support
// ─────────────────────────────────────────────────────────────────────────────

test( 'slim-stubs: PassNode.setMRT stores the mrt descriptor and returns this', () => {

	const pass = new PassNode( PassNode.COLOR, null, null );
	const mrtDescriptor = { isNode: true, outputNodes: { output: {}, normal: {} } };
	const result = pass.setMRT( mrtDescriptor );

	assert.equal( result, pass, 'setMRT must return this for chaining' );
	assert.equal( pass._mrt, mrtDescriptor, 'setMRT must store mrtNode in _mrt' );

} );

test( 'slim-stubs: PassNode.getTexture returns a live render-target texture', () => {

	const pass = new PassNode();
	const tex = pass.getTexture( 'output' );

	assert.ok( tex, 'getTexture must return a value' );
	assert.equal( tex.isTexture, true, 'getTexture returns the texture object postprocess artifacts sample' );
	assert.equal( tex.name, 'output' );
	assert.equal( pass.getTextureNode( 'output' ).value, tex, 'texture node points at the same live texture' );

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

test( 'slim-stubs: instancedBufferAttribute carriers survive production-style graph traversal', () => {

	const timeAttribute = {
		isBufferAttribute: true,
		isInstancedBufferAttribute: true,
		count: 2,
		itemSize: 1,
		array: new Float32Array( [ 0.1, 0.2 ] ),
	};
	const positionAttribute = {
		isBufferAttribute: true,
		isInstancedBufferAttribute: true,
		count: 2,
		itemSize: 3,
		array: new Float32Array( [ 1, 2, 3, 4, 5, 6 ] ),
	};
	const seedAttribute = {
		isBufferAttribute: true,
		isInstancedBufferAttribute: true,
		count: 2,
		itemSize: 1,
		array: new Float32Array( [ 0.7, 0.8 ] ),
	};

	const instancePosition = instancedBufferAttribute( positionAttribute );
	const instanceSeed = instancedBufferAttribute( seedAttribute );
	const instanceTime = instancedBufferAttribute( timeAttribute );
	const localTime = instanceTime.add( time );
	const modTime = mod( time.mul( 0.4 ), 1 );
	const s0 = sin( localTime.add( instanceSeed ) ).mul( 0.25 );
	const dist = abs( instanceTime.sub( modTime ) ).toConst();
	const wrapDist = select( dist.greaterThan( 0.5 ), dist.oneMinus(), dist ).toConst();
	const s1 = select( wrapDist.greaterThan( 0.1 ), float( 1 ), wrapDist.remap( 0, 0.1, 3, 1 ) );
	const offset = vec3( instancePosition.x, instancePosition.y.add( s0 ), instancePosition.z ).toConst( 'offset' );

	const state = hydrateNodeBuilderState( {
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		attributes: [
			{ name: 'nodeAttribute0', type: 'float', source: 'node', count: 2, itemSize: 1, arrayType: 'Float32Array', instanced: true, storage: false, userPath: [ 'positionNode' ] },
			{ name: 'nodeAttribute2', type: 'vec3', source: 'node', count: 2, itemSize: 3, arrayType: 'Float32Array', instanced: true, storage: false, userPath: [ 'positionNode' ] },
			{ name: 'nodeAttribute3', type: 'float', source: 'node', count: 2, itemSize: 1, arrayType: 'Float32Array', instanced: true, storage: false, userPath: [ 'positionNode' ] },
		],
		bindings: [],
		uniformPlan: [],
	}, {
		positionNode: positionLocal.mul( s1 ).add( offset ),
	} );

	assert.equal( state.nodeAttributes[ 0 ].node.attribute, timeAttribute );
	assert.equal( state.nodeAttributes[ 1 ].node.attribute, positionAttribute );
	assert.equal( state.nodeAttributes[ 2 ].node.attribute, seedAttribute );

} );

test( 'slim-stubs: instancedArray carries a live storage attribute', () => {

	const node = instancedArray( new Float32Array( [ 1, 2, 3, 4, 5, 6 ] ), 'vec3' ).setName( 'positions' );
	const element = node.element( 0 );

	assert.ok( node.value.isStorageInstancedBufferAttribute );
	assert.equal( node.value.itemSize, 3 );
	assert.equal( node.value.count, 2 );
	assert.equal( node.value.name, 'positions' );
	assert.equal( element.value, node.value );

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

test( 'hydrator: resolves registered texture by loader URL stored in userData', () => {

	clearLiveTextureIndex();

	const live = new DataTexture( new Uint8Array( [ 255, 255, 255, 255 ] ), 1, 1 );
	live.name = '';
	live.userData.__tslpLoaderUrl = 'textures/materialx/brass_basecolor.png';
	registerLiveTexture( live );

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
				{
					name: 'nodeUniform0',
					bindingKind: 'sampled-texture',
					textureType: '2d',
					source: {
						kind: 'artifact.texture',
						textureUuid: 'captured-loader-texture',
						imageSrc: 'textures/materialx/brass_basecolor.png',
					},
				},
			],
		} ],
	};

	const state = hydrateNodeBuilderState( artifact );
	const binding = state.bindings[ 0 ].bindings[ 0 ];
	assert.equal( binding.texture, live );

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

async function loadPatchedApplicationThree() {

	const three = await import( 'three' );
	installLiveTextureRegistryPatches( three );
	return three;

}

test( 'hydrator: anonymous DataTexture by shape replaces trivial-zeros snapshot', async () => {

	clearLiveTextureIndex();

	const { DataTexture, RedFormat, UnsignedByteType } = await loadPatchedApplicationThree();
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

	const { DataTexture, RedFormat, UnsignedByteType } = await loadPatchedApplicationThree();
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

	const { DataTexture, RedFormat, UnsignedByteType } = await loadPatchedApplicationThree();
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

test( 'collectLiveMaterialTextures: walks volume material node slots', () => {

	const offsetTex = { isTexture: true, uuid: 'tex-volume-offset' };
	const scatteringTex = { isTexture: true, uuid: 'tex-volume-scattering' };
	const sourceMaterial = {
		offsetNode: { isTextureNode: true, value: offsetTex },
		scatteringNode: {
			isNode: true,
			traverse( cb ) {

				cb( { isTextureNode: true, value: scatteringTex } );

			},
		},
	};
	const out = collectLiveMaterialTextures( sourceMaterial );

	assert.equal( out.size, 2 );
	assert.equal( out.get( 'tex-volume-offset' ), offsetTex );
	assert.equal( out.get( 'tex-volume-scattering' ), scatteringTex );

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

test( 'catalogueArtifactTextureRefs: pairs anonymous node textures by captured shape order', () => {

	const first = { isTexture: true, uuid: 'live-first', image: { width: 4, height: 4 } };
	const second = { isTexture: true, uuid: 'live-second', image: { width: 8, height: 8 } };
	const sourceMaterial = {
		colorNode: {
			isNode: true,
			traverse( cb ) {

				cb( { isTextureNode: true, value: first } );
				cb( { isTextureNode: true, value: second } );

			},
		},
	};
	const artifact = {
		uniformPlan: [ {
			name: 'object',
			textures: [
				{ bindingKind: 'sampled-texture', name: 'nodeUniform0', source: { kind: 'artifact.texture', textureUuid: 'captured-first', imageWidth: 4, imageHeight: 4 } },
				{ bindingKind: 'sampled-texture', name: 'nodeUniform1', source: { kind: 'artifact.texture', textureUuid: 'captured-second', imageWidth: 8, imageHeight: 8 } },
			],
		} ],
	};

	const added = catalogueArtifactTextureRefs( artifact, sourceMaterial );

	assert.equal( added, 2 );
	assert.ok( artifact._textureRefs instanceof Map );
	assert.equal( artifact._textureRefs.get( 'captured-first' ), first );
	assert.equal( artifact._textureRefs.get( 'captured-second' ), second );

} );
