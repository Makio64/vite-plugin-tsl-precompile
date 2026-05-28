import { test } from 'node:test';
import assert from 'node:assert/strict';

import { autoMarkSource } from '../../src/auto-mark.js';

test( 'autoMark — rewrites new MeshStandardNodeMaterial() → .precompile()', () => {

	const src = `
		import { MeshStandardNodeMaterial } from 'three/webgpu';
		const m = new MeshStandardNodeMaterial();
	`;
	const { code, injectedNames } = autoMarkSource( src, { filename: '/path/to/example.js' } );
	assert.equal( injectedNames.length, 1 );
	assert.match( code, /new MeshStandardNodeMaterial\(\)\.precompile\("auto-example-0"\)/ );

} );

test( 'autoMark — multiple materials in one file get distinct names', () => {

	const src = `
		const a = new MeshBasicNodeMaterial();
		const b = new MeshStandardNodeMaterial();
		const c = new PointsNodeMaterial();
	`;
	const { injectedNames } = autoMarkSource( src, { filename: 'demo.js', namePrefix: 'x' } );
	assert.equal( injectedNames.length, 3 );
	assert.equal( injectedNames[ 0 ], 'x-demo-0' );
	assert.equal( injectedNames[ 2 ], 'x-demo-2' );

} );

test( 'autoMark — skips already-marked materials', () => {

	const src = `
		const a = new MeshBasicNodeMaterial().precompile( 'mine' );
	`;
	const { injectedNames, code } = autoMarkSource( src, { filename: 'file.js' } );
	assert.equal( injectedNames.length, 0 );
	assert.equal( code, src );

} );

test( 'autoMark — files without NodeMaterial are untouched', () => {

	const src = `console.log('hello');`;
	const result = autoMarkSource( src, { filename: 'x.js' } );
	assert.equal( result.injectedNames.length, 0 );
	assert.equal( result.code, src );

} );

test( 'autoMark — ignores non-NodeMaterial constructors', () => {

	const src = `const m = new MeshBasicMaterial();`;   // no 'Node'
	const { injectedNames } = autoMarkSource( src, { filename: 'x.js' } );
	assert.equal( injectedNames.length, 0 );

} );

test( 'autoMark — rewrites member expressions ending in NodeMaterial', () => {

	const src = `
		import * as THREE from 'three/webgpu';
		const m = new THREE.MeshStandardNodeMaterial();
		const m2 = new THREE.nodes.MeshPhysicalNodeMaterial();
	`;
	const { code, injectedNames } = autoMarkSource( src, { filename: 'example.js' } );
	assert.equal( injectedNames.length, 2 );
	assert.match( code, /new THREE\.MeshStandardNodeMaterial\(\)\.precompile\("auto-example-0"\)/ );
	assert.match( code, /new THREE\.nodes\.MeshPhysicalNodeMaterial\(\)\.precompile\("auto-example-1"\)/ );

} );
