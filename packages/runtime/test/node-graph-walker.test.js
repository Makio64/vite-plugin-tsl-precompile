import assert from 'node:assert/strict';
import test from 'node:test';

import {
	walkMaterialNodeGraphUnique,
	walkNodeGraphUnique,
} from '../src/slim-support/node-graph-walker.js';

test( 'node graph walker visits shared DAG descendants only once', () => {

	const shared = { isNode: true, getChildren: () => [] };
	const left = { isNode: true, getChildren: () => [ shared ] };
	const right = { isNode: true, getChildren: () => [ shared ] };
	const root = { isNode: true, getChildren: () => [ left, right ] };
	const visits = [];

	walkNodeGraphUnique( root, ( node ) => visits.push( node ) );

	assert.equal( visits.filter( ( node ) => node === shared ).length, 1 );
	assert.deepEqual( new Set( visits ), new Set( [ root, left, right, shared ] ) );
	assert.doesNotThrow( () => walkNodeGraphUnique( undefined, () => {} ) );

} );

test( 'node graph walker retains uniform and attribute traverse compatibility', () => {

	const liveUniform = { isUniformNode: true, value: 0.5 };
	const liveAttribute = {
		isBufferAttribute: true,
		array: new Float32Array( [ 1, 2 ] ),
		itemSize: 1,
		count: 2,
	};
	const attributeWrapper = { attribute: liveAttribute };
	const root = {
		isNode: true,
		traverse( visit ) {

			visit( liveUniform );
			visit( attributeWrapper );

		},
	};
	const visits = [];

	walkNodeGraphUnique( root, ( node ) => visits.push( node ) );

	assert.deepEqual( visits, [ root, liveUniform, attributeWrapper ] );
	assert.equal( visits.includes( liveAttribute ), false, 'raw BufferAttribute payload must not become a graph node' );

} );

test( 'node graph walker tolerates hostile marker getters', () => {

	const root = {
		isNode: true,
		get isTexture() {

			throw new Error( 'hostile marker getter' );

		},
	};
	const visits = [];
	assert.doesNotThrow( () => walkNodeGraphUnique( root, ( node ) => visits.push( node ) ) );
	assert.deepEqual( visits, [ root ] );

} );

test( 'spoofed ArrayBuffer tags cannot hide a custom node graph', () => {

	const child = { isUniformNode: true, value: 1 };
	const root = {
		isNode: true,
		child,
		[ Symbol.toStringTag ]: 'ArrayBuffer',
	};
	const visits = [];
	walkNodeGraphUnique( root, ( node ) => visits.push( node ) );
	assert.deepEqual( visits, [ root, child ] );

} );

test( 'node graph walker terminates on cyclic Proxy prototype traps', () => {

	let proxy;
	proxy = new Proxy( { isNode: true, traverse() {} }, {
		getPrototypeOf() { return proxy; },
	} );
	const visits = [];
	assert.doesNotThrow( () => walkNodeGraphUnique( proxy, ( node ) => visits.push( node ) ) );
	assert.deepEqual( visits, [ proxy ] );

} );

test( 'node graph walker bounds fresh Proxy prototype chains', () => {

	let prototypeReads = 0;
	const freshProxy = () => new Proxy( {}, {
		getPrototypeOf() {

			prototypeReads ++;
			return freshProxy();

		},
	} );
	const root = new Proxy( { isNode: true, traverse() {} }, {
		getPrototypeOf() {

			prototypeReads ++;
			return freshProxy();

		},
	} );
	assert.doesNotThrow( () => walkNodeGraphUnique( root, () => {} ) );
	assert.ok( prototypeReads <= 128, `prototype probing must stay bounded, got ${ prototypeReads }` );

} );

test( 'empty getChildren does not hide virtual traverse descendants', () => {

	const child = { isUniformNode: true, value: 3 };
	const root = {
		isNode: true,
		* getChildren() {},
		traverse( callback ) {

			callback( this );
			callback( child );

		},
	};
	const visits = [];
	walkNodeGraphUnique( root, ( node ) => visits.push( node ) );
	assert.deepEqual( visits, [ root, child ] );

} );

test( 'authoritative traverse order excludes unrelated reflective state', () => {

	const first = { isUniformNode: true, value: 1 };
	const second = { isUniformNode: true, value: 2 };
	const unrelated = { isUniformNode: true, value: 3 };
	const root = {
		isNode: true,
		unrelated,
		traverse( callback ) {

			callback( this );
			callback( first );
			callback( second );

		},
	};
	const visits = [];
	walkNodeGraphUnique( root, ( node ) => visits.push( node ) );
	assert.deepEqual( visits, [ root, first, second ] );

} );

test( 'authoritative child APIs do not leak PassNode-like scene state', () => {

	const backgroundTexture = { isTexture: true };
	const scene = {
		isScene: true,
		background: backgroundTexture,
		traverse( callback ) { callback( this ); },
	};
	const root = {
		isNode: true,
		scene,
		* getChildren() {},
		traverse( callback ) { callback( this ); },
	};
	const visits = [];
	walkNodeGraphUnique( root, ( node ) => visits.push( node ) );
	assert.deepEqual( visits, [ root ] );

} );

test( 'material walker shares identity across every node-valued material root', () => {

	const shared = { isUniformNode: true, value: 1 };
	const material = {
		colorNode: { isNode: true, child: shared },
		positionNode: { isNode: true, child: shared },
	};
	const visits = [];

	walkMaterialNodeGraphUnique( material, ( node ) => visits.push( node ) );

	assert.equal( visits.filter( ( node ) => node === shared ).length, 1 );

} );

test( 'material walker includes non-enumerable and array-contained node roots', () => {

	const hidden = { isUniformNode: true, value: 1 };
	const nested = { isUniformNode: true, value: 2 };
	const roots = [ nested ];
	roots.push( roots );
	const material = { roots };
	Object.defineProperty( material, 'hiddenNode', {
		value: hidden,
		enumerable: false,
	} );
	const visits = [];
	walkMaterialNodeGraphUnique( material, ( node ) => visits.push( node ) );
	assert.deepEqual( visits, [ nested, hidden ] );

} );

test( 'material walker ignores inherited enumerable graph roots', () => {

	const inherited = { isUniformNode: true, value: 1 };
	const material = Object.create( { pollutedNode: inherited } );
	const visits = [];
	walkMaterialNodeGraphUnique( material, ( node ) => visits.push( node ) );
	assert.deepEqual( visits, [] );

} );
