import assert from 'node:assert/strict';
import test from 'node:test';

import { PrecompilePanel } from '../src/panel.js';

function renderRows( captures ) {

	const list = {
		innerHTML: '',
		querySelectorAll() {

			return [];

		},
	};
	const panel = Object.create( PrecompilePanel.prototype );
	panel._list = list;
	panel._selectedId = null;
	panel._renderList( captures );
	return list.innerHTML;

}

function capture( unsupportedKinds ) {

	return {
		id: 'user:ocean-water',
		shape: 'user',
		name: 'ocean-water',
		hash: 'a'.repeat( 64 ),
		configHash: null,
		vertexBytes: 10,
		fragmentBytes: 20,
		computeBytes: 0,
		unsupportedKinds,
	};

}

test( 'capture rows expose exact unsupported-kind entry counts for smoke gates', () => {

	const html = renderRows( [ capture( [
		{ severity: 'unknown', kind: 'FirstUnknown' },
		{ severity: 'blocked', kind: 'Blocked' },
		{ severity: 'unknown', kind: 'SecondUnknown' },
	] ) ] );

	assert.match( html, /data-unknown-count="2"/ );
	assert.match( html, /data-blocked-count="1"/ );
	assert.match( html, /class="tslp-row tslp-row-err"/ );

} );

test( 'capture rows expose zero diagnostic counts when unsupportedKinds is absent', () => {

	const html = renderRows( [ capture( undefined ) ] );

	assert.match( html, /data-unknown-count="0"/ );
	assert.match( html, /data-blocked-count="0"/ );
	assert.doesNotMatch( html, /tslp-row-(?:err|warn)/ );

} );
