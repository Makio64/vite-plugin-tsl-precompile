import test from 'node:test';
import assert from 'node:assert/strict';

import { extractUniformPlan } from '../../src/vendor/extractUniformPlan.js';

function makeUniformSlot( node, value ) {

	return {
		isNumberUniform: true,
		name: 'nodeUniform0',
		offset: 0,
		itemSize: 1,
		nodeUniform: { node },
		getType() { return 'float'; },
		getValue() { return value; },
	};

}

test( 'extractUniformPlan maps object-owned UniformNode properties', () => {

	const distortionScale = {
		isUniformNode: true,
		constructor: { type: 'UniformNode' },
		nodeType: 'float',
		value: 3.7,
	};
	const state = {
		updateNodes: [],
		bindings: [ {
			name: 'object',
			bindings: [ {
				isUniformsGroup: true,
				byteLength: 16,
				visibility: 2,
				groupNode: { shared: false },
				uniforms: [ makeUniformSlot( distortionScale, distortionScale.value ) ],
			} ],
		} ],
	};

	const plan = extractUniformPlan( state, { object: { distortionScale } } );
	assert.equal( plan[ 0 ].slots[ 0 ].source.kind, 'object3d.nodeUniform' );
	assert.equal( plan[ 0 ].slots[ 0 ].source.property, 'distortionScale' );
	assert.deepEqual( plan[ 0 ].slots[ 0 ].source.valueSnapshot, { type: 'number', data: 3.7 } );

} );

// Wave 6 S1: classifyByCallback lifts `uniform(...).onFrameUpdate(frame => frame.time * k)`
// to a `frame.time.scaled` slot with the recorded scale, so the emit-updater and
// hydrator honour __tslpPinnedClock instead of freezing on uniform.live.
test( 'extractUniformPlan detects frame.time passthrough callback as frame.time', () => {

	const callback = ( frame ) => frame.time;
	const node = {
		isUniformNode: true,
		constructor: { type: 'UniformNode' },
		nodeType: 'float',
		updateType: 'frame',
		value: 0,
		update( frame ) { this.value = callback( frame ); },
	};
	const state = {
		updateNodes: [ node ],
		bindings: [ {
			name: 'render',
			bindings: [ {
				isUniformsGroup: true,
				byteLength: 4,
				visibility: 1,
				groupNode: { shared: true },
				uniforms: [ makeUniformSlot( node, node.value ) ],
			} ],
		} ],
	};
	const plan = extractUniformPlan( state, {} );
	assert.equal( plan[ 0 ].slots[ 0 ].source.kind, 'frame.time' );
	// Side effects of probing must not leak — node.value restored to original.
	assert.equal( node.value, 0 );

} );

test( 'extractUniformPlan detects frame.time scaled callback (Wave 6 S1)', () => {

	const callback = ( frame ) => frame.time * 0.75;
	const node = {
		isUniformNode: true,
		constructor: { type: 'UniformNode' },
		nodeType: 'float',
		updateType: 'frame',
		value: 0,
		update( frame ) { this.value = callback( frame ); },
	};
	const state = {
		updateNodes: [ node ],
		bindings: [ {
			name: 'render',
			bindings: [ {
				isUniformsGroup: true,
				byteLength: 4,
				visibility: 1,
				groupNode: { shared: true },
				uniforms: [ makeUniformSlot( node, node.value ) ],
			} ],
		} ],
	};
	const plan = extractUniformPlan( state, {} );
	assert.equal( plan[ 0 ].slots[ 0 ].source.kind, 'frame.time.scaled' );
	assert.ok( Math.abs( plan[ 0 ].slots[ 0 ].source.scale - 0.75 ) < 1e-9 );
	assert.equal( node.value, 0 );

} );

test( 'extractUniformPlan detects frame.deltaTime callback (Wave 6 S1)', () => {

	const callback = ( frame ) => frame.deltaTime;
	const node = {
		isUniformNode: true,
		constructor: { type: 'UniformNode' },
		nodeType: 'float',
		updateType: 'frame',
		value: 0,
		update( frame ) { this.value = callback( frame ); },
	};
	const state = {
		updateNodes: [ node ],
		bindings: [ {
			name: 'render',
			bindings: [ {
				isUniformsGroup: true,
				byteLength: 4,
				visibility: 1,
				groupNode: { shared: true },
				uniforms: [ makeUniformSlot( node, node.value ) ],
			} ],
		} ],
	};
	const plan = extractUniformPlan( state, {} );
	assert.equal( plan[ 0 ].slots[ 0 ].source.kind, 'frame.deltaTime' );

} );

test( 'extractUniformPlan leaves non-linear time callbacks as uniform.live', () => {

	// sin(time) is not linear — the detector must NOT misclassify it as
	// frame.time.scaled, since the three-frame coherence guard fails.
	const callback = ( frame ) => Math.sin( frame.time );
	const node = {
		isUniformNode: true,
		constructor: { type: 'UniformNode' },
		nodeType: 'float',
		updateType: 'frame',
		value: 0,
		update( frame ) { this.value = callback( frame ); },
	};
	const state = {
		updateNodes: [ node ],
		bindings: [ {
			name: 'render',
			bindings: [ {
				isUniformsGroup: true,
				byteLength: 4,
				visibility: 1,
				groupNode: { shared: true },
				uniforms: [ makeUniformSlot( node, node.value ) ],
			} ],
		} ],
	};
	const plan = extractUniformPlan( state, {} );
	assert.equal( plan[ 0 ].slots[ 0 ].source.kind, 'uniform.live' );

} );
