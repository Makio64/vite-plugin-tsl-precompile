import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';

const PUBLIC_PACKAGE_FILES = Object.freeze( [
	new URL( '../../package.json', import.meta.url ),
	new URL( '../../../contract/package.json', import.meta.url ),
	new URL( '../../../runtime/package.json', import.meta.url ),
] );
const INSPECTOR_PACKAGE_FILE = new URL( '../../../inspector-panel/package.json', import.meta.url );

test( 'public package versions stay in lockstep', async () => {

	const packages = await Promise.all( PUBLIC_PACKAGE_FILES.map( async ( packageFile ) =>
		JSON.parse( await readFile( packageFile, 'utf8' ) )
	) );
	const versions = new Map( packages.map( ( packageJson ) => [ packageJson.name, packageJson.version ] ) );
	const expectedVersion = packages[ 0 ].version;

	assert.deepEqual(
		[ ...new Set( versions.values() ) ],
		[ expectedVersion ],
		`public package versions must match:\n${ [ ...versions ].map( ( [ name, version ] ) => `  ${ name }: ${ version }` ).join( '\n' ) }`,
	);

} );

test( 'artifact compatibility version stays decoupled from npm prerelease versions', () => {

	assert.equal(
		ARTIFACT_TOOLCHAIN_VERSION,
		'0.1.0',
		'npm prerelease bumps must not invalidate captures; change this only for an incompatible artifact contract',
	);

} );

test( 'repository-only inspector package cannot enter a recursive publish', async () => {

	const packageJson = JSON.parse( await readFile( INSPECTOR_PACKAGE_FILE, 'utf8' ) );
	assert.equal( packageJson.name, '@tsl-precompile/inspector-panel' );
	assert.equal(
		packageJson.private,
		true,
		'@tsl-precompile/inspector-panel is outside the public plugin/runtime/contract release set',
	);

} );
