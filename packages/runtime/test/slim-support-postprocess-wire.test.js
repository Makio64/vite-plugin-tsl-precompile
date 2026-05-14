import test from 'node:test';
import assert from 'node:assert/strict';

import {
	collectLiveBloomNodes,
	wireBloomNode,
	wirePrecompiledPostprocess,
} from '../src/slim-support/postprocess-wire.js';
import {
	registerAuxArtifact,
	__resetAuxRegistryForTests,
} from '../src/aux-loader.js';

function fakeBloomNode( { withSubMaterials = true, blurCount = 5 } = {} ) {

	const node = {
		updateBefore: () => {},
		_renderTargetBright: { texture: {}, width: 1, height: 1 },
		_renderTargetsHorizontal: [],
		_renderTargetsVertical: [],
	};
	if ( withSubMaterials ) {

		node._highPassFilterMaterial = {};
		node._separableBlurMaterials = [];
		for ( let i = 0; i < blurCount; i ++ ) node._separableBlurMaterials.push( {} );
		node._compositeMaterial = {};

	}
	return node;

}

function registerBloomAuxArtifacts() {

	registerAuxArtifact( 'bloom-high-pass', 'hp-hash', {
		uniformPlan: [], vertexShader: '', fragmentShader: '',
	}, { name: 'aux-bloom-high-pass-hp-hash' } );
	for ( let i = 0; i < 5; i ++ ) {

		registerAuxArtifact( `bloom-blur-${ i }`, `blur-${ i }-hash`, {
			uniformPlan: [], vertexShader: '', fragmentShader: '',
		}, { name: `aux-bloom-blur-${ i }-blur-${ i }-hash` } );

	}
	registerAuxArtifact( 'bloom-composite', 'comp-hash', {
		uniformPlan: [], vertexShader: '', fragmentShader: '',
	}, { name: 'aux-bloom-composite-comp-hash' } );

}

test( 'collectLiveBloomNodes finds top-level bloom node', () => {

	const bloom = fakeBloomNode();
	const found = collectLiveBloomNodes( bloom );
	assert.deepEqual( found, [ bloom ] );

} );

test( 'collectLiveBloomNodes finds bloom nested in an outputNode tree', () => {

	const bloom = fakeBloomNode();
	const outputNode = { aNode: { bNode: bloom }, colorNode: bloom };
	const found = collectLiveBloomNodes( outputNode );
	// Deduplicated even though `bloom` is reachable twice.
	assert.equal( found.length, 1 );
	assert.equal( found[ 0 ], bloom );

} );

test( 'collectLiveBloomNodes returns empty for non-bloom roots', () => {

	const node = { isNode: true, nodeType: 'float' };
	assert.deepEqual( collectLiveBloomNodes( node ), [] );
	assert.deepEqual( collectLiveBloomNodes( null ), [] );

} );

test( 'wireBloomNode stamps __tslpAuxShape on each constructed sub-material', () => {

	__resetAuxRegistryForTests();
	registerBloomAuxArtifacts();
	const bloom = fakeBloomNode();
	const result = wireBloomNode( bloom );

	assert.equal( result.missed.length, 0, 'no misses when all materials + auxes present' );
	assert.equal( result.wired.length, 7, '1 high-pass + 5 blur + 1 composite = 7' );
	assert.equal( bloom._highPassFilterMaterial.__tslpAuxShape, 'bloom-high-pass' );
	assert.equal( bloom._separableBlurMaterials[ 2 ].__tslpAuxShape, 'bloom-blur-2' );
	assert.equal( bloom._compositeMaterial.__tslpAuxShape, 'bloom-composite' );

} );

test( 'wireBloomNode reports a generic miss when sub-materials not yet constructed', () => {

	__resetAuxRegistryForTests();
	registerBloomAuxArtifacts();
	const bloom = fakeBloomNode( { withSubMaterials: false } );
	const result = wireBloomNode( bloom );

	assert.equal( result.wired.length, 0 );
	// Registry-driven wiring reports a single shape-level miss for the
	// effect when its handler returns no sub-passes (lazy construction).
	assert.equal( result.missed.length, 1 );
	assert.equal( result.missed[ 0 ].shape, 'bloom:*' );
	assert.match( result.missed[ 0 ].reason, /materials not constructed yet/ );

} );

test( 'wireBloomNode misses shapes when aux registry is empty', () => {

	__resetAuxRegistryForTests();
	const bloom = fakeBloomNode();
	const result = wireBloomNode( bloom );

	assert.equal( result.wired.length, 0 );
	assert.equal( result.missed.every( ( m ) => m.reason === 'no aux artifact registered for shape' ), true );

} );

test( 'wirePrecompiledPostprocess accepts a postProcessing object with outputNode', () => {

	__resetAuxRegistryForTests();
	registerBloomAuxArtifacts();
	const bloom = fakeBloomNode();
	const postProcessing = { outputNode: { colorNode: bloom } };

	const result = wirePrecompiledPostprocess( { postProcessing } );
	assert.equal( result.effects, 1 );
	assert.equal( result.wired.length, 7 );
	assert.equal( bloom._compositeMaterial.__tslpAuxShape, 'bloom-composite' );

} );

test( 'wirePrecompiledPostprocess returns a no-outputNode miss when called empty', () => {

	const result = wirePrecompiledPostprocess( {} );
	assert.equal( result.effects, 0 );
	assert.equal( result.missed.length, 1 );
	assert.equal( result.missed[ 0 ].reason, 'no outputNode passed' );

} );

test( 'wirePrecompiledPostprocess is idempotent', () => {

	__resetAuxRegistryForTests();
	registerBloomAuxArtifacts();
	const bloom = fakeBloomNode();
	const postProcessing = { outputNode: bloom };

	const first = wirePrecompiledPostprocess( { postProcessing } );
	const second = wirePrecompiledPostprocess( { postProcessing } );
	assert.equal( first.effects, second.effects );
	assert.equal( first.wired.length, second.wired.length );
	// Stamping a node a second time does not corrupt the stamp.
	assert.equal( bloom._compositeMaterial.__tslpAuxShape, 'bloom-composite' );

} );
