import { test } from 'node:test';
import { generateForPlan, assertGenerates } from './_helpers.js';

test( 'cell: time → writeF32 frame.time', () => {

	const r = generateForPlan( { groups: [ { slots: [ { byteOffset: 0, source: { kind: 'time' } } ] } ] } );
	assertGenerates( r, 'writeF32(view, byteOffset + 0, frame.time)' );

} );

test( 'cell: deltaTime + frameId', () => {

	const r = generateForPlan( { groups: [ { slots: [
		{ byteOffset: 0, source: { kind: 'deltaTime' } },
		{ byteOffset: 4, source: { kind: 'frameId' } },
	] } ] } );
	assertGenerates( r, 'writeF32(view, byteOffset + 0, frame.deltaTime)' );
	assertGenerates( r, 'writeU32(view, byteOffset + 4, frame.frameId)' );

} );
