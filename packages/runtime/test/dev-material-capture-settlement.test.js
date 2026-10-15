import test from 'node:test';
import assert from 'node:assert/strict';
import { beginMaterialCapture, finishMaterialCapture, waitForMaterialCaptures } from '../src/dev-material-capture-settlement.js';

test( 'transient capture can settle while an unrelated material still awaits its first draw', async () => {

	const atlas = {}, text = {};
	const atlasCapture = beginMaterialCapture( { material: atlas, name: 'atlas' } );
	beginMaterialCapture( { material: text, name: 'text' } );
	const settled = waitForMaterialCaptures( [ atlas ], { timeoutMs: 500 } );
	finishMaterialCapture( atlasCapture, true );
	await settled;
	await waitForMaterialCaptures( [ atlas ], { timeoutMs: 500 } );

} );

test( 'each factory instance and recapture has its own completion', async () => {

	const first = {}, second = {};
	finishMaterialCapture( beginMaterialCapture( { material: first, name: 'atlas' } ), true );
	const pending = beginMaterialCapture( { material: second, name: 'atlas' } );
	let completed = false;
	const wait = waitForMaterialCaptures( [ second ], { timeoutMs: 500 } ).then( () => { completed = true; } );
	await Promise.resolve();
	assert.equal( completed, false );
	finishMaterialCapture( pending, true );
	await wait;
	const recapture = beginMaterialCapture( { material: first, name: 'atlas' } );
	finishMaterialCapture( recapture, false );
	await assert.rejects( waitForMaterialCaptures( [ first ] ), /Material capture failed: atlas/ );
	await assert.rejects( waitForMaterialCaptures( [ {} ] ), /unmarked material/ );

} );
