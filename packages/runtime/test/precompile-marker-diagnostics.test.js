import assert from 'node:assert/strict';
import test from 'node:test';

import { formatCaptureBlockedKindWarning } from '../src/precompile-marker.js';

test( 'capture blocked-kind warning distinguishes compatibility from slim replay', () => {

	const warning = formatCaptureBlockedKindWarning( 'animated-material', [
		{ kind: 'uniform.live', severity: 'blocked' },
		{ kind: 'uniform.live', severity: 'blocked' },
	] );

	assert.match( warning, /capture recorded 2 kind/ );
	assert.match( warning, /slim replay cannot update/ );
	assert.match( warning, /Full-Three development and compatibility builds remain live and are unaffected/ );
	assert.match( warning, /frozen snapshots and may not animate/ );
	assert.match( warning, /Kinds: uniform\.live/ );
	assert.doesNotMatch( warning, /uniform\.live, uniform\.live/ );
	assert.match( warning, /https:\/\/github\.com\/Makio64\/vite-plugin-tsl-precompile#troubleshooting/ );

} );
