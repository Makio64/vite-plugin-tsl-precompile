import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { REVISION } from 'three/src/constants.js';
import { THREE_RELEASE_PROFILES } from '@tsl-precompile/contract/slim-three-policy';
import {
	hash as threeHash,
	hashArray as threeHashArray,
	hashString as threeHashString,
} from 'three/src/nodes/core/NodeUtils.js';
import * as threeNodeConstants from 'three/src/nodes/core/constants.js';
import * as replayPrimitives from '../src/slim-replay-node-core-primitives.js';
import {
	hash,
	hashArray,
	hashString,
	NodeAccess,
	NodeUpdateType,
} from '../src/slim-replay-node-core-primitives.js';
import {
	NodeAccess as publicNodeAccess,
	NodeUtils,
	TSL,
} from '../src/slim-stubs.js';

test( 'replay-owned hashes retain exact installed Three string behavior', () => {

	assert.ok( Object.values( THREE_RELEASE_PROFILES ).some( ( profile ) => profile.revision === REVISION ), 'hash parity must run against a supported native Three release' );
	const strings = [
		'',
		'a',
		'three.js WebGPU replay',
		'\0embedded\0null',
		'日本語と🙂 surrogate pairs',
		'𝌆'.repeat( 129 ),
		'x'.repeat( 4097 ),
	];

	for ( const value of strings ) {

		assert.equal( hashString( value ), threeHashString( value ), JSON.stringify( value.slice( 0, 40 ) ) );

	}

} );

test( 'replay-owned hashes retain exact installed Three array and variadic numeric behavior', () => {

	const arrays = [
		[],
		[ 0 ],
		[ - 0 ],
		[ 1, - 1, 2.5, - 2.5 ],
		[ Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY ],
		[ Number.MIN_VALUE, Number.MAX_VALUE ],
		[ Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER ],
		[ - 0x100000000, 0xffffffff, 0x100000000 ],
		[ undefined, null, true, false ],
		[ , 1, , - 1 ],
	];

	for ( const values of arrays ) {

		assert.equal( hashArray( values ), threeHashArray( values ), JSON.stringify( values ) );
		assert.equal( hash( ...values ), threeHash( ...values ), `variadic ${ JSON.stringify( values ) }` );

	}

	assert.equal( hash(), threeHash() );
	assert.equal( hashArray( [ 1, 2, 3 ] ), hash( 1, 2, 3 ), 'array and variadic helpers share Three\'s cyrb53 domain' );

} );

test( 'replay-owned node constants cover every installed native export with exact values and mutable object shapes', () => {

	const nativeNames = Object.keys( threeNodeConstants ).sort();
	assert.deepEqual( Object.keys( replayPrimitives ).filter( ( name ) => ! [ 'hash', 'hashArray', 'hashString' ].includes( name ) ).sort(), nativeNames );
	for ( const name of nativeNames ) {

		assert.deepEqual( replayPrimitives[ name ], threeNodeConstants[ name ], name );
		assert.equal( Object.isFrozen( replayPrimitives[ name ] ), Object.isFrozen( threeNodeConstants[ name ] ), name );

	}
	assert.deepEqual( Object.keys( NodeAccess ), [ 'READ_ONLY', 'WRITE_ONLY', 'READ_WRITE' ] );
	assert.deepEqual( Object.keys( NodeUpdateType ), [ 'NONE', 'FRAME', 'RENDER', 'OBJECT' ] );
	assert.notEqual( replayPrimitives.shaderStages, replayPrimitives.defaultShaderStages, 'native shaderStages is a separate mutable array' );

} );

test( 'slim public compatibility exports expose only the safe Node-core primitives', () => {

	assert.equal( NodeUtils.hash, hash );
	assert.equal( NodeUtils.hashArray, hashArray );
	assert.equal( NodeUtils.hashString, hashString );
	assert.equal( publicNodeAccess, NodeAccess );
	assert.equal( TSL.NodeAccess, NodeAccess );
	assert.throws( () => NodeUtils.getValueType( 1 ), /NodeUtils\.getValueType\(\) unavailable/ );

} );

test( 'runtime-owned replay modules do not import Three Node core primitives', () => {

	for ( const relativePath of [ '../src/slim-stubs.js', '../src/slim-replay-scene-nodes.js' ] ) {

		const source = readFileSync( new URL( relativePath, import.meta.url ), 'utf8' );
		assert.doesNotMatch( source, /three\/src\/nodes\/core\/(?:NodeUtils|constants)\.js/, relativePath );

	}

} );
