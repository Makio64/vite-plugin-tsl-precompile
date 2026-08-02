#!/usr/bin/env node
// Generate public/examples.json and its thumbnails exclusively from the
// canonical schema-2 campaign. Loose screenshots, artifact dumps, reports, and
// the human-readable coverage markdown are never discovery inputs.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

import {
	E2E_COVERAGE_JSON,
	E2E_EVIDENCE_SET_JSON,
	readSafeContainedFile,
} from '../../examples/batch/e2e-evidence.mjs';
import {
	resolveStockHarnessSourceFiles,
	stockHarnessFingerprint,
	validateExactStockReport,
} from '../../examples/batch/stock-report-contract.mjs';
import {
	assertCanonicalExampleId,
	assertCanonicalExampleName,
	assertOutputDirectoryTarget,
	assertOutputFileTarget,
	ensureOutputDirectory,
	prepareOutputRoot,
	removeOutputPath,
	writeOutputFileAtomic,
} from '../../examples/batch/output-path-safety.mjs';
import {
	assertKnownSiteSelectorArguments,
	assertPublishableSitePublicEvidence,
	describeCanonicalStockReport,
	loadCanonicalExamplesEvidence,
	resolveCanonicalExamplesEvidenceRoot,
	resolveCanonicalSitePublicRoot,
	resolveCanonicalStockReport,
} from './examples-evidence-contract.mjs';
import { probeThumbHealth, renderBoundShot } from './evidence-image-buffer.mjs';

assertKnownSiteSelectorArguments();
const SELF = dirname( fileURLToPath( import.meta.url ) );
const SITE_ROOT = resolve( SELF, '..' );
const REPO_ROOT = resolve( SITE_ROOT, '../..' );
const RESULTS = resolveCanonicalExamplesEvidenceRoot( { repositoryRoot: REPO_ROOT } );
const CATALOGUE_JSON = resolve( REPO_ROOT, 'packages/examples/batch/example-catalogue.json' );
const STOCK_REPORT_JSON = resolveCanonicalStockReport( { repositoryRoot: REPO_ROOT } );
const GENERATOR_SOURCE = fileURLToPath( import.meta.url );
const EVIDENCE_CONTRACT_SOURCE = resolve( SELF, 'examples-evidence-contract.mjs' );
const IMAGE_BUFFER_SOURCE = resolve( SELF, 'evidence-image-buffer.mjs' );

const SELECTED_PUBLIC = resolveCanonicalSitePublicRoot( { siteRoot: SITE_ROOT } );
let PUBLIC = SELECTED_PUBLIC;
let THUMBS_ROOT = resolve( PUBLIC, 'examples/thumbs' );
let THUMBS = THUMBS_ROOT;
let THUMB_URL_PREFIX = 'examples/thumbs';
let OUT_JSON = resolve( PUBLIC, 'examples.json' );
let OUT_COVERAGE = resolve( PUBLIC, E2E_COVERAGE_JSON );
let OUT_MANIFEST = resolve( PUBLIC, E2E_EVIDENCE_SET_JSON );

const THUMB_W = 320;
const THUMB_H = 240;
const MODAL_W = 640;
const MODAL_H = 480;
const WEBP_Q = 78;

function sha256( value ) {

	return createHash( 'sha256' ).update( value ).digest( 'hex' );

}

async function resizeBoundShot( sourceBytes, destPath, width, height ) {

	const bytes = await renderBoundShot( sourceBytes, width, height, { quality: WEBP_Q } );
	writeOutputFileAtomic( PUBLIC, destPath, bytes, {
		label: 'Bound example thumbnail',
	} );
	return { bytes, sha256: sha256( bytes ) };

}

function badgeFor( record ) {

	if ( record.pixel.verdict === 'diagnostic' ) return 'diagnostic';
	if ( record.pixel.verdict === 'fail' ) return 'fail';
	return qualityFor( record );

}

function qualityFor( record ) {

	if ( ! record.hasReplay ) return 'capture-only';
	if ( record.pixel.identical || record.pixel.psnr >= record.pixel.threshold ) return 'pixel-match';
	if ( record.pixel.psnr !== null && record.pixel.psnr >= 20 ) return 'visual-match';
	return 'renders';

}

function displayName( basename ) {

	const withoutPrefix = basename.replace( /^webgpu_/, '' );
	const parts = withoutPrefix.split( '_' );
	return parts.length === 1 ? parts[ 0 ] : `${ parts[ 0 ] } · ${ parts.slice( 1 ).join( ' ' ) }`;

}

function categoryIdentity( label ) {

	const known = {
		Lights: 'lights',
		Materials: 'materials',
		Shadows: 'shadows',
		Sprites: 'sprites',
		Compute: 'compute',
		Camera: 'camera',
		'MRT / RenderTargets': 'mrt',
		Particles: 'particles',
		Postprocessing: 'postprocessing',
		Misc: 'misc',
	};
	return known[ label ] || String( label || 'Misc' ).toLowerCase().replace( /\W+/g, '-' );

}

function sortKey( record ) {

	const tier = {
		'pixel-match': 0,
		'visual-match': 1,
		diagnostic: 2,
		renders: 3,
		'capture-only': 4,
		fail: 5,
	}[ record.badge ] ?? 6;
	const effectivePsnr = record.pixel.identical ? 1e6 : ( record.pixel.psnr ?? 0 );
	return [ tier, - effectivePsnr, record.basename ];

}

function compareSortKeys( left, right ) {

	for ( let index = 0; index < left.length; index ++ ) {

		if ( left[ index ] < right[ index ] ) return - 1;
		if ( left[ index ] > right[ index ] ) return 1;

	}
	return 0;

}

function reorderForBreadth( records ) {

	const greens = records.filter( ( record ) => record.badge === 'pixel-match' );
	const rest = records.filter( ( record ) => record.badge !== 'pixel-match' );
	const buckets = new Map();
	for ( const record of greens ) {

		if ( ! buckets.has( record.category ) ) buckets.set( record.category, [] );
		buckets.get( record.category ).push( record );

	}
	const effectivePsnr = ( record ) => record.pixel.identical ? 1e6 : ( record.pixel.psnr ?? 0 );
	for ( const recordsInCategory of buckets.values() ) {

		recordsInCategory.sort( ( left, right ) => effectivePsnr( right ) - effectivePsnr( left ) );

	}
	const breadth = [];
	while ( buckets.size > 0 ) {

		for ( const [ category, recordsInCategory ] of [ ...buckets.entries() ] ) {

			breadth.push( recordsInCategory.shift() );
			if ( recordsInCategory.length === 0 ) buckets.delete( category );

		}

	}
	return [ ...breadth, ...rest ];

}

async function main() {

	console.log( `[examples-data] validating canonical schema-2 evidence at ${ RESULTS }…` );
	console.log( `[examples-data] validating canonical stock report ${ STOCK_REPORT_JSON }…` );
	const campaign = loadCanonicalExamplesEvidence( {
		resultsRoot: RESULTS,
		cataloguePath: CATALOGUE_JSON,
	} );
	const stockReportRaw = readSafeContainedFile( dirname( STOCK_REPORT_JSON ), STOCK_REPORT_JSON, {
		label: 'current stock report',
	} );
	const catalogueRaw = readSafeContainedFile( REPO_ROOT, CATALOGUE_JSON, {
		label: 'current example catalogue',
	} );
	const generatorRaw = readSafeContainedFile( REPO_ROOT, GENERATOR_SOURCE, {
		label: 'current examples data generator',
	} );
	const evidenceContractRaw = readSafeContainedFile( REPO_ROOT, EVIDENCE_CONTRACT_SOURCE, {
		label: 'current examples evidence contract',
	} );
	const imageBufferRaw = readSafeContainedFile( REPO_ROOT, IMAGE_BUFFER_SOURCE, {
		label: 'current verified evidence image helper',
	} );
	const stockHarnessSha256 = stockHarnessFingerprint(
		resolveStockHarnessSourceFiles( REPO_ROOT ).map( ( path ) => readSafeContainedFile(
			REPO_ROOT,
			path,
			{ label: `current stock harness source ${ relative( REPO_ROOT, path ) }` },
		) ),
	);
	const stockReport = JSON.parse( stockReportRaw.toString( 'utf8' ) );
	const stockReportDescriptor = describeCanonicalStockReport( STOCK_REPORT_JSON, stockReportRaw, stockReport );
	const catalogueJson = JSON.parse( catalogueRaw.toString( 'utf8' ) );
	validateExactStockReport( stockReport, {
		catalogue: catalogueJson,
		catalogueSha256: sha256( catalogueRaw ),
		harnessSha256: stockHarnessSha256,
	} );
	const stockByName = new Map( stockReport.details.map( ( detail ) => [ detail.name, detail ] ) );

	for ( const catalogueEntry of campaign.catalogue.records ) {

		assertCanonicalExampleId( catalogueEntry.id, 'Public example catalogue identifier' );
		assertCanonicalExampleName( catalogueEntry.name, 'Public example catalogue name' );

	}
	const thumbnailGeneration = assertCanonicalExampleId(
		[
			campaign.coverage.campaignId,
			campaign.coverageSource.sha256.slice( 0, 16 ),
			sha256( generatorRaw ).slice( 0, 16 ),
			sha256( imageBufferRaw ).slice( 0, 16 ),
			sha256( JSON.stringify( sharp.versions ) ).slice( 0, 12 ),
		].join( '-' ),
		'Public thumbnail generation identifier',
	);
	PUBLIC = prepareOutputRoot( SELECTED_PUBLIC, {
		repositoryRoot: REPO_ROOT,
		allowedRepositoryRoots: [ resolve( SITE_ROOT, 'public' ) ],
		label: 'Site public output root',
	} );
	THUMBS_ROOT = resolve( PUBLIC, 'examples/thumbs' );
	THUMBS = resolve( THUMBS_ROOT, thumbnailGeneration );
	THUMB_URL_PREFIX = `examples/thumbs/${ thumbnailGeneration }`;
	OUT_JSON = resolve( PUBLIC, 'examples.json' );
	OUT_COVERAGE = resolve( PUBLIC, E2E_COVERAGE_JSON );
	OUT_MANIFEST = resolve( PUBLIC, E2E_EVIDENCE_SET_JSON );
	console.log( `[examples-data] writing bound public data below ${ PUBLIC }…` );
	assertOutputDirectoryTarget( PUBLIC, THUMBS_ROOT, { label: 'Public example thumbnail root' } );
	assertOutputDirectoryTarget( PUBLIC, THUMBS, { label: 'Public example thumbnail generation' } );
	assertOutputFileTarget( PUBLIC, OUT_JSON, { label: 'Public examples JSON' } );
	assertOutputFileTarget( PUBLIC, OUT_COVERAGE, { label: 'Public coverage summary' } );
	assertOutputFileTarget( PUBLIC, OUT_MANIFEST, { label: 'Public campaign manifest' } );
	ensureOutputDirectory( PUBLIC, THUMBS_ROOT, { label: 'Public example thumbnail root' } );
	let previousThumbnailGeneration = null;
	if ( existsSync( OUT_JSON ) ) {

		const previousRaw = readSafeContainedFile( PUBLIC, OUT_JSON, {
			label: 'Previous public examples JSON',
		} );
		try {

			const previous = JSON.parse( previousRaw.toString( 'utf8' ) );
			if ( previous.provenance?.thumbnailGeneration ) {

				previousThumbnailGeneration = assertCanonicalExampleId(
					previous.provenance.thumbnailGeneration,
					'Previous public thumbnail generation',
				);

			}

		} catch {

			// A malformed previous output cannot safely name a generation to
			// retain, but it must not prevent a complete validated replacement.

		}

	}
	for ( const entry of await readdir( THUMBS_ROOT, { withFileTypes: true } ) ) {

		if ( entry.isSymbolicLink() ) throw new Error(
			`Public example thumbnail root contains a symbolic link: ${ entry.name }.`,
		);

	}
	ensureOutputDirectory( PUBLIC, THUMBS, { label: 'Public example thumbnail generation' } );

	const examples = [];
	const expectedThumbnailFiles = new Set();
	let index = 0;
	for ( const catalogueEntry of campaign.catalogue.records ) {

		index ++;
		if ( index % 25 === 0 ) console.log( `  …${ index }/${ campaign.catalogue.caseCount }` );
		const name = catalogueEntry.name;
		const basename = catalogueEntry.id;
		const row = campaign.rowsByName.get( name );
		const evidenceCase = campaign.caseByName.get( name );
		const metrics = row.artifactMetrics;
		const replayThumbDest = join( THUMBS, `${ basename }.webp` );
		const captureThumbDest = join( THUMBS, `${ basename }.capture.webp` );
		const replayModalDest = join( THUMBS, `${ basename }.modal.webp` );
		const captureModalDest = join( THUMBS, `${ basename }.capture.modal.webp` );
		for ( const destination of [
			replayThumbDest,
			captureThumbDest,
			replayModalDest,
			captureModalDest,
		] ) expectedThumbnailFiles.add( destination.slice( THUMBS.length + 1 ) );
		const [
			replayThumb,
			captureThumb,
			replayModal,
			captureModal,
		] = await Promise.all( [
			resizeBoundShot( evidenceCase.replay.bytes, replayThumbDest, THUMB_W, THUMB_H ),
			resizeBoundShot( evidenceCase.capture.bytes, captureThumbDest, THUMB_W, THUMB_H ),
			resizeBoundShot( evidenceCase.replay.bytes, replayModalDest, MODAL_W, MODAL_H ),
			resizeBoundShot( evidenceCase.capture.bytes, captureModalDest, MODAL_W, MODAL_H ),
		] );
		const thumbHealth = await probeThumbHealth( evidenceCase.replay.bytes );
		const categoryLabel = row.category;
		const stock = stockByName.get( name );
		const record = {
			basename,
			displayName: displayName( basename ),
			category: categoryIdentity( categoryLabel ),
			categoryLabel,
			threejsUrl: catalogueEntry.source.originalUrl ?? null,
			source: catalogueEntry.source,
			thumbReplay: `${ THUMB_URL_PREFIX }/${ basename }.webp`,
			thumbCapture: `${ THUMB_URL_PREFIX }/${ basename }.capture.webp`,
			thumbReplayModal: `${ THUMB_URL_PREFIX }/${ basename }.modal.webp`,
			thumbCaptureModal: `${ THUMB_URL_PREFIX }/${ basename }.capture.modal.webp`,
			smoke: {
				status: stock?.status ?? null,
				gpuValidationCount: stock?.gpuValidationCount ?? null,
			},
			pixel: {
				psnr: row.identical || row.psnr === null ? null : row.psnr,
				identical: row.identical === true,
				threshold: row.effectiveThreshold,
				captured: true,
				replayed: true,
				verdict: row.verdict,
			},
			hasReplay: true,
			hasCapture: true,
			materialCount: metrics.materialCount,
			artifactCount: metrics.artifactCount,
			totalWgslBytes: metrics.totalWgslBytes,
			hasCompute: metrics.hasCompute,
			shapes: metrics.shapes,
			materialShapes: metrics.materialShapes,
			notes: row.note,
			thumbHealth,
				evidence: {
					runId: row.runId,
					campaignId: campaign.coverage.campaignId,
					cohort: row.cohort,
					evidenceRoot: row.evidenceRoot,
					gate: evidenceCase.detail.evidenceGate,
					capture: row.capture,
				replay: row.replay,
				userArtifacts: row.userArtifacts,
				auxArtifacts: row.auxArtifacts,
				artifactMetrics: row.artifactMetrics,
			},
			evidenceHashes: {
				capture: row.capture.sha256,
				replay: row.replay.sha256,
				captureThumb: captureThumb.sha256,
				replayThumb: replayThumb.sha256,
				captureModal: captureModal.sha256,
				replayModal: replayModal.sha256,
			},
			};
			record.quality = qualityFor( record );
			record.badge = badgeFor( record );
		examples.push( record );

	}
	examples.sort( ( left, right ) => compareSortKeys( sortKey( left ), sortKey( right ) ) );
	const ordered = reorderForBreadth( examples );
	const categoryCounts = new Map();
	for ( const record of ordered ) categoryCounts.set( record.category, ( categoryCounts.get( record.category ) ?? 0 ) + 1 );
	const categoryLabels = new Map( ordered.map( ( record ) => [ record.category, record.categoryLabel ] ) );
	const categoryOrder = [ 'lights', 'materials', 'shadows', 'sprites', 'compute', 'camera', 'mrt', 'particles', 'postprocessing', 'misc' ];
	const categories = categoryOrder
		.filter( ( id ) => categoryCounts.has( id ) )
		.map( ( id ) => ( { id, label: categoryLabels.get( id ), count: categoryCounts.get( id ) } ) );
	for ( const id of categoryCounts.keys() ) {

		if ( ! categoryOrder.includes( id ) ) categories.push( { id, label: categoryLabels.get( id ), count: categoryCounts.get( id ) } );

	}

	const visible = ordered.filter( ( record ) => record.thumbHealth === 'ok' );
	const upstreamExamples = ordered.filter( ( record ) => record.source.kind === 'three' );
	const localExamples = ordered.filter( ( record ) => record.source.kind === 'local' );
	const out = {
		schemaVersion: 2,
		generatedAt: new Date().toISOString(),
				provenance: {
					campaignId: campaign.coverage.campaignId,
					coverageSha256: campaign.coverageSource.sha256,
					evidenceSetSha256: campaign.evidenceSetSource.sha256,
					publishedEvidence: {
						summary: {
							file: E2E_COVERAGE_JSON,
							sha256: campaign.coverageSource.sha256,
							campaignId: campaign.coverage.campaignId,
						},
						manifest: {
							file: E2E_EVIDENCE_SET_JSON,
							sha256: campaign.evidenceSetSource.sha256,
							campaignId: campaign.coverage.campaignId,
						},
					},
			stockReportSha256: sha256( stockReportRaw ),
			stockReport: stockReportDescriptor,
			catalogueSha256: sha256( catalogueRaw ),
			generatorSha256: sha256( generatorRaw ),
			evidenceContractSha256: sha256( evidenceContractRaw ),
			imageBufferSha256: sha256( imageBufferRaw ),
			stockHarnessSha256,
			slimBundleSha256: campaign.coverage.slimBundle.sha256,
			harnessSourceFingerprint: campaign.coverage.harness.sourceFingerprint,
				thumbnailGeneration,
			},
			coverageVerdicts: {
				pass: campaign.coverage.totals.pass,
				diagnostic: campaign.coverage.totals.diagnostic,
				fail: campaign.coverage.totals.fail,
			},
		totals: {
			examplesProcessed: ordered.length,
			upstreamExamples: upstreamExamples.length,
			localExamples: localExamples.length,
			upstreamReplayCount: upstreamExamples.filter( ( record ) => record.hasCapture && record.hasReplay ).length,
			localReplayCount: localExamples.filter( ( record ) => record.hasCapture && record.hasReplay ).length,
			examplesVisible: visible.length,
			examplesHidden: ordered.length - visible.length,
			materialsBaked: ordered.reduce( ( total, record ) => total + record.materialCount, 0 ),
			artifactsCaptured: ordered.reduce( ( total, record ) => total + record.artifactCount, 0 ),
			wgslBytes: ordered.reduce( ( total, record ) => total + record.totalWgslBytes, 0 ),
			smokeTotal: stockReport.total,
			smokePass: stockReport.pass,
			smokeFail: stockReport.fail,
			pixelMatchCount: ordered.filter( ( record ) => record.badge === 'pixel-match' ).length,
			visualMatchCount: ordered.filter( ( record ) => record.badge === 'visual-match' ).length,
			rendersCount: ordered.filter( ( record ) => record.badge === 'renders' ).length,
			captureOnlyCount: ordered.filter( ( record ) => record.badge === 'capture-only' ).length,
		},
			categories,
			examples: ordered,
		};
		assertPublishableSitePublicEvidence( out, 'Generated public site evidence' );
		for ( const entry of await readdir( THUMBS, { withFileTypes: true } ) ) {

		if ( expectedThumbnailFiles.has( entry.name ) ) continue;
		removeOutputPath( PUBLIC, resolve( THUMBS, entry.name ), {
			recursive: true,
			label: `Stale generated thumbnail ${ entry.name }`,
		} );

	}
	writeOutputFileAtomic( PUBLIC, OUT_JSON, JSON.stringify( out, null, '\t' ), {
		label: 'Public examples JSON',
	} );
	writeOutputFileAtomic( PUBLIC, OUT_COVERAGE, campaign.coverageSource.bytes, {
		label: 'Public coverage summary',
	} );
	writeOutputFileAtomic( PUBLIC, OUT_MANIFEST, campaign.evidenceSetSource.bytes, {
		label: 'Public campaign manifest',
	} );
	for ( const entry of await readdir( THUMBS_ROOT, { withFileTypes: true } ) ) {

		if (
			! entry.isDirectory() ||
			entry.name === thumbnailGeneration ||
			entry.name === previousThumbnailGeneration
		) continue;
		removeOutputPath( PUBLIC, resolve( THUMBS_ROOT, entry.name ), {
			recursive: true,
			label: `Retired public thumbnail generation ${ entry.name }`,
		} );

	}
	console.log( `[examples-data] wrote ${ OUT_JSON } from campaign ${ out.provenance.campaignId }` );
	console.log(
		`[examples-data] totals: ${ out.totals.examplesProcessed } examples, ${ out.totals.materialsBaked } materials, ` +
		`${ ( out.totals.wgslBytes / 1024 ).toFixed( 1 ) } KB WGSL, ` +
		`official stock observation ${ out.totals.smokePass }/${ out.totals.smokeTotal }, ` +
		`pixel-match ${ out.totals.pixelMatchCount }`,
	);

}

main().catch( ( error ) => {

	console.error( error );
	process.exit( 1 );

} );
