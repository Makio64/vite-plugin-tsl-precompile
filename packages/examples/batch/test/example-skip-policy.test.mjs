import assert from 'node:assert/strict';
import test from 'node:test';

import {
	E2E_EXAMPLE_SKIP_PREFIXES,
	matchesExampleSkipPrefix,
	shouldSkipE2EExample,
} from '../example-skip-policy.mjs';

const PREFIXES = [ 'webgpu_xr_' ];

test( 'example skips are prefixes rather than incidental substrings', () => {

	assert.equal( matchesExampleSkipPrefix( 'webgpu_xr_ar_light_estimation.html', PREFIXES ), true );
	assert.equal( matchesExampleSkipPrefix( 'webgpu_tsl_angular_slicing.html', PREFIXES ), false );

} );

test( 'the shared E2E policy owns intentional non-catalogue examples', () => {

	assert.equal( shouldSkipE2EExample( 'webgpu_compile_async.html' ), true );
	assert.equal( shouldSkipE2EExample( 'webgpu_tsl_precompile.html' ), true );
	assert.equal( shouldSkipE2EExample( 'webgpu_tsl_transpiler.html' ), true );
	assert.equal( shouldSkipE2EExample( 'webgpu_xr_cubes.html' ), true );
	assert.equal( shouldSkipE2EExample( 'webgpu_tsl_angular_slicing.html' ), false );
	assert.equal( new Set( E2E_EXAMPLE_SKIP_PREFIXES ).size, E2E_EXAMPLE_SKIP_PREFIXES.length );

} );
