import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hasReplayArtifactCoverage } from '../e2e-artifact-policy.mjs';

test( 'user material capture is sufficient without auxiliary artifacts', () => {

	assert.equal( hasReplayArtifactCoverage( { material: { artifact: {} } }, [] ), true );

} );

test( 'aux-only capture requires both background and renderer output materials', () => {

	assert.equal( hasReplayArtifactCoverage( {}, [
		{ shape: 'background' },
		{ shape: 'render-output' },
	] ), true );
	assert.equal( hasReplayArtifactCoverage( {}, [ { shape: 'background' } ] ), false );
	assert.equal( hasReplayArtifactCoverage( {}, [ { shape: 'render-output' } ] ), false );

} );

test( 'unrelated auxiliary captures cannot hide a missed user material', () => {

	assert.equal( hasReplayArtifactCoverage( {}, [
		{ shape: 'post-process' },
		{ shape: 'shadow-depth' },
	] ), false );

} );
