import test from 'node:test';
import assert from 'node:assert/strict';

import { hydrateNodeBuilderState } from '../src/hydrator.js';

const REQUIRED_STATE_KEYS = [
	'bindings',
	'build',
	'buildAsync',
	'computeShader',
	'createBindings',
	'fragmentShader',
	'getAttributesArray',
	'getBindings',
	'hardwareClipping',
	'nodeAttributes',
	'observer',
	'transforms',
	'updateAfterNodes',
	'updateBeforeNodes',
	'updateNodes',
	'usedTimes',
	'vertexShader',
];

function createState() {

	return hydrateNodeBuilderState( {
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		computeShader: 'compute',
		bindings: [],
		nodeAttributes: [],
		uniformPlan: [],
	} );

}

test( 'hydrated NodeBuilderState exposes only its explicit required surface', () => {

	const state = createState();

	assert.equal( Object.getPrototypeOf( state ), Object.prototype );
	assert.deepEqual( Reflect.ownKeys( state ).sort(), REQUIRED_STATE_KEYS );
	assert.equal( typeof state.createBindings, 'function' );
	assert.equal( typeof state.getAttributesArray, 'function' );
	assert.equal( typeof state.getBindings, 'function' );
	assert.equal( typeof state.build, 'function' );
	assert.equal( typeof state.buildAsync, 'function' );

} );

test( 'hydrated NodeBuilderState does not fabricate unknown renderer methods', () => {

	const state = createState();

	assert.equal( state.getUnknownRendererProbe, undefined );
	assert.equal( state[ Symbol.for( 'tsl-precompile.unknown-state-probe' ) ], undefined );
	assert.equal( 'getUnknownRendererProbe' in state, false );

} );

test( 'hydrated NodeBuilderState remains non-thenable', async () => {

	const state = createState();

	assert.equal( state.then, undefined );
	assert.equal( Object.hasOwn( state, 'then' ), false );
	assert.equal( 'then' in state, false );
	assert.equal( await Promise.resolve( state ), state );

} );
