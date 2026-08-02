import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import {
	assertCurrentEvidenceSourceSnapshot,
	assertUniqueExactNames,
	fingerprintJson,
} from './e2e-evidence.mjs';
import { discoverLocalExampleCases } from './local-example-discovery.mjs';

export const E2E_LOCAL_DISCOVERY_SCHEMA = 'tslp-e2e-local-discovery@2';

function routePathname( route ) {

	return String( route || '' ).split( /[?#]/, 1 )[ 0 ];

}

function portablePath( repositoryRoot, file, label ) {

	const path = relative( resolve( repositoryRoot ), resolve( file ) );
	if (
		! path ||
		path === '..' ||
		path.startsWith( `..${ sep }` ) ||
		isAbsolute( path )
	) {

		throw new Error( `${ label } escapes the current repository.` );

	}
	return path.replaceAll( sep, '/' );

}

function expectedProjectRoot( repositoryRoot, project ) {

	return resolve( repositoryRoot, 'packages/examples', project );

}

export function describeLocalExampleDiscovery( {
	repositoryRoot,
	localRoot,
	project,
	entries,
} ) {

	const expectedRoot = expectedProjectRoot( repositoryRoot, project );
	const resolvedLocalRoot = resolve( localRoot );
	const rootKind = resolvedLocalRoot === expectedRoot ? 'repository' : 'external';
	const cases = entries.map( ( entry ) => ( {
		name: entry.name,
		path: entry.path,
		options: entry.options === null || entry.options === undefined
			? null
			: structuredClone( entry.options ),
	} ) ).sort( ( left, right ) => left.name.localeCompare( right.name ) );
	const sourcePaths = [
		...( existsSync( resolve( localRoot, 'e2e-cases.json' ) ) ? [ 'e2e-cases.json' ] : [] ),
		...cases.map( ( entry ) => routePathname( entry.path ) ),
	].filter( Boolean ).sort();
	const uniqueSourcePaths = [ ...new Set( sourcePaths ) ];
	return {
		schema: E2E_LOCAL_DISCOVERY_SCHEMA,
		project,
		rootKind,
		root: rootKind === 'repository'
			? portablePath( repositoryRoot, resolvedLocalRoot, `Local evidence project ${ project } root` )
			: resolvedLocalRoot,
		caseCount: cases.length,
		casesSha256: fingerprintJson( cases ),
		cases,
		sourcePaths: uniqueSourcePaths,
	};

}

export function createLocalExampleDiscoveryEvidence( {
	repositoryRoot,
	localRoot,
	project,
	readFile,
} ) {

	const entries = discoverLocalExampleCases( localRoot, readFile ? { readFile } : undefined );
	return describeLocalExampleDiscovery( {
		repositoryRoot,
		localRoot,
		project,
		entries,
	} );

}

export function assertCurrentLocalCohortSources( {
	snapshot,
	discovery,
	corpus,
	catalogue,
	repositoryRoot,
	label = 'Local evidence cohort',
} ) {

	const project = corpus?.project;
	if ( typeof project !== 'string' || project.length === 0 ) {

		throw new Error( `${ label } has no local project identity.` );

	}
	if ( discovery?.rootKind !== 'repository' ) {

		throw new Error(
			`${ label } uses an external local-example root and is diagnostic-only; ` +
			'canonical coverage and site publication require a repository local cohort.',
		);

	}
	const localRoot = expectedProjectRoot( repositoryRoot, project );
	const current = createLocalExampleDiscoveryEvidence( {
		repositoryRoot,
		localRoot,
		project,
	} );
	if (
		! discovery ||
		discovery.schema !== E2E_LOCAL_DISCOVERY_SCHEMA ||
		discovery.project !== project ||
		discovery.root !== current.root ||
		discovery.caseCount !== discovery.cases?.length ||
		discovery.casesSha256 !== fingerprintJson( discovery.cases || [] ) ||
		fingerprintJson( discovery ) !== fingerprintJson( current )
	) {

		throw new Error( `${ label } local discovery evidence is stale or inconsistent.` );

	}
	const expectedRecords = catalogue.records.filter(
		( record ) => record.sourceKind === 'local' && record.source?.project === project,
	);
	const expectedNames = expectedRecords.map( ( record ) => record.name );
	const currentNames = current.cases.map( ( entry ) => entry.name );
	assertUniqueExactNames( currentNames, expectedNames, `${ label } current local discovery` );
	assertUniqueExactNames(
		corpus.discoveredCaseNames || [],
		currentNames,
		`${ label } recorded local discovery`,
	);
	assertUniqueExactNames(
		corpus.caseNames || [],
		expectedNames,
		`${ label } local corpus`,
	);
	const currentByName = new Map( current.cases.map( ( entry ) => [ entry.name, entry ] ) );
	for ( const record of expectedRecords ) {

		if ( currentByName.get( record.name )?.path !== record.source.route ) {

			throw new Error(
				`${ label } current route for ${ record.name } drifted from the evidence catalogue.`,
			);

		}

	}
	assertCurrentEvidenceSourceSnapshot( snapshot, {
		domain: 'local',
		root: localRoot,
		label,
		requiredPaths: current.sourcePaths,
	} );
	return current;

}
