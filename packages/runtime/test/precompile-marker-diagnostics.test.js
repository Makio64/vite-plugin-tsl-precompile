import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { formatCaptureBlockedKindWarning } from '../src/precompile-marker.js';

const markerDeclaration = readFileSync(
	new URL( '../types/precompile-marker.d.ts', import.meta.url ),
	'utf8',
).replace( /\s+/g, ' ' );

test( 'capture blocked-kind warning distinguishes compatibility from slim replay', () => {

	const warning = formatCaptureBlockedKindWarning( 'animated-material', [
		{ kind: 'uniform.live', severity: 'blocked' },
		{ kind: 'uniform.live', severity: 'blocked', isStaticSnapshot: true },
	] );

	assert.match( warning, /capture recorded 1 kind/ );
	assert.match( warning, /slim replay cannot update/ );
	assert.match( warning, /Full-Three development and compatibility builds remain live and are unaffected/ );
	assert.match( warning, /frozen snapshots and may not animate/ );
	assert.match( warning, /Kinds: uniform\.live/ );
	assert.doesNotMatch( warning, /uniform\.live, uniform\.live/ );
	assert.match( warning, /https:\/\/github\.com\/Makio64\/vite-plugin-tsl-precompile#troubleshooting/ );

} );

test( 'capture blocked-kind warning omits provably static identity texture matrices', () => {

	assert.equal( formatCaptureBlockedKindWarning( 'static-texture-matrices', [
		{ kind: 'uniform.live', severity: 'blocked', isStaticSnapshot: true },
		{ kind: 'uniform.live', severity: 'blocked', isStaticSnapshot: true },
	] ), null );

} );

test( 'marker declaration exposes static-snapshot inputs and the nullable formatter result', () => {

	assert.match(
		markerDeclaration,
		/export type CaptureBlockedKind = \{ kind\?: string \| null; isStaticSnapshot\?: boolean; \};/,
	);
	assert.match(
		markerDeclaration,
		/formatCaptureBlockedKindWarning\( name: string, blocked\?: readonly \( CaptureBlockedKind \| null \| undefined \)\[\], \): string \| null;/,
	);

} );
