import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as auxRegistry from '../src/aux-registry.js';

const RUNTIME_ROOT = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );

test( 'aux-registry public entry exposes only generated registration', () => {

	assert.deepEqual( Object.keys( auxRegistry ), [ 'registerAuxArtifacts' ] );
	const pkg = JSON.parse( readFileSync( resolve( RUNTIME_ROOT, 'package.json' ), 'utf8' ) );
	assert.deepEqual( pkg.exports[ './aux-registry' ], {
		types: './types/aux-registry.d.ts',
		default: './src/aux-registry.js',
	} );
	const types = readFileSync( resolve( RUNTIME_ROOT, 'types/aux-registry.d.ts' ), 'utf8' );
	assert.match( types, /registerAuxArtifacts/ );
	assert.doesNotMatch( types, /loadAux|wireViewportTextureRefs|registerAuxArtifact\s*</ );

} );

test( 'packed runtime includes the narrow aux-registry entry and declaration', () => {

	const stdout = execFileSync( 'pnpm', [ 'pack', '--dry-run', '--json' ], {
		cwd: RUNTIME_ROOT,
		encoding: 'utf8',
	} );
	const packed = JSON.parse( stdout.slice( stdout.indexOf( '{' ), stdout.lastIndexOf( '}' ) + 1 ) );
	const paths = new Set( packed.files.map( ( file ) => file.path ) );
	assert.equal( paths.has( 'src/aux-registry.js' ), true );
	assert.equal( paths.has( 'types/aux-registry.d.ts' ), true );

} );
