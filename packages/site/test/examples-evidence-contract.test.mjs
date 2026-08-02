import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import sharp from 'sharp';

import {
	E2E_EVIDENCE_SCHEMA_VERSION,
	caseIdsFingerprint,
	describeEvidenceBytes,
	fingerprintJson,
	readEvidenceCatalogue,
	resolveE2EHarnessSourceFiles,
	sha256,
} from '../../examples/batch/e2e-evidence.mjs';
import {
	bindE2EArtifactMetrics,
	computeE2EArtifactMetrics,
} from '../../examples/batch/e2e-artifact-metrics.mjs';
import { createE2EEvidenceGate } from '../../examples/batch/e2e-evidence-gate.mjs';
import { E2E_GPU_OBSERVATION_SCHEMA } from '../../examples/batch/e2e-gpu-diagnostics.mjs';
import { createLocalExampleDiscoveryEvidence } from '../../examples/batch/e2e-local-source-contract.mjs';
import {
	pixelGateDisabledReasonForExample,
	psnrThresholdForExample,
} from '../../examples/batch/psnr.mjs';
import { fingerprintThreeSourceVerificationRecords } from '../../examples/batch/_three-version.mjs';
import {
	applySiteEvidenceTotalsToHtml,
	applySiteEvidenceVerdictsToHtml,
	applySiteFeaturedEvidenceToHtml,
	assertKnownSiteSelectorArguments,
	assertPassingSiteEvidenceGate,
	assertPublishableSitePublicEvidence,
	describeCanonicalStockReport,
	describeSiteFeaturedEvidence,
	loadCanonicalExamplesEvidence,
	resolveCanonicalExamplesEvidenceRoot,
	resolveCanonicalSitePublicRoot,
	resolveCanonicalStockReport,
	SITE_EVIDENCE_TOTAL_KEYS,
	verifyBuiltSiteFeaturedEvidence,
	verifyPublishedSiteEvidence,
	verifyPublicFileHash,
} from '../scripts/examples-evidence-contract.mjs';

const REPO_ROOT = resolve( import.meta.dirname, '../../..' );
const CATALOGUE_PATH = resolve( REPO_ROOT, 'packages/examples/batch/example-catalogue.json' );
const CATALOGUE = readEvidenceCatalogue( CATALOGUE_PATH );
const CAMPAIGN_ID = 'campaign-contract-fixture';
const SLIM_BUNDLE_PATH = resolve( REPO_ROOT, 'packages/runtime/build/three.webgpu.slim.js' );
const SLIM_BUNDLE = { absolutePath: SLIM_BUNDLE_PATH, sha256: sha256( readFileSync( SLIM_BUNDLE_PATH ) ) };
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
const FIXTURE_PNG = await sharp( {
	create: {
		width: 640,
		height: 480,
		channels: 4,
		background: { r: 20, g: 80, b: 140, alpha: 1 },
	},
} ).png().toBuffer();

function writeJson( file, value ) {

	mkdirSync( dirname( file ), { recursive: true } );
	const bytes = Buffer.from( JSON.stringify( value, null, 2 ) );
	writeFileSync( file, bytes );
	return bytes;

}

function writeEvidence( root, file, value, runId ) {

	const bytes = Buffer.isBuffer( value ) ? value : Buffer.from( value );
	const absolute = join( root, file );
	mkdirSync( dirname( absolute ), { recursive: true } );
	writeFileSync( absolute, bytes );
	return describeEvidenceBytes( { outputRoot: root, file: absolute, bytes, runId } );

}

function png() {

	return Buffer.from( FIXTURE_PNG );

	/* c8 ignore next 4 */
	return Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAoAAAAHgCAYAAAA10dzkAAAH2ElEQVR4Ae3BAQGAMAACME4Ggz2YnTUI285z3y8AAMxoAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApjQAAExpAACY0gAAMKUBAGBKAwDAlAYAgCkNAABTGgAApvxQlQWvnKq5NAAAAABJRU5ErkJggg==',
		'base64',
	);

}

function categoryOf( name ) {

	if ( /^webgpu_lights_/.test( name ) || name === 'webgpu_lightprobe_cubecamera.html' ) return 'Lights';
	if ( /^webgpu_materials_/.test( name ) || name === 'webgpu_clearcoat.html' || name === 'webgpu_sandbox.html' ) return 'Materials';
	if ( /^webgpu_shadow/.test( name ) ) return 'Shadows';
	if ( /^webgpu_compute_/.test( name ) ) return 'Compute';
	if ( /^webgpu_sprites/.test( name ) ) return 'Sprites';
	if ( /^webgpu_camera/.test( name ) ) return 'Camera';
	if ( /^webgpu_mrt/.test( name ) || /^webgpu_multiple_rendertargets/.test( name ) ) return 'MRT / RenderTargets';
	if ( /^webgpu_particles/.test( name ) ) return 'Particles';
	if ( /^webgpu_postprocessing_/.test( name ) ) return 'Postprocessing';
	return 'Misc';

}

function catalogueBinding() {

	return {
		schemaVersion: CATALOGUE.schemaVersion,
		threeVersion: CATALOGUE.threeVersion,
		sha256: CATALOGUE.sha256,
		caseCount: CATALOGUE.caseCount,
		caseIdsSha256: CATALOGUE.caseIdsSha256,
		upstreamCaseCount: CATALOGUE.upstreamCaseNames.length,
		upstreamCaseNamesSha256: CATALOGUE.upstreamCaseNamesSha256,
	};

}

function fixtureCohorts() {

	const groups = new Map( [ [ 'upstream', {
		kind: 'three',
		project: null,
		names: CATALOGUE.records.filter( ( record ) => record.sourceKind === 'three' ).map( ( record ) => record.name ),
	} ] ] );
	for ( const record of CATALOGUE.records.filter( ( entry ) => entry.sourceKind === 'local' ) ) {

		const project = record.source.project;
		if ( ! groups.has( project ) ) groups.set( project, { kind: 'local', project, names: [] } );
		groups.get( project ).names.push( record.name );

	}
	return groups;

}

function canonicalConfiguration( casePolicies ) {

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
		casePolicies,
	};

}

function passingSemanticGate() {

	return createE2EEvidenceGate( {
		timings: {
			stock: { freezeCompleted: true },
			capture: { freezeCompleted: true },
			replay: { freezeCompleted: true },
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

function repositorySources() {

	const files = resolveE2EHarnessSourceFiles( REPO_ROOT ).map( ( file ) => {

		const bytes = readFileSync( file );
		const path = relative( REPO_ROOT, file ).replaceAll( '\\', '/' );
		return {
			domain: 'repository',
			path,
			sha256: sha256( bytes ),
			bytes: bytes.length,
		};

	} );
	const repository = {
		sha256: fingerprintJson( files ),
		fileCount: files.length,
		files,
	};
	const three = structuredClone( OFFICIAL_THREE_SOURCES );
	const allFiles = [ ...repository.files, ...three.files ]
		.sort( ( left, right ) => left.domain.localeCompare( right.domain ) || left.path.localeCompare( right.path ) );
	return {
		repository,
		three,
		all: {
			sha256: fingerprintJson( allFiles ),
			fileCount: allFiles.length,
			files: allFiles,
		},
	};

}

function localSources( project ) {

	const localRoot = resolve( REPO_ROOT, 'packages/examples', project );
	const discovery = createLocalExampleDiscoveryEvidence( {
		repositoryRoot: REPO_ROOT,
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

function createCampaignFixture( root, { semanticGatePass = true } = {} ) {

	const cohortReferences = [];
	const rows = [];
	let upstream = null;
	let cohortIndex = 0;
	for ( const [ id, cohort ] of fixtureCohorts() ) {

		cohortIndex ++;
		const runId = `run-${ String( cohortIndex ).padStart( 2, '0' ) }`;
		const relativeRoot = id === 'upstream' ? '.' : `cohorts/${ id }`;
		const cohortRoot = resolve( root, relativeRoot );
		mkdirSync( cohortRoot, { recursive: true } );
		const corpus = {
			kind: cohort.kind,
			project: cohort.project,
			exact: id === 'upstream',
			caseNames: cohort.names,
		};
			const threeCheckout = {
				revision: '185',
				packageVersion: '0.185.1',
				git: { available: true, head: OFFICIAL_COMMIT, clean: true },
				sourceVerification: OFFICIAL_SOURCE_VERIFICATION,
				sourceFingerprint: OFFICIAL_THREE_SOURCES.sha256,
			};
			const sources = repositorySources();
			if ( cohort.kind === 'local' ) {

				const local = localSources( cohort.project );
				corpus.localDiscovery = local.discovery;
				corpus.discoveredCaseNames = local.discovery.cases.map( ( entry ) => entry.name );
				sources.local = local.snapshot;
				sources.all.files = [ ...sources.all.files, ...sources.local.files ]
					.sort( ( left, right ) => left.domain.localeCompare( right.domain ) || left.path.localeCompare( right.path ) );
				sources.all.fileCount = sources.all.files.length;
				sources.all.sha256 = fingerprintJson( sources.all.files );

			}
			const harness = {
				sourceFingerprint: sources.repository.sha256,
				sourceFileCount: sources.repository.fileCount,
			};
			const casePolicies = Object.fromEntries( cohort.names.map( ( name ) => {

				const disabledReason = pixelGateDisabledReasonForExample( name );
				return [ name, {
					effectivePsnrThreshold: psnrThresholdForExample( name, 30 ),
					pixelGateEnabled: ! disabledReason,
					pixelGateDisabledReason: disabledReason,
				} ];

			} ) );
			const configuration = canonicalConfiguration( casePolicies );
			configuration.fingerprint = fingerprintJson( configuration );
			const cases = [];
			const details = [];
		const shotBytes = png();
		for ( const name of cohort.names ) {

			const stem = name.replace( /\.html$/, '' );
			const capture = writeEvidence( cohortRoot, `evidence/${ runId }/shots/${ name }.capture.png`, shotBytes, runId );
			const replay = writeEvidence( cohortRoot, `evidence/${ runId }/shots/${ name }.replay.png`, shotBytes, runId );
			const userArtifacts = writeEvidence( cohortRoot, `evidence/${ runId }/artifacts/${ name }.user.json`, '{}', runId );
			const auxArtifacts = writeEvidence( cohortRoot, `evidence/${ runId }/artifacts/${ name }.aux.json`, '[]', runId );
			const artifactMetrics = bindE2EArtifactMetrics(
				computeE2EArtifactMetrics( { user: {}, aux: [] } ),
				{ runId, userArtifacts, auxArtifacts },
			);
				const caseConfiguration = casePolicies[ name ];
				const evidence = { runId, capture, replay, userArtifacts, auxArtifacts };
				const evidenceGate = createE2EEvidenceGate( {
					timings: {
						stock: { freezeCompleted: true },
						capture: { freezeCompleted: true },
						replay: { freezeCompleted: true },
					},
					operationRegistry: {
						schema: 'tslp-e2e-operation-registry@1',
						complete: true,
						expected: [],
					},
					diagnostics: passingGpuDiagnostics(),
					blocking: semanticGatePass ? [] : [ {
						code: 'fixture-semantic-failure',
						message: 'fixture semantic evidence failed',
					} ],
				} );
				const entry = {
					runId,
					name,
					status: 'pass',
					evidenceGate,
					caseConfiguration,
				...evidence,
				artifactMetrics,
			};
			cases.push( entry );
					details.push( {
						name,
						status: 'pass',
						evidenceGate,
						caseConfiguration,
					evidence,
					artifactMetrics,
					userArtifacts: artifactMetrics.userArtifactCount,
					auxArtifacts: artifactMetrics.auxArtifactCount,
				} );
			const catalogueRecord = CATALOGUE.records.find( ( record ) => record.name === name );
			rows.push( {
				id: catalogueRecord.id,
				name,
				sourceKind: catalogueRecord.sourceKind,
					category: categoryOf( name ),
				hasCapture: true,
				hasReplay: true,
				psnr: null,
				identical: true,
				effectiveThreshold: caseConfiguration.effectivePsnrThreshold,
				pixelGateEnabled: caseConfiguration.pixelGateEnabled,
				disabledReason: caseConfiguration.pixelGateDisabledReason,
				verdict: caseConfiguration.pixelGateEnabled ? 'pass' : 'diagnostic',
				note: '',
				runId,
				cohort: id,
				evidenceRoot: relativeRoot,
				capture,
				replay,
				userArtifacts,
				auxArtifacts,
				artifactMetrics,
				_fixtureStem: stem,
			} );

		}
		const manifestBase = {
			schemaVersion: E2E_EVIDENCE_SCHEMA_VERSION,
			runId,
			campaignId: CAMPAIGN_ID,
			canonical: id === 'upstream',
			catalogue: catalogueBinding(),
			corpus,
			threeCheckout,
			slimBundle: SLIM_BUNDLE,
			harness,
			sources,
			configuration,
			cases,
		};
		const report = {
			schemaVersion: E2E_EVIDENCE_SCHEMA_VERSION,
			runId,
			campaignId: CAMPAIGN_ID,
			status: 'completed',
			canonical: id === 'upstream',
			total: details.length,
			pass: details.length,
			fail: 0,
			configuration,
			evidence: {
				catalogue: manifestBase.catalogue,
				corpus,
				threeCheckout,
				slimBundle: SLIM_BUNDLE,
				harness,
				sources,
				configurationFingerprint: configuration.fingerprint,
			},
			details,
		};
		const reportFile = id === 'upstream' ? 'e2e-report.json' : `${ id }-e2e-report.json`;
		const reportBytes = writeJson( join( cohortRoot, reportFile ), report );
		const reportDescriptor = describeEvidenceBytes( {
			outputRoot: cohortRoot,
			file: join( cohortRoot, reportFile ),
			bytes: reportBytes,
			runId,
		} );
		const manifest = { ...manifestBase, report: reportDescriptor };
		const manifestBytes = writeJson( join( cohortRoot, 'evidence-manifest.json' ), manifest );
		const reference = {
			id,
			kind: cohort.kind,
			project: cohort.project,
			runId,
			campaignId: CAMPAIGN_ID,
			canonical: id === 'upstream',
			root: relativeRoot,
			portable: true,
			manifest: {
				file: 'evidence-manifest.json',
				sha256: sha256( manifestBytes ),
			},
			report: reportDescriptor,
			corpus,
			threeCheckout,
			slimBundle: SLIM_BUNDLE,
			harness,
			configuration,
		};
		cohortReferences.push( reference );
		if ( id === 'upstream' ) upstream = { manifest, manifestBytes };

	}
	for ( const row of rows ) delete row._fixtureStem;
	rows.sort( ( left, right ) => left.name.localeCompare( right.name ) );
	const corpus = {
		kind: 'aggregate',
		exact: true,
		caseCount: CATALOGUE.caseCount,
		caseNamesSha256: caseIdsFingerprint( CATALOGUE.records.map( ( record ) => record.name ) ),
		cohortCount: cohortReferences.length,
	};
	const evidenceSet = {
		schemaVersion: E2E_EVIDENCE_SCHEMA_VERSION,
		campaignId: CAMPAIGN_ID,
		canonical: true,
		catalogue: catalogueBinding(),
		corpus,
		cohorts: cohortReferences,
	};
	const evidenceSetPath = join( root, 'coverage-evidence-set.json' );
	const evidenceSetBytes = writeJson( evidenceSetPath, evidenceSet );
	const coverage = {
		schemaVersion: E2E_EVIDENCE_SCHEMA_VERSION,
		runId: upstream.manifest.runId,
		campaignId: CAMPAIGN_ID,
		canonical: true,
		catalogue: catalogueBinding(),
		corpus,
		threeCheckout: upstream.manifest.threeCheckout,
		slimBundle: upstream.manifest.slimBundle,
		harness: upstream.manifest.harness,
		configuration: upstream.manifest.configuration,
		evidenceManifest: {
			file: 'evidence-manifest.json',
			sha256: sha256( upstream.manifestBytes ),
		},
		report: upstream.manifest.report,
		evidenceSet: {
			file: 'coverage-evidence-set.json',
			sha256: sha256( evidenceSetBytes ),
		},
		totals: {
			rows: CATALOGUE.caseCount,
			evidenceRows: CATALOGUE.caseCount,
			pass: rows.filter( ( row ) => row.verdict === 'pass' ).length,
			diagnostic: rows.filter( ( row ) => row.verdict === 'diagnostic' ).length,
			fail: 0,
		},
		rows,
	};
	const coveragePath = join( root, 'coverage-summary.json' );
	writeJson( coveragePath, coverage );
	return { coveragePath, evidenceSetPath, rows };

}

function rewriteCampaignCohort( root, fixture, id, mutate ) {

	const evidenceSet = JSON.parse( readFileSync( fixture.evidenceSetPath, 'utf8' ) );
	const coverage = JSON.parse( readFileSync( fixture.coveragePath, 'utf8' ) );
	const reference = evidenceSet.cohorts.find( ( cohort ) => cohort.id === id );
	const cohortRoot = resolve( root, reference.root );
	const manifestPath = join( cohortRoot, reference.manifest.file );
	const manifest = JSON.parse( readFileSync( manifestPath, 'utf8' ) );
	const reportPath = join( cohortRoot, manifest.report.file );
	const report = JSON.parse( readFileSync( reportPath, 'utf8' ) );
	mutate( { cohortRoot, report, manifest } );
	delete report.configuration.fingerprint;
	report.configuration.fingerprint = fingerprintJson( report.configuration );
	report.evidence.configurationFingerprint = report.configuration.fingerprint;
	manifest.configuration = structuredClone( report.configuration );
	const reportBytes = writeJson( reportPath, report );
	const reportDescriptor = describeEvidenceBytes( {
		outputRoot: cohortRoot,
		file: reportPath,
		bytes: reportBytes,
		runId: report.runId,
	} );
	manifest.report = reportDescriptor;
	const manifestBytes = writeJson( manifestPath, manifest );
	reference.report = reportDescriptor;
	reference.configuration = manifest.configuration;
	reference.threeCheckout = manifest.threeCheckout;
	reference.manifest.sha256 = sha256( manifestBytes );
	const evidenceSetBytes = writeJson( fixture.evidenceSetPath, evidenceSet );
	coverage.evidenceSet.sha256 = sha256( evidenceSetBytes );
	if ( id === 'upstream' ) {

		coverage.configuration = manifest.configuration;
		coverage.report = reportDescriptor;
		coverage.evidenceManifest.sha256 = sha256( manifestBytes );

	}
	writeJson( fixture.coveragePath, coverage );

}

test( 'accepts one exact portable schema-2 campaign', ( t ) => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-site-evidence-valid-' ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	createCampaignFixture( root );
	const loaded = loadCanonicalExamplesEvidence( { resultsRoot: root, cataloguePath: CATALOGUE_PATH } );
	assert.equal( loaded.caseByName.size, 254 );
	assert.equal( loaded.cohortById.size, 7 );
	assert.equal( loaded.rowsByName.size, 254 );

} );

test( 'site publication rejects stale local source bytes even when snapshot hashes are rebound', ( t ) => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-site-stale-local-' ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	const fixture = createCampaignFixture( root );
	rewriteCampaignCohort( root, fixture, 'shadow-debug', ( { report, manifest } ) => {

		for ( const sources of [ report.evidence.sources, manifest.sources ] ) {

			sources.local.files[ 0 ].sha256 = '0'.repeat( 64 );
			sources.local.sha256 = fingerprintJson( sources.local.files );

		}

	} );
	assert.throws(
		() => loadCanonicalExamplesEvidence( { resultsRoot: root, cataloguePath: CATALOGUE_PATH } ),
		/local source .* is stale/,
	);

} );

test( 'site publication re-derives current thresholds and diagnostic exemptions', async ( t ) => {

	for ( const mutation of [
		{
			label: 'lowered threshold',
			pattern: /effectivePsnrThreshold drifted from the current coverage policy/,
			apply( policy ) {

				policy.effectivePsnrThreshold = 1;

			},
		},
		{
			label: 'added diagnostic exemption',
			pattern: /pixelGateEnabled drifted from the current coverage policy/,
			apply( policy ) {

				policy.pixelGateEnabled = false;
				policy.pixelGateDisabledReason = 'diagnostic';

			},
		},
	] ) {

		await t.test( mutation.label, ( subtest ) => {

			const root = mkdtempSync( join( tmpdir(), 'tslp-site-policy-drift-' ) );
			subtest.after( () => rmSync( root, { recursive: true, force: true } ) );
			const fixture = createCampaignFixture( root );
			rewriteCampaignCohort( root, fixture, 'upstream', ( { report, manifest } ) => {

				const name = 'webgpu_clearcoat.html';
				const policy = { ...report.configuration.casePolicies[ name ] };
				mutation.apply( policy );
				report.configuration.casePolicies[ name ] = policy;
				report.details.find( ( value ) => value.name === name ).caseConfiguration = policy;
				manifest.cases.find( ( value ) => value.name === name ).caseConfiguration = policy;

			} );
			assert.throws(
				() => loadCanonicalExamplesEvidence( { resultsRoot: root, cataloguePath: CATALOGUE_PATH } ),
				mutation.pattern,
			);

		} );

	}

} );

test( 'site publication re-runs the current whole-run canonical predicate', ( t ) => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-site-run-policy-drift-' ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	const fixture = createCampaignFixture( root );
	rewriteCampaignCohort( root, fixture, 'upstream', ( { report } ) => {

		report.configuration.pixelGateEnabled = false;

	} );
	assert.throws(
		() => loadCanonicalExamplesEvidence( { resultsRoot: root, cataloguePath: CATALOGUE_PATH } ),
		/configuration drifted from the current canonical policy: pixelGateEnabled=false/,
	);

} );

test( 'site publication requires official source verification for every local cohort', async ( t ) => {

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

			const root = mkdtempSync( join( tmpdir(), 'tslp-site-local-source-verification-' ) );
			subtest.after( () => rmSync( root, { recursive: true, force: true } ) );
			const fixture = createCampaignFixture( root );
			rewriteCampaignCohort( root, fixture, 'shadow-debug', ( { report, manifest } ) => {

				mutation.apply( report.evidence.threeCheckout, report.evidence.sources );
				manifest.threeCheckout = structuredClone( report.evidence.threeCheckout );
				manifest.sources = structuredClone( report.evidence.sources );

			} );
			assert.throws(
				() => loadCanonicalExamplesEvidence( { resultsRoot: root, cataloguePath: CATALOGUE_PATH } ),
				/evidence cohort "shadow-debug" did not verify served sources against the official Three r185 Git tree/,
			);

		} );

	}

} );

test( 'site publication decodes artifact evidence and recomputes its metrics', async ( t ) => {

	for ( const mutation of [
		{
			label: 'corrupt gzip',
			pattern: /failed bounded gzip decompression/,
			apply( { cohortRoot, detail, entry } ) {

				const file = join( cohortRoot, 'evidence', detail.evidence.runId, 'artifacts', 'corrupt.user.json.gz' );
				const bytes = Buffer.from( 'hash-valid but not gzip' );
				writeFileSync( file, bytes );
				const descriptor = {
					...describeEvidenceBytes( {
						outputRoot: cohortRoot,
						file,
						bytes,
						runId: detail.evidence.runId,
					} ),
					contentEncoding: 'gzip',
					uncompressedBytes: 2,
				};
				detail.evidence.userArtifacts = descriptor;
				entry.userArtifacts = descriptor;
				detail.artifactMetrics.evidence.userArtifacts = {
					file: descriptor.file,
					bytes: descriptor.bytes,
					sha256: descriptor.sha256,
				};
				entry.artifactMetrics = detail.artifactMetrics;

			},
		},
		{
			label: 'fabricated metrics',
			pattern: /decoded artifact metrics drifted/,
			apply( { detail, entry } ) {

				detail.artifactMetrics.artifactCount = 1;
				entry.artifactMetrics = detail.artifactMetrics;

			},
		},
	] ) {

		await t.test( mutation.label, ( subtest ) => {

			const root = mkdtempSync( join( tmpdir(), 'tslp-site-artifact-drift-' ) );
			subtest.after( () => rmSync( root, { recursive: true, force: true } ) );
			const fixture = createCampaignFixture( root );
			rewriteCampaignCohort( root, fixture, 'upstream', ( context ) => {

				const name = 'webgpu_clearcoat.html';
				const detail = context.report.details.find( ( value ) => value.name === name );
				const entry = context.manifest.cases.find( ( value ) => value.name === name );
				mutation.apply( { ...context, detail, entry } );

			} );
			assert.throws(
				() => loadCanonicalExamplesEvidence( { resultsRoot: root, cataloguePath: CATALOGUE_PATH } ),
				mutation.pattern,
			);

		} );

	}

} );

test( 'semantic evidence failures cannot be presented as canonical passes', ( t ) => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-site-evidence-semantic-fail-' ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	createCampaignFixture( root, { semanticGatePass: false } );
	assert.throws(
		() => loadCanonicalExamplesEvidence( { resultsRoot: root, cataloguePath: CATALOGUE_PATH } ),
		/semantic gate did not pass its semantic evidence gate/,
	);
	const contradictory = passingSemanticGate();
	contradictory.blocking.push( { code: 'contradiction', message: 'contradictory blocker' } );
	assert.throws(
		() => assertPassingSiteEvidenceGate( contradictory, 'Contradictory gate' ),
		/is invalid: pass disagrees with the blocking list/,
	);

} );

test( 'refuses to publish an exact campaign with a failing aggregate row', ( t ) => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-site-evidence-failing-' ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	const fixture = createCampaignFixture( root );
	const coverage = JSON.parse( readFileSync( fixture.coveragePath, 'utf8' ) );
	coverage.totals.pass --;
	coverage.totals.fail ++;
	writeJson( fixture.coveragePath, coverage );
	assert.throws(
		() => loadCanonicalExamplesEvidence( { resultsRoot: root, cataloguePath: CATALOGUE_PATH } ),
		/refuses to publish 1 failing visual-evidence case/,
	);

} );

test( 'current catalogue and slim bundle must be regular repository files', ( t ) => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-site-evidence-current-inputs-' ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	createCampaignFixture( root );
	const externalBundle = join( root, 'external-slim.js' );
	writeFileSync( externalBundle, readFileSync( SLIM_BUNDLE_PATH ) );
	assert.throws(
		() => loadCanonicalExamplesEvidence( {
			resultsRoot: root,
			cataloguePath: CATALOGUE_PATH,
			slimBundlePath: externalBundle,
		} ),
		/escapes its declared root/,
	);
	const repository = join( root, 'repository' );
	const linkedCatalogue = join( repository, 'example-catalogue.json' );
	const copiedCatalogue = join( repository, 'catalogue-copy.json' );
	const linkedBundle = join( repository, 'three.webgpu.slim.js' );
	mkdirSync( repository );
	writeFileSync( copiedCatalogue, readFileSync( CATALOGUE_PATH ) );
	symlinkSync( CATALOGUE_PATH, linkedCatalogue );
	symlinkSync( SLIM_BUNDLE_PATH, linkedBundle );
	assert.throws(
		() => loadCanonicalExamplesEvidence( {
			resultsRoot: root,
			cataloguePath: linkedCatalogue,
			repositoryRoot: repository,
			slimBundlePath: copiedCatalogue,
		} ),
		/symbolic link/,
	);
	assert.throws(
		() => loadCanonicalExamplesEvidence( {
			resultsRoot: root,
			cataloguePath: copiedCatalogue,
			repositoryRoot: repository,
			slimBundlePath: linkedBundle,
		} ),
		/symbolic link/,
	);

} );

test( 'rejects tampered shots, row bindings, cohort roots, and manifest bytes', async ( t ) => {

	const mutations = [
		{
			label: 'shot bytes',
			pattern: /size drifted|hash drifted/,
			mutate( root, fixture ) {

				const row = fixture.rows[ 0 ];
				writeFileSync( resolve( root, row.evidenceRoot, row.capture.file ), 'tampered' );

			},
		},
			{
				label: 'row runId',
				pattern: /identity drifted/,
			mutate( root, fixture ) {

				const coverage = JSON.parse( readFileSync( fixture.coveragePath, 'utf8' ) );
				coverage.rows[ 0 ].runId = 'other-run';
				writeJson( fixture.coveragePath, coverage );

				},
			},
			{
				label: 'row category',
				pattern: /identity drifted/,
				mutate( root, fixture ) {

					const coverage = JSON.parse( readFileSync( fixture.coveragePath, 'utf8' ) );
					coverage.rows[ 0 ].category = 'Fabricated';
					writeJson( fixture.coveragePath, coverage );

				},
			},
			{
				label: 'coverage totals',
				pattern: /Coverage total pass/,
				mutate( root, fixture ) {

					const coverage = JSON.parse( readFileSync( fixture.coveragePath, 'utf8' ) );
					coverage.totals.pass --;
					coverage.totals.diagnostic ++;
					writeJson( fixture.coveragePath, coverage );

				},
			},
		{
			label: 'escaping root',
			pattern: /escapes the aggregate results root/,
			mutate( root, fixture ) {

				const evidenceSet = JSON.parse( readFileSync( fixture.evidenceSetPath, 'utf8' ) );
				evidenceSet.cohorts[ 1 ].root = '../escape';
				const bytes = writeJson( fixture.evidenceSetPath, evidenceSet );
				const coverage = JSON.parse( readFileSync( fixture.coveragePath, 'utf8' ) );
				coverage.evidenceSet.sha256 = sha256( bytes );
				writeJson( fixture.coveragePath, coverage );

			},
		},
		{
			label: 'symlinked cohort root',
			pattern: /symbolic link/,
			mutate( root, fixture, subtest ) {

				const evidenceSet = JSON.parse( readFileSync( fixture.evidenceSetPath, 'utf8' ) );
				const cohort = evidenceSet.cohorts.find( ( entry ) => entry.root !== '.' );
				const cohortRoot = resolve( root, cohort.root );
				const outside = `${ root }-outside-cohort`;
				renameSync( cohortRoot, outside );
				symlinkSync( outside, cohortRoot, 'dir' );
				subtest.after( () => rmSync( outside, { recursive: true, force: true } ) );

			},
		},
		{
			label: 'manifest bytes',
			pattern: /manifest hash drifted/,
			mutate( root ) {

				const manifestPath = join( root, 'evidence-manifest.json' );
				const manifest = JSON.parse( readFileSync( manifestPath, 'utf8' ) );
				manifest.harness.sourceFingerprint = 'f'.repeat( 64 );
				writeJson( manifestPath, manifest );

			},
		},
		{
			label: 'current slim bundle',
			pattern: /current checked slim bundle/,
			mutate( root, fixture ) {

				const coverage = JSON.parse( readFileSync( fixture.coveragePath, 'utf8' ) );
				coverage.slimBundle.sha256 = 'f'.repeat( 64 );
				writeJson( fixture.coveragePath, coverage );

			},
		},
		{
			label: 'current harness source',
			pattern: /repository source .* is stale/,
			mutate( root, fixture ) {

				const manifestPath = join( root, 'evidence-manifest.json' );
				const manifest = JSON.parse( readFileSync( manifestPath, 'utf8' ) );
				manifest.sources.repository.files[ 0 ].sha256 = 'f'.repeat( 64 );
				manifest.sources.repository.sha256 = fingerprintJson( manifest.sources.repository.files );
				manifest.harness.sourceFingerprint = manifest.sources.repository.sha256;
				const manifestBytes = writeJson( manifestPath, manifest );
				const evidenceSet = JSON.parse( readFileSync( fixture.evidenceSetPath, 'utf8' ) );
				const upstream = evidenceSet.cohorts.find( ( cohort ) => cohort.id === 'upstream' );
				upstream.manifest.sha256 = sha256( manifestBytes );
				upstream.harness = manifest.harness;
				const evidenceSetBytes = writeJson( fixture.evidenceSetPath, evidenceSet );
				const coverage = JSON.parse( readFileSync( fixture.coveragePath, 'utf8' ) );
				coverage.evidenceSet.sha256 = sha256( evidenceSetBytes );
				coverage.evidenceManifest.sha256 = sha256( manifestBytes );
				coverage.harness = manifest.harness;
				writeJson( fixture.coveragePath, coverage );

			},
		},
		{
			label: 'recursive harness dependency',
			pattern: /repository source snapshot omits required inputs: .*late-render-target-textures\.mjs/,
			mutate( root, fixture ) {

				const manifestPath = join( root, 'evidence-manifest.json' );
				const manifest = JSON.parse( readFileSync( manifestPath, 'utf8' ) );
				manifest.sources.repository.files = manifest.sources.repository.files.filter(
					( record ) => record.path !== 'packages/examples/batch/late-render-target-textures.mjs',
				);
				manifest.sources.repository.fileCount = manifest.sources.repository.files.length;
				manifest.sources.repository.sha256 = fingerprintJson( manifest.sources.repository.files );
				manifest.harness.sourceFingerprint = manifest.sources.repository.sha256;
				manifest.harness.sourceFileCount = manifest.sources.repository.fileCount;
				const manifestBytes = writeJson( manifestPath, manifest );
				const evidenceSet = JSON.parse( readFileSync( fixture.evidenceSetPath, 'utf8' ) );
				const upstream = evidenceSet.cohorts.find( ( cohort ) => cohort.id === 'upstream' );
				upstream.manifest.sha256 = sha256( manifestBytes );
				upstream.harness = manifest.harness;
				const evidenceSetBytes = writeJson( fixture.evidenceSetPath, evidenceSet );
				const coverage = JSON.parse( readFileSync( fixture.coveragePath, 'utf8' ) );
				coverage.evidenceSet.sha256 = sha256( evidenceSetBytes );
				coverage.evidenceManifest.sha256 = sha256( manifestBytes );
				coverage.harness = manifest.harness;
				writeJson( fixture.coveragePath, coverage );

			},
		},
	];
	for ( const mutation of mutations ) {

		await t.test( mutation.label, ( subtest ) => {

			const root = mkdtempSync( join( tmpdir(), 'tslp-site-evidence-bad-' ) );
			subtest.after( () => rmSync( root, { recursive: true, force: true } ) );
			const fixture = createCampaignFixture( root );
			mutation.mutate( root, fixture, subtest );
			assert.throws(
				() => loadCanonicalExamplesEvidence( { resultsRoot: root, cataloguePath: CATALOGUE_PATH } ),
				mutation.pattern,
			);

		} );

	}

} );

test( 'public file hashes reject tampering and path escape', ( t ) => {

	const scratch = mkdtempSync( join( tmpdir(), 'tslp-site-public-hash-' ) );
	t.after( () => rmSync( scratch, { recursive: true, force: true } ) );
	const root = join( scratch, 'public' );
	const outside = join( scratch, 'outside' );
	const bytes = Buffer.from( 'bound public bytes' );
	mkdirSync( root );
	mkdirSync( outside );
	writeFileSync( join( root, 'thumb.webp' ), bytes );
	assert.equal(
		verifyPublicFileHash( root, 'thumb.webp', sha256( bytes ), 'fixture thumbnail' ),
		join( root, 'thumb.webp' ),
	);
	assert.throws(
		() => verifyPublicFileHash( root, 'thumb.webp', 'f'.repeat( 64 ), 'fixture thumbnail' ),
		/hash drifted/,
	);
	assert.throws(
		() => verifyPublicFileHash( root, '../outside.webp', sha256( bytes ), 'fixture thumbnail' ),
		/escapes its public root/,
	);
	writeFileSync( join( outside, 'escaped.webp' ), bytes );
	symlinkSync( outside, join( root, 'thumbs' ), 'dir' );
	assert.throws(
		() => verifyPublicFileHash( root, 'thumbs/escaped.webp', sha256( bytes ), 'fixture thumbnail' ),
		/symbolic link/,
	);

} );

test( 'published raw evidence stays campaign- and digest-bound to examples.json', ( t ) => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-site-published-evidence-' ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	const manifest = {
		schemaVersion: E2E_EVIDENCE_SCHEMA_VERSION,
		canonical: true,
		campaignId: CAMPAIGN_ID,
	};
	const manifestBytes = writeJson( join( root, 'coverage-evidence-set.json' ), manifest );
	const summary = {
		schemaVersion: E2E_EVIDENCE_SCHEMA_VERSION,
		canonical: true,
		campaignId: CAMPAIGN_ID,
		evidenceSet: {
			file: 'coverage-evidence-set.json',
			sha256: sha256( manifestBytes ),
		},
		totals: { pass: 253, diagnostic: 1, fail: 0 },
	};
	const summaryBytes = writeJson( join( root, 'coverage-summary.json' ), summary );
	const evidence = {
		coverageVerdicts: { pass: 253, diagnostic: 1, fail: 0 },
		provenance: {
			campaignId: CAMPAIGN_ID,
			coverageSha256: sha256( summaryBytes ),
			evidenceSetSha256: sha256( manifestBytes ),
			publishedEvidence: {
				summary: {
					file: 'coverage-summary.json',
					sha256: sha256( summaryBytes ),
					campaignId: CAMPAIGN_ID,
				},
				manifest: {
					file: 'coverage-evidence-set.json',
					sha256: sha256( manifestBytes ),
					campaignId: CAMPAIGN_ID,
				},
			},
		},
	};
	const verified = verifyPublishedSiteEvidence( evidence, root );
	assert.equal( verified.summary.campaignId, CAMPAIGN_ID );
	assert.equal( verified.manifest.campaignId, CAMPAIGN_ID );

	const drifted = structuredClone( evidence );
	drifted.provenance.publishedEvidence.manifest.campaignId = 'other-campaign';
	assert.throws(
		() => verifyPublishedSiteEvidence( drifted, root ),
		/campaign ID drifted/,
	);
	writeJson( join( root, 'coverage-evidence-set.json' ), { ...manifest, campaignId: 'tampered' } );
	assert.throws(
		() => verifyPublishedSiteEvidence( evidence, root ),
		/file hash drifted/,
	);

} );

test( 'site evidence roots support isolated campaigns without weakening precedence', () => {

	assert.equal(
		resolveCanonicalExamplesEvidenceRoot( {
			repositoryRoot: REPO_ROOT,
			args: [],
			env: {},
		} ),
		resolve( REPO_ROOT, 'packages/examples/batch/results' ),
	);
	assert.equal(
		resolveCanonicalExamplesEvidenceRoot( {
			repositoryRoot: REPO_ROOT,
			args: [],
			env: { TSLP_E2E_OUT: '/private/tmp/from-env' },
		} ),
		'/private/tmp/from-env',
	);
	assert.equal(
		resolveCanonicalExamplesEvidenceRoot( {
			repositoryRoot: REPO_ROOT,
			args: [ '--evidence-root=/private/tmp/from-cli' ],
			env: { TSLP_E2E_OUT: '/private/tmp/from-env' },
		} ),
		'/private/tmp/from-cli',
	);
	assert.throws(
		() => resolveCanonicalExamplesEvidenceRoot( {
			repositoryRoot: REPO_ROOT,
			args: [ '--evidence-root', '/private/tmp/one', '--evidence-root=/private/tmp/two' ],
			env: {},
		} ),
		/only once/,
	);
	assert.throws(
		() => resolveCanonicalSitePublicRoot( {
			siteRoot: resolve( REPO_ROOT, 'packages/site' ),
			args: [ '--public-rooot=/private/tmp/typo' ],
			env: {},
		} ),
		/Unknown site evidence selector/,
	);
	assert.throws(
		() => assertKnownSiteSelectorArguments( [ '--unrelated' ] ),
		/Unknown site evidence selector/,
	);
	assert.throws(
		() => assertKnownSiteSelectorArguments( [ '--public-root' ] ),
		/--public-root requires a non-empty path value/,
	);
	assert.throws(
		() => assertKnownSiteSelectorArguments( [
			'--public-root',
			'--stock-report=/private/tmp/report.json',
		] ),
		/--public-root requires a non-empty path value/,
	);

} );

test( 'stock report selection and descriptors are exact and portable', () => {

	const defaultReport = resolve( REPO_ROOT, 'packages/examples/batch/results/report.json' );
	assert.equal(
		resolveCanonicalStockReport( { repositoryRoot: REPO_ROOT, args: [], env: {} } ),
		defaultReport,
	);
	assert.equal(
		resolveCanonicalStockReport( {
			repositoryRoot: REPO_ROOT,
			args: [],
			env: { TSLP_STOCK_REPORT: '/private/tmp/env-report.json' },
		} ),
		'/private/tmp/env-report.json',
	);
	assert.equal(
		resolveCanonicalStockReport( {
			repositoryRoot: REPO_ROOT,
			args: [ '--stock-report=/private/tmp/cli-report.json' ],
			env: { TSLP_STOCK_REPORT: '/private/tmp/env-report.json' },
		} ),
		'/private/tmp/cli-report.json',
	);
	assert.throws(
		() => resolveCanonicalStockReport( {
			repositoryRoot: REPO_ROOT,
			args: [ '--stock-report=' ],
			env: {},
		} ),
		/non-empty/,
	);
	assert.throws(
		() => resolveCanonicalStockReport( {
			repositoryRoot: REPO_ROOT,
			args: [ '--stock-report=/private/tmp/one.json', '--stock-report=/private/tmp/two.json' ],
			env: {},
		} ),
		/only once/,
	);
	assert.throws(
		() => resolveCanonicalStockReport( {
			repositoryRoot: REPO_ROOT,
			args: [ '--stock-report=/private/tmp/not-json.txt' ],
			env: {},
		} ),
		/end in \.json/,
	);
	const bytes = Buffer.from( '{"complete":true}' );
	assert.deepEqual(
		describeCanonicalStockReport( '/private/tmp/canonical-stock.json', bytes, { runId: 'stock-run' } ),
		{
			file: 'canonical-stock.json',
			bytes: bytes.length,
			sha256: sha256( bytes ),
			runId: 'stock-run',
		},
	);

} );

test( 'site public output stays default or outside the repository', ( t ) => {

	const defaultRoot = resolve( REPO_ROOT, 'packages/site/public' );
	assert.equal(
		resolveCanonicalSitePublicRoot( {
			siteRoot: resolve( REPO_ROOT, 'packages/site' ),
			args: [],
			env: {},
		} ),
		defaultRoot,
	);
	assert.equal(
		resolveCanonicalSitePublicRoot( {
			siteRoot: resolve( REPO_ROOT, 'packages/site' ),
			args: [],
			env: { TSLP_SITE_PUBLIC_OUT: '/private/tmp/site-public-env' },
		} ),
		'/private/tmp/site-public-env',
	);
	assert.equal(
		resolveCanonicalSitePublicRoot( {
			siteRoot: resolve( REPO_ROOT, 'packages/site' ),
			args: [ '--public-root=/private/tmp/site-public-cli' ],
			env: { TSLP_SITE_PUBLIC_OUT: '/private/tmp/site-public-env' },
		} ),
		'/private/tmp/site-public-cli',
	);
	assert.throws(
		() => resolveCanonicalSitePublicRoot( {
			siteRoot: resolve( REPO_ROOT, 'packages/site' ),
			args: [ '--public-root=' ],
			env: {},
		} ),
		/non-empty/,
	);
	assert.throws(
		() => resolveCanonicalSitePublicRoot( {
			siteRoot: resolve( REPO_ROOT, 'packages/site' ),
			args: [ '--public-root=/private/tmp/one', '--public-root=/private/tmp/two' ],
			env: {},
		} ),
		/only once/,
	);
	assert.throws(
		() => resolveCanonicalSitePublicRoot( {
			siteRoot: resolve( REPO_ROOT, 'packages/site' ),
			args: [ `--public-root=${ resolve( REPO_ROOT, 'scratch-public' ) }` ],
			env: {},
		} ),
		/outside the repository/,
	);
	assert.throws(
		() => resolveCanonicalSitePublicRoot( {
			siteRoot: resolve( REPO_ROOT, 'packages/site' ),
			args: [ '--public-root=/' ],
			env: {},
		} ),
		/filesystem root/,
	);
	const scratch = mkdtempSync( join( tmpdir(), 'tslp-site-public-root-' ) );
	t.after( () => rmSync( scratch, { recursive: true, force: true } ) );
	const missingExternalRoot = join( scratch, 'missing', 'public' );
	assert.equal(
		resolveCanonicalSitePublicRoot( {
			siteRoot: resolve( REPO_ROOT, 'packages/site' ),
			args: [ `--public-root=${ missingExternalRoot }` ],
			env: {},
		} ),
		missingExternalRoot,
	);
	const repositoryLink = join( scratch, 'repository-link' );
	symlinkSync( REPO_ROOT, repositoryLink, 'dir' );
	assert.throws(
		() => resolveCanonicalSitePublicRoot( {
			siteRoot: resolve( REPO_ROOT, 'packages/site' ),
			args: [ `--public-root=${ join( repositoryLink, 'missing-public-output' ) }` ],
			env: {},
		} ),
		/outside the repository/,
	);

} );

test( 'site HTML evidence fallbacks are derived without editing source files', () => {

	const totals = Object.fromEntries( SITE_EVIDENCE_TOTAL_KEYS.map( ( key, index ) => [ key, index + 10 ] ) );
	const html = [
		'<span data-stat="examplesProcessed">legacy</span>',
		'<dt data-stat="materialsBaked">legacy</dt>',
		'<span data-bench-stat="examplesProcessed">legacy</span>',
		'<span data-evidence-verdict="pass">legacy</span>',
		'<span data-evidence-verdict="diagnostic">legacy</span>',
		'<span data-evidence-verdict="fail">legacy</span>',
		'<span data-other="examplesProcessed">unchanged</span>',
	].join( '' );
	const transformed = applySiteEvidenceTotalsToHtml( html, totals );
	assert.match( transformed, /data-stat="examplesProcessed">10</ );
	assert.match( transformed, /data-stat="materialsBaked">13</ );
	assert.match( transformed, /data-bench-stat="examplesProcessed">10</ );
	assert.match( transformed, /data-other="examplesProcessed">unchanged</ );
	const verdictTransformed = applySiteEvidenceVerdictsToHtml( transformed, {
		pass: 253,
		diagnostic: 1,
		fail: 0,
	} );
	assert.match( verdictTransformed, /data-evidence-verdict="pass">253</ );
	assert.match( verdictTransformed, /data-evidence-verdict="diagnostic">1</ );
	assert.match( verdictTransformed, /data-evidence-verdict="fail">0</ );
	assert.throws(
		() => applySiteEvidenceTotalsToHtml( html, { ...totals, materialsBaked: null } ),
		/materialsBaked must be finite/,
	);

} );

test( 'featured homepage evidence is bound to versioned bytes and its aggregate verdict', ( t ) => {

	const scratch = mkdtempSync( join( tmpdir(), 'tslp-site-featured-evidence-' ) );
	t.after( () => rmSync( scratch, { recursive: true, force: true } ) );
	const capturePath = 'examples/thumbs/generation-1/webgpu_tsl_earth.capture.modal.webp';
	const replayPath = 'examples/thumbs/generation-1/webgpu_tsl_earth.modal.webp';
	const captureBytes = Buffer.from( 'bound Earth capture' );
	const replayBytes = Buffer.from( 'bound Earth replay' );
	for ( const [ path, bytes ] of [
		[ capturePath, captureBytes ],
		[ replayPath, replayBytes ],
	] ) {

		const file = resolve( scratch, path );
		mkdirSync( dirname( file ), { recursive: true } );
		writeFileSync( file, bytes );

	}
	const evidence = {
		schemaVersion: 2,
		coverageVerdicts: { pass: 1, diagnostic: 0, fail: 0 },
		totals: {
			upstreamExamples: 1,
			smokePass: 1,
			smokeFail: 0,
			smokeTotal: 1,
		},
			examples: [ {
				basename: 'webgpu_tsl_earth',
				badge: 'pixel-match',
				hasCapture: true,
				hasReplay: true,
				evidence: {
					gate: passingSemanticGate(),
				},
				thumbCaptureModal: capturePath,
			thumbReplayModal: replayPath,
			evidenceHashes: {
				captureModal: sha256( captureBytes ),
				replayModal: sha256( replayBytes ),
			},
			pixel: {
				identical: false,
				psnr: 34.25,
				threshold: 30,
				verdict: 'pass',
			},
		} ],
	};
	const source = [
		'<figure>',
		'<img data-featured-evidence-image="capture" alt="capture">',
		'<img data-featured-evidence-image="replay" alt="replay">',
		'<figcaption data-featured-evidence-caption>unbound</figcaption>',
		'</figure>',
	].join( '' );
	const transformed = applySiteFeaturedEvidenceToHtml( source, evidence );
	assert.match( transformed, new RegExp( `src="/${ capturePath }"` ) );
	assert.match( transformed, new RegExp( `src="/${ replayPath }"` ) );
	assert.match( transformed, /data-featured-evidence-verdict="pass"/ );
	assert.match( transformed, /Pixel gate passed at 34\.3 dB \(≥ 30 dB\)\./ );

	const built = transformed.replaceAll( 'src="/examples/', 'src="/vite-plugin-tsl-precompile/examples/' );
	const featured = verifyBuiltSiteFeaturedEvidence( built, evidence, scratch );
	assert.equal( featured.id, 'webgpu_tsl_earth' );
	assert.equal( featured.sides.capture.hash, sha256( captureBytes ) );
	assert.throws(
		() => verifyBuiltSiteFeaturedEvidence(
			built.replace(
				`src="/vite-plugin-tsl-precompile/${ capturePath }"`,
				'src="/vite-plugin-tsl-precompile/examples/thumbs/missing.webp"',
			),
			evidence,
			scratch,
		),
		/Built featured capture image URL does not resolve/,
	);
	assert.equal( describeSiteFeaturedEvidence( {
		...evidence,
		examples: [ {
			...evidence.examples[ 0 ],
			pixel: { identical: true, psnr: null, threshold: 30, verdict: 'pass' },
		} ],
	} ).verdictText, 'Pixel-identical.' );
	const diagnostic = {
		...evidence,
		coverageVerdicts: { pass: 0, diagnostic: 1, fail: 0 },
		examples: [ {
			...evidence.examples[ 0 ],
			badge: 'diagnostic',
			pixel: { identical: false, psnr: 36, threshold: 30, verdict: 'diagnostic' },
		} ],
	};
	assert.equal(
		describeSiteFeaturedEvidence( diagnostic ).verdictText,
		'Diagnostic comparison at 36 dB; pixel gate disabled.',
	);
	assert.throws(
		() => assertPublishableSitePublicEvidence( {
			...diagnostic,
			examples: [ { ...diagnostic.examples[ 0 ], badge: 'visual-match' } ],
		} ),
		/must present its diagnostic verdict separately from image quality/,
	);
	assert.throws(
		() => assertPublishableSitePublicEvidence( {
			...evidence,
			totals: { ...evidence.totals, smokeTotal: 2 },
		} ),
		/stock smoke total 2 must equal its 1 official upstream routes/,
	);
	assert.throws(
		() => assertPublishableSitePublicEvidence( {
			...evidence,
			totals: { ...evidence.totals, smokePass: 0 },
		} ),
		/stock smoke passes 0 plus failures 0 must equal all 1 official upstream routes/,
	);

	writeFileSync( resolve( scratch, replayPath ), 'tampered replay' );
	assert.throws(
		() => verifyBuiltSiteFeaturedEvidence( built, evidence, scratch ),
		/Built featured replay image file hash drifted/,
	);
	assert.throws(
		() => applySiteFeaturedEvidenceToHtml(
			'<img data-featured-evidence-image="capture"><figcaption data-featured-evidence-caption></figcaption>',
			evidence,
		),
		/Featured replay image must appear exactly once/,
	);

	const failing = {
		...evidence,
		coverageVerdicts: { pass: 0, diagnostic: 0, fail: 1 },
		examples: [ {
			...evidence.examples[ 0 ],
			pixel: { identical: false, psnr: 12, threshold: 30, verdict: 'fail' },
		} ],
	};
	assert.throws(
		() => assertPublishableSitePublicEvidence( failing ),
		/refuses to publish 1 failing visual-evidence case/,
	);

} );
