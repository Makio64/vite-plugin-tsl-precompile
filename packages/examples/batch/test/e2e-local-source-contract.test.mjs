import assert from 'node:assert/strict';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { fingerprintJson, sha256 } from '../e2e-evidence.mjs';
import {
	assertCurrentLocalCohortSources,
	createLocalExampleDiscoveryEvidence,
} from '../e2e-local-source-contract.mjs';

function localSnapshot( root, discovery ) {

	const files = discovery.sourcePaths.map( ( path ) => {

		const bytes = readFileSync( resolve( root, path ) );
		return { domain: 'local', path, sha256: sha256( bytes ), bytes: bytes.length };

	} ).sort( ( left, right ) => left.path.localeCompare( right.path ) );
	return { sha256: fingerprintJson( files ), fileCount: files.length, files };

}

test( 'local cohort proof binds manifest options, route bytes, and discovered HTML inventory', ( t ) => {

	const repositoryRoot = mkdtempSync( join( tmpdir(), 'tslp-local-proof-' ) );
	t.after( () => rmSync( repositoryRoot, { recursive: true, force: true } ) );
	const project = 'fixture-project';
	const localRoot = resolve( repositoryRoot, 'packages/examples', project );
	mkdirSync( localRoot, { recursive: true } );
	const manifestPath = resolve( localRoot, 'e2e-cases.json' );
	const routePath = resolve( localRoot, 'scene.html' );
	writeFileSync( manifestPath, JSON.stringify( {
		cases: [ {
			name: 'scene.html',
			path: 'scene.html?mode=fixture',
			pixelGate: false,
		} ],
	} ) );
	writeFileSync( routePath, '<!doctype html><canvas></canvas>' );
	const discovery = createLocalExampleDiscoveryEvidence( {
		repositoryRoot,
		localRoot,
		project,
	} );
	assert.equal( discovery.rootKind, 'repository' );
	const snapshot = localSnapshot( localRoot, discovery );
	const corpus = {
		kind: 'local',
		project,
		localDiscovery: discovery,
		caseNames: [ 'scene.html' ],
		discoveredCaseNames: [ 'scene.html' ],
	};
	const catalogue = {
		records: [ {
			name: 'scene.html',
			sourceKind: 'local',
			source: {
				kind: 'local',
				project,
				path: `packages/examples/${ project }/scene.html`,
				route: 'scene.html?mode=fixture',
			},
		} ],
	};
	assert.equal(
		assertCurrentLocalCohortSources( {
			snapshot,
			discovery,
			corpus,
			catalogue,
			repositoryRoot,
			label: 'fixture cohort',
		} ).cases.length,
		1,
	);

	writeFileSync( manifestPath, JSON.stringify( {
		cases: [ {
			name: 'scene.html',
			path: 'scene.html?mode=fixture',
			pixelGate: true,
		} ],
	} ) );
	assert.throws(
		() => assertCurrentLocalCohortSources( {
			snapshot,
			discovery,
			corpus,
			catalogue,
			repositoryRoot,
			label: 'fixture cohort',
		} ),
		/local discovery evidence is stale/,
	);

	writeFileSync( manifestPath, JSON.stringify( {
		cases: [ {
			name: 'scene.html',
			path: 'scene.html?mode=fixture',
			pixelGate: false,
		} ],
	} ) );
	writeFileSync( resolve( localRoot, 'extra.html' ), '<!doctype html><canvas></canvas>' );
	assert.throws(
		() => assertCurrentLocalCohortSources( {
			snapshot,
			discovery,
			corpus,
			catalogue,
			repositoryRoot,
			label: 'fixture cohort',
		} ),
		/local discovery evidence is stale/,
	);

} );

test( 'external local roots remain byte-snapshotted diagnostics but cannot be published', ( t ) => {

	const repositoryRoot = mkdtempSync( join( tmpdir(), 'tslp-local-repository-' ) );
	const localRoot = mkdtempSync( join( tmpdir(), 'tslp-local-external-' ) );
	t.after( () => {

		rmSync( repositoryRoot, { recursive: true, force: true } );
		rmSync( localRoot, { recursive: true, force: true } );

	} );
	const project = 'external-pages';
	writeFileSync( resolve( localRoot, 'scene.html' ), '<!doctype html><canvas></canvas>' );
	const discovery = createLocalExampleDiscoveryEvidence( {
		repositoryRoot,
		localRoot,
		project,
	} );
	assert.equal( discovery.rootKind, 'external' );
	assert.equal( discovery.root, resolve( localRoot ) );
	assert.deepEqual( discovery.sourcePaths, [ 'scene.html' ] );
	const snapshot = localSnapshot( localRoot, discovery );
	assert.equal( snapshot.fileCount, 1 );
	assert.throws(
		() => assertCurrentLocalCohortSources( {
			snapshot,
			discovery,
			corpus: {
				kind: 'local',
				project,
				localDiscovery: discovery,
				caseNames: [ 'scene.html' ],
				discoveredCaseNames: [ 'scene.html' ],
			},
			catalogue: { records: [] },
			repositoryRoot,
			label: 'external fixture',
		} ),
		/external local-example root.*diagnostic-only/,
	);

} );

test( 'local cohort proof rejects stale recorded route bytes', ( t ) => {

	const repositoryRoot = mkdtempSync( join( tmpdir(), 'tslp-local-bytes-' ) );
	t.after( () => rmSync( repositoryRoot, { recursive: true, force: true } ) );
	const project = 'fixture-project';
	const localRoot = resolve( repositoryRoot, 'packages/examples', project );
	mkdirSync( localRoot, { recursive: true } );
	const routePath = resolve( localRoot, 'scene.html' );
	writeFileSync( routePath, '<!doctype html><canvas></canvas>' );
	const discovery = createLocalExampleDiscoveryEvidence( {
		repositoryRoot,
		localRoot,
		project,
	} );
	const snapshot = localSnapshot( localRoot, discovery );
	const corpus = {
		kind: 'local',
		project,
		localDiscovery: discovery,
		caseNames: [ 'scene.html' ],
		discoveredCaseNames: [ 'scene.html' ],
	};
	const catalogue = {
		records: [ {
			name: 'scene.html',
			sourceKind: 'local',
			source: {
				kind: 'local',
				project,
				path: `packages/examples/${ project }/scene.html`,
				route: 'scene.html',
			},
		} ],
	};
	writeFileSync( routePath, '<!doctype html><canvas>changed</canvas>' );
	assert.throws(
		() => assertCurrentLocalCohortSources( {
			snapshot,
			discovery,
			corpus,
			catalogue,
			repositoryRoot,
			label: 'fixture cohort',
		} ),
		/local source scene\.html is stale/,
	);

} );
