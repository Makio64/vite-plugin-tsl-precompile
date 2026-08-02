#!/usr/bin/env node

import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname( fileURLToPath( import.meta.url ) );
export const DEFAULT_REPOSITORY_ROOT = resolve( SCRIPT_DIR, '..' );

function expectedPackage( directory, {
	build = 'vite build',
	ciPhase = 'recursive-build',
} = {} ) {

	return Object.freeze( {
		directory,
		manifestPath: `packages/examples/${ directory }/package.json`,
		name: `examples-${ directory }`,
		build,
		ciPhase,
	} );

}

export const EXPECTED_EXAMPLE_BUILD_PACKAGES = Object.freeze( [
	expectedPackage( 'background' ),
	expectedPackage( 'bloom' ),
	expectedPackage( 'compute' ),
	expectedPackage( 'compute-debug' ),
	expectedPackage( 'getting-started' ),
	expectedPackage( 'mrt-debug' ),
	expectedPackage( 'pbr-shadows' ),
	expectedPackage( 'pmrem-debug' ),
	expectedPackage( 'postprocessing-debug' ),
	expectedPackage( 'shadow-debug' ),
	expectedPackage( 'ocean', { ciPhase: 'preview-smoke' } ),
	expectedPackage( 'wow-showcase', {
		build: 'pnpm run test:routes && vite build',
		ciPhase: 'showcase-preview',
	} ),
] );

function duplicateValues( values ) {

	const seen = new Set();
	const duplicates = new Set();
	for ( const value of values ) {

		if ( seen.has( value ) ) duplicates.add( value );
		seen.add( value );

	}
	return [ ...duplicates ].sort();

}

function exactSortedValues( actual, expected ) {

	return actual.length === expected.length &&
		actual.every( ( value, index ) => value === expected[ index ] );

}

export function assertExamplesBuildContract(
	packageRecords,
	expectedPackages = EXPECTED_EXAMPLE_BUILD_PACKAGES,
) {

	if ( ! Array.isArray( packageRecords ) ) throw new TypeError( 'Example package records must be an array.' );
	if ( ! Array.isArray( expectedPackages ) || expectedPackages.length === 0 ) {

		throw new Error( 'The expected example build package contract must be non-empty.' );

	}
	for ( const [ label, values ] of [
		[ 'expected package names', expectedPackages.map( entry => entry.name ) ],
		[ 'expected manifest paths', expectedPackages.map( entry => entry.manifestPath ) ],
		[ 'discovered package names', packageRecords.map( entry => entry.name ) ],
		[ 'discovered manifest paths', packageRecords.map( entry => entry.manifestPath ) ],
	] ) {

		const duplicates = duplicateValues( values );
		if ( duplicates.length > 0 ) throw new Error( `Duplicate ${ label }: ${ duplicates.join( ', ' ) }.` );

	}

	const recordsByPath = new Map( packageRecords.map( record => [ record.manifestPath, record ] ) );
	for ( const expected of expectedPackages ) {

		const actual = recordsByPath.get( expected.manifestPath );
		if ( ! actual ) throw new Error(
			`Required CI example package is missing: ${ expected.manifestPath } (${ expected.ciPhase }).`,
		);
		if ( actual.name !== expected.name ) throw new Error(
			`${ expected.manifestPath } must be named ${ expected.name }, received ${ JSON.stringify( actual.name ) }.`,
		);
		if ( actual.private !== true ) throw new Error( `${ expected.name } must remain a private example package.` );
		if ( typeof actual.build !== 'string' || actual.build.trim().length === 0 ) {

			throw new Error( `${ expected.name } is missing its required build script.` );

		}
		if ( actual.build !== expected.build ) throw new Error(
			`${ expected.name } build script drifted: expected ${ JSON.stringify( expected.build ) }, ` +
			`received ${ JSON.stringify( actual.build ) }.`,
		);

	}

	const actualBuildPackages = packageRecords
		.filter( record => typeof record.build === 'string' && record.build.trim().length > 0 )
		.map( record => record.name )
		.sort();
	const expectedBuildPackages = expectedPackages.map( entry => entry.name ).sort();
	if ( ! exactSortedValues( actualBuildPackages, expectedBuildPackages ) ) {

		const expectedSet = new Set( expectedBuildPackages );
		const actualSet = new Set( actualBuildPackages );
		const missing = expectedBuildPackages.filter( name => ! actualSet.has( name ) );
		const unexpected = actualBuildPackages.filter( name => ! expectedSet.has( name ) );
		throw new Error(
			'Example build-enabled package set drifted.' +
			( missing.length > 0 ? ` Missing: ${ missing.join( ', ' )}.` : '' ) +
			( unexpected.length > 0 ? ` Unexpected: ${ unexpected.join( ', ' )}.` : '' ),
		);

	}
	return {
		buildPackageCount: expectedPackages.length,
		ciPhases: Object.fromEntries(
			[ ...new Set( expectedPackages.map( entry => entry.ciPhase ) ) ].sort().map( phase => [
				phase,
				expectedPackages.filter( entry => entry.ciPhase === phase ).map( entry => entry.name ),
			] ),
		),
	};

}

export function inspectExamplesBuildContract( repositoryRoot = DEFAULT_REPOSITORY_ROOT ) {

	const examplesRoot = resolve( repositoryRoot, 'packages/examples' );
	const records = [];
	for ( const entry of readdirSync( examplesRoot, { withFileTypes: true } ) ) {

		if ( entry.isSymbolicLink() ) throw new Error( `Example package directory must not be a symbolic link: ${ entry.name }.` );
		if ( ! entry.isDirectory() ) continue;
		const manifestPath = `packages/examples/${ entry.name }/package.json`;
		const absoluteManifest = join( examplesRoot, entry.name, 'package.json' );
		let manifestStat;
		try {

			manifestStat = lstatSync( absoluteManifest );

		} catch ( error ) {

			if ( error?.code === 'ENOENT' ) continue;
			throw error;

		}
		if ( manifestStat.isSymbolicLink() || ! manifestStat.isFile() ) {

			throw new Error( `Example package manifest must be a regular file: ${ manifestPath }.` );

		}
		let manifest;
		try {

			manifest = JSON.parse( readFileSync( absoluteManifest, 'utf8' ) );

		} catch ( cause ) {

			throw new Error( `Could not parse ${ manifestPath }.`, { cause } );

		}
		records.push( {
			manifestPath,
			name: manifest.name,
			private: manifest.private,
			build: manifest.scripts?.build,
		} );

	}
	return assertExamplesBuildContract( records );

}

if ( process.argv[ 1 ] && resolve( process.argv[ 1 ] ) === fileURLToPath( import.meta.url ) ) {

	const result = inspectExamplesBuildContract();
	console.log(
		`[examples-build-contract] ${ result.buildPackageCount } build packages across ` +
		`${ Object.keys( result.ciPhases ).length } CI phases verified.`,
	);

}
