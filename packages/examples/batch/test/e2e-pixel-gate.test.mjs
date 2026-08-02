import assert from 'node:assert/strict';
import test from 'node:test';

import { pixelGateOf, pixelGatePassed } from '../e2e-pixel-gate.mjs';
import { coverageConfig, psnrThresholdForExample, tierExamples } from '../psnr.mjs';

test( 'enabled batch pixel gates reject skipped or invalid comparisons', () => {

	for ( const metrics of [
		null,
		{ skipped: true, reason: 'capture frame empty' },
		{ skipped: true, reason: 'replay frame empty' },
		{ error: 'dimension mismatch' },
		{ psnr: null },
	] ) {

		const gate = pixelGateOf( metrics, 30 );
		assert.equal( pixelGatePassed( gate, true ), false, JSON.stringify( gate ) );

	}

} );

test( 'batch pixel gates pass only explicit successful evidence when enabled', () => {

	assert.equal( pixelGatePassed( pixelGateOf( { psnr: 'inf' }, 30 ), true ), true );
	assert.equal( pixelGatePassed( pixelGateOf( { psnr: 31 }, 30 ), true ), true );
	assert.equal( pixelGatePassed( pixelGateOf( { psnr: 29 }, 30 ), true ), false );

} );

test( 'an explicitly disabled batch pixel gate remains diagnostic-only', () => {

	const skipped = pixelGateOf( { skipped: true, reason: 'capture frame empty' }, 30 );
	assert.equal( pixelGatePassed( skipped, false ), true );

} );

test( 'the evidence corpus has no below-default PSNR exceptions', () => {

	assert.deepEqual( coverageConfig.pixelGate.psnrThresholdOverrides, {} );
	const names = [ 'tier1', 'tier2', 'tier3' ].flatMap( ( tier ) => tierExamples( tier ) );
	assert.ok( names.length > 0 );
	for ( const name of names ) assert.equal( psnrThresholdForExample( name, 30 ), 30, name );

} );
