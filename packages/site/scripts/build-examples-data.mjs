#!/usr/bin/env node
// Generate /public/examples.json + /public/examples/thumbs/*.webp from the
// batch harness output. Run manually after each batch sweep:
//   pnpm --filter @tsl-precompile/site data
// CI does not run this — outputs are committed.

import { readdir, readFile, stat, mkdir, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname( fileURLToPath( import.meta.url ) );
const SITE_ROOT = resolve( __dirname, '..' );
const REPO_ROOT = resolve( SITE_ROOT, '..', '..' );
const RESULTS = resolve( REPO_ROOT, 'packages/examples/batch/results' );
const SHOTS = resolve( RESULTS, 'shots' );
const ARTIFACTS = resolve( RESULTS, 'artifacts' );
const COVERAGE_MD = resolve( RESULTS, 'coverage-summary.md' );
const REPORT_JSON = resolve( RESULTS, 'report.json' );

const PUBLIC = resolve( SITE_ROOT, 'public' );
const THUMBS = resolve( PUBLIC, 'examples/thumbs' );
const OUT_JSON = resolve( PUBLIC, 'examples.json' );

const THUMB_W = 320;
const THUMB_H = 240;
const MODAL_W = 640;
const MODAL_H = 480;
const WEBP_Q = 78;

// ---------- coverage-summary.md parser ----------

function parseCoverage( md ) {
	const lines = md.split( '\n' );
	const sections = []; // [{ id, label, rows: [{ basename, capture, replay, psnr, verdict, note }] }]
	let current = null;

	const sectionMap = {
		'Lights': 'lights',
		'Materials': 'materials',
		'Shadows': 'shadows',
		'Sprites': 'sprites',
		'Compute': 'compute',
		'Camera': 'camera',
		'MRT / RenderTargets': 'mrt',
		'Particles': 'particles',
		'Postprocessing': 'postprocessing',
		'Misc': 'misc',
	};

	for ( const raw of lines ) {
		const h = raw.match( /^## (.+?)\s*\(/ );
		if ( h ) {
			const label = h[ 1 ];
			const id = sectionMap[ label ] ?? label.toLowerCase().replace( /\W+/g, '-' );
			current = { id, label, rows: [] };
			sections.push( current );
			continue;
		}
		if ( ! current ) continue;
		const m = raw.match( /^\| (webgpu_[^ |]+\.html) \| (.+?) \| (.+?) \| (.+?) \| (.+?) \|(.*)\|/ );
		if ( ! m ) continue;
		const basename = m[ 1 ].replace( /\.html$/, '' );
		const capture = m[ 2 ].trim() === '✓';
		const replay = m[ 3 ].trim() === '✓';
		const psnrText = m[ 4 ].trim();
		let psnr = null;
		if ( psnrText === 'inf' ) psnr = Infinity;
		else if ( /^[\d.]+$/.test( psnrText ) ) psnr = parseFloat( psnrText );
		const verdict = m[ 5 ].includes( 'matches' ) ? 'matches' : 'regression';
		const note = m[ 6 ].trim();
		current.rows.push( { basename, capture, replay, psnr, verdict, note } );
	}
	return sections;
}

// ---------- aux.json enrichment ----------

async function readAux( basename ) {
	const path = join( ARTIFACTS, `${basename}.html.aux.json` );
	if ( ! existsSync( path ) ) return null;
	try {
		const raw = await readFile( path, 'utf8' );
		const arr = JSON.parse( raw );
		let materialCount = 0;
		let totalWgslBytes = 0;
		let hasCompute = false;
		const shapes = new Set();
		const matShapes = new Set();
		for ( const item of arr ) {
			const a = item.artifact ?? {};
			const v = a.vertexShader ?? '';
			const f = a.fragmentShader ?? '';
			const c = a.computeShader ?? '';
			if ( v || f || c ) {
				materialCount += 1;
				totalWgslBytes += v.length + f.length + c.length;
			}
			if ( c ) hasCompute = true;
			if ( item.shape ) shapes.add( item.shape );
			if ( a.materialShape ) matShapes.add( a.materialShape );
		}
		return {
			artifactCount: arr.length,
			materialCount,
			totalWgslBytes,
			hasCompute,
			shapes: [ ...shapes ],
			materialShapes: [ ...matShapes ],
		};
	} catch ( err ) {
		console.warn( `[examples-data] aux read failed for ${basename}:`, err.message );
		return null;
	}
}

// ---------- thumbnails ----------

async function maybeResize( srcPath, destPath, w, h ) {
	if ( ! existsSync( srcPath ) ) return false;
	if ( existsSync( destPath ) ) {
		const [ s, d ] = await Promise.all( [ stat( srcPath ), stat( destPath ) ] );
		if ( d.mtimeMs >= s.mtimeMs ) return true;
	}
	await mkdir( dirname( destPath ), { recursive: true } );
	await sharp( srcPath )
		.resize( { width: w, height: h, fit: 'cover', position: 'attention' } )
		.webp( { quality: WEBP_Q } )
		.toFile( destPath );
	return true;
}

async function probeThumbHealth( srcPath ) {
	if ( ! existsSync( srcPath ) ) return 'missing';
	try {
		const s = await stat( srcPath );
		if ( s.size < 2048 ) return 'blank';
		// Variance test: a truly blank/uniform thumbnail has near-zero stdev across
		// all RGB channels. Dark demos still have detail and pass this easily.
		const stats = await sharp( srcPath ).stats();
		const maxStdev = Math.max( ...stats.channels.slice( 0, 3 ).map( c => c.stdev ) );
		if ( maxStdev < 2 ) return 'blank';
		return 'ok';
	} catch {
		return 'blank';
	}
}

// ---------- per-record assembly ----------

function badgeFor( record ) {
	const { pixel, hasReplay } = record;
	if ( ! hasReplay ) return 'capture-only';
	if ( pixel.identical ) return 'pixel-match';
	if ( pixel.psnr == null ) return 'renders';
	if ( pixel.psnr >= 30 ) return 'pixel-match';
	if ( pixel.psnr >= 20 ) return 'visual-match';
	return 'renders';
}

function displayName( basename ) {
	// "webgpu_lights_rectarealight" → "lights · rectarealight"
	const withoutPrefix = basename.replace( /^webgpu_/, '' );
	const parts = withoutPrefix.split( '_' );
	if ( parts.length === 1 ) return parts[ 0 ];
	return parts[ 0 ] + ' · ' + parts.slice( 1 ).join( ' ' );
}

function threejsUrlFor( basename ) {
	return `https://threejs.org/examples/?q=tsl#${basename}`;
}

// "most-impressive first" sort — see plan.
function sortKey( record ) {
	const tier = { 'pixel-match': 0, 'visual-match': 1, 'renders': 2, 'capture-only': 3 }[ record.badge ] ?? 4;
	const effectivePsnr = record.pixel.identical ? 1e6 : ( record.pixel.psnr ?? 0 );
	return [ tier, -effectivePsnr, record.basename ];
}

function compareSortKeys( a, b ) {
	for ( let i = 0; i < a.length; i += 1 ) {
		if ( a[ i ] < b[ i ] ) return - 1;
		if ( a[ i ] > b[ i ] ) return 1;
	}
	return 0;
}

// Apply category-breadth pass on the pixel-match prefix only.
function reorderForBreadth( records ) {
	const greens = records.filter( r => r.badge === 'pixel-match' );
	const rest = records.filter( r => r.badge !== 'pixel-match' );
	// One per category before doubling up.
	const buckets = new Map();
	for ( const r of greens ) {
		if ( ! buckets.has( r.category ) ) buckets.set( r.category, [] );
		buckets.get( r.category ).push( r );
	}
	const effPsnr = r => r.pixel.identical ? 1e6 : ( r.pixel.psnr ?? 0 );
	for ( const arr of buckets.values() ) arr.sort( ( a, b ) => effPsnr( b ) - effPsnr( a ) );
	const breadth = [];
	while ( buckets.size ) {
		for ( const [ cat, arr ] of [ ...buckets.entries() ] ) {
			breadth.push( arr.shift() );
			if ( ! arr.length ) buckets.delete( cat );
		}
	}
	return [ ...breadth, ...rest ];
}

// ---------- main ----------

async function main() {
	console.log( '[examples-data] reading inputs…' );

	const [ md, reportRaw ] = await Promise.all( [
		readFile( COVERAGE_MD, 'utf8' ),
		readFile( REPORT_JSON, 'utf8' ),
	] );
	const sections = parseCoverage( md );
	const report = JSON.parse( reportRaw );

	// Universe is replay PNGs on disk.
	const shotFiles = await readdir( SHOTS );
	const replayBasenames = shotFiles
		.filter( f => f.endsWith( '.replay.png' ) )
		.map( f => f.replace( /\.html\.replay\.png$/, '' ) );
	const replaySet = new Set( replayBasenames );

	// Coverage rows include some examples without a replay (no-replay note).
	// Universe is union of (any row in coverage) ∪ (any replay PNG) — captureBasenames may also exist.
	const captureSet = new Set(
		shotFiles
			.filter( f => f.endsWith( '.capture.png' ) )
			.map( f => f.replace( /\.html\.capture\.png$/, '' ) )
	);

	const universe = new Set();
	for ( const sec of sections ) for ( const row of sec.rows ) universe.add( row.basename );
	for ( const b of replaySet ) universe.add( b );
	for ( const b of captureSet ) universe.add( b );

	console.log( `[examples-data] universe: ${universe.size} examples` );

	const rowByBasename = new Map();
	const categoryByBasename = new Map();
	for ( const sec of sections ) {
		for ( const row of sec.rows ) {
			rowByBasename.set( row.basename, row );
			categoryByBasename.set( row.basename, { id: sec.id, label: sec.label } );
		}
	}

	const reportByName = new Map();
	for ( const d of report.details ?? [] ) reportByName.set( d.name.replace( /\.html$/, '' ), d );

	await mkdir( THUMBS, { recursive: true } );

	const examples = [];
	let i = 0;
	for ( const basename of universe ) {
		i += 1;
		if ( i % 25 === 0 ) console.log( `  …${i}/${universe.size}` );

		const cov = rowByBasename.get( basename );
		const cat = categoryByBasename.get( basename ) ?? { id: 'misc', label: 'Misc' };
		const rep = reportByName.get( basename );
		const aux = await readAux( basename );

		const replaySrc = join( SHOTS, `${basename}.html.replay.png` );
		const captureSrc = join( SHOTS, `${basename}.html.capture.png` );
		const replayThumbDest = join( THUMBS, `${basename}.webp` );
		const captureThumbDest = join( THUMBS, `${basename}.capture.webp` );
		const replayModalDest = join( THUMBS, `${basename}.modal.webp` );
		const captureModalDest = join( THUMBS, `${basename}.capture.modal.webp` );

		const hasReplay = existsSync( replaySrc );
		const hasCapture = existsSync( captureSrc );

		await Promise.all( [
			hasReplay && maybeResize( replaySrc, replayThumbDest, THUMB_W, THUMB_H ),
			hasCapture && maybeResize( captureSrc, captureThumbDest, THUMB_W, THUMB_H ),
			hasReplay && maybeResize( replaySrc, replayModalDest, MODAL_W, MODAL_H ),
			hasCapture && maybeResize( captureSrc, captureModalDest, MODAL_W, MODAL_H ),
		].filter( Boolean ) );

		const thumbHealth = hasReplay ? await probeThumbHealth( replaySrc ) : 'missing';

		const psnrRaw = cov?.psnr ?? null;
		const psnrIdentical = psnrRaw === Infinity;
		const record = {
			basename,
			displayName: displayName( basename ),
			category: cat.id,
			categoryLabel: cat.label,
			threejsUrl: threejsUrlFor( basename ),
			thumbReplay: hasReplay ? `examples/thumbs/${basename}.webp` : null,
			thumbCapture: hasCapture ? `examples/thumbs/${basename}.capture.webp` : null,
			thumbReplayModal: hasReplay ? `examples/thumbs/${basename}.modal.webp` : null,
			thumbCaptureModal: hasCapture ? `examples/thumbs/${basename}.capture.modal.webp` : null,
			smoke: {
				status: rep?.status ?? null,
				gpuValidationCount: rep?.gpuValidationCount ?? null,
			},
			pixel: {
				psnr: psnrIdentical || psnrRaw == null ? null : psnrRaw,
				identical: psnrIdentical,
				threshold: 30,
				captured: cov?.capture ?? hasCapture,
				replayed: cov?.replay ?? hasReplay,
			},
			hasReplay,
			hasCapture,
			materialCount: aux?.materialCount ?? null,
			artifactCount: aux?.artifactCount ?? null,
			totalWgslBytes: aux?.totalWgslBytes ?? null,
			hasCompute: aux?.hasCompute ?? ( cat.id === 'compute' ),
			shapes: aux?.shapes ?? null,
			materialShapes: aux?.materialShapes ?? null,
			notes: cov?.note ?? '',
			thumbHealth,
		};
		record.badge = badgeFor( record );
		examples.push( record );
	}

	// Sort: most-impressive first (tier → -psnr → name), then breadth-promote pixel-matches.
	examples.sort( ( a, b ) => compareSortKeys( sortKey( a ), sortKey( b ) ) );
	const ordered = reorderForBreadth( examples );

	// Build categories list (only those that have any visible records).
	const categoryCounts = new Map();
	for ( const r of ordered ) {
		categoryCounts.set( r.category, ( categoryCounts.get( r.category ) ?? 0 ) + 1 );
	}
	const categoryLabels = new Map( ordered.map( r => [ r.category, r.categoryLabel ] ) );
	const CATEGORY_ORDER = [ 'lights', 'materials', 'shadows', 'sprites', 'compute', 'camera', 'mrt', 'particles', 'postprocessing', 'misc' ];
	const categories = CATEGORY_ORDER
		.filter( id => categoryCounts.has( id ) )
		.map( id => ( { id, label: categoryLabels.get( id ), count: categoryCounts.get( id ) } ) );
	for ( const id of categoryCounts.keys() ) {
		if ( ! CATEGORY_ORDER.includes( id ) ) {
			categories.push( { id, label: categoryLabels.get( id ), count: categoryCounts.get( id ) } );
		}
	}

	// Totals for the hero strip — every number reproducible from the records below.
	const visible = ordered.filter( r => r.thumbHealth === 'ok' );
	const totalArtifacts = ordered.reduce( ( a, r ) => a + ( r.artifactCount ?? 0 ), 0 );
	const totalMaterials = ordered.reduce( ( a, r ) => a + ( r.materialCount ?? 0 ), 0 );
	const totalWgsl = ordered.reduce( ( a, r ) => a + ( r.totalWgslBytes ?? 0 ), 0 );
	const pixelMatchCount = ordered.filter( r => r.badge === 'pixel-match' ).length;
	const visualMatchCount = ordered.filter( r => r.badge === 'visual-match' ).length;
	const rendersCount = ordered.filter( r => r.badge === 'renders' ).length;
	const captureOnlyCount = ordered.filter( r => r.badge === 'capture-only' ).length;
	const blankCount = ordered.length - visible.length;

	const out = {
		generatedAt: new Date().toISOString(),
		totals: {
			examplesProcessed: ordered.length,
			examplesVisible: visible.length,
			examplesHidden: blankCount,
			materialsBaked: totalMaterials,
			artifactsCaptured: totalArtifacts,
			wgslBytes: totalWgsl,
			runtimeNodeBuilderCalls: 0,
			smokeTotal: report.total ?? null,
			smokePass: report.pass ?? null,
			smokePassRate: report.total ? Math.round( ( report.pass / report.total ) * 1000 ) / 10 : null,
			pixelMatchCount,
			visualMatchCount,
			rendersCount,
			captureOnlyCount,
		},
		categories,
		examples: ordered,
	};

	const tmp = OUT_JSON + '.tmp';
	await writeFile( tmp, JSON.stringify( out, null, '\t' ) );
	await rename( tmp, OUT_JSON );
	console.log( `[examples-data] wrote ${OUT_JSON}` );
	console.log( `[examples-data] totals: ${out.totals.examplesProcessed} examples, ${out.totals.materialsBaked} materials, ${( out.totals.wgslBytes / 1024 ).toFixed( 1 )} KB WGSL, smoke ${out.totals.smokePassRate}%, pixel-match ${pixelMatchCount}` );
}

main().catch( err => {
	console.error( err );
	process.exit( 1 );
} );
