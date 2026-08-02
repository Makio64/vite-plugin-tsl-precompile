import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import test from 'node:test';

import {
	applySiteMeasurementFallbacksToHtml,
	assertCurrentSiteMeasurements,
	createSiteMeasurements,
	siteMeasurementProvenanceLabel,
} from '../scripts/measurement-contract.mjs';

function sha256( bytes ) {

	return createHash( 'sha256' ).update( bytes ).digest( 'hex' );

}

function fixture() {

	const bundleBytes = Buffer.from( 'export const replay = true;\n'.repeat( 80 ) );
	const budgetBytes = Buffer.from( JSON.stringify( {
		schema: 'tslp-slim-budget@1',
		gzipLevel: 9,
		baseline: { threeVersion: '0.185.1' },
		prebuilt: {
			maxRawBytes: bundleBytes.length + 100,
			maxGzipBytes: gzipSync( bundleBytes, { level: 9 } ).length + 100,
		},
		source: {
			fixtures: {
				minimal: { baselineGzipBytes: 120, maxGzipBytes: 140 },
				advanced: { baselineGzipBytes: 150, maxGzipBytes: 170 },
			},
		},
	} ) );
	const metaBytes = Buffer.from( JSON.stringify( {
		schema: 'tslp-slim-bundle-provenance@1',
		bundle: {
			bytes: bundleBytes.length,
			sha256: sha256( bundleBytes ),
		},
		source: { fingerprint: 'a'.repeat( 64 ) },
		versions: { three: '0.185.1' },
	} ) );
	return { budgetBytes, bundleBytes, metaBytes };

}

test( 'measurement manifest binds displayed bytes to budget, bundle and metadata hashes', () => {

	const inputs = fixture();
	const manifest = createSiteMeasurements( inputs );
	assert.equal( manifest.profiles.sourceMinimal.gzipBytes, 120 );
	assert.equal( manifest.profiles.sourceAdvanced.gzipBytes, 150 );
	assert.equal( manifest.profiles.prebuilt.rawBytes, inputs.bundleBytes.length );
	assert.equal( manifest.profiles.prebuilt.gzipBytes, gzipSync( inputs.bundleBytes, { level: 9 } ).length );
	assert.equal( manifest.provenance.prebuilt.sha256, sha256( inputs.bundleBytes ) );
	assert.equal( assertCurrentSiteMeasurements( structuredClone( manifest ), inputs ).schema, 'tslp-site-measurements@1' );
	assert.match( siteMeasurementProvenanceLabel( manifest ), /budget [a-f0-9]{12} · bundle [a-f0-9]{12}$/ );

	const html = applySiteMeasurementFallbacksToHtml(
		'<b data-bench-measurement="profiles.sourceMinimal.gzipBytes">—</b><i data-bench-provenance>loading</i>',
		manifest,
	);
	assert.match( html, />120</ );
	assert.match( html, new RegExp( siteMeasurementProvenanceLabel( manifest ).replace( /[.*+?^${}()|[\]\\]/g, '\\$&' ) ) );

} );

test( 'measurement contract fails closed on stale metadata and public data', () => {

	const inputs = fixture();
	const staleMeta = JSON.parse( inputs.metaBytes );
	staleMeta.bundle.sha256 = 'b'.repeat( 64 );
	assert.throws(
		() => createSiteMeasurements( { ...inputs, metaBytes: Buffer.from( JSON.stringify( staleMeta ) ) } ),
		/does not describe/,
	);

	const manifest = createSiteMeasurements( inputs );
	manifest.profiles.sourceMinimal.gzipBytes ++;
	assert.throws( () => assertCurrentSiteMeasurements( manifest, inputs ), /stale/ );

} );

test( 'measurement contract refuses to publish an over-budget profile', () => {

	const inputs = fixture();
	const budget = JSON.parse( inputs.budgetBytes );
	budget.source.fixtures.minimal.maxGzipBytes = 100;
	assert.throws(
		() => createSiteMeasurements( { ...inputs, budgetBytes: Buffer.from( JSON.stringify( budget ) ) } ),
		/refuses to publish/,
	);

} );
