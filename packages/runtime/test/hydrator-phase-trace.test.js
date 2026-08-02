import test from 'node:test';
import assert from 'node:assert/strict';

import { hydrateNodeBuilderState } from '../src/hydrator.js';

test( 'hydrator phase tracing is opt-in and preserves synchronous results', () => {

	const phases = [];
	const previousHook = globalThis.__tslpReplayHydrationPhaseTrace;
	globalThis.__tslpReplayHydrationPhaseTrace = ( phase, detail, callback ) => {

		phases.push( { phase, detail } );
		return callback();

	};
	try {

		const state = hydrateNodeBuilderState( {
			materialShape: 'trace-fixture',
			vertexShader: 'vertex',
			fragmentShader: 'fragment',
			bindings: [],
			nodeAttributes: [],
			uniformPlan: [],
		}, { type: 'TraceMaterial' }, { type: 'TraceMesh' } );
		assert.equal( state.vertexShader, 'vertex' );
		assert.equal( state.fragmentShader, 'fragment' );

	} finally {

		if ( previousHook === undefined ) delete globalThis.__tslpReplayHydrationPhaseTrace;
		else globalThis.__tslpReplayHydrationPhaseTrace = previousHook;

	}

	assert.deepEqual(
		phases.slice( 0, 3 ).map( ( entry ) => entry.phase ),
		[ 'selectArtifactVariant', 'createHydrationBindingArtifactView', 'linkArtifactLightIdentities' ],
	);
	assert.ok( phases.some( ( entry ) => entry.phase === 'hydrateRuntimeBindings' ) );
	assert.ok( phases.some( ( entry ) => entry.phase === 'hydrateNodeAttributes' ) );
	assert.equal( phases.every( ( entry ) => entry.detail === 'TraceMesh->TraceMaterial' ), true );

} );
