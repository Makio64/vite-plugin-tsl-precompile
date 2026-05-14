import { test } from 'node:test';
import { generateForPlan, assertGenerates } from './_helpers.js';

test( 'cell: time → writeF32 frame.time (or pinned clock via Wedge 4)', () => {

	const r = generateForPlan( { groups: [ { slots: [ { byteOffset: 0, source: { kind: 'time' } } ] } ] } );
	// The frame.time writer now consults globalThis.__tslpPinnedClock first
	// (Wedge 4 — clock alignment for PSNR snapshot replay). Assert the core
	// fallback expression `frame.time)` appears at the right offset.
	assertGenerates( r, ': frame.time));' );

} );

test( 'cell: deltaTime + frameId', () => {

	const r = generateForPlan( { groups: [ { slots: [
		{ byteOffset: 0, source: { kind: 'deltaTime' } },
		{ byteOffset: 4, source: { kind: 'frameId' } },
	] } ] } );
	assertGenerates( r, 'writeF32(view, byteOffset + 0, frame.deltaTime)' );
	assertGenerates( r, 'writeU32(view, byteOffset + 4, frame.frameId)' );

} );
