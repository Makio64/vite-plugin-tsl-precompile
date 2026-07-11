import { test } from 'node:test';
import assert from 'node:assert/strict';

import { autoMarkSource } from '../../src/auto-mark.js';

test( 'autoMark — rewrites new MeshStandardNodeMaterial() → .precompile()', () => {

	const src = `
		import { MeshStandardNodeMaterial } from 'three/webgpu';
		const m = new MeshStandardNodeMaterial();
	`;
	const { code, injectedNames } = autoMarkSource( src, { filename: '/path/to/example.js', root: '/path' } );
	assert.equal( injectedNames.length, 1 );
	assert.match( injectedNames[ 0 ], /^auto-example-[0-9a-f]{12}-0$/ );
	assert.match( code, new RegExp( `new MeshStandardNodeMaterial\\(\\)\\.precompile\\("${ injectedNames[ 0 ] }", \\{\\s*__tslpAutoMark: true` ) );

} );

test( 'autoMark — multiple materials in one file get distinct names', () => {

	const src = `
		const a = new MeshBasicNodeMaterial();
		const b = new MeshStandardNodeMaterial();
		const c = new PointsNodeMaterial();
	`;
	const { injectedNames } = autoMarkSource( src, { filename: 'demo.js', root: '/project', namePrefix: 'x' } );
	assert.equal( injectedNames.length, 3 );
	assert.match( injectedNames[ 0 ], /^x-demo-[0-9a-f]{12}-0$/ );
	assert.equal( injectedNames[ 2 ], injectedNames[ 0 ].replace( /-0$/, '-2' ) );

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
	const { code, injectedNames } = autoMarkSource( src, { filename: 'example.js', root: '/project' } );
	assert.equal( injectedNames.length, 2 );
	assert.match( code, new RegExp( `new THREE\\.MeshStandardNodeMaterial\\(\\)\\.precompile\\("${ injectedNames[ 0 ] }", \\{` ) );
	assert.match( code, new RegExp( `new THREE\\.nodes\\.MeshPhysicalNodeMaterial\\(\\)\\.precompile\\("${ injectedNames[ 1 ] }", \\{` ) );

} );

test( 'autoMark — same basename in different root-relative paths gets distinct stable names', () => {

	const src = 'const m = new MeshStandardNodeMaterial();';
	const a = autoMarkSource( src, { filename: '/project/src/first/material.js', root: '/project' } );
	const b = autoMarkSource( src, { filename: '/project/src/second/material.js', root: '/project' } );
	const aRelative = autoMarkSource( src, { filename: 'src/first/material.js', root: '/project' } );

	assert.notEqual( a.injectedNames[ 0 ], b.injectedNames[ 0 ] );
	assert.equal( a.injectedNames[ 0 ], aRelative.injectedNames[ 0 ] );
	assert.match( a.injectedNames[ 0 ], /^auto-material-[0-9a-f]{12}-0$/ );

} );

test( 'autoMark — generated prefix remains a canonical artifact-name component', () => {

	const src = 'const m = new MeshStandardNodeMaterial();';
	const { injectedNames } = autoMarkSource( src, {
		filename: '/project/src/material.js',
		root: '/project',
		namePrefix: '../custom prefix',
	} );
	assert.match( injectedNames[ 0 ], /^custom_prefix-material-[0-9a-f]{12}-0$/ );
	assert.doesNotMatch( injectedNames[ 0 ], /[\\/]/ );

} );

test( 'autoMark — framework script subresources receive distinct stable names', () => {

	const source = 'export const material = new MeshStandardNodeMaterial();\n';
	const first = autoMarkSource( source, {
		filename: '/project/src/Page.astro?astro&type=script&index=0&lang.ts',
		root: '/project',
	} );
	const firstAgain = autoMarkSource( source, {
		filename: '/project/src/Page.astro?lang.ts&index=0&type=script&astro',
		root: '/project',
	} );
	const second = autoMarkSource( source, {
		filename: '/project/src/Page.astro?astro&type=script&index=1&lang.ts',
		root: '/project',
	} );

	assert.deepEqual( first.injectedNames, firstAgain.injectedNames );
	assert.notDeepEqual( first.injectedNames, second.injectedNames );

} );

test( 'autoMark — accepts decorated TypeScript modules', () => {

	const source = `
		@sealed
		class Owner {
			material = new MeshStandardNodeMaterial();
		}
	`;
	const result = autoMarkSource( source, { filename: '/project/src/owner.ts', root: '/project' } );
	assert.equal( result.injectedNames.length, 1 );
	assert.match( result.code, /\.precompile\(/ );

} );
