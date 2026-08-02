#!/usr/bin/env node
/**
 * Build the public visual-coverage snapshot from one upstream manifest plus
 * exact local cohort manifests. This intentionally never scans a shared
 * screenshot directory or merges loose reports: every byte belongs to one
 * runId, every run belongs to one campaignId, and every cohort is an exact,
 * non-overlapping catalogue partition.
 */

import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	E2E_COVERAGE_JSON,
	E2E_EVIDENCE_MANIFEST,
	E2E_EVIDENCE_SCHEMA_VERSION,
	E2E_EVIDENCE_SET_JSON,
	assertCurrentEvidenceSourceSnapshot,
	assertUniqueExactNames,
	caseIdsFingerprint,
	classifyEvidenceRun,
	fingerprintJson,
	readEvidenceCatalogue,
	readSafeContainedFile,
	resolveE2EHarnessSourceFiles,
	sha256,
	verifyEvidenceDescriptor,
} from './e2e-evidence.mjs';
import { assertCurrentLocalCohortSources } from './e2e-local-source-contract.mjs';
import { inspectE2EEvidenceGate } from './e2e-evidence-gate.mjs';
import {
	assertArtifactEvidenceDescriptor,
	decodeArtifactEvidenceJson,
} from './e2e-artifact-output.mjs';
import { assertEvidenceEnvironment } from './e2e-environment.mjs';
import { resolveE2EOutputRoot } from './e2e-report-diagnostics.mjs';
import {
	comparePngBuffers,
	pixelGateDisabledReasonForExample,
	psnrThresholdForExample,
} from './psnr.mjs';
import {
	assertE2EArtifactMetricsBinding,
	bindE2EArtifactMetrics,
	computeE2EArtifactMetrics,
} from './e2e-artifact-metrics.mjs';
import {
	assertOfficialThreeR185SourceVerification,
	THREE_R185_OFFICIAL_COMMIT,
} from './_three-version.mjs';
import {
	prepareOutputRoot,
	writeOutputFileAtomic,
} from './output-path-safety.mjs';

const SELF = dirname( fileURLToPath( import.meta.url ) );
const REPO = resolve( SELF, '../../..' );
const args = process.argv.slice( 2 );
const RESULTS = resolveE2EOutputRoot( { selfDir: SELF, args } );
const MANIFEST_PATH = join( RESULTS, E2E_EVIDENCE_MANIFEST );
const CATALOGUE_PATH = join( SELF, 'example-catalogue.json' );
const DEFAULT_SLIM_BUNDLE = resolve( REPO, 'packages/runtime/build/three.webgpu.slim.js' );

const CANONICAL_CONFIGURATION_DEFAULTS = Object.freeze( {
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
} );

function getArg( prefix ) {

	const argument = args.find( ( value ) => value.startsWith( prefix ) );
	return argument ? argument.slice( prefix.length ) : '';

}

function campaignConfiguration( configuration ) {

	const value = { ...configuration };
	delete value.casePolicies;
	delete value.fingerprint;
	return value;

}

function assertCurrentCanonicalRunPolicy( bundle ) {

	const configuration = bundle.report.configuration || {};
	const drifted = Object.entries( CANONICAL_CONFIGURATION_DEFAULTS )
		.filter( ( [ key, expected ] ) => configuration[ key ] !== expected )
		.map( ( [ key, expected ] ) => `${ key }=${ JSON.stringify( configuration[ key ] ) } (expected ${ JSON.stringify( expected ) })` );
	if ( drifted.length > 0 ) {

		throw new Error( `Canonical upstream evidence configuration drifted from the current default policy: ${ drifted.join( ', ' ) }.` );

	}
	const classification = classifyEvidenceRun( {
		canonicalRoot: bundle.root,
		outputRoot: bundle.root,
		catalogueUpstreamCaseNames: catalogue.upstreamCaseNames,
		candidates: bundle.corpusNames,
		localExamplesRoot: null,
		tier: configuration.tier || '',
		filter: configuration.filter || '',
		hasExplicitOffset: configuration.offset !== 0,
		hasExplicitLimit: configuration.limit !== 9999,
		hasExplicitPsnrThreshold: configuration.psnrThreshold !== 30,
		pixelGateEnabled: configuration.pixelGateEnabled === true,
		saveShots: configuration.saveShots === true,
		replayOnly: configuration.replayOnly === true,
		reuseReferenceShot: configuration.reuseReferenceShot === true,
		defaultSlimBundle: DEFAULT_SLIM_BUNDLE,
		slimBundle: bundle.manifest.slimBundle?.absolutePath || '',
		reportFile: bundle.manifest.report?.file || '',
		hasEvidenceAffectingOverrides: drifted.length > 0,
		canonicalEvidenceRequested: true,
	} );
	if (
		classification.canonical !== true ||
		classification.exactCorpus !== true ||
		classification.freshDefaultConfiguration !== true
	) {

		throw new Error( 'Canonical upstream evidence does not satisfy the current canonical run policy.' );

	}
	assertOfficialThreeR185SourceVerification(
		bundle.manifest.threeCheckout?.sourceVerification,
		{
			sourceSnapshot: bundle.manifest.sources?.three,
			sourceFingerprint: bundle.manifest.threeCheckout?.sourceFingerprint,
			label: 'Canonical upstream evidence',
		},
	);

}

function assertCurrentCasePixelPolicy( name, caseConfiguration, defaultThreshold, label ) {

	const expected = {
		effectivePsnrThreshold: psnrThresholdForExample( name, defaultThreshold ),
		pixelGateEnabled: ! pixelGateDisabledReasonForExample( name ),
		pixelGateDisabledReason: pixelGateDisabledReasonForExample( name ),
	};
	for ( const [ key, value ] of Object.entries( expected ) ) {

		if ( caseConfiguration?.[ key ] !== value ) {

			throw new Error(
				`${ label } ${ name} ${ key } drifted from the current coverage policy: ` +
				`${ JSON.stringify( caseConfiguration?.[ key ] ) } != ${ JSON.stringify( value ) }.`,
			);

		}

	}

}

function assertDecodedArtifactMetrics( {
	root,
	runId,
	userArtifacts,
	auxArtifacts,
	metrics,
	label,
} ) {

	const userBytes = verifyEvidenceDescriptor( root, userArtifacts, runId ).bytes;
	const auxBytes = verifyEvidenceDescriptor( root, auxArtifacts, runId ).bytes;
	const user = decodeArtifactEvidenceJson( userArtifacts, userBytes, { label: `${ label } user artifacts` } );
	const aux = decodeArtifactEvidenceJson( auxArtifacts, auxBytes, { label: `${ label } auxiliary artifacts` } );
	if ( ! user || typeof user !== 'object' || Array.isArray( user ) ) {

		throw new Error( `${ label } user artifact evidence must decode to an object.` );

	}
	if ( ! Array.isArray( aux ) ) {

		throw new Error( `${ label } auxiliary artifact evidence must decode to an array.` );

	}
	const recomputed = bindE2EArtifactMetrics(
		computeE2EArtifactMetrics( { user, aux } ),
		{ runId, userArtifacts, auxArtifacts },
	);
	if ( fingerprintJson( recomputed ) !== fingerprintJson( metrics ) ) {

		throw new Error( `${ label } artifact metrics do not match the decoded artifact evidence.` );

	}

}

function assertSha256( value, label ) {

	if ( typeof value !== 'string' || ! /^[a-f0-9]{64}$/.test( value ) ) {

		throw new Error( `${ label } must be a lowercase SHA-256 digest.` );

	}

}

function assertCurrentRepositorySources( snapshot, harness, label ) {

	const requiredHarnessPaths = new Set( resolveE2EHarnessSourceFiles( REPO ).map( ( file ) => (
		relative( REPO, file ).replaceAll( sep, '/' )
	) ) );
	assertCurrentEvidenceSourceSnapshot( snapshot, {
		domain: 'repository',
		root: REPO,
		label,
		requiredPaths: [ ...requiredHarnessPaths ],
	} );
	if (
		harness?.sourceFingerprint !== snapshot.sha256 ||
		harness?.sourceFileCount !== snapshot.fileCount
	) {

		throw new Error( `${ label } harness identity is not bound to its repository source snapshot.` );

	}

}

function assertCurrentSlimBundle( provenance, label ) {

	if ( ! provenance || typeof provenance.absolutePath !== 'string' || ! isAbsolute( provenance.absolutePath ) ) {

		throw new Error( `${ label } has no absolute slim-bundle path.` );

	}
	assertSha256( provenance.sha256, `${ label } slim-bundle sha256` );
	const bundlePath = resolve( provenance.absolutePath );
	const bytes = readSafeContainedFile( dirname( bundlePath ), bundlePath, {
		label: `${ label } slim bundle`,
	} );
	if ( sha256( bytes ) !== provenance.sha256 ) {

		throw new Error( `${ label } slim bundle is stale.` );

	}

}

if ( args.some( ( value ) => value.startsWith( '--threshold=' ) ) ) {

	throw new Error( 'Coverage thresholds are evidence configuration, not a summary-time override. Rerun E2E with an isolated output root.' );

}
const catalogue = readEvidenceCatalogue( CATALOGUE_PATH, {
	root: REPO,
	label: 'current example catalogue',
} );
const requestedReport = getArg( '--report=' );

function loadEvidenceBundle( root, manifestPath, { requestedReportPath = '' } = {} ) {

	if ( ! existsSync( manifestPath ) ) {

		throw new Error( `Evidence manifest not found: ${ manifestPath }. Run the complete cohort first.` );

	}
	const manifestBytes = readSafeContainedFile( root, manifestPath, {
		label: `Evidence manifest ${ manifestPath }`,
	} );
	const manifest = JSON.parse( manifestBytes.toString( 'utf8' ) );
	if (
		manifest.schemaVersion !== E2E_EVIDENCE_SCHEMA_VERSION ||
		typeof manifest.runId !== 'string' ||
		typeof manifest.campaignId !== 'string'
	) {

		throw new Error( `${ manifestPath } is not an E2E evidence schema ${ E2E_EVIDENCE_SCHEMA_VERSION } campaign manifest.` );

	}
	if (
		manifest.catalogue?.sha256 !== catalogue.sha256 ||
		manifest.catalogue?.caseIdsSha256 !== catalogue.caseIdsSha256 ||
		manifest.catalogue?.caseCount !== catalogue.caseCount
	) {

		throw new Error( `${ manifestPath } catalogue binding does not match the current example-catalogue.json.` );

	}
	if ( ! manifest.report ) throw new Error( `${ manifestPath } has no report descriptor.` );
	const reportEvidence = verifyEvidenceDescriptor( root, manifest.report, manifest.runId );
	if ( requestedReportPath ) {

		const requestedPath = isAbsolute( requestedReportPath ) ? resolve( requestedReportPath ) : resolve( root, requestedReportPath );
		if ( requestedPath !== reportEvidence.file ) {

			throw new Error( `Requested report ${ requestedPath } is not the manifest-bound report ${ reportEvidence.file }.` );

		}

	}
	const report = JSON.parse( reportEvidence.bytes.toString( 'utf8' ) );
	if (
		report.schemaVersion !== E2E_EVIDENCE_SCHEMA_VERSION ||
		report.runId !== manifest.runId ||
		report.campaignId !== manifest.campaignId ||
		report.status !== 'completed' ||
		report.canonical !== manifest.canonical
	) {

		throw new Error( `${ manifestPath } report is not its completed campaign run.` );

	}
	if (
		report.configuration?.fingerprint !== manifest.configuration?.fingerprint ||
		report.evidence?.configurationFingerprint !== manifest.configuration?.fingerprint
	) {

		throw new Error( `${ manifestPath } configuration fingerprint drifted between report and manifest.` );

	}
	const fingerprintedConfiguration = { ...report.configuration };
	delete fingerprintedConfiguration.fingerprint;
	if ( fingerprintJson( fingerprintedConfiguration ) !== manifest.configuration.fingerprint ) {

		throw new Error( `${ manifestPath } configuration contents do not match their declared fingerprint.` );

	}
	assertEvidenceEnvironment(
		report.configuration?.environment,
		`${ manifestPath } report evidence environment`,
	);
	if (
		fingerprintJson( report.configuration.environment ) !==
		fingerprintJson( manifest.configuration?.environment )
	) {

		throw new Error( `${ manifestPath } evidence environment drifted between report and manifest.` );

	}
	if ( report.evidence?.catalogue?.sha256 !== catalogue.sha256 ) {

		throw new Error( `${ manifestPath } provenance drifted between report and manifest.` );

	}
	for ( const key of [ 'catalogue', 'corpus', 'threeCheckout', 'slimBundle', 'harness', 'sources' ] ) {

		const reportValue = report.evidence?.[ key ];
		if ( fingerprintJson( reportValue ) !== fingerprintJson( manifest[ key ] ) ) {

			throw new Error( `${ manifestPath } ${ key } provenance drifted between report and manifest.` );

		}

	}
	assertCurrentRepositorySources(
		manifest.sources?.repository,
		manifest.harness,
		`Evidence manifest ${ manifestPath }`,
	);
	if ( manifest.corpus?.kind === 'local' ) {

		assertCurrentLocalCohortSources( {
			snapshot: manifest.sources?.local,
			discovery: manifest.corpus.localDiscovery,
			corpus: manifest.corpus,
			catalogue,
			repositoryRoot: REPO,
			label: `Evidence manifest ${ manifestPath }`,
		} );

	} else if ( manifest.corpus?.kind === 'three' ) {

		if ( manifest.sources?.local !== undefined ) {

			throw new Error( `Evidence manifest ${ manifestPath } upstream evidence must not declare local sources.` );

		}

	} else {

		throw new Error( `Evidence manifest ${ manifestPath } has an unknown corpus kind.` );

	}
	assertCurrentSlimBundle( manifest.slimBundle, `Evidence manifest ${ manifestPath }` );
	const details = Array.isArray( report.details ) ? report.details : [];
	const manifestCases = Array.isArray( manifest.cases ) ? manifest.cases : [];
	const corpusNames = Array.isArray( manifest.corpus?.caseNames ) ? manifest.corpus.caseNames : [];
	assertUniqueExactNames( details.map( ( detail ) => detail.name ), corpusNames, `${ manifestPath } report details` );
	assertUniqueExactNames( manifestCases.map( ( entry ) => entry.name ), corpusNames, `${ manifestPath } cases` );
	if ( report.total !== corpusNames.length || report.pass + report.fail !== report.total ) {

		throw new Error( `${ manifestPath } report totals do not describe every cohort case exactly once.` );

	}
	const reportPass = details.filter( ( detail ) => detail?.status === 'pass' ).length;
	const reportFail = details.filter( ( detail ) => detail?.status === 'fail' ).length;
	if (
		reportPass + reportFail !== details.length ||
		report.pass !== reportPass ||
		report.fail !== reportFail
	) {

		throw new Error( `${ manifestPath } report pass/fail totals drifted from its case statuses.` );

	}
	const detailsByName = new Map( details.map( ( detail ) => [ detail.name, detail ] ) );
	const manifestByName = new Map( manifestCases.map( ( entry ) => [ entry.name, entry ] ) );
	const defaultThreshold = report.configuration?.psnrThreshold;
	for ( const name of corpusNames ) {

		const detail = detailsByName.get( name );
		const entry = manifestByName.get( name );
		if (
			entry.runId !== manifest.runId ||
				detail.evidence?.runId !== manifest.runId ||
				entry.status !== detail.status ||
				fingerprintJson( detail.evidenceGate || null ) !== fingerprintJson( entry.evidenceGate || null ) ||
				fingerprintJson( detail.caseConfiguration ) !== fingerprintJson( entry.caseConfiguration ) ||
			fingerprintJson( detail.artifactMetrics || null ) !== fingerprintJson( entry.artifactMetrics || null )
		) {

			throw new Error( `Evidence case binding drifted for ${ name } in ${ manifestPath }.` );

		}
		if ( fingerprintJson( detail.caseConfiguration ) !== fingerprintJson( report.configuration?.casePolicies?.[ name ] ) ) {

			throw new Error( `Evidence case policy ${ name } drifted from the fingerprinted configuration in ${ manifestPath }.` );

		}
		assertCurrentCasePixelPolicy(
			name,
			detail.caseConfiguration,
			defaultThreshold,
			`Evidence case policy in ${ manifestPath }`,
		);
		for ( const key of [ 'capture', 'replay', 'userArtifacts', 'auxArtifacts' ] ) {

			const reportDescriptor = detail.evidence?.[ key ] || null;
			const manifestDescriptor = entry[ key ] || null;
			if ( fingerprintJson( reportDescriptor ) !== fingerprintJson( manifestDescriptor ) ) {

				throw new Error( `Evidence descriptor ${ key } drifted for ${ name } in ${ manifestPath }.` );

			}
			if ( manifestDescriptor ) {

				const verified = verifyEvidenceDescriptor( root, manifestDescriptor, manifest.runId );
				if ( key === 'userArtifacts' || key === 'auxArtifacts' ) {

					assertArtifactEvidenceDescriptor( manifestDescriptor, verified.bytes, {
						label: `Artifact evidence ${ key } for ${ name }`,
					} );

				}

			}

		}
		if ( detail.artifactMetrics ) {

			if ( entry.userArtifacts?.truncated || entry.auxArtifacts?.truncated ) {

				throw new Error( `Artifact metrics for ${ name } are bound to truncated debug dumps in ${ manifestPath }.` );

			}
			assertE2EArtifactMetricsBinding( detail.artifactMetrics, {
				runId: manifest.runId,
				userArtifacts: entry.userArtifacts,
				auxArtifacts: entry.auxArtifacts,
			}, `${ manifestPath } ${ name } artifact metrics` );
			assertDecodedArtifactMetrics( {
				root,
				runId: manifest.runId,
				userArtifacts: entry.userArtifacts,
				auxArtifacts: entry.auxArtifacts,
				metrics: detail.artifactMetrics,
				label: `${ manifestPath } ${ name }`,
			} );
			if (
				detail.userArtifacts !== detail.artifactMetrics.userArtifactCount ||
				detail.auxArtifacts !== detail.artifactMetrics.auxArtifactCount
			) {

				throw new Error( `Artifact root counts for ${ name } drifted from bound metrics in ${ manifestPath }.` );

			}

		}

	}
	return {
		root,
		manifestPath,
		manifestBytes,
		manifestSha256: sha256( manifestBytes ),
		manifest,
		report,
		detailsByName,
		manifestByName,
		corpusNames,
	};

}

const primary = loadEvidenceBundle( RESULTS, MANIFEST_PATH, { requestedReportPath: requestedReport } );
const { manifest, manifestBytes, report } = primary;
if ( manifest.canonical ) {

	assertCurrentCanonicalRunPolicy( primary );
	if (
		manifest.corpus?.kind !== 'three' ||
		manifest.corpus?.exact !== true ||
		manifest.threeCheckout?.packageVersion !== catalogue.threeVersion ||
		manifest.threeCheckout?.git?.head !== THREE_R185_OFFICIAL_COMMIT ||
		manifest.threeCheckout?.git?.clean !== true
	) {

		throw new Error( 'Canonical upstream evidence is not the exact clean official Three r185 corpus.' );

	}
	assertUniqueExactNames( manifest.corpus.caseNames || [], catalogue.upstreamCaseNames, 'canonical upstream evidence corpus' );

}

const localNamesByProject = new Map();
for ( const record of catalogue.records.filter( ( entry ) => entry.sourceKind === 'local' ) ) {

	const project = record.source?.project;
	if ( typeof project !== 'string' || project.length === 0 ) throw new Error( `Local catalogue case ${ record.name } has no project.` );
	if ( ! localNamesByProject.has( project ) ) localNamesByProject.set( project, [] );
	localNamesByProject.get( project ).push( record.name );

}
const providedCohortRoots = args
	.filter( ( value ) => value.startsWith( '--cohort-root=' ) )
	.map( ( value ) => resolve( value.slice( '--cohort-root='.length ) ) );
const cohortRoots = providedCohortRoots.length > 0
	? providedCohortRoots
	: [ ...localNamesByProject.keys() ]
		.map( ( project ) => resolve( RESULTS, 'cohorts', project ) )
		.filter( ( root ) => existsSync( join( root, E2E_EVIDENCE_MANIFEST ) ) );
const cohorts = cohortRoots.map( ( root ) => loadEvidenceBundle( root, join( root, E2E_EVIDENCE_MANIFEST ) ) );
const cohortsByProject = new Map();
for ( const cohort of cohorts ) {

	const project = cohort.manifest.corpus?.project;
	if ( cohort.manifest.corpus?.kind !== 'local' || ! localNamesByProject.has( project ) ) {

		throw new Error( `Unexpected local evidence cohort ${ JSON.stringify( project ) } at ${ cohort.manifestPath }.` );

	}
	if ( cohortsByProject.has( project ) ) throw new Error( `Duplicate local evidence cohort ${ project }.` );
	assertUniqueExactNames( cohort.corpusNames, localNamesByProject.get( project ), `${ project } local cohort` );
	if (
		cohort.manifest.campaignId !== manifest.campaignId ||
		cohort.manifest.catalogue.sha256 !== manifest.catalogue.sha256 ||
		cohort.manifest.slimBundle?.sha256 !== manifest.slimBundle?.sha256 ||
		cohort.manifest.threeCheckout?.packageVersion !== manifest.threeCheckout?.packageVersion ||
		cohort.manifest.threeCheckout?.revision !== '185' ||
		cohort.manifest.threeCheckout?.git?.head !== THREE_R185_OFFICIAL_COMMIT ||
		cohort.manifest.threeCheckout?.git?.clean !== true ||
		fingerprintJson( campaignConfiguration( cohort.report.configuration ) ) !==
			fingerprintJson( campaignConfiguration( report.configuration ) )
	) {

		throw new Error( `Local cohort ${ project } does not belong to campaign ${ manifest.campaignId } or its runtime provenance.` );

	}
	assertOfficialThreeR185SourceVerification(
		cohort.manifest.threeCheckout?.sourceVerification,
		{
			sourceSnapshot: cohort.manifest.sources?.three,
			sourceFingerprint: cohort.manifest.threeCheckout?.sourceFingerprint,
			label: `Local cohort ${ project }`,
		},
	);
	cohortsByProject.set( project, cohort );

}

const bundles = [ primary, ...cohorts ];
const detailsByName = new Map();
const manifestByName = new Map();
const bundleByName = new Map();
for ( const bundle of bundles ) {

	for ( const name of bundle.corpusNames ) {

		if ( detailsByName.has( name ) ) throw new Error( `Evidence cohorts overlap on ${ name }.` );
		detailsByName.set( name, bundle.detailsByName.get( name ) );
		manifestByName.set( name, bundle.manifestByName.get( name ) );
		bundleByName.set( name, bundle );

	}

}
const allCatalogueNames = catalogue.records.map( ( record ) => record.name );
const aggregateExact = detailsByName.size === allCatalogueNames.length &&
	allCatalogueNames.every( ( name ) => detailsByName.has( name ) );
const aggregateCanonical = manifest.canonical && aggregateExact &&
	cohortsByProject.size === localNamesByProject.size;
if ( manifest.canonical && ! aggregateCanonical ) {

	const missingProjects = [ ...localNamesByProject.keys() ].filter( ( project ) => ! cohortsByProject.has( project ) );
	const missingNames = allCatalogueNames.filter( ( name ) => ! detailsByName.has( name ) );
	throw new Error(
		`Canonical coverage requires the exact 254-case campaign. Missing cohorts: ${ missingProjects.join( ', ' ) || 'none' }; ` +
		`missing cases: ${ missingNames.join( ', ' ) || 'none' }.`,
	);

}
if ( aggregateCanonical ) {

	for ( const name of allCatalogueNames ) {

		const detail = detailsByName.get( name );
		const entry = manifestByName.get( name );
		if ( ! entry.capture || ! entry.replay ) {

			throw new Error( `Canonical coverage case ${ name } is missing its capture/replay evidence pair.` );

		}
		if ( ! entry.userArtifacts || ! entry.auxArtifacts || ! detail.artifactMetrics ) {

			throw new Error( `Canonical coverage case ${ name } is missing full artifact evidence or bound metrics.` );

		}

	}

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

function classifyRow( record ) {

	const detail = detailsByName.get( record.name );
	const evidence = manifestByName.get( record.name );
	const bundle = bundleByName.get( record.name );
	const semanticEvidence = inspectE2EEvidenceGate( detail?.evidenceGate );
	const defaultThreshold = bundle?.report.configuration?.psnrThreshold ?? report.configuration?.psnrThreshold ?? 30;
	const effectiveThreshold = evidence?.caseConfiguration?.effectivePsnrThreshold ??
		psnrThresholdForExample( record.name, defaultThreshold );
	const pixelGateEnabled = evidence?.caseConfiguration?.pixelGateEnabled ??
		! pixelGateDisabledReasonForExample( record.name );
	const disabledReason = evidence?.caseConfiguration?.pixelGateDisabledReason ??
		pixelGateDisabledReasonForExample( record.name );
	let psnr = null;
	let comparison = null;
	let verdict = 'fail';
	let note = '';

	if ( ! detail || ! evidence ) {

		note = `not part of evidence campaign ${ manifest.campaignId }`;
		return {
			id: record.id,
			name: record.name,
			sourceKind: record.sourceKind,
			category: categoryOf( record.name ),
			hasCapture: false,
			hasReplay: false,
			psnr,
			identical: false,
			effectiveThreshold,
			pixelGateEnabled,
			disabledReason,
			verdict,
			note,
			semanticEvidence,
		};

	}
	const gate = detail.pixelGate || null;
	if ( gate && gate.threshold !== undefined && gate.threshold !== effectiveThreshold ) {

		throw new Error( `Reported threshold drifted for ${ record.name }: ${ gate.threshold } != ${ effectiveThreshold }.` );

	}
	if ( evidence.capture && evidence.replay ) {

		const capture = verifyEvidenceDescriptor( bundle.root, evidence.capture, bundle.manifest.runId ).bytes;
		const replay = verifyEvidenceDescriptor( bundle.root, evidence.replay, bundle.manifest.runId ).bytes;
		comparison = comparePngBuffers( capture, replay, { name: record.name } );
		if ( ! comparison.error ) psnr = comparison.psnr === 'inf' ? Infinity : comparison.psnr;

	}
	if ( detail.status !== 'pass' ) {

		note = detail.error || gate?.reason || 'E2E case failed';

	} else if ( ! semanticEvidence.valid || ! semanticEvidence.pass ) {

		note = semanticEvidence.note;

	} else if ( disabledReason || ! pixelGateEnabled ) {

		verdict = 'diagnostic';
		note = `pixel gate disabled: ${ disabledReason || 'run configuration' }`;

	} else if ( comparison?.error ) {

		note = comparison.error;

	} else if ( psnr === Infinity || ( typeof psnr === 'number' && psnr >= effectiveThreshold ) ) {

		verdict = 'pass';

	} else if ( typeof psnr === 'number' ) {

		note = `PSNR ${ psnr } dB is below configured ${ effectiveThreshold } dB`;

	} else {

		note = gate?.reason || detail.error || 'fresh capture/replay pair missing';

	}
	if (
		( verdict === 'pass' || verdict === 'diagnostic' ) &&
		semanticEvidence.note
	) {

		note = note ? `${ note }; ${ semanticEvidence.note }` : semanticEvidence.note;

	}
	return {
		id: record.id,
		name: record.name,
		sourceKind: record.sourceKind,
		category: categoryOf( record.name ),
		hasCapture: !! evidence.capture,
		hasReplay: !! evidence.replay,
		psnr,
		identical: psnr === Infinity,
		effectiveThreshold,
		pixelGateEnabled,
		disabledReason,
		verdict,
		note,
		semanticEvidence,
		runId: bundle.manifest.runId,
		cohort: bundle.manifest.corpus.project || 'upstream',
		evidenceRoot: relative( RESULTS, bundle.root ).replaceAll( sep, '/' ) || '.',
		capture: evidence.capture || null,
		replay: evidence.replay || null,
		userArtifacts: evidence.userArtifacts || null,
		auxArtifacts: evidence.auxArtifacts || null,
		artifactMetrics: detail.artifactMetrics || null,
	};

}

const rows = catalogue.records.map( classifyRow ).sort( ( left, right ) => left.name.localeCompare( right.name ) );
const totals = {
	rows: rows.length,
	evidenceRows: rows.filter( ( row ) => detailsByName.has( row.name ) ).length,
	pass: rows.filter( ( row ) => row.verdict === 'pass' ).length,
	diagnostic: rows.filter( ( row ) => row.verdict === 'diagnostic' ).length,
	fail: rows.filter( ( row ) => row.verdict === 'fail' ).length,
	semanticGatePass: rows.filter( ( row ) => detailsByName.has( row.name ) && row.semanticEvidence.valid && row.semanticEvidence.pass ).length,
	semanticGateFail: rows.filter( ( row ) => detailsByName.has( row.name ) && ( ! row.semanticEvidence.valid || ! row.semanticEvidence.pass ) ).length,
	semanticBlocking: rows
		.filter( ( row ) => detailsByName.has( row.name ) )
		.reduce( ( sum, row ) => sum + row.semanticEvidence.blockingCount, 0 ),
	semanticErrors: rows
		.filter( ( row ) => detailsByName.has( row.name ) )
		.reduce( ( sum, row ) => sum + row.semanticEvidence.errorCount, 0 ),
	semanticWarnings: rows
		.filter( ( row ) => detailsByName.has( row.name ) )
		.reduce( ( sum, row ) => sum + row.semanticEvidence.warningCount, 0 ),
	semanticRecoveries: rows
		.filter( ( row ) => detailsByName.has( row.name ) )
		.reduce( ( sum, row ) => sum + row.semanticEvidence.recoveredCount, 0 ),
	semanticOptionalFailures: rows
		.filter( ( row ) => detailsByName.has( row.name ) )
		.reduce( ( sum, row ) => sum + row.semanticEvidence.optionalFailureCount, 0 ),
};
totals.matchPercent = totals.rows === 0 ? 0 : Math.round( ( totals.pass / totals.rows ) * 100 );

function fmtPsnr( psnr ) {

	if ( psnr === null ) return '—';
	if ( psnr === Infinity ) return 'inf';
	return Number( psnr ).toFixed( 2 );

}

function tick( value ) {

	return value ? '✓' : '✗';

}

function verdictTag( verdict ) {

	if ( verdict === 'pass' ) return '✅ matches';
	if ( verdict === 'diagnostic' ) return '⚠ diagnostic';
	return '❌ failure';

}

const coverage = {
	schemaVersion: E2E_EVIDENCE_SCHEMA_VERSION,
	generatedAt: new Date().toISOString(),
	runId: manifest.runId,
	campaignId: manifest.campaignId,
	canonical: aggregateCanonical,
	catalogue: manifest.catalogue,
	corpus: {
		kind: 'aggregate',
		exact: aggregateExact,
		caseCount: detailsByName.size,
		caseNamesSha256: caseIdsFingerprint( [ ...detailsByName.keys() ] ),
		cohortCount: bundles.length,
	},
	threeCheckout: manifest.threeCheckout,
	slimBundle: manifest.slimBundle,
	harness: manifest.harness,
	configuration: manifest.configuration,
	evidenceManifest: {
		file: basename( MANIFEST_PATH ),
		sha256: sha256( manifestBytes ),
	},
	report: manifest.report,
	totals,
	rows,
};
function cohortReference( bundle ) {

	const rel = relative( RESULTS, bundle.root );
	const nested = ! rel || ( rel !== '..' && ! rel.startsWith( `..${ sep }` ) && ! isAbsolute( rel ) );
	if ( aggregateCanonical && ! nested ) {

		throw new Error( `Canonical cohort root ${ bundle.root } must be inside aggregate root ${ RESULTS }.` );

	}
	return {
		id: bundle.manifest.corpus.project || 'upstream',
		kind: bundle.manifest.corpus.kind,
		project: bundle.manifest.corpus.project || null,
		runId: bundle.manifest.runId,
		campaignId: bundle.manifest.campaignId,
		canonical: bundle.manifest.canonical,
		root: nested ? ( rel.replaceAll( sep, '/' ) || '.' ) : bundle.root,
		portable: nested,
		manifest: {
			file: E2E_EVIDENCE_MANIFEST,
			sha256: bundle.manifestSha256,
		},
		report: bundle.manifest.report,
		corpus: bundle.manifest.corpus,
		threeCheckout: bundle.manifest.threeCheckout,
		slimBundle: bundle.manifest.slimBundle,
		harness: bundle.manifest.harness,
		configuration: bundle.manifest.configuration,
	};

}
const evidenceSet = {
	schemaVersion: E2E_EVIDENCE_SCHEMA_VERSION,
	campaignId: manifest.campaignId,
	canonical: aggregateCanonical,
	catalogue: manifest.catalogue,
	corpus: coverage.corpus,
	cohorts: bundles.map( cohortReference ),
};
const OUTPUT_RESULTS = prepareOutputRoot( RESULTS, {
	repositoryRoot: REPO,
	allowedRepositoryRoots: [ resolve( SELF, 'results' ) ],
	label: 'Coverage output root',
} );
const MARKDOWN_PATH = join( OUTPUT_RESULTS, 'coverage-summary.md' );
const JSON_PATH = join( OUTPUT_RESULTS, E2E_COVERAGE_JSON );
const EVIDENCE_SET_PATH = join( OUTPUT_RESULTS, E2E_EVIDENCE_SET_JSON );
const evidenceSetBytes = Buffer.from( JSON.stringify( evidenceSet, null, 2 ) );
writeOutputFileAtomic( OUTPUT_RESULTS, EVIDENCE_SET_PATH, evidenceSetBytes, {
	label: 'Coverage evidence-set JSON',
} );
coverage.evidenceSet = {
	file: basename( EVIDENCE_SET_PATH ),
	sha256: sha256( evidenceSetBytes ),
};
writeOutputFileAtomic( OUTPUT_RESULTS, JSON_PATH, JSON.stringify( coverage, null, 2 ), {
	label: 'Coverage JSON',
} );

const lines = [
	'# Feature coverage — capture vs replay',
	'',
	`Generated from evidence schema ${ E2E_EVIDENCE_SCHEMA_VERSION }, campaign \`${ manifest.campaignId }\`. Each row shows its effective configured PSNR threshold.`,
	'',
	`**${ totals.pass } / ${ totals.rows } catalogue examples match (${ totals.matchPercent }%).** ` +
	`${ totals.evidenceRows } rows belong to ${ bundles.length } run-bound evidence cohort(s); ` +
	`${ totals.diagnostic } diagnostics, ${ totals.fail } failed or ungraded routes.`,
	'',
	`Semantic evidence: ${ totals.semanticGatePass } pass, ${ totals.semanticGateFail } fail; ` +
	`${ totals.semanticErrors } unexpected errors, ${ totals.semanticWarnings } unclassified warnings, ${ totals.semanticRecoveries } proven recoveries, ` +
	`${ totals.semanticOptionalFailures } optional probe failures.`,
	'',
	'Only screenshot bytes named and hashed by this run’s evidence manifest are graded. Semantic failures remain visibly failed even when their pixels match; missing, unbound, timed-out, or warning-bearing evidence fails closed.',
	'',
];
const categoryOrder = [ 'Lights', 'Materials', 'Shadows', 'Sprites', 'Compute', 'Camera', 'MRT / RenderTargets', 'Particles', 'Postprocessing', 'Misc' ];
for ( const category of categoryOrder ) {

	const items = rows.filter( ( row ) => row.category === category );
	if ( items.length === 0 ) continue;
	const pass = items.filter( ( row ) => row.verdict === 'pass' ).length;
	const diagnostics = items.filter( ( row ) => row.verdict === 'diagnostic' ).length;
	lines.push( `## ${ category } (${ pass } / ${ items.length } match${ diagnostics ? `, ${ diagnostics } diagnostic` : '' })` );
	lines.push( '' );
	lines.push( '| Example | Source | Capture | Replay | PSNR (dB) | Effective gate | Verdict | Note |' );
	lines.push( '|---|---|---|---|---|---|---|---|' );
	for ( const row of items ) {

		lines.push(
			`| ${ row.name } | ${ row.sourceKind } | ${ tick( row.hasCapture ) } | ${ tick( row.hasReplay ) } | ` +
			`${ fmtPsnr( row.psnr ) } | ${ row.effectiveThreshold } dB | ${ verdictTag( row.verdict ) } | ${ row.note } |`,
		);

	}
	lines.push( '' );

}
writeOutputFileAtomic( OUTPUT_RESULTS, MARKDOWN_PATH, lines.join( '\n' ), {
	label: 'Coverage Markdown',
} );
console.log( `[coverage-summary] wrote ${ MARKDOWN_PATH }, ${ JSON_PATH }, and ${ EVIDENCE_SET_PATH }` );
console.log(
	`[coverage-summary] ${ totals.pass } / ${ totals.rows } catalogue rows match; ` +
	`${ totals.evidenceRows } exact run-bound evidence rows; ${ totals.diagnostic } diagnostic; ${ totals.fail } fail`,
);
