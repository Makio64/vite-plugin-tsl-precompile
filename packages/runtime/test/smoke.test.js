import { test } from 'node:test';
import assert from 'node:assert/strict';

import { registerArtifact, getArtifact } from '../src/artifact-loader.js';
import { hydrateNodeBuilderState } from '../src/hydrator.js';
import { __applyPrecompiled } from '../src/apply-precompiled.js';
import { PrecompiledComputeNode } from '../src/precompiled-compute-node.js';

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
