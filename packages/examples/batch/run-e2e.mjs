#!/usr/bin/env node
/**
 * Capture -> slim replay harness for three.js WebGPU examples.
 *
 * Per example:
 *   1. Serve the stock example through full three.js and take the visual
 *      reference screenshot.
 *   2. Serve the same example with an importmap wrapper around
 *      `three/webgpu`/`three` that auto-marks every constructed NodeMaterial.
 *   3. Let the real three.js TSL builder render once and POST captured
 *      user-material + aux artifacts to this harness.
 *   4. Reload the same example with the slim bundle, a TSL authoring stub,
 *      the captured user materials, and the captured aux registry.
 *   5. Report whether replay reached a non-empty frame without unexpected
 *      console/page errors AND the per-pixel PSNR vs the capture frame is
 *      at or above the configured threshold (default 30 dB). The pixel
 *      gate can be disabled with `--no-pixel-gate` for diagnostic runs.
 *
 * This is intentionally a harness, not a production build. It answers:
 * "Can this example's live materials be captured and replayed through the
 * slim runtime if we automate the user's dev-capture step, and does the
 * replayed frame look the same as the live one?"
 *
 *   node packages/examples/batch/run-e2e.mjs --filter=webgpu_backdrop
 *   node packages/examples/batch/run-e2e.mjs --filter=ocean --psnr-threshold=25
 *   node packages/examples/batch/run-e2e.mjs --filter=ocean --no-pixel-gate
 *   node packages/examples/batch/run-e2e.mjs --filter=ocean --replay-only
 *   node packages/examples/batch/run-e2e.mjs --filter=ocean --reuse-reference-shot
 *   node packages/examples/batch/run-e2e.mjs --tier=tier1
 *   node packages/examples/batch/run-e2e.mjs --filter=ocean --port=8729 --port-retries=20
 *   node packages/examples/batch/run-e2e.mjs --filter=ocean --target-tick=60
 *   node packages/examples/batch/run-e2e.mjs --filter=ocean --timings
 *   node packages/examples/batch/run-e2e.mjs --filter=ocean --slim-bundle=/tmp/three.webgpu.slim.js
 *   TSLP_E2E_OUT=/tmp/tslp-ocean node packages/examples/batch/run-e2e.mjs --filter=ocean --reuse-reference-shot --no-save-shots
 */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readdirSync, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, join, dirname, extname, normalize, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MATERIAL_TEXTURE_PROPS as __TEXTURE_PROPS, MATERIAL_NODE_TEXTURE_KEYS as __NODE_GRAPH_KEYS } from '@tsl-precompile/contract/texture-props';
import { instrumentLiveUniformIdentities } from '../../plugin/src/babel-transform.js';
import { validateAuxiliaryFamilyPayload } from '../../plugin/src/dev-capture-server.js';
import { installBrowserFailureCollector } from '../browser-failure-policy.mjs';

import {
	assertOfficialThreeR185Checkout,
	assertThreeCheckoutMatchesVersion,
	createOfficialThreeR185SourceVerifier,
	readThreeGitIdentity,
} from './_three-version.mjs';
import {
	E2E_EVIDENCE_MANIFEST,
	E2E_EVIDENCE_SCHEMA_VERSION,
	EvidenceSourceRecorder,
	assertUniqueExactNames,
	caseIdsFingerprint,
	classifyEvidenceRun,
	createRunId,
	describeEvidenceBytes,
	evidenceAffectingEnvironmentOverrides,
	fingerprintJson,
	readEvidenceCatalogue,
	readSafeContainedFile,
	resolveE2EHarnessSourceFiles,
	sha256,
	verifyEvidenceDescriptor,
} from './e2e-evidence.mjs';
import { createE2EEvidenceGate } from './e2e-evidence-gate.mjs';
import { classifyDirectNodeMaterialCapture } from './e2e-direct-node-material-policy.mjs';
import {
	assertEvidenceEnvironment,
	assertEvidenceEnvironmentMatches,
	collectEvidenceEnvironment,
	launchEvidenceBrowser,
} from './e2e-environment.mjs';
import {
	drainAndSettleE2EGpuDiagnostics,
	drainE2EGpuDiagnostics,
	installE2EGpuDiagnostics,
} from './e2e-gpu-diagnostics.mjs';
import {
	assertStoredE2ENetworkObservation,
	bindE2ENetworkObservationBodies,
	e2eNetworkCrossPhaseIssues,
	e2eNetworkObservationIssues,
	installE2ENetworkCaptureCollector,
	installE2ENetworkFixtureReplayCollector,
} from './e2e-network-evidence.mjs';
import { createTslpBrowserImportMap } from './e2e-browser-import-map.mjs';
import { slimWebgpuReplayModule } from './e2e-slim-replay-module.mjs';
import { trackLateTextureNodeAssignments } from './late-render-target-textures.mjs';
import {
	describeArtifactEvidenceDump,
	readArtifactEvidenceJson,
	writeArtifactDebugDump as writeCompressedArtifactDebugDump,
} from './e2e-artifact-output.mjs';
import { shouldSkipE2EExample } from './example-skip-policy.mjs';
import { pixelGateOf, pixelGatePassed } from './e2e-pixel-gate.mjs';
import { validateE2ESelection } from './e2e-selection.mjs';
import { discoverLocalExampleCases as discoverSharedLocalExampleCases } from './local-example-discovery.mjs';
import { describeLocalExampleDiscovery } from './e2e-local-source-contract.mjs';
import { isTslpWarningMessage } from './e2e-warning-policy.mjs';
import { canvasIndicesByBackendThenHorizontalPosition, canvasIndicesByHorizontalPosition, isolateCanvasForScreenshot, restoreCanvasAfterScreenshot } from './e2e-canvas-screenshot.mjs';
import { browserStabilizationPolicyForExample, canvasOrderForExample } from './e2e-browser-stabilization-policy.mjs';
import { createRendererBackendEvidence, uniqueRendererBackendValues } from './e2e-renderer-backend-evidence.mjs';
import { hasReplayArtifactCoverage } from './e2e-artifact-policy.mjs';
import { installRenderSelectorMismatchRecorder } from './e2e-render-selector-recorder.mjs';
import { auditArtifactShaderLanguageBackends, enrichRenderSelectorDiagnostics, resolveE2ERoots, summarizeArtifactRenderSelectors } from './e2e-report-diagnostics.mjs';
import { writeCurrentShotPair } from './e2e-shot-output.mjs';
import { deterministicTimeoutPolicyForExample, holdAnimationUntilReadyForExample, installAnimationLoopOwnerReadiness, installAnimationLoopSettleTransition, installAudioAnalyserReadiness, minimumAnimationLoopOwnersForExample, minimumRenderableObjectsForExample, settleFramesForExample, targetTickForExample } from './e2e-settle-policy.mjs';
import { applyExampleWorkloadPolicy, workloadPolicyForExample } from './e2e-workload-policy.mjs';
import { isLoaderAddonReadinessPath, rewriteLoaderAddonReadiness } from './e2e-loader-readiness.mjs';
import {
	captureWaitOverrideForExample,
	comparePngBuffers,
	coverageConfig,
	expectedCaptureErrorPatternsForExample,
	expectedCaptureErrorSourcesForExample,
	expectedReplayErrorPatternsForExample,
	expectedReplayErrorSourcesForExample,
	minimumBrightFractionForExample,
	pixelGateDisabledReasonForExample,
	psnrIgnoreRegionsForExample,
	psnrThresholdForExample,
	tierExamples,
} from './psnr.mjs';
import { loadSlimBundle, slimBundleHashOptions, slimBundleReportProvenance } from './slim-bundle-provenance.mjs';
import { coalesceUserArtifactVariantFamilies } from './user-artifact-families.mjs';
import { rewriteR185AddonCompatibility } from './r185-addon-compat.mjs';
import {
	bindE2EArtifactMetrics,
	computeE2EArtifactMetrics,
} from './e2e-artifact-metrics.mjs';
import { applyBatchCapturePayload } from './capture-payload-store.mjs';
import {
	assertOutputFileTarget,
	assertSafeJsonOutputName,
	ensureOutputDirectory,
	prepareOutputRoot,
	removeOutputPath,
	writeOutputFileAtomic,
} from './output-path-safety.mjs';

const SELF = dirname( fileURLToPath( import.meta.url ) );
const REPO = resolve( SELF, '../../..' );
const args = process.argv.slice( 2 );
function getArg( prefix, def ) {

	const a = args.find( ( x ) => x.startsWith( prefix ) );
	return a ? a.slice( prefix.length ) : def;

}

const {
	canonicalRoot: CANONICAL_RESULTS,
	outputRoot: selectedOutputRoot,
	inputRoot: INPUT_ROOT,
} = resolveE2ERoots( { selfDir: SELF, args } );
let OUT = selectedOutputRoot;
const RUNTIME_SRC = resolve( REPO, 'packages/runtime/src' );
const PLUGIN_SRC = resolve( REPO, 'packages/plugin/src' );
const CONTRACT_SRC = resolve( REPO, 'packages/contract/src' );
const DEFAULT_SLIM_BUNDLE = resolve( REPO, 'packages/runtime/build/three.webgpu.slim.js' );
const CATALOGUE_PATH = resolve( SELF, 'example-catalogue.json' );
const EVIDENCE_CATALOGUE = readEvidenceCatalogue( CATALOGUE_PATH, {
	root: REPO,
	label: 'current example catalogue',
} );
const CACHE_BUST = Date.now().toString( 36 );
const SLIM_BUNDLE_BROWSER_MODULE = `/__tslp__/three.webgpu.slim.js?v=${ CACHE_BUST }`;

let slimBundle;
try {

	slimBundle = loadSlimBundle( { defaultPath: DEFAULT_SLIM_BUNDLE, args } );

} catch ( error ) {

	console.error( `[batch-e2e] ${ error.message }\nRun \`pnpm --filter @tsl-precompile/runtime build:slim\` first or pass --slim-bundle=<path>.` );
	process.exit( 2 );

}
const SLIM_BUNDLE = slimBundle.absolutePath;
const SLIM_BUNDLE_SOURCE = slimBundle.bytes.toString( 'utf8' );
const SLIM_BUNDLE_PROVENANCE = slimBundleReportProvenance( slimBundle );

// The capture pass must use the same versions that stamped the slim bundle so
// that
// hashPlainConfigSync(config, { shape, threeVersion, pluginVersion }) produces
// matching configHashes for render-output, background, etc. artifacts.
// Read the authoritative provenance stamp rather than depending on incidental
// unminified runtime object literals surviving tree-shaking.
const SLIM_HASH_OPTS = ( () => {

	try {

		return slimBundleHashOptions( slimBundle );

	} catch ( error ) {

		console.error( `[batch-e2e] could not read hash-domain versions from slim bundle ${ SLIM_BUNDLE }: ${ error && error.message || error }. Rebuild it with \`pnpm --filter @tsl-precompile/runtime build:slim\`.` );
		process.exit( 2 );

	}

} )();
console.log( `[batch-e2e] slim bundle: ${ SLIM_BUNDLE } (sha256:${ slimBundle.shortSha256 })` );
console.log( `[batch-e2e] slim bundle hash opts: threeVersion=${ SLIM_HASH_OPTS.threeVersion } pluginVersion=${ SLIM_HASH_OPTS.pluginVersion }` );
console.log( `[batch-e2e] evidence input: ${ INPUT_ROOT }` );

function parseIntAtLeast( value, fallback, min ) {

	const n = parseInt( value, 10 );
	return Number.isFinite( n ) && n >= min ? n : fallback;

}

function parseFloatOr( value, fallback ) {

	const n = parseFloat( value );
	return Number.isFinite( n ) ? n : fallback;

}

const threeRepo = resolve(
	getArg( '--three-repo=', process.env.TSLP_THREE_REPO || resolve( SELF, '../../../../three.js' ) )
);
const localExamplesRootArg = getArg( '--local-examples-root=', '' );
const localExamplesRoot = localExamplesRootArg ? resolve( localExamplesRootArg ) : null;
const filter = getArg( '--filter=', '' );
const tier = getArg( '--tier=', '' );
const HAS_EXPLICIT_LIMIT = args.some( ( arg ) => arg.startsWith( '--limit=' ) );
const HAS_EXPLICIT_OFFSET = args.some( ( arg ) => arg.startsWith( '--offset=' ) );
const limit = parseIntAtLeast( getArg( '--limit=', '9999' ), 9999, 0 );
const offset = parseIntAtLeast( getArg( '--offset=', '0' ), 0, 0 );
let port = parseIntAtLeast( getArg( '--port=', '8729' ), 8729, 1 );
const portRetries = parseIntAtLeast( getArg( '--port-retries=', '100' ), 100, 0 );
const captureWaitMs = parseIntAtLeast( getArg( '--capture-wait-ms=', '12000' ), 12000, 0 );
const HAS_EXPLICIT_CAPTURE_WAIT = args.some( ( arg ) => arg.startsWith( '--capture-wait-ms=' ) );
const replayWaitMs = parseIntAtLeast( getArg( '--replay-wait-ms=', '5000' ), 5000, 0 );
const targetTick = parseIntAtLeast( getArg( '--target-tick=', '0' ), 0, 0 );
const HAS_EXPLICIT_TARGET_TICK = args.some( ( arg ) => arg.startsWith( '--target-tick=' ) );
const psnrThreshold = parseFloatOr( getArg( '--psnr-threshold=', '30' ), 30 );
const HAS_EXPLICIT_PSNR_THRESHOLD = args.some( ( arg ) => arg.startsWith( '--psnr-threshold=' ) );
const pixelGateEnabled = ! args.includes( '--no-pixel-gate' );
const saveShots = ! args.includes( '--no-save-shots' );
const replayOnly = args.includes( '--replay-only' );
const reuseReferenceShot = replayOnly || args.includes( '--reuse-reference-shot' );
const canonicalEvidenceRequested = args.includes( '--canonical-evidence' );
const officialThreeSourcesRequested = args.includes( '--require-official-three-sources' );
const verboseConsole = args.includes( '--verbose' ) || process.env.TSLP_E2E_VERBOSE === '1' || !! process.env.TSLP_DEBUG_TORNADO_VERBOSE;
const replayOperationDiagnostics = process.env.TSLP_DEBUG_REPLAY_OPS === '1';
const timingsEnabled = args.includes( '--timings' ) || process.env.TSLP_E2E_TIMINGS === '1';
let reportFile;
try {

	reportFile = assertSafeJsonOutputName( getArg( '--report=', 'e2e-report.json' ), {
		label: '--report=',
	} );

} catch ( error ) {

	console.error( `[batch-e2e] invalid report filename: ${ error && error.message || error }` );
	process.exit( 2 );

}
const EVIDENCE_AFFECTING_ARG_PREFIXES = [
	'--capture-wait-ms=',
	'--replay-wait-ms=',
	'--target-tick=',
	'--settle-frames=',
	'--present-settle-ms=',
	'--asset-settle-ms=',
	'--bright-poll-ms=',
	'--minimum-bright-fraction=',
];
const EVIDENCE_AFFECTING_ENVIRONMENT_OVERRIDES = evidenceAffectingEnvironmentOverrides();
const HAS_EVIDENCE_AFFECTING_OVERRIDES = EVIDENCE_AFFECTING_ENVIRONMENT_OVERRIDES.length > 0 || args.some( ( argument ) => (
	EVIDENCE_AFFECTING_ARG_PREFIXES.some( ( prefix ) => argument.startsWith( prefix ) )
) );
if (
	EVIDENCE_AFFECTING_ENVIRONMENT_OVERRIDES.length > 0 &&
	( canonicalEvidenceRequested || officialThreeSourcesRequested )
) {

	console.error(
		'[batch-e2e] canonical/official evidence forbids behavior-affecting environment overrides: ' +
		EVIDENCE_AFFECTING_ENVIRONMENT_OVERRIDES.join( ', ' ),
	);
	process.exit( 2 );

}

if ( ! existsSync( join( threeRepo, 'examples' ) ) ) {

	console.error( `[batch-e2e] three.js examples not found at ${ threeRepo }/examples. Pass --three-repo=<absolute-path>` );
	process.exit( 2 );

}
if ( localExamplesRoot && ! existsSync( localExamplesRoot ) ) {

	console.error( `[batch-e2e] local examples root not found at ${ localExamplesRoot }` );
	process.exit( 2 );

}
if ( EVIDENCE_CATALOGUE.threeVersion !== SLIM_HASH_OPTS.threeVersion ) {

	console.error(
		`[batch-e2e] catalogue Three version ${ JSON.stringify( EVIDENCE_CATALOGUE.threeVersion ) } ` +
		`does not match the signed slim bundle ${ JSON.stringify( SLIM_HASH_OPTS.threeVersion ) }.`,
	);
	process.exit( 2 );

}

let threeCheckout;
try {

	threeCheckout = assertThreeCheckoutMatchesVersion( threeRepo, SLIM_HASH_OPTS.threeVersion, 'batch-e2e' );

} catch ( error ) {

	console.error( error && error.message || error );
	process.exit( 2 );

}

const threeGitIdentity = readThreeGitIdentity( threeRepo );
let officialThreeSourceVerifier = null;
const sourceRecorder = new EvidenceSourceRecorder( {
	repoRoot: REPO,
	threeRoot: threeRepo,
	localRoot: localExamplesRoot,
} );
const HARNESS_SOURCE_FILES = resolveE2EHarnessSourceFiles( REPO );

function trackedReadFileSync( file, encoding = null ) {

	const bytes = sourceRecorder.record( file );
	return encoding ? bytes.toString( encoding ) : bytes;

}

function shouldSkip( name ) { return shouldSkipE2EExample( name ); }

const examplesRoot = localExamplesRoot || join( threeRepo, 'examples' );
const examplePaths = new Map();
const localExampleOptions = new Map();
let localDiscoveredCaseEntries = [];
const tierExampleNames = tier ? tierExamples( tier ) : [];
const tierExampleSet = tier ? new Set( tierExampleNames ) : null;
if ( tier && tierExampleNames.length === 0 ) {

	console.error( `[batch-e2e] unknown or empty coverage tier "${ tier }"` );
	process.exit( 2 );

}
function stripExampleQuery( examplePath ) {

	return String( examplePath || '' ).split( /[?#]/ )[ 0 ];

}
function examplePathFor( name ) {

	return examplePaths.get( name ) || name;

}
function discoverLocalExampleCases() {

	localDiscoveredCaseEntries = discoverSharedLocalExampleCases( localExamplesRoot, {
		readFile: ( file ) => sourceRecorder.record( file ),
	} );
	return localDiscoveredCaseEntries.map( ( entry ) => {

		examplePaths.set( entry.name, entry.path );
		if ( entry.options ) localExampleOptions.set( entry.name, entry.options );
		return entry.name;

	} );

}

const discoveredExamples = localExamplesRoot
	? discoverLocalExampleCases()
	: readdirSync( examplesRoot )
		.filter( ( f ) => f.startsWith( 'webgpu_' ) && f.endsWith( '.html' ) );
const allExamples = discoveredExamples
	.filter( ( f ) => ! tierExampleSet || tierExampleSet.has( f ) )
	.filter( ( f ) => ! filter || f.includes( filter ) || examplePathFor( f ).includes( filter ) )
	.slice( offset, offset + limit );
const candidates = localExamplesRoot ? allExamples : allExamples.filter( ( f ) => ! shouldSkip( f ) );

try {

	validateE2ESelection( {
		tier,
		tierExampleNames,
		discoveredExamples,
		candidates,
		filter,
		hasExplicitOffset: HAS_EXPLICIT_OFFSET,
		hasExplicitLimit: HAS_EXPLICIT_LIMIT,
		hasExplicitPsnrThreshold: HAS_EXPLICIT_PSNR_THRESHOLD,
		localExamplesRoot,
		pixelGateEnabled,
		replayOnly,
		reuseReferenceShot,
		shouldSkip,
	} );

} catch ( error ) {

	console.error( `[batch-e2e] invalid example selection: ${ error && error.message || error }` );
	process.exit( 2 );

}
let evidenceRun;
try {

	evidenceRun = classifyEvidenceRun( {
		canonicalRoot: CANONICAL_RESULTS,
		outputRoot: OUT,
		catalogueUpstreamCaseNames: EVIDENCE_CATALOGUE.upstreamCaseNames,
		candidates,
		localExamplesRoot,
		tier,
		filter,
		hasExplicitOffset: HAS_EXPLICIT_OFFSET,
		hasExplicitLimit: HAS_EXPLICIT_LIMIT,
		hasExplicitPsnrThreshold: HAS_EXPLICIT_PSNR_THRESHOLD,
		pixelGateEnabled,
		saveShots,
		replayOnly,
		reuseReferenceShot,
		defaultSlimBundle: DEFAULT_SLIM_BUNDLE,
		slimBundle: SLIM_BUNDLE,
		reportFile,
		hasEvidenceAffectingOverrides: HAS_EVIDENCE_AFFECTING_OVERRIDES,
		canonicalEvidenceRequested,
	} );

} catch ( error ) {

	console.error( `[batch-e2e] invalid evidence destination: ${ error && error.message || error }` );
	process.exit( 2 );

}
const officialThreeSourcesRequired = evidenceRun.canonical || officialThreeSourcesRequested;
if ( officialThreeSourcesRequired ) {

	try {

		assertOfficialThreeR185Checkout( threeRepo, 'batch-e2e canonical evidence' );
		officialThreeSourceVerifier = createOfficialThreeR185SourceVerifier(
			threeRepo,
			'batch-e2e official Three sources',
		);

	} catch ( error ) {

		console.error(
			`${ error && error.message || error } ` +
			( evidenceRun.canonical
				? 'Use an isolated --output-root for modified/version-only diagnostics.'
				: 'The evidence campaign requires an unchanged official checkout.' ),
		);
		process.exit( 2 );

	}

}
sourceRecorder.setThreeSourceVerifier( officialThreeSourceVerifier );
for ( const file of HARNESS_SOURCE_FILES ) sourceRecorder.record( file );
sourceRecorder.record( threeCheckout.constantsPath );
sourceRecorder.record( threeCheckout.packagePath );
const localDiscoveryEvidence = localExamplesRoot
	? describeLocalExampleDiscovery( {
		repositoryRoot: REPO,
		localRoot: localExamplesRoot,
		project: basename( localExamplesRoot ),
		entries: localDiscoveredCaseEntries,
	} )
	: null;
for ( const path of localDiscoveryEvidence?.sourcePaths || [] ) {

	sourceRecorder.record( resolve( localExamplesRoot, path ) );

}

const RUN_ID = createRunId();
const CAMPAIGN_ID = getArg( '--campaign-id=', RUN_ID );
if ( ! /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test( CAMPAIGN_ID ) ) {

	console.error( `[batch-e2e] invalid campaign ID ${ JSON.stringify( CAMPAIGN_ID ) }` );
	process.exit( 2 );

}
try {

	OUT = prepareOutputRoot( OUT, {
		repositoryRoot: REPO,
		allowedRepositoryRoots: [ CANONICAL_RESULTS ],
		label: 'E2E output root',
	} );

} catch ( error ) {

	console.error( `[batch-e2e] unsafe output root: ${ error && error.message || error }` );
	process.exit( 2 );

}
console.log( `[batch-e2e] output root: ${ OUT }${ evidenceRun.canonical ? '' : ' (isolated)' }` );
const RUN_ROOT = join( OUT, 'evidence', RUN_ID );
const RUN_SHOTS_DIR = join( RUN_ROOT, 'shots' );
const RUN_ARTIFACTS_DIR = join( RUN_ROOT, 'artifacts' );
const RUN_NETWORK_DIR = join( RUN_ROOT, 'network' );
const EVIDENCE_MANIFEST_PATH = join( OUT, E2E_EVIDENCE_MANIFEST );
const reportPath = join( OUT, reportFile );
try {

	assertOutputFileTarget( OUT, reportPath, { label: 'E2E report' } );
	assertOutputFileTarget( OUT, EVIDENCE_MANIFEST_PATH, { label: 'E2E evidence manifest' } );
	removeOutputPath( OUT, reportPath, { label: 'Previous E2E report' } );
	removeOutputPath( OUT, EVIDENCE_MANIFEST_PATH, { label: 'Stale E2E evidence manifest' } );
	ensureOutputDirectory( OUT, RUN_ROOT, { label: 'E2E run directory' } );

} catch ( error ) {

	console.error( `[batch-e2e] unsafe output destination: ${ error && error.message || error }` );
	process.exit( 2 );

}

const networkBodyDescriptors = new Map();
function describeRunNetworkBody( { sha256: bodySha256, bytes } ) {

	if ( networkBodyDescriptors.has( bodySha256 ) ) return networkBodyDescriptors.get( bodySha256 );
	if ( ! Buffer.isBuffer( bytes ) || sha256( bytes ) !== bodySha256 ) {

		throw new Error( `Network response body ${ bodySha256 } does not match its content address.` );

	}
	ensureOutputDirectory( OUT, RUN_NETWORK_DIR, { label: 'E2E network evidence directory' } );
	const file = join( RUN_NETWORK_DIR, `${ bodySha256 }.bin` );
	writeOutputFileAtomic( OUT, file, bytes, { label: 'E2E network response body' } );
	const descriptor = describeEvidenceBytes( {
		outputRoot: OUT,
		file,
		bytes,
		runId: RUN_ID,
	} );
	networkBodyDescriptors.set( bodySha256, descriptor );
	return descriptor;

}

function bindRunNetworkEvidence( observation, bodies ) {

	return bindE2ENetworkObservationBodies(
		observation,
		bodies,
		describeRunNetworkBody,
	);

}

if ( localExamplesRoot ) {
	console.log( `[batch-e2e] discovered ${ allExamples.length } local *.html in ${ localExamplesRoot } — ${ candidates.length } candidates` );
} else {
	console.log( `[batch-e2e] discovered ${ allExamples.length } webgpu_*.html — ${ candidates.length } after skip list` );
}

const deferredSceneAssetCache = new Map();
async function exampleUsesDeferredSceneAssets( name ) {

	if ( deferredSceneAssetCache.has( name ) ) return deferredSceneAssetCache.get( name );
	if ( name === 'webgpu_tsl_wood.html' ) {
		deferredSceneAssetCache.set( name, true );
		return true;
	}
	const file = localExamplesRoot ? join( localExamplesRoot, stripExampleQuery( examplePathFor( name ) ) ) : join( threeRepo, 'examples', name );
	let source = '';
	try {

		source = sourceRecorder.record( file ).toString( 'utf8' );

	} catch {}
	const result = /\b(?:GLTFLoader|FBXLoader|OBJLoader|ColladaLoader|PLYLoader|STLLoader|LDrawLoader|LWOLoader|USDZLoader)\b/.test( source );
	deferredSceneAssetCache.set( name, result );
	return result;

}

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'application/javascript; charset=utf-8',
	'.mjs': 'application/javascript; charset=utf-8',
	'.json': 'application/json',
	'.wasm': 'application/wasm',
	'.css': 'text/css; charset=utf-8',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.svg': 'image/svg+xml',
	'.hdr': 'application/octet-stream',
	'.exr': 'application/octet-stream',
	'.bin': 'application/octet-stream',
	'.glb': 'model/gltf-binary',
	'.gltf': 'model/gltf+json',
	'.ktx2': 'application/octet-stream',
	'.wgsl': 'text/plain; charset=utf-8',
};

const NODE_MATERIAL_EXPORTS = [
	'NodeMaterial',
	'MeshBasicNodeMaterial',
	'MeshStandardNodeMaterial',
	'MeshPhysicalNodeMaterial',
	'MeshLambertNodeMaterial',
	'MeshPhongNodeMaterial',
	'MeshToonNodeMaterial',
	'MeshNormalNodeMaterial',
	'MeshMatcapNodeMaterial',
	'MeshSSSNodeMaterial',
	'VolumeNodeMaterial',
	'LineBasicNodeMaterial',
	'LineDashedNodeMaterial',
	'Line2NodeMaterial',
	'PointsNodeMaterial',
	'SpriteNodeMaterial',
	'ShadowNodeMaterial',
];

const SLIM_REPLAY_DIRECT_EXPORTS = new Set( [
	...NODE_MATERIAL_EXPORTS,
	'ArrayCamera',
	'BlendMode',
	'Controls',
	'MOUSE',
	'MathUtils',
	'NodeUpdateType',
	'PMREMGenerator',
	'PassNode',
	'Plane',
	'PostProcessing',
	'QuadMesh',
	'Quaternion',
	'Ray',
	'RenderPipeline',
	'RendererUtils',
	'Spherical',
	'TSL',
	'TOUCH',
	'TempNode',
	'TextureNode',
	'Vector2',
	'Vector3',
	'WebGPURenderer',
] );
// A diagnostic bundle can live in /tmp, where a `.js` file has no enclosing
// `type: module` package. Import the exact hashed bytes as ESM so export
// discovery is independent of the alternate path's package boundary.
const SLIM_BUNDLE_MODULE_URL = `data:text/javascript;base64,${ slimBundle.bytes.toString( 'base64' ) }`;
const SLIM_REPLAY_SLIM_EXPORTS = Object.keys( await import( SLIM_BUNDLE_MODULE_URL ) );
function readR185WebgpuExportNames() {

	const source = trackedReadFileSync( join( threeRepo, 'build/three.webgpu.js' ), 'utf8' );
	const blocks = [ ...source.matchAll( /^export\s*\{([^}]*)\}(?:\s+from\s+['"][^'"]+['"])?\s*;/gm ) ];
	if ( blocks.length !== 2 ) {

		throw new Error( `Expected two named export blocks in the exact r185 three.webgpu.js build, found ${ blocks.length }.` );

	}
	const names = [];
	for ( const block of blocks ) {

		for ( const rawSpecifier of block[ 1 ].split( ',' ) ) {

			const specifier = rawSpecifier.trim();
			const match = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec( specifier );
			if ( ! match ) {

				throw new Error( `Could not parse exact r185 three.webgpu.js export ${ JSON.stringify( specifier ) }.` );

			}
			names.push( match[ 2 ] || match[ 1 ] );

		}

	}
	return [ ...new Set( names ) ].sort();

}
const SLIM_REPLAY_FULL_EXPORTS = readR185WebgpuExportNames();
const SLIM_REPLAY_FORWARD_EXPORTS = SLIM_REPLAY_SLIM_EXPORTS
	.filter( ( name ) => /^[A-Za-z_$][\w$]*$/.test( name ) )
	.filter( ( name ) => ! SLIM_REPLAY_DIRECT_EXPORTS.has( name ) )
	.sort();
const SLIM_REPLAY_FORWARD_EXPORT_BLOCK = SLIM_REPLAY_FORWARD_EXPORTS.length > 0
	? `export { ${ SLIM_REPLAY_FORWARD_EXPORTS.join( ', ' ) } } from ${ JSON.stringify( SLIM_BUNDLE_BROWSER_MODULE ) };`
	: '';
const SLIM_REPLAY_FULL_FALLBACK_EXPORTS = SLIM_REPLAY_FULL_EXPORTS
	.filter( ( name ) => /^[A-Za-z_$][\w$]*$/.test( name ) )
	.filter( ( name ) => ! SLIM_REPLAY_DIRECT_EXPORTS.has( name ) )
	.filter( ( name ) => ! SLIM_REPLAY_SLIM_EXPORTS.includes( name ) )
	.sort();
const SLIM_REPLAY_FULL_FALLBACK_EXPORT_BLOCK = SLIM_REPLAY_FULL_FALLBACK_EXPORTS.length > 0
	? `export { ${ SLIM_REPLAY_FULL_FALLBACK_EXPORTS.join( ', ' ) } } from '/build/three.webgpu.js';`
	: '';

const captures = new Map();
function captureBucket( example ) {

	if ( ! captures.has( example ) ) captures.set( example, { user: {}, aux: [] } );
	return captures.get( example );

}

function resetCaptureBucketForArtifactPass( example, frameClock = null ) {

	const bucket = { user: {}, aux: [] };
	if ( typeof frameClock === 'number' && Number.isFinite( frameClock ) ) {

		bucket.frameClock = frameClock;

	}
	captures.set( example, bucket );
	return bucket;

}

function jsonScriptLiteral( value ) {

	return JSON.stringify( value ).replace( /</g, '\\u003c' );

}

function stabilizeExampleHtml( html, example ) {

	if ( example === 'webgpu_tsl_editor.html' ) return stabilizeTslEditorHtml( html );
	if ( example !== 'webgpu_test_memory.html' ) return html;
	// The example intentionally churns random meshes/textures every frame; keep
	// the memory churn while making the visual gate compare one stable frame.
	return html
		.replace(
			"canvas2DContext.fillStyle = 'rgb(' + Math.floor( Math.random() * 256 ) + ',' + Math.floor( Math.random() * 256 ) + ',' + Math.floor( Math.random() * 256 ) + ')';",
			"canvas2DContext.fillStyle = 'rgb(192,0,80)';"
		)
		.replace(
			'const geometry = new THREE.SphereGeometry( 50, Math.random() * 64, Math.random() * 32 );',
			'const geometry = new THREE.SphereGeometry( 50, 32, 16 );'
		);

}

function instrumentInlineLiveUniforms( html, example ) {

	let inlineIndex = 0;
	return String( html ).replace( /<script\b([^>]*\btype=["']module["'][^>]*)>([\s\S]*?)<\/script>/gi, ( match, attributes, moduleSource ) => {

		if ( /\bsrc\s*=/.test( attributes ) ) return match;
		const sourceRoot = localExamplesRoot || threeRepo;
		const filename = join( sourceRoot, 'examples', `${ example }.inline-${ inlineIndex ++ }.js` );
		const transformed = instrumentLiveUniformIdentities( moduleSource, { filename, root: sourceRoot } );
		return transformed.touched ? `<script${ attributes }>${ transformed.code }</script>` : match;

	} );

}

function stabilizeTslEditorHtml( html ) {

	return html
		.replace(
			'\t\t\tinit();',
			`\t\t\tif ( window.__TSLP_E2E ) {

\t\t\t\twindow.__tslpLoaderPending = ( window.__tslpLoaderPending | 0 ) + 1;
\t\t\t\twindow.__tslpLoaderLastBusyAt = typeof window.__tslpRealNow === 'function' ? window.__tslpRealNow() : Date.now();

\t\t\t}

\t\t\tinit();`
		)
		.replace(
			'\t\t\t\t\tlet rawShader = null;',
			`\t\t\t\t\tlet rawShader = null;
\t\t\t\t\tlet tslpInitialBuildPending = !! window.__TSLP_E2E;
\t\t\t\t\tconst tslpMarkInitialBuildReady = () => {

\t\t\t\t\t\tif ( ! tslpInitialBuildPending ) return;
\t\t\t\t\t\ttslpInitialBuildPending = false;
\t\t\t\t\t\twindow.__tslpLoaderPending = Math.max( 0, ( window.__tslpLoaderPending | 0 ) - 1 );
\t\t\t\t\t\twindow.__tslpLoaderLastBusyAt = typeof window.__tslpRealNow === 'function' ? window.__tslpRealNow() : Date.now();

\t\t\t\t\t};`
		)
		.replace(
			`\t\t\t\t\t\t} catch ( e ) {

\t\t\t\t\t\t\tresult.setValue( 'Error: ' + e.message );

\t\t\t\t\t\t}
`,
			`\t\t\t\t\t\t} catch ( e ) {

\t\t\t\t\t\t\tresult.setValue( 'Error: ' + e.message );

\t\t\t\t\t\t} finally {

\t\t\t\t\t\t\ttslpMarkInitialBuildReady();

\t\t\t\t\t\t}
`
		);

}

function injectHtml( html, example, mode ) {

	const bucket = captureBucket( example );
	const captureEndpoint = '/__tslp__/capture?example=' + encodeURIComponent( example );
	// Wedge 4: stamp a global "pinned clock" for replay so time-driven node
	// graphs render at the SAME `t` the stock comparison frame observed.
	// `bucket.frameClock` is set by `runOne` to the stock pass's
	// `nodeFrame.time` at screenshot moment — the correct reference for
	// pinning replay. Fall back to per-artifact `captureClock` (stamped at
	// compileTSL time) for offline replays where the harness can't measure
	// stock. Stock/capture modes leave the global undefined.
	let pinnedClock = null;
	if ( mode === 'replay' ) {

		if ( typeof bucket.frameClock === 'number' && Number.isFinite( bucket.frameClock ) ) {

			pinnedClock = bucket.frameClock;

		} else {

			for ( const entry of Object.values( bucket.user || {} ) ) {

				const t = entry && entry.artifact && entry.artifact.captureClock;
				if ( typeof t === 'number' && Number.isFinite( t ) ) { pinnedClock = t; break; }

			}
			if ( pinnedClock === null ) {

				for ( const entry of ( bucket.aux || [] ) ) {

					const t = entry && entry.artifact && entry.artifact.captureClock;
					if ( typeof t === 'number' && Number.isFinite( t ) ) { pinnedClock = t; break; }

				}

			}

		}

	}
	const pinBoot = pinnedClock !== null
		? `<script>globalThis.__tslpPinnedClock=${ pinnedClock };${ process.env.TSLP_DEBUG_CLOCK === '1' ? `console.log('[tslp-clock] replay pin=' + globalThis.__tslpPinnedClock);` : '' }</script>`
		: '';
	const boot = `<script>globalThis.__TSLP_THREE_PACKAGE_VERSION__=${ jsonScriptLiteral( SLIM_HASH_OPTS.threeVersion ) };window.__TSLP_E2E=${ jsonScriptLiteral( { example, mode, artifacts: bucket, captureEndpoint, localExamples: !! localExamplesRoot } ) };</script>${ pinBoot }`;
	const stabilized = stabilizeExampleHtml( html, example );
	const mapped = rewriteImportmap( instrumentInlineLiveUniforms( stabilized, example ), mode );
	return mapped.includes( '</head>' )
		? mapped.replace( '</head>', `${ boot }\n</head>` )
		: boot + mapped;

}

function rewriteImportmap( html, mode ) {

	const bust = ( path ) => `${ path }?v=${ CACHE_BUST }`;
	const webgpuTarget = mode === 'capture'
		? bust( '/__tslp__/full-webgpu-auto.js' )
		: mode === 'stock'
			? bust( '/__tslp__/stock-webgpu.js' )
			: bust( '/__tslp__/slim-webgpu-replay.js' );
	let out = html
		.replace( /("three\/webgpu"\s*:\s*")[^"]+(")/g, `$1${ webgpuTarget }$2` )
		.replace( /("three"\s*:\s*")[^"]*three\.webgpu[^"]*(")/g, `$1${ webgpuTarget }$2` );

		const replayAddonsTarget = '/__tslp_addons_replay/';
		const harnessAddonsTarget = mode === 'replay'
			? replayAddonsTarget
			: mode === 'capture'
				? '/__tslp_addons/'
				: null;
		if ( harnessAddonsTarget !== null ) {

			out = out.replace( /("three\/addons\/"\s*:\s*")[^"]+(")/g, `$1${ harnessAddonsTarget }$2` );

		}
		if ( mode === 'replay' ) {

			out = out.replace( /("three\/tsl"\s*:\s*")[^"]+(")/g, '$1/__tslp__/tsl-stub.js$2' );

		}

	const tslTarget = mode === 'replay'
		? bust( '/__tslp__/tsl-stub.js' )
		: mode === 'capture'
			? bust( '/__tslp__/tsl-capture.js' )
			: '/build/three.tsl.js';
	const extraImports = {
		three: webgpuTarget,
		'three/webgpu': webgpuTarget,
		'three/tsl': tslTarget,
		...createTslpBrowserImportMap( mode, {
			auxVirtualUrl: bust( '/__tslp__/aux-virtual.js' ),
		} ),
		'three/src/': '/src/',
	};

	// Local example packages (--local-examples-root) don't ship `examples/jsm/`,
	// and the harness intercepts `/examples/*` for them, so the upstream-style
	// `"three/addons/": "./jsm/"` mapping can't resolve. Inject a mapping to the
	// `/__tslp_addons/` route (served from `<threeRepo>/examples/jsm/`). Capture
	// and replay also replace existing upstream mappings so the narrow,
	// version-gated addon compatibility rewrites apply in both instrumented modes.
		if ( ! /["']three\/addons\/["']\s*:/.test( out ) ) {

			extraImports[ 'three/addons/' ] = mode === 'replay' ? replayAddonsTarget : '/__tslp_addons/';

		}

	const runtimeThreeTarget = mode === 'replay' ? bust( '/__tslp__/three.webgpu.slim.js' ) : '/build/three.webgpu.js';
	const withHarnessMappings = ( map ) => {

		const next = map && typeof map === 'object' ? map : {};
		next.imports = { ...( next.imports || {} ), ...extraImports };
		next.scopes = { ...( next.scopes || {} ) };
		next.scopes[ '/__tslp_runtime/' ] = {
			...( next.scopes[ '/__tslp_runtime/' ] || {} ),
			three: runtimeThreeTarget,
			'three/webgpu': runtimeThreeTarget,
			'three/tsl': tslTarget,
		};
		return next;

	};

	if ( out.includes( '</script>' ) && out.includes( '"imports"' ) ) {

		const scriptRe = /<script\s+type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/i;
		return out.replace( scriptRe, ( match, json ) => {

			try {

				const map = withHarnessMappings( JSON.parse( json ) );
				return `<script type="importmap">${ JSON.stringify( map, null, '\t' ) }</script>`;

			} catch ( _ ) {

				return match.replace( /"imports"\s*:\s*\{/, ( m ) => `${ m }\n${ Object.entries( extraImports ).map( ( [ key, value ] ) => `\t\t\t\t"${ key }": "${ value }",` ).join( '\n' ) }` );

			}

		} );

	}

	const importMap = `<script type="importmap">${ JSON.stringify( withHarnessMappings( {} ), null, '\t' ) }</script>`;
	return out.includes( '</head>' ) ? out.replace( '</head>', `${ importMap }\n</head>` ) : importMap + out;

}

function rewriteHarnessVirtualImports( source ) {

	return String( source ).replace( /(["'])virtual:tsl-precompile\/__aux\1/g, `$1/__tslp__/aux-virtual.js?v=${ CACHE_BUST }$1` );

}

function rewriteMaterialXLoaderTextureIdentity( source ) {

	const text = String( source );
	if ( ! text.includes( 'class MaterialXLoader' ) || text.includes( '__tslpMaterialXTextureName' ) ) return text;
	const textureNeedle = [
		'const texture = new Texture();',
		'\t\ttexture.wrapS = texture.wrapT = RepeatWrapping;',
	].join( '\n' );
	if ( ! text.includes( textureNeedle ) ) return text;
	const textureReplacement = [
		'const texture = new Texture();',
		'\t\tlet __tslpMaterialXTextureUrl = uri;',
		'\t\tif ( typeof uri === \'string\' && uri.length > 0 ) {',
		'\t\t\tconst __tslpMaterialXTextureName = uri.split( /[?#]/ )[ 0 ].split( \'/\' ).filter( Boolean ).pop() || uri;',
		'\t\t\tif ( __tslpMaterialXTextureName && ! texture.name ) texture.name = __tslpMaterialXTextureName;',
		'\t\t\ttry {',
		'\t\t\t\t__tslpMaterialXTextureUrl = new URL( uri, new URL( this.materialX.path || \'.\', document.baseURI ) ).href;',
		'\t\t\t\ttexture.userData = texture.userData || {};',
		'\t\t\t\ttexture.userData.__tslpLoaderUrl = __tslpMaterialXTextureUrl;',
		'\t\t\t} catch ( _ ) {}',
		'\t\t}',
		'\t\ttexture.wrapS = texture.wrapT = RepeatWrapping;',
	].join( '\n' );
	const callbackNeedle = [
		'texture.image = imageBitmap;',
		'\t\t\ttexture.needsUpdate = true;',
	].join( '\n' );
	const callbackReplacement = [
		'texture.image = imageBitmap;',
		'\t\t\ttexture.needsUpdate = true;',
		'\t\t\tif ( globalThis.__tslpMarkLoaderTexture ) globalThis.__tslpMarkLoaderTexture( texture, __tslpMaterialXTextureUrl );',
	].join( '\n' );
	return text
		.replace( textureNeedle, textureReplacement )
		.replace( callbackNeedle, callbackReplacement );

}

function rewriteReplayAddon( source ) {

	const text = String( source );
	if ( ! /from\s*['"]three\/webgpu['"]/.test( text ) ) return text;
	let needsFullNodeMaterial = false;
	const rewritten = text.replace( /import\s*\{([\s\S]*?)\}\s*from\s*(['"])three\/webgpu\2/g, ( match, spec, quote ) => {
		const parts = spec.split( ',' ).map( ( part ) => part.trim() ).filter( Boolean );
		if ( ! parts.includes( 'NodeMaterial' ) ) return match;
		needsFullNodeMaterial = true;
		const kept = parts.filter( ( part ) => part !== 'NodeMaterial' );
		if ( kept.length === 0 ) return '';
		return `import { ${ kept.join( ', ' ) } } from ${ quote }three/webgpu${ quote }`;
	} );
	return needsFullNodeMaterial ? `import { NodeMaterial } from '/build/three.webgpu.js';\n${ rewritten }` : rewritten;

}

function rewriteThreeCoreDeterministicObjectIds( source ) {

	const text = String( source );
	const needle = `Object.defineProperty( this, 'id', { value: _object3DId ++ } );`;
	const replacement = `const __tslpObject3DId = typeof globalThis !== 'undefined' && typeof globalThis.__tslpStableObject3DId === 'function'
\t\t\t\t? globalThis.__tslpStableObject3DId()
\t\t\t\t: _object3DId ++;
\t\t\tObject.defineProperty( this, 'id', { value: __tslpObject3DId } );`;
	return text.includes( needle ) ? text.replace( needle, replacement ) : text;

}

function rewriteSlimDeterministicObjectIds( source ) {

	return String( source ).replace(
		/this\.isObject3D=!0,Object\.defineProperty\(this,"id",\{value:([A-Za-z_$][\w$]*)\+\+\}\)/,
		( match, counter ) => `this.isObject3D=!0,Object.defineProperty(this,"id",{value:"undefined"!=typeof globalThis&&"function"==typeof globalThis.__tslpStableObject3DId?globalThis.__tslpStableObject3DId():${ counter }++})`
	);

}

function stockWebgpuModule() {

	return `
import * as Original from '/build/three.webgpu.js';
export * from '/build/three.webgpu.js';
import { installR185PMREMNodeGuard } from '/__tslp_runtime/r185-pmrem-node-guard.js';
import { installPrecompileMarker as __installStockPrecompileMarker } from '/__tslp_runtime/precompile-marker.js';
import { installRangeAttributeCapture } from '/__tslp_runtime/range-attribute-capture.js';
import { installVelocityProjectionLifecycle as __installVelocityProjectionLifecycle } from '/__tslp_runtime/slim-support/velocity-projection-lifecycle.js';
import { synchronizeTemporalJitterNode as __sharedSynchronizeTemporalJitterNode } from '/__tslp_batch/temporal-jitter.mjs';

installR185PMREMNodeGuard( Original );
// The capture pass replaces r185's ambient physical RangeNode stream with a
// compact deterministic recipe. Apply the same rendering-only patch to the
// stock reference so the pixel gate compares identical instance attributes,
// rather than a stock random field against the captured recipe.
installRangeAttributeCapture( Original );

// Stock mode serves authored source without Vite's production Babel rewrite.
// Install the runtime-owned, branded marker without a capture endpoint. It
// stays chain-preserving and capture-inert, while remaining compatible with
// local raw fixtures that later update the same installation in development.
__installStockPrecompileMarker( Original );

let __pmremRunning = 0;
window.__tslpPmremPending = window.__tslpPmremPending || 0;
window.__tslpCompilePending = window.__tslpCompilePending || 0;

function __tslpLoaderBasename( value ) {
	const raw = String( value || '' );
	const tail = raw.split( /[?#]/ )[ 0 ].split( '/' ).filter( Boolean ).pop() || raw;
	return tail || '';
}

window.__tslpMarkLoaderTexture = function ( texture, url ) {
	if ( ! texture || texture.isTexture !== true ) return texture;
	const name = __tslpLoaderBasename( url );
	if ( name && ! texture.name ) texture.name = name;
	try {
		texture.userData = texture.userData || {};
		if ( typeof url === 'string' && url.length > 0 ) texture.userData.__tslpLoaderUrl = url;
	} catch ( _ ) {}
	return texture;
};

window.__tslpPatchTextureLoaderClass = function ( Ctor ) {
	if ( ! Ctor || ! Ctor.prototype || typeof Ctor.prototype.load !== 'function' || Ctor.prototype.__tslpCallbackLoadPatched ) return;
	Ctor.prototype.__tslpCallbackLoadPatched = true;
	const origLoad = Ctor.prototype.load;
	const _now = () => ( typeof window.__tslpRealNow === 'function' ? window.__tslpRealNow() : Date.now() );
	Ctor.prototype.load = function ( url, onLoad, onProgress, onError ) {
		window.__tslpLoaderPending = ( window.__tslpLoaderPending | 0 ) + 1;
		window.__tslpLoaderLastBusyAt = _now();
		let settled = false;
		const settle = () => {
			if ( settled ) return;
			settled = true;
			window.__tslpLoaderPending = Math.max( 0, ( window.__tslpLoaderPending | 0 ) - 1 );
			window.__tslpLoaderLastBusyAt = _now();
		};
		const wrapLoad = ( texture, ...rest ) => {
			window.__tslpMarkLoaderTexture( texture, url );
			try { if ( typeof onLoad === 'function' ) return onLoad.call( this, texture, ...rest ); }
			finally { settle(); }
		};
		const wrapError = ( err, ...rest ) => {
			try { if ( typeof onError === 'function' ) return onError.call( this, err, ...rest ); }
			finally { settle(); }
		};
		try {
			const result = origLoad.call( this, url, wrapLoad, onProgress, wrapError );
			window.__tslpMarkLoaderTexture( result, url );
			return result;
		} catch ( err ) {
			settle();
			throw err;
		}
	};
};

for ( const __tslpTextureLoaderCtor of [ Original.TextureLoader, Original.CubeTextureLoader, Original.DataTextureLoader, Original.ImageBitmapLoader ] ) {
	window.__tslpPatchTextureLoaderClass( __tslpTextureLoaderCtor );
}

function __syncFramebufferTextureForActiveTarget( renderer, texture, rectangle = null ) {
	if ( ! renderer || ! texture || texture.isFramebufferTexture !== true ) return null;
	const context = renderer._currentRenderContext || null;
	const target = context && context.renderTarget || null;
	const source = target && target.texture || null;
	if ( ! source ) return null;
	const targetWidth = Number( target.width || source.image && source.image.width || 0 );
	const targetHeight = Number( target.height || source.image && source.image.height || 0 );
	const copyX = Number( rectangle && rectangle.x || 0 );
	const copyY = Number( rectangle && rectangle.y || 0 );
	const copyWidth = Number( rectangle && ( rectangle.width ?? rectangle.z ) || texture.image && texture.image.width || 0 );
	const copyHeight = Number( rectangle && ( rectangle.height ?? rectangle.w ) || texture.image && texture.image.height || 0 );
	if ( rectangle && targetWidth > 0 && targetHeight > 0 && copyWidth > 0 && copyHeight > 0 && (
		copyX < 0 || copyY < 0 || copyX + copyWidth > targetWidth || copyY + copyHeight > targetHeight
	) ) return null;
	let currentTarget = null;
	try { currentTarget = typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : null; } catch ( _ ) {}
	const previousTarget = renderer._renderTarget;
	const patchTarget = ! currentTarget && previousTarget !== target;
	let changed = false;
	for ( const key of [ 'format', 'type', 'colorSpace' ] ) {
		if ( source[ key ] !== undefined && texture[ key ] !== source[ key ] ) {
			texture[ key ] = source[ key ];
			changed = true;
		}
	}
	if ( changed ) texture.needsUpdate = true;
	if ( patchTarget ) renderer._renderTarget = target;
	return () => {
		if ( patchTarget ) renderer._renderTarget = previousTarget;
	};
}

function __recordRenderableObjectCount( scene ) {
	if ( ! scene || typeof scene.traverse !== 'function' ) return;
	let count = 0;
	try {
		scene.traverse( ( object ) => {
			if ( object && object.visible !== false && object.geometry && object.material ) count ++;
		} );
	} catch ( _ ) {
		return 0;
	}
	const prev = window.__tslpRenderableObjectCount | 0;
	const observedMaximum = Math.max( prev, count );
	if ( observedMaximum !== prev ) {
		window.__tslpRenderableObjectCount = observedMaximum;
		window.__tslpRenderableLastBusyAt = typeof window.__tslpRealNow === 'function' ? window.__tslpRealNow() : Date.now();
	}
	return count;
}

function __isCubeCameraFaceReadinessRender( camera ) {
	const parent = camera && camera.parent;
	return !! ( parent && ( parent.isCubeCamera === true || parent.type === 'CubeCamera' ) );
}

( function patchStockDefaultLoadingManager() {
	const dlm = Original.DefaultLoadingManager;
	if ( ! dlm || dlm.__tslpStockPatched ) return;
	dlm.__tslpStockPatched = true;
	const _origStart = dlm.itemStart.bind( dlm );
	const _origEnd = dlm.itemEnd.bind( dlm );
	const _origError = dlm.itemError ? dlm.itemError.bind( dlm ) : null;
	const _now = () => ( typeof window.__tslpRealNow === 'function' ? window.__tslpRealNow() : Date.now() );
	dlm.itemStart = function ( url ) {
		window.__tslpLoaderPending = ( window.__tslpLoaderPending | 0 ) + 1;
		window.__tslpLoaderLastBusyAt = _now();
		return _origStart( url );
	};
	dlm.itemEnd = function ( url ) {
		window.__tslpLoaderPending = Math.max( 0, ( window.__tslpLoaderPending | 0 ) - 1 );
		window.__tslpLoaderLastBusyAt = _now();
		return _origEnd( url );
	};
	if ( _origError ) dlm.itemError = function ( url ) { return _origError( url ); };
} )();

	( function patchStockPMREMGenerator() {
		const PG = Original.PMREMGenerator;
		if ( ! PG || ! PG.prototype || PG.prototype.__tslpStockPatched ) return;
	PG.prototype.__tslpStockPatched = true;
	const begin = () => {
		__pmremRunning ++;
		window.__tslpPmremPending = ( window.__tslpPmremPending | 0 ) + 1;
	};
	const end = () => {
		__pmremRunning = Math.max( 0, __pmremRunning - 1 );
		window.__tslpPmremPending = Math.max( 0, ( window.__tslpPmremPending | 0 ) - 1 );
	};
	for ( const method of [ 'fromScene', 'fromCubemap', 'fromEquirectangular', 'fromTexture' ] ) {
		const orig = PG.prototype[ method ];
		if ( typeof orig !== 'function' ) continue;
		PG.prototype[ method ] = function ( ...args ) {
			begin();
			try { return orig.apply( this, args ); }
			finally { end(); }
		};
	}
	for ( const method of [ 'fromSceneAsync', 'fromCubemapAsync', 'fromEquirectangularAsync' ] ) {
		const orig = PG.prototype[ method ];
		if ( typeof orig !== 'function' ) continue;
		PG.prototype[ method ] = function ( ...args ) {
			begin();
			let result;
			try { result = orig.apply( this, args ); }
			catch ( err ) { end(); throw err; }
			return Promise.resolve( result ).finally( end );
		};
		}
	} )();

	function __isStockTRAAEffectNode( node ) {
		if ( ! node || typeof node === 'function' ) return false;
		const type = ( node.constructor && ( node.constructor.type || node.constructor.name ) ) || node.type || '';
		if ( type && type !== 'TRAANode' ) return false;
		return !! ( node && typeof node.updateBefore === 'function' && node._resolveMaterial && node._historyRenderTarget && node._resolveRenderTarget );
	}

	function __isStockTAAUEffectNode( node ) {
		if ( ! node || typeof node === 'function' ) return false;
		const type = ( node.constructor && ( node.constructor.type || node.constructor.name ) ) || node.type || '';
		if ( type && type !== 'TAAUNode' ) return false;
		return !! ( node && typeof node.updateBefore === 'function' && node._resolveMaterial && node._historyRenderTarget && node._resolveRenderTarget );
	}

	function __syncStockTRAAJitterIndex( traaNode ) {
		__sharedSynchronizeTemporalJitterNode( traaNode, { marker: '__tslpTRAAJitterSynchronized', installVelocityProjectionLifecycle: __installVelocityProjectionLifecycle } );
	}

	function __syncStockTAAUJitterIndex( taauNode ) {
		__sharedSynchronizeTemporalJitterNode( taauNode, { marker: '__tslpTAAUJitterSynchronized', installVelocityProjectionLifecycle: __installVelocityProjectionLifecycle } );
	}

	function __scanForStockTAAUNodes( node, seen = new Set(), depth = 0 ) {
		if ( ! node || depth > 24 || seen.has( node ) ) return;
		if ( typeof node !== 'object' && typeof node !== 'function' ) return;
		seen.add( node );
		if ( __isStockTRAAEffectNode( node ) ) {
			__syncStockTRAAJitterIndex( node );
			return;
		}
		if ( __isStockTAAUEffectNode( node ) ) {
			__syncStockTAAUJitterIndex( node );
			return;
		}
		const keys = [];
		try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) {}
		const skip = new Set( [ 'parent', 'children', '_cache', 'scene', 'camera', 'renderer', 'geometry', 'material', 'domElement' ] );
		for ( const key of keys ) {
			if ( skip.has( key ) ) continue;
			let child;
			try { child = node[ key ]; } catch ( _ ) { continue; }
			if ( ! child ) continue;
			if ( Array.isArray( child ) ) {
				for ( const item of child ) if ( item && ( typeof item === 'object' || typeof item === 'function' ) ) __scanForStockTAAUNodes( item, seen, depth + 1 );
			} else if ( typeof child === 'object' || typeof child === 'function' ) {
				__scanForStockTAAUNodes( child, seen, depth + 1 );
			}
		}
	}

	const __StockRenderPipelineBase = Original.RenderPipeline || Original.PostProcessing;
	export class RenderPipeline extends __StockRenderPipelineBase {
		render( ...args ) {
			try { window.__tslpLastRenderPipeline = this; } catch ( _ ) {}
			try { if ( this.outputNode ) __scanForStockTAAUNodes( this.outputNode ); } catch ( _ ) {}
			return super.render( ...args );
		}
	}

	export class PostProcessing extends RenderPipeline {}

	function __trackDebugShaderAsync( renderer ) {
		const debug = renderer && renderer.debug;
		if ( ! debug || debug.__tslpGetShaderAsyncPatched || typeof debug.getShaderAsync !== 'function' ) return;
		const originalGetShaderAsync = debug.getShaderAsync;
		try {
			Object.defineProperty( debug, '__tslpGetShaderAsyncPatched', {
				value: true,
				configurable: true,
			} );
		} catch ( _ ) {
			debug.__tslpGetShaderAsyncPatched = true;
		}
		debug.getShaderAsync = function ( ...args ) {
			window.__tslpCompilePending = ( window.__tslpCompilePending | 0 ) + 1;
			const settle = () => { window.__tslpCompilePending = Math.max( 0, ( window.__tslpCompilePending | 0 ) - 1 ); };
			try {
				const p = originalGetShaderAsync.apply( this, args );
				return Promise.resolve( p ).then( ( v ) => { settle(); return v; }, ( e ) => { settle(); throw e; } );
			} catch ( err ) {
				settle();
				throw err;
			}
		};
	}

	export class WebGPURenderer extends Original.WebGPURenderer {
	constructor( ...args ) {
		super( ...args );
		// Wedge 4: expose the harness's WebGPURenderer so the runner can read
		// nodeFrame.time at screenshot time (the "freeze clock") to pin replay.
		window.__tslpHarnessRenderer = this;
		__trackDebugShaderAsync( this );
	}
		setAnimationLoop( callback ) {
			const wrap = typeof window.__tslpWrapAnimationLoop === 'function' ? window.__tslpWrapAnimationLoop : null;
			return super.setAnimationLoop( wrap ? wrap( callback, this ) : callback );
		}
		copyFramebufferToTexture( texture, rectangle = null ) {
			const restore = __syncFramebufferTextureForActiveTarget( this, texture, rectangle );
			try {
				return super.copyFramebufferToTexture( texture, rectangle );
			} finally {
				if ( restore ) restore();
			}
		}
		compileAsync( scene, camera, ...rest ) {
			if ( __pmremRunning > 0 ) return typeof super.compileAsync === 'function' ? super.compileAsync( scene, camera, ...rest ) : Promise.resolve();
			if ( typeof super.compileAsync !== 'function' ) return Promise.resolve();
			window.__tslpCompilePending = ( window.__tslpCompilePending | 0 ) + 1;
		const settle = () => { window.__tslpCompilePending = Math.max( 0, ( window.__tslpCompilePending | 0 ) - 1 ); };
		const p = super.compileAsync( scene, camera, ...rest );
		return Promise.resolve( p ).then( ( v ) => { settle(); return v; }, ( e ) => { settle(); throw e; } );
	}
	render( scene, camera ) {
		if ( __pmremRunning > 0 ) return super.render( scene, camera );
		// CubeCamera equirectangular conversions use a private one-mesh scene.
		// Ignore only those six face renders: authored scenes reached through a
		// RenderPipeline/PassNode are also nested and remain valid readiness.
		if ( ! __isCubeCameraFaceReadinessRender( camera ) ) __recordRenderableObjectCount( scene );
		return super.render( scene, camera );
	}
}
`;

}

function auxVirtualModule() {

	return `
import { registerAuxArtifacts } from '@tsl-precompile/runtime';
import { materializeArtifactAttributeDescriptors } from '@tsl-precompile/contract/attribute-generators';
import { materializeArtifactVariantSelectorAdapters } from '@tsl-precompile/contract/variant-selector-adapter';

const __state = window.__TSLP_E2E || {};
const __entries = __state.mode === 'replay' && __state.artifacts && Array.isArray( __state.artifacts.aux )
	? __state.artifacts.aux
	: [];

if ( __entries.length > 0 ) {
	materializeArtifactAttributeDescriptors( __entries );
	materializeArtifactVariantSelectorAdapters( __entries );
	registerAuxArtifacts( __entries );
}

export default __entries;
`;

}

function fullWebgpuAutoModule() {

	return `
import * as Original from '/build/three.webgpu.js';
export * from '/build/three.webgpu.js';
import { installPrecompileMarker, setDevRenderer } from '/__tslp_runtime/precompile-marker.js';
import { installRangeAttributeCapture } from '/__tslp_runtime/range-attribute-capture.js';
import { precompileAuxiliary, precompileRendererOutput } from '/__tslp_runtime/aux-marker.js';
import { rememberBackgroundCaptureRenderTarget as __rememberBackgroundCaptureRenderTarget } from '/__tslp_runtime/capture-render-target.js';
import { collectEffectNodes as __collectRegisteredEffectNodes } from '/__tslp_runtime/slim-support/postprocess-effects.js';
import { installVelocityProjectionLifecycle as __installVelocityProjectionLifecycle } from '/__tslp_runtime/slim-support/velocity-projection-lifecycle.js';
import { createRenderObjectContextSelector as __createRenderObjectContextSelector, projectRenderObjectContextSelector as __projectRenderObjectContextSelector } from '/__tslp_contract/render-selector.js';
import { MATERIAL_TEXTURE_PROPS as __MATERIAL_TEXTURE_PROPS, MATERIAL_NODE_TEXTURE_KEYS as __MATERIAL_NODE_TEXTURE_KEYS } from '/__tslp_contract/texture-props.js';
import { createMaterialContextKey as __createMaterialContextKey, createObjectIdentityKeyer as __createObjectIdentityKeyer, createStockMaterialTopologyKey as __createStockMaterialTopologyKey, getMaterialContextMap as __getMaterialContextMap, getSceneTopologyMap as __getSceneTopologyMap } from '/__tslp_batch/material-context-cache.mjs';
import { createCubeCapturePrearmRegistry as __createCubeCapturePrearmRegistry, isVerifiedCubeRenderTarget as __isVerifiedCubeRenderTarget } from '/__tslp_batch/cube-capture-prearm.mjs';
import { createLayeredCapturePrearmRegistry as __createLayeredCapturePrearmRegistry, isVerifiedLayeredRenderTarget as __isVerifiedLayeredRenderTarget } from '/__tslp_batch/layered-capture-prearm.mjs';
import { synchronizeTemporalJitterNode as __sharedSynchronizeTemporalJitterNode } from '/__tslp_batch/temporal-jitter.mjs';

const __classifyDirectNodeMaterialCapture = ${ classifyDirectNodeMaterialCapture.toString() };
const __state = window.__TSLP_E2E || { example: 'unknown' };
const __counts = Object.create( null );
const __pending = [];
const __seenMaterialContexts = new WeakMap();
const __captureTopologyRepresentativesByScene = new WeakMap();
const __captureTopologyIdentity = __createObjectIdentityKeyer();
const __cubeCapturePrearmRegistry = __createCubeCapturePrearmRegistry();
const __layeredCapturePrearmRegistry = __createLayeredCapturePrearmRegistry();
const __postProcessingPipelines = new Set();
const __postProcessingSubpassMaterials = new WeakSet();
const __nonPostProcessingSubpassMaterials = new WeakSet();
const __auxPromises = new Set();
const __auxScenes = new Map();
let __renderer = null;
let __pmremRunning = 0;
let __lastScene = null;
let __lastCamera = null;
window.__tslpPmremPending = window.__tslpPmremPending || 0;
window.__tslpPrecompilePending = window.__tslpPrecompilePending || 0;
window.__tslpAuxCapturePending = window.__tslpAuxCapturePending || 0;

function __tslpLoaderBasename( value ) {
	const raw = String( value || '' );
	const tail = raw.split( /[?#]/ )[ 0 ].split( '/' ).filter( Boolean ).pop() || raw;
	return tail || '';
}

window.__tslpMarkLoaderTexture = function ( texture, url ) {
	if ( ! texture || texture.isTexture !== true ) return texture;
	const name = __tslpLoaderBasename( url );
	if ( name && ! texture.name ) texture.name = name;
	try {
		texture.userData = texture.userData || {};
		if ( typeof url === 'string' && url.length > 0 ) texture.userData.__tslpLoaderUrl = url;
	} catch ( _ ) {}
	return texture;
};

window.__tslpPatchTextureLoaderClass = function ( Ctor ) {
	if ( ! Ctor || ! Ctor.prototype || typeof Ctor.prototype.load !== 'function' || Ctor.prototype.__tslpCallbackLoadPatched ) return;
	Ctor.prototype.__tslpCallbackLoadPatched = true;
	const origLoad = Ctor.prototype.load;
	const _now = () => ( typeof window.__tslpRealNow === 'function' ? window.__tslpRealNow() : Date.now() );
	Ctor.prototype.load = function ( url, onLoad, onProgress, onError ) {
		window.__tslpLoaderPending = ( window.__tslpLoaderPending | 0 ) + 1;
		window.__tslpLoaderLastBusyAt = _now();
		let settled = false;
		const settle = () => {
			if ( settled ) return;
			settled = true;
			window.__tslpLoaderPending = Math.max( 0, ( window.__tslpLoaderPending | 0 ) - 1 );
			window.__tslpLoaderLastBusyAt = _now();
		};
		const wrapLoad = ( texture, ...rest ) => {
			window.__tslpMarkLoaderTexture( texture, url );
			try { if ( typeof onLoad === 'function' ) return onLoad.call( this, texture, ...rest ); }
			finally { settle(); }
		};
		const wrapError = ( err, ...rest ) => {
			try { if ( typeof onError === 'function' ) return onError.call( this, err, ...rest ); }
			finally { settle(); }
		};
		try {
			const result = origLoad.call( this, url, wrapLoad, onProgress, wrapError );
			window.__tslpMarkLoaderTexture( result, url );
			return result;
		} catch ( err ) {
			settle();
			throw err;
		}
	};
};

for ( const __tslpTextureLoaderCtor of [ Original.TextureLoader, Original.CubeTextureLoader, Original.DataTextureLoader, Original.ImageBitmapLoader ] ) {
	window.__tslpPatchTextureLoaderClass( __tslpTextureLoaderCtor );
}

function __syncFramebufferTextureForActiveTarget( renderer, texture, rectangle = null ) {
	if ( ! renderer || ! texture || texture.isFramebufferTexture !== true ) return null;
	const context = renderer._currentRenderContext || null;
	const target = context && context.renderTarget || null;
	const source = target && target.texture || null;
	if ( ! source ) return null;
	const targetWidth = Number( target.width || source.image && source.image.width || 0 );
	const targetHeight = Number( target.height || source.image && source.image.height || 0 );
	const copyX = Number( rectangle && rectangle.x || 0 );
	const copyY = Number( rectangle && rectangle.y || 0 );
	const copyWidth = Number( rectangle && ( rectangle.width ?? rectangle.z ) || texture.image && texture.image.width || 0 );
	const copyHeight = Number( rectangle && ( rectangle.height ?? rectangle.w ) || texture.image && texture.image.height || 0 );
	if ( rectangle && targetWidth > 0 && targetHeight > 0 && copyWidth > 0 && copyHeight > 0 && (
		copyX < 0 || copyY < 0 || copyX + copyWidth > targetWidth || copyY + copyHeight > targetHeight
	) ) return null;
	let currentTarget = null;
	try { currentTarget = typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : null; } catch ( _ ) {}
	const previousTarget = renderer._renderTarget;
	const patchTarget = ! currentTarget && previousTarget !== target;
	let changed = false;
	for ( const key of [ 'format', 'type', 'colorSpace' ] ) {
		if ( source[ key ] !== undefined && texture[ key ] !== source[ key ] ) {
			texture[ key ] = source[ key ];
			changed = true;
		}
	}
	if ( changed ) texture.needsUpdate = true;
	if ( patchTarget ) renderer._renderTarget = target;
	return () => {
		if ( patchTarget ) renderer._renderTarget = previousTarget;
	};
}

function __recordRenderableObjectCount( scene ) {
	if ( ! scene || typeof scene.traverse !== 'function' ) return;
	let count = 0;
	try {
		scene.traverse( ( object ) => {
			if ( object && object.visible !== false && object.geometry && object.material ) count ++;
		} );
	} catch ( _ ) {
		return 0;
	}
	const prev = window.__tslpRenderableObjectCount | 0;
	const observedMaximum = Math.max( prev, count );
	if ( observedMaximum !== prev ) {
		window.__tslpRenderableObjectCount = observedMaximum;
		window.__tslpRenderableLastBusyAt = typeof window.__tslpRealNow === 'function' ? window.__tslpRealNow() : Date.now();
	}
	return count;
}

function __isCubeCameraFaceReadinessRender( camera ) {
	const parent = camera && camera.parent;
	return !! ( parent && ( parent.isCubeCamera === true || parent.type === 'CubeCamera' ) );
}

// Bump window.__tslpLoaderPending around every three.js loader item so the
// Playwright wait gate doesn't screenshot while HDR/GLTF/MaterialX/etc. are
// still in flight. All stock three.js loaders use DefaultLoadingManager unless
// constructed with an explicit one; itemStart/itemEnd are the lower-level hooks
// the manager calls per-item, so wrapping them catches every default loader.
( function patchDefaultLoadingManager() {
	const dlm = Original.DefaultLoadingManager;
	if ( ! dlm || dlm.__tslpPatched ) return;
	dlm.__tslpPatched = true;
	const _origStart = dlm.itemStart.bind( dlm );
	const _origEnd = dlm.itemEnd.bind( dlm );
	const _origError = dlm.itemError ? dlm.itemError.bind( dlm ) : null;
	const _now = () => ( typeof window.__tslpRealNow === 'function' ? window.__tslpRealNow() : Date.now() );
	dlm.itemStart = function ( url ) {
		window.__tslpLoaderPending = ( window.__tslpLoaderPending | 0 ) + 1;
		window.__tslpLoaderLastBusyAt = _now();
		return _origStart( url );
	};
	dlm.itemEnd = function ( url ) {
		window.__tslpLoaderPending = Math.max( 0, ( window.__tslpLoaderPending | 0 ) - 1 );
		window.__tslpLoaderLastBusyAt = _now();
		return _origEnd( url );
	};
	if ( _origError ) dlm.itemError = function ( url ) {
		// itemEnd is also called after itemError by Loader.load, so don't double-decrement here.
		return _origError( url );
	};
} )();

installRangeAttributeCapture( Original );
installPrecompileMarker( Original, {
	devEndpoint: '/__tslp__/capture?example=' + encodeURIComponent( __state.example ),
} );

( function patchCapturePMREMGenerator() {
	const PG = Original.PMREMGenerator;
	if ( ! PG || ! PG.prototype || PG.prototype.__tslpCapturePatched ) return;
	PG.prototype.__tslpCapturePatched = true;
	const begin = () => {
		__pmremRunning ++;
		window.__tslpPmremPending = ( window.__tslpPmremPending | 0 ) + 1;
	};
	const end = () => {
		__pmremRunning = Math.max( 0, __pmremRunning - 1 );
		window.__tslpPmremPending = Math.max( 0, ( window.__tslpPmremPending | 0 ) - 1 );
	};
	for ( const method of [ 'fromScene', 'fromCubemap', 'fromEquirectangular', 'fromTexture' ] ) {
		const orig = PG.prototype[ method ];
		if ( typeof orig !== 'function' ) continue;
		PG.prototype[ method ] = function ( ...args ) {
			begin();
			try {
				return orig.apply( this, args );
			} finally {
				end();
			}
		};
	}
	for ( const method of [ 'fromSceneAsync', 'fromCubemapAsync', 'fromEquirectangularAsync' ] ) {
		const orig = PG.prototype[ method ];
		if ( typeof orig !== 'function' ) continue;
		PG.prototype[ method ] = function ( ...args ) {
			begin();
			let result;
			try {
				result = orig.apply( this, args );
			} catch ( err ) {
				end();
				throw err;
			}
			return Promise.resolve( result ).finally( end );
		};
	}
} )();

function __cameraSeesObject( camera, object ) {
	if ( ! camera || ! object || ! camera.layers || ! object.layers ) return true;
	try { return camera.layers.test( object.layers ); } catch ( _ ) { return true; }
}

function __captureRenderTarget( renderer ) {
	try {
		const target = renderer && typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : null;
		if ( target ) return target;
	} catch ( _ ) {}
	try {
		const target = renderer && typeof renderer._getFrameBufferTarget === 'function' ? renderer._getFrameBufferTarget() : null;
		return target && target.isPostProcessingRenderTarget === true ? target : null;
	} catch ( _ ) {
		return null;
	}
}

function __queueCubeCapturePrearm( pendingItem, prearmQueue, context ) {
	if ( ! Array.isArray( prearmQueue ) || ! pendingItem || ! context ) return;
	if ( ! __cubeCapturePrearmRegistry.claim( {
		material: pendingItem.material,
		renderer: context.renderer,
		renderTarget: context.renderTarget,
		captureMaintenance: __isCaptureMaintenanceRender(),
	} ) ) return;
	prearmQueue.push( { pendingItem, ...context } );
}

function __prearmCubeCapture( task ) {
	const { pendingItem, renderer, renderTarget, scene, camera, object, mrt } = task || {};
	const material = pendingItem && pendingItem.material;
	if ( ! pendingItem || pendingItem.done || typeof material.precompile !== 'function' ) return;
	try {

		material.precompile( pendingItem.name + ':cube-prearm', {
			__tslpAutoMark: true,
			__tslpObserveNextRender: true,
			renderer,
			scene,
			camera,
			object,
			renderTarget,
			mrt,
		} );

	} catch ( err ) {

		console.warn( '[tslp-e2e] dynamic cube pre-arm failed; deferring to capture flush:', err && err.message || err );

	}
}

function __prearmLayeredCapture( pendingItem, renderer, renderTarget, object, camera, mrt ) {
	const material = pendingItem && pendingItem.material;
	if ( ! pendingItem || pendingItem.done || typeof material.precompile !== 'function' ) return false;
	if ( ! __layeredCapturePrearmRegistry.claim( {
		material,
		renderer,
		renderTarget,
		captureMaintenance: __isCaptureMaintenanceRender(),
	} ) ) return false;
	try {

		// Keep the ordinary queue identity. The r185 QuadMesh burst is the real
		// capture: array and 3D siblings join one observed variant family before
		// the extraction microtask closes it.
		material.precompile( pendingItem.name, {
			__tslpAutoMark: true,
			__tslpObserveNextRender: true,
			renderer,
			scene: null,
			camera,
			object,
			renderTarget,
			mrt,
		} );
		pendingItem.done = true;
		return true;

	} catch ( err ) {

		console.warn( '[tslp-e2e] layered target pre-arm failed; deferring to capture flush:', err && err.message || err );
		return false;

	}
}

function __mark( material, className, sourceObject = null, camera = null, renderer = null, renderTargetOverride = undefined, prearmQueue = null, directSceneContext = null ) {
	if ( ! material ) return null;
	// A Scene traversal still visits objects outside the active camera layers.
	// Do not let an earlier, hidden pass freeze its render target topology onto
	// the pending capture. PassNode can render the same object later with a
	// different layer mask and a depthless/single-sample target (for example
	// the r185 volume pipeline).
	if ( sourceObject && camera && ! __cameraSeesObject( camera, sourceObject ) ) return null;
	if ( sourceObject && ! material.__tslpPrecompileObject ) Object.defineProperty( material, '__tslpPrecompileObject', { value: sourceObject, configurable: true } );
	const hasCameraHint = Object.prototype.hasOwnProperty.call( material, '__tslpPrecompileCamera' );
	const currentCameraSeesObject = hasCameraHint ? __cameraSeesObject( material.__tslpPrecompileCamera, sourceObject ) : false;
	const nextCameraSeesObject = __cameraSeesObject( camera, sourceObject );
	if ( camera && nextCameraSeesObject && ( ! hasCameraHint || ! currentCameraSeesObject ) ) {
		Object.defineProperty( material, '__tslpPrecompileCamera', { value: camera, configurable: true } );
	}
	if ( sourceObject && ! Object.prototype.hasOwnProperty.call( material, '__tslpArrayCamera' ) ) {
		const arrayCameraHint = camera && camera.isArrayCamera === true ? camera : null;
		Object.defineProperty( material, '__tslpArrayCamera', { value: arrayCameraHint, configurable: true } );
	}
	const sourceScene = sourceObject ? __findParentScene( sourceObject ) : null;
	const authoredScene = directSceneContext || sourceScene;
	if ( authoredScene ) {
		const currentScene = material.__tslpPrecompileScene || null;
		const shouldSetScene = directSceneContext !== null ||
			! currentScene ||
			( __countSceneLights( currentScene ) === 0 && __countSceneLights( authoredScene ) > 0 );
		if ( shouldSetScene ) Object.defineProperty( material, '__tslpPrecompileScene', { value: authoredScene, configurable: true } );
	}
	let renderTarget = renderTargetOverride;
	let mrt = null;
	if ( renderTarget === undefined ) {
		try { renderTarget = __captureRenderTarget( renderer ); } catch ( _ ) { renderTarget = null; }
	}
	try { mrt = renderer && typeof renderer.getMRT === 'function' ? renderer.getMRT() : null; } catch ( _ ) {}
	const captureScene = directSceneContext || sourceScene || material.__tslpPrecompileScene || null;
	const captureCamera = nextCameraSeesObject ? camera : material.__tslpPrecompileCamera || camera || null;
	const captureObject = sourceObject || material.__tslpPrecompileObject || null;
	if ( ! mrt && captureScene && captureScene.userData ) mrt = captureScene.userData.__tslp_mrtNode || null;
	const baseContextKey = __createMaterialContextKey( __createRenderObjectContextSelector, {
		object: captureObject,
		material,
		renderer,
		// Render targets and MRT are represented artifact variants, not distinct
		// material names. Keep only renderer configuration in this queue key.
		renderTarget: null,
		mrt: null,
	}, __projectRenderObjectContextSelector );
	const contextKey = directSceneContext
		? baseContextKey + ':direct-scene:' + __captureTopologyIdentity( directSceneContext )
		: baseContextKey;
	const seenContexts = __getMaterialContextMap( __seenMaterialContexts, material, true );
	const existingItem = seenContexts.get( contextKey );
	if ( existingItem ) {

		__queueCubeCapturePrearm( existingItem, prearmQueue, {
			renderer,
			renderTarget,
			scene: captureScene,
			camera: captureCamera,
			object: captureObject,
			mrt,
		} );
		return existingItem;

	}
	const n = ( __counts[ className ] || 0 ) + 1;
	__counts[ className ] = n;
	const name = __state.example + ':' + className + ':' + n;
	material.name = material.name || name;
	const topologyKey = __createStockMaterialTopologyKey( {
		material,
		object: captureObject,
		className,
		contextKey,
		nodeKeys: __MATERIAL_NODE_TEXTURE_KEYS,
		textureProps: __MATERIAL_TEXTURE_PROPS,
		getObjectIdentity: __captureTopologyIdentity,
	} );
	const topologyRepresentatives = topologyKey && captureScene
		? __getSceneTopologyMap( __captureTopologyRepresentativesByScene, captureScene, true )
		: null;
	const topologyRepresentative = topologyRepresentatives && topologyRepresentatives.get( topologyKey );
	if ( topologyRepresentative ) {

		seenContexts.set( contextKey, topologyRepresentative );
		window.__tslpCaptureTopologyAliases = ( window.__tslpCaptureTopologyAliases | 0 ) + 1;
		__queueCubeCapturePrearm( topologyRepresentative, prearmQueue, {
			renderer,
			renderTarget,
			scene: captureScene,
			camera: captureCamera,
			object: captureObject,
			mrt,
		} );
		return topologyRepresentative;

	}
	const pendingItem = {
		material,
		name,
		scene: captureScene,
		camera: captureCamera,
		object: captureObject,
		renderer,
		renderTarget,
		mrt,
		done: false,
	};
	seenContexts.set( contextKey, pendingItem );
	if ( topologyRepresentatives ) topologyRepresentatives.set( topologyKey, pendingItem );
	__pending.push( pendingItem );
	__queueCubeCapturePrearm( pendingItem, prearmQueue, {
		renderer,
		renderTarget,
		scene: captureScene,
		camera: captureCamera,
		object: captureObject,
		mrt,
	} );
	// Do NOT __flush() here. precompile() must run AFTER the example
	// has finished setting up the scene (background, environment,
	// lights). Many examples create materials inside an async loader
	// callback then set scene.environment on the next line — running
	// precompile from the material constructor would freeze an artifact
	// without the IBL bindings. We defer precompile to the first
	// render()/compile() hook below, by which time scene state is
	// guaranteed to be fully wired.
	return pendingItem;
}

function __findParentScene( object ) {
	let current = object || null;
	while ( current ) {
		if ( current.isScene === true ) return current;
		current = current.parent || null;
	}
	return null;
}

function __countSceneLights( scene ) {
	if ( ! scene || typeof scene.traverse !== 'function' ) return 0;
	let count = 0;
	try {
		scene.traverse( ( object ) => {
			if ( object && object.isLight === true ) count ++;
		} );
	} catch ( _ ) {}
	return count;
}

function __classNameForMaterial( material ) {
	if ( ! material ) return 'Material';
	const type = material.type || '';
	if ( type === 'Line2NodeMaterial' ) return 'Line2NodeMaterial';
	if ( material.isMeshBasicNodeMaterial || material.isMeshBasicMaterial ) return 'MeshBasicNodeMaterial';
	if ( material.isMeshSSSNodeMaterial || material.type === 'MeshSSSNodeMaterial' ) return 'MeshSSSNodeMaterial';
	if ( material.isMeshPhysicalNodeMaterial || material.isMeshPhysicalMaterial ) return 'MeshPhysicalNodeMaterial';
	if ( material.isMeshStandardNodeMaterial || material.isMeshStandardMaterial ) return 'MeshStandardNodeMaterial';
	if ( material.isMeshLambertNodeMaterial || material.isMeshLambertMaterial ) return 'MeshLambertNodeMaterial';
	if ( material.isMeshPhongNodeMaterial || material.isMeshPhongMaterial ) return 'MeshPhongNodeMaterial';
	if ( material.isMeshToonNodeMaterial || material.isMeshToonMaterial ) return 'MeshToonNodeMaterial';
	if ( material.isMeshNormalNodeMaterial || material.isMeshNormalMaterial ) return 'MeshNormalNodeMaterial';
	if ( material.isMeshMatcapNodeMaterial || material.isMeshMatcapMaterial ) return 'MeshMatcapNodeMaterial';
	if ( material.isLine2NodeMaterial ) return 'Line2NodeMaterial';
	if ( material.isLineBasicNodeMaterial || material.isLineBasicMaterial ) return 'LineBasicNodeMaterial';
	if ( material.isPointsNodeMaterial || material.isPointsMaterial ) return 'PointsNodeMaterial';
	if ( material.isSpriteNodeMaterial || material.isSpriteMaterial ) return 'SpriteNodeMaterial';
	if ( material.isVolumeNodeMaterial || type === 'VolumeNodeMaterial' ) return 'VolumeNodeMaterial';
	if ( type === 'MeshBasicNodeMaterial' || type === 'MeshBasicMaterial' ) return 'MeshBasicNodeMaterial';
	if ( type === 'MeshSSSNodeMaterial' ) return 'MeshSSSNodeMaterial';
	if ( type === 'MeshPhysicalNodeMaterial' || type === 'MeshPhysicalMaterial' ) return 'MeshPhysicalNodeMaterial';
	if ( type === 'MeshStandardNodeMaterial' || type === 'MeshStandardMaterial' ) return 'MeshStandardNodeMaterial';
	if ( type === 'MeshLambertNodeMaterial' || type === 'MeshLambertMaterial' ) return 'MeshLambertNodeMaterial';
	if ( type === 'MeshPhongNodeMaterial' || type === 'MeshPhongMaterial' ) return 'MeshPhongNodeMaterial';
	if ( type === 'MeshToonNodeMaterial' || type === 'MeshToonMaterial' ) return 'MeshToonNodeMaterial';
	if ( type === 'MeshNormalNodeMaterial' || type === 'MeshNormalMaterial' ) return 'MeshNormalNodeMaterial';
	if ( type === 'MeshMatcapNodeMaterial' || type === 'MeshMatcapMaterial' ) return 'MeshMatcapNodeMaterial';
	if ( type === 'Line2NodeMaterial' ) return 'Line2NodeMaterial';
	if ( type === 'LineBasicNodeMaterial' || type === 'LineBasicMaterial' ) return 'LineBasicNodeMaterial';
	if ( type === 'PointsNodeMaterial' || type === 'PointsMaterial' ) return 'PointsNodeMaterial';
	if ( type === 'SpriteNodeMaterial' || type === 'SpriteMaterial' ) return 'SpriteNodeMaterial';
	if ( /NodeMaterial$/.test( type ) ) return type;
	return material.constructor && material.constructor.name || 'Material';
}

function __isRetroPassRenderTarget( renderer ) {
	try {
		const target = renderer && typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : null;
		const texture = target && target.texture;
		return !! ( texture
			&& texture.magFilter === Original.NearestFilter
			&& texture.minFilter === Original.NearestFilter );
	} catch ( _ ) {
		return false;
	}
}

function __isRetroPassGeneratedMaterial( renderer, scene, material, className ) {
	return !! ( material
		&& scene && scene.isScene === true && scene.userData && scene.userData.__tslpUserScene === true
		&& ! scene.overrideMaterial
		&& __isRetroPassRenderTarget( renderer )
		&& /^(?:MeshBasic|MeshPhong)NodeMaterial$/.test( className || __classNameForMaterial( material ) ) );
}

function __markSceneMaterials( scene, camera = null, renderer = null, renderTargetOverride = undefined, prearmQueue = null ) {
	if ( ! scene || typeof scene.traverse !== 'function' ) return;
	if ( scene.isScene !== true ) return;
	if ( ! scene.userData || scene.userData.__tslpUserScene !== true ) return;
	if ( scene.userData && scene.userData.__tslpSyntheticCaptureScene ) return;
	if ( camera && camera.isArrayCamera === true && scene.overrideMaterial ) return;
	// Three reuses this renderer-owned override for shadow passes and clears its
	// caster-specific positionNode after the pass. Capturing it later as a user
	// material freezes the cleared topology instead of the real shadow artifact.
	if ( scene.overrideMaterial && scene.overrideMaterial.isShadowPassMaterial === true ) return;
	if ( scene.overrideMaterial ) {
		if ( scene.overrideMaterial.visible !== false ) {
			let representative = null;
			scene.traverse( ( object ) => {
				if ( ! representative && object && object.geometry && object.visible !== false ) representative = object;
			} );
			__mark( scene.overrideMaterial, __classNameForMaterial( scene.overrideMaterial ), representative, camera, renderer, renderTargetOverride, prearmQueue );
		}
		// Renderer.overrideMaterial replaces every object's own material for
		// this pass. Leave the originals unmarked until a pass actually uses
		// them so their camera/lights/target selector comes from real topology.
		return;
	}
	scene.traverse( ( object ) => {
		const material = object && object.material;
		const materials = Array.isArray( material ) ? material : material ? [ material ] : [];
		for ( const m of materials ) {

			if ( m && m.visible === false ) continue;
			__mark( m, __classNameForMaterial( m ), object, camera, renderer, renderTargetOverride, prearmQueue );

		}
	} );
}

function __markHiddenCubeSceneMaterialsForMainOutput( scene, camera, renderer ) {
	if ( ! scene || typeof scene.traverse !== 'function' || scene.isScene !== true ) return;
	if ( ! scene.userData || scene.userData.__tslpUserScene !== true || scene.userData.__tslpSyntheticCaptureScene ) return;
	scene.traverse( ( object ) => {
		const material = object && object.material;
		const materials = Array.isArray( material ) ? material : material ? [ material ] : [];
		for ( const m of materials ) {

			if ( m && m.visible === false ) __mark( m, __classNameForMaterial( m ), object, camera, renderer );

		}
	} );
}

( function patchDynamicCubeCaptureBoundary() {
	const prototype = Original.CubeCamera && Original.CubeCamera.prototype;
	if ( ! prototype || prototype.__tslpCapturePrearmPatched || typeof prototype.update !== 'function' ) return;
	prototype.__tslpCapturePrearmPatched = true;
	const originalUpdate = prototype.update;
	prototype.update = function ( renderer, scene, ...args ) {

		const renderTarget = this.renderTarget;
		const prearmQueue = [];
		if ( __pmremRunning === 0 && ! __isCaptureMaintenanceRender() && __isVerifiedCubeRenderTarget( renderTarget ) ) {

			const camera = Array.isArray( this.children ) ? this.children[ 0 ] || null : null;
			// The hidden reflective material is main-output-only in the dynamic
			// cubemap pattern. Queue its normal flush capture before pre-arming the
			// visible cube family turns later renders into capture maintenance.
			__markHiddenCubeSceneMaterialsForMainOutput( scene, camera, renderer );
			__markSceneMaterials( scene, camera, renderer, renderTarget, prearmQueue );
			for ( const task of prearmQueue ) __prearmCubeCapture( task );

		}
		const result = originalUpdate.call( this, renderer, scene, ...args );
		// Keep the ordinary pending capture independent from the one-shot cube
		// pre-arm. CubeCamera has restored the renderer target here, so the later
		// flush deterministically captures the normal output sibling even if the
		// real-render harvest closes before the application's main draw.
		if ( prearmQueue.length > 0 ) {
			let outputTarget = null;
			let outputMRT = null;
			try { outputTarget = __captureRenderTarget( renderer ); } catch ( _ ) {}
			try { outputMRT = renderer && typeof renderer.getMRT === 'function' ? renderer.getMRT() : null; } catch ( _ ) {}
			for ( const task of prearmQueue ) {
				task.pendingItem.renderer = renderer;
				task.pendingItem.scene = scene;
				task.pendingItem.renderTarget = outputTarget;
				task.pendingItem.mrt = outputMRT;
			}
		}
		return result;

	};
} )();

( function patchLayeredQuadCaptureBoundary() {
	const prototype = Original.QuadMesh && Original.QuadMesh.prototype;
	if ( ! prototype || prototype.__tslpLayeredCapturePrearmPatched || typeof prototype.render !== 'function' ) return;
	prototype.__tslpLayeredCapturePrearmPatched = true;
	const originalRender = prototype.render;
	prototype.render = function ( renderer, ...args ) {

		let renderTarget = null;
		try { renderTarget = __captureRenderTarget( renderer ); } catch ( _ ) {}
		if (
			__pmremRunning === 0 &&
			! __isCaptureMaintenanceRender() &&
			__isVerifiedLayeredRenderTarget( renderTarget )
		) {

			let mrt = null;
			try { mrt = renderer && typeof renderer.getMRT === 'function' ? renderer.getMRT() : null; } catch ( _ ) {}
			const materials = Array.isArray( this.material ) ? this.material : this.material ? [ this.material ] : [];
			for ( const material of materials ) {

				if ( ! material || material.visible === false ) continue;
				const pendingItem = __mark(
					material,
					__classNameForMaterial( material ),
					this,
					this.camera || null,
					renderer,
					renderTarget,
				);
				__prearmLayeredCapture(
					pendingItem,
					renderer,
					renderTarget,
					this,
					this.camera || null,
					mrt,
				);

			}

		}
		return originalRender.call( this, renderer, ...args );

	};
} )();

function __collectRegisteredPostprocessSubpassMaterials( pipelines, collectEffectNodes, out ) {
	for ( const pipeline of pipelines || [] ) {
		let matches = [];
		try {
			matches = collectEffectNodes( pipeline && pipeline.outputNode );
		} catch ( _ ) {
			continue;
		}
		const indexByHandler = new Map();
		for ( const match of Array.isArray( matches ) ? matches : [] ) {
			const handler = match && match.handler;
			if ( ! handler || typeof handler.subPasses !== 'function' ) continue;
			const handlerName = handler.name;
			const effectIndex = indexByHandler.get( handlerName ) || 0;
			indexByHandler.set( handlerName, effectIndex + 1 );
			let subPasses = [];
			try {
				subPasses = handler.subPasses( match.node, effectIndex );
			} catch ( _ ) {
				continue;
			}
			for ( const subPass of Array.isArray( subPasses ) ? subPasses : [] ) {
				const material = subPass && subPass.material;
				if ( material && ( typeof material === 'object' || typeof material === 'function' ) ) out.add( material );
			}
		}
	}
	return out;
}

function __isRegisteredPostprocessSubpassMaterial( material ) {
	if ( ! material || ( typeof material !== 'object' && typeof material !== 'function' ) ) return false;
	if ( __postProcessingSubpassMaterials.has( material ) ) return true;
	if ( __nonPostProcessingSubpassMaterials.has( material ) ) return false;
	__collectRegisteredPostprocessSubpassMaterials(
		__postProcessingPipelines,
		__collectRegisteredEffectNodes,
		__postProcessingSubpassMaterials,
	);
	if ( __postProcessingSubpassMaterials.has( material ) ) return true;
	__nonPostProcessingSubpassMaterials.add( material );
	return false;
}

function __isRegisteredPostprocessFinalQuad( target, material ) {
	for ( const pipeline of __postProcessingPipelines ) {
		if ( pipeline && pipeline._quadMesh === target && pipeline._quadMesh.material === material ) return true;
	}
	return false;
}

// QuadMesh.render(renderer) bottoms out at renderer.render(quadMesh, _camera),
// so the "scene" argument is a Mesh — not a Scene — and __markSceneMaterials
// short-circuits. Handler-owned postprocess subpasses are captured by
// precompileAuxiliary() with stable aux shapes; queuing the same identities as
// user materials duplicates the serialized compile workload and can starve the
// aux flush. The registered pipeline's final material also belongs to aux:
// capturePostProcessingLive() intentionally compiles an isolated final quad so
// Three does not execute every updateBefore node on the caller's live graph.
// Keep unrelated standalone mesh.render paths on the user-material path.
function __markStandaloneRenderTargetMaterial( target, renderer = null ) {
	if ( ! target || target.isScene === true || ! target.material ) return;
	const materials = Array.isArray( target.material ) ? target.material : [ target.material ];
	for ( const m of materials ) {
		if ( ! m || m.visible === false ) continue;
		if ( target.isQuadMesh === true && (
			__isRegisteredPostprocessFinalQuad( target, m )
			|| target.name !== 'Render Pipeline' && __isRegisteredPostprocessSubpassMaterial( m )
		) ) continue;
		if ( __classNameForMaterial( m ) === 'NodeMaterial' && target.name !== 'Render Pipeline' && target.isQuadMesh !== true ) continue;
		__mark( m, __classNameForMaterial( m ), target, null, renderer );
	}
}

function __rememberAuxScene( scene, camera, renderer = null ) {
	if ( ! scene || scene.isScene !== true ) return;
	if ( ! scene.userData || scene.userData.__tslpUserScene !== true ) return;
	if ( scene.userData && scene.userData.__tslpSyntheticCaptureScene ) return;
	let entry = __auxScenes.get( scene );
	if ( ! entry ) {
		entry = { camera: null, renderers: new Map() };
		__auxScenes.set( scene, entry );
	}
	if ( camera ) entry.camera = camera;
	if ( renderer ) entry.renderers.set( renderer, camera || entry.camera || null );
}

function __stampSceneMRT( scene, renderer ) {
	if ( ! scene || scene.isScene !== true ) return;
	if ( ! scene.userData || scene.userData.__tslpUserScene !== true ) return;
	if ( scene.userData && scene.userData.__tslpSyntheticCaptureScene ) return;
	if ( ! renderer || typeof renderer.getMRT !== 'function' ) return;
	const mrtNode = renderer.getMRT();
	if ( mrtNode ) scene.userData.__tslp_mrtNode = mrtNode;
}

function __rememberBackgroundTargetContext( scene, renderer ) {
	if ( __isSyntheticCaptureRender() ) return;
	if ( ! scene || scene.isScene !== true || ! renderer ) return;
	if ( ! scene.userData || scene.userData.__tslpUserScene !== true || scene.userData.__tslpSyntheticCaptureScene ) return;
	if ( ! scene.backgroundNode && ! scene.background ) return;
	let renderTarget = null;
	let mrtNode = null;
	try { renderTarget = typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : null; } catch ( _ ) {}
	try { mrtNode = typeof renderer.getMRT === 'function' ? renderer.getMRT() : null; } catch ( _ ) {}
	__rememberBackgroundCaptureRenderTarget( scene, renderer, renderTarget, mrtNode );
}

async function __waitForPrecompilePendingAtMost( limit, timeoutMs = 20000 ) {
	const now = () => ( typeof window.__tslpRealNow === 'function' ? window.__tslpRealNow() : Date.now() );
	const start = now();
	while ( ( window.__tslpPrecompilePending | 0 ) > limit ) {
		if ( now() - start > timeoutMs ) throw new Error( 'timed out waiting for material precompile' );
		await new Promise( ( resolve ) => setTimeout( resolve, 25 ) );
	}
}

async function __flush( passNodes = [] ) {
	const pendingItems = [];
	for ( const item of __pending ) {
		if ( item.done ) continue;
		item.done = true;
		pendingItems.push( item );
	}
	if ( pendingItems.length === 0 ) return;
	const observedPipelineScenes = new Set( passNodes
		.filter( ( passNode ) => passNode && passNode.scene )
		.map( ( passNode ) => passNode.scene ) );
	const hasObservedPipelineItems = pendingItems.some( ( item ) => observedPipelineScenes.has( item.scene ) );
	// Capture every explicit color sibling first. Interleaving a queued main
	// capture with the next item's temporary MRT removal races on the shared
	// scene.userData descriptor and can silently lose that main MRT variant.
	for ( const item of pendingItems ) {
		const itemRenderer = item.renderer || __renderer;
		if ( ! itemRenderer ) continue;
		const sceneUserData = item.scene && item.scene.userData;
		const sceneMRT = item.mrt;
		if ( sceneMRT ) {
			const currentMRT = typeof itemRenderer.getMRT === 'function' ? itemRenderer.getMRT() : null;
			const colorMaterial = item.material && typeof item.material.clone === 'function' ? item.material.clone() : item.material;
			let removedSceneMRT = false;
			try {
				if ( item.scene ) Object.defineProperty( colorMaterial, '__tslpPrecompileScene', { value: item.scene, configurable: true } );
				if ( item.object ) Object.defineProperty( colorMaterial, '__tslpPrecompileObject', { value: item.object, configurable: true } );
				if ( item.camera ) Object.defineProperty( colorMaterial, '__tslpPrecompileCamera', { value: item.camera, configurable: true } );
				if ( Object.prototype.hasOwnProperty.call( item.material, '__tslpArrayCamera' ) ) Object.defineProperty( colorMaterial, '__tslpArrayCamera', { value: item.material.__tslpArrayCamera, configurable: true } );
			} catch ( _ ) {}
			try {
				if ( sceneUserData && sceneUserData.__tslp_mrtNode === sceneMRT ) {
					delete sceneUserData.__tslp_mrtNode;
					removedSceneMRT = true;
				}
				colorMaterial.mrtNode = null;
				colorMaterial.needsUpdate = true;
				if ( typeof itemRenderer.setMRT === 'function' ) itemRenderer.setMRT( null );
				const pendingBefore = window.__tslpPrecompilePending | 0;
				colorMaterial.precompile( item.name + ':color', {
					__tslpAutoMark: true,
					renderer: itemRenderer,
					scene: item.scene || null,
					camera: item.camera || null,
					object: item.object || null,
					mrt: null,
				} );
				await __waitForPrecompilePendingAtMost( pendingBefore );
			} catch ( err ) {
				console.error( '[tslp-e2e] non-MRT precompile failed:', err );
			} finally {
				if ( removedSceneMRT && sceneUserData.__tslp_mrtNode === undefined ) sceneUserData.__tslp_mrtNode = sceneMRT;
				if ( typeof itemRenderer.setMRT === 'function' ) itemRenderer.setMRT( currentMRT );
			}
		}
	}
	// With every shared scene MRT restored, enqueue the main artifact burst.
	for ( const item of pendingItems ) {
		try {
			const itemRenderer = item.renderer || __renderer;
			if ( ! itemRenderer ) continue;
			item.material.needsUpdate = true;
			item.material.precompile( item.name, {
				__tslpAutoMark: true,
				__tslpObserveNextRender: observedPipelineScenes.has( item.scene ),
				renderer: itemRenderer,
				scene: item.scene || null,
				camera: item.camera || null,
				object: item.object || null,
				renderTarget: item.renderTarget || __captureRenderTarget( itemRenderer ) || null,
				mrt: item.mrt || null,
			} );
		} catch ( err ) {
			console.error( '[tslp-e2e] precompile failed:', err );
		}
	}
	// Explicit MRT hints normally start synthetic extraction immediately. A
	// post-processing scene needs one more real pipeline burst instead: its
	// producer pass installs MRT while a later consumer pass can install a
	// closure-backed context (SSS, AO, selective light, etc.). Keep the marked
	// entries pending above, then let the runtime observer harvest the complete
	// synchronous RenderObject family before extraction begins.
	if ( hasObservedPipelineItems ) {
		const observedRenderers = new Set( pendingItems
			.filter( ( item ) => observedPipelineScenes.has( item.scene ) )
			.map( ( item ) => item.renderer || __renderer ) );
		const pendingPipelineRenders = [];
		for ( const pipeline of __postProcessingPipelines ) {
			try {
				if ( pipeline && pipeline.renderer && ! observedRenderers.has( pipeline.renderer ) ) continue;
				const result = pipeline && typeof pipeline.render === 'function' ? pipeline.render() : null;
				if ( result && typeof result.then === 'function' ) pendingPipelineRenders.push( Promise.resolve( result ) );
			} catch ( err ) {
				console.warn( '[tslp-e2e] observed pipeline capture render failed:', err && err.message || err );
			}
		}
		if ( pendingPipelineRenders.length > 0 ) await Promise.allSettled( pendingPipelineRenders );
	}
	// Material extraction is deliberately serialized by the runtime because
	// compileTSL mutates renderer-global MRT/cache state. Enqueue the full burst
	// first, then wait once; per-item "return to previous counter" waits become
	// invalid when earlier captures finish while later ones are being queued.
	await __waitForPrecompilePendingAtMost( 0, 120000 );
}

	function __captureOperationRegistry() {
		const diagnostics = window.__tslpHarnessDiagnostics ||
			( window.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
		let registry = diagnostics.operationRegistry;
		if ( ! registry || registry.schema !== 'tslp-e2e-operation-registry@1' || ! Array.isArray( registry.expected ) ) {
			registry = {
				schema: 'tslp-e2e-operation-registry@1',
				complete: false,
				expected: [],
			};
			diagnostics.operationRegistry = registry;
		}
		return registry;
	}

	function __expectOptionalAuxiliaryOperation( operation ) {
		const registry = __captureOperationRegistry();
		if ( ! registry.expected.some( ( entry ) => entry
			&& entry.phase === 'capture'
			&& entry.component === 'auxiliary-capture'
			&& entry.operation === operation ) ) {
			// A newly discovered operation after a diagnostic seal invalidates
			// that seal until the deterministic boundary explicitly seals again.
			if ( registry.complete === true ) registry.complete = false;
			registry.expected.push( {
				phase: 'capture',
				component: 'auxiliary-capture',
				operation,
				required: false,
			} );
		}
	}

	function __sealCaptureOperationRegistry() {
		const registry = __captureOperationRegistry();
		registry.complete = true;
		return registry;
	}

	window.__tslpSealCaptureOperationRegistry = __sealCaptureOperationRegistry;
	// Initialize an explicitly incomplete registry. visitExample seals it only
	// after capture flush, GPU drain, and all discovery work are complete.
	__captureOperationRegistry();

	function __trackAuxCapture( promise, label ) {
		__expectOptionalAuxiliaryOperation( label );
		window.__tslpAuxCapturePending = ( window.__tslpAuxCapturePending | 0 ) + 1;
		const recordOutcome = ( attempted, succeeded, failed, lastError = null ) => {
			const diagnostics = window.__tslpHarnessDiagnostics ||
				( window.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
			const outcomes = diagnostics.operationOutcomes || ( diagnostics.operationOutcomes = [] );
			let outcome = outcomes.find( ( entry ) => entry
				&& entry.phase === 'capture'
				&& entry.component === 'auxiliary-capture'
				&& entry.operation === label );
			if ( ! outcome ) {
				outcome = {
					phase: 'capture',
					component: 'auxiliary-capture',
					operation: label,
					required: false,
					attempted: 0,
					succeeded: 0,
					failed: 0,
				};
				outcomes.push( outcome );
			}
			outcome.attempted += attempted;
			outcome.succeeded += succeeded;
			outcome.failed += failed;
			if ( lastError ) outcome.lastError = String( lastError );
		};
		let tracked;
		tracked = Promise.resolve( promise )
			.then( ( results ) => {
				const entries = Array.isArray( results ) ? results : [];
				const failedEntries = entries.filter( ( result ) => result && result.ok === false );
				for ( const result of failedEntries ) {
					console.info( '[tslp-e2e] optional ' + label + ' result failed:', result.shape, result.error );
				}
				recordOutcome(
					entries.length,
					entries.length - failedEntries.length,
					failedEntries.length,
					failedEntries[ 0 ] && failedEntries[ 0 ].error || null,
				);
				return results;
			} )
			.catch( ( err ) => {
				const message = err && err.message || String( err );
				recordOutcome( 1, 0, 1, message );
				console.info( '[tslp-e2e] optional ' + label + ' failed:', message );
			} )
			.finally( () => {
				window.__tslpAuxCapturePending = Math.max( 0, ( window.__tslpAuxCapturePending | 0 ) - 1 );
				__auxPromises.delete( tracked );
			} );
	__auxPromises.add( tracked );
	return tracked;
}

function __auxOpts( extra = {} ) {
	return {
		devEndpoint: '/__tslp__/capture?example=' + encodeURIComponent( __state.example ),
		three: Original,
		threeVersion: ${ JSON.stringify( SLIM_HASH_OPTS.threeVersion ) },
		pluginVersion: ${ JSON.stringify( SLIM_HASH_OPTS.pluginVersion ) },
		...extra,
	};
}

function __isGraphTraversalCandidate( value ) {
	if ( ! value || ( typeof value !== 'object' && typeof value !== 'function' ) ) return false;
	try {
		if ( value.isTexture === true || value.isNode === true || value.isPassNode === true || value.isRTTNode === true || value.isRenderTarget === true ) return true;
	} catch ( _ ) {}
	try {
		if ( value.texture && value.texture.isTexture === true && typeof value.setSize === 'function' ) return true;
	} catch ( _ ) {}
	if ( Array.isArray( value ) ) return true;
	let tag = '';
	try { tag = Object.prototype.toString.call( value ); } catch ( _ ) { return false; }
	return tag === '[object Object]';
}

function __readGraphOwnValue( node, key ) {
	let descriptor = null;
	try { descriptor = Object.getOwnPropertyDescriptor( node, key ); } catch ( _ ) { return null; }
	if ( descriptor ) {
		if ( ! Object.prototype.hasOwnProperty.call( descriptor, 'value' ) ) return null;
		return descriptor.value;
	}
	try { return node[ key ]; } catch ( _ ) { return null; }
}

function __collectCapturePassNodesInGraph( node, out = [], seen = new Set(), depth = 0 ) {
	if ( ! node || depth > 16 || seen.has( node ) ) return out;
	if ( typeof node !== 'object' && typeof node !== 'function' ) return out;
	if ( ! __isGraphTraversalCandidate( node ) ) return out;
	seen.add( node );
	if ( node.isPassNode === true && node.scene && node.camera ) {
		if ( ! out.includes( node ) ) out.push( node );
	}
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) {}
	const skip = new Set( [ 'parent', 'children', '_cache', 'renderer', 'geometry', 'material', 'domElement' ] );
	for ( const key of keys ) {
		if ( skip.has( key ) ) continue;
		const child = __readGraphOwnValue( node, key );
		if ( ! child ) continue;
		if ( Array.isArray( child ) ) {
			for ( const item of child ) __collectCapturePassNodesInGraph( item, out, seen, depth + 1 );
		} else {
			__collectCapturePassNodesInGraph( child, out, seen, depth + 1 );
		}
	}
	return out;
}

function __stampMRTPassScenes() {
	const passNodes = [];
	for ( const pipeline of __postProcessingPipelines ) {
		__collectCapturePassNodesInGraph( pipeline && pipeline.outputNode, passNodes );
	}
	for ( const passNode of passNodes ) {
		if ( ! passNode || ! passNode.scene ) continue;
		passNode.scene.userData = passNode.scene.userData || {};
		if ( passNode._mrt ) passNode.scene.userData.__tslp_mrtNode = passNode._mrt;
	}
	return passNodes;
}

function __passNodeForScene( scene, passNodes ) {
	for ( const passNode of passNodes || [] ) {
		if ( passNode && passNode.scene === scene && passNode._mrt ) return passNode;
	}
	return null;
}

function __pipelineCoversAuxScene( pipeline, scene, renderer, fallbackRenderer, collectPassNodes ) {
	if ( ! pipeline || ! scene || ! renderer ) return false;
	const pipelineRenderer = pipeline.renderer || fallbackRenderer || null;
	if ( pipelineRenderer !== renderer ) return false;
	let passNodes = [];
	try {
		passNodes = collectPassNodes( pipeline.outputNode );
	} catch ( _ ) {
		return false;
	}
	// Match the exact pass context selected by the pipeline job below. Other
	// scenes reachable from a multi-scene pipeline still need their own aux job.
	const primaryPassNode = passNodes.find( ( passNode ) => passNode && passNode._mrt ) || passNodes[ 0 ] || null;
	return !! ( primaryPassNode && primaryPassNode.scene === scene );
}

function __hasRegisteredPipelineAuxCapture( scene, renderer ) {
	for ( const pipeline of __postProcessingPipelines ) {
		if ( __pipelineCoversAuxScene( pipeline, scene, renderer, __renderer, __collectCapturePassNodesInGraph ) ) return true;
	}
	return false;
}

async function __waitForCaptureIdle( timeoutMs = 45000 ) {
	const now = () => ( typeof window.__tslpRealNow === 'function' ? window.__tslpRealNow() : Date.now() );
	const start = now();
	while ( ( window.__tslpPrecompilePending | 0 ) > 0 || ( window.__tslpAuxCapturePending | 0 ) > 0 || __auxPromises.size > 0 ) {
		if ( now() - start > timeoutMs ) throw new Error( 'timed out waiting for capture artifacts' );
		await new Promise( ( resolve ) => setTimeout( resolve, 50 ) );
	}
}

function __suppressCaptureOcclusionQueries( scenes ) {
	const snapshots = [];
	for ( const scene of scenes || [] ) {
		if ( ! scene || typeof scene.traverse !== 'function' ) continue;
		scene.traverse( ( object ) => {
			if ( ! object || object.occlusionTest !== true ) return;
			const hadOwn = Object.prototype.hasOwnProperty.call( object, 'occlusionTest' );
			const descriptor = hadOwn ? Object.getOwnPropertyDescriptor( object, 'occlusionTest' ) : null;
			try {
				object.occlusionTest = false;
				if ( object.occlusionTest === false ) snapshots.push( { object, hadOwn, descriptor } );
			} catch ( _ ) {}
		} );
	}
	return () => {
		for ( let i = snapshots.length - 1; i >= 0; i -- ) {
			const { object, hadOwn, descriptor } = snapshots[ i ];
			try {
				if ( hadOwn ) Object.defineProperty( object, 'occlusionTest', descriptor );
				else delete object.occlusionTest;
			} catch ( _ ) {}
		}
	};
}

window.__tslpFlushCaptureArtifacts = async function () {
	const captureScenes = new Set( [
		...__pending.map( ( item ) => item && item.scene ),
		...__auxScenes.keys(),
		__lastScene,
	] );
	const restoreOcclusionQueries = __suppressCaptureOcclusionQueries( captureScenes );
	try {
	const passNodes = __stampMRTPassScenes();
	await __flush( passNodes );
	if ( __renderer || __auxScenes.size > 0 ) {
		const scenes = Array.from( __auxScenes.entries() );
		if ( scenes.length === 0 && __lastScene && __lastCamera ) scenes.push( [ __lastScene, { camera: __lastCamera, renderers: new Map( [ [ __renderer, __lastCamera ] ] ) } ] );
		for ( const [ scene, entry ] of scenes ) {
			const rendererEntries = Array.from( entry.renderers.entries() );
			const primaryRendererEntry = rendererEntries.find( ( [ renderer ] ) => renderer === __renderer ) || rendererEntries[ 0 ] || null;
			const primaryRenderer = primaryRendererEntry && primaryRendererEntry[ 0 ] || __renderer;
			const primaryCamera = primaryRendererEntry && primaryRendererEntry[ 1 ] || entry.camera || null;
			if ( scene && primaryCamera && primaryRenderer ) {
				const passNode = __passNodeForScene( scene, passNodes );
				// A pipeline-owned scene is captured by the combined postprocess
				// job below. Scheduling another full precompileAuxiliary() here
				// repeats background/MRT/cube/PMREM/output work on the same
				// renderer compile lock and can outlive the idle gate.
				if ( ! __hasRegisteredPipelineAuxCapture( scene, primaryRenderer ) ) {
					__trackAuxCapture( precompileAuxiliary( primaryRenderer, scene, primaryCamera, __auxOpts( passNode ? { passNode, mrtNode: passNode._mrt } : {} ) ), 'aux capture' );
				}
				for ( const [ renderer, camera ] of rendererEntries ) {
					if ( renderer === primaryRenderer || ! camera ) continue;
					__trackAuxCapture( precompileRendererOutput( renderer, scene, camera, __auxOpts() ), 'renderer-output aux capture' );
				}
			}
		}
	}
	if ( __renderer ) {
		for ( const pipeline of __postProcessingPipelines ) {
			const pipelineRenderer = pipeline && pipeline.renderer || __renderer;
			if ( ! pipelineRenderer ) continue;
			const pipelinePassNodes = __collectCapturePassNodesInGraph( pipeline && pipeline.outputNode );
			const passNode = pipelinePassNodes.find( ( node ) => node && node._mrt ) || pipelinePassNodes[ 0 ] || null;
			__trackAuxCapture( precompileAuxiliary(
				pipelineRenderer,
				passNode && passNode.scene || null,
				passNode && passNode.camera || null,
				__auxOpts( {
					postProcessing: pipeline,
					renderPipeline: pipeline,
					...( passNode ? { passNode, mrtNode: passNode._mrt } : {} ),
				} )
			), 'post-process aux capture' );
		}
	}
	await __waitForCaptureIdle();
	return {
		pendingMaterials: __pending.length,
		precompilePending: window.__tslpPrecompilePending | 0,
		auxPending: window.__tslpAuxCapturePending | 0,
	};
	} finally {
		restoreOcclusionQueries();
	}
};

export class Scene extends Original.Scene {
	constructor( ...args ) {
		super( ...args );
		this.userData = this.userData || {};
		this.userData.__tslpUserScene = true;
	}
}

function __isCaptureTRAAEffectNode( node ) {
	if ( ! node || typeof node === 'function' ) return false;
	const type = ( node.constructor && ( node.constructor.type || node.constructor.name ) ) || node.type || '';
	if ( type && type !== 'TRAANode' ) return false;
	return !! ( node && typeof node.updateBefore === 'function' && node._resolveMaterial && node._historyRenderTarget && node._resolveRenderTarget );
}

function __isCaptureTAAUEffectNode( node ) {
	if ( ! node || typeof node === 'function' ) return false;
	const type = ( node.constructor && ( node.constructor.type || node.constructor.name ) ) || node.type || '';
	if ( type && type !== 'TAAUNode' ) return false;
	return !! ( node && typeof node.updateBefore === 'function' && node._resolveMaterial && node._historyRenderTarget && node._resolveRenderTarget );
}

function __syncCaptureTRAAJitterIndex( traaNode ) {
	__sharedSynchronizeTemporalJitterNode( traaNode, { marker: '__tslpTRAAJitterSynchronized', installVelocityProjectionLifecycle: __installVelocityProjectionLifecycle } );
}

function __syncCaptureTAAUJitterIndex( taauNode ) {
	__sharedSynchronizeTemporalJitterNode( taauNode, { marker: '__tslpTAAUJitterSynchronized', installVelocityProjectionLifecycle: __installVelocityProjectionLifecycle } );
}

function __scanForCaptureTRAANodes( node, seen = new Set(), depth = 0 ) {
	if ( ! node || depth > 24 || seen.has( node ) ) return;
	if ( typeof node !== 'object' && typeof node !== 'function' ) return;
	seen.add( node );
	if ( __isCaptureTRAAEffectNode( node ) ) {
		__syncCaptureTRAAJitterIndex( node );
		return;
	}
	if ( __isCaptureTAAUEffectNode( node ) ) {
		__syncCaptureTAAUJitterIndex( node );
		return;
	}
	const keys = [];
	try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) {}
	const skip = new Set( [ 'parent', 'children', '_cache', 'scene', 'camera', 'renderer', 'geometry', 'material', 'domElement' ] );
	for ( const key of keys ) {
		if ( skip.has( key ) ) continue;
		let child;
		try { child = node[ key ]; } catch ( _ ) { continue; }
		if ( ! child ) continue;
		if ( Array.isArray( child ) ) {
			for ( const item of child ) if ( item && ( typeof item === 'object' || typeof item === 'function' ) ) __scanForCaptureTRAANodes( item, seen, depth + 1 );
		} else if ( typeof child === 'object' || typeof child === 'function' ) {
			__scanForCaptureTRAANodes( child, seen, depth + 1 );
		}
	}
}

function __capturePostProcessing( pipeline ) {
	if ( pipeline ) {
		__postProcessingPipelines.add( pipeline );
		// Keep temporal AA on the synthetic application-frame sample so capture
		// and replay advance identically despite different internal render counts.
		try {
			if ( pipeline.outputNode ) __scanForCaptureTRAANodes( pipeline.outputNode );
		} catch ( _ ) {}
	}
}

const __RenderPipelineBase = Original.RenderPipeline || Original.PostProcessing;
export class RenderPipeline extends __RenderPipelineBase {
	render( ...args ) {
		try { window.__tslpLastRenderPipeline = this; } catch ( _ ) {}
		__capturePostProcessing( this );
		return super.render( ...args );
	}
}

export class PostProcessing extends RenderPipeline {}

function __trackDebugShaderAsync( renderer ) {
	const debug = renderer && renderer.debug;
	if ( ! debug || debug.__tslpGetShaderAsyncPatched || typeof debug.getShaderAsync !== 'function' ) return;
	const originalGetShaderAsync = debug.getShaderAsync;
	try {
		Object.defineProperty( debug, '__tslpGetShaderAsyncPatched', {
			value: true,
			configurable: true,
		} );
	} catch ( _ ) {
		debug.__tslpGetShaderAsyncPatched = true;
	}
	debug.getShaderAsync = function ( ...args ) {
		window.__tslpCompilePending = ( window.__tslpCompilePending | 0 ) + 1;
		const settle = () => { window.__tslpCompilePending = Math.max( 0, ( window.__tslpCompilePending | 0 ) - 1 ); };
		try {
			const p = originalGetShaderAsync.apply( this, args );
			return Promise.resolve( p ).then( ( v ) => { settle(); return v; }, ( e ) => { settle(); throw e; } );
		} catch ( err ) {
			settle();
			throw err;
		}
	};
}

function __isCaptureMaintenanceRender() {
	return __isSyntheticCaptureRender()
		|| ( window.__tslpPrecompilePending | 0 ) > 0;
}

function __isSyntheticCaptureRender() {
	return ( window.__tslpSyntheticRenderActive | 0 ) > 0;
}

export class WebGPURenderer extends Original.WebGPURenderer {
	constructor( ...args ) {
		const params = args[ 0 ];
		const forceWebGLCapture = !! ( params && typeof params === 'object' && params.forceWebGL === true );
		super( ...args );
		this.__tslpForceWebGLCapture = forceWebGLCapture;
		this.__tslpRecordCaptureBackend = () => {
			const actualBackend = this.backend && this.backend.isWebGLBackend === true ? 'webgl' : 'webgpu';
			this.__tslpCaptureBackend = actualBackend;
			if ( this.domElement && this.domElement.dataset ) this.domElement.dataset.tslpBackend = actualBackend;
		};
		this.__tslpRecordCaptureBackend();
		// Wedge 4: expose the full renderer so the runner can read nodeFrame.time
		// at screenshot time.
		window.__tslpHarnessRenderer = this;
		window.__tslpFullRenderer = this;
		__trackDebugShaderAsync( this );
	}
	setAnimationLoop( callback ) {
		const wrap = typeof window.__tslpWrapAnimationLoop === 'function' ? window.__tslpWrapAnimationLoop : null;
		return super.setAnimationLoop( wrap ? wrap( callback, this ) : callback );
	}
	copyFramebufferToTexture( texture, rectangle = null ) {
		const restore = __syncFramebufferTextureForActiveTarget( this, texture, rectangle );
		try {
			return super.copyFramebufferToTexture( texture, rectangle );
		} finally {
			if ( restore ) restore();
		}
	}
	renderObject( object, scene, camera, geometry, material, group, lightsNode, clippingContext, passId = null ) {
		if ( __pmremRunning > 0 || __isSyntheticCaptureRender() ) return super.renderObject( object, scene, camera, geometry, material, group, lightsNode, clippingContext, passId );
		const materialClassName = material ? __classNameForMaterial( material ) : '';
		const isOffscreenRenderPass = typeof this.getRenderTarget === 'function' && this.getRenderTarget() !== null;
		const isSyntheticScene = !! ( scene && scene.userData && scene.userData.__tslpSyntheticCaptureScene );
		const isUserScene = !! ( scene
			&& scene.isScene === true
			&& scene.userData
			&& scene.userData.__tslpUserScene === true
			&& ! isSyntheticScene );
		const isRetroPassMaterial = __isRetroPassGeneratedMaterial( this, scene, material, materialClassName );
		const objectScene = object ? __findParentScene( object ) : null;
		const objectSceneRelation = ! object
			? 'absent'
			: objectScene === scene
				? 'same'
				: objectScene === null
					? 'detached'
					: 'other';
		// Some effects render private, detached meshes directly against an
		// authored Scene. LensflareMesh is one upstream example. The shared
		// policy distinguishes those draws from cross-Scene ownership and
		// synthetic/offscreen maintenance without relying on addon labels that
		// r185's read-only NodeMaterial.type cannot expose.
		const directNodeMaterialPolicy = __classifyDirectNodeMaterialCapture( {
			materialClassName,
			authoredUserScene: isUserScene,
			syntheticScene: isSyntheticScene,
			pmremRunning: __pmremRunning > 0,
			syntheticRenderActive: __isSyntheticCaptureRender(),
			offscreenRenderPass: isOffscreenRenderPass,
			objectSceneRelation,
		} );
		if ( isRetroPassMaterial ) {
			try {
				Object.defineProperty( material, '__tslpRetroPassMaterial', {
					value: true,
					configurable: true,
					writable: true,
				} );
			} catch ( _ ) {
				material.__tslpRetroPassMaterial = true;
			}
		}
		if ( material && ( material.isMeshToonOutlineMaterial === true || directNodeMaterialPolicy.claim || isRetroPassMaterial ) ) {
			__mark(
				material,
				isRetroPassMaterial ? materialClassName : 'NodeMaterial',
				object,
				camera,
				this,
				undefined,
				null,
				directNodeMaterialPolicy.sceneHint ? scene : null,
			);
		}
		return super.renderObject( object, scene, camera, geometry, material, group, lightsNode, clippingContext, passId );
	}
	async init( ...args ) {
		const result = await super.init( ...args );
		this.__tslpRecordCaptureBackend();
		__renderer = this;
		setDevRenderer( this );
		window.__tslpRendererBound = true;
		// __flush deliberately skipped here — see __mark for why.
		return result;
	}
	compile( scene, camera, ...rest ) {
		if ( __pmremRunning > 0 || __isSyntheticCaptureRender() ) return typeof super.compile === 'function' ? super.compile( scene, camera, ...rest ) : undefined;
		__lastScene = scene;
		__lastCamera = camera;
		__rememberAuxScene( scene, camera, this );
		__rememberBackgroundTargetContext( scene, this );
		__stampSceneMRT( scene, this );
		__markSceneMaterials( scene, camera, this );
		__markStandaloneRenderTargetMaterial( scene, this );
		return typeof super.compile === 'function' ? super.compile( scene, camera, ...rest ) : undefined;
	}
	compileAsync( scene, camera, ...rest ) {
		if ( __pmremRunning > 0 || __isSyntheticCaptureRender() ) return typeof super.compileAsync === 'function' ? super.compileAsync( scene, camera, ...rest ) : Promise.resolve();
		__lastScene = scene;
		__lastCamera = camera;
		__rememberAuxScene( scene, camera, this );
		__rememberBackgroundTargetContext( scene, this );
		__stampSceneMRT( scene, this );
		__markSceneMaterials( scene, camera, this );
		__markStandaloneRenderTargetMaterial( scene, this );
		if ( typeof super.compileAsync !== 'function' ) return Promise.resolve();
		// Track this compile so the screenshot waits for it. MaterialX, GLTF, and
		// other examples await renderer.compileAsync between asset loads to warm
		// the GPU pipeline; without this counter, the wait gate can fire while
		// the next mesh's pipeline is still being built.
		window.__tslpCompilePending = ( window.__tslpCompilePending | 0 ) + 1;
		const _settle = () => { window.__tslpCompilePending = Math.max( 0, ( window.__tslpCompilePending | 0 ) - 1 ); };
		const p = super.compileAsync( scene, camera, ...rest );
		return Promise.resolve( p ).then( ( v ) => { _settle(); return v; }, ( e ) => { _settle(); throw e; } );
	}
	render( scene, camera ) {
		if ( __pmremRunning > 0 || __isSyntheticCaptureRender() ) {

			// A dynamic-cube pre-arm makes the live harvest burst capture
			// maintenance. Keep it invisible to readiness/material marking, but
			// retain the final scene/camera for the later aux pass.
			const rememberAuxScene = __pmremRunning === 0;
			const result = super.render( scene, camera );
			if ( rememberAuxScene ) {

				// Nested shadow renders can reuse this Scene with a private camera.
				// Publish on completion so the outer application render owns aux capture.
				__lastScene = scene;
				__lastCamera = camera;
				__rememberAuxScene( scene, camera, this );

			}
			return result;

		}
		// CubeCamera equirectangular conversions use a private one-mesh scene.
		// Authored RenderPipeline/PassNode renders are nested too, so retain them.
		if ( ! __isCubeCameraFaceReadinessRender( camera ) ) __recordRenderableObjectCount( scene );
		__rememberBackgroundTargetContext( scene, this );
		__stampSceneMRT( scene, this );
		__markSceneMaterials( scene, camera, this );
		__markStandaloneRenderTargetMaterial( scene, this );
		const result = super.render( scene, camera );
		// TileShadowNode re-enters renderer.render() with an ArrayCamera.
		// Completion order restores this outer camera as the same Scene's owner.
		__lastScene = scene;
		__lastCamera = camera;
		__rememberAuxScene( scene, camera, this );
		return result;
	}
}

window.__tslpFullAutoLoaded = true;
`;

}

function tslStubModule() {

	// In replay mode `three/tsl` maps to this stub. We rebuild the TSL export
	// surface by pulling real implementations from the full three.webgpu.js via
	// its TSL namespace object. The import uses an absolute URL to bypass the
	// replay import-map (which would redirect 'three/webgpu' to the slim bundle
	// whose TSL stub throws on every property access).
	//
	// Without real node objects, Fn(...)().compute(count) returns a chainable
	// proxy with no isComputeNode flag. The slim renderer's computeAsync guard
	// then silently drops every dispatch, particle positions stay at origin/zero,
	// and the particle blob is invisible.
	//
	// three.tsl.js itself does `import { TSL } from 'three/webgpu'` which in
	// replay mode resolves to the slim stub — so we CANNOT re-export from
	// three.tsl.js. We pull directly from /build/three.webgpu.js instead.
	const src = trackedReadFileSync( join( threeRepo, 'build/three.tsl.js' ), 'utf8' );
	const match = src.match( /export\s*\{([\s\S]*?)\};?\s*$/m );
	const names = match
		? match[ 1 ].split( ',' ).map( ( x ) => x.trim().split( /\s+as\s+/ ).pop().trim() ).filter( Boolean )
		: [];
	const unique = Array.from( new Set( names ) ).filter( ( name ) => /^[A-Za-z_$][\w$]*$/.test( name ) && name !== 'pass' );
	const consts = unique
		.filter( ( name ) => name !== 'reflector' )
		.filter( ( name ) => name !== 'builtinAOContext' )
		.filter( ( name ) => name !== 'builtinShadowContext' )
		.filter( ( name ) => name !== 'renderOutput' )
		.filter( ( name ) => name !== 'uniform' )
		.filter( ( name ) => name !== 'texture' )
		.filter( ( name ) => name !== 'texture3D' )
		.filter( ( name ) => name !== 'textureLoad' )
		.filter( ( name ) => name !== 'pmremTexture' )
		.map( ( name ) => `const ${ name } = __TSL[ '${ name }' ];` )
		.join( '\n' );
	const reflectorShim = unique.includes( 'reflector' )
		? `
const __tslpRealReflector = __TSL[ 'reflector' ];
const reflector = ( ...args ) => {
	const node = __tslpRealReflector( ...args );
	const baseNode = node && node._reflectorBaseNode;
	if ( baseNode ) {
		const list = globalThis.__tslpReflectorBaseNodes || ( globalThis.__tslpReflectorBaseNodes = [] );
		if ( ! list.includes( baseNode ) ) list.push( baseNode );
	}
	return node;
};
`
		: '';
	const builtinAOContextShim = unique.includes( 'builtinAOContext' )
		? `
const __tslpRealBuiltinAOContext = __TSL[ 'builtinAOContext' ];
const builtinAOContext = ( aoNode, node = null ) => {
	const contextNode = __tslpRealBuiltinAOContext( aoNode, node );
	__sharedAttachLiveNodeDependency( contextNode, aoNode, { role: 'ambient-occlusion' } );
	return contextNode;
};
`
		: '';
	const builtinShadowContextShim = unique.includes( 'builtinShadowContext' )
		? `
const __tslpRealBuiltinShadowContext = __TSL[ 'builtinShadowContext' ];
const builtinShadowContext = ( shadowNode, light, node = null ) => {
	const contextNode = __tslpRealBuiltinShadowContext( shadowNode, light, node );
	__sharedAttachLiveNodeDependency( contextNode, shadowNode, { role: 'shadow', light } );
	return contextNode;
};
`
		: '';
	const renderOutputShim = unique.includes( 'renderOutput' )
		? `
const __tslpRealRenderOutput = __TSL[ 'renderOutput' ];
const renderOutput = ( node, ...args ) => {
	if ( node && node.isPassNode === true && typeof node.getTextureNode === 'function' ) {
		return node.getTextureNode().renderOutput( ...args );
	}
	return __tslpRealRenderOutput( node, ...args );
};
`
		: '';
	const pmremTextureShim = unique.includes( 'pmremTexture' )
		? `
const __tslpRealPmremTexture = __TSL[ 'pmremTexture' ];
const pmremTexture = ( ...args ) => {
	__tslpRememberTextureArg( args[ 0 ] );
	return __tslpRealPmremTexture( ...args );
};
`
		: '';
	const exportList = [ ...unique, 'pass' ].join( ', ' );
	return `
// Import the FULL three.js TSL namespace via absolute URL so the replay
// import-map (which redirects 'three/webgpu' to the slim bundle) is bypassed.
import { TSL as __TSL } from '/build/three.webgpu.js';
import { PassNode as __ReplayPassNode, registerLiveTexture as __tslpRegisterLiveTexture } from '/__tslp__/slim-webgpu-replay.js?v=${ CACHE_BUST }';
import { registerLiveUniformNode as __tslpRegisterLiveUniformNode } from '/__tslp_runtime/slim-support/live-uniform-registry.js';
import { attachLiveNodeDependency as __sharedAttachLiveNodeDependency } from '/__tslp_runtime/slim-support/node-dependencies.js';

// Re-expose every named TSL export so compute kernels (Fn, instancedArray, ...)
// receive genuine TSL node objects whose isComputeNode flag is set correctly.
${ consts }
${ reflectorShim }
${ builtinAOContextShim }
${ builtinShadowContextShim }
${ renderOutputShim }
const __tslpRealUniform = __TSL[ 'uniform' ];
const uniform = ( ...args ) => __tslpRegisterLiveUniformNode( __tslpRealUniform( ...args ) );
const __tslpRememberTextureArg = ( value ) => {
	if ( ! value || value.isTexture !== true ) return;
	const list = globalThis.__tslpTslTextureArgs || ( globalThis.__tslpTslTextureArgs = [] );
	if ( ! list.includes( value ) ) list.push( value );
	try { __tslpRegisterLiveTexture( value ); } catch ( _ ) {}
};
const __tslpTrackLateTextureNodeAssignments = ${ trackLateTextureNodeAssignments.toString() };
const __tslpRealTexture = __TSL[ 'texture' ];
const texture = ( ...args ) => {
	__tslpRememberTextureArg( args[ 0 ] );
	return __tslpTrackLateTextureNodeAssignments( __tslpRealTexture( ...args ), __tslpRememberTextureArg );
};
const __tslpRealTexture3D = __TSL[ 'texture3D' ];
const texture3D = ( ...args ) => {
	__tslpRememberTextureArg( args[ 0 ] );
	return __tslpTrackLateTextureNodeAssignments( __tslpRealTexture3D( ...args ), __tslpRememberTextureArg );
};
const __tslpRealTextureLoad = __TSL[ 'textureLoad' ];
const textureLoad = ( ...args ) => {
	__tslpRememberTextureArg( args[ 0 ] );
	return __tslpTrackLateTextureNodeAssignments( __tslpRealTextureLoad( ...args ), __tslpRememberTextureArg );
};
${ pmremTextureShim }
const pass = ( scene, camera, options ) => new __ReplayPassNode( __ReplayPassNode.COLOR, scene, camera, options );
export { ${ exportList } };
// Also export the TSL namespace object for code that imports it directly.
export const TSL = __TSL;
`;

}

function tslCaptureModule() {

	// Capture uses the full TSL implementation, but wraps context constructors
	// so closure-only AO/SSS inputs are visible to the product aux collector.
	// Real Vite adopters receive the equivalent wrapper from the plugin's source
	// transform; this module keeps the custom batch server on the same contract.
	const src = trackedReadFileSync( join( threeRepo, 'build/three.tsl.js' ), 'utf8' );
	const match = src.match( /export\s*\{([\s\S]*?)\};?\s*$/m );
	const names = match
		? match[ 1 ].split( ',' ).map( ( x ) => x.trim().split( /\s+as\s+/ ).pop().trim() ).filter( Boolean )
		: [];
	const unique = Array.from( new Set( names ) ).filter( ( name ) => /^[A-Za-z_$][\w$]*$/.test( name ) && name !== 'TSL' );
	const consts = unique
		.filter( ( name ) => name !== 'builtinAOContext' && name !== 'builtinShadowContext' )
		.map( ( name ) => `const ${ name } = __TSL[ '${ name }' ];` )
		.join( '\n' );
	const exportList = unique.join( ', ' );
	return `
import { TSL as __TSL } from '/build/three.webgpu.js';
import { attachLiveNodeDependency as __attachLiveNodeDependency } from '/__tslp_runtime/slim-support/node-dependencies.js';
${ consts }
const __realBuiltinAOContext = __TSL[ 'builtinAOContext' ];
const builtinAOContext = ( aoNode, node = null ) => {
	const contextNode = __realBuiltinAOContext( aoNode, node );
	__attachLiveNodeDependency( contextNode, aoNode, { role: 'ambient-occlusion' } );
	return contextNode;
};
const __realBuiltinShadowContext = __TSL[ 'builtinShadowContext' ];
const builtinShadowContext = ( shadowNode, light, node = null ) => {
	const contextNode = __realBuiltinShadowContext( shadowNode, light, node );
	__attachLiveNodeDependency( contextNode, shadowNode, { role: 'shadow', light } );
	return contextNode;
};
export { ${ exportList } };
export const TSL = __TSL;
`;

}

function inspectorStubModule() {

	return `
// Function builtins (name, length, prototype, arguments, caller, bind, etc.)
// must be shadowed so chained GUI calls like \`gui.add(...).name('Label')\`
// hit the chainable Proxy and not Function.prototype.name (string).
const FN_BUILTINS = new Set( [ 'name', 'length', 'prototype', 'arguments', 'caller', 'bind', 'call', 'apply' ] );
function makeChainable( base = {} ) {
	const target = Object.assign( function () { return chain; }, base );
	const chain = new Proxy( target, {
		get( t, prop ) {
			if ( prop === Symbol.toPrimitive ) return () => 0;
			if ( prop === 'toString' ) return () => '[inspector stub]';
			if ( typeof prop === 'string' && Object.prototype.hasOwnProperty.call( base, prop ) ) return base[ prop ];
			if ( typeof prop === 'string' && FN_BUILTINS.has( prop ) ) return makeChainable();
			if ( prop in t ) return t[ prop ];
			return makeChainable();
		},
		apply() { return makeChainable(); },
		construct() { return makeChainable(); },
	} );
	return chain;
}
const guiTarget = { paramList: { domElement: { style: {} } } };
function makeGui() { return makeChainable( guiTarget ); }
export class Inspector {
	constructor() {
		const base = { domElement: document.createElement( 'div' ) };
		base.createParameters = makeGui;
		return makeChainable( base );
	}
}
export default Inspector;
`;

}

function statsStubModule() {

	return `
function Stats() {
	const dom = document.createElement( 'div' );
	return {
		REVISION: 16,
		dom,
		domElement: dom,
		addPanel() { return { dom: document.createElement( 'canvas' ), update() {} }; },
		showPanel() {},
		begin() {},
		end() { return ( performance || Date ).now(); },
		update() {},
	};
}
Stats.Panel = function () { return { dom: document.createElement( 'canvas' ), update() {} }; };
export default Stats;
`;

}

async function readBody( req ) {

	const chunks = [];
	for await ( const chunk of req ) chunks.push( chunk );
	return Buffer.concat( chunks ).toString( 'utf8' );

}

async function handleCapture( req, res, url ) {

	try {

		const example = url.searchParams.get( 'example' ) || 'unknown';
		const payload = JSON.parse( await readBody( req ) );
		const bucket = captureBucket( example );
		applyBatchCapturePayload( bucket, payload, {
			validateAuxiliaryFamilyPayload,
		} );

		res.setHeader( 'content-type', 'application/json' );
		res.end( JSON.stringify( { ok: true } ) );

	} catch ( err ) {

		res.statusCode = 400;
		res.setHeader( 'content-type', 'application/json' );
		res.end( JSON.stringify( { error: err && err.message || String( err ) } ) );

	}

}

function safeResolveUnder( root, rel ) {

	const file = resolve( root, rel.replace( /^\/+/, '' ) );
	const rootNorm = normalize( root + '/' );
	if ( ! normalize( file ).startsWith( rootNorm ) ) return null;
	return file;

}

const server = createServer( async ( req, res ) => {

	try {

		const url = new URL( req.url, 'http://localhost' );

		if ( url.pathname === '/__tslp__/capture' ) return handleCapture( req, res, url );
		if ( url.pathname === '/__tslp__/environment-probe.html' ) {

			res.setHeader( 'content-type', 'text/html; charset=utf-8' );
			res.setHeader( 'cache-control', 'no-store' );
			res.end( '<!doctype html><html><head><meta charset="utf-8"><title>TSL evidence environment probe</title></head><body></body></html>' );
			return;

		}
		if ( url.pathname === '/__tslp__/stock-webgpu.js' ) return sendJs( res, stockWebgpuModule() );
		if ( url.pathname === '/__tslp__/full-webgpu-auto.js' ) return sendJs( res, fullWebgpuAutoModule() );
		if ( url.pathname === '/__tslp__/slim-webgpu-replay.js' ) {

			return sendJs( res, slimWebgpuReplayModule( {
				nodeMaterialExports: NODE_MATERIAL_EXPORTS,
				slimBundleBrowserModule: SLIM_BUNDLE_BROWSER_MODULE,
				slimReplayForwardExportBlock: SLIM_REPLAY_FORWARD_EXPORT_BLOCK,
				slimReplayFullFallbackExportBlock: SLIM_REPLAY_FULL_FALLBACK_EXPORT_BLOCK,
				replayOperationDiagnostics,
				slimHashOptions: SLIM_HASH_OPTS,
			} ) );

		}
		if ( url.pathname === '/__tslp__/tsl-stub.js' ) return sendJs( res, tslStubModule() );
		if ( url.pathname === '/__tslp__/tsl-capture.js' ) return sendJs( res, tslCaptureModule() );
		if ( url.pathname === '/__tslp__/aux-virtual.js' ) return sendJs( res, auxVirtualModule() );
		if ( url.pathname === '/__tslp_batch/cube-capture-prearm.mjs' ) return sendFile( res, join( SELF, 'cube-capture-prearm.mjs' ) );
		if ( url.pathname === '/__tslp_batch/e2e-capture-setup-adapter.js' ) return sendFile( res, join( SELF, 'e2e-capture-setup-adapter.js' ) );
		if ( url.pathname === '/__tslp_batch/layered-capture-prearm.mjs' ) return sendFile( res, join( SELF, 'layered-capture-prearm.mjs' ) );
		if ( url.pathname === '/__tslp_batch/material-context-cache.mjs' ) return sendFile( res, join( SELF, 'material-context-cache.mjs' ) );
		if ( url.pathname === '/__tslp_batch/pass-material-visibility.mjs' ) return sendFile( res, join( SELF, 'pass-material-visibility.mjs' ) );
		if ( url.pathname === '/__tslp_batch/presentation-readiness.mjs' ) return sendFile( res, join( SELF, 'presentation-readiness.mjs' ) );
		if ( url.pathname === '/__tslp_batch/temporal-jitter.mjs' ) return sendFile( res, join( SELF, 'temporal-jitter.mjs' ) );
		if ( url.pathname === '/__tslp_batch/vsm-blur-texture.mjs' ) return sendFile( res, join( SELF, 'vsm-blur-texture.mjs' ) );
		if ( url.pathname === '/examples/jsm/inspector/Inspector.js' ) return sendJs( res, inspectorStubModule() );
		if ( url.pathname === '/examples/jsm/libs/stats.module.js' ) return sendJs( res, statsStubModule() );
		// `three/addons/*` for local-examples-root packages: `/examples/*` is
		// intercepted to the local root (which has no `jsm/`), so route the
		// importmap-injected `"three/addons/"` here instead → `<threeRepo>/examples/jsm/`.
		if ( url.pathname.startsWith( '/__tslp_addons/' ) ) {

			const rel = url.pathname.slice( '/__tslp_addons/'.length );
			if ( rel === 'inspector/Inspector.js' ) return sendJs( res, inspectorStubModule() );
			if ( rel === 'libs/stats.module.js' ) return sendJs( res, statsStubModule() );
			const addonFile = safeResolveUnder( join( threeRepo, 'examples/jsm' ), rel );
			if ( ! /\.(?:mjs|js)$/.test( rel ) ) return sendFile( res, addonFile );
			const source = sourceRecorder.record( addonFile ).toString( 'utf8' );
			let rewritten = rewriteR185AddonCompatibility( source, {
				relativePath: rel,
				threeVersion: SLIM_HASH_OPTS.threeVersion,
			} );
			if ( rel === 'loaders/MaterialXLoader.js' ) rewritten = rewriteMaterialXLoaderTextureIdentity( rewritten );
			rewritten = rewriteLoaderAddonReadiness( rewritten, rel );
			return sendJs( res, rewritten );

		}
		if ( url.pathname.startsWith( '/__tslp_addons_replay/' ) ) {

			const rel = url.pathname.slice( '/__tslp_addons_replay/'.length );
			if ( rel === 'inspector/Inspector.js' ) return sendJs( res, inspectorStubModule() );
			if ( rel === 'libs/stats.module.js' ) return sendJs( res, statsStubModule() );
			const addonFile = safeResolveUnder( join( threeRepo, 'examples/jsm' ), rel );
			// Decoder workers resolve WASM and other binary assets relative to the
			// rewritten addon URL. Preserve those bytes; decoding every replay addon
			// as UTF-8 JavaScript corrupts Draco before the scene can render.
			if ( ! /\.(?:mjs|js)$/.test( rel ) ) return sendFile( res, addonFile );
			const source = sourceRecorder.record( addonFile ).toString( 'utf8' );
			let rewritten = rewriteR185AddonCompatibility( source, {
				relativePath: rel,
				threeVersion: SLIM_HASH_OPTS.threeVersion,
			} );
			rewritten = rewriteReplayAddon( rewritten );
			if ( rel === 'loaders/MaterialXLoader.js' ) rewritten = rewriteMaterialXLoaderTextureIdentity( rewritten );
			rewritten = rewriteLoaderAddonReadiness( rewritten, rel );
			return sendJs( res, rewritten );

		}
			if ( url.pathname === '/__tslp__/three.webgpu.slim.js' ) {

				res.setHeader( 'content-type', 'application/javascript; charset=utf-8' );
				res.setHeader( 'cache-control', 'no-store' );
				res.end( rewriteSlimDeterministicObjectIds( SLIM_BUNDLE_SOURCE ) );
				return;

		}

		if ( url.pathname.startsWith( '/__tslp_runtime/' ) ) {

			return sendFile( res, safeResolveUnder( RUNTIME_SRC, url.pathname.slice( '/__tslp_runtime/'.length ) ) );

		}
			if ( url.pathname.startsWith( '/__tslp_contract/' ) ) {

				const rel = url.pathname.slice( '/__tslp_contract/'.length );
				const withExtension = extname( rel ) ? rel : `${ rel }.js`;
				return sendFile( res, safeResolveUnder( CONTRACT_SRC, withExtension ) );

			}
		if ( url.pathname.startsWith( '/__tslp_plugin/' ) ) {

			return sendFile( res, safeResolveUnder( PLUGIN_SRC, url.pathname.slice( '/__tslp_plugin/'.length ) ) );

		}

		const requestPath = decodeURIComponent( url.pathname );
		let filePath;
		if ( localExamplesRoot && requestPath.startsWith( '/examples/' ) ) {

			filePath = safeResolveUnder( localExamplesRoot, requestPath.slice( '/examples/'.length ) );

		} else if ( localExamplesRoot && requestPath.startsWith( '/__local_src/' ) ) {

			filePath = safeResolveUnder( localExamplesRoot, 'src/' + requestPath.slice( '/__local_src/'.length ) );

		} else {

			filePath = resolve( threeRepo, '.' + requestPath );

		}
		if ( ! filePath || ! normalize( filePath ).startsWith( normalize( ( localExamplesRoot && ( requestPath.startsWith( '/examples/' ) || requestPath.startsWith( '/__local_src/' ) ) ? localExamplesRoot : threeRepo ) + '/' ) ) ) {

			res.statusCode = 403;
			res.end( 'forbidden' );
			return;

		}

		const s = await stat( filePath ).catch( () => null );
		if ( ! s || ! s.isFile() ) {

			res.statusCode = 404;
			res.end( 'not found' );
			return;

		}

			let buf = sourceRecorder.record( filePath );
		const isLocalHtml = localExamplesRoot && filePath.endsWith( '.html' ) && normalize( filePath ).startsWith( normalize( localExamplesRoot + '/' ) );
		const isThreeWebgpuHtml = filePath.endsWith( '.html' ) && filePath.includes( '/examples/webgpu_' );
		if ( isLocalHtml || isThreeWebgpuHtml ) {

			const requestedMode = url.searchParams.get( '__tslp_mode' );
			const mode = requestedMode === 'replay' ? 'replay' : requestedMode === 'stock' ? 'stock' : 'capture';
			const example = url.searchParams.get( '__tslp_case' ) || basename( requestPath );
			const html = isLocalHtml
				? buf.toString( 'utf8' ).replace( /(["'])\/src\//g, '$1/__local_src/' )
				: buf.toString( 'utf8' );
			const workload = applyExampleWorkloadPolicy( html, example );
			buf = Buffer.from( injectHtml( workload.html, example, mode ) );

		}
		const isLocalJs = localExamplesRoot && /\.(?:mjs|js)$/.test( filePath ) && normalize( filePath ).startsWith( normalize( localExamplesRoot + '/' ) );
		if ( isLocalJs ) {

			buf = Buffer.from( rewriteHarnessVirtualImports( buf.toString( 'utf8' ) ) );

		}
			if ( requestPath === '/examples/jsm/loaders/MaterialXLoader.js' ) {

				buf = Buffer.from( rewriteMaterialXLoaderTextureIdentity( buf.toString( 'utf8' ) ) );

			}
				if ( requestPath.startsWith( '/examples/jsm/' )
					&& isLoaderAddonReadinessPath( requestPath.slice( '/examples/jsm/'.length ) ) ) {

					buf = Buffer.from( rewriteLoaderAddonReadiness(
						buf.toString( 'utf8' ),
						requestPath.slice( '/examples/jsm/'.length ),
					) );

				}
				if ( requestPath === '/build/three.core.js' ) {

					buf = Buffer.from( rewriteThreeCoreDeterministicObjectIds( buf.toString( 'utf8' ) ) );

				}
					res.setHeader( 'access-control-allow-origin', '*' );
		res.setHeader( 'content-type', MIME[ extname( filePath ).toLowerCase() ] || 'application/octet-stream' );
		res.setHeader( 'cache-control', 'no-store' );
		res.end( buf );

	} catch ( err ) {

		res.statusCode = 500;
		res.end( 'error: ' + ( err && err.message || err ) );

	}

} );

function sendJs( res, code ) {

	res.setHeader( 'access-control-allow-origin', '*' );
	res.setHeader( 'content-type', 'application/javascript; charset=utf-8' );
	res.setHeader( 'cache-control', 'no-store' );
	res.end( code );

}

async function sendFile( res, file ) {

	if ( ! file ) {

		res.statusCode = 403;
		res.end( 'forbidden' );
		return;

	}
	const s = await stat( file ).catch( () => null );
	if ( ! s || ! s.isFile() ) {

		res.statusCode = 404;
		res.end( 'not found' );
		return;

	}
	res.setHeader( 'access-control-allow-origin', '*' );
	res.setHeader( 'content-type', MIME[ extname( file ).toLowerCase() ] || 'application/javascript; charset=utf-8' );
	res.setHeader( 'cache-control', 'no-store' );
	const bytes = sourceRecorder.record( file );
	res.end( bytes );

}

async function listenWithPortFallback( server, startPort, maxRetries ) {

	for ( let attempt = 0; attempt <= maxRetries; attempt ++ ) {

		const candidate = startPort + attempt;
		try {

			await new Promise( ( ok, fail ) => {

				const onError = ( err ) => {

					server.off( 'listening', onListening );
					fail( err );

				};
				const onListening = () => {

					server.off( 'error', onError );
					ok();

				};
				server.once( 'error', onError );
				server.once( 'listening', onListening );
				server.listen( candidate, '127.0.0.1' );

			} );
			if ( candidate !== startPort ) console.warn( `[batch-e2e] port ${ startPort } busy; using ${ candidate } instead` );
			return candidate;

		} catch ( err ) {

			if ( ! err || err.code !== 'EADDRINUSE' || attempt === maxRetries ) throw err;

		}

	}

}

port = await listenWithPortFallback( server, port, portRetries );
console.log( `[batch-e2e] server on http://localhost:${ port}/` );

const BROWSER_ARGS = [ '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--no-sandbox', '--disable-dev-shm-usage' ];
const NAV_TIMEOUT_MS = 30000;
const RENDER_TIMEOUT_MS = 12000;
// Loader-gated wait can take much longer than RENDER_TIMEOUT_MS — examples like
// webgpu_loader_materialx fetch 20+ .mtlx files sequentially and renderer.compileAsync
// each one. The freeze itself is synthetic and fires fast; this budget purely
// absorbs the network + sequential GPU-compile cascade.
const LOADER_TIMEOUT_MS = 45000;
// How long the loader/compile counters must remain at zero before we accept
// "loaders settled". Bridges the gap between sequential awaits (load A → onLoad
// callback kicks load B) where the counter briefly hits 0 mid-cascade.
const LOADER_QUIESCENT_MS = 250;
// Extra rAF ticks to fire at clamped time after counters first go quiet, before
// the freeze actually engages. Covers things that DON'T bump our counters but
// still need a few frames to converge: OrbitControls damping interpolation,
// onWindowResize handlers calling renderer.setSize without an explicit render,
// post-load setTimeout(0) chains, GUI build re-layouts. Each tick fires the
// example's setAnimationLoop callback at the same clamped synthetic time so
// animation phase stays deterministic between capture and replay.
const SETTLE_FRAMES = parseIntAtLeast( getArg( '--settle-frames=', '8' ), 8, 0 );
const RENDER_POLL_MS = 400;
const DEFAULT_MINIMUM_BRIGHT_FRACTION = 0.005;
// Restart the browser more aggressively than wear-and-tear suggests because
// some examples (PMREM-heavy, large GLTF, postprocessing) corrupt the WebGPU
// state in a way that crashes the whole renderer process after 8–11 runs.
// Recreating proactively also keeps Metal/GPU buffer accumulation in check
// on Apple Silicon, where unified memory means GPU pressure freezes the
// whole OS — at 4 runs/browser the parallel runner still froze users'
// machines around the 150-example mark, so we cycle every 2 by default.
// Override with TSLP_E2E_MAX_RUNS_PER_BROWSER=N or --max-runs-per-browser=N
// if a future Chromium/Playwright makes per-context GPU release reliable
// enough to relax this. The per-example catch below handles the residual
// case where a crash hits before we hit this cap.
const MAX_RUNS_PER_BROWSER = parseIntAtLeast( process.env.TSLP_E2E_MAX_RUNS_PER_BROWSER || getArg( '--max-runs-per-browser=', '2' ), 2, 1 );
// Pause after `browser.close()` before relaunching. Without this, Chromium's
// GPU process can still hold Metal buffers when the new browser starts,
// doubling unified-memory pressure for the cross-over moment. 250 ms is
// enough on Apple Silicon for the OS to reclaim GPU resources.
const BROWSER_RESPAWN_DELAY_MS = parseIntAtLeast( process.env.TSLP_E2E_BROWSER_RESPAWN_DELAY_MS || '250', 250, 0 );

// Deterministic-time replay support. Animated examples driven by
// `setAnimationLoop` would otherwise sample different animation phases on
// stock/capture/replay. The default target tick is 0: take the first fully
// loaded, settled frame so per-frame mutations like `rotation += 0.005`
// cannot drift while assets and PMREM compile at different speeds. Use
// `--target-tick=60` when deliberately auditing a later animation phase.
// Real-time fetch / XHR are unaffected, so HDR / KTX2 / GLTF loaders still work.
const PRESENT_SETTLE_MS = parseIntAtLeast( getArg( '--present-settle-ms=', '120' ), 120, 0 );
const ASSET_SETTLE_MS = parseIntAtLeast( getArg( '--asset-settle-ms=', '250' ), 250, 0 );
const BRIGHT_POLL_MS = parseIntAtLeast( getArg( '--bright-poll-ms=', '400' ), 400, 0 );
const HAS_EXPLICIT_SETTLE_FRAMES = args.some( ( arg ) => arg.startsWith( '--settle-frames=' ) );

async function dumpCanvases( page, name = '' ) {

	const canvases = await page.$$( 'canvas' );
	const shots = [];
	const canvasOrder = canvasOrderForExample( name );
	let indices = canvasOrder === 'document'
		? Array.from( canvases.keys() )
		: Array.from( canvases.keys() ).reverse();
	if ( canvasOrder === 'horizontal-right-first' ) {

		// Both renderer initializers run concurrently, so append order is not a
		// canvas identity. Preserve the existing right/global-canvas evidence by
		// selecting it from the authored horizontal layout instead.
		const candidates = await Promise.all( canvases.map( async ( canvas, index ) => {

			const box = await canvas.boundingBox();
			return { index, left: box && box.x || 0 };

		} ) );
		indices = canvasIndicesByHorizontalPosition( candidates, { rightFirst: true } );

	}
	if ( canvasOrder === 'webgpu-backend-first' ) {

		// The example starts both async renderer initializers without awaiting
		// either, so DOM append order is not a backend identity. Prefer the marker
		// installed by the capture/replay wrappers and use the authored left-canvas
		// position for the unwrapped stock pass.
		const candidates = await Promise.all( canvases.map( async ( canvas, index ) => {

			const box = await canvas.boundingBox();
			const backend = await canvas.evaluate( ( element ) => element.dataset && element.dataset.tslpBackend || '' ).catch( () => '' );
			return { index, backend, left: box && box.x || 0 };

		} ) );
		indices = canvasIndicesByBackendThenHorizontalPosition( candidates );

	}
	for ( const i of indices ) {

		const box = await canvases[ i ].boundingBox();
		if ( ! box || box.width <= 0 || box.height <= 0 ) continue;
		try {

			await page.evaluate( isolateCanvasForScreenshot, canvases[ i ] );
			// Let the compositor observe the visibility change before Playwright
			// clips the page for its element screenshot.
			await page.waitForTimeout( 16 );
			shots.push( await canvases[ i ].screenshot( { timeout: 3000 } ) );

		} catch ( _ ) { /* ignore this canvas */ }
		finally {

			try { await page.evaluate( restoreCanvasAfterScreenshot, canvases[ i ] ); } catch ( _ ) {}

		}

	}
	return shots;

}

async function canvasBrightFractionInPage( page ) {

	return await page.evaluate( () => {

		const canvases = document.querySelectorAll( 'canvas' );
		let bestBright = 0;
		for ( const canvas of canvases ) {

			if ( ! canvas.width || ! canvas.height ) continue;
			try {

				const off = new OffscreenCanvas( canvas.width, canvas.height );
				const ctx = off.getContext( '2d' );
				ctx.drawImage( canvas, 0, 0 );
				const img = ctx.getImageData( 0, 0, canvas.width, canvas.height ).data;
				let bright = 0;
				for ( let i = 0; i < img.length; i += 4 ) {

					if ( img[ i ] + img[ i + 1 ] + img[ i + 2 ] > 30 ) bright ++;

				}
				const frac = bright / ( img.length / 4 );
				if ( frac > bestBright ) bestBright = frac;

			} catch ( _ ) { /* ignore canvas read errors */ }

		}
		return bestBright;

	} ).catch( () => 0 );

}

async function dumpBrightestCanvas( page, name = '' ) {

	const shots = await dumpCanvases( page, name );
	const bright = await canvasBrightFractionInPage( page );
	const best = shots.length > 0 ? shots[ 0 ] : null;
	return { shot: best, bright: +bright.toFixed( 4 ) };

}

async function dumpCanvas( page, name = '' ) {

	const result = await dumpBrightestCanvas( page, name );
	return result.shot;

}

async function collectFrameTextureSnapshot( page ) {

	return await page.evaluate( async () => {

		const w = window;
		const pipeline = w.__tslpLastRenderPipeline || null;
		const rendererCandidates = [
			w.__tslpSlimRenderer,
			w.__tslpCurrentReplayRenderer,
			w.__tslpFullRenderer,
			w.__tslpHarnessRenderer,
			w.__tslpComputeRenderer,
		].filter( Boolean );
		const rendererLabels = new Map( [
			[ w.__tslpSlimRenderer, 'slim' ],
			[ w.__tslpCurrentReplayRenderer, 'current' ],
			[ w.__tslpFullRenderer, 'full' ],
			[ w.__tslpHarnessRenderer, 'harness' ],
			[ w.__tslpComputeRenderer, 'compute' ],
		].filter( ( entry ) => entry[ 0 ] ) );
		const renderers = [];
		for ( const renderer of rendererCandidates ) {
			if ( renderer && renderer.backend && typeof renderer.backend.copyTextureToBuffer === 'function' && ! renderers.includes( renderer ) ) {
				renderers.push( renderer );
			}
		}
		const textures = [];
		const seenTextures = new Set();
		const gpuResourceIds = new WeakMap();
		let nextGpuResourceId = 1;
		const gpuResourceId = ( value ) => {
			if ( ! value || ( typeof value !== 'object' && typeof value !== 'function' ) ) return null;
			if ( ! gpuResourceIds.has( value ) ) gpuResourceIds.set( value, nextGpuResourceId ++ );
			return gpuResourceIds.get( value );
		};
		function addTexture( label, texture ) {
			if (
				! texture ||
				texture.isTexture !== true ||
				texture.isDepthTexture === true ||
				seenTextures.has( label + ':' + texture.uuid )
			) return;
			seenTextures.add( label + ':' + texture.uuid );
			textures.push( { label, texture } );
		}
		function effectTypeName( node ) {
			return node && node.constructor && ( node.constructor.type || node.constructor.name ) || node && node.type || '';
		}
		function visit( node, seen = new Set(), depth = 0 ) {
			if ( ! node || depth > 24 || seen.has( node ) || ( typeof node !== 'object' && typeof node !== 'function' ) ) return;
			seen.add( node );
			const type = effectTypeName( node );
			if ( node.isPassNode === true ) {
				try {
					const passTextures = node._textures || {};
					for ( const [ name, texture ] of Object.entries( passTextures ) ) addTexture( 'Pass.' + name, texture );
					if ( ! passTextures.output ) addTexture( 'Pass.output', node.renderTarget && node.renderTarget.texture );
				} catch ( _ ) {}
			}
			if ( type === 'BloomNode' || node && node._renderTargetBright && node._renderTargetsHorizontal ) {
				addTexture( 'Bloom.bright', node._renderTargetBright && node._renderTargetBright.texture );
				const horizontal = Array.isArray( node._renderTargetsHorizontal ) ? node._renderTargetsHorizontal : [];
				const vertical = Array.isArray( node._renderTargetsVertical ) ? node._renderTargetsVertical : [];
				for ( let i = 0; i < Math.min( 2, horizontal.length ); i ++ ) addTexture( 'Bloom.h' + i, horizontal[ i ] && horizontal[ i ].texture );
				for ( let i = 0; i < Math.min( 2, vertical.length ); i ++ ) addTexture( 'Bloom.v' + i, vertical[ i ] && vertical[ i ].texture );
			}
			if ( type === 'LensflareNode' ) {
				try {
					const textureNode = typeof node.getTextureNode === 'function' ? node.getTextureNode() : node._textureNode;
					addTexture( 'Lensflare.output', textureNode && textureNode.value || node._renderTarget && node._renderTarget.texture );
					addTexture( 'Lensflare.input', node.textureNode && node.textureNode.value );
				} catch ( _ ) {}
			}
			if ( type === 'GaussianBlurNode' ) {
				addTexture( 'GaussianBlur.input', node.textureNode && node.textureNode.value );
				addTexture( 'GaussianBlur.horizontal', node._horizontalRT && node._horizontalRT.texture );
				addTexture( 'GaussianBlur.vertical', node._verticalRT && node._verticalRT.texture );
			}
			if ( type === 'SSRNode' ) {
				addTexture( 'SSR.output', node._ssrRenderTarget && node._ssrRenderTarget.texture );
				addTexture( 'SSR.blur', node._blurRenderTarget && node._blurRenderTarget.texture );
			}
			if ( type === 'TemporalReprojectNode' ) {
				addTexture( 'TemporalReproject.beauty', node.beautyNode && node.beautyNode.value );
				addTexture( 'TemporalReproject.resolve', node._resolveRenderTarget && node._resolveRenderTarget.texture );
				addTexture( 'TemporalReproject.history', node._historyRenderTarget && node._historyRenderTarget.texture );
			}
			if ( type === 'RecurrentDenoiseNode' ) {
				addTexture( 'RecurrentDenoise.output', node._renderTarget && node._renderTarget.texture );
			}
			if ( type === 'TRAANode' || type === 'TAAUNode' ) {
				addTexture( type + '.resolve', node._resolveRenderTarget && node._resolveRenderTarget.texture );
				addTexture( type + '.history', node._historyRenderTarget && node._historyRenderTarget.texture );
			}
			if ( type === 'SharpenNode' ) {
				addTexture( 'Sharpen.output', node._renderTarget && node._renderTarget.texture );
			}
			const keys = [];
			try { keys.push( ...Object.getOwnPropertyNames( node ) ); } catch ( _ ) {}
			const skip = new Set( [ 'parent', 'children', '_cache', 'scene', 'camera', 'renderer', 'geometry', 'material', 'domElement' ] );
			for ( const key of keys ) {
				if ( skip.has( key ) ) continue;
				let child = null;
				try {
					const descriptor = Object.getOwnPropertyDescriptor( node, key );
					if ( descriptor && Object.prototype.hasOwnProperty.call( descriptor, 'value' ) ) child = descriptor.value;
				} catch ( _ ) {}
				if ( ! child ) continue;
				if ( Array.isArray( child ) ) {
					for ( const item of child ) visit( item, seen, depth + 1 );
				} else {
					visit( child, seen, depth + 1 );
				}
			}
		}
		if ( pipeline && pipeline.outputNode ) visit( pipeline.outputNode );
		for ( const node of w.__tslpDebugPipelineNodes || [] ) visit( node );
		const out = [];
		for ( const { label, texture } of textures ) {
			const image = texture.image || {};
			const width = image.width || image.naturalWidth || image.videoWidth || 0;
			const height = image.height || image.naturalHeight || image.videoHeight || 0;
			if ( ! width || ! height ) continue;
			let record = null;
			for ( const renderer of renderers ) {
				try {
					const buf = await renderer.backend.copyTextureToBuffer( texture, 0, 0, width, height, 0 );
					const view = ArrayBuffer.isView( buf ) ? buf : new Uint8Array( buf );
					const bytes = view instanceof Uint8Array ? view : new Uint8Array( view.buffer, view.byteOffset, view.byteLength );
					let hash = 2166136261;
					let nonzero = 0;
					let sum = 0;
					let max = 0;
					for ( let i = 0; i < bytes.length; i ++ ) {
						const value = bytes[ i ];
						hash ^= value;
						hash = Math.imul( hash, 16777619 ) >>> 0;
						sum += value;
						if ( value !== 0 ) nonzero ++;
						if ( value > max ) max = value;
					}
					record = {
						label,
						name: texture.name || '',
						uuid: texture.uuid || '',
						width,
						height,
						bytes: bytes.length,
						hash: hash.toString( 16 ).padStart( 8, '0' ),
						meanByte: sum / Math.max( 1, bytes.length ),
						nonzeroByteFrac: nonzero / Math.max( 1, bytes.length ),
						maxByte: max,
						rendererResources: renderers.map( ( candidate ) => {
							let resource = null;
							try { resource = candidate.backend.get( texture ).texture || null; } catch ( _ ) {}
							return {
								renderer: rendererLabels.get( candidate ) || 'renderer',
								gpu: gpuResourceId( resource ),
							};
						} ),
					};
					break;
				} catch ( err ) {
					record = {
						label,
						name: texture.name || '',
						uuid: texture.uuid || '',
						width,
						height,
						error: err && err.message || String( err ),
					};
				}
			}
			if ( record ) out.push( record );
			if ( out.length >= 32 ) break;
		}
		return out;

	} ).catch( ( err ) => [ { error: err && err.message || String( err ) } ] );

}

function safeExampleName( name ) {

	return name.replace( /[^A-Za-z0-9_.-]/g, '_' );

}

function writeArtifactDebugDump( file, value, summary ) {

	return writeCompressedArtifactDebugDump( { outputRoot: OUT, file, value, summary } );

}

function emptyVisitResult( overrides = {} ) {

	return {
		bright: 0,
		shot: null,
		errors: [],
		errorCount: 0,
		warnings: [],
		warningCount: 0,
		canvasBackends: [],
		diagnostics: null,
		networkEvidence: null,
		networkFixtureRoot: null,
		networkFixtureRunId: null,
		context: null,
		page: null,
		cleanup: async () => {},
		...overrides,
	};

}

let savedEvidenceInput = null;
function loadSavedEvidenceInput() {

	if ( savedEvidenceInput ) return savedEvidenceInput;
	const manifestPath = join( INPUT_ROOT, E2E_EVIDENCE_MANIFEST );
	if ( ! existsSync( manifestPath ) ) {

		throw new Error( `saved evidence manifest is missing: ${ manifestPath }` );

	}
	const manifest = JSON.parse( readSafeContainedFile( INPUT_ROOT, manifestPath, {
		label: 'saved evidence manifest',
	} ).toString( 'utf8' ) );
	if ( manifest.schemaVersion !== E2E_EVIDENCE_SCHEMA_VERSION || typeof manifest.runId !== 'string' ) {

		throw new Error( `saved evidence manifest ${ manifestPath } is not schema ${ E2E_EVIDENCE_SCHEMA_VERSION }` );

	}
	if ( manifest.catalogue?.sha256 !== EVIDENCE_CATALOGUE.sha256 ) {

		throw new Error(
			`saved evidence catalogue ${ manifest.catalogue?.sha256 || '<missing>' } does not match ` +
			`the current catalogue ${ EVIDENCE_CATALOGUE.sha256 }`,
		);

	}
	const reportEvidence = verifyEvidenceDescriptor( INPUT_ROOT, manifest.report, manifest.runId );
	const inputReport = JSON.parse( reportEvidence.bytes.toString( 'utf8' ) );
	if (
		inputReport.schemaVersion !== E2E_EVIDENCE_SCHEMA_VERSION ||
		inputReport.runId !== manifest.runId ||
		inputReport.campaignId !== manifest.campaignId ||
		inputReport.status !== 'completed'
	) {

		throw new Error( `saved evidence report ${ manifest.report.file } is not the completed run ${ manifest.runId }` );

	}
	assertEvidenceEnvironment( inputReport.configuration?.environment, 'Saved evidence report environment' );
	if (
		inputReport.configuration?.fingerprint !== manifest.configuration?.fingerprint ||
		inputReport.evidence?.configurationFingerprint !== manifest.configuration?.fingerprint
	) {

		throw new Error( `saved evidence run ${ manifest.runId } has configuration fingerprint drift` );

	}
	const fingerprintedConfiguration = { ...inputReport.configuration };
	delete fingerprintedConfiguration.fingerprint;
	if (
		fingerprintJson( fingerprintedConfiguration ) !== manifest.configuration.fingerprint ||
		fingerprintJson( inputReport.configuration.environment ) !==
			fingerprintJson( manifest.configuration.environment )
	) {

		throw new Error( `saved evidence run ${ manifest.runId } has environment provenance drift` );

	}
	if ( ! Array.isArray( manifest.cases ) ) throw new Error( 'saved evidence manifest has no cases array' );
	savedEvidenceInput = {
		manifest,
		byName: new Map( manifest.cases.map( ( entry ) => [ entry.name, entry ] ) ),
	};
	return savedEvidenceInput;

}

function savedEvidenceCase( name ) {

	const input = loadSavedEvidenceInput();
	const entry = input.byName.get( name );
	if ( ! entry ) throw new Error( `saved evidence run ${ input.manifest.runId } has no case ${ name }` );
	if ( entry.runId !== input.manifest.runId ) throw new Error( `saved evidence case ${ name } has a mismatched runId` );
	return { input, entry };

}

function loadSavedReferenceShot( name ) {

	let saved;
	try {

		saved = savedEvidenceCase( name );

	} catch ( error ) {

		return emptyVisitResult( { errors: [ error && error.message || String( error ) ] } );

	}
	if ( ! saved.entry.capture ) {

		return emptyVisitResult( { errors: [ `saved evidence case ${ name } has no capture screenshot` ] } );

	}
	const { bytes } = verifyEvidenceDescriptor( INPUT_ROOT, saved.entry.capture, saved.input.manifest.runId );
	let networkEvidence = saved.entry.networkInputs?.stock;
	if ( ! networkEvidence ) {

		return emptyVisitResult( { errors: [ `saved evidence case ${ name } has no stock network evidence` ] } );

	}
	try {

		assertStoredE2ENetworkObservation( networkEvidence, {
			outputRoot: INPUT_ROOT,
			runId: saved.input.manifest.runId,
			label: `Saved stock network evidence for ${ name }`,
		} );
		const bodies = new Map();
		for ( const resource of networkEvidence.resources ) {

			if ( bodies.has( resource.sha256 ) ) continue;
			const verified = verifyEvidenceDescriptor(
				INPUT_ROOT,
				resource.evidence,
				saved.input.manifest.runId,
			);
			bodies.set( resource.sha256, verified.bytes );

		}
		networkEvidence = bindRunNetworkEvidence( networkEvidence, bodies );

	} catch ( error ) {

		return emptyVisitResult( { errors: [ error && error.message || String( error ) ] } );

	}
	return emptyVisitResult( {
		shot: bytes,
		fromDisk: true,
		sourceRunId: saved.input.manifest.runId,
		networkEvidence,
		networkFixtureRoot: OUT,
		networkFixtureRunId: RUN_ID,
	} );

}

function loadSavedArtifacts( name ) {

	const { input, entry } = savedEvidenceCase( name );
	if ( ! entry.userArtifacts || ! entry.auxArtifacts ) {

		throw new Error( `saved evidence case ${ name } has no replayable artifact pair` );

	}
	if ( entry.userArtifacts.truncated || entry.auxArtifacts.truncated ) {

		throw new Error( `saved evidence case ${ name } contains a truncated artifact dump` );

	}
	const user = readArtifactEvidenceJson( {
		outputRoot: INPUT_ROOT,
		descriptor: entry.userArtifacts,
		expectedRunId: input.manifest.runId,
		label: `Saved user artifact evidence for ${ name }`,
	} );
	const aux = readArtifactEvidenceJson( {
		outputRoot: INPUT_ROOT,
		descriptor: entry.auxArtifacts,
		expectedRunId: input.manifest.runId,
		label: `Saved auxiliary artifact evidence for ${ name }`,
	} );
	const bucket = { user: user || {}, aux: Array.isArray( aux ) ? aux : [] };
	captures.set( name, bucket );
	return bucket;

}

async function brightFraction( page, pngBuf ) {

	if ( ! pngBuf ) return 0;
	return await page.evaluate( async ( b64 ) => {

		try {

			const blob = await ( await fetch( 'data:image/png;base64,' + b64 ) ).blob();
			const bmp = await createImageBitmap( blob );
			const off = new OffscreenCanvas( bmp.width, bmp.height );
			const ctx = off.getContext( '2d' );
			ctx.drawImage( bmp, 0, 0 );
			const img = ctx.getImageData( 0, 0, bmp.width, bmp.height ).data;
			let bright = 0;
			for ( let i = 0; i < img.length; i += 4 ) {

				if ( img[ i ] + img[ i + 1 ] + img[ i + 2 ] > 30 ) bright ++;

			}
			return bright / ( img.length / 4 );

		} catch ( _ ) {

			return 0;

		}

	}, pngBuf.toString( 'base64' ) );

}

async function comparePSNR( _page, captureShot, replayShot, name = '' ) {

	if ( ! captureShot || ! replayShot ) return { error: 'missing screenshot' };
	return comparePngBuffers( captureShot, replayShot, { name } );

}

async function maybeClickStart( page ) {

	await page.evaluate( () => {

		const clickables = [ document.getElementById( 'startButton' ), document.querySelector( '#overlay button' ) ];
		for ( const el of document.querySelectorAll( 'button' ) ) {

			const t = ( el.textContent || '' ).trim().toLowerCase();
			if ( /^(play|start|begin|enter)$/.test( t ) ) clickables.push( el );

		}
		for ( const el of clickables ) {

			if ( ! el ) continue;
			const r = el.getBoundingClientRect();
			if ( r.width <= 0 || r.height <= 0 || el.disabled ) continue;
			el.click();

		}

	} );

}

async function waitForFrame( page, timeoutMs, minimumBrightFraction = DEFAULT_MINIMUM_BRIGHT_FRACTION ) {

	try {

		await page.waitForSelector( 'canvas', { state: 'attached', timeout: Math.min( timeoutMs, 5000 ) } );
		await page.evaluate( () => new Promise( ( resolve ) => {

			let done = false;
			const finish = () => {

				if ( done ) return;
				done = true;
				resolve();

			};
			setTimeout( finish, 250 );
			requestAnimationFrame( () => requestAnimationFrame( finish ) );

		} ) );

	} catch ( _ ) { /* keep the bright poll below as the fallback */ }

	// WebGPU canvases are often not readable through drawImage() until after
	// compositor capture. The final screenshot brightness check below is the
	// authoritative gate, so don't spend the full render timeout on this poll.
	const deadline = Date.now() + Math.min( timeoutMs, BRIGHT_POLL_MS );
	let bright = 0;
	while ( Date.now() < deadline ) {

		bright = await canvasBrightFractionInPage( page );
		if ( bright > minimumBrightFraction ) break;
		await new Promise( ( r ) => setTimeout( r, RENDER_POLL_MS ) );

	}
	return +bright.toFixed( 4 );

}

async function visitExample( browser, name, mode, waitMs, {
	networkFixture = null,
	networkFixtureRoot = OUT,
	networkFixtureRunId = RUN_ID,
} = {} ) {

	const timings = { mode };
	const minimumBrightFraction = minimumBrightFractionForExample( name, DEFAULT_MINIMUM_BRIGHT_FRACTION );
	const startedAt = Date.now();
	const mark = ( key, from ) => { timings[ key ] = Date.now() - from; };
	const trace = ( phase ) => {

		if ( verboseConsole ) console.log( `[batch-e2e] visit ${ name } ${ mode }: ${ phase } (+${ Date.now() - startedAt }ms)` );

	};
	trace( 'start' );

	const examplePath = examplePathFor( name );
	const separator = examplePath.includes( '?' ) ? '&' : '?';
	const pageUrl = `http://localhost:${ port }/examples/${ examplePath }${ separator }__tslp_mode=${ mode }&__tslp_case=${ encodeURIComponent( name ) }`;
	let stepStartedAt = Date.now();
	const context = await browser.newContext( {
		viewport: { width: 640, height: 480 },
		serviceWorkers: 'block',
	} );
	const networkBodyCache = new Map();
	const networkCollector = networkFixture
		? await installE2ENetworkFixtureReplayCollector( context, {
			pageUrl,
			fixture: networkFixture,
			serviceWorkersBlocked: true,
			loadBody( resource ) {

				const cached = networkBodyCache.get( resource.sha256 );
				if ( cached ) return cached;
				const verified = verifyEvidenceDescriptor(
					networkFixtureRoot,
					resource.evidence,
					networkFixtureRunId,
				);
				networkBodyCache.set( resource.sha256, verified.bytes );
				return verified.bytes;

			},
		} )
		: await installE2ENetworkCaptureCollector( context, {
			pageUrl,
			serviceWorkersBlocked: true,
		} );
	const page = await context.newPage();
	const browserFailures = installBrowserFailureCollector( page, { pageUrl } );
	mark( 'contextMs', stepStartedAt );
	trace( 'context-ready' );
	// Non-browser harness assertions remain separate from the shared browser
	// failure policy, then join its fail-closed messages at the visit boundary.
	const errors = [];
	const warnings = [];
	let canvasBackends = [];
	let networkEvidence = null;
	let networkFinalized = false;
	let visitResult = null;
	const recordNetworkError = ( value ) => {

		const message = `network evidence: ${ value && value.message || value }`;
		errors.push( message );
		if ( visitResult && visitResult.errors !== errors ) {

			visitResult.errors.push( message );
			visitResult.errorCount = visitResult.errors.length;

		}

	};
	const finalizeNetworkEvidence = async () => {

		if ( networkFinalized ) return networkEvidence;
		networkFinalized = true;
		try {

			const sealed = await networkCollector.drain();
			const expectedMode = networkFixture ? 'replay' : 'capture';
			const issues = e2eNetworkObservationIssues( sealed.observation, { expectedMode } );
			if ( issues.length > 0 ) {

				networkEvidence = sealed.observation;
				for ( const issue of issues ) recordNetworkError( issue );

			} else {

				networkEvidence = bindRunNetworkEvidence( sealed.observation, sealed.bodies );

			}

		} catch ( error ) {

			recordNetworkError( error );

		}
		return networkEvidence;

	};

	// Named diagnostic handlers so cleanup() can detach them. Without removeListener
	// the closures retain references to errors/warnings/mode for the lifetime
	// of the underlying Playwright page object — across a long parallel run
	// that holds page+context (and the GPU resources they back) past
	// context.close() and shows up as steady RSS climb.
	const traceResponses = !! process.env.TSLP_DEBUG_TORNADO_TRACE;
	const onResponse = async ( res ) => {

		const url = res.url();
		if ( /__tslp__|__tslp_runtime|__tslp_plugin|three\.webgpu|three\.tsl|tsl-stub|tornado/.test( url ) ) {
			try {
				const txt = await res.text();
				console.log( `[res ${ mode }]`, res.status(), url, 'len=', txt.length );
				if ( /tornado/.test( url ) && process.env.TSLP_DEBUG_DUMP_HTML ) {
					writeOutputFileAtomic(
						OUT,
						join( OUT, 'debug-http', `tornado-${ safeExampleName( mode ) }.html` ),
						txt,
						{ label: 'Tornado response debug HTML' },
					);
				}
			} catch ( _ ) { /* not text */ }
		}

	};
	const onConsole = ( m ) => {

		if ( m.type() === 'error' && process.env.TSLP_DEBUG_TORNADO ) console.error( `[console-error ${ mode }]`, m.text() );
		if ( m.type() === 'warning' && isTslpWarningMessage( m.text() ) ) {
			warnings.push( m.text() );
			if ( verboseConsole ) console.warn( `[page-warn ${ mode }] ${ m.text() }` );
		}
		if ( m.type() === 'log' && isTslpWarningMessage( m.text() ) && verboseConsole ) console.log( `[page-log ${ mode }] ${ m.text() }` );
		if ( process.env.TSLP_DEBUG_TORNADO_VERBOSE ) console.log( `[page-${ m.type() } ${ mode }]`, m.text() );

	};
	if ( traceResponses ) page.on( 'response', onResponse );
	page.on( 'console', onConsole );

	// Single owner for tearing down a visit's Playwright resources. Always
	// detach listeners first (so any in-flight event between page.close()
	// and context.close() can't push into the captured arrays and keep
	// them alive), then close the page, then close the context.
	const cleanup = async () => {

		try {
			browserFailures.dispose();
			if ( traceResponses ) page.off( 'response', onResponse );
			page.off( 'console', onConsole );
		} catch ( _ ) {}
		try { await page.close( { runBeforeUnload: false } ); } catch ( _ ) {}
		try { networkCollector.assertNoLateRequests(); } catch ( error ) {
			recordNetworkError( error );
		}
		try { await context.close(); } catch ( _ ) {}
		try { networkCollector.assertNoLateRequests(); } catch ( error ) {
			recordNetworkError( error );
		}
		try { await networkCollector.dispose(); } catch ( _ ) {}

	};

	// Inject a deterministic-rAF shim BEFORE the page navigates so it's
	// active from the very first script. Each `requestAnimationFrame`
	// callback receives a synthetic monotonic timestamp that advances by
	// exactly FRAME_STEP_MS per tick. `Date.now()` / `performance.now()`
	// / `setTimeout` are left alone so async loaders, fetch, and
	// renderer init still progress on real time — only the animation
	// loop sees the synthetic clock.
	//
	// Stock, capture, and replay block until tick >= TARGET_TICK, freeze
	// the synthetic clock at TARGET_TICK, then screenshot. With the default
	// target tick of 0, any
	// `setAnimationLoop( ( time ) => ... )` callback therefore sees the
	// same post-load settled time in all passes, so per-frame animations do
	// not drift just because replay generated PMREM or hydrated artifacts.
	const effectiveTargetTick = targetTickForExample( name, targetTick, HAS_EXPLICIT_TARGET_TICK );
	const TARGET_TICK = Number.isFinite( effectiveTargetTick ) ? Math.max( 0, effectiveTargetTick | 0 ) : 0;
	const FRAME_STEP_MS = 16.6667;
		const effectiveSettleFrames = settleFramesForExample( name, SETTLE_FRAMES, HAS_EXPLICIT_SETTLE_FRAMES );
		const minimumAnimationLoopOwners = minimumAnimationLoopOwnersForExample( name );
		timings.targetTick = TARGET_TICK;
		timings.settleFrames = effectiveSettleFrames;
		timings.minimumAnimationLoopOwners = minimumAnimationLoopOwners;
		const waitForRenderableObjects = await exampleUsesDeferredSceneAssets( name );
		const minRenderableObjects = minimumRenderableObjectsForExample( name );
		const holdAnimationUntilReady = holdAnimationUntilReadyForExample( name );
		const deterministicTimeoutPolicy = deterministicTimeoutPolicyForExample( name );
		const browserStabilizationPolicy = browserStabilizationPolicyForExample( name );
	try {

		stepStartedAt = Date.now();
		if ( process.env.TSLP_DEBUG_SHADOW_COVERAGE === '1' && mode === 'replay' ) {
			await page.addInitScript( () => { globalThis.__TSLP_DEBUG_SHADOW_COVERAGE = true; window.__TSLP_DEBUG_SHADOW_COVERAGE = true; } );
		}
		if ( process.env.TSLP_DEBUG_LIGHT_LINKAGE === '1' && mode === 'replay' ) {
			await page.addInitScript( () => { globalThis.__TSLP_DEBUG_LIGHT_LINKAGE = true; window.__TSLP_DEBUG_LIGHT_LINKAGE = true; } );
		}
		if ( process.env.TSLP_DEBUG_SHADOW_BINDINGS === '1' && mode === 'replay' ) {
			await page.addInitScript( () => { globalThis.__TSLP_DEBUG_SHADOW_BINDINGS = true; window.__TSLP_DEBUG_SHADOW_BINDINGS = true; } );
		}
		if ( process.env.TSLP_DEBUG_FRAME_TEXTURES === '1' && mode === 'replay' ) {
			await page.addInitScript( () => { globalThis.__TSLP_DEBUG_FRAME_TEXTURES = true; window.__TSLP_DEBUG_FRAME_TEXTURES = true; } );
		}
		if ( process.env.TSLP_DEBUG_SSR_RESOURCES === '1' && mode === 'replay' ) {
			await page.addInitScript( () => { globalThis.__TSLP_DEBUG_SSR_RESOURCES = true; window.__TSLP_DEBUG_SSR_RESOURCES = true; } );
		}
		if ( process.env.TSLP_DEBUG_PMREM_READBACK === '1' && mode === 'replay' ) {
			await page.addInitScript( () => { globalThis.__TSLP_DEBUG_PMREM_READBACK = true; window.__TSLP_DEBUG_PMREM_READBACK = true; } );
		}
		if ( process.env.TSLP_DEBUG_IBL_BINDINGS === '1' && mode === 'replay' ) {
			await page.addInitScript( () => { globalThis.__TSLP_DEBUG_IBL_BINDINGS = true; window.__TSLP_DEBUG_IBL_BINDINGS = true; } );
		}
		if ( process.env.TSLP_DEBUG_OBJECT_UBO === '1' && mode === 'replay' ) {
			await page.addInitScript( () => { globalThis.__TSLP_DEBUG_OBJECT_UBO = true; window.__TSLP_DEBUG_OBJECT_UBO = true; } );
		}
		if ( process.env.TSLP_DEBUG_REFLECTOR_BINDINGS === '1' && mode === 'replay' ) {
			await page.addInitScript( () => { globalThis.__TSLP_DEBUG_REFLECTOR_BINDINGS = true; window.__TSLP_DEBUG_REFLECTOR_BINDINGS = true; } );
		}
			await page.addInitScript( installAnimationLoopOwnerReadiness );
			await page.addInitScript( installAnimationLoopSettleTransition );
			await page.addInitScript( installRenderSelectorMismatchRecorder, { phase: mode } );
			await page.addInitScript( installE2EGpuDiagnostics );
			await page.addInitScript( ( { step, base, freezeAt, quiescentMs, settleFrames, minimumAnimationLoopOwners, waitForRenderableObjects, minRenderableObjects, holdAnimationUntilReady, requireSuccessfulPresentation, deterministicTimeoutPolicy, browserStabilizationPolicy } ) => {

			// eslint-disable-next-line no-undef
			const w = window;
			const diagnostics = w.__tslpHarnessDiagnostics || ( w.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
			if ( deterministicTimeoutPolicy && ! w.__tslpDeterministicTimeoutInstalled ) {
				w.__tslpDeterministicTimeoutInstalled = true;
				const nativeSetTimeout = w.setTimeout.bind( w );
				const nativeClearTimeout = w.clearTimeout.bind( w );
				const targetDelay = Math.max( 0, Number( deterministicTimeoutPolicy.delayMs ) || 0 );
				const queue = [];
				const pending = new Map();
				let nextId = - 1;
				w.__tslpDeterministicTimeoutQueue = queue;
				w.__tslpDeterministicTimeoutTrace = [];
				w.setTimeout = function ( callback, delay = 0, ...args ) {
					if ( typeof callback === 'function' && Number( delay ) === targetDelay ) {
						const id = nextId --;
						const record = { id, callback, args, cancelled: false };
						pending.set( id, record );
						queue.push( record );
						return id;
					}
					return nativeSetTimeout( callback, delay, ...args );
				};
				w.clearTimeout = function ( id ) {
					const record = pending.get( id );
					if ( record ) {
						record.cancelled = true;
						pending.delete( id );
						return;
					}
					return nativeClearTimeout( id );
				};
				w.__tslpRunDeterministicTimeouts = async function ( count ) {
					let ran = 0;
					while ( ran < Math.max( 0, count | 0 ) ) {
						let record = queue.shift() || null;
						while ( record && record.cancelled ) record = queue.shift() || null;
						if ( ! record ) break;
						pending.delete( record.id );
						w.__tslpDeterministicTimeoutTrace.push( record.callback.name || '<anonymous>' );
						const result = record.callback( ...record.args );
						if ( result && typeof result.then === 'function' ) await result;
						await Promise.resolve();
						ran ++;
					}
					return ran;
				};
			}
			if ( w.__tslpRafShimInstalled ) return;
			w.__tslpRafShimInstalled = true;
				w.__tslpRafTick = 0;
				w.__tslpFrozen = false;
				w.__tslpAnimationLoopRegistered = false;
				w.__tslpAnimationLoopCalls = 0;
				w.__tslpFrameCallbackCount = 0;
				if ( browserStabilizationPolicy?.freezeRepresentativeVideoDecoderFrame === true && typeof w.VideoDecoder === 'function' && ! w.VideoDecoder.__tslpFirstFrameOnly ) {
				const NativeVideoDecoder = w.VideoDecoder;
				w.VideoDecoder = class VideoDecoder extends NativeVideoDecoder {
					static __tslpFirstFrameOnly = true;
					constructor( init = {} ) {
						let delivered = false;
						let decodedFrames = 0;
						const targetTimestamp = 5_000_000;
						const output = typeof init.output === 'function' ? init.output : null;
						const error = typeof init.error === 'function' ? init.error : null;
						let pending = true;
						w.__tslpLoaderPending = ( w.__tslpLoaderPending | 0 ) + 1;
						w.__tslpLoaderLastBusyAt = typeof w.__tslpRealNow === 'function' ? w.__tslpRealNow() : 1;
						const settleFirstFrame = () => {
							if ( ! pending ) return;
							pending = false;
							w.__tslpLoaderPending = Math.max( 0, ( w.__tslpLoaderPending | 0 ) - 1 );
							w.__tslpLoaderLastBusyAt = typeof w.__tslpRealNow === 'function' ? w.__tslpRealNow() : 1;
						};
						super( {
							...init,
							output( frame ) {
								decodedFrames ++;
								if ( delivered ) {
									try { frame.close && frame.close(); } catch ( _ ) {}
									return;
								}
								const timestamp = Number( frame && frame.timestamp );
								const reachedRepresentativeFrame = Number.isFinite( timestamp )
									? timestamp >= targetTimestamp
									: decodedFrames >= 120;
								if ( ! reachedRepresentativeFrame ) {
									try { frame.close && frame.close(); } catch ( _ ) {}
									return;
								}
								delivered = true;
								w.__tslpVideoFrameDelivered = true;
								try {
									if ( output ) return output( frame );
								} finally {
									settleFirstFrame();
								}
							},
							error( reason ) {
								try {
									if ( error ) return error( reason );
								} finally {
									settleFirstFrame();
								}
							},
						} );
					}
					decode( chunk ) {
						if ( w.__tslpVideoFrameDelivered === true ) return;
						return super.decode( chunk );
					}
					flush() {
						if ( w.__tslpVideoFrameDelivered === true ) return new Promise( () => {} );
						return super.flush();
					}
				};
			}
			w.__tslpWrapAnimationLoop = function ( callback, owner = null ) {

				const transitionAnimationLoopSettle = w.__tslpTransitionAnimationLoopSettle;
				if ( typeof transitionAnimationLoopSettle !== 'function' ) throw new Error( '[batch-e2e] animation-loop settle transition was not installed' );
				const ownerReadiness = w.__tslpAnimationLoopOwnerReadiness;
				const ownerReadinessEnabled = minimumAnimationLoopOwners > 1
					&& ownerReadiness && typeof ownerReadiness.register === 'function';
				const ownerState = ownerReadinessEnabled
					? ownerReadiness.register( owner, callback )
					: null;
				if ( ! ownerReadinessEnabled ) {

					w.__tslpAnimationLoopRegistered = typeof callback === 'function';
					w.__tslpAnimationLoopCalls = 0;

				}
				w.__tslpSettleTicks = 0;
				if ( typeof callback !== 'function' ) return callback;
				return function ( ...args ) {

					const completedSteps = w.__tslpFrameCallbackCount | 0;
					const atTarget = completedSteps >= freezeAt;
					const previousAnimationLoopCalls = ownerState
						? ownerState.animationLoopCalls | 0
						: w.__tslpAnimationLoopCalls | 0;
					const previousSuccessfulCallbacks = ownerState ? ownerState.successfulCallbacks | 0 : 0;
					const previousRafTick = w.__tslpRafTick | 0;
					const waitingForRenderableObjects = w.__tslpWaitForRenderableObjects === true && ( w.__tslpRenderableObjectCount | 0 ) < ( w.__tslpMinRenderableObjects | 0 );
					const waitingForAsyncCounters = ( w.__tslpLoaderPending | 0 ) !== 0
						|| ( w.__tslpCompilePending | 0 ) !== 0
						|| ( w.__tslpPmremPending | 0 ) !== 0
						|| ( w.__tslpShadowPending | 0 ) !== 0
						|| ( w.__tslpComputePending | 0 ) !== 0;
					// A shadow job belongs to the callback that started it. Pause until
					// that job finishes, but retain the completed-callback count; resetting
					// it makes animated shadow scenes launch another job forever. Loader,
					// compile, PMREM, compute, and scene-population work can change the next
					// callback's inputs, so those still restart the settle count.
						const waitingForAsyncWork = ( w.__tslpLoaderPending | 0 ) !== 0
							|| ( w.__tslpCompilePending | 0 ) !== 0
							|| ( w.__tslpPmremPending | 0 ) !== 0
							|| ( w.__tslpComputePending | 0 ) !== 0
							|| waitingForRenderableObjects;
						const presentation = w.__tslpPresentationReadiness;
						const presentationReady = requireSuccessfulPresentation !== true
							|| !! presentation && ( presentation.successful | 0 ) > ( presentation.requiredAfter | 0 );
						const retainAsyncProgress = requireSuccessfulPresentation === true
							&& presentationReady
							&& ( w.__tslpLoaderPending | 0 ) === 0
							&& ! waitingForRenderableObjects;
						const transition = transitionAnimationLoopSettle( {
							animationLoopCalls: previousAnimationLoopCalls,
							atTarget,
							computePending: ( w.__tslpComputePending | 0 ) !== 0,
							holdAnimationUntilReady: w.__tslpHoldAnimationUntilReady === true,
							presentationReady,
							retainAsyncProgress,
							settleFrames,
							shadowPending: ( w.__tslpShadowPending | 0 ) !== 0,
							waitingForAsyncCounters,
							waitingForAsyncWork,
					} );
					if ( ownerState ) {

						ownerState.animationLoopCalls = transition.animationLoopCalls;
						if ( transition.animationLoopCalls < previousAnimationLoopCalls ) ownerState.successfulCallbacks = 0;
						ownerReadiness.sync();

					} else {

						w.__tslpAnimationLoopCalls = transition.animationLoopCalls;

					}
					if ( ! transition.runCallback ) return;
					const nextSteps = completedSteps + 1;
					if ( ! atTarget ) w.__tslpRafTick = Math.min( freezeAt, nextSteps );
					w.__tslpFrameCallbackCount = nextSteps;
					args[ 0 ] = base + Math.min( freezeAt, nextSteps ) * step;
					try {

						const result = callback.apply( this, args );
						if ( ownerState ) {

							ownerState.successfulCallbacks = ( ownerState.successfulCallbacks | 0 ) + 1;
							ownerReadiness.sync();

						}
						return result;

					} catch ( error ) {

						w.__tslpFrameCallbackCount = completedSteps;
						if ( ownerState ) {

							ownerState.animationLoopCalls = previousAnimationLoopCalls;
							ownerState.successfulCallbacks = previousSuccessfulCallbacks;
							ownerReadiness.sync();

						} else {

							w.__tslpAnimationLoopCalls = previousAnimationLoopCalls;

						}
						if ( ! atTarget ) w.__tslpRafTick = previousRafTick;
						throw error;

					}

				};

			};

			// Pending counters for async loaders (HDR/GLTF/MaterialX/Texture/...) and
			// in-flight renderer.compileAsync() promises. The Playwright wait gate
			// requires both === 0 (and 250 ms of quiescence) before screenshotting,
			// so capture doesn't fire mid-cascade for examples like
			// webgpu_loader_materialx that load 20+ assets sequentially.
			w.__tslpLoaderPending = 0;
			w.__tslpCompilePending = 0;
				w.__tslpLoaderLastBusyAt = 0;
				w.__tslpWaitForRenderableObjects = waitForRenderableObjects === true;
				w.__tslpMinRenderableObjects = Math.max( 1, minRenderableObjects | 0 );
				w.__tslpHoldAnimationUntilReady = holdAnimationUntilReady === true;
				w.__tslpRenderableObjectCount = 0;
			w.__tslpRenderableLastBusyAt = 0;
			if ( browserStabilizationPolicy?.freezeRepresentativeMediaFrame === true && w.HTMLMediaElement && ! w.HTMLMediaElement.prototype.__tslpFreezeFirstFrame ) {
				const mediaPrototype = w.HTMLMediaElement.prototype;
				const nativePlay = mediaPrototype.play;
				mediaPrototype.__tslpFreezeFirstFrame = true;
				mediaPrototype.play = function ( ...playArgs ) {
					const media = this;
					if ( media.__tslpFirstFrameRequested === true ) return nativePlay.apply( media, playArgs );
					media.__tslpFirstFrameRequested = true;
					w.__tslpLoaderPending = ( w.__tslpLoaderPending | 0 ) + 1;
					let settled = false;
					let freezing = false;
					let seekTimeout = null;
					const settle = () => {
						if ( settled ) return;
						settled = true;
						w.__tslpLoaderPending = Math.max( 0, ( w.__tslpLoaderPending | 0 ) - 1 );
						w.__tslpLoaderLastBusyAt = typeof w.__tslpRealNow === 'function' ? w.__tslpRealNow() : 1;
					};
					const finish = () => {
						if ( seekTimeout !== null ) w.clearTimeout( seekTimeout );
						try { media.pause(); } catch ( _ ) {}
						w.__tslpVideoMediaFrozen = true;
						settle();
					};
					const freezeFirstFrame = () => {
						if ( freezing || media.readyState < 2 ) return;
						freezing = true;
						const targetTime = 0.25;
						try { media.pause(); } catch ( _ ) {}
						if ( Math.abs( ( Number( media.currentTime ) || 0 ) - targetTime ) <= 0.001 ) {
							finish();
							return;
						}
						media.addEventListener( 'seeked', finish, { once: true } );
						seekTimeout = w.setTimeout( finish, 2000 );
						try { media.currentTime = targetTime; } catch ( _ ) { finish(); }
					};
					media.addEventListener( 'loadeddata', freezeFirstFrame, { once: true } );
					media.addEventListener( 'error', settle, { once: true } );
					let playResult;
					try {
						playResult = nativePlay.apply( media, playArgs );
					} catch ( error ) {
						settle();
						throw error;
					}
					Promise.resolve( playResult ).then( freezeFirstFrame, settle );
					return playResult;
				};
			}

			// Save the original Date.now BEFORE the synthetic-clock patch below
			// overwrites it. The wait gate uses real wall-clock time to enforce
			// "loaders quiet for 250 ms" — synthetic time freezes at tick 60 so it
			// can't measure post-freeze real-time settle.
			w.__tslpRealNow = Date.now.bind( Date );

				// Patch requestAnimationFrame to use a synthetic monotonic clock.
			// This ensures both capture and replay see the same `time` argument
			// in every animation callback — independent of real wall-clock time.
			//
			// Two-phase freeze:
			//   Phase 1 (tick < freezeAt): tick advances; cb sees time = tick * step.
			//   Phase 2 (tick >= freezeAt): tick is clamped at freezeAt; cb keeps
			//     firing at the same frozen time so renderer.render() continues to
			//     paint scene mutations from post-target loaders. The wrapper
			//     self-freezes (__tslpFrozen = true, all subsequent rAF squashed)
			//     once (a) all pending counters are 0 and have been quiet for
			//     LOADER_QUIESCENT_MS AND (b) `settleFrames` extra ticks have
			//     fired with everything still quiet. The settle pass covers
			//     things that don't bump our counters but still need a few
			//     frames to converge: OrbitControls damping, onWindowResize
			//     handlers calling renderer.setSize without an explicit render,
			//     post-load setTimeout(0) chains, GUI build re-layouts.
			w.__tslpSettleTicks = 0;
			const origRaf = w.requestAnimationFrame.bind( w );
			w.requestAnimationFrame = function ( cb ) {

				return origRaf( () => {

					if ( w.__tslpFrozen ) return; // squash: freeze already triggered
					const hasAnimationLoop = w.__tslpAnimationLoopRegistered === true;
					const targetProgress = hasAnimationLoop ? ( w.__tslpFrameCallbackCount | 0 ) : ( w.__tslpRafTick | 0 );
					if ( targetProgress < freezeAt ) {
						const tick = targetProgress + 1;
						if ( ! hasAnimationLoop ) w.__tslpRafTick = tick;
						cb( base + tick * step );
						return;
					}
					// Phase 2: clamped time, keep painting until counters settle
					// AND `settleFrames` extra ticks have fired without activity.
					cb( base + freezeAt * step );
					const lastBusy = w.__tslpLoaderLastBusyAt | 0;
					const renderableLastBusy = w.__tslpRenderableLastBusyAt | 0;
					const realNow = ( typeof w.__tslpRealNow === 'function' ) ? w.__tslpRealNow() : 0;
					const renderableReady = w.__tslpWaitForRenderableObjects !== true || ( w.__tslpRenderableObjectCount | 0 ) >= ( w.__tslpMinRenderableObjects | 0 );
					const animationLoopRegistered = w.__tslpAnimationLoopRegistered === true;
					const ownerReadiness = w.__tslpAnimationLoopOwnerReadiness;
					const animationLoopReady = minimumAnimationLoopOwners > 1
						&& ownerReadiness && typeof ownerReadiness.ready === 'function'
						? ownerReadiness.ready( minimumAnimationLoopOwners, settleFrames )
						: ! animationLoopRegistered || ( w.__tslpAnimationLoopCalls | 0 ) >= settleFrames;
					const presentation = w.__tslpPresentationReadiness;
					const presentationReady = requireSuccessfulPresentation !== true
						|| !! presentation && ( presentation.successful | 0 ) > ( presentation.requiredAfter | 0 );
					const settleTarget = animationLoopRegistered ? 1 : settleFrames;
					const quiescent = ( ( lastBusy === 0 ) || ( realNow && ( realNow - lastBusy ) >= quiescentMs ) )
						&& ( ( renderableLastBusy === 0 ) || ( realNow && ( realNow - renderableLastBusy ) >= quiescentMs ) );
					const allZero = ( w.__tslpLoaderPending | 0 ) === 0
						 && ( w.__tslpCompilePending | 0 ) === 0
						 && ( w.__tslpPmremPending | 0 ) === 0
						 && ( w.__tslpShadowPending | 0 ) === 0
						 && ( w.__tslpComputePending | 0 ) === 0
						 && renderableReady
						 && animationLoopReady
						 && presentationReady;
					if ( quiescent && allZero ) {
						w.__tslpSettleTicks = ( w.__tslpSettleTicks | 0 ) + 1;
						if ( w.__tslpSettleTicks >= settleTarget ) w.__tslpFrozen = true;
					} else {
						// New activity in this settle pass — restart the countdown
						// so freeze waits for another `settleFrames` quiet ticks.
						w.__tslpSettleTicks = 0;
					}

				} );

			};

			// Also patch Date.now() and performance.now() so examples that
			// drive animation from wall-clock time (instead of the rAF
			// timestamp) produce the same positions in capture and replay.
			// We use tick-based values starting at 0 so both passes are
			// always in sync.
			//
			// Strategy: replace window.performance with a Proxy so the
			// 'now' getter is intercepted regardless of how the native
			// Performance object defines it (accessor vs data, configurable
			// or not). window.performance itself is a configurable accessor
			// on window, so we can swap it via Object.defineProperty.
			const _syntheticNow = () => base + w.__tslpRafTick * step;
			w.Date.now = _syntheticNow;
			w.__tslpPerfNowLog = []; // diagnostic: log every performance.now() call
			const _syntheticNowLogged = () => {
				const val = base + w.__tslpRafTick * step;
				w.__tslpPerfNowLog.push( val );
				return val;
			};
			try {
				const _origPerf = w.performance;
				const _perfProxy = new Proxy( _origPerf, {
					get( target, prop, receiver ) {
						if ( prop === 'now' ) return _syntheticNowLogged;
						const val = Reflect.get( target, prop, target );
						return typeof val === 'function' ? val.bind( target ) : val;
					},
				} );
				Object.defineProperty( w, 'performance', {
					value: _perfProxy,
					writable: true,
					configurable: true,
					enumerable: true,
				} );
			} catch ( _ ) {
				// Fallback chain if Proxy or property replacement fails
				try {
					Object.defineProperty( w.Performance.prototype, 'now', {
						value: _syntheticNow,
						writable: true,
						configurable: true,
					} );
				} catch ( _2 ) {
					try {
						Object.defineProperty( w.performance, 'now', {
							value: _syntheticNow,
							writable: true,
							configurable: true,
						} );
					} catch ( _3 ) {
						w.performance.now = _syntheticNow;
					}
				}
			}

			// Deterministic Math.random per callsite. A single global RNG stream is
			// too fragile here because replay constructs extra helper objects, which
			// shifts later user-scene random calls. Keying by normalized stack line
			// keeps loops at the same user callsite aligned across stock/capture/replay.
			const _rngCounts = new Map();
			const _hashString = ( text ) => {
				let h = 2166136261 >>> 0;
				for ( let i = 0; i < text.length; i ++ ) {
					h ^= text.charCodeAt( i );
					h = Math.imul( h, 16777619 ) >>> 0;
				}
				return h >>> 0;
			};
			const _mixRng = ( seed ) => {
				let x = seed >>> 0;
				x ^= x >>> 16;
				x = Math.imul( x, 0x7feb352d ) >>> 0;
				x ^= x >>> 15;
				x = Math.imul( x, 0x846ca68b ) >>> 0;
				x ^= x >>> 16;
				return x >>> 0;
			};
			const _randomKeyFromStack = ( stack ) => {
				const lines = String( stack || '' ).split( '\n' ).slice( 1 );
				const exampleLines = [];
				const userLines = [];
				const fallbackLines = [];
				const normalizeLine = ( line ) => {
					const normalized = String( line || '' )
						.replace( /https?:\/\/[^/]+/g, '' )
						.replace( /\?[^:)\s]+/g, '' )
						.trim();
					// V8 prefixes stack locations with the current function name. The
					// same user callback is "Animation.render" in stock Three but can be
					// minified to "e.render" in replay, so key example calls by their
					// stable source location instead of that mode-dependent prefix.
					const location = normalized.match( /\(([^()]+:\d+:\d+)\)$/ );
					return location ? 'at ' + location[ 1 ] : normalized;
				};
				const isHarnessLine = ( line ) => line.includes( '__tslp__' ) || line.includes( '/__tslp_' );
				const isThreeInternalLine = ( line ) => (
					/\/build\/three\.[^/)\s]+\.js/.test( line ) ||
					/(^|[(\s])\/src\//.test( line )
				);
				for ( let line of lines ) {
					if ( line.includes( 'Math.random' ) ) continue;
					line = normalizeLine( line );
					if ( ! line ) continue;
					fallbackLines.push( line );
					if ( isHarnessLine( line ) || isThreeInternalLine( line ) ) continue;
					if ( line.includes( '/examples/' ) && ! line.includes( '/examples/jsm/' ) ) {
						exampleLines.push( line );
						if ( exampleLines.length >= 2 ) return exampleLines.join( ' <= ' );
						continue;
					}
					userLines.push( line );
					if ( userLines.length >= 2 ) break;
				}
				if ( exampleLines.length > 0 ) return exampleLines.join( ' <= ' );
					if ( userLines.length > 0 ) return userLines.join( ' <= ' );
					return fallbackLines.slice( 0, 2 ).join( ' <= ' ) || 'unknown';
				};
				const _objectIdCounts = new Map();
				w.__tslpStableObject3DId = function () {
					let stack = '';
					try { stack = String( new Error().stack || '' ); } catch ( _ ) {}
					const key = _randomKeyFromStack( stack );
					const count = ( _objectIdCounts.get( key ) || 0 ) + 1;
					_objectIdCounts.set( key, count );
					return _mixRng( _hashString( 'object3d#' + key + '#' + count + '#42' ) );
				};
				w.Math.random = function () {

					let stack = '';
					try { stack = String( new Error().stack || '' ); } catch ( _ ) {}
				const key = _randomKeyFromStack( stack );
				const count = ( _rngCounts.get( key ) || 0 ) + 1;
				_rngCounts.set( key, count );
				return _mixRng( _hashString( key + '#' + count + '#42' ) ) / 4294967296;

			};

		}, { step: FRAME_STEP_MS, base: 0, freezeAt: TARGET_TICK, quiescentMs: LOADER_QUIESCENT_MS, settleFrames: effectiveSettleFrames, minimumAnimationLoopOwners, waitForRenderableObjects, minRenderableObjects, holdAnimationUntilReady, requireSuccessfulPresentation: mode === 'replay', deterministicTimeoutPolicy, browserStabilizationPolicy } );
		mark( 'initScriptMs', stepStartedAt );
		trace( 'init-scripts-ready' );

	} catch ( _ ) { /* older Playwright fallback */ }

	try {

		stepStartedAt = Date.now();
			trace( 'navigation-start' );
			await page.goto( pageUrl, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS } );
		mark( 'gotoMs', stepStartedAt );
		trace( 'navigation-complete' );

		// Debug: verify timing patch is active. performance.now() should return
		// a tick-based synthetic value (< 10000) rather than real wall-clock
		// time (>> 10000). Log a warning if patch isn't working.
		try {
			const _perfNowCheck = await page.evaluate( () => window.performance.now() );
			if ( _perfNowCheck > 10000 ) console.warn( `[tslp-patch-warn] ${ name } ${ mode }: performance.now()=${ _perfNowCheck.toFixed(0) } — patch may not be active` );
		} catch ( _ ) {}

		if ( browserStabilizationPolicy?.installAudioAnalyserReadiness === true ) {

			const readinessInstalled = await page.evaluate( installAudioAnalyserReadiness );
			timings.audioAnalyserReadinessInstalled = readinessInstalled;
			if ( ! readinessInstalled ) errors.push( '[tslp-e2e] Audio analyser readiness hook could not be installed' );

		}
		await maybeClickStart( page );

		// Wait for the canvas to paint a non-empty frame under real
		// wall-clock time. This lets async loaders, `renderer.init()`,
		// aux capture (microtask chains), and the first rAF tick run
		// uninterrupted. Without this window, captures with async
		// setup (HDR / KTX2 / GLTF) would be incomplete.
		stepStartedAt = Date.now();
		const bright = await waitForFrame( page, mode === 'capture' ? RENDER_TIMEOUT_MS : Math.max( waitMs, RENDER_TIMEOUT_MS ), minimumBrightFraction );
		mark( 'initialFrameMs', stepStartedAt );
		trace( 'initial-frame-complete' );

		// Additional real-time settle so aux capture (Promise chains)
		// and post-init scene mutations have time to complete.
		stepStartedAt = Date.now();
		await new Promise( ( r ) => setTimeout( r, ASSET_SETTLE_MS ) );
		mark( 'assetSettleMs', stepStartedAt );
		trace( 'asset-settle-complete' );

		if ( deterministicTimeoutPolicy ) {
			stepStartedAt = Date.now();
			await page.waitForFunction(
				() => ( window.__tslpPrecompilePending | 0 ) === 0
					&& ( window.__tslpAuxCapturePending | 0 ) === 0
					&& ( window.__tslpCompilePending | 0 ) === 0,
				null,
				{ timeout: LOADER_TIMEOUT_MS, polling: 25 },
			);
			await page.waitForFunction(
				() => Array.isArray( window.__tslpDeterministicTimeoutQueue ) && window.__tslpDeterministicTimeoutQueue.some( ( record ) => record && record.cancelled !== true ),
				null,
				{ timeout: RENDER_TIMEOUT_MS, polling: 25 },
			);
			const drained = await page.evaluate( async ( steps ) => window.__tslpRunDeterministicTimeouts( steps ), deterministicTimeoutPolicy.steps );
			timings.deterministicTimeoutSteps = drained | 0;
			timings.deterministicTimeoutTrace = await page.evaluate( () => window.__tslpDeterministicTimeoutTrace.slice() );
			mark( 'deterministicTimeoutMs', stepStartedAt );
		}

		// Wait until the init-script rAF wrapper reaches TARGET_TICK and
		// self-freezes. The freeze happens
		// atomically inside the wrapper (no Playwright round-trip race),
		// so stock/capture/replay screenshot the same settled animation phase.
		try {

			stepStartedAt = Date.now();
			await page.waitForFunction(
				// Also wait for async PMREM generations, compute dispatches,
				// shadow-map renders, three.js loader items (HDR/GLTF/MaterialX/
				// Texture/...), and renderer.compileAsync() promises — so the
				// screenshot fires on a fully-loaded, fully-compiled frame.
				// LOADER_QUIESCENT_MS bridges sequential-load loops where the
				// loader counter briefly hits 0 between awaits.
				( quiescentMs ) => {
					if ( window.__tslpFrozen !== true ) return false;
					if ( ( window.__tslpPmremPending | 0 ) !== 0 ) return false;
					if ( ( window.__tslpComputePending | 0 ) !== 0 ) return false;
					if ( ( window.__tslpShadowPending | 0 ) !== 0 ) return false;
					if ( ( window.__tslpLoaderPending | 0 ) !== 0 ) return false;
					if ( ( window.__tslpCompilePending | 0 ) !== 0 ) return false;
					const now = ( typeof window.__tslpRealNow === 'function' ) ? window.__tslpRealNow() : Date.now();
					const lastBusy = window.__tslpLoaderLastBusyAt | 0;
					if ( lastBusy && ( now - lastBusy ) < quiescentMs ) return false;
					return true;
					},
					LOADER_QUIESCENT_MS,
					{ timeout: LOADER_TIMEOUT_MS, polling: 50 },
				);
			mark( 'freezeWaitMs', stepStartedAt );

			// Brief settle so the GPU presents the frozen frame.
			stepStartedAt = Date.now();
			await new Promise( ( r ) => setTimeout( r, PRESENT_SETTLE_MS ) );
			mark( 'presentSettleMs', stepStartedAt );
			timings.freezeCompleted = true;
			trace( 'freeze-complete' );

			} catch ( _ ) {
				mark( 'freezeWaitMs', stepStartedAt );
				timings.freezeTimedOut = true;
				timings.freezeCompleted = false;
				try {
					timings.freezeState = await page.evaluate( () => ( {
						frozen: window.__tslpFrozen === true,
						rafTick: window.__tslpRafTick | 0,
						settleTicks: window.__tslpSettleTicks | 0,
						loaderPending: window.__tslpLoaderPending | 0,
						compilePending: window.__tslpCompilePending | 0,
						pmremPending: window.__tslpPmremPending | 0,
						computePending: window.__tslpComputePending | 0,
						shadowPending: window.__tslpShadowPending | 0,
						lastBusyAgeMs: typeof window.__tslpRealNow === 'function' ? window.__tslpRealNow() - ( window.__tslpLoaderLastBusyAt | 0 ) : null,
						fullAutoLoaded: window.__tslpFullAutoLoaded === true,
						rendererBound: window.__tslpRendererBound === true,
						animationLoopRegistered: window.__tslpAnimationLoopRegistered === true,
						animationLoopCalls: window.__tslpAnimationLoopCalls | 0,
						frameCallbackCount: window.__tslpFrameCallbackCount | 0,
						presentationReadiness: window.__tslpPresentationReadiness
							? {
								deferred: window.__tslpPresentationReadiness.deferred | 0,
								requiredAfter: window.__tslpPresentationReadiness.requiredAfter | 0,
								successful: window.__tslpPresentationReadiness.successful | 0,
							}
							: null,
						renderableObjectCount: window.__tslpRenderableObjectCount | 0,
						minRenderableObjects: window.__tslpMinRenderableObjects | 0,
						wrapperIsActive: typeof window.__tslpWrapAnimationLoop === 'function',
					} ) );
				} catch ( _2 ) {}
			}

		stepStartedAt = Date.now();
		canvasBackends = uniqueRendererBackendValues( await page.$$eval(
			'canvas',
			( canvases ) => canvases.map( ( canvas ) => canvas.dataset && canvas.dataset.tslpBackend || '' ),
		).catch( () => [] ) );
		mark( 'canvasBackendEvidenceMs', stepStartedAt );
		trace( `canvas-backends-collected (${ canvasBackends.join( ',' ) || 'none' })` );

		stepStartedAt = Date.now();
		const shot = await dumpCanvas( page, name );
		mark( 'screenshotMs', stepStartedAt );
		trace( 'screenshot-complete' );
		// Re-measure bright from the final screenshot PNG — WebGPU canvas pixels
		// are often not readable via 2D-context drawImage during the animation loop
		// (the compositing pipeline lags), so the waitForFrame poll may see 0 even
		// when the canvas has content. The Playwright screenshot always captures the
		// composited frame, so computing brightness from it gives the true value.
		stepStartedAt = Date.now();
			const shotBright = shot ? await brightFraction( page, shot ) : 0;
			mark( 'shotBrightMs', stepStartedAt );
			const finalBright = Math.max( bright, shotBright );
			let frameTextureSnapshot = null;
			if ( process.env.TSLP_DEBUG_FRAME_TEXTURE_SNAPSHOT === '1' ) {
				stepStartedAt = Date.now();
				frameTextureSnapshot = await collectFrameTextureSnapshot( page );
				mark( 'frameTextureSnapshotMs', stepStartedAt );
			}
			if ( mode === 'capture' ) {
				stepStartedAt = Date.now();
				await page.evaluate( async () => {
					if ( typeof window.__tslpFlushCaptureArtifacts === 'function' ) await window.__tslpFlushCaptureArtifacts();
			} );
			mark( 'flushCaptureMs', stepStartedAt );
			trace( 'capture-flush-complete' );
		}
			// Drain submitted work before harvesting semantic diagnostics. WebGPU
			// validation errors and device loss are delivered asynchronously; the
			// shared drain also turns queue-completion rejection into gate evidence.
			stepStartedAt = Date.now();
			await drainAndSettleE2EGpuDiagnostics( page );
			await page.evaluate( ( phase ) => {
				const seal = phase === 'capture'
					? window.__tslpSealCaptureOperationRegistry
					: phase === 'replay'
						? window.__tslpSealReplayOperationRegistry
						: null;
				if ( typeof seal === 'function' ) seal();
			}, mode );
			mark( 'gpuDiagnosticsFenceMs', stepStartedAt );
			stepStartedAt = Date.now();
			await finalizeNetworkEvidence();
			mark( 'networkEvidenceMs', stepStartedAt );
		// Wedge 4: read the deterministic clock at the moment the screenshot
		// was taken. nodeFrame.time accumulates from `performance.now()`, which
		// the harness patched to `base + __tslpRafTick * step`. So at freeze,
		// nodeFrame.time should equal that synthetic value (in seconds).
		// We try renderer._nodes.nodeFrame.time first (authoritative), then
		// fall back to the synthetic rAF clock if no renderer global is exposed.
		let frameClock = null;
		try {
			frameClock = await page.evaluate( () => {
				const w = window;
				const candidates = [];
				if ( w.__tslpSlimRenderer ) candidates.push( w.__tslpSlimRenderer );
				if ( w.__tslpFullRenderer ) candidates.push( w.__tslpFullRenderer );
				if ( w.__tslpCurrentReplayRenderer ) candidates.push( w.__tslpCurrentReplayRenderer );
				if ( w.__tslpHarnessRenderer ) candidates.push( w.__tslpHarnessRenderer );
				for ( const r of candidates ) {
					const t = r && r._nodes && r._nodes.nodeFrame && r._nodes.nodeFrame.time;
					if ( typeof t === 'number' && Number.isFinite( t ) ) return t;
				}
				// Fallback: the synthetic rAF clock (seconds, base 0, step ms / 1000).
				if ( typeof w.__tslpRafTick === 'number' && typeof w.__tslpFrozen === 'boolean' ) {
					return ( w.__tslpRafTick | 0 ) * ( 16.6667 / 1000 );
				}
				return null;
			} );
		} catch ( _ ) {}
			const diagnostics = await page.evaluate( () => {
				return window.__tslpHarnessDiagnostics || null;
			} ).catch( () => null );
			if ( diagnostics && frameTextureSnapshot ) diagnostics.frameTextureSnapshot = frameTextureSnapshot;
			timings.totalMs = Date.now() - startedAt;
			const visitErrors = [ ...browserFailures.messages(), ...errors ];
			visitResult = { bright: finalBright, shot, errors: visitErrors, errorCount: visitErrors.length, warnings: warnings.slice( 0, 5 ), warningCount: warnings.length, canvasBackends, diagnostics, networkEvidence, context, page, timings, cleanup, frameClock };
			return visitResult;

	} catch ( err ) {

		try {
			await page.evaluate( drainE2EGpuDiagnostics );
		} catch ( _ ) {}
		await finalizeNetworkEvidence();
		const diagnostics = await page.evaluate( () => window.__tslpHarnessDiagnostics || null ).catch( () => null );
		timings.totalMs = Date.now() - startedAt;
		const visitErrors = [ ...browserFailures.messages(), ...errors, err && err.message || String( err ) ];
		visitResult = { bright: 0, shot: null, errors: visitErrors, errorCount: visitErrors.length, warnings: warnings.slice( 0, 5 ), warningCount: warnings.length, canvasBackends, diagnostics, networkEvidence, navigationError: true, context, page, timings, cleanup };
		return visitResult;

	}

}

function pixelGateEnabledForExample( name ) {

	if ( ! pixelGateEnabled ) return false;
	if ( pixelGateDisabledReasonForExample( name ) ) return false;
	if ( localExamplesRoot ) {
		const options = localExampleOptions.get( name );
		if ( options && options.pixelGate === false ) return false;
	}
	return true;

}

function caseEvidenceConfiguration( name ) {

	const configuredDisabledReason = pixelGateDisabledReasonForExample( name );
	const localDisabled = localExamplesRoot && localExampleOptions.get( name )?.pixelGate === false;
	const disabledReason = configuredDisabledReason || ( localDisabled ? 'local case configuration' : null );
	const overrideWaitMs = HAS_EXPLICIT_CAPTURE_WAIT ? 0 : captureWaitOverrideForExample( name );
	return {
		effectivePsnrThreshold: psnrThresholdForExample( name, psnrThreshold ),
		pixelGateEnabled: pixelGateEnabled && ! disabledReason,
		pixelGateDisabledReason: disabledReason,
		minimumBrightFraction: minimumBrightFractionForExample( name, DEFAULT_MINIMUM_BRIGHT_FRACTION ),
		captureWaitMs: Math.max( captureWaitMs, overrideWaitMs ),
		replayWaitMs,
		targetTick: targetTickForExample( name, targetTick, HAS_EXPLICIT_TARGET_TICK ),
		settleFrames: settleFramesForExample( name, SETTLE_FRAMES, HAS_EXPLICIT_SETTLE_FRAMES ),
		ignoreRegions: psnrIgnoreRegionsForExample( name ),
		expectedCaptureErrors: expectedCaptureErrorSourcesForExample( name ),
		expectedReplayErrors: expectedReplayErrorSourcesForExample( name ),
		browserStabilizationPolicy: browserStabilizationPolicyForExample( name ),
		workloadPolicy: workloadPolicyForExample( name ),
	};

}

function mergeDiagnostics( ...items ) {

	const present = items.filter( Boolean );
	if ( present.length === 0 ) return null;
	const merged = { colorTransferFallbacks: {}, healedNullTextureImages: 0 };
	const frameTextureSnapshot = [];
	const renderSelectorMismatches = [];
	const operationOutcomes = [];
	const gpuErrors = [];
	for ( const item of present ) {

		merged.healedNullTextureImages += item.healedNullTextureImages | 0;
		for ( const [ key, count ] of Object.entries( item.colorTransferFallbacks || {} ) ) {

			merged.colorTransferFallbacks[ key ] = ( merged.colorTransferFallbacks[ key ] || 0 ) + ( count | 0 );

		}
		if ( Array.isArray( item.frameTextureSnapshot ) ) frameTextureSnapshot.push( ...item.frameTextureSnapshot );
		if ( Array.isArray( item.renderSelectorMismatches ) ) renderSelectorMismatches.push( ...item.renderSelectorMismatches );
		if ( Array.isArray( item.operationOutcomes ) ) operationOutcomes.push( ...item.operationOutcomes );
		if ( Array.isArray( item.gpuErrors ) ) gpuErrors.push( ...item.gpuErrors );

	}
	if ( frameTextureSnapshot.length > 0 ) merged.frameTextureSnapshot = frameTextureSnapshot;
	if ( renderSelectorMismatches.length > 0 ) merged.renderSelectorMismatches = renderSelectorMismatches;
	if ( operationOutcomes.length > 0 ) merged.operationOutcomes = operationOutcomes;
	if ( gpuErrors.length > 0 ) merged.gpuErrors = gpuErrors;
	return merged;

}

function combineOperationRegistries( ...registries ) {

	if ( registries.some( ( registry ) => ! registry || typeof registry !== 'object' ) ) return null;
	return {
		schema: registries.every( ( registry ) => registry.schema === 'tslp-e2e-operation-registry@1' )
			? 'tslp-e2e-operation-registry@1'
			: 'invalid',
		complete: registries.every( ( registry ) => registry.complete === true ),
		expected: registries.flatMap( ( registry ) => Array.isArray( registry.expected ) ? registry.expected : [] ),
	};

}

async function runOne( browser, name ) {

	captures.delete( name );
	const overrideWaitMs = HAS_EXPLICIT_CAPTURE_WAIT ? 0 : captureWaitOverrideForExample( name );
	const effectiveCaptureWait = overrideWaitMs > captureWaitMs ? overrideWaitMs : captureWaitMs;
	const capture = reuseReferenceShot
		? loadSavedReferenceShot( name )
		: await visitExample( browser, name, 'stock', effectiveCaptureWait );
	// Wedge 4: remember the stock pass's nodeFrame.time so the replay pass can
	// pin its clock to the SAME value the comparison-reference screenshot saw.
	// injectHtml in replay mode reads this from the bucket below.
	if ( capture && typeof capture.frameClock === 'number' && Number.isFinite( capture.frameClock ) ) {
		const bucket = captureBucket( name );
		bucket.frameClock = capture.frameClock;
		if ( process.env.TSLP_DEBUG_CLOCK === '1' ) console.log( '[tslp-clock] ' + name + ' stock frameClock=' + capture.frameClock );
	}
	// Tear down listeners + page + context as soon as the visit returns.
	// Holding only the screenshot Buffer past this point lets Chromium
	// release the page's GPU surface before we open the next one.
	if ( capture.cleanup ) await capture.cleanup();
	capture.cleanup = null;
	capture.context = null;
	capture.page = null;

	// Stock is the visual reference, never the artifact authority. Raw local
	// fixtures intentionally exercise their development helpers in stock mode,
	// so discard any incidental POSTs before the dedicated capture visit while
	// retaining only the measured reference clock needed by replay.
	resetCaptureBucketForArtifactPass( name, capture.frameClock );
	const stockNetworkFixture = capture.networkEvidence;
	const networkFixtureRoot = capture.networkFixtureRoot || OUT;
	const networkFixtureRunId = capture.networkFixtureRunId || RUN_ID;

	const artifactCapture = replayOnly
		? emptyVisitResult()
		: await visitExample( browser, name, 'capture', effectiveCaptureWait, {
			networkFixture: stockNetworkFixture,
			networkFixtureRoot,
			networkFixtureRunId,
		} );
	if ( artifactCapture.cleanup ) await artifactCapture.cleanup();
	artifactCapture.cleanup = null;
	artifactCapture.context = null;
	artifactCapture.page = null;
	// The capture pass exists to harvest TSL artifacts into `bucket`; its
	// screenshot is never read downstream (PSNR runs against the stock shot).
	artifactCapture.shot = null;
	if ( replayOnly ) loadSavedArtifacts( name );
	const bucket = captureBucket( name );
	coalesceUserArtifactVariantFamilies( bucket.user );
	const userCount = Object.keys( bucket.user ).length;
	const auxCount = bucket.aux.length;
	const artifactCoverageOk = hasReplayArtifactCoverage( bucket.user, bucket.aux );
	const artifactSummaries = summarizeArtifacts( bucket );
	const auxSummaries = summarizeAuxArtifacts( bucket );
	const artifactMetricsBase = computeE2EArtifactMetrics( bucket );

	if ( replayOperationDiagnostics ) {

		const debugDir = join( OUT, 'debug-pre-replay' );
		ensureOutputDirectory( OUT, debugDir, { label: 'Pre-replay debug directory' } );
		const safeName = safeExampleName( name );
		const userDump = writeArtifactDebugDump( join( debugDir, `${ safeName }.user.json` ), bucket.user, artifactSummaries );
		const auxDump = writeArtifactDebugDump( join( debugDir, `${ safeName }.aux.json` ), bucket.aux, auxSummaries );
		writeOutputFileAtomic(
			OUT,
			join( debugDir, `${ safeName }.json` ),
			JSON.stringify( {
				runId: RUN_ID,
				name,
				userArtifacts: userCount,
				auxArtifacts: auxCount,
				artifactCoverageOk,
				userDump: {
					file: userDump.file,
					bytes: userDump.bytes.length,
					contentEncoding: userDump.contentEncoding || null,
					uncompressedBytes: userDump.uncompressedBytes ?? null,
					truncated: userDump.truncated,
				},
				auxDump: {
					file: auxDump.file,
					bytes: auxDump.bytes.length,
					contentEncoding: auxDump.contentEncoding || null,
					uncompressedBytes: auxDump.uncompressedBytes ?? null,
					truncated: auxDump.truncated,
				},
				artifactSummaries,
				auxSummaries,
			}, null, 2 ),
			{ label: 'Pre-replay diagnostic summary' },
		);
		console.log( `[batch-e2e] pre-replay diagnostic artifacts: ${ debugDir }` );

	}

	const replay = await visitExample( browser, name, 'replay', replayWaitMs, {
		networkFixture: stockNetworkFixture,
		networkFixtureRoot,
		networkFixtureRunId,
	} );
	const passTimings = {
		stock: capture.timings || null,
		capture: artifactCapture.timings || null,
		replay: replay.timings || null,
	};
	if ( capture.shot && replay.page ) {

		const referenceBrightStartedAt = Date.now();
		capture.bright = await brightFraction( replay.page, capture.shot );
		if ( passTimings.replay ) passTimings.replay.referenceBrightMs = Date.now() - referenceBrightStartedAt;

	}
	const captureErrors = [ ...capture.errors, ...artifactCapture.errors ];
	const captureWarnings = [ ...( capture.warnings || [] ), ...( artifactCapture.warnings || [] ) ];
	const expectedCapturePatterns = expectedCaptureErrorPatternsForExample( name );
	const blockingStockErrors = capture.errors.filter( ( error ) => ! expectedCapturePatterns.some( ( re ) => re.test( error ) ) );
	const blockingArtifactCaptureErrors = artifactCapture.errors.filter( ( error ) => ! expectedCapturePatterns.some( ( re ) => re.test( error ) ) );
	const blockingCaptureErrors = [ ...blockingStockErrors, ...blockingArtifactCaptureErrors ];
	const expectedReplayPatterns = expectedReplayErrorPatternsForExample( name );
	const blockingReplayErrors = replay.errors.filter( ( error ) => ! expectedReplayPatterns.some( ( re ) => re.test( error ) ) );
	const minimumBrightFraction = minimumBrightFractionForExample( name, DEFAULT_MINIMUM_BRIGHT_FRACTION );

	let pixelMetrics;
	if ( capture.shot && replay.shot && capture.bright > minimumBrightFraction && replay.bright > minimumBrightFraction && replay.page ) {

		pixelMetrics = await comparePSNR( replay.page, capture.shot, replay.shot, name ).catch( ( err ) => ( { error: err && err.message || String( err ) } ) );

	} else {

		pixelMetrics = { skipped: true, reason: capture.bright <= minimumBrightFraction ? 'capture frame empty' : replay.bright <= minimumBrightFraction ? 'replay frame empty' : 'screenshot missing' };

	}
	let shotEvidence = { capture: null, replay: null };
	let userArtifactEvidence = null;
	let auxArtifactEvidence = null;
	if ( saveShots ) {

		const safe = safeExampleName( name );
		shotEvidence = writeCurrentShotPair( {
			outputRoot: OUT,
			runId: RUN_ID,
			shotsDir: RUN_SHOTS_DIR,
			stem: safe,
			captureShot: capture.shot,
			replayShot: replay.shot,
		} );
		// Also dump full captured user-material artifacts for debugging.
		ensureOutputDirectory( OUT, RUN_ARTIFACTS_DIR, {
			label: 'E2E artifact evidence directory',
		} );
		const userDump = writeArtifactDebugDump( join( RUN_ARTIFACTS_DIR, `${ safe }.user.json` ), bucket.user, artifactSummaries );
		const auxDump = writeArtifactDebugDump( join( RUN_ARTIFACTS_DIR, `${ safe }.aux.json` ), bucket.aux, auxSummaries );
		userArtifactEvidence = describeArtifactEvidenceDump( {
			outputRoot: OUT,
			dump: userDump,
			runId: RUN_ID,
		} );
		auxArtifactEvidence = describeArtifactEvidenceDump( {
			outputRoot: OUT,
			dump: auxDump,
			runId: RUN_ID,
		} );

	}
	const artifactMetrics = bindE2EArtifactMetrics( artifactMetricsBase, {
		runId: RUN_ID,
		userArtifacts: userArtifactEvidence,
		auxArtifacts: auxArtifactEvidence,
	} );
	if ( replay.cleanup ) await replay.cleanup();
	replay.cleanup = null;
	replay.context = null;
	replay.page = null;
	const networkInputs = {
		stock: stockNetworkFixture,
		capture: replayOnly ? savedEvidenceCase( name ).entry.networkInputs?.capture || null : artifactCapture.networkEvidence,
		replay: replay.networkEvidence,
	};
	const networkIssues = e2eNetworkCrossPhaseIssues( networkInputs );

	const effectivePsnrThreshold = psnrThresholdForExample( name, psnrThreshold );
	const pixelGate = pixelGateOf( pixelMetrics, effectivePsnrThreshold );
	const examplePixelGateEnabled = pixelGateEnabledForExample( name );
	if ( ! examplePixelGateEnabled && pixelGate && pixelGate.pass === false ) pixelGate.disabled = true;
	const pixelGateOk = pixelGatePassed( pixelGate, examplePixelGateEnabled );
	const captureDiagnostics = enrichRenderSelectorDiagnostics( mergeDiagnostics( capture.diagnostics, artifactCapture.diagnostics ), captureErrors );
	const replayDiagnostics = enrichRenderSelectorDiagnostics( replay.diagnostics || null, replay.errors );
	const evidenceGate = createE2EEvidenceGate( {
		timings: passTimings,
		errors: {
			stock: {
				messages: blockingStockErrors,
				total: blockingStockErrors.length,
			},
			capture: {
				messages: blockingArtifactCaptureErrors,
				total: blockingArtifactCaptureErrors.length,
			},
			replay: {
				messages: blockingReplayErrors,
				total: blockingReplayErrors.length,
			},
		},
		warnings: {
			stock: {
				messages: capture.warnings || [],
				total: capture.warningCount ?? ( capture.warnings || [] ).length,
			},
			capture: {
				messages: artifactCapture.warnings || [],
				total: artifactCapture.warningCount ?? ( artifactCapture.warnings || [] ).length,
			},
			replay: {
				messages: replay.warnings || [],
				total: replay.warningCount ?? ( replay.warnings || [] ).length,
			},
		},
		diagnostics: {
			stock: capture.diagnostics,
			capture: artifactCapture.diagnostics,
			replay: replay.diagnostics,
		},
		operationRegistry: combineOperationRegistries(
			artifactCapture.diagnostics?.operationRegistry,
			replay.diagnostics?.operationRegistry,
		),
		blocking: networkIssues.map( ( message ) => ( {
			code: 'network-provenance',
			phase: null,
			message,
		} ) ),
	} );
	const backendArtifactGate = auditArtifactShaderLanguageBackends( bucket, {
		requiredBackends: canvasOrderForExample( name ) === 'webgpu-backend-first' ? [ 'webgpu', 'webgl' ] : [],
	} );
	const rendererBackendEvidence = createRendererBackendEvidence( {
		capture: artifactCapture.canvasBackends,
		replay: replay.canvasBackends,
		requireDualBackend: canvasOrderForExample( name ) === 'webgpu-backend-first',
	} );
	const pass = artifactCoverageOk &&
		blockingCaptureErrors.length === 0 &&
		replay.bright > minimumBrightFraction &&
		blockingReplayErrors.length === 0 &&
		evidenceGate.pass &&
		backendArtifactGate.pass &&
		rendererBackendEvidence.pass &&
		pixelGateOk;

	// Release everything that won't make it into the report: TSL artifact
	// buckets (many MB on heavy scenes) and the capture/replay screenshot
	// Buffers (~1.5 MB each at 640×480). Without this the worker accumulates
	// these per-example across its whole slice and the OS sees steady RSS
	// growth — on Apple Silicon's unified memory that compounds with the
	// Chromium GPU process and eventually freezes the whole machine.
	captures.delete( name );
	capture.shot = null;
	artifactCapture.shot = null;
	replay.shot = null;

	return {
		name,
		status: pass ? 'pass' : 'fail',
		caseConfiguration: caseEvidenceConfiguration( name ),
		evidence: {
			runId: RUN_ID,
			capture: shotEvidence.capture,
			replay: shotEvidence.replay,
			userArtifacts: userArtifactEvidence,
			auxArtifacts: auxArtifactEvidence,
		},
		artifactMetrics,
		networkInputs,
		evidenceGate,
		backendArtifactGate,
		rendererBackendEvidence,
		captureBrightFrac: capture.bright,
		replayBrightFrac: replay.bright,
		minimumBrightFraction,
		pixelGate,
		userArtifacts: userCount,
		auxArtifacts: auxCount,
		stockErrors: capture.errors.slice( 0, 5 ),
		stockErrorCount: capture.errorCount ?? capture.errors.length,
		artifactCaptureErrors: artifactCapture.errors.slice( 0, 5 ),
		artifactCaptureErrorCount: artifactCapture.errorCount ?? artifactCapture.errors.length,
		captureErrors: captureErrors.slice( 0, 10 ),
		captureErrorCount: ( capture.errorCount ?? capture.errors.length ) + ( artifactCapture.errorCount ?? artifactCapture.errors.length ),
		replayErrors: replay.errors.slice( 0, 5 ),
		replayErrorCount: replay.errorCount ?? replay.errors.length,
		stockWarnings: capture.warnings || [],
		artifactCaptureWarnings: artifactCapture.warnings || [],
		captureWarnings,
		replayWarnings: replay.warnings || [],
		captureDiagnostics,
		replayDiagnostics,
		timings: passTimings,
		artifactSummaries,
		auxSummaries,
		error: pass ? null : summarizeFailure( { artifactCoverageOk, userCount, auxCount, blockingCaptureErrors, replayBright: replay.bright, minimumBrightFraction, blockingReplayErrors, evidenceGate, backendArtifactGate, rendererBackendEvidence, pixelGate, pixelGateEnabled: examplePixelGateEnabled } ),
	};

}

function summarizeArtifacts( bucket ) {

	return Object.entries( bucket.user ).map( ( [ name, entry ] ) => {

		const artifact = entry.artifact || {};
		return {
			name,
			hash: entry.__hash || null,
			cacheKey: artifact.cacheKey,
			variantKey: artifact.variantKey || null,
			shaderLanguage: artifactShaderLanguage( artifact ),
			variantShaderLanguages: Object.fromEntries( Object.entries( artifact.variants || {} )
				.map( ( [ key, variant ] ) => [ key, artifactShaderLanguage( variant ) ] ) ),
			shape: artifact.materialShape,
			renderSelectors: summarizeArtifactRenderSelectors( artifact ),
			vertexSnippet: String( artifact.vertexShader || '' ).slice( 0, 1200 ),
			fragmentSnippet: String( artifact.fragmentShader || '' ).slice( 0, 1200 ),
			attributes: ( artifact.attributes || [] ).map( ( attribute ) => ( {
				name: attribute.name,
				type: attribute.type,
				source: attribute.source,
				count: attribute.count,
				itemSize: attribute.itemSize,
				arrayType: attribute.arrayType,
			} ) ),
			textures: ( artifact.uniformPlan || [] ).flatMap( ( group ) => ( group.textures || [] ).map( ( texture ) => ( {
				group: group.name,
				name: texture.name,
				kind: texture.source && texture.source.kind,
				property: texture.source && texture.source.property,
				textureUuid: texture.source && texture.source.textureUuid,
				imageSrc: texture.source && texture.source.imageSrc,
				textureName: texture.source && texture.source.textureName,
				hasSnapshot: !! ( texture.source && texture.source.snapshot ),
				snapshotSize: texture.source && texture.source.snapshot ? [ texture.source.snapshot.width, texture.source.snapshot.height ] : null,
			} ) ) ),
		};

	} );

}

function summarizeAuxArtifacts( bucket ) {

	return ( bucket.aux || [] ).map( ( entry ) => {

		const artifact = entry.artifact || {};
		return {
			shape: entry.shape,
			configHash: entry.configHash,
			artifactShape: artifact.materialShape,
			cacheKey: artifact.cacheKey,
			variantKey: artifact.variantKey || null,
			shaderLanguage: artifactShaderLanguage( artifact ),
			variantShaderLanguages: Object.fromEntries( Object.entries( artifact.variants || {} )
				.map( ( [ key, variant ] ) => [ key, artifactShaderLanguage( variant ) ] ) ),
			renderSelectors: summarizeArtifactRenderSelectors( artifact ),
			attributes: ( artifact.attributes || [] ).map( ( attribute ) => ( {
				name: attribute.name,
				type: attribute.type,
				source: attribute.source,
				count: attribute.count,
				itemSize: attribute.itemSize,
				arrayType: attribute.arrayType,
			} ) ),
			bindings: ( artifact.bindings || [] ).map( ( group ) => ( {
				name: group.name,
				bindings: ( group.bindings || [] ).map( ( binding ) => ( { name: binding.name, kind: binding.kind, byteLength: binding.byteLength } ) ),
			} ) ),
			uniformPlan: ( artifact.uniformPlan || [] ).map( ( group ) => ( {
				name: group.name,
				byteLength: group.byteLength,
				slotCount: ( group.slots || [] ).length,
				textures: ( group.textures || [] ).map( ( texture ) => ( {
					name: texture.name,
					kind: texture.source && texture.source.kind,
					property: texture.source && texture.source.property,
					textureUuid: texture.source && texture.source.textureUuid,
					hasSnapshot: !! ( texture.source && texture.source.snapshot ),
					snapshotSize: texture.source && texture.source.snapshot ? [ texture.source.snapshot.width, texture.source.snapshot.height ] : null,
				} ) ),
			} ) ),
		};

	} );

}

function artifactShaderLanguage( artifact ) {

	if ( artifact && ( artifact.shaderLanguage === 'wgsl' || artifact.shaderLanguage === 'glsl' ) ) return artifact.shaderLanguage;
	const source = `${ artifact && artifact.vertexShader || '' }\n${ artifact && artifact.fragmentShader || '' }\n${ artifact && artifact.computeShader || '' }`;
	if ( /^[ \t]*#[ \t]*version\b/m.test( source ) ) return 'glsl';
	if ( /(?:^|[^\w])@(vertex|fragment|compute)\b/m.test( source ) ) return 'wgsl';
	return null;

}

function summarizeFailure( { artifactCoverageOk, userCount, auxCount, blockingCaptureErrors, replayBright, minimumBrightFraction = DEFAULT_MINIMUM_BRIGHT_FRACTION, blockingReplayErrors, evidenceGate, backendArtifactGate, rendererBackendEvidence, pixelGate, pixelGateEnabled } ) {

	if ( ! artifactCoverageOk ) return userCount === 0 && auxCount > 0
		? 'capture produced auxiliary artifacts without complete background + render-output replay coverage'
		: 'capture produced no replayable material artifacts';
	if ( blockingCaptureErrors.length > 0 ) return blockingCaptureErrors[ 0 ].slice( 0, 500 );
	if ( replayBright <= minimumBrightFraction ) return 'slim replay did not produce a non-empty frame';
	if ( blockingReplayErrors.length > 0 ) return blockingReplayErrors[ 0 ].slice( 0, 500 );
	if ( evidenceGate && evidenceGate.pass === false ) {
		return String( evidenceGate.blocking?.[ 0 ]?.message || 'semantic evidence gate failed' ).slice( 0, 500 );
	}
	if ( rendererBackendEvidence && rendererBackendEvidence.pass === false ) {
		for ( const mode of [ 'capture', 'replay' ] ) {
			const missing = rendererBackendEvidence.missing?.[ mode ] || [];
			const unexpected = rendererBackendEvidence.unexpected?.[ mode ] || [];
			if ( missing.length === 0 && unexpected.length === 0 ) continue;
			const details = [];
			if ( missing.length > 0 ) details.push( `missing ${ missing.join( ', ' ) }` );
			if ( unexpected.length > 0 ) details.push( `unexpected ${ unexpected.join( ', ' ) }` );
			return `${ mode } canvas backend evidence mismatch (${ details.join( '; ' ) })`;
		}
		return 'canvas backend evidence failed';
	}
	if ( backendArtifactGate && backendArtifactGate.pass === false ) {
		if ( backendArtifactGate.mismatches.length > 0 ) {
			const mismatch = backendArtifactGate.mismatches[ 0 ];
			return `captured ${ mismatch.actualLanguage || 'unknown' } shader for ${ mismatch.backend } backend (expected ${ mismatch.expectedLanguage })`;
		}
		return `capture produced no replayable artifacts for backend(s): ${ backendArtifactGate.missingBackends.join( ', ' ) }`;
	}
	if ( pixelGateEnabled && pixelGate && pixelGate.pass === false ) return `pixel diff PSNR ${ pixelGate.psnr } dB < threshold ${ pixelGate.threshold } dB (visual regression)`;
	return 'unknown replay failure';

}

function formatPercent( value ) {

	if ( typeof value !== 'number' || ! Number.isFinite( value ) ) return 'n/a';
	return ( value * 100 ).toFixed( 1 ) + '%';

}

function compactText( value, max = 180 ) {

	const text = String( value || '' ).replace( /\s+/g, ' ' ).trim();
	return text.length > max ? text.slice( 0, max - 1 ) + '…' : text;

}

function formatPixelGate( gate ) {

	if ( ! gate ) return 'psnr n/a';
	if ( gate.skipped ) return `psnr skipped (${ compactText( gate.reason, 48 ) })`;
	if ( gate.pass === undefined ) return 'psnr n/a';
	if ( gate.disabled ) return `psnr ${ gate.psnr }/${ gate.threshold } dB diagnostic`;
	const verdict = gate.pass ? 'ok' : 'FAIL';
	return `psnr ${ gate.psnr }/${ gate.threshold } dB ${ verdict }`;

}

function formatRendererBackendEvidence( evidence ) {

	if ( ! evidence || evidence.enabled !== true ) return '';
	const capture = evidence.visits?.capture?.join( '+' ) || 'none';
	const replay = evidence.visits?.replay?.join( '+' ) || 'none';
	return `backends capture=${ capture } replay=${ replay } ${ evidence.pass ? 'ok' : 'FAIL' }`;

}

function diagnosticNote( diagnostics ) {

	if ( ! diagnostics ) return '';
	const parts = [];
	if ( diagnostics.healedNullTextureImages > 0 ) parts.push( `healed-null-images=${ diagnostics.healedNullTextureImages }` );
	const fallbacks = diagnostics.colorTransferFallbacks || {};
	const fallbackTotal = Object.values( fallbacks ).reduce( ( sum, count ) => sum + ( count | 0 ), 0 );
	if ( fallbackTotal > 0 ) parts.push( `color-fallbacks=${ fallbackTotal }` );
	return parts.length ? parts.join( ', ' ) : '';

}

function formatResultLine( label, result ) {

	const status = result.status === 'pass' ? 'PASS' : 'FAIL';
	const parts = [
		`${ label } ${ status }`,
		`artifacts ${ result.userArtifacts }+${ result.auxArtifacts }`,
		`capture ${ formatPercent( result.captureBrightFrac ) }`,
		`replay ${ formatPercent( result.replayBrightFrac ) }`,
		formatPixelGate( result.pixelGate ),
	];
	const rendererBackendSummary = formatRendererBackendEvidence( result.rendererBackendEvidence );
	if ( rendererBackendSummary ) parts.push( rendererBackendSummary );
	const diag = diagnosticNote( result.replayDiagnostics );
	if ( diag ) parts.push( diag );
	if ( result.error ) parts.push( `error: ${ compactText( result.error ) }` );
	return parts.join( ' | ' );

}

function formatTimingLine( result ) {

	if ( ! result || ! result.timings ) return '';
	const parts = [];
	for ( const mode of [ 'stock', 'capture', 'replay' ] ) {

		const t = result.timings[ mode ];
		if ( ! t ) continue;
		const ms = ( key ) => `${ key }=${ t[ key ] || 0 }ms`;
		const detail = [
			ms( 'totalMs' ),
			ms( 'contextMs' ),
			ms( 'gotoMs' ),
			ms( 'initialFrameMs' ),
			ms( 'assetSettleMs' ),
			ms( 'freezeWaitMs' ),
			ms( 'presentSettleMs' ),
			ms( 'screenshotMs' ),
		];
		if ( t.referenceBrightMs ) detail.push( `referenceBrightMs=${ t.referenceBrightMs }ms` );
		if ( t.freezeTimedOut ) detail.push( 'freezeTimeout' );
		parts.push( `${ mode }(${ detail.join( ' ' ) })` );

	}
	return parts.length ? `  timings: ${ parts.join( ' | ' ) }` : '';

}

function printFailureSummary( details, max = 20 ) {

	const failures = details.filter( ( result ) => result && result.status === 'fail' );
	if ( failures.length === 0 ) return;
	console.log( '\nFailures:' );
	for ( const result of failures.slice( 0, max ) ) {
		const replayErrors = Array.isArray( result.replayErrors ) ? result.replayErrors.length : 0;
		const captureErrors = Array.isArray( result.captureErrors ) ? result.captureErrors.length : 0;
		const diag = diagnosticNote( result.replayDiagnostics );
		console.log( `  - ${ result.name }: ${ formatPixelGate( result.pixelGate ) }; replay ${ formatPercent( result.replayBrightFrac ) }; artifacts ${ result.userArtifacts }+${ result.auxArtifacts }; captureErrors=${ captureErrors }; replayErrors=${ replayErrors }${ diag ? '; ' + diag : '' }` );
		if ( result.error ) console.log( `    ${ compactText( result.error, 240 ) }` );
	}
	if ( failures.length > max ) console.log( `  ... ${ failures.length - max } more failures in the JSON report` );

}

async function launchBrowser() {

	return await launchEvidenceBrowser( chromium, {
		headless: true,
		args: BROWSER_ARGS,
	} );

}

async function recycleBrowser( current, expectedEnvironment ) {

	try { await current?.close(); } catch ( _ ) {}
	// Give the OS a beat to reclaim Chromium's GPU process before we spawn a
	// fresh one — without this delay the new browser's GPU process overlaps
	// with the dying one and unified-memory pressure spikes on Apple Silicon.
	if ( BROWSER_RESPAWN_DELAY_MS > 0 ) await new Promise( ( r ) => setTimeout( r, BROWSER_RESPAWN_DELAY_MS ) );
	// Best-effort manual GC between browser lifetimes — only fires if the
	// worker was launched with --expose-gc (the parallel runner does so).
	if ( typeof globalThis.gc === 'function' ) {
		try { globalThis.gc(); } catch ( _ ) {}
	}
	const launched = await launchBrowser();
	try {

		const environment = await collectEvidenceEnvironment( {
			browser: launched.browser,
			channel: launched.channel,
			probeUrl: `http://127.0.0.1:${ port }/__tslp__/environment-probe.html`,
		} );
		assertEvidenceEnvironmentMatches( expectedEnvironment, environment );
		return launched.browser;

	} catch ( error ) {

		await launched.browser.close().catch( () => {} );
		throw error;

	}

}

let initialBrowser = null;
let browser = null;
let evidenceEnvironment;
try {

	initialBrowser = await launchBrowser();
	browser = initialBrowser.browser;
	evidenceEnvironment = await collectEvidenceEnvironment( {
		browser,
		channel: initialBrowser.channel,
		probeUrl: `http://127.0.0.1:${ port }/__tslp__/environment-probe.html`,
	} );

} catch ( error ) {

	await initialBrowser?.browser?.close().catch( () => {} );
	await new Promise( ( resolveClose ) => server.close( resolveClose ) );
	throw error;

}

const casePolicies = Object.fromEntries( candidates.map( ( name ) => [ name, caseEvidenceConfiguration( name ) ] ) );
const configuration = {
	tier: tier || null,
	filter: filter || null,
	offset,
	limit,
	replayOnly,
	reuseReferenceShot,
	pixelGateEnabled,
	psnrThreshold,
	saveShots,
	captureWaitMs,
	replayWaitMs,
	targetTick,
	settleFrames: SETTLE_FRAMES,
	presentSettleMs: PRESENT_SETTLE_MS,
	assetSettleMs: ASSET_SETTLE_MS,
	brightPollMs: BRIGHT_POLL_MS,
	officialThreeSourcesRequired,
	environment: evidenceEnvironment,
	casePolicies,
};
configuration.fingerprint = fingerprintJson( configuration );

const corpusEvidence = {
	kind: localExamplesRoot ? 'local' : 'three',
	project: localExamplesRoot ? basename( localExamplesRoot ) : null,
	...( localDiscoveryEvidence ? { localDiscovery: localDiscoveryEvidence } : {} ),
	exact: evidenceRun.exactCorpus,
	caseNames: [ ...candidates ],
	caseNamesSha256: caseIdsFingerprint( candidates ),
	discoveredCaseNames: [ ...discoveredExamples ],
	discoveredCaseNamesSha256: caseIdsFingerprint( discoveredExamples ),
	skippedCaseNames: localExamplesRoot ? [] : discoveredExamples.filter( shouldSkip ),
	catalogueUpstreamCaseNamesSha256: EVIDENCE_CATALOGUE.upstreamCaseNamesSha256,
};
const catalogueEvidence = {
	schemaVersion: EVIDENCE_CATALOGUE.schemaVersion,
	threeVersion: EVIDENCE_CATALOGUE.threeVersion,
	sha256: EVIDENCE_CATALOGUE.sha256,
	caseCount: EVIDENCE_CATALOGUE.caseCount,
	caseIdsSha256: EVIDENCE_CATALOGUE.caseIdsSha256,
	upstreamCaseCount: EVIDENCE_CATALOGUE.upstreamCaseNames.length,
	upstreamCaseNamesSha256: EVIDENCE_CATALOGUE.upstreamCaseNamesSha256,
};
const report = {
	schemaVersion: E2E_EVIDENCE_SCHEMA_VERSION,
	runId: RUN_ID,
	campaignId: CAMPAIGN_ID,
	status: 'running',
	canonical: evidenceRun.canonical,
	startedAt: new Date().toISOString(),
	total: candidates.length,
	pass: 0,
	fail: 0,
	skip: allExamples.length - candidates.length,
	configuration,
	evidence: {
		manifestFile: E2E_EVIDENCE_MANIFEST,
		runRoot: relative( OUT, RUN_ROOT ).replaceAll( '\\', '/' ),
		catalogue: catalogueEvidence,
		corpus: corpusEvidence,
		threeCheckout: {
			root: threeRepo,
			revision: threeCheckout.revision,
			packageVersion: threeCheckout.packageVersion,
			git: threeGitIdentity,
			sourceVerification: officialThreeSourceVerifier?.snapshot() || null,
		},
		slimBundle: SLIM_BUNDLE_PROVENANCE,
		configurationFingerprint: configuration.fingerprint,
		sources: null,
	},
	evidenceInputRoot: INPUT_ROOT,
	outputRoot: OUT,
	slimBundle: SLIM_BUNDLE_PROVENANCE,
	details: [],
};
let runsSinceRestart = 0;

function refreshReportSourceEvidence() {

	const all = sourceRecorder.snapshot();
	const repository = sourceRecorder.snapshot( 'repository' );
	const three = sourceRecorder.snapshot( 'three' );
	const local = localExamplesRoot ? sourceRecorder.snapshot( 'local' ) : null;
	report.evidence.sources = {
		all,
		repository,
		three,
		...( local ? { local } : {} ),
	};
	report.evidence.threeCheckout.sourceFingerprint = three.sha256;
	report.evidence.threeCheckout.sourceVerification = officialThreeSourceVerifier?.snapshot() || null;
	report.evidence.harness = {
		sourceFingerprint: repository.sha256,
		sourceFileCount: repository.fileCount,
	};

}

function writeReport() {

	refreshReportSourceEvidence();
	const bytes = Buffer.from( JSON.stringify( report, null, 2 ) );
	writeOutputFileAtomic( OUT, reportPath, bytes, { label: 'E2E report' } );
	return bytes;

}

writeReport();

try {

	for ( let i = 0; i < candidates.length; i ++ ) {

		const name = candidates[ i ];
		const label = `[${ i + 1 }/${ candidates.length }] ${ name }`;

		try {

			if ( runsSinceRestart >= MAX_RUNS_PER_BROWSER ) {

				browser = await recycleBrowser( browser, evidenceEnvironment );
				runsSinceRestart = 0;

			}

			const result = await runOne( browser, name );
			runsSinceRestart ++;
			if ( result.status === 'pass' ) report.pass ++; else report.fail ++;
			report.details.push( result );
			writeReport();

			console.log( formatResultLine( label, result ) );
			if ( timingsEnabled ) {
				const timingLine = formatTimingLine( result );
				if ( timingLine ) console.log( timingLine );
			}

		} catch ( err ) {

			if ( err?.code === 'TSLP_EVIDENCE_ENVIRONMENT_DRIFT' ) throw err;
			const errorMessage = err && err.message || String( err );
			report.fail ++;
			report.details.push( {
				name,
				status: 'fail',
				caseConfiguration: caseEvidenceConfiguration( name ),
				evidence: {
					runId: RUN_ID,
					capture: null,
					replay: null,
					userArtifacts: null,
					auxArtifacts: null,
				},
				artifactMetrics: null,
				rendererBackendEvidence: null,
				evidenceGate: createE2EEvidenceGate( {
					blocking: [ {
						code: 'harness-error',
						message: errorMessage,
					} ],
				} ),
				error: errorMessage,
			} );
			writeReport();
			console.log( `${ label } — FAIL harness-error "${ errorMessage }"` );

			// Recover from a dead browser: without this, the first Chrome crash
			// poisons every remaining example because newContext() keeps throwing
			// "Target page, context or browser has been closed" against the dead
			// handle, so we lose ~80 % of the slice every time the renderer dies.
			const msg = errorMessage;
			if ( /browser has been closed|Target page, context|Browser closed/i.test( msg ) ) {
				browser = await recycleBrowser( browser, evidenceEnvironment );
				runsSinceRestart = 0;
			}

		}

	}

} finally {

	await browser.close().catch( () => {} );
	await new Promise( ( resolveClose ) => server.close( resolveClose ) );

}

if ( officialThreeSourcesRequired ) {

	const integrityFailures = [];
	try {

		officialThreeSourceVerifier.assertValid();

	} catch ( error ) {

		integrityFailures.push( error );

	}
	try {

		assertOfficialThreeR185Checkout( threeRepo, 'batch-e2e post-run canonical evidence' );
		const finalGitIdentity = readThreeGitIdentity( threeRepo );
		for ( const key of Object.keys( threeGitIdentity ) ) delete threeGitIdentity[ key ];
		Object.assign( threeGitIdentity, finalGitIdentity );

	} catch ( error ) {

		integrityFailures.push( error );

	}
	if ( integrityFailures.length > 0 ) {

		report.status = 'failed';
		report.completedAt = new Date().toISOString();
		report.integrityError = integrityFailures.map( ( error ) => error && error.message || String( error ) ).join( ' ' );
		writeReport();
		console.error( `[batch-e2e] canonical Three source integrity failed: ${ report.integrityError }` );
		process.exit( 1 );

	}

}

assertUniqueExactNames( report.details.map( ( detail ) => detail.name ), candidates, 'completed E2E report' );
report.status = 'completed';
report.completedAt = new Date().toISOString();
report.evidence.inputRunId = savedEvidenceInput?.manifest?.runId || null;
const reportBytes = writeReport();
const reportDescriptor = describeEvidenceBytes( {
	outputRoot: OUT,
	file: reportPath,
	bytes: reportBytes,
	runId: RUN_ID,
} );
const manifest = {
	schemaVersion: E2E_EVIDENCE_SCHEMA_VERSION,
	runId: RUN_ID,
	campaignId: CAMPAIGN_ID,
	canonical: evidenceRun.canonical,
	completedAt: report.completedAt,
	report: reportDescriptor,
	catalogue: catalogueEvidence,
	corpus: corpusEvidence,
	threeCheckout: report.evidence.threeCheckout,
	slimBundle: report.evidence.slimBundle,
	harness: report.evidence.harness,
	sources: report.evidence.sources,
	configuration: {
		fingerprint: configuration.fingerprint,
		environment: configuration.environment,
	},
	cases: report.details.map( ( detail ) => ( {
		runId: RUN_ID,
		name: detail.name,
		status: detail.status,
		evidenceGate: detail.evidenceGate,
		rendererBackendEvidence: detail.rendererBackendEvidence || null,
		caseConfiguration: detail.caseConfiguration,
		capture: detail.evidence?.capture || null,
		replay: detail.evidence?.replay || null,
		userArtifacts: detail.evidence?.userArtifacts || null,
		auxArtifacts: detail.evidence?.auxArtifacts || null,
		artifactMetrics: detail.artifactMetrics || null,
	} ) ),
};
writeOutputFileAtomic(
	OUT,
	EVIDENCE_MANIFEST_PATH,
	JSON.stringify( manifest, null, 2 ),
	{ label: 'E2E evidence manifest' },
);

console.log( '\n═══ e2e summary ═══' );
console.log( `  ${ report.pass } pass, ${ report.fail } fail, ${ report.skip } skip, ${ report.total } candidates` );
console.log( `  report: ${ reportPath }` );
console.log( `  evidence manifest: ${ EVIDENCE_MANIFEST_PATH } (run ${ RUN_ID })` );
printFailureSummary( report.details );

process.exit( report.total > 0 && report.fail === 0 ? 0 : 1 );
