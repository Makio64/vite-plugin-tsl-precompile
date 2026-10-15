import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { probeVendorImports, probeThreeRewrites, withThreeSourceRoot } from '../../scripts/probe-vendor.mjs';
import { THREE_RELEASE_PROFILES } from '@tsl-precompile/contract/slim-three-policy';

test( 'rewrite probes carry the exact development revision and source commit', async () => {

	const profile = THREE_RELEASE_PROFILES.development;
	const failures = await probeThreeRewrites( profile.packageVersion, {
		threeRevision: profile.revision,
		threeCommit: profile.gitCommit,
		targets: [ { sourcePath: 'candidate.js', rewriteFamily: 'candidate' } ],
		loadSource: async () => ( { code: 'export {};', id: '/node_modules/three/src/candidate.js' } ),
		rewrite( code, id, options ) {

			assert.deepEqual( options, { threeVersion: profile.packageVersion, threeRevision: profile.revision, threeCommit: profile.gitCommit } );
			return { code };

		},
	} );
	assert.deepEqual( failures, [] );

} );

test( 'candidate source imports apply to vendor dependencies and restore normal resolution after failure', async ( t ) => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-three-vendor-probe-' ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	writeFileSync( join( root, 'package.json' ), JSON.stringify( { name: 'three', type: 'module', exports: { '.': './candidate.js' } } ) );
	writeFileSync( join( root, 'candidate.js' ), 'export const candidate = "pinned";\n' );
	writeFileSync( join( root, 'dependency.js' ), 'import { candidate } from "three"; export { candidate };\n' );
	writeFileSync( join( root, 'vendor.js' ), 'export { candidate } from "./dependency.js";\n' );
	const original = import.meta.resolve( 'three' );
	const failure = new Error( 'initialization failed' );
	await assert.rejects( withThreeSourceRoot( root, async () => {

		const vendor = await import( pathToFileURL( join( root, 'vendor.js' ) ).href );
		assert.equal( vendor.candidate, 'pinned' );
		throw failure;

	} ), ( error ) => error === failure );
	assert.equal( import.meta.resolve( 'three' ), original );

} );

test( 'vendor diagnostics report every changed import at its source location and load shared modules once', async () => {

	let loads = 0;
	const failures = await probeVendorImports( [ { file: 'vendor.js', code: `
import { renamed as local, kept } from 'three/tsl';
import Default from 'three/tsl';
import * as namespace from 'three/tsl';
import { gone } from 'three/src/moved.js';
import { ignored } from './local.js';
` } ], async ( specifier ) => {

		loads ++;
		if ( specifier.endsWith( 'moved.js' ) ) throw new Error( 'upstream file moved' );
		return { kept: 1 };

	} );
	assert.equal( loads, 2 );
	assert.equal( failures.length, 3 );
	assert.equal( failures[ 0 ].location, 'vendor.js:2' );
	assert.match( failures[ 0 ].message, /missing export renamed/ );
	assert.match( failures[ 1 ].message, /missing export default/ );
	assert.equal( failures[ 2 ].stage, 'import' );
	assert.match( failures[ 2 ].message, /file moved/ );

} );

test( 'rewrite diagnostics aggregate changed assumptions and missing files without skipping later targets', async () => {

	const failures = await probeThreeRewrites( 'next', {
		targets: [ 'changed', 'missing', 'healthy' ].map( ( sourcePath ) => ( { sourcePath, rewriteFamily: sourcePath } ) ),
		loadSource: async ( target ) => {

			if ( target.sourcePath === 'missing' ) throw new Error( 'source moved' );
			return { code: '', id: target.sourcePath };

		},
		rewrite: ( code, id, options ) => {

			assert.equal( options.threeVersion, 'next' );
			return id === 'changed' ? { warning: 'expected _nodes.getForRender assignment' } : { code: 'export {}' };

		},
	} );
	assert.deepEqual( failures.map( ( failure ) => failure.family ), [ 'changed', 'missing' ] );
	assert.match( failures[ 0 ].message, /getForRender/ );
	assert.equal( failures[ 1 ].message, 'source moved' );

} );

test( 'historical filenames are optional only when their rewrite family still exists', async () => {

	const targets = [
		{ sourcePath: 'Nodes.js', rewriteFamily: 'nodes' },
		{ sourcePath: 'NodeManager.js', rewriteFamily: 'nodes' },
	];
	const missing = () => { throw Object.assign( new Error( 'missing file' ), { code: 'ENOENT' } ); };
	const options = {
		targets,
		loadSource: async ( target ) => target.sourcePath === 'Nodes.js' ? missing() : { code: 'export {}', id: target.sourcePath },
		rewrite: ( code ) => ( { code } ),
	};
	assert.deepEqual( await probeThreeRewrites( 'next', options ), [] );
	assert.equal( ( await probeThreeRewrites( 'next', { ...options, loadSource: missing } ) ).length, 2 );

} );
