/**
 * attachToInspector: structural test.
 *
 * We can't instantiate `three/addons/inspector/Inspector.js` in Node (it
 * reaches into the DOM), but we CAN verify `attachToInspector` calls
 * `inspector.addTab(panel)` once with our PrecompilePanel.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { attachToInspector, PrecompilePanel } from '../src/index.js';

// Fake DOM so Tab's constructor (document.createElement) survives import.
if ( typeof globalThis.document === 'undefined' ) {

	const fakeEl = () => ( {
		className: '',
		classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
		style: {},
		children: [],
		firstChild: null,
		appendChild( child ) { this.children.push( child ); return child; },
		removeChild() {},
		querySelectorAll() { return []; },
		addEventListener() {},
		removeEventListener() {},
		setAttribute() {},
		getAttribute() { return null; },
	} );
	globalThis.document = { createElement: () => fakeEl() };

}

function makeFakeInspector() {

	const tabs = [];
	return {
		addTab( tab ) { tabs.push( tab ); return this; },
		__tabs: tabs,
	};

}

test( 'attach: adds a PrecompilePanel tab', () => {

	const inspector = makeFakeInspector();
	const panel = attachToInspector( inspector );
	assert.ok( panel instanceof PrecompilePanel );
	assert.equal( inspector.__tabs.length, 1 );
	assert.equal( inspector.__tabs[ 0 ], panel );

} );

test( 'attach: idempotent — second call returns the same panel without re-adding', () => {

	const inspector = makeFakeInspector();
	const a = attachToInspector( inspector );
	const b = attachToInspector( inspector );
	assert.equal( a, b );
	assert.equal( inspector.__tabs.length, 1 );

} );

test( 'attach: rejects invalid inspector argument', () => {

	assert.throws( () => attachToInspector( null ), /expected a three\.js Inspector/ );
	assert.throws( () => attachToInspector( {} ), /expected a three\.js Inspector/ );

} );
