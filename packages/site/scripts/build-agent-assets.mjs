#!/usr/bin/env node

import { cp, lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	assertKnownSiteSelectorArguments,
	resolveCanonicalSitePublicRoot,
} from './examples-evidence-contract.mjs';
import {
	prepareOutputRoot,
	removeOutputPath,
} from '../../examples/batch/output-path-safety.mjs';

async function assertRegularCopyTree( root, label ) {

	const stat = await lstat( root );
	if ( stat.isSymbolicLink() ) throw new Error( `${ label } must not contain symbolic links: ${ root }.` );
	if ( stat.isFile() ) return;
	if ( ! stat.isDirectory() ) throw new Error( `${ label } contains an unsupported filesystem entry: ${ root }.` );
	for ( const entry of await readdir( root ) ) {

		await assertRegularCopyTree( resolve( root, entry ), label );

	}

}

assertKnownSiteSelectorArguments();
const siteRoot = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );
const repoRoot = resolve( siteRoot, '../..' );
const source = resolve( repoRoot, '.agents/skills/integrate-tsl-precompile' );
const canonicalPublicRoot = resolve( siteRoot, 'public' );
const skill = await readFile( resolve( source, 'SKILL.md' ), 'utf8' );
if ( ! /^---\nname: integrate-tsl-precompile\n/m.test( skill ) ) throw new Error(
	'The public agent asset source is not the canonical integrate-tsl-precompile skill.',
);
await assertRegularCopyTree( source, 'Public agent asset source' );
const selectedPublicRoot = resolveCanonicalSitePublicRoot( { siteRoot } );
const publicRoot = prepareOutputRoot( selectedPublicRoot, {
	repositoryRoot: repoRoot,
	allowedRepositoryRoots: [ canonicalPublicRoot ],
	label: 'Site public output root',
} );
const destination = resolve( publicRoot, 'agent/integrate-tsl-precompile' );

if ( publicRoot !== canonicalPublicRoot ) {

	const generatedNames = new Set( [
		'agent',
		'coverage-evidence-set.json',
		'coverage-summary.json',
		'examples',
		'examples.json',
		'live',
		'live-examples.json',
	] );
	for ( const entry of await readdir( canonicalPublicRoot, { withFileTypes: true } ) ) {

		if ( generatedNames.has( entry.name ) ) continue;
		const sourceEntry = resolve( canonicalPublicRoot, entry.name );
		await assertRegularCopyTree( sourceEntry, `Copied public asset ${ entry.name }` );
		const target = resolve( publicRoot, entry.name );
		removeOutputPath( publicRoot, target, {
			recursive: true,
			label: `Copied public asset ${ entry.name }`,
		} );
		await cp(
			sourceEntry,
			target,
			{ recursive: true, force: true },
		);

	}

}

removeOutputPath( publicRoot, destination, {
	recursive: true,
	label: 'Published integration skill',
} );
await cp( source, destination, { recursive: true, force: true } );
console.log( '[site-agent] published the canonical integration skill.' );
