import assert from 'node:assert/strict';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { discoverLocalExampleCases } from '../local-example-discovery.mjs';

test( 'local example manifests are additive and share physical routes with the runner', ( t ) => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-local-cases-' ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	mkdirSync( root, { recursive: true } );
	writeFileSync( join( root, 'index.html' ), '' );
	writeFileSync( join( root, 'shadow.html' ), '' );
	writeFileSync( join( root, 'standalone.html' ), '' );
	writeFileSync( join( root, 'e2e-cases.json' ), JSON.stringify( {
		cases: [
			{ name: 'shadow-basic.html', path: 'shadow.html?mode=basic', pixelGate: false },
			{ name: 'shadow-vsm.html', path: 'shadow.html?mode=vsm' },
		],
	} ) );

	assert.deepEqual( discoverLocalExampleCases( root ), [
		{
			name: 'shadow-basic.html',
			path: 'shadow.html?mode=basic',
			options: { name: 'shadow-basic.html', path: 'shadow.html?mode=basic', pixelGate: false },
		},
		{
			name: 'shadow-vsm.html',
			path: 'shadow.html?mode=vsm',
			options: { name: 'shadow-vsm.html', path: 'shadow.html?mode=vsm' },
		},
		{ name: 'shadow.html', path: 'shadow.html', options: null },
		{ name: 'standalone.html', path: 'standalone.html', options: null },
	] );

} );

test( 'local example manifests reject traversal names and routes without touching outside files', ( t ) => {

	const scratch = mkdtempSync( join( tmpdir(), 'tslp-local-case-traversal-' ) );
	t.after( () => rmSync( scratch, { recursive: true, force: true } ) );
	const root = join( scratch, 'examples' );
	mkdirSync( root );
	writeFileSync( join( root, 'index.html' ), '' );
	const victim = join( scratch, 'outside.html' );
	writeFileSync( victim, 'preserve-outside' );

	writeFileSync( join( root, 'e2e-cases.json' ), JSON.stringify( [
		{ name: '../../../../outside.html', path: 'index.html' },
	] ) );
	assert.throws( () => discoverLocalExampleCases( root ), /canonical HTML basename/ );
	assert.equal( readFileSync( victim, 'utf8' ), 'preserve-outside' );

	writeFileSync( join( root, 'e2e-cases.json' ), JSON.stringify( [
		{ name: 'outside.html', path: '../outside.html' },
	] ) );
	assert.throws( () => discoverLocalExampleCases( root ), /canonical relative HTML route/ );
	assert.equal( readFileSync( victim, 'utf8' ), 'preserve-outside' );

} );

test( 'local example discovery rejects symlinked HTML routes', ( t ) => {

	const scratch = mkdtempSync( join( tmpdir(), 'tslp-local-case-symlink-' ) );
	t.after( () => rmSync( scratch, { recursive: true, force: true } ) );
	const root = join( scratch, 'examples' );
	mkdirSync( root );
	const victim = join( scratch, 'outside.html' );
	writeFileSync( victim, 'preserve-outside' );
	symlinkSync( victim, join( root, 'linked.html' ) );
	writeFileSync( join( root, 'e2e-cases.json' ), JSON.stringify( [
		{ name: 'linked.html', path: 'linked.html' },
	] ) );

	assert.throws( () => discoverLocalExampleCases( root ), /must not traverse a symbolic link/ );
	assert.equal( readFileSync( victim, 'utf8' ), 'preserve-outside' );

} );

test( 'shadow-debug manifest and physical routes form one 16-case set', () => {

	const root = fileURLToPath( new URL( '../../shadow-debug/', import.meta.url ) );
	const cases = discoverLocalExampleCases( root );
	assert.equal( cases.length, 16 );
	for ( const name of [ 'directional.html', 'point.html', 'spot.html', 'vsm.html' ] ) {

		assert.equal( cases.some( ( entry ) => entry.name === name ), true );

	}

} );
