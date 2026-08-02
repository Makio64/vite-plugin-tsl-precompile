import assert from 'node:assert/strict';
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import {
	E2E_EVIDENCE_SCHEMA_VERSION,
	describeEvidenceBytes,
	fingerprintJson,
	readEvidenceCatalogue,
	sha256,
} from '../e2e-evidence.mjs';
import {
	loadUiEvidenceSnapshot,
	planUiDiagnosticRun,
	readUiEvidenceShot,
} from '../run-ui.mjs';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const CAMPAIGN_ID = 'ui-schema2-fixture';
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
	'base64',
);

function createFixture( t, {
	symlinkCapture = false,
	artifactEncoding = 'plain',
} = {} ) {

	const workspace = mkdtempSync( join( tmpdir(), 'tslp-results-ui-' ) );
	t.after( () => rmSync( workspace, { recursive: true, force: true } ) );
	const resultsRoot = join( workspace, 'results' );
	const runRoot = join( resultsRoot, 'evidence', RUN_ID );
	const shotsRoot = join( runRoot, 'shots' );
	const artifactsRoot = join( runRoot, 'artifacts' );
	mkdirSync( shotsRoot, { recursive: true } );
	mkdirSync( artifactsRoot, { recursive: true } );

	const cataloguePath = join( workspace, 'example-catalogue.json' );
	writeFileSync( cataloguePath, JSON.stringify( {
		schemaVersion: 1,
		threeVersion: '0.185.1',
		cases: [ {
			id: 'webgpu_fixture',
			source: {
				kind: 'three',
				path: 'examples/webgpu_fixture.html',
				route: 'webgpu_fixture.html',
				originalUrl: 'https://threejs.org/examples/#webgpu_fixture',
			},
		} ],
	} ) );
	const catalogue = readEvidenceCatalogue( cataloguePath, {
		root: workspace,
		label: 'results UI test catalogue',
	} );
	const name = 'webgpu_fixture.html';
	const capturePath = join( shotsRoot, `${ name }.capture.png` );
	const replayPath = join( shotsRoot, `${ name }.replay.png` );
	const compressedArtifacts = artifactEncoding !== 'plain';
	const userPath = join( artifactsRoot, `${ name }.user.json${ compressedArtifacts ? '.gz' : '' }` );
	const auxPath = join( artifactsRoot, `${ name }.aux.json${ compressedArtifacts ? '.gz' : '' }` );
	const userBytes = compressedArtifacts ? gzipSync( Buffer.from( '{}' ) ) : Buffer.from( '{}' );
	const auxBytes = compressedArtifacts ? gzipSync( Buffer.from( '[]' ) ) : Buffer.from( '[]' );
	writeFileSync( capturePath, PNG );
	writeFileSync( replayPath, PNG );
	writeFileSync( userPath, userBytes );
	writeFileSync( auxPath, auxBytes );
	let capture = describeEvidenceBytes( {
		outputRoot: resultsRoot,
		file: capturePath,
		bytes: PNG,
		runId: RUN_ID,
	} );
	if ( symlinkCapture ) {

		const outside = join( workspace, 'outside.png' );
		writeFileSync( outside, PNG );
		unlinkSync( capturePath );
		try {

			symlinkSync( outside, capturePath );

		} catch ( error ) {

			if ( error?.code === 'EPERM' || error?.code === 'EACCES' ) {

				t.skip( `symlinks unavailable: ${ error.code }` );

			}
			throw error;

		}
		capture = {
			runId: RUN_ID,
			file: `evidence/${ RUN_ID }/shots/${ name }.capture.png`,
			sha256: sha256( PNG ),
			bytes: PNG.length,
		};

	}
	const replay = describeEvidenceBytes( {
		outputRoot: resultsRoot,
		file: replayPath,
		bytes: PNG,
		runId: RUN_ID,
	} );
	let userArtifacts = describeEvidenceBytes( {
		outputRoot: resultsRoot,
		file: userPath,
		bytes: userBytes,
		runId: RUN_ID,
	} );
	let auxArtifacts = describeEvidenceBytes( {
		outputRoot: resultsRoot,
		file: auxPath,
		bytes: auxBytes,
		runId: RUN_ID,
	} );
	if ( artifactEncoding === 'gzip' ) {

		userArtifacts = {
			...userArtifacts,
			contentEncoding: 'gzip',
			uncompressedBytes: Buffer.byteLength( '{}' ),
		};
		auxArtifacts = {
			...auxArtifacts,
			contentEncoding: 'gzip',
			uncompressedBytes: Buffer.byteLength( '[]' ),
		};

	}
	const environment = { schema: 'test-environment@1', browser: { version: '1' } };
	const caseConfiguration = {
		effectivePsnrThreshold: 30,
		pixelGateEnabled: true,
		pixelGateDisabledReason: null,
		minimumBrightFraction: 0.005,
	};
	const configuration = {
		psnrThreshold: 30,
		environment,
		casePolicies: { [ name ]: caseConfiguration },
	};
	configuration.fingerprint = fingerprintJson( configuration );
	const detail = {
		name,
		status: 'pass',
		caseConfiguration,
		evidence: {
			runId: RUN_ID,
			capture,
			replay,
			userArtifacts,
			auxArtifacts,
		},
		pixelGate: { pass: true, psnr: 'inf', threshold: 30 },
		userArtifacts: 1,
		auxArtifacts: 0,
	};
	const catalogueBinding = {
		schemaVersion: catalogue.schemaVersion,
		threeVersion: catalogue.threeVersion,
		sha256: catalogue.sha256,
		caseCount: catalogue.caseCount,
		caseIdsSha256: catalogue.caseIdsSha256,
	};
	const corpus = {
		kind: 'three',
		exact: true,
		caseNames: [ name ],
	};
	const report = {
		schemaVersion: E2E_EVIDENCE_SCHEMA_VERSION,
		runId: RUN_ID,
		campaignId: CAMPAIGN_ID,
		status: 'completed',
		canonical: true,
		total: 1,
		pass: 1,
		fail: 0,
		configuration,
		details: [ detail ],
	};
	const reportPath = join( resultsRoot, 'e2e-report.json' );
	const reportBytes = Buffer.from( JSON.stringify( report, null, 2 ) );
	writeFileSync( reportPath, reportBytes );
	const reportDescriptor = describeEvidenceBytes( {
		outputRoot: resultsRoot,
		file: reportPath,
		bytes: reportBytes,
		runId: RUN_ID,
	} );
	const manifest = {
		schemaVersion: E2E_EVIDENCE_SCHEMA_VERSION,
		runId: RUN_ID,
		campaignId: CAMPAIGN_ID,
		canonical: true,
		report: reportDescriptor,
		catalogue: catalogueBinding,
		corpus,
		configuration: {
			fingerprint: configuration.fingerprint,
			environment,
		},
		cases: [ {
			runId: RUN_ID,
			name,
			status: 'pass',
			caseConfiguration,
			capture,
			replay,
			userArtifacts,
			auxArtifacts,
		} ],
	};
	const manifestBytes = Buffer.from( JSON.stringify( manifest, null, 2 ) );
	writeFileSync( join( resultsRoot, 'evidence-manifest.json' ), manifestBytes );
	const evidenceSet = {
		schemaVersion: E2E_EVIDENCE_SCHEMA_VERSION,
		campaignId: CAMPAIGN_ID,
		canonical: true,
		catalogue: catalogueBinding,
		corpus: { kind: 'aggregate', exact: true, caseCount: 1, cohortCount: 1 },
		cohorts: [ {
			id: 'upstream',
			kind: 'three',
			project: null,
			runId: RUN_ID,
			campaignId: CAMPAIGN_ID,
			canonical: true,
			root: '.',
			portable: true,
			manifest: {
				file: 'evidence-manifest.json',
				sha256: sha256( manifestBytes ),
			},
			report: reportDescriptor,
			corpus,
			configuration: manifest.configuration,
		} ],
	};
	writeFileSync( join( resultsRoot, 'coverage-evidence-set.json' ), JSON.stringify( evidenceSet, null, 2 ) );
	return {
		workspace,
		resultsRoot,
		catalogue,
		record: catalogue.records[ 0 ],
		capturePath,
	};

}

test( 'results UI loads and reads only manifest-bound schema-2 screenshots', ( t ) => {

	const fixture = createFixture( t );
	const snapshot = loadUiEvidenceSnapshot( {
		resultsRoot: fixture.resultsRoot,
		catalogue: fixture.catalogue,
	} );
	assert.equal( snapshot.canonical, true );
	assert.equal( snapshot.entries.size, 1 );
	const entry = snapshot.entries.get( 'webgpu_fixture.html' );
	assert.equal( entry.capture.descriptor.runId, RUN_ID );
	assert.deepEqual( readUiEvidenceShot( entry.capture ), PNG );

	writeFileSync( fixture.capturePath, Buffer.concat( [ PNG, Buffer.from( 'tampered' ) ] ) );
	assert.throws(
		() => readUiEvidenceShot( entry.capture ),
		/size drifted|hash drifted/,
	);

} );

test( 'results UI rejects a manifest screenshot that traverses a symlink', ( t ) => {

	const fixture = createFixture( t, { symlinkCapture: true } );
	assert.throws(
		() => loadUiEvidenceSnapshot( {
			resultsRoot: fixture.resultsRoot,
			catalogue: fixture.catalogue,
		} ),
		/symbolic link/,
	);

} );

test( 'results UI accepts gzip artifact descriptors only with matching encoding and suffix', ( t ) => {

	const compressed = createFixture( t, { artifactEncoding: 'gzip' } );
	const snapshot = loadUiEvidenceSnapshot( {
		resultsRoot: compressed.resultsRoot,
		catalogue: compressed.catalogue,
	} );
	const entry = snapshot.entries.get( compressed.record.name );
	assert.equal( entry.userArtifacts.descriptor.contentEncoding, 'gzip' );
	assert.equal( entry.userArtifacts.descriptor.uncompressedBytes, 2 );
	assert.match( entry.userArtifacts.descriptor.file, /\.user\.json\.gz$/ );

	const mismatched = createFixture( t, { artifactEncoding: 'mismatch' } );
	assert.throws(
		() => loadUiEvidenceSnapshot( {
			resultsRoot: mismatched.resultsRoot,
			catalogue: mismatched.catalogue,
		} ),
		/run-scoped canonical path/,
	);

} );

test( 'focused UI runs separate isolated output from canonical input', ( t ) => {

	const fixture = createFixture( t );
	const snapshot = loadUiEvidenceSnapshot( {
		resultsRoot: fixture.resultsRoot,
		catalogue: fixture.catalogue,
	} );
	const runsRoot = mkdtempSync( join( tmpdir(), 'tslp-results-ui-runs-' ) );
	t.after( () => rmSync( runsRoot, { recursive: true, force: true } ) );
	const threeRepo = join( fixture.workspace, 'three' );
	mkdirSync( join( threeRepo, 'examples' ), { recursive: true } );
	const plan = planUiDiagnosticRun( {
		record: fixture.record,
		canonicalEntry: snapshot.entries.get( fixture.record.name ),
		mode: 'replay',
		sequence: 7,
		runsRoot,
		threeRepo,
		repositoryRoot: fixture.workspace,
		catalogue: fixture.catalogue,
	} );
	assert.notEqual( plan.outputRoot, fixture.resultsRoot );
	assert.ok( plan.outputRoot.startsWith( `${ realpathSync( runsRoot ) }/` ) );
	assert.equal( plan.inputRoot, fixture.resultsRoot );
	assert.ok( plan.runnerArgs.includes( `--output-root=${ plan.outputRoot }` ) );
	assert.ok( plan.runnerArgs.includes( `--input-root=${ fixture.resultsRoot }` ) );
	assert.ok( plan.runnerArgs.includes( '--replay-only' ) );
	assert.throws(
		() => planUiDiagnosticRun( {
			record: fixture.record,
			canonicalEntry: { ...snapshot.entries.get( fixture.record.name ), canonical: false },
			mode: 'reuse-reference',
			sequence: 8,
			runsRoot,
			threeRepo,
			repositoryRoot: fixture.workspace,
			catalogue: fixture.catalogue,
		} ),
		/current canonical manifest-bound input cohort/,
	);

} );

test( 'results UI source and operator docs describe run-scoped evidence without flat-shot drift', () => {

	const root = resolve( import.meta.dirname, '..' );
	const source = readFileSync( join( root, 'run-ui.mjs' ), 'utf8' );
	const readme = readFileSync( join( root, 'README.md' ), 'utf8' );
	assert.doesNotMatch( source, /results\/shots|\/shots\// );
	assert.match( source, /coverage-evidence-set\.json|E2E_EVIDENCE_SET_JSON/ );
	assert.match( source, /--output-root=/ );
	assert.match( source, /--input-root=/ );
	assert.doesNotMatch( readme, /\b206\b|results\/shots/ );
	assert.match( readme, /254-case catalogue/ );
	assert.match( readme, /209 official Three r185 WebGPU examples plus 45 local routes/ );
	assert.match( readme, /Schema-2 evidence is run-scoped/ );
	assert.match( readme, /diagnostic pass/ );

} );
