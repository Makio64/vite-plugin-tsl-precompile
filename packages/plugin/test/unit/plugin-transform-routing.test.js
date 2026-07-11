import { test } from 'node:test';
import assert from 'node:assert/strict';

import tslPrecompile from '../../src/index.js';

const source = 'export const material = new MeshStandardNodeMaterial();\n';

async function transform( id ) {

	const plugin = tslPrecompile( { autoMark: true } );
	return plugin.transform.call( {
		warn() {},
		error( message ) { throw new Error( message ); },
	}, source, id );

}

test( 'application JS/TS module ids remain transformable with ordinary Vite query suffixes', async () => {

	const ids = [
		'/project/src/material.js?v=abc123',
		'/project/src/material.ts?import',
		'/project/src/material.jsx?t=1234',
		'/project/src/material.tsx?direct',
		'/project/src/material.mjs?foo=bar',
		'/project/src/material.mts#source',
		'/project/src/material.cjs?foo=bar#source',
		'/project/src/material.cts',
	];

	for ( const id of ids ) {

		const result = await transform( id );
		assert.ok( result, `${ id } should be transformed` );
		assert.match( result.code, /\.precompile\(/, id );

	}

} );

test( 'Vite raw, URL, and worker asset requests are not parsed as application modules', async () => {

	const ids = [
		'/project/src/material.js?raw',
		'/project/src/material.ts?url',
		'/project/src/material.js?worker&inline',
		'/project/src/material.ts?sharedworker',
		'/project/src/material.js?foo=bar&raw=true',
	];

	for ( const id of ids ) assert.equal( await transform( id ), null, id );

} );

test( 'dependency and virtual module ids are excluded across Vite id shapes', async () => {

	const ids = [
		'/project/node_modules/pkg/index.js?v=1',
		'C:\\project\\node_modules\\pkg\\index.ts?import',
		'\0virtual:generated.js',
		'virtual:generated.ts?import',
		'vite:generated.js',
		'/@id/__x00__virtual:generated.js',
		'/@vite/client.js',
	];

	for ( const id of ids ) assert.equal( await transform( id ), null, id );

} );

test( 'Vue and Astro script subrequests are transformed without parsing raw SFC markup', async () => {

	const scriptIds = [
		'/project/src/App.vue?vue&type=script&setup=true&lang.ts',
		'/project/src/Page.astro?astro&type=script&index=0&lang.ts',
	];
	for ( const id of scriptIds ) {

		const result = await transform( id );
		assert.ok( result, `${ id } should be transformed` );
		assert.match( result.code, /\.precompile\(/, id );

	}

	const nonScriptIds = [
		'/project/src/App.vue',
		'/project/src/App.vue?vue&type=template&id=123',
		'/project/src/App.vue?vue&type=style&lang.css',
		'/project/src/Page.astro',
		'/project/src/Page.astro?astro&type=style&index=0&lang.css',
		'/project/src/Widget.svelte',
		'/project/src/Widget.svelte?svelte&type=style&lang.css',
	];
	for ( const id of nonScriptIds ) assert.equal( await transform( id ), null, id );

} );
