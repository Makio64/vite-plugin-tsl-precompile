import test from 'node:test';
import assert from 'node:assert/strict';

import {
	getSlimDiagnosticsBag,
	isDiagnosticChannelEnabled,
	recordDiagnostic,
	resetSlimDiagnostics,
	snapshotSlimDiagnostics,
} from '../src/slim-support/diagnostics.js';

test( 'recordDiagnostic is a no-op when the channel flag is off', () => {

	resetSlimDiagnostics();
	delete globalThis.__TSLP_DEBUG_LIGHT_LINKAGE;
	const ok = recordDiagnostic( 'lightLinkage', { kind: 'test' } );
	assert.equal( ok, false );
	const bag = getSlimDiagnosticsBag();
	assert.equal( bag.lightLinkage, undefined );

} );

test( 'recordDiagnostic appends to the channel list when the flag is on', () => {

	resetSlimDiagnostics();
	globalThis.__TSLP_DEBUG_LIGHT_LINKAGE = true;
	try {

		recordDiagnostic( 'lightLinkage', { kind: 'event-a' } );
		recordDiagnostic( 'lightLinkage', { kind: 'event-b' } );
		const bag = getSlimDiagnosticsBag();
		assert.equal( bag.lightLinkage.length, 2 );
		assert.equal( bag.lightLinkage[ 0 ].kind, 'event-a' );

	} finally {

		delete globalThis.__TSLP_DEBUG_LIGHT_LINKAGE;
		resetSlimDiagnostics();

	}

} );

test( 'recordDiagnostic respects the per-channel cap', () => {

	resetSlimDiagnostics();
	globalThis.__TSLP_DEBUG_LIGHT_LINKAGE = true;
	try {

		for ( let i = 0; i < 150; i ++ ) recordDiagnostic( 'lightLinkage', { kind: i } );
		const bag = getSlimDiagnosticsBag();
		assert.equal( bag.lightLinkage.length, 120 ); // cap is 120

	} finally {

		delete globalThis.__TSLP_DEBUG_LIGHT_LINKAGE;
		resetSlimDiagnostics();

	}

} );

test( 'isDiagnosticChannelEnabled returns true for always-on counters', () => {

	assert.equal( isDiagnosticChannelEnabled( 'pmrem' ), true );
	assert.equal( isDiagnosticChannelEnabled( 'textureShare' ), true );
	assert.equal( isDiagnosticChannelEnabled( 'colorTransferFallbacks' ), true );
	delete globalThis.__TSLP_DEBUG_LIGHT_LINKAGE;
	assert.equal( isDiagnosticChannelEnabled( 'lightLinkage' ), false );
	globalThis.__TSLP_DEBUG_LIGHT_LINKAGE = true;
	assert.equal( isDiagnosticChannelEnabled( 'lightLinkage' ), true );
	delete globalThis.__TSLP_DEBUG_LIGHT_LINKAGE;

} );

test( 'getSlimDiagnosticsBag returns the existing global bag', () => {

	resetSlimDiagnostics();
	const a = getSlimDiagnosticsBag();
	const b = getSlimDiagnosticsBag();
	assert.equal( a, b );
	assert.equal( typeof a.colorTransferFallbacks, 'object' );
	assert.equal( a.healedNullTextureImages, 0 );

} );

test( 'snapshotSlimDiagnostics returns shallow copies of the array channels', () => {

	resetSlimDiagnostics();
	globalThis.__TSLP_DEBUG_LIGHT_LINKAGE = true;
	try {

		recordDiagnostic( 'lightLinkage', { kind: 'snap' } );
		const snap = snapshotSlimDiagnostics();
		assert.equal( snap.lightLinkage.length, 1 );
		const bag = getSlimDiagnosticsBag();
		bag.lightLinkage.push( { kind: 'mutate' } );
		assert.equal( snap.lightLinkage.length, 1, 'snapshot is a copy' );

	} finally {

		delete globalThis.__TSLP_DEBUG_LIGHT_LINKAGE;
		resetSlimDiagnostics();

	}

} );
