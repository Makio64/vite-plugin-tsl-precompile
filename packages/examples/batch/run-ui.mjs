#!/usr/bin/env node
/**
 * Local batch-results browser.
 *
 * Shows only capture/replay pairs bound by the current schema-2 evidence set,
 * then lets you run one isolated diagnostic at a time from the UI.
 *
 *   pnpm --filter examples-batch ui
 *   pnpm --filter examples-batch ui -- --port=8787
 *   pnpm --filter examples-batch ui -- --three-repo=/path/to/three.js
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	ARTIFACT_EVIDENCE_CONTENT_ENCODING,
	MAX_ARTIFACT_EVIDENCE_UNCOMPRESSED_BYTES,
} from './e2e-artifact-output.mjs';
import {
	E2E_EVIDENCE_MANIFEST,
	E2E_EVIDENCE_SCHEMA_VERSION,
	E2E_EVIDENCE_SET_JSON,
	assertSafeContainedPath,
	fingerprintJson,
	readEvidenceCatalogue,
	readSafeContainedFile,
	resolveEvidenceDescriptor,
	sha256,
	verifyEvidenceDescriptor,
} from './e2e-evidence.mjs';
import { matchesExampleSkipPrefix } from './example-skip-policy.mjs';
import {
	assertCanonicalExampleName,
	prepareOutputRoot,
} from './output-path-safety.mjs';

const SELF_FILE = fileURLToPath( import.meta.url );
const SELF = dirname( SELF_FILE );
const REPO = resolve( SELF, '../../..' );
const RESULTS = resolve( SELF, 'results' );
const CATALOGUE_PATH = resolve( SELF, 'example-catalogue.json' );
const CATALOGUE = readEvidenceCatalogue( CATALOGUE_PATH, {
	root: REPO,
	label: 'results UI example catalogue',
} );

const args = process.argv.slice( 2 );

function getArg( prefix, def ) {

	const found = args.find( ( arg ) => arg.startsWith( prefix ) );
	return found ? found.slice( prefix.length ) : def;

}

const host = getArg( '--host=', '127.0.0.1' );
const port = parseInt( getArg( '--port=', '8787' ), 10 );
const threeRepo = resolve( getArg( '--three-repo=', resolve( SELF, '../../../../three.js' ) ) );

const SKIP_PREFIXES = [
	'webxr_', 'vr_', 'ar_', 'webgpu_xr_', 'webgpu_webxr_',
	'webgpu_compile_async',
	'webgpu_tsl_precompile',
];

const CATEGORY_ORDER = [
	'Lights',
	'Materials',
	'Shadows',
	'Sprites',
	'Compute',
	'Camera',
	'MRT / RenderTargets',
	'Particles',
	'Postprocessing',
	'Misc',
];

let currentRun = null;
let runSeq = 0;
let uiRunsRoot = null;
let canonicalEvidenceCache = null;
let evidenceFiles = new Map();

function shouldSkip( name ) {

	return matchesExampleSkipPrefix( name, SKIP_PREFIXES );

}

function getUiRunsRoot() {

	if ( ! uiRunsRoot ) uiRunsRoot = mkdtempSync( join( tmpdir(), 'tslp-batch-ui-' ) );
	return uiRunsRoot;

}

function parseJson( bytes, label ) {

	try {

		return JSON.parse( bytes.toString( 'utf8' ) );

	} catch ( cause ) {

		throw new Error( `${ label } is not valid JSON.`, { cause } );

	}

}

function sameJson( left, right ) {

	return fingerprintJson( left === undefined ? null : left ) ===
		fingerprintJson( right === undefined ? null : right );

}

function validateDescriptorMetadata( root, descriptor, runId, label ) {

	if (
		! descriptor ||
		descriptor.runId !== runId ||
		! Number.isSafeInteger( descriptor.bytes ) ||
		descriptor.bytes < 0 ||
		! /^[a-f0-9]{64}$/.test( descriptor.sha256 || '' )
	) {

		throw new Error( `${ label } has invalid schema-2 descriptor metadata.` );
	}
	const file = resolveEvidenceDescriptor( root, descriptor );
	const stats = statSync( file );
	if ( stats.size !== descriptor.bytes ) {

		throw new Error( `${ label } size drifted from its manifest descriptor.` );

	}
	return {
		root,
		runId,
		descriptor,
		file,
		mtimeMs: stats.mtimeMs,
		size: stats.size,
	};

}

function validateCaseDescriptor( root, descriptor, runId, name, kind ) {

	if ( ! descriptor ) return null;
	const screenshot = kind === 'capture' || kind === 'replay';
	let suffix;
	if ( screenshot ) {

		if ( descriptor.contentEncoding !== undefined || descriptor.uncompressedBytes !== undefined ) {

			throw new Error( `Evidence ${ kind } for ${ name } must not declare artifact content encoding.` );

		}
		suffix = `${ kind }.png`;

	} else {

		const basename = kind === 'userArtifacts' ? 'user.json' : 'aux.json';
		if ( descriptor.contentEncoding === undefined && descriptor.uncompressedBytes === undefined ) {

			suffix = basename;

		} else if (
			descriptor.contentEncoding === ARTIFACT_EVIDENCE_CONTENT_ENCODING &&
			Number.isSafeInteger( descriptor.uncompressedBytes ) &&
			descriptor.uncompressedBytes >= 0 &&
			descriptor.uncompressedBytes <= MAX_ARTIFACT_EVIDENCE_UNCOMPRESSED_BYTES
		) {

			suffix = `${ basename }.gz`;

		} else {

			throw new Error( `Evidence ${ kind } for ${ name } has unsupported content encoding.` );

		}

	}
	const expectedFile = `evidence/${ runId }/${ screenshot ? 'shots' : 'artifacts' }/${ name }.${ suffix }`;
	if ( descriptor.file !== expectedFile ) {

		throw new Error( `Evidence ${ kind } for ${ name } is not at its run-scoped canonical path.` );

	}
	return validateDescriptorMetadata( root, descriptor, runId, `Evidence ${ kind } for ${ name }` );

}

function categoryOf( name ) {

	if ( /^webgpu_lights_/.test( name ) || name === 'webgpu_lightprobe_cubecamera.html' ) return 'Lights';
	if ( /^webgpu_materials_/.test( name ) || name === 'webgpu_clearcoat.html' || name === 'webgpu_sandbox.html' ) return 'Materials';
	if ( /^webgpu_shadow/.test( name ) || /^(directional|point|spot|vsm)(?:-|\.html)/.test( name ) ) return 'Shadows';
	if ( /^webgpu_compute_/.test( name ) || /^(dispatch2d|instanced|particles|pipeline|reduce|texture|uniform)\.html$/.test( name ) ) return 'Compute';
	if ( /^webgpu_sprites/.test( name ) ) return 'Sprites';
	if ( /^webgpu_camera/.test( name ) ) return 'Camera';
	if ( /^webgpu_mrt/.test( name ) || /^webgpu_multiple_rendertargets/.test( name ) || /^(manual|mask|pass)\.html$/.test( name ) ) return 'MRT / RenderTargets';
	if ( /^webgpu_particles/.test( name ) ) return 'Particles';
	if ( /^webgpu_postprocessing_/.test( name ) || /^(bloom|fxaa|gtao|passthrough|variants)\.html$/.test( name ) ) return 'Postprocessing';
	return 'Misc';

}

function formatPsnr( psnr ) {

	if ( psnr === 'inf' || psnr === Infinity ) return 'inf';
	if ( typeof psnr === 'number' && Number.isFinite( psnr ) ) return psnr.toFixed( 2 );
	return null;

}

function loadManifestBundle( {
	root,
	manifestBytes,
	catalogue,
	expectedCohort = null,
	aggregateCanonical = false,
	origin = 'canonical',
} ) {

	const manifest = parseJson( manifestBytes, `Evidence manifest below ${ root }` );
	if (
		manifest.schemaVersion !== E2E_EVIDENCE_SCHEMA_VERSION ||
		typeof manifest.runId !== 'string' ||
		typeof manifest.campaignId !== 'string'
	) {

		throw new Error( `Evidence manifest below ${ root } is not schema ${ E2E_EVIDENCE_SCHEMA_VERSION }.` );

	}
	if (
		manifest.catalogue?.sha256 !== catalogue.sha256 ||
		manifest.catalogue?.caseIdsSha256 !== catalogue.caseIdsSha256 ||
		manifest.catalogue?.caseCount !== catalogue.caseCount
	) {

		throw new Error( `Evidence manifest below ${ root } is not bound to the current catalogue.` );

	}
	if ( expectedCohort ) {

		for ( const key of [ 'runId', 'campaignId', 'canonical' ] ) {

			if ( manifest[ key ] !== expectedCohort[ key ] ) {

				throw new Error( `Evidence cohort ${ expectedCohort.id } ${ key } drifted from its manifest.` );

			}

		}
		if ( ! sameJson( manifest.corpus, expectedCohort.corpus ) ) {

			throw new Error( `Evidence cohort ${ expectedCohort.id } corpus drifted from its manifest.` );

		}
	}
	const reportEvidence = verifyEvidenceDescriptor( root, manifest.report, manifest.runId );
	const report = parseJson( reportEvidence.bytes, `Manifest-bound report ${ manifest.report.file }` );
	if (
		report.schemaVersion !== E2E_EVIDENCE_SCHEMA_VERSION ||
		report.runId !== manifest.runId ||
		report.campaignId !== manifest.campaignId ||
		report.status !== 'completed' ||
		report.canonical !== manifest.canonical
	) {

		throw new Error( `Manifest-bound report below ${ root } is not the completed evidence run.` );

	}
	if (
		report.configuration?.fingerprint !== manifest.configuration?.fingerprint ||
		! sameJson( report.configuration?.environment, manifest.configuration?.environment )
	) {

		throw new Error( `Manifest-bound report below ${ root } has configuration drift.` );

	}
	const configuration = { ...report.configuration };
	delete configuration.fingerprint;
	if ( fingerprintJson( configuration ) !== manifest.configuration.fingerprint ) {

		throw new Error( `Manifest-bound report below ${ root } has an invalid configuration fingerprint.` );

	}

	const catalogueByName = new Map( catalogue.records.map( ( record ) => [ record.name, record ] ) );
	const cases = Array.isArray( manifest.cases ) ? manifest.cases : [];
	const details = Array.isArray( report.details ) ? report.details : [];
	const corpusNames = Array.isArray( manifest.corpus?.caseNames ) ? manifest.corpus.caseNames : [];
	const caseNames = cases.map( ( entry ) => entry?.name );
	const detailNames = details.map( ( detail ) => detail?.name );
	for ( const names of [ corpusNames, caseNames, detailNames ] ) {

		if ( names.some( ( name ) => typeof name !== 'string' ) || new Set( names ).size !== names.length ) {

			throw new Error( `Evidence run ${ manifest.runId } has invalid or duplicate case names.` );

		}

	}
	if ( ! sameJson( [ ...corpusNames ].sort(), [ ...caseNames ].sort() ) ||
		! sameJson( [ ...corpusNames ].sort(), [ ...detailNames ].sort() ) ) {

		throw new Error( `Evidence run ${ manifest.runId } report, manifest, and corpus case names drifted.` );

	}

	const detailsByName = new Map( details.map( ( detail ) => [ detail.name, detail ] ) );
	const entries = new Map();
	for ( const entry of cases ) {

		assertCanonicalExampleName( entry.name, `Evidence run ${ manifest.runId } case name` );
		const record = catalogueByName.get( entry.name );
		if ( ! record ) throw new Error( `Evidence run ${ manifest.runId } contains unknown case ${ entry.name }.` );
		if (
			manifest.corpus.kind === 'three' && record.sourceKind !== 'three' ||
			manifest.corpus.kind === 'local' &&
				( record.sourceKind !== 'local' || record.source.project !== manifest.corpus.project )
		) {

			throw new Error( `Evidence run ${ manifest.runId } source cohort does not own ${ entry.name }.` );

		}
		const detail = detailsByName.get( entry.name );
		if (
			entry.runId !== manifest.runId ||
			detail?.evidence?.runId !== manifest.runId ||
			entry.status !== detail?.status ||
			! [ 'pass', 'fail' ].includes( entry.status )
		) {

			throw new Error( `Evidence run ${ manifest.runId } case binding drifted for ${ entry.name }.` );

		}
		for ( const kind of [ 'capture', 'replay', 'userArtifacts', 'auxArtifacts' ] ) {

			if ( ! sameJson( entry[ kind ] || null, detail.evidence?.[ kind ] || null ) ) {

				throw new Error( `Evidence run ${ manifest.runId } ${ kind } binding drifted for ${ entry.name }.` );

			}

		}
		const capture = validateCaseDescriptor( root, entry.capture, manifest.runId, entry.name, 'capture' );
		const replay = validateCaseDescriptor( root, entry.replay, manifest.runId, entry.name, 'replay' );
		const userArtifacts = validateCaseDescriptor( root, entry.userArtifacts, manifest.runId, entry.name, 'userArtifacts' );
		const auxArtifacts = validateCaseDescriptor( root, entry.auxArtifacts, manifest.runId, entry.name, 'auxArtifacts' );
		entries.set( entry.name, {
			name: entry.name,
			record,
			root,
			runId: manifest.runId,
			campaignId: manifest.campaignId,
			cohort: manifest.corpus.project || 'upstream',
			canonical: aggregateCanonical,
			origin,
			status: entry.status,
			capture,
			replay,
			userArtifacts,
			auxArtifacts,
			psnr: formatPsnr( detail.pixelGate?.psnr ),
			psnrValue: detail.pixelGate?.psnr === 'inf'
				? 1e9
				: typeof detail.pixelGate?.psnr === 'number' ? detail.pixelGate.psnr : null,
			note: detail.error || detail.pixelGate?.reason || '',
			captureErrors: Array.isArray( detail.captureErrors ) ? detail.captureErrors.length : null,
			replayErrors: Array.isArray( detail.replayErrors ) ? detail.replayErrors.length : null,
			userArtifactCount: detail.userArtifacts ?? detail.artifactMetrics?.userArtifactCount ?? null,
			auxArtifactCount: detail.auxArtifacts ?? detail.artifactMetrics?.auxArtifactCount ?? null,
		} );

	}
	return { root, manifest, report, entries };

}

export function loadUiEvidenceSnapshot( {
	resultsRoot = RESULTS,
	catalogue = CATALOGUE,
	evidenceSetBytes = null,
} = {} ) {

	const setPath = resolve( resultsRoot, E2E_EVIDENCE_SET_JSON );
	const bytes = evidenceSetBytes || readSafeContainedFile( resultsRoot, setPath, {
		label: 'Results UI evidence set',
	} );
	const evidenceSet = parseJson( bytes, 'Results UI evidence set' );
	if (
		evidenceSet.schemaVersion !== E2E_EVIDENCE_SCHEMA_VERSION ||
		typeof evidenceSet.campaignId !== 'string' ||
		evidenceSet.catalogue?.sha256 !== catalogue.sha256 ||
		evidenceSet.catalogue?.caseIdsSha256 !== catalogue.caseIdsSha256 ||
		evidenceSet.catalogue?.caseCount !== catalogue.caseCount ||
		! Array.isArray( evidenceSet.cohorts )
	) {

		throw new Error( 'Results UI evidence set is not bound to the current schema-2 catalogue.' );

	}

	const entries = new Map();
	const bundles = [];
	for ( const cohort of evidenceSet.cohorts ) {

		if (
			cohort?.portable !== true ||
			cohort.manifest?.file !== E2E_EVIDENCE_MANIFEST ||
			! /^[a-f0-9]{64}$/.test( cohort.manifest?.sha256 || '' )
		) {

			throw new Error( `Results UI cohort ${ cohort?.id || '<unknown>' } is not a portable manifest reference.` );

		}
		const root = resolve( resultsRoot, cohort.root );
		assertSafeContainedPath( resultsRoot, root, {
			allowRoot: true,
			kind: 'directory',
			label: `Results UI cohort ${ cohort.id } root`,
		} );
		const manifestPath = resolve( root, cohort.manifest.file );
		const manifestBytes = readSafeContainedFile( root, manifestPath, {
			label: `Results UI cohort ${ cohort.id } manifest`,
		} );
		if ( sha256( manifestBytes ) !== cohort.manifest.sha256 ) {

			throw new Error( `Results UI cohort ${ cohort.id } manifest hash drifted.` );

		}
		const bundle = loadManifestBundle( {
			root,
			manifestBytes,
			catalogue,
			expectedCohort: cohort,
			aggregateCanonical: evidenceSet.canonical === true,
			origin: 'canonical',
		} );
		for ( const [ name, entry ] of bundle.entries ) {

			if ( entries.has( name ) ) throw new Error( `Results UI evidence cohorts overlap on ${ name }.` );
			entries.set( name, entry );

		}
		bundles.push( bundle );

	}
	if (
		evidenceSet.corpus?.caseCount !== entries.size ||
		( evidenceSet.canonical === true &&
			( entries.size !== catalogue.caseCount ||
				catalogue.records.some( ( record ) => ! entries.has( record.name ) ) ) )
	) {

		throw new Error( 'Results UI evidence set case coverage drifted from its declared corpus.' );

	}
	return {
		canonical: evidenceSet.canonical === true,
		campaignId: evidenceSet.campaignId,
		evidenceSetSha256: sha256( bytes ),
		catalogue,
		entries,
		bundles,
	};

}

export function loadUiDiagnosticSnapshot( {
	outputRoot,
	catalogue = CATALOGUE,
} ) {

	assertSafeContainedPath( outputRoot, outputRoot, {
		allowRoot: true,
		kind: 'directory',
		label: 'Results UI diagnostic root',
	} );
	const manifestPath = resolve( outputRoot, E2E_EVIDENCE_MANIFEST );
	const manifestBytes = readSafeContainedFile( outputRoot, manifestPath, {
		label: 'Results UI diagnostic manifest',
	} );
	return loadManifestBundle( {
		root: outputRoot,
		manifestBytes,
		catalogue,
		aggregateCanonical: false,
		origin: 'diagnostic',
	} );

}

export function readUiEvidenceShot( reference ) {

	const verified = verifyEvidenceDescriptor( reference.root, reference.descriptor, reference.runId );
	if (
		verified.bytes.length < 8 ||
		! verified.bytes.subarray( 0, 8 ).equals( Buffer.from( [ 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a ] ) )
	) {

		throw new Error( `Manifest-bound screenshot ${ reference.descriptor.file } is not a PNG.` );

	}
	return verified.bytes;

}

function readCanonicalEvidence() {

	const evidenceSetPath = resolve( RESULTS, E2E_EVIDENCE_SET_JSON );
	const bytes = readSafeContainedFile( RESULTS, evidenceSetPath, {
		label: 'Results UI evidence set',
	} );
	const fingerprint = sha256( bytes );
	if ( canonicalEvidenceCache?.fingerprint === fingerprint ) return canonicalEvidenceCache.snapshot;
	const snapshot = loadUiEvidenceSnapshot( { evidenceSetBytes: bytes } );
	canonicalEvidenceCache = { fingerprint, snapshot };
	return snapshot;

}

function catalogueRecord( name ) {

	return CATALOGUE.records.find( ( record ) => record.name === name ) || null;

}

export function planUiDiagnosticRun( {
	record,
	canonicalEntry = null,
	mode = 'full',
	sequence,
	runsRoot,
	threeRepo: selectedThreeRepo,
	repositoryRoot = REPO,
	catalogue = CATALOGUE,
} ) {

	if ( ! record || ! catalogue.records.some( ( candidate ) => candidate.name === record.name ) ) {

		throw new Error( `Unknown catalogue example ${ record?.name || '<missing>' }.` );

	}
	const runMode = mode === 'replay' || mode === 'reuse-reference' ? mode : 'full';
	if ( runMode !== 'full' ) {

		if ( ! canonicalEntry?.canonical || canonicalEntry.origin !== 'canonical' ) {

			throw new Error( `${ runMode } requires the current canonical manifest-bound input cohort.` );

		}
		if ( ! canonicalEntry.capture || ( runMode === 'replay' && ( ! canonicalEntry.userArtifacts || ! canonicalEntry.auxArtifacts ) ) ) {

			throw new Error( `${ runMode } requires complete canonical saved evidence for ${ record.name }.` );

		}

	}
	const outputRoot = prepareOutputRoot(
		resolve( runsRoot, `${ String( sequence ).padStart( 4, '0' ) }-${ record.id }` ),
		{
			repositoryRoot,
			label: 'Results UI diagnostic output root',
		},
	);
	const runnerArgs = [
		resolve( SELF, 'run-e2e-with-coverage.mjs' ),
		`--filter=${ record.name }`,
		`--three-repo=${ resolve( selectedThreeRepo ) }`,
		`--output-root=${ outputRoot }`,
	];
	if ( canonicalEntry ) runnerArgs.push( `--input-root=${ canonicalEntry.root }` );
	if ( record.sourceKind === 'local' ) {

		runnerArgs.push( `--local-examples-root=${ resolve( repositoryRoot, 'packages/examples', record.source.project ) }` );

	}
	if ( runMode === 'replay' ) runnerArgs.push( '--replay-only' );
	if ( runMode === 'reuse-reference' ) runnerArgs.push( '--reuse-reference-shot' );
	return {
		mode: runMode,
		outputRoot,
		inputRoot: canonicalEntry?.root || null,
		runnerArgs,
	};

}

function registerShot( registry, entry, kind ) {

	const reference = entry?.[ kind ];
	if ( ! reference ) return null;
	const token = sha256( [
		entry.origin,
		entry.runId,
		entry.name,
		kind,
		reference.descriptor.sha256,
	].join( '\0' ) ).slice( 0, 40 );
	registry.set( token, reference );
	return {
		url: `/evidence/${ token }.png?v=${ reference.descriptor.sha256.slice( 0, 12 ) }`,
		mtimeMs: reference.mtimeMs,
		size: reference.size,
		runId: entry.runId,
		origin: entry.origin,
	};

}

function sortExamples( examples ) {

	return examples.sort( ( left, right ) => {

		const leftRank = CATEGORY_ORDER.indexOf( left.category );
		const rightRank = CATEGORY_ORDER.indexOf( right.category );
		if ( leftRank !== rightRank ) return ( leftRank === - 1 ? 99 : leftRank ) - ( rightRank === - 1 ? 99 : rightRank );
		return left.name.localeCompare( right.name );

	} );

}

function buildState() {

	let canonical = null;
	let evidenceError = null;
	try {

		canonical = readCanonicalEvidence();

	} catch ( error ) {

		evidenceError = error.message;

	}
	let diagnosticEntry = null;
	let diagnosticError = null;
	if ( currentRun && ! currentRun.active && existsSync( resolve( currentRun.outputRoot, E2E_EVIDENCE_MANIFEST ) ) ) {

		try {

			diagnosticEntry = loadUiDiagnosticSnapshot( {
				outputRoot: currentRun.outputRoot,
			} ).entries.get( currentRun.name ) || null;

		} catch ( error ) {

			diagnosticError = error.message;

		}

	}

	const registry = new Map();
	const examples = sortExamples( CATALOGUE.records.map( ( record ) => {

		const canonicalEntry = canonical?.entries.get( record.name ) || null;
		const shown = diagnosticEntry?.name === record.name ? diagnosticEntry : canonicalEntry;
		const capture = registerShot( registry, shown, 'capture' );
		const replay = registerShot( registry, shown, 'replay' );
		return {
			name: record.name,
			basename: record.id,
			category: categoryOf( record.name ),
			status: shown?.status || 'missing',
			canonicalStatus: canonicalEntry?.status || 'missing',
			canonical: canonical?.canonical === true,
			diagnostic: shown?.origin === 'diagnostic',
			canReplay: canonicalEntry?.canonical === true &&
				!! canonicalEntry.capture &&
				!! canonicalEntry.userArtifacts &&
				!! canonicalEntry.auxArtifacts,
			canReuseCapture: canonicalEntry?.canonical === true && !! canonicalEntry.capture,
			evidenceLabel: shown
				? `${ shown.origin === 'diagnostic' ? 'diagnostic run' : canonical?.canonical ? 'canonical campaign' : 'manifest-bound campaign' } ${ shown.runId.slice( 0, 8 ) }`
				: 'no current manifest-bound evidence',
			cohort: shown?.cohort || record.source.project || 'upstream',
			skipped: shouldSkip( record.name ),
			hasCapture: !! capture,
			hasReplay: !! replay,
			capture,
			replay,
			psnr: shown?.psnr || null,
			psnrValue: shown?.psnrValue ?? null,
			note: shown?.note || '',
			captureErrors: shown?.captureErrors ?? null,
			replayErrors: shown?.replayErrors ?? null,
			userArtifacts: shown?.userArtifactCount ?? null,
			auxArtifacts: shown?.auxArtifactCount ?? null,
			updatedAt: Math.max( capture?.mtimeMs || 0, replay?.mtimeMs || 0 ) || null,
			threejsUrl: record.sourceKind === 'three' ? record.source.originalUrl : null,
			sourceLabel: record.sourceKind === 'three'
				? 'Three.js r185'
				: `${ record.source.project }/${ record.source.route }`,
		};

	} ) );
	evidenceFiles = registry;
	const canonicalExamples = CATALOGUE.records.map( ( record ) => canonical?.entries.get( record.name ) || null );
	const totals = {
		total: CATALOGUE.caseCount,
		pass: canonicalExamples.filter( ( example ) => example?.status === 'pass' ).length,
		fail: canonicalExamples.filter( ( example ) => example?.status === 'fail' ).length,
		missingReplay: canonicalExamples.filter( ( example ) => ! example?.replay ).length,
		missingCapture: canonicalExamples.filter( ( example ) => ! example?.capture ).length,
		diagnostic: diagnosticEntry ? 1 : 0,
	};
	return {
		generatedAt: new Date().toISOString(),
		evidence: {
			schemaVersion: E2E_EVIDENCE_SCHEMA_VERSION,
			campaignId: canonical?.campaignId || null,
			canonical: canonical?.canonical === true,
			error: evidenceError,
			diagnosticError,
		},
		paths: {
			results: RESULTS,
			uiRuns: getUiRunsRoot(),
			threeRepo,
			hasThreeRepo: existsSync( join( threeRepo, 'examples' ) ),
		},
		totals,
		run: publicRun(),
		examples,
	};

}

function publicRun() {

	if ( ! currentRun ) return null;
	return {
		id: currentRun.id,
		name: currentRun.name,
		mode: currentRun.mode,
		active: currentRun.active,
		exitCode: currentRun.exitCode,
		startedAt: currentRun.startedAt,
		finishedAt: currentRun.finishedAt,
		outputRoot: currentRun.outputRoot,
		inputRoot: currentRun.inputRoot,
		evidenceKind: 'diagnostic',
		lines: currentRun.lines.slice( - 180 ),
	};

}

function addRunLine( run, line ) {

	const text = String( line || '' );
	if ( ! text ) return;
	run.lines.push( text );
	if ( run.lines.length > 700 ) run.lines.splice( 0, run.lines.length - 700 );

}

function attachLines( stream, run ) {

	let buffer = '';
	stream.on( 'data', ( chunk ) => {

		buffer += chunk.toString();
		const lines = buffer.split( '\n' );
		buffer = lines.pop();
		for ( const line of lines ) addRunLine( run, line );

	} );
	stream.on( 'end', () => {

		if ( buffer ) addRunLine( run, buffer );

	} );

}

function startRun( name, mode ) {

	if ( currentRun?.active ) {

		const err = new Error( `${ currentRun.name } is already running` );
		err.statusCode = 409;
		throw err;

	}
	const normalized = String( name || '' ).trim().endsWith( '.html' )
		? String( name ).trim()
		: `${ String( name || '' ).trim() }.html`;
	try {

		assertCanonicalExampleName( normalized, 'Results UI example name' );

	} catch {

		const err = new Error( 'Invalid example name' );
		err.statusCode = 400;
		throw err;

	}
	const record = catalogueRecord( normalized );
	if ( ! record ) {

		const err = new Error( `Unknown example: ${ normalized }` );
		err.statusCode = 404;
		throw err;

	}
	let canonical = null;
	try {

		canonical = readCanonicalEvidence();

	} catch {}
	const nextSequence = runSeq + 1;
	let plan;
	try {

		plan = planUiDiagnosticRun( {
			record,
			canonicalEntry: canonical?.entries.get( normalized ) || null,
			mode,
			sequence: nextSequence,
			runsRoot: getUiRunsRoot(),
			threeRepo,
		} );

	} catch ( cause ) {

		const err = new Error( cause.message );
		err.statusCode = 409;
		throw err;

	}
	runSeq = nextSequence;
	const run = {
		id: runSeq,
		name: normalized,
		mode: plan.mode,
		active: true,
		exitCode: null,
		startedAt: new Date().toISOString(),
		finishedAt: null,
		outputRoot: plan.outputRoot,
		inputRoot: plan.inputRoot,
		lines: [],
		child: null,
	};
	currentRun = run;
	addRunLine( run, `[ui] diagnostic output: ${ plan.outputRoot }` );
	addRunLine( run, `[ui] canonical input: ${ plan.inputRoot || 'not available' }` );
	addRunLine( run, `[ui] node ${ plan.runnerArgs.map( ( part ) => part.includes( ' ' ) ? JSON.stringify( part ) : part ).join( ' ' ) }` );

	const child = spawn( process.execPath, plan.runnerArgs, {
		cwd: SELF,
		env: { ...process.env, NO_COLOR: '1' },
		stdio: [ 'ignore', 'pipe', 'pipe' ],
		detached: process.platform !== 'win32',
	} );
	run.child = child;
	attachLines( child.stdout, run );
	attachLines( child.stderr, run );
	child.on( 'error', ( err ) => addRunLine( run, `[ui] failed to start: ${ err.message }` ) );
	child.on( 'close', ( code, signal ) => {

		run.active = false;
		run.exitCode = signal ? signal : code ?? 1;
		run.finishedAt = new Date().toISOString();
		addRunLine( run, `[ui] finished with ${ signal ? `signal ${ signal }` : `exit ${ code ?? 1 }` }` );

	} );
	return publicRun();

}

function stopRun() {

	if ( ! currentRun?.active || ! currentRun.child ) return publicRun();
	addRunLine( currentRun, '[ui] stopping run' );
	if ( process.platform !== 'win32' && currentRun.child.pid ) {

		try {

			process.kill( - currentRun.child.pid, 'SIGTERM' );

		} catch {

			currentRun.child.kill( 'SIGTERM' );

		}

	} else {

		currentRun.child.kill( 'SIGTERM' );

	}
	return publicRun();

}

function sendJson( res, data, statusCode = 200 ) {

	const body = JSON.stringify( data );
	res.writeHead( statusCode, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'content-length': Buffer.byteLength( body ),
	} );
	res.end( body );

}

function sendHtml( res, body ) {

	res.writeHead( 200, {
		'content-type': 'text/html; charset=utf-8',
		'cache-control': 'no-store',
		'content-length': Buffer.byteLength( body ),
	} );
	res.end( body );

}

function sendText( res, body, statusCode = 200 ) {

	res.writeHead( statusCode, {
		'content-type': 'text/plain; charset=utf-8',
		'cache-control': 'no-store',
		'content-length': Buffer.byteLength( body ),
	} );
	res.end( body );

}

function readBody( req ) {

	return new Promise( ( resolveBody, rejectBody ) => {

		let body = '';
		req.on( 'data', ( chunk ) => {

			body += chunk;
			if ( body.length > 1024 * 1024 ) {

				rejectBody( new Error( 'Request body too large' ) );
				req.destroy();

			}

		} );
		req.on( 'end', () => resolveBody( body ) );
		req.on( 'error', rejectBody );

	} );

}

function serveEvidenceShot( res, pathname ) {

	const match = pathname.match( /^\/evidence\/([a-f0-9]{40})\.png$/ );
	if ( ! match ) {

		sendText( res, 'Invalid evidence token', 400 );
		return;

	}
	const reference = evidenceFiles.get( match[ 1 ] );
	if ( ! reference ) {

		sendText( res, 'Not found', 404 );
		return;

	}
	const bytes = readUiEvidenceShot( reference );
	res.writeHead( 200, {
		'content-type': 'image/png',
		'cache-control': 'private, max-age=60, immutable',
		'content-length': bytes.length,
		'x-content-type-options': 'nosniff',
	} );
	res.end( bytes );

}

async function handleRequest( req, res ) {

	const url = new URL( req.url, `http://${ req.headers.host || 'localhost' }` );

	try {

		if ( req.method === 'GET' && url.pathname === '/' ) {

			sendHtml( res, appHtml() );
			return;

		}

		if ( req.method === 'GET' && url.pathname === '/api/state' ) {

			sendJson( res, buildState() );
			return;

		}

		if ( req.method === 'POST' && url.pathname === '/api/run' ) {

			const body = JSON.parse( await readBody( req ) || '{}' );
			sendJson( res, { run: startRun( body.name, body.mode ) } );
			return;

		}

		if ( req.method === 'POST' && url.pathname === '/api/stop' ) {

			sendJson( res, { run: stopRun() } );
			return;

		}

		if ( req.method === 'GET' && url.pathname.startsWith( '/evidence/' ) ) {

			serveEvidenceShot( res, url.pathname );
			return;

		}

		sendText( res, 'Not found', 404 );

	} catch ( err ) {

		sendJson( res, { error: err.message }, err.statusCode || 500 );

	}

}

function appHtml() {

	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<meta name="color-scheme" content="dark">
	<title>TSL examples batch viewer</title>
	<style>
		:root {
			color-scheme: dark;
			--bg: #090a0f;
			--panel: #11131b;
			--panel-2: #171a25;
			--line: #2a2f3e;
			--line-strong: #3a4154;
			--text: #f3f6fb;
			--dim: #aab2c2;
			--muted: #767f93;
			--accent: #54d7b7;
			--accent-2: #78a8ff;
			--warn: #f2bb45;
			--bad: #f2707e;
			--good: #55d694;
			--shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
			font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
			font-size: 15px;
		}
		* { box-sizing: border-box; }
		body {
			margin: 0;
			min-height: 100vh;
			background: var(--bg);
			color: var(--text);
		}
		button, input, select { font: inherit; }
		button {
			border: 1px solid var(--line);
			background: var(--panel-2);
			color: var(--text);
			border-radius: 7px;
			padding: 0.48rem 0.7rem;
			cursor: pointer;
		}
		button:hover:not(:disabled) { border-color: var(--line-strong); background: #1d2130; }
		button:disabled { opacity: 0.45; cursor: not-allowed; }
		.app {
			width: min(1760px, 100%);
			margin: 0 auto;
			padding: 1rem;
		}
		.top {
			position: sticky;
			top: 0;
			z-index: 10;
			background: rgba(9, 10, 15, 0.92);
			backdrop-filter: blur(14px);
			border-bottom: 1px solid var(--line);
			margin: -1rem -1rem 1rem;
			padding: 1rem;
		}
		.top-row {
			display: grid;
			grid-template-columns: minmax(260px, 1fr) auto;
			gap: 1rem;
			align-items: start;
		}
		h1 {
			margin: 0 0 0.25rem;
			font-size: 1.25rem;
			letter-spacing: 0;
		}
		.sub {
			margin: 0;
			color: var(--dim);
			font-size: 0.88rem;
		}
		.metrics {
			display: flex;
			flex-wrap: wrap;
			gap: 0.45rem;
			justify-content: flex-end;
		}
		.metric {
			background: var(--panel);
			border: 1px solid var(--line);
			border-radius: 7px;
			padding: 0.45rem 0.65rem;
			min-width: 76px;
			text-align: right;
		}
		.metric strong {
			display: block;
			font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
			font-size: 1rem;
		}
		.metric span {
			color: var(--muted);
			font-size: 0.72rem;
		}
		.controls {
			margin-top: 0.9rem;
			display: grid;
			grid-template-columns: minmax(220px, 1fr) 180px 180px auto;
			gap: 0.55rem;
			align-items: center;
		}
		.search, .select {
			width: 100%;
			background: var(--panel);
			border: 1px solid var(--line);
			color: var(--text);
			border-radius: 7px;
			padding: 0.55rem 0.7rem;
		}
		.search:focus, .select:focus {
			outline: none;
			border-color: var(--accent-2);
		}
		.runbar {
			margin-top: 0.75rem;
			display: none;
			grid-template-columns: minmax(180px, 1fr) auto;
			gap: 0.6rem;
			align-items: center;
			background: var(--panel);
			border: 1px solid var(--line);
			border-radius: 8px;
			padding: 0.65rem;
		}
		.runbar.is-visible { display: grid; }
		.run-title {
			font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
			font-size: 0.82rem;
			color: var(--dim);
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.log {
			margin: 0.55rem 0 0;
			max-height: 190px;
			overflow: auto;
			background: #05060a;
			border: 1px solid var(--line);
			border-radius: 7px;
			padding: 0.7rem;
			font: 0.78rem/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
			color: #c8d0df;
			white-space: pre-wrap;
		}
		.grid {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
			gap: 0.85rem;
		}
		.card {
			background: var(--panel);
			border: 1px solid var(--line);
			border-radius: 8px;
			overflow: hidden;
			box-shadow: var(--shadow);
		}
		.card.is-active { border-color: var(--accent-2); }
		.card.is-diagnostic { border-color: var(--warn); }
		.card-head {
			padding: 0.72rem;
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 0.55rem;
			align-items: start;
			border-bottom: 1px solid var(--line);
		}
		.name {
			font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
			font-size: 0.86rem;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.meta {
			margin-top: 0.24rem;
			color: var(--muted);
			font-size: 0.76rem;
			display: flex;
			gap: 0.45rem;
			flex-wrap: wrap;
		}
		.badge {
			display: inline-flex;
			align-items: center;
			gap: 0.35rem;
			border: 1px solid var(--line);
			border-radius: 999px;
			padding: 0.18rem 0.5rem;
			color: var(--dim);
			font-size: 0.74rem;
		}
		.badge::before {
			content: "";
			width: 0.5rem;
			height: 0.5rem;
			border-radius: 999px;
			background: var(--muted);
		}
		.badge.pass::before { background: var(--good); }
		.badge.fail::before { background: var(--bad); }
		.badge.unknown::before { background: var(--warn); }
		.badge.missing::before { background: var(--muted); }
		.compare {
			display: grid;
			grid-template-columns: 1fr 1fr;
			gap: 1px;
			background: var(--line);
		}
		.frame {
			min-width: 0;
			background: #05060a;
		}
		.frame-label {
			display: flex;
			justify-content: space-between;
			gap: 0.5rem;
			padding: 0.38rem 0.5rem;
			color: var(--dim);
			font-size: 0.72rem;
			border-bottom: 1px solid var(--line);
		}
		.frame-label span:last-child {
			color: var(--muted);
			font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		}
		.shot {
			display: block;
			width: 100%;
			aspect-ratio: 4 / 3;
			object-fit: contain;
			background: #05060a;
		}
		.placeholder {
			aspect-ratio: 4 / 3;
			display: grid;
			place-items: center;
			color: var(--muted);
			font-size: 0.8rem;
		}
		.actions {
			padding: 0.65rem 0.72rem;
			display: flex;
			gap: 0.5rem;
			flex-wrap: wrap;
			align-items: center;
			justify-content: space-between;
		}
		.actions-left, .actions-right {
			display: flex;
			gap: 0.45rem;
			flex-wrap: wrap;
		}
		.primary {
			background: linear-gradient(135deg, var(--accent), var(--accent-2));
			color: #071018;
			border-color: transparent;
			font-weight: 700;
		}
		.link {
			color: var(--dim);
			text-decoration: none;
			border: 1px solid var(--line);
			border-radius: 7px;
			padding: 0.48rem 0.7rem;
			font-size: 0.86rem;
		}
		.link:hover { color: var(--text); border-color: var(--line-strong); }
		.empty {
			padding: 3rem 1rem;
			text-align: center;
			color: var(--muted);
			border: 1px dashed var(--line-strong);
			border-radius: 8px;
		}
		.toast {
			position: fixed;
			right: 1rem;
			bottom: 1rem;
			background: var(--panel);
			border: 1px solid var(--line-strong);
			border-radius: 8px;
			padding: 0.75rem 0.9rem;
			box-shadow: var(--shadow);
			color: var(--text);
			display: none;
			max-width: min(460px, calc(100vw - 2rem));
		}
		.toast.is-visible { display: block; }
		@media (max-width: 980px) {
			.top-row { grid-template-columns: 1fr; }
			.metrics { justify-content: flex-start; }
			.controls { grid-template-columns: 1fr 1fr; }
			.grid { grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); }
		}
		@media (max-width: 620px) {
			.app { padding: 0.7rem; }
			.top { margin: -0.7rem -0.7rem 0.7rem; padding: 0.7rem; }
			.controls { grid-template-columns: 1fr; }
			.compare { grid-template-columns: 1fr; }
			.grid { grid-template-columns: 1fr; }
		}
	</style>
</head>
<body>
	<div class="app">
		<header class="top">
			<div class="top-row">
				<div>
					<h1>TSL examples before / after</h1>
					<p class="sub" id="subtitle">Loading batch results...</p>
				</div>
				<div class="metrics" id="metrics"></div>
			</div>
			<div class="controls">
				<input class="search" id="search" type="search" placeholder="Search examples" autocomplete="off">
				<select class="select" id="status">
					<option value="all">All statuses</option>
					<option value="fail">Failing</option>
					<option value="pass">Passing</option>
					<option value="unknown">Unknown</option>
					<option value="missing-replay">Missing replay</option>
					<option value="missing-capture">Missing capture</option>
				</select>
				<select class="select" id="category">
					<option value="all">All categories</option>
				</select>
				<button id="refresh" type="button">Refresh</button>
			</div>
			<section class="runbar" id="runbar" aria-live="polite">
				<div>
					<div class="run-title" id="run-title"></div>
					<pre class="log" id="log"></pre>
				</div>
				<button id="stop" type="button">Stop</button>
			</section>
		</header>
		<main class="grid" id="grid"></main>
		<div class="empty" id="empty" hidden>No examples match the current filters.</div>
	</div>
	<div class="toast" id="toast"></div>
	<script type="module">
		const state = {
			data: null,
			query: '',
			status: 'all',
			category: 'all',
			pending: false,
		};

		const $ = ( selector ) => document.querySelector( selector );

		function escapeHtml( value ) {
			return String( value ?? '' ).replace( /[&<>"']/g, ( char ) => ( {
				'&': '&amp;',
				'<': '&lt;',
				'>': '&gt;',
				'"': '&quot;',
				"'": '&#39;',
			} )[ char ] );
		}

		function fmtTime( value ) {
			if ( ! value ) return 'never';
			const date = new Date( value );
			if ( Number.isNaN( date.getTime() ) ) return 'unknown';
			return date.toLocaleString( [], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } );
		}

		function showToast( message ) {
			const el = $( '#toast' );
			el.textContent = message;
			el.classList.add( 'is-visible' );
			clearTimeout( showToast.timer );
			showToast.timer = setTimeout( () => el.classList.remove( 'is-visible' ), 4200 );
		}

		function metric( label, value ) {
			return '<div class="metric"><strong>' + escapeHtml( value ) + '</strong><span>' + escapeHtml( label ) + '</span></div>';
		}

			function renderMetrics() {
				const totals = state.data.totals;
				$( '#metrics' ).innerHTML = [
					metric( 'catalogue', totals.total ),
					metric( 'canonical pass', totals.pass ),
					metric( 'canonical fail', totals.fail ),
					metric( 'canonical no replay', totals.missingReplay ),
					metric( 'diagnostic shown', totals.diagnostic ),
				].join( '' );
			}

			function renderSubtitle() {
				const paths = state.data.paths;
				const evidence = state.data.evidence;
				const suffix = paths.hasThreeRepo ? paths.threeRepo : 'three.js checkout not found; showing saved results';
				const campaign = evidence.error
					? 'Evidence unavailable: ' + evidence.error
					: ( evidence.canonical ? 'Canonical' : 'Non-canonical' ) + ' schema-2 campaign ' + evidence.campaignId;
				$( '#subtitle' ).textContent = campaign + ' | focused output: ' + paths.uiRuns + ' | three.js: ' + suffix;
			}

		function renderCategories() {
			const select = $( '#category' );
			const current = select.value || 'all';
			const categories = Array.from( new Set( state.data.examples.map( ( example ) => example.category ) ) ).sort();
			select.innerHTML = '<option value="all">All categories</option>' + categories.map( ( category ) =>
				'<option value="' + escapeHtml( category ) + '">' + escapeHtml( category ) + '</option>'
			).join( '' );
			select.value = categories.includes( current ) ? current : 'all';
			state.category = select.value;
		}

			function statusText( example ) {
				if ( example.skipped ) return 'skipped';
				if ( example.status === 'pass' ) return example.diagnostic ? 'diagnostic pass' : 'pass';
				if ( example.status === 'fail' ) return example.diagnostic ? 'diagnostic fail' : 'fail';
				if ( example.status === 'missing' ) return 'missing';
				return 'unknown';
			}

		function matchesFilters( example ) {
			if ( state.query ) {
				const q = state.query.toLowerCase();
				const hit = example.name.toLowerCase().includes( q )
					|| example.category.toLowerCase().includes( q )
					|| String( example.note || '' ).toLowerCase().includes( q );
				if ( ! hit ) return false;
			}
			if ( state.category !== 'all' && example.category !== state.category ) return false;
			if ( state.status === 'missing-replay' ) return ! example.hasReplay;
			if ( state.status === 'missing-capture' ) return ! example.hasCapture;
			if ( state.status !== 'all' && example.status !== state.status ) return false;
			return true;
		}

		function renderImage( example, kind ) {
			const shot = example[ kind ];
			const label = kind === 'capture' ? 'Before: live three.js' : 'After: slim replay';
			const stamp = shot ? fmtTime( shot.mtimeMs ) : 'missing';
			const body = shot
				? '<img class="shot" loading="lazy" decoding="async" src="' + escapeHtml( shot.url ) + '" alt="' + escapeHtml( label + ' for ' + example.name ) + '">'
				: '<div class="placeholder">No ' + escapeHtml( kind ) + ' screenshot</div>';
			return '<div class="frame"><div class="frame-label"><span>' + escapeHtml( label ) + '</span><span>' + escapeHtml( stamp ) + '</span></div>' + body + '</div>';
		}

			function renderCard( example ) {
				const running = state.data.run && state.data.run.active;
				const active = running && state.data.run.name === example.name;
				const disabled = running ? ' disabled' : '';
				const replayDisabled = running || ! example.canReplay ? ' disabled' : '';
				const reuseDisabled = running || ! example.canReuseCapture ? ' disabled' : '';
				const psnr = example.psnr ? example.psnr + ' dB' : 'PSNR n/a';
				const artifacts = example.userArtifacts == null ? '' : '<span>' + escapeHtml( example.userArtifacts + '+' + example.auxArtifacts + ' artifacts' ) + '</span>';
				const errors = example.captureErrors || example.replayErrors
					? '<span>' + escapeHtml( ( example.captureErrors || 0 ) + ' capture errors, ' + ( example.replayErrors || 0 ) + ' replay errors' ) + '</span>'
					: '';
				const note = example.note ? '<span title="' + escapeHtml( example.note ) + '">' + escapeHtml( example.note ) + '</span>' : '';
				const sourceLink = example.threejsUrl
					? '<a class="link" href="' + escapeHtml( example.threejsUrl ) + '" target="_blank" rel="noopener">three.js</a>'
					: '<span class="link">' + escapeHtml( example.sourceLabel ) + '</span>';
				return '<article class="card' + ( active ? ' is-active' : '' ) + ( example.diagnostic ? ' is-diagnostic' : '' ) + '" data-name="' + escapeHtml( example.name ) + '">'
					+ '<div class="card-head">'
					+ '<div><div class="name">' + escapeHtml( example.name ) + '</div><div class="meta"><span>' + escapeHtml( example.category ) + '</span><span>' + escapeHtml( psnr ) + '</span><span>' + escapeHtml( example.evidenceLabel ) + '</span>' + artifacts + errors + note + '</div></div>'
					+ '<span class="badge ' + escapeHtml( example.status ) + '">' + escapeHtml( statusText( example ) ) + '</span>'
					+ '</div>'
					+ '<div class="compare">' + renderImage( example, 'capture' ) + renderImage( example, 'replay' ) + '</div>'
					+ '<div class="actions">'
					+ '<div class="actions-left">'
					+ '<button class="primary" type="button" data-run="full" data-name="' + escapeHtml( example.name ) + '"' + disabled + '>Regenerate</button>'
					+ '<button type="button" data-run="replay" data-name="' + escapeHtml( example.name ) + '"' + replayDisabled + '>Replay only</button>'
					+ '<button type="button" data-run="reuse-reference" data-name="' + escapeHtml( example.name ) + '"' + reuseDisabled + '>Reuse capture</button>'
					+ '</div>'
					+ '<div class="actions-right">' + sourceLink + '</div>'
					+ '</div>'
					+ '</article>';
		}

		function renderGrid() {
			const examples = state.data.examples.filter( matchesFilters );
			$( '#grid' ).innerHTML = examples.map( renderCard ).join( '' );
			$( '#empty' ).hidden = examples.length > 0;
		}

		function renderRun() {
			const run = state.data.run;
			const runbar = $( '#runbar' );
			if ( ! run ) {
				runbar.classList.remove( 'is-visible' );
				return;
			}
			runbar.classList.add( 'is-visible' );
			const stateText = run.active ? 'running' : 'finished: ' + run.exitCode;
				$( '#run-title' ).textContent = 'diagnostic | ' + run.name + ' | ' + run.mode + ' | ' + stateText;
			$( '#log' ).textContent = run.lines.join( '\\n' );
			$( '#stop' ).disabled = ! run.active;
		}

		function render() {
			if ( ! state.data ) return;
			renderSubtitle();
			renderMetrics();
			renderCategories();
			renderRun();
			renderGrid();
		}

		async function loadState() {
			const response = await fetch( '/api/state', { cache: 'no-store' } );
			if ( ! response.ok ) throw new Error( 'State request failed: HTTP ' + response.status );
			state.data = await response.json();
			render();
		}

		async function startRun( name, mode ) {
			const response = await fetch( '/api/run', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify( { name, mode } ),
			} );
			const body = await response.json().catch( () => ( {} ) );
			if ( ! response.ok ) throw new Error( body.error || 'Run request failed' );
			await loadState();
		}

		async function stopRun() {
			await fetch( '/api/stop', { method: 'POST' } );
			await loadState();
		}

		$( '#search' ).addEventListener( 'input', ( event ) => {
			state.query = event.target.value.trim();
			renderGrid();
		} );
		$( '#status' ).addEventListener( 'change', ( event ) => {
			state.status = event.target.value;
			renderGrid();
		} );
		$( '#category' ).addEventListener( 'change', ( event ) => {
			state.category = event.target.value;
			renderGrid();
		} );
		$( '#refresh' ).addEventListener( 'click', () => {
			loadState().catch( ( err ) => showToast( err.message ) );
		} );
		$( '#stop' ).addEventListener( 'click', () => {
			stopRun().catch( ( err ) => showToast( err.message ) );
		} );
		$( '#grid' ).addEventListener( 'click', ( event ) => {
			const button = event.target.closest( '[data-run]' );
			if ( ! button ) return;
			startRun( button.dataset.name, button.dataset.run ).catch( ( err ) => showToast( err.message ) );
		} );

		await loadState().catch( ( err ) => showToast( err.message ) );
		setInterval( () => {
			if ( state.data?.run?.active ) {
				loadState().catch( ( err ) => showToast( err.message ) );
			}
		}, 1200 );
		setInterval( () => {
			if ( ! state.data?.run?.active ) {
				loadState().catch( () => {} );
			}
		}, 8000 );
	</script>
</body>
</html>`;

}

export function createUiServer() {

	return createServer( ( req, res ) => {

		handleRequest( req, res ).catch( ( err ) => sendJson( res, { error: err.message }, 500 ) );

	} );

}

if ( process.argv[ 1 ] && resolve( process.argv[ 1 ] ) === SELF_FILE ) {

	const server = createUiServer();
	server.listen( port, host, () => {

		const url = `http://${ host }:${ port }`;
		console.log( `[examples-ui] ${ url }` );
		console.log( `[examples-ui] manifest-bound results: ${ RESULTS }` );
		console.log( `[examples-ui] diagnostic output root: ${ getUiRunsRoot() }` );
		console.log( `[examples-ui] three.js: ${ threeRepo }` );
		console.log( '[examples-ui] press Ctrl+C to stop' );

	} );

}
