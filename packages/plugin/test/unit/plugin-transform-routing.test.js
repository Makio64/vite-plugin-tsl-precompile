import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';

import tslPrecompile from '../../src/index.js';

const source = 'export const material = new MeshStandardNodeMaterial();\n';
const PROJECT_ROOT = process.cwd();

async function transform( id, input = source ) {

	const plugin = tslPrecompile( { autoMark: true } );
	return plugin.transform.call( {
		warn() {},
		error( message ) { throw new Error( message ); },
	}, input, id );

}

test( 'application JS/TS module ids remain transformable with ordinary Vite query suffixes', async () => {

	const ids = [
		join( PROJECT_ROOT, 'src/material.js?v=abc123' ),
		join( PROJECT_ROOT, 'src/material.ts?import' ),
		join( PROJECT_ROOT, 'src/material.jsx?t=1234' ),
		join( PROJECT_ROOT, 'src/material.tsx?direct' ),
		join( PROJECT_ROOT, 'src/material.mjs?foo=bar' ),
		join( PROJECT_ROOT, 'src/material.mts#source' ),
		join( PROJECT_ROOT, 'src/material.cjs?foo=bar#source' ),
		join( PROJECT_ROOT, 'src/material.cts' ),
	];

	for ( const id of ids ) {

		const result = await transform( id );
		assert.ok( result, `${ id } should be transformed` );
		assert.match( result.code, /\.precompile\(/, id );

	}

} );

test( 'workspace-linked source outside the project root is not auto-marked, while authored markers still transform', async () => {

	const id = join( dirname( PROJECT_ROOT ), 'runtime-linked/src/helper.js?import' );
	const input = `
		export const helper = new MeshStandardNodeMaterial();
		export const authored = new MeshBasicNodeMaterial().precompile( 'authored' );
	`;
	const result = await transform( id, input );

	assert.ok( result );
	assert.match( result.code, /authored/ );
	assert.doesNotMatch( result.code, /__tslpAutoMark|auto-helper-/ );

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
		join( PROJECT_ROOT, 'src/App.vue?vue&type=script&setup=true&lang.ts' ),
		join( PROJECT_ROOT, 'src/Page.astro?astro&type=script&index=0&lang.ts' ),
	];
	for ( const id of scriptIds ) {

		const result = await transform( id );
		assert.ok( result, `${ id } should be transformed` );
		assert.match( result.code, /\.precompile\(/, id );

	}

	const nonScriptIds = [
		join( PROJECT_ROOT, 'src/App.vue' ),
		join( PROJECT_ROOT, 'src/App.vue?vue&type=template&id=123' ),
		join( PROJECT_ROOT, 'src/App.vue?vue&type=style&lang.css' ),
		join( PROJECT_ROOT, 'src/Page.astro' ),
		join( PROJECT_ROOT, 'src/Page.astro?astro&type=style&index=0&lang.css' ),
		join( PROJECT_ROOT, 'src/Widget.svelte' ),
		join( PROJECT_ROOT, 'src/Widget.svelte?svelte&type=style&lang.css' ),
	];
	for ( const id of nonScriptIds ) assert.equal( await transform( id ), null, id );

} );
