/**
 * Snapshot tests for the RenderObject.js three.js-source rewrite.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

import { rewriteThreeSource } from '../../src/three-rewrite.js';

const HERE = dirname( fileURLToPath( import.meta.url ) );
const THREE_SRC = resolve( HERE, '../../../../node_modules/three/src' );
const PATH = resolve( THREE_SRC, 'renderers/common/RenderObject.js' );

test( 'rewrite/RenderObject: missing geometry attributes do not read attribute.id', () => {

	const src = readFileSync( PATH, 'utf8' );
	const r = rewriteThreeSource( src, PATH, { threeVersion: '184', pluginVersion: '0.0.0' } );
	assert.ok( r, 'handler should return a result' );
	assert.equal( r.warning, null, `expected no warning; got: ${ r.warning }` );

	assert.match( r.code, /import \{ BufferAttribute \} from "\.\.\/\.\.\/core\/BufferAttribute\.js"/ );
	assert.match( r.code, /function __tslpAttributeItemSize/ );
	assert.match( r.code, /if \(attribute === undefined\)/ );
	assert.match( r.code, /new BufferAttribute\(new Float32Array\(__tslpAttributeItemSize\(nodeAttribute\.type\)\), __tslpAttributeItemSize\(nodeAttribute\.type\)\)/ );
	assert.match( r.code, /attributesId\[nodeAttribute\.name\] = attribute\.id/ );
	assert.doesNotThrow( () => parse( r.code, { sourceType: 'module', plugins: [ 'importAttributes' ] } ) );

} );
