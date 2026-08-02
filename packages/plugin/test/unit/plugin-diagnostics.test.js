import assert from 'node:assert/strict';
import test from 'node:test';

import { formatBlockedKindWarnings } from '../../src/diagnostics.js';

test( 'blocked updater diagnostics are silent in full-Three compatibility mode', () => {

	const blocked = [
		{ kind: 'uniform.live', severity: 'blocked' },
		{ kind: 'uniform.live', severity: 'blocked', isStaticSnapshot: true },
	];
	assert.deepEqual( formatBlockedKindWarnings( 'compat-material', blocked ), [] );
	assert.deepEqual( formatBlockedKindWarnings( 'compat-material', blocked, { replay: false } ), [] );

} );

test( 'blocked updater diagnostics identify slim replay impact and link public troubleshooting', () => {

	const warnings = formatBlockedKindWarnings( 'animated-material', [
		{ kind: 'uniform.live', severity: 'blocked' },
		{ kind: 'uniform.live', severity: 'blocked', isStaticSnapshot: true },
	], { replay: true } );

	assert.equal( warnings.length, 2 );
	assert.match( warnings[ 0 ], /slim replay artifact "animated-material"/ );
	assert.match( warnings[ 0 ], /static-snapshot/ );
	assert.match( warnings[ 1 ], /frozen snapshot/ );
	assert.match( warnings[ 1 ], /Use full-Three compatibility mode/ );
	for ( const warning of warnings ) {

		assert.match( warning, /https:\/\/github\.com\/Makio64\/vite-plugin-tsl-precompile#troubleshooting/ );

	}

} );
