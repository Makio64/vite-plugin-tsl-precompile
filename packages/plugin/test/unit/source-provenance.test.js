import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
	MARKER_SOURCE_PROVENANCE_SCHEMA,
	collectMarkerSourceProvenance,
	normalizeMarkerSourceProvenance,
	recomputeRecordedMarkerSourceRevision,
} from '../../src/_shared/source-provenance.js';

const EXTENSIONS = [ '.js', '.jsx', '.ts', '.tsx', '.mjs', '.mts', '.cjs', '.cts', '.json' ];

async function write( path, source ) {

	await mkdir( dirname( path ), { recursive: true } );
	await writeFile( path, source );

}

async function firstExisting( candidates ) {

	for ( const candidate of candidates ) {

		try {

			await access( candidate );
			return candidate;

		} catch {}

	}
	return null;

}

function resolver( root, aliases = {} ) {

	return async ( specifier, importer ) => {

		if ( specifier === 'virtual:fixture' ) return '\0virtual:fixture';
		if ( aliases[ specifier ] ) return aliases[ specifier ];
		if ( specifier.startsWith( '.' ) ) {

			const cleanImporter = String( importer ).split( /[?#]/, 1 )[ 0 ];
			const base = resolve( dirname( cleanImporter ), specifier );
			const candidates = extname( base )
				? [ base ]
				: [ base, ...EXTENSIONS.map( ( extension ) => base + extension ), ...EXTENSIONS.map( ( extension ) => join( base, 'index' + extension ) ) ];
			return firstExisting( candidates );

		}
		if ( specifier === 'dependency-package' ) return join( root, 'node_modules/dependency-package/index.js' );
		return null;

	};

}

test( 'marker source provenance follows the deterministic transitive local static closure', async () => {

	const root = await mkdtemp( join( tmpdir(), 'tslp-source-provenance-' ) );
	const owner = join( root, 'src/main.js' );
	const material = join( root, 'src/material.js' );
	const nodes = join( root, 'src/nodes.ts' );
	const lazy = join( root, 'src/lazy.js' );
	const common = join( root, 'src/common.cjs' );
	const typescriptImport = join( root, 'src/ts-import.ts' );
	const unrelated = join( root, 'src/unrelated.js' );
	const ownerSource = [
		`import { material } from './material.js';`,
		`import 'dependency-package';`,
		`import 'virtual:fixture';`,
		`material.precompile( 'hero' );`,
	].join( '\n' );

	try {

		await write( owner, ownerSource );
		await write( material, [
			`export { node } from './nodes.ts';`,
			`void import( './lazy.js' );`,
			`const common = require( './common.cjs' );`,
			`import extra = require( './ts-import.ts' );`,
			`import './main.js';`,
			`export const material = common.material || extra;`,
		].join( '\n' ) );
		await write( nodes, 'export const node: number = 1;\n' );
		await write( lazy, 'export const lazy = true;\n' );
		await write( common, 'exports.material = {};\n' );
		await write( typescriptImport, 'export = {};\n' );
		await write( unrelated, 'export const unrelated = 1;\n' );
		await write( join( root, 'node_modules/dependency-package/index.js' ), 'export const external = 1;\n' );

		const first = await collectMarkerSourceProvenance( {
			source: ownerSource,
			filename: owner,
			root,
			resolveDependency: resolver( root ),
		} );
		assert.equal( first.provenance.schema, MARKER_SOURCE_PROVENANCE_SCHEMA );
		assert.deepEqual(
			first.provenance.dependencies,
			[ 'src/common.cjs', 'src/lazy.js', 'src/material.js', 'src/nodes.ts', 'src/ts-import.ts' ],
		);

		await write( unrelated, 'export const unrelated = 2;\n' );
		const unrelatedEdit = await collectMarkerSourceProvenance( {
			source: ownerSource,
			filename: owner,
			root,
			resolveDependency: resolver( root ),
		} );
		assert.equal( unrelatedEdit.revision, first.revision );

		await write( join( root, 'node_modules/dependency-package/index.js' ), 'export const external = 2;\n' );
		const dependencyPackageEdit = await collectMarkerSourceProvenance( {
			source: ownerSource,
			filename: owner,
			root,
			resolveDependency: resolver( root ),
		} );
		assert.equal( dependencyPackageEdit.revision, first.revision );

		await write( nodes, 'export const node: number = 2;\n' );
		const transitiveEdit = await collectMarkerSourceProvenance( {
			source: ownerSource,
			filename: owner,
			root,
			resolveDependency: resolver( root ),
		} );
		assert.notEqual( transitiveEdit.revision, first.revision );
		const verified = await recomputeRecordedMarkerSourceRevision( {
			source: ownerSource,
			provenance: first.provenance,
			root,
		} );
		assert.equal( verified.revision, transitiveEdit.revision );

	} finally {

		await rm( root, { recursive: true, force: true } );

	}

} );

test( 'marker source provenance canonicalizes alias query subresources and symlinked paths', async () => {

	const realRoot = await mkdtemp( join( tmpdir(), 'tslp-source-provenance-real-' ) );
	const rootLink = realRoot + '-link';
	const owner = join( rootLink, 'src/main.js' );
	const helper = join( rootLink, 'src/helper.ts' );
	const component = join( rootLink, 'src/Material.vue' );
	const source = `import { helper } from '@shader';\nimport '@component';\nhelper.precompile( 'hero' );\n`;

	try {

		await write( join( realRoot, 'src/main.js' ), source );
		await write( join( realRoot, 'src/helper.ts' ), 'export const helper = {};\n' );
		await write( join( realRoot, 'src/Material.vue' ), `<script setup lang="ts">\nimport './helper.ts';\n</script>\n<template><canvas /></template>\n` );
		await symlink( realRoot, rootLink, 'dir' );
		const first = await collectMarkerSourceProvenance( {
			source,
			filename: owner + '?import&t=1',
			root: rootLink,
			resolveDependency: resolver( rootLink, {
				'@shader': helper + '?lang.ts&kind=shader&t=111',
				'@component': component + '?vue&type=script&lang.ts&t=111',
			} ),
		} );
		const second = await collectMarkerSourceProvenance( {
			source,
			filename: join( realRoot, 'src/main.js' ) + '?t=99&import',
			root: realRoot,
			resolveDependency: resolver( realRoot, {
				'@shader': pathToFileURL( join( realRoot, 'src/helper.ts' ) ).href + '?kind=shader&t=222&lang.ts',
				'@component': join( realRoot, 'src/Material.vue' ) + '?lang.ts&type=script&vue&t=222',
			} ),
		} );
		assert.equal( first.revision, second.revision );
		assert.equal( first.provenance.dependencies.length, 3 );
		assert.match( first.provenance.dependencies[ 0 ], /^src\/Material\.vue\?subresource=[a-f0-9]{64}$/ );
		assert.equal( first.provenance.dependencies[ 1 ], 'src/helper.ts' );
		assert.match( first.provenance.dependencies[ 2 ], /^src\/helper\.ts\?subresource=[a-f0-9]{64}$/ );

	} finally {

		await rm( rootLink, { force: true } );
		await rm( realRoot, { recursive: true, force: true } );

	}

} );

test( 'marker source provenance fails closed on unresolved local imports and unsafe recorded identities', async () => {

	const root = await mkdtemp( join( tmpdir(), 'tslp-source-provenance-errors-' ) );
	const owner = join( root, 'src/main.js' );
	const source = `import './missing.js';\nmaterial.precompile( 'hero' );\n`;

	try {

		await assert.rejects(
			collectMarkerSourceProvenance( {
				source,
				filename: owner,
				root,
				resolveDependency: resolver( root ),
			} ),
			/could not resolve project-local import "\.\/missing\.js"/,
		);
		assert.throws(
			() => normalizeMarkerSourceProvenance( {
				schema: MARKER_SOURCE_PROVENANCE_SCHEMA,
				dependencies: [ '../outside.js' ],
			} ),
			/not safely contained/,
		);

	} finally {

		await rm( root, { recursive: true, force: true } );

	}

} );
