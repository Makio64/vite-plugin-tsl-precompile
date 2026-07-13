import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { linkGeneratedLightIdentitySource, writeGeneratedLightValue } from '../src/generated/light-writer.js';
import { linkedLightIdentityForSource } from '../src/hydrate/light-identities.js';
import { writeLightValue } from '../src/hydrate/light-writers.js';

test( 'generated light writer is the canonical hydration writer', () => {

	assert.equal( writeGeneratedLightValue, writeLightValue );

} );

test( 'generated light writer subpath links frozen source constants', () => {

	const record = { captureIndex: 0, type: 'PointLight', snapshot: {} };
	const table = [ record ];
	const source = Object.freeze( { kind: 'light.distance', lightIdentity: 0 } );
	assert.equal( linkGeneratedLightIdentitySource( source, table ), source );
	assert.deepEqual( linkedLightIdentityForSource( source ), { record, table } );

} );

test( 'generated light writer has a narrow public package subpath', () => {

	const pkg = JSON.parse( readFileSync( new URL( '../package.json', import.meta.url ), 'utf8' ) );
	assert.deepEqual( pkg.exports[ './generated/light-writer' ], {
		types: './types/generated/light-writer.d.ts',
		default: './src/generated/light-writer.js',
	} );

} );
