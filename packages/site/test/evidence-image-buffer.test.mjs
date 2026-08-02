import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import sharp from 'sharp';

import {
	describeEvidenceBytes,
	verifyEvidenceDescriptor,
} from '../../examples/batch/e2e-evidence.mjs';
import { probeThumbHealth, renderBoundShot } from '../scripts/evidence-image-buffer.mjs';

async function fixturePngs() {

	const width = 96;
	const height = 96;
	const patternedPixels = Buffer.alloc( width * height * 3 );
	for ( let index = 0; index < patternedPixels.length; index ++ ) {

		patternedPixels[ index ] = ( index * 31 + Math.floor( index / 17 ) * 47 ) % 256;

	}
	const patterned = await sharp( patternedPixels, {
		raw: { width, height, channels: 3 },
	} ).png( { compressionLevel: 0 } ).toBuffer();
	const blank = await sharp( {
		create: {
			width,
			height,
			channels: 3,
			background: { r: 128, g: 128, b: 128 },
		},
	} ).png( { compressionLevel: 0 } ).toBuffer();
	return { patterned, blank };

}

test( 'thumbnail helpers consume stable verified buffers after the source path changes', async ( t ) => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-site-evidence-image-buffer-' ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	const source = join( root, 'replay.png' );
	const { patterned, blank } = await fixturePngs();
	writeFileSync( source, patterned );
	const runId = 'buffer-bound-run';
	const descriptor = describeEvidenceBytes( {
		outputRoot: root,
		file: source,
		bytes: patterned,
		runId,
	} );
	const verifiedBytes = verifyEvidenceDescriptor( root, descriptor, runId ).bytes;

	// Simulate a post-validation replacement. The helpers never receive or
	// reopen this path, so both decisions remain bound to verifiedBytes.
	writeFileSync( source, blank );
	await assert.rejects( () => probeThumbHealth( source ), /must be a Buffer/ );
	await assert.rejects( () => renderBoundShot( source, 40, 30 ), /must be a Buffer/ );
	assert.equal( await probeThumbHealth( verifiedBytes ), 'ok' );
	assert.equal( await probeThumbHealth( blank ), 'blank' );
	const rendered = await renderBoundShot( verifiedBytes, 40, 30 );
	const metadata = await sharp( rendered ).metadata();
	assert.equal( metadata.format, 'webp' );
	assert.equal( metadata.width, 40 );
	assert.equal( metadata.height, 30 );

} );
