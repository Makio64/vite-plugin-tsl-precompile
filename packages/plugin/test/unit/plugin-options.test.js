import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import tslPrecompile from '../../src/index.js';

test( 'tslPrecompile — accepts zero-config (no opts)', () => {

	const plugin = tslPrecompile();
	assert.equal( plugin.name, 'vite-plugin-tsl-precompile' );
	assert.equal( plugin.enforce, 'pre' );

} );

test( 'tslPrecompile — accepts empty object', () => {

	const plugin = tslPrecompile( {} );
	assert.equal( plugin.name, 'vite-plugin-tsl-precompile' );

} );

test( 'tslPrecompile — accepts null-prototype option bags', () => {

	const opts = Object.create( null );
	opts.fail = 'warn';
	const plugin = tslPrecompile( opts );
	assert.equal( plugin.name, 'vite-plugin-tsl-precompile' );

} );

test( 'tslPrecompile — accepts every known option', () => {

	const plugin = tslPrecompile( {
		artifactsDir: './my-artifacts',
		fail: 'warn',
		autoMark: true,
		autoMarkPrefix: 'demo',
		slim: true,
		threeVersion: '0.184.0',
		minifyWgsl: false,
		dedupeWgsl: false,
	} );
	assert.equal( plugin.name, 'vite-plugin-tsl-precompile' );

} );

test( 'tslPrecompile — rejects unknown option keys', () => {

	assert.throws(
		() => tslPrecompile( { miifyWgsl: true } ),
		/unknown plugin option\(s\): "miifyWgsl"/,
	);
	assert.throws(
		() => tslPrecompile( { foo: 1, bar: 2 } ),
		/unknown plugin option\(s\): "foo", "bar"/,
	);

} );

test( 'tslPrecompile — rejects invalid `fail` enum', () => {

	assert.throws(
		() => tslPrecompile( { fail: 'silent' } ),
		/invalid `fail` option: "silent"/,
	);
	assert.throws(
		() => tslPrecompile( { fail: false } ),
		/invalid `fail` option: false/,
	);

} );

test( 'tslPrecompile — rejects non-object opts', () => {

	assert.throws( () => tslPrecompile( null ), /options must be a plain object/ );
	assert.throws( () => tslPrecompile( 'artifacts' ), /options must be a plain object/ );
	assert.throws( () => tslPrecompile( [] ), /options must be a plain object/ );
	assert.throws( () => tslPrecompile( new Date() ), /options must be a plain object/ );

} );

test( 'tslPrecompile — rejects wrong types for typed options', () => {

	assert.throws( () => tslPrecompile( { artifactsDir: 123 } ), /`artifactsDir` must be a string/ );
	assert.throws( () => tslPrecompile( { autoMarkPrefix: 5 } ), /`autoMarkPrefix` must be a string/ );
	assert.throws( () => tslPrecompile( { threeVersion: 184 } ), /`threeVersion` must be a string/ );
	assert.throws( () => tslPrecompile( { autoMark: 'yes' } ), /`autoMark` must be a boolean/ );
	assert.throws( () => tslPrecompile( { slim: 1 } ), /`slim` must be a boolean/ );
	assert.throws( () => tslPrecompile( { minifyWgsl: 'no' } ), /`minifyWgsl` must be a boolean/ );
	assert.throws( () => tslPrecompile( { dedupeWgsl: 'no' } ), /`dedupeWgsl` must be a boolean/ );

} );

test( 'tslPrecompile — `fail` undefined is accepted (uses default)', () => {

	const plugin = tslPrecompile( { fail: undefined } );
	assert.equal( plugin.name, 'vite-plugin-tsl-precompile' );

} );

test( 'tslPrecompile — `threeVersion: null` is accepted (uses auto-detect)', () => {

	const plugin = tslPrecompile( { threeVersion: null } );
	assert.equal( plugin.name, 'vite-plugin-tsl-precompile' );

} );

test( 'tslPrecompile — warns when app package.json ranges three', async () => {

	const root = await mkdtemp( join( tmpdir(), 'tslp-ranged-three-' ) );
	try {

		await writeFile( join( root, 'package.json' ), JSON.stringify( {
			dependencies: { three: '^0.184.0' },
		} ) );
		const warnings = [];
		const plugin = tslPrecompile( { threeVersion: '0.184.0' } );
		await plugin.configResolved( {
			root,
			command: 'serve',
			logger: { warn: ( message ) => warnings.push( message ) },
		} );

		assert.equal( warnings.length, 1 );
		assert.match( warnings[ 0 ], /dependencies\.three is "\^0\.184\.0"/ );
		assert.match( warnings[ 0 ], /pin three to an exact patch version/ );

	} finally {

		await rm( root, { recursive: true, force: true } );

	}

} );

test( 'tslPrecompile — accepts exact pinned three package specs without warning', async () => {

	const root = await mkdtemp( join( tmpdir(), 'tslp-exact-three-' ) );
	try {

		await writeFile( join( root, 'package.json' ), JSON.stringify( {
			dependencies: { three: '0.184.0' },
		} ) );
		const warnings = [];
		const plugin = tslPrecompile( { threeVersion: '0.184.0' } );
		await plugin.configResolved( {
			root,
			command: 'build',
			logger: { warn: ( message ) => warnings.push( message ) },
		} );

		assert.deepEqual( warnings, [] );

	} finally {

		await rm( root, { recursive: true, force: true } );

	}

} );
