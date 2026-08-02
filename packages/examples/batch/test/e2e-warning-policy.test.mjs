import assert from 'node:assert/strict';
import test from 'node:test';

import { isTslpWarningMessage } from '../e2e-warning-policy.mjs';

test( 'warning policy recognizes harness and public product prefixes only', () => {

	assert.equal( isTslpWarningMessage( '[tslp-e2e] replay fallback failed' ), true );
	assert.equal( isTslpWarningMessage( '[tsl-precompile] blocked uniform kind' ), true );
	assert.equal( isTslpWarningMessage( '[tsl-precompile/aux] no exact artifact' ), true );
	assert.equal( isTslpWarningMessage( 'prefix [TSL-PRECOMPILE/slim] fallback' ), true );
	assert.equal( isTslpWarningMessage( 'THREE.WebGPURenderer: benign upstream warning' ), false );
	assert.equal( isTslpWarningMessage( '[tsl] unrelated tag' ), false );

} );
