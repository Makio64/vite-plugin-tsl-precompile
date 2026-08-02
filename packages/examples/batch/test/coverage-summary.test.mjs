import assert from 'node:assert/strict';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { PNG } from 'pngjs';

import {
	E2E_EVIDENCE_SCHEMA_VERSION,
	describeEvidenceBytes,
	fingerprintJson,
	readEvidenceCatalogue,
	resolveE2EHarnessSourceFiles,
	sha256,
} from '../e2e-evidence.mjs';
import { createE2EEvidenceGate } from '../e2e-evidence-gate.mjs';
import { E2E_GPU_OBSERVATION_SCHEMA } from '../e2e-gpu-diagnostics.mjs';
import { createLocalExampleDiscoveryEvidence } from '../e2e-local-source-contract.mjs';
import {
	bindE2EArtifactMetrics,
	computeE2EArtifactMetrics,
} from '../e2e-artifact-metrics.mjs';
import {
	pixelGateDisabledReasonForExample,
	psnrThresholdForExample,
} from '../psnr.mjs';
import { fingerprintThreeSourceVerificationRecords } from '../_three-version.mjs';

const SELF = dirname( fileURLToPath( import.meta.url ) );
const BATCH_ROOT = resolve( SELF, '..' );
const REPO = resolve( BATCH_ROOT, '../../..' );
const SUMMARY_SCRIPT = resolve( BATCH_ROOT, 'run-coverage-summary.mjs' );
const SLIM_BUNDLE_PATH = resolve( REPO, 'packages/runtime/build/three.webgpu.slim.js' );
const CATALOGUE_PATH = resolve( BATCH_ROOT, 'example-catalogue.json' );
const CATALOGUE = readEvidenceCatalogue( CATALOGUE_PATH );
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const CAMPAIGN_ID = 'campaign-fixture';
const OFFICIAL_COMMIT = '2431a09f46f34c560bc8e44b33be0e567723d5b9';
const OFFICIAL_TREE = 'db4af93e35bd10c43f957137f7fb44c138e52ea0';
const OFFICIAL_THREE_PROOF_FILES = [ {
	path: 'build/three.webgpu.js',
	bytes: 42,
	gitBlob: 'b'.repeat( 40 ),
	gitMode: '100644',
	sha256: 'c'.repeat( 64 ),
	gitCommit: OFFICIAL_COMMIT,
	gitTree: OFFICIAL_TREE,
	gitObjectFormat: 'sha1',
} ];
const OFFICIAL_THREE_SOURCE_FILES = OFFICIAL_THREE_PROOF_FILES.map( ( record ) => ( {
	domain: 'three',
	...record,
} ) );
const OFFICIAL_THREE_SOURCES = {
	sha256: fingerprintJson( OFFICIAL_THREE_SOURCE_FILES ),
	fileCount: OFFICIAL_THREE_SOURCE_FILES.length,
	files: OFFICIAL_THREE_SOURCE_FILES,
};
const OFFICIAL_SOURCE_VERIFICATION = {
	commit: OFFICIAL_COMMIT,
	tree: OFFICIAL_TREE,
	objectFormat: 'sha1',
	trackedBlobCount: 6011,
	verifiedBlobCount: OFFICIAL_THREE_PROOF_FILES.length,
	verifiedSourcesSha256: fingerprintThreeSourceVerificationRecords( OFFICIAL_THREE_PROOF_FILES ),
	files: OFFICIAL_THREE_PROOF_FILES,
};
const REQUIRED_REPOSITORY_SOURCES = resolveE2EHarnessSourceFiles( REPO );

function fixtureEnvironment() {

	return {
		schema: 'tslp-e2e-execution-environment@1',
		node: {
			version: 'v24.0.0',
			platform: 'darwin',
			arch: 'arm64',
		},
		browser: {
			engine: 'chromium',
			channel: 'chrome',
			version: '140.0.0.0',
			headless: true,
			userAgent: 'fixture Chrome/140.0.0.0',
			platform: 'macOS',
		},
		webgpu: {
			available: true,
			preferredCanvasFormat: 'bgra8unorm',
			wgslLanguageFeatures: [],
			adapter: {
				isFallbackAdapter: false,
				info: {
					vendor: 'fixture-vendor',
					architecture: 'fixture-architecture',
					device: 'fixture-device',
					description: 'fixture-adapter',
				},
				features: [ 'timestamp-query' ],
				limits: { maxBindGroups: 4 },
			},
		},
		graphics: {
			backendIdentity: 'ANGLE Metal fixture',
			devices: [ { vendorString: 'fixture-vendor', deviceString: 'fixture-device' } ],
			auxiliaryAttributes: { glRenderer: 'ANGLE Metal fixture' },
			featureStatus: { webgpu: 'enabled' },
			driverBugWorkarounds: [],
		},
	};

}

function fixtureRunProvenance( { staleRepositorySource = false, omitRepositorySource = null } = {} ) {

	const files = REQUIRED_REPOSITORY_SOURCES
		.filter( ( file ) => relative( REPO, file ).replaceAll( '\\', '/' ) !== omitRepositorySource )
		.map( ( file ) => {

		const bytes = readFileSync( file );
		return {
			domain: 'repository',
			path: relative( REPO, file ).replaceAll( '\\', '/' ),
			sha256: sha256( bytes ),
			bytes: bytes.length,
		};

	} ).sort( ( left, right ) => left.path.localeCompare( right.path ) );
	if ( staleRepositorySource ) files[ 0 ].sha256 = '0'.repeat( 64 );
	const repository = {
		sha256: fingerprintJson( files ),
		fileCount: files.length,
		files,
	};
	const three = structuredClone( OFFICIAL_THREE_SOURCES );
	const allFiles = [ ...repository.files, ...three.files ]
		.sort( ( left, right ) => left.domain.localeCompare( right.domain ) || left.path.localeCompare( right.path ) );
	const bundleBytes = readFileSync( SLIM_BUNDLE_PATH );
	return {
		harness: {
			sourceFingerprint: repository.sha256,
			sourceFileCount: repository.fileCount,
		},
		sources: {
			all: {
				sha256: fingerprintJson( allFiles ),
				fileCount: allFiles.length,
				files: allFiles,
			},
			repository,
			three,
		},
		slimBundle: {
			absolutePath: SLIM_BUNDLE_PATH,
			sha256: sha256( bundleBytes ),
		},
	};

}

function fixtureLocalProvenance( project ) {

	const localRoot = resolve( REPO, 'packages/examples', project );
	const discovery = createLocalExampleDiscoveryEvidence( {
		repositoryRoot: REPO,
		localRoot,
		project,
	} );
	const files = discovery.sourcePaths.map( ( path ) => {

		const bytes = readFileSync( resolve( localRoot, path ) );
		return {
			domain: 'local',
			path,
			sha256: sha256( bytes ),
			bytes: bytes.length,
		};

	} ).sort( ( left, right ) => left.path.localeCompare( right.path ) );
	return {
		discovery,
		snapshot: {
			sha256: fingerprintJson( files ),
			fileCount: files.length,
			files,
		},
	};

}

function png( rgb ) {

	const image = new PNG( { width: 2, height: 2 } );
	for ( let index = 0; index < image.data.length; index += 4 ) {

		image.data[ index ] = rgb[ 0 ];
		image.data[ index + 1 ] = rgb[ 1 ];
		image.data[ index + 2 ] = rgb[ 2 ];
		image.data[ index + 3 ] = 255;

	}
	return PNG.sync.write( image );

}

function passingSemanticGate() {

	return createE2EEvidenceGate( {
		timings: {
			stock: { mode: 'stock', freezeCompleted: true },
			capture: { mode: 'capture', freezeCompleted: true },
			replay: { mode: 'replay', freezeCompleted: true },
		},
		operationRegistry: {
			schema: 'tslp-e2e-operation-registry@1',
			complete: true,
			expected: [],
		},
		diagnostics: passingGpuDiagnostics(),
	} );

}

function passingGpuDiagnostics() {

	const observation = () => ( {
		schema: E2E_GPU_OBSERVATION_SCHEMA,
		hookInstalled: true,
		requestAdapterCalls: 1,
		requestDeviceCalls: 1,
		devicesObserved: 1,
		uncapturedErrorObservers: 1,
		deviceLostObservers: 1,
		drainAttempts: 1,
		queuesExpected: 1,
		queuesFenced: 1,
		queueFenceFailures: 0,
		complete: true,
	} );
	return Object.fromEntries(
		[ 'stock', 'capture', 'replay' ].map( ( phase ) => [ phase, { gpuObservation: observation() } ] ),
	);

}

function canonicalConfiguration( environment, casePolicies ) {

	return {
		tier: null,
		filter: null,
		offset: 0,
		limit: 9999,
		replayOnly: false,
		reuseReferenceShot: false,
		pixelGateEnabled: true,
		psnrThreshold: 30,
		saveShots: true,
		captureWaitMs: 12000,
		replayWaitMs: 5000,
		targetTick: 0,
		settleFrames: 8,
		presentSettleMs: 120,
		assetSettleMs: 250,
		brightPollMs: 400,
		officialThreeSourcesRequired: true,
		environment,
		casePolicies,
	};

}

function casePolicy( name ) {

	const disabledReason = pixelGateDisabledReasonForExample( name );
	return {
		effectivePsnrThreshold: psnrThresholdForExample( name, 30 ),
		pixelGateEnabled: ! disabledReason,
		pixelGateDisabledReason: disabledReason,
		minimumBrightFraction: 0.005,
	};

}

function createEvidenceFixture( root, {
	canonical = false,
	campaignId = CAMPAIGN_ID,
	staleRepositorySource = false,
	omitRepositorySource = null,
	driftReportTotals = false,
	failedPairedCase = false,
	failedSemanticGate = false,
	missingSemanticGate = false,
	missingEnvironment = false,
	driftManifestEnvironment = false,
} = {} ) {

	const shotDir = join( root, 'evidence', RUN_ID, 'shots' );
	const artifactDir = join( root, 'evidence', RUN_ID, 'artifacts' );
	mkdirSync( shotDir, { recursive: true } );
	mkdirSync( artifactDir, { recursive: true } );
	const passingName = 'webgpu_clearcoat.html';
	const captureBytes = png( [ 20, 80, 140 ] );
	const replayBytes = Buffer.from( captureBytes );
	const capturePath = join( shotDir, `${ passingName }.capture.png` );
	const casePolicies = Object.fromEntries( CATALOGUE.upstreamCaseNames.map( ( name ) => [ name, casePolicy( name ) ] ) );
	const environment = fixtureEnvironment();
	const configuration = canonicalConfiguration( missingEnvironment ? undefined : environment, casePolicies );
	if ( missingEnvironment ) delete configuration.environment;
	configuration.fingerprint = fingerprintJson( configuration );
	const corpus = {
		kind: 'three',
		exact: true,
		caseNames: CATALOGUE.upstreamCaseNames,
	};
	const catalogue = {
		schemaVersion: CATALOGUE.schemaVersion,
		threeVersion: CATALOGUE.threeVersion,
		sha256: CATALOGUE.sha256,
		caseCount: CATALOGUE.caseCount,
		caseIdsSha256: CATALOGUE.caseIdsSha256,
	};
	const threeCheckout = {
		revision: '185',
		packageVersion: '0.185.1',
		git: { available: true, head: OFFICIAL_COMMIT, clean: true },
		sourceVerification: OFFICIAL_SOURCE_VERIFICATION,
		sourceFingerprint: OFFICIAL_THREE_SOURCES.sha256,
	};
	const { harness, sources, slimBundle } = fixtureRunProvenance( {
		staleRepositorySource,
		omitRepositorySource,
	} );
	const details = CATALOGUE.upstreamCaseNames.map( ( name ) => {

		const passing = canonical || name === passingName;
		let capture = null;
		let replay = null;
		let userArtifacts = null;
		let auxArtifacts = null;
		let artifactMetrics = null;
		if ( passing ) {

			const caseCapturePath = join( shotDir, `${ name }.capture.png` );
			const caseReplayPath = join( shotDir, `${ name }.replay.png` );
			writeFileSync( caseCapturePath, captureBytes );
			writeFileSync( caseReplayPath, replayBytes );
			capture = describeEvidenceBytes( { outputRoot: root, file: caseCapturePath, bytes: captureBytes, runId: RUN_ID } );
			replay = describeEvidenceBytes( { outputRoot: root, file: caseReplayPath, bytes: replayBytes, runId: RUN_ID } );
			const userPath = join( artifactDir, `${ name }.user.json` );
			const auxPath = join( artifactDir, `${ name }.aux.json` );
			const userBytes = Buffer.from( '{}' );
			const auxBytes = Buffer.from( '[]' );
			writeFileSync( userPath, userBytes );
			writeFileSync( auxPath, auxBytes );
			userArtifacts = describeEvidenceBytes( { outputRoot: root, file: userPath, bytes: userBytes, runId: RUN_ID } );
			auxArtifacts = describeEvidenceBytes( { outputRoot: root, file: auxPath, bytes: auxBytes, runId: RUN_ID } );
			artifactMetrics = bindE2EArtifactMetrics(
				computeE2EArtifactMetrics( { user: {}, aux: [] } ),
				{ runId: RUN_ID, userArtifacts, auxArtifacts },
			);

		}
		const evidence = {
			runId: RUN_ID,
			capture,
			replay,
			userArtifacts,
			auxArtifacts,
		};
		const status = passing && ! ( failedPairedCase && name === passingName ) ? 'pass' : 'fail';
			return {
				name,
				status,
				evidenceGate: missingSemanticGate && name === passingName
					? undefined
					: failedSemanticGate && name === passingName
					? createE2EEvidenceGate( {
						timings: {
							stock: { mode: 'stock', freezeCompleted: true },
							capture: { mode: 'capture', freezeCompleted: true },
							replay: { mode: 'replay', freezeTimedOut: true },
						},
						operationRegistry: {
							schema: 'tslp-e2e-operation-registry@1',
							complete: true,
							expected: [],
						},
						diagnostics: passingGpuDiagnostics(),
					} )
					: passingSemanticGate(),
				caseConfiguration: casePolicies[ name ],
			evidence,
			artifactMetrics,
			userArtifacts: artifactMetrics?.userArtifactCount ?? 0,
			auxArtifacts: artifactMetrics?.auxArtifactCount ?? 0,
			pixelGate: passing
				? { pass: true, psnr: 'inf', threshold: casePolicies[ name ].effectivePsnrThreshold }
				: { skipped: true, reason: 'fixture has no screenshot', threshold: casePolicies[ name ].effectivePsnrThreshold },
			...( status === 'pass' ? {} : { error: passing ? 'fixture forced a paired failure' : 'fixture has no screenshot' } ),
		};

	} );
	const report = {
		schemaVersion: E2E_EVIDENCE_SCHEMA_VERSION,
		runId: RUN_ID,
		campaignId,
		status: 'completed',
		canonical,
		total: details.length,
		pass: details.filter( ( detail ) => detail.status === 'pass' ).length,
		fail: details.filter( ( detail ) => detail.status === 'fail' ).length,
		configuration,
		evidence: {
			catalogue,
			corpus,
			configurationFingerprint: configuration.fingerprint,
			slimBundle,
			threeCheckout,
			harness,
			sources,
		},
		details,
	};
	if ( driftReportTotals ) {

		report.pass ++;
		report.fail --;

	}
	const reportPath = join( root, 'e2e-report.json' );
	const reportBytes = Buffer.from( JSON.stringify( report, null, 2 ) );
	writeFileSync( reportPath, reportBytes );
	const reportDescriptor = describeEvidenceBytes( { outputRoot: root, file: reportPath, bytes: reportBytes, runId: RUN_ID } );
	const manifest = {
		schemaVersion: E2E_EVIDENCE_SCHEMA_VERSION,
		runId: RUN_ID,
		campaignId,
		canonical,
		report: reportDescriptor,
		catalogue,
		corpus,
		threeCheckout,
		slimBundle,
		harness,
		sources,
		configuration: {
			fingerprint: configuration.fingerprint,
			...( missingEnvironment ? {} : {
				environment: driftManifestEnvironment
					? { ...environment, browser: { ...environment.browser, version: '141.0.0.0' } }
					: environment,
			} ),
		},
		cases: details.map( ( detail ) => ( {
				runId: RUN_ID,
				name: detail.name,
				status: detail.status,
				evidenceGate: detail.evidenceGate,
				caseConfiguration: detail.caseConfiguration,
			capture: detail.evidence.capture,
			replay: detail.evidence.replay,
			userArtifacts: detail.evidence.userArtifacts,
			auxArtifacts: detail.evidence.auxArtifacts,
			artifactMetrics: detail.artifactMetrics,
		} ) ),
	};
	writeFileSync( join( root, 'evidence-manifest.json' ), JSON.stringify( manifest, null, 2 ) );
	return { capturePath, reportPath };

}

function createLocalCohortFixture( aggregateRoot, project, index, campaignId = CAMPAIGN_ID ) {

	const root = join( aggregateRoot, 'cohorts', project );
	mkdirSync( root, { recursive: true } );
	const runId = `22222222-2222-4222-8222-${ String( index ).padStart( 12, '0' ) }`;
	const names = CATALOGUE.records
		.filter( ( record ) => record.sourceKind === 'local' && record.source.project === project )
		.map( ( record ) => record.name );
	const casePolicies = Object.fromEntries( names.map( ( name ) => [ name, casePolicy( name ) ] ) );
	const environment = fixtureEnvironment();
	const configuration = canonicalConfiguration( environment, casePolicies );
	configuration.fingerprint = fingerprintJson( configuration );
	const catalogue = {
		schemaVersion: CATALOGUE.schemaVersion,
		threeVersion: CATALOGUE.threeVersion,
		sha256: CATALOGUE.sha256,
		caseCount: CATALOGUE.caseCount,
		caseIdsSha256: CATALOGUE.caseIdsSha256,
	};
	const localProvenance = fixtureLocalProvenance( project );
	const corpus = {
		kind: 'local',
		project,
		localDiscovery: localProvenance.discovery,
		exact: false,
		caseNames: names,
		discoveredCaseNames: localProvenance.discovery.cases.map( ( entry ) => entry.name ),
	};
	const threeCheckout = {
		revision: '185',
		packageVersion: '0.185.1',
		git: { available: true, head: OFFICIAL_COMMIT, clean: true },
		sourceVerification: OFFICIAL_SOURCE_VERIFICATION,
		sourceFingerprint: OFFICIAL_THREE_SOURCES.sha256,
	};
	const { harness, sources, slimBundle } = fixtureRunProvenance();
	sources.local = localProvenance.snapshot;
	sources.all.files = [ ...sources.all.files, ...sources.local.files ]
		.sort( ( left, right ) => left.domain.localeCompare( right.domain ) || left.path.localeCompare( right.path ) );
	sources.all.fileCount = sources.all.files.length;
	sources.all.sha256 = fingerprintJson( sources.all.files );
	const shotDir = join( root, 'evidence', runId, 'shots' );
	const artifactDir = join( root, 'evidence', runId, 'artifacts' );
	mkdirSync( shotDir, { recursive: true } );
	mkdirSync( artifactDir, { recursive: true } );
	const details = names.map( ( name ) => {

		const captureBytes = png( [ 20, 80, 140 ] );
		const replayBytes = Buffer.from( captureBytes );
		const capturePath = join( shotDir, `${ name }.capture.png` );
		const replayPath = join( shotDir, `${ name }.replay.png` );
		const userPath = join( artifactDir, `${ name }.user.json` );
		const auxPath = join( artifactDir, `${ name }.aux.json` );
		const userBytes = Buffer.from( '{}' );
		const auxBytes = Buffer.from( '[]' );
		writeFileSync( capturePath, captureBytes );
		writeFileSync( replayPath, replayBytes );
		writeFileSync( userPath, userBytes );
		writeFileSync( auxPath, auxBytes );
		const capture = describeEvidenceBytes( { outputRoot: root, file: capturePath, bytes: captureBytes, runId } );
		const replay = describeEvidenceBytes( { outputRoot: root, file: replayPath, bytes: replayBytes, runId } );
		const userArtifacts = describeEvidenceBytes( { outputRoot: root, file: userPath, bytes: userBytes, runId } );
		const auxArtifacts = describeEvidenceBytes( { outputRoot: root, file: auxPath, bytes: auxBytes, runId } );
		const artifactMetrics = bindE2EArtifactMetrics(
			computeE2EArtifactMetrics( { user: {}, aux: [] } ),
			{ runId, userArtifacts, auxArtifacts },
		);
			return {
				name,
				status: 'pass',
				evidenceGate: passingSemanticGate(),
				caseConfiguration: casePolicies[ name ],
			evidence: { runId, capture, replay, userArtifacts, auxArtifacts },
			artifactMetrics,
			userArtifacts: artifactMetrics.userArtifactCount,
			auxArtifacts: artifactMetrics.auxArtifactCount,
			pixelGate: {
				pass: true,
				psnr: 'inf',
				threshold: casePolicies[ name ].effectivePsnrThreshold,
			},
		};

	} );
	const report = {
		schemaVersion: E2E_EVIDENCE_SCHEMA_VERSION,
		runId,
		campaignId,
		status: 'completed',
		canonical: false,
		total: details.length,
		pass: details.length,
		fail: 0,
		configuration,
		evidence: {
			catalogue,
			corpus,
			configurationFingerprint: configuration.fingerprint,
			slimBundle,
			threeCheckout,
			harness,
			sources,
		},
		details,
	};
	const reportPath = join( root, `${ project }-e2e-report.json` );
	const reportBytes = Buffer.from( JSON.stringify( report, null, 2 ) );
	writeFileSync( reportPath, reportBytes );
	const reportDescriptor = describeEvidenceBytes( { outputRoot: root, file: reportPath, bytes: reportBytes, runId } );
	const manifest = {
		schemaVersion: E2E_EVIDENCE_SCHEMA_VERSION,
		runId,
		campaignId,
		canonical: false,
		report: reportDescriptor,
		catalogue,
		corpus,
		threeCheckout,
		slimBundle,
		harness,
		sources,
		configuration: {
			fingerprint: configuration.fingerprint,
			environment,
		},
		cases: details.map( ( detail ) => ( {
				runId,
				name: detail.name,
				status: detail.status,
				evidenceGate: detail.evidenceGate,
				caseConfiguration: detail.caseConfiguration,
			capture: detail.evidence.capture,
			replay: detail.evidence.replay,
			userArtifacts: detail.evidence.userArtifacts,
			auxArtifacts: detail.evidence.auxArtifacts,
			artifactMetrics: detail.artifactMetrics,
		} ) ),
	};
	writeFileSync( join( root, 'evidence-manifest.json' ), JSON.stringify( manifest, null, 2 ) );

}

function rewriteLocalCohortThreeCheckout( aggregateRoot, project, mutate ) {

	const root = join( aggregateRoot, 'cohorts', project );
	const reportPath = join( root, `${ project }-e2e-report.json` );
	const manifestPath = join( root, 'evidence-manifest.json' );
	const report = JSON.parse( readFileSync( reportPath, 'utf8' ) );
	const manifest = JSON.parse( readFileSync( manifestPath, 'utf8' ) );
	mutate( report.evidence.threeCheckout, report.evidence.sources );
	manifest.threeCheckout = structuredClone( report.evidence.threeCheckout );
	manifest.sources = structuredClone( report.evidence.sources );
	const reportBytes = Buffer.from( JSON.stringify( report, null, 2 ) );
	writeFileSync( reportPath, reportBytes );
	manifest.report = describeEvidenceBytes( {
		outputRoot: root,
		file: reportPath,
		bytes: reportBytes,
		runId: report.runId,
	} );
	writeFileSync( manifestPath, JSON.stringify( manifest, null, 2 ) );

}

function rewritePrimaryEvidence( root, mutate ) {

	const reportPath = join( root, 'e2e-report.json' );
	const manifestPath = join( root, 'evidence-manifest.json' );
	const report = JSON.parse( readFileSync( reportPath, 'utf8' ) );
	const manifest = JSON.parse( readFileSync( manifestPath, 'utf8' ) );
	mutate( { report, manifest } );
	delete report.configuration.fingerprint;
	report.configuration.fingerprint = fingerprintJson( report.configuration );
	report.evidence.configurationFingerprint = report.configuration.fingerprint;
	manifest.configuration.fingerprint = report.configuration.fingerprint;
	const reportBytes = Buffer.from( JSON.stringify( report, null, 2 ) );
	writeFileSync( reportPath, reportBytes );
	manifest.report = describeEvidenceBytes( {
		outputRoot: root,
		file: reportPath,
		bytes: reportBytes,
		runId: report.runId,
	} );
	writeFileSync( manifestPath, JSON.stringify( manifest, null, 2 ) );

}

function runCoverageSummary( root ) {

	return spawnSync( process.execPath, [ SUMMARY_SCRIPT, `--output-root=${ root }` ], {
		cwd: BATCH_ROOT,
		encoding: 'utf8',
	} );

}

test( 'coverage summary rejects loose historical shots and reports without a manifest', ( t ) => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-coverage-loose-' ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	mkdirSync( join( root, 'shots' ) );
	writeFileSync( join( root, 'shots', 'webgpu_clearcoat.html.capture.png' ), png( [ 1, 2, 3 ] ) );
	writeFileSync( join( root, 'e2e-report.json' ), JSON.stringify( { details: [] } ) );
	const result = spawnSync( process.execPath, [ SUMMARY_SCRIPT, `--output-root=${ root }` ], {
		cwd: BATCH_ROOT,
		encoding: 'utf8',
	} );
	assert.notEqual( result.status, 0 );
	assert.match( result.stderr, /Evidence manifest not found/ );

} );

test( 'the E2E source fingerprint recursively includes its graders and behavior-bearing imports', () => {

	const runnerSource = readFileSync( resolve( BATCH_ROOT, 'run-e2e.mjs' ), 'utf8' );
	assert.match(
		runnerSource,
		/const HARNESS_SOURCE_FILES = resolveE2EHarnessSourceFiles\( REPO \);/,
	);
	const relativeSources = REQUIRED_REPOSITORY_SOURCES.map( ( file ) => relative( REPO, file ).replaceAll( '\\', '/' ) );
	for ( const path of [
		'packages/examples/batch/run-coverage-summary.mjs',
		'packages/examples/batch/e2e-evidence-gate.mjs',
		'packages/examples/batch/late-render-target-textures.mjs',
		'packages/examples/batch/capture-payload-store.mjs',
		'packages/plugin/src/dev-capture-server.js',
	] ) assert.ok( relativeSources.includes( path ), `${ path } must be in the recursive harness source closure` );

} );

test( 'coverage summary emits exact catalogue rows, run binding, and per-case thresholds', ( t ) => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-coverage-bound-' ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	createEvidenceFixture( root );
	const result = spawnSync( process.execPath, [ SUMMARY_SCRIPT, `--output-root=${ root }` ], {
		cwd: BATCH_ROOT,
		encoding: 'utf8',
	} );
	assert.equal( result.status, 0, result.stderr || result.stdout );

	const markdown = readFileSync( join( root, 'coverage-summary.md' ), 'utf8' );
	const names = [ ...markdown.matchAll( /^\| ([^ |]+\.html) \|/gm ) ].map( ( match ) => match[ 1 ] );
	assert.deepEqual( names.sort(), CATALOGUE.records.map( ( entry ) => entry.name ).sort() );
	assert.match( markdown, new RegExp( `campaign \\\`${ CAMPAIGN_ID }\\\`` ) );
	assert.match( markdown, /\| webgpu_clearcoat\.html \| three \| ✓ \| ✓ \| inf \| 30 dB \| ✅ matches \|/ );
	assert.match( markdown, /\| webgpu_camera_logarithmicdepthbuffer\.html \| three \| ✗ \| ✗ \| — \| 30 dB \| ❌ failure \|/ );

	const coverage = JSON.parse( readFileSync( join( root, 'coverage-summary.json' ), 'utf8' ) );
	assert.equal( coverage.schemaVersion, E2E_EVIDENCE_SCHEMA_VERSION );
	assert.equal( coverage.runId, RUN_ID );
	assert.equal( coverage.canonical, false );
	assert.equal( coverage.totals.rows, CATALOGUE.caseCount );
	assert.equal( coverage.totals.evidenceRows, CATALOGUE.upstreamCaseNames.length );
	assert.equal( coverage.rows.find( ( row ) => row.name === 'webgpu_camera_logarithmicdepthbuffer.html' ).effectiveThreshold, 30 );
	assert.equal( coverage.rows.find( ( row ) => row.name === 'webgpu_clearcoat.html' ).identical, true );
	assert.equal( coverage.rows.find( ( row ) => row.name === 'webgpu_clearcoat.html' ).artifactMetrics.schema, 'tslp-e2e-artifact-metrics@1' );
	assert.match( coverage.evidenceManifest.sha256, /^[a-f0-9]{64}$/ );
	assert.match( coverage.evidenceSet.sha256, /^[a-f0-9]{64}$/ );
	assert.equal( coverage.configuration.environment.browser.channel, 'chrome' );
	assert.equal( coverage.configuration.environment.graphics.backendIdentity, 'ANGLE Metal fixture' );

} );

test( 'coverage summary rejects schema-2 evidence without execution-environment provenance', ( t ) => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-coverage-missing-environment-' ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	createEvidenceFixture( root, { missingEnvironment: true } );
	const result = spawnSync( process.execPath, [ SUMMARY_SCRIPT, `--output-root=${ root }` ], {
		cwd: BATCH_ROOT,
		encoding: 'utf8',
	} );
	assert.notEqual( result.status, 0 );
	assert.match( result.stderr, /report evidence environment is not tslp-e2e-execution-environment@1/ );

} );

test( 'coverage summary rejects environment drift between the report and manifest', ( t ) => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-coverage-environment-drift-' ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	createEvidenceFixture( root, { driftManifestEnvironment: true } );
	const result = spawnSync( process.execPath, [ SUMMARY_SCRIPT, `--output-root=${ root }` ], {
		cwd: BATCH_ROOT,
		encoding: 'utf8',
	} );
	assert.notEqual( result.status, 0 );
	assert.match( result.stderr, /evidence environment drifted between report and manifest/ );

} );

test( 'coverage summary rejects an internally bound but stale repository source snapshot', ( t ) => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-coverage-stale-source-' ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	createEvidenceFixture( root, { staleRepositorySource: true } );
	const result = spawnSync( process.execPath, [ SUMMARY_SCRIPT, `--output-root=${ root }` ], {
		cwd: BATCH_ROOT,
		encoding: 'utf8',
	} );
	assert.notEqual( result.status, 0 );
	assert.match( result.stderr, /repository source .* is stale/ );

} );

test( 'coverage summary rejects a source snapshot that omits a recursive harness dependency', ( t ) => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-coverage-omitted-import-' ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	createEvidenceFixture( root, {
		omitRepositorySource: 'packages/examples/batch/late-render-target-textures.mjs',
	} );
	const result = runCoverageSummary( root );
	assert.notEqual( result.status, 0 );
	assert.match( result.stderr, /repository source snapshot omits required inputs: .*late-render-target-textures\.mjs/ );

} );

test( 'coverage summary reconciles report totals with exact case statuses', ( t ) => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-coverage-status-totals-' ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	createEvidenceFixture( root, { driftReportTotals: true } );
	const result = spawnSync( process.execPath, [ SUMMARY_SCRIPT, `--output-root=${ root }` ], {
		cwd: BATCH_ROOT,
		encoding: 'utf8',
	} );
	assert.notEqual( result.status, 0 );
	assert.match( result.stderr, /pass\/fail totals drifted from its case statuses/ );

} );

test( 'coverage summary never promotes a failed case with matching screenshots', ( t ) => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-coverage-failed-pair-' ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	createEvidenceFixture( root, { failedPairedCase: true } );
	const result = spawnSync( process.execPath, [ SUMMARY_SCRIPT, `--output-root=${ root }` ], {
		cwd: BATCH_ROOT,
		encoding: 'utf8',
	} );
	assert.equal( result.status, 0, result.stderr || result.stdout );
	const coverage = JSON.parse( readFileSync( join( root, 'coverage-summary.json' ), 'utf8' ) );
	const row = coverage.rows.find( ( entry ) => entry.name === 'webgpu_clearcoat.html' );
	assert.equal( row.identical, true );
	assert.equal( row.verdict, 'fail' );
	assert.equal( row.note, 'fixture forced a paired failure' );

} );

test( 'coverage summary never promotes a status-pass case whose semantic gate failed', ( t ) => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-coverage-semantic-fail-' ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	createEvidenceFixture( root, { failedSemanticGate: true } );
	const result = spawnSync( process.execPath, [ SUMMARY_SCRIPT, `--output-root=${ root }` ], {
		cwd: BATCH_ROOT,
		encoding: 'utf8',
	} );
	assert.equal( result.status, 0, result.stderr || result.stdout );
	const coverage = JSON.parse( readFileSync( join( root, 'coverage-summary.json' ), 'utf8' ) );
	const row = coverage.rows.find( ( entry ) => entry.name === 'webgpu_clearcoat.html' );
	assert.equal( row.identical, true );
	assert.equal( row.verdict, 'fail' );
	assert.equal( row.semanticEvidence.valid, true );
	assert.equal( row.semanticEvidence.pass, false );
	assert.equal( row.semanticEvidence.freezeTimeoutCount, 1 );
	assert.match( row.note, /did not reach the deterministic freeze boundary/ );
	assert.equal( coverage.totals.semanticGateFail, 1 );

} );

test( 'coverage summary requires a schema-valid semantic gate before publishing pass', ( t ) => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-coverage-semantic-missing-' ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	createEvidenceFixture( root, { missingSemanticGate: true } );
	const result = spawnSync( process.execPath, [ SUMMARY_SCRIPT, `--output-root=${ root }` ], {
		cwd: BATCH_ROOT,
		encoding: 'utf8',
	} );
	assert.equal( result.status, 0, result.stderr || result.stdout );
	const coverage = JSON.parse( readFileSync( join( root, 'coverage-summary.json' ), 'utf8' ) );
	const row = coverage.rows.find( ( entry ) => entry.name === 'webgpu_clearcoat.html' );
	assert.equal( row.identical, true );
	assert.equal( row.verdict, 'fail' );
	assert.equal( row.semanticEvidence.valid, false );
	assert.equal( row.semanticEvidence.pass, false );
	assert.match( row.note, /invalid semantic evidence gate: gate is missing/ );

} );

test( 'canonical aggregate coverage requires the exact upstream plus six local cohort campaign', ( t ) => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-coverage-aggregate-' ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	createEvidenceFixture( root, { canonical: true } );
	const projects = [ ...new Set( CATALOGUE.records.filter( ( record ) => record.sourceKind === 'local' ).map( ( record ) => record.source.project ) ) ];
	projects.forEach( ( project, index ) => createLocalCohortFixture( root, project, index + 1 ) );
	const result = spawnSync( process.execPath, [ SUMMARY_SCRIPT, `--output-root=${ root }` ], {
		cwd: BATCH_ROOT,
		encoding: 'utf8',
	} );
	assert.equal( result.status, 0, result.stderr || result.stdout );
	const coverage = JSON.parse( readFileSync( join( root, 'coverage-summary.json' ), 'utf8' ) );
	const evidenceSet = JSON.parse( readFileSync( join( root, 'coverage-evidence-set.json' ), 'utf8' ) );
	assert.equal( coverage.canonical, true );
	assert.equal( coverage.corpus.exact, true );
	assert.equal( coverage.totals.evidenceRows, CATALOGUE.caseCount );
	assert.equal( evidenceSet.canonical, true );
	assert.equal( evidenceSet.cohorts.length, projects.length + 1 );
	assert.deepEqual( evidenceSet.cohorts.map( ( cohort ) => cohort.id ).sort(), [ 'upstream', ...projects ].sort() );

} );

test( 'coverage summary rejects an internally consistent stale local source snapshot', ( t ) => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-coverage-stale-local-' ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	createEvidenceFixture( root, { canonical: true } );
	const projects = [ ...new Set( CATALOGUE.records
		.filter( ( record ) => record.sourceKind === 'local' )
		.map( ( record ) => record.source.project ) ) ];
	projects.forEach( ( project, index ) => createLocalCohortFixture( root, project, index + 1 ) );
	const project = projects[ 0 ];
	rewriteLocalCohortThreeCheckout( root, project, ( _threeCheckout, sources ) => {

		sources.local.files[ 0 ].sha256 = '0'.repeat( 64 );
		sources.local.sha256 = fingerprintJson( sources.local.files );

	} );
	const result = runCoverageSummary( root );
	assert.notEqual( result.status, 0 );
	assert.match( result.stderr, /local source .* is stale/ );

} );

test( 'canonical aggregate coverage requires official source verification for every local cohort', async ( t ) => {

	for ( const mutation of [
		{
			label: 'missing source verification',
			apply( threeCheckout ) {

				delete threeCheckout.sourceVerification;

			},
		},
		{
			label: 'corrupt source verification',
			apply( threeCheckout ) {

				threeCheckout.sourceVerification = {
					...OFFICIAL_SOURCE_VERIFICATION,
					tree: 'f'.repeat( 40 ),
				};

			},
		},
		{
			label: 'missing self-contained proof records',
			apply( threeCheckout ) {

				delete threeCheckout.sourceVerification.files;

			},
		},
		{
			label: 'aggregate digest does not match proof records',
			apply( threeCheckout ) {

				threeCheckout.sourceVerification.verifiedSourcesSha256 = 'd'.repeat( 64 );

			},
		},
		{
			label: 'missing Three source snapshot',
			apply( _threeCheckout, sources ) {

				delete sources.three;

			},
		},
		{
			label: 'snapshot proof record differs from self-contained proof',
			apply( threeCheckout, sources ) {

				sources.three.files[ 0 ].gitBlob = 'd'.repeat( 40 );
				sources.three.sha256 = fingerprintJson( sources.three.files );
				threeCheckout.sourceFingerprint = sources.three.sha256;

			},
		},
	] ) {

		await t.test( mutation.label, ( subtest ) => {

			const root = mkdtempSync( join( tmpdir(), 'tslp-coverage-local-source-verification-' ) );
			subtest.after( () => rmSync( root, { recursive: true, force: true } ) );
			createEvidenceFixture( root, { canonical: true } );
			const projects = [ ...new Set( CATALOGUE.records.filter( ( record ) => record.sourceKind === 'local' ).map( ( record ) => record.source.project ) ) ];
			projects.forEach( ( project, index ) => createLocalCohortFixture( root, project, index + 1 ) );
			rewriteLocalCohortThreeCheckout( root, projects[ 0 ], mutation.apply );
			const result = runCoverageSummary( root );
			assert.notEqual( result.status, 0 );
			assert.match(
				result.stderr,
				/Local cohort .* did not verify served sources against the official Three r185 Git tree/,
			);

		} );

	}

} );

test( 'canonical aggregate coverage rejects a missing local cohort', ( t ) => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-coverage-incomplete-' ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	createEvidenceFixture( root, { canonical: true } );
	const result = spawnSync( process.execPath, [ SUMMARY_SCRIPT, `--output-root=${ root }` ], {
		cwd: BATCH_ROOT,
		encoding: 'utf8',
	} );
	assert.notEqual( result.status, 0 );
	assert.match( result.stderr, /requires the exact 254-case campaign/ );

} );

test( 'canonical coverage re-derives thresholds and diagnostic exemptions from current policy', async ( t ) => {

	for ( const mutation of [
		{
			label: 'lowered threshold',
			pattern: /effectivePsnrThreshold drifted from the current coverage policy/,
			apply( detail, entry, policy ) {

				policy.effectivePsnrThreshold = 1;
				detail.caseConfiguration = policy;
				entry.caseConfiguration = policy;
				detail.pixelGate.threshold = 1;

			},
		},
		{
			label: 'added diagnostic exemption',
			pattern: /pixelGateEnabled drifted from the current coverage policy/,
			apply( detail, entry, policy ) {

				policy.pixelGateEnabled = false;
				policy.pixelGateDisabledReason = 'diagnostic';
				detail.caseConfiguration = policy;
				entry.caseConfiguration = policy;

			},
		},
	] ) {

		await t.test( mutation.label, ( subtest ) => {

			const root = mkdtempSync( join( tmpdir(), 'tslp-coverage-policy-drift-' ) );
			subtest.after( () => rmSync( root, { recursive: true, force: true } ) );
			createEvidenceFixture( root );
			rewritePrimaryEvidence( root, ( { report, manifest } ) => {

				const name = 'webgpu_clearcoat.html';
				const detail = report.details.find( ( value ) => value.name === name );
				const entry = manifest.cases.find( ( value ) => value.name === name );
				const policy = { ...report.configuration.casePolicies[ name ] };
				mutation.apply( detail, entry, policy );
				report.configuration.casePolicies[ name ] = policy;

			} );
			const result = runCoverageSummary( root );
			assert.notEqual( result.status, 0 );
			assert.match( result.stderr, mutation.pattern );

		} );

	}

} );

test( 'canonical coverage re-runs the whole-run pixel policy instead of trusting canonical flags', ( t ) => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-coverage-run-policy-drift-' ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	createEvidenceFixture( root, { canonical: true } );
	rewritePrimaryEvidence( root, ( { report } ) => {

		report.configuration.pixelGateEnabled = false;

	} );
	const result = runCoverageSummary( root );
	assert.notEqual( result.status, 0 );
	assert.match( result.stderr, /configuration drifted from the current default policy: pixelGateEnabled=false/ );

} );

test( 'coverage summary rejects corrupt compressed artifact evidence after hash verification', ( t ) => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-coverage-corrupt-artifacts-' ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	createEvidenceFixture( root );
	const corruptPath = join( root, 'evidence', RUN_ID, 'artifacts', 'webgpu_clearcoat.html.user.json.gz' );
	const corruptBytes = Buffer.from( 'hash-valid but not gzip' );
	writeFileSync( corruptPath, corruptBytes );
	const descriptor = {
		...describeEvidenceBytes( {
			outputRoot: root,
			file: corruptPath,
			bytes: corruptBytes,
			runId: RUN_ID,
		} ),
		contentEncoding: 'gzip',
		uncompressedBytes: 2,
	};
	rewritePrimaryEvidence( root, ( { report, manifest } ) => {

		const name = 'webgpu_clearcoat.html';
		const detail = report.details.find( ( value ) => value.name === name );
		const entry = manifest.cases.find( ( value ) => value.name === name );
		detail.evidence.userArtifacts = descriptor;
		entry.userArtifacts = descriptor;
		detail.artifactMetrics.evidence.userArtifacts = {
			file: descriptor.file,
			bytes: descriptor.bytes,
			sha256: descriptor.sha256,
		};
		entry.artifactMetrics = detail.artifactMetrics;

	} );
	const result = runCoverageSummary( root );
	assert.notEqual( result.status, 0 );
	assert.match( result.stderr, /failed bounded gzip decompression/ );

} );

test( 'coverage summary recomputes artifact metrics from decoded dumps', ( t ) => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-coverage-fabricated-metrics-' ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	createEvidenceFixture( root );
	rewritePrimaryEvidence( root, ( { report, manifest } ) => {

		const name = 'webgpu_clearcoat.html';
		const detail = report.details.find( ( value ) => value.name === name );
		const entry = manifest.cases.find( ( value ) => value.name === name );
		detail.artifactMetrics.artifactCount = 1;
		entry.artifactMetrics = detail.artifactMetrics;

	} );
	const result = runCoverageSummary( root );
	assert.notEqual( result.status, 0 );
	assert.match( result.stderr, /artifact metrics do not match the decoded artifact evidence/ );

} );

test( 'coverage summary rejects a tampered run-scoped screenshot', ( t ) => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-coverage-tamper-' ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	const { capturePath } = createEvidenceFixture( root );
	writeFileSync( capturePath, png( [ 255, 0, 0 ] ) );
	const result = spawnSync( process.execPath, [ SUMMARY_SCRIPT, `--output-root=${ root }` ], {
		cwd: BATCH_ROOT,
		encoding: 'utf8',
	} );
	assert.notEqual( result.status, 0 );
	assert.match( result.stderr, /hash drifted/ );

} );

test( 'coverage summary preserves outside victims behind each output symlink', async ( t ) => {

	for ( const outputName of [
		'coverage-evidence-set.json',
		'coverage-summary.json',
		'coverage-summary.md',
	] ) {

		await t.test( outputName, () => {

			const scratch = mkdtempSync( join( tmpdir(), 'tslp-coverage-output-link-' ) );
			t.after( () => rmSync( scratch, { recursive: true, force: true } ) );
			const root = join( scratch, 'output' );
			const outside = join( scratch, 'outside' );
			mkdirSync( root );
			mkdirSync( outside );
			createEvidenceFixture( root );
			const victim = join( outside, outputName );
			writeFileSync( victim, 'preserve-outside' );
			symlinkSync( victim, join( root, outputName ) );

			const result = spawnSync( process.execPath, [ SUMMARY_SCRIPT, `--output-root=${ root }` ], {
				cwd: BATCH_ROOT,
				encoding: 'utf8',
			} );
			assert.notEqual( result.status, 0, result.stdout );
			assert.match( result.stderr, /symbolic link/ );
			assert.equal( readFileSync( victim, 'utf8' ), 'preserve-outside' );

		} );

	}

} );
