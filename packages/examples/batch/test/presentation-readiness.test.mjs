import assert from 'node:assert/strict';
import test from 'node:test';

import {
	createPresentationReadinessState,
	markPresentationDeferred,
	markPresentationSuccessful,
	presentationReadinessSatisfied,
} from '../presentation-readiness.mjs';

test( 'deferred callbacks require a later successful presentation', () => {

	const state = createPresentationReadinessState();
	assert.equal( presentationReadinessSatisfied( state ), false );

	markPresentationDeferred( state );
	markPresentationDeferred( state );
	assert.deepEqual( state, { deferred: 2, requiredAfter: 0, successful: 0 } );
	assert.equal( presentationReadinessSatisfied( state ), false );

	markPresentationSuccessful( state );
	assert.equal( presentationReadinessSatisfied( state ), true );

	markPresentationDeferred( state );
	assert.deepEqual( state, { deferred: 3, requiredAfter: 1, successful: 1 } );
	assert.equal( presentationReadinessSatisfied( state ), false );

	markPresentationSuccessful( state );
	assert.equal( presentationReadinessSatisfied( state ), true );

} );
