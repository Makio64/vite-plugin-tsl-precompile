#!/usr/bin/env node
/**
 * Local batch-results browser.
 *
 * Shows paired live-three.js capture and slim replay screenshots from
 * results/shots/, then lets you regenerate one example at a time from the UI.
 *
 *   pnpm --filter examples-batch ui
 *   pnpm --filter examples-batch ui -- --port=8787
 *   pnpm --filter examples-batch ui -- --three-repo=/path/to/three.js
 */

import { spawn } from 'node:child_process';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = dirname( fileURLToPath( import.meta.url ) );
const RESULTS = resolve( SELF, 'results' );
const SHOTS = resolve( RESULTS, 'shots' );
const COVERAGE_MD = resolve( RESULTS, 'coverage-summary.md' );
const E2E_REPORT = resolve( RESULTS, 'e2e-report.json' );

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

function shouldSkip( name ) {

	return SKIP_PREFIXES.some( ( prefix ) => name.includes( prefix ) );

}

function validExampleName( value ) {

	const name = String( value || '' ).trim();
	const normalized = name.endsWith( '.html' ) ? name : `${ name }.html`;
	if ( ! /^webgpu_[A-Za-z0-9_.-]+\.html$/.test( normalized ) ) return null;
	return normalized;

}

function safeReadJson( path, fallback ) {

	if ( ! existsSync( path ) ) return fallback;
	try {

		return JSON.parse( readFileSync( path, 'utf8' ) );

	} catch {

		return fallback;

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

function parseCoverageSummary() {

	const rows = new Map();
	if ( ! existsSync( COVERAGE_MD ) ) return rows;

	const tick = String.fromCharCode( 10003 );
	const lines = readFileSync( COVERAGE_MD, 'utf8' ).split( '\n' );
	let category = 'Misc';

	for ( const line of lines ) {

		const heading = line.match( /^## (.+?)\s*\(/ );
		if ( heading ) {

			category = heading[ 1 ];
			continue;

		}

		const row = line.match( /^\| (webgpu_[^ |]+\.html) \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|([^|]*)\|/ );
		if ( ! row ) continue;

		const psnrText = row[ 4 ].trim();
		let psnr = null;
		if ( psnrText === 'inf' ) psnr = Infinity;
		else if ( /^[0-9.]+$/.test( psnrText ) ) psnr = parseFloat( psnrText );

		rows.set( row[ 1 ], {
			name: row[ 1 ],
			category,
			hasCapture: row[ 2 ].includes( tick ),
			hasReplay: row[ 3 ].includes( tick ),
			psnr,
			verdict: row[ 5 ].includes( 'matches' ) ? 'pass' : 'fail',
			note: row[ 6 ].trim(),
		} );

	}

	return rows;

}

function shotPath( name, kind ) {

	return join( SHOTS, `${ name }.${ kind }.png` );

}

function shotInfo( name, kind ) {

	const file = `${ name }.${ kind }.png`;
	const path = join( SHOTS, file );
	if ( ! existsSync( path ) ) return null;
	const stats = statSync( path );
	return {
		url: `/shots/${ encodeURIComponent( file ) }?v=${ Math.round( stats.mtimeMs ) }`,
		mtimeMs: stats.mtimeMs,
		size: stats.size,
	};

}

function listShotNames() {

	const names = new Set();
	if ( ! existsSync( SHOTS ) ) return names;
	for ( const file of readdirSync( SHOTS ) ) {

		const match = file.match( /^(webgpu_.+\.html)\.(capture|replay)\.png$/ );
		if ( match ) names.add( match[ 1 ] );

	}
	return names;

}

function listThreeExampleNames() {

	const names = new Set();
	const examplesDir = join( threeRepo, 'examples' );
	if ( ! existsSync( examplesDir ) ) return names;
	for ( const file of readdirSync( examplesDir ) ) {

		if ( file.startsWith( 'webgpu_' ) && file.endsWith( '.html' ) ) names.add( file );

	}
	return names;

}

function knownExampleNames() {

	return new Set( [
		...listThreeExampleNames(),
		...listShotNames(),
		...parseCoverageSummary().keys(),
		...( safeReadJson( E2E_REPORT, { details: [] } ).details || [] )
			.map( ( detail ) => detail?.name )
			.filter( Boolean ),
	] );

}

function formatPsnr( psnr ) {

	if ( psnr === Infinity ) return 'inf';
	if ( typeof psnr === 'number' && Number.isFinite( psnr ) ) return psnr.toFixed( 2 );
	return null;

}

function buildState() {

	const coverage = parseCoverageSummary();
	const report = safeReadJson( E2E_REPORT, { details: [] } );
	const reportByName = new Map();
	for ( const detail of report.details || [] ) {

		if ( detail && detail.name ) reportByName.set( detail.name, detail );

	}

	const names = new Set( [
		...listThreeExampleNames(),
		...listShotNames(),
		...coverage.keys(),
		...reportByName.keys(),
	] );

	const examples = [ ...names ].sort( ( a, b ) => {

		const ca = coverage.get( a )?.category || categoryOf( a );
		const cb = coverage.get( b )?.category || categoryOf( b );
		const ra = CATEGORY_ORDER.indexOf( ca );
		const rb = CATEGORY_ORDER.indexOf( cb );
		if ( ra !== rb ) return ( ra === - 1 ? 99 : ra ) - ( rb === - 1 ? 99 : rb );
		return a.localeCompare( b );

	} ).map( ( name ) => {

		const cov = coverage.get( name );
		const rep = reportByName.get( name );
		const capture = shotInfo( name, 'capture' );
		const replay = shotInfo( name, 'replay' );
		const hasCapture = !! capture;
		const hasReplay = !! replay;
		const psnr = cov?.psnr ??
			( rep?.pixelGate?.psnr === 'inf' ? Infinity : typeof rep?.pixelGate?.psnr === 'number' ? rep.pixelGate.psnr : null );
		let status = cov?.verdict || null;
		if ( ! status && rep?.status ) status = rep.status === 'pass' ? 'pass' : 'fail';
		if ( ! status ) status = hasCapture || hasReplay ? 'unknown' : 'missing';

		return {
			name,
			basename: name.replace( /\.html$/, '' ),
			category: cov?.category || categoryOf( name ),
			status,
			skipped: shouldSkip( name ),
			hasCapture,
			hasReplay,
			capture,
			replay,
			psnr: formatPsnr( psnr ),
			psnrValue: psnr === Infinity ? 1e9 : typeof psnr === 'number' ? psnr : null,
			note: cov?.note || rep?.error || '',
			captureErrors: Array.isArray( rep?.captureErrors ) ? rep.captureErrors.length : null,
			replayErrors: Array.isArray( rep?.replayErrors ) ? rep.replayErrors.length : null,
			userArtifacts: rep?.userArtifacts ?? null,
			auxArtifacts: rep?.auxArtifacts ?? null,
			updatedAt: Math.max( capture?.mtimeMs || 0, replay?.mtimeMs || 0 ) || null,
			threejsUrl: `https://threejs.org/examples/?q=tsl#${ name.replace( /\.html$/, '' ) }`,
		};

	} );

	const totals = {
		total: examples.length,
		pass: examples.filter( ( example ) => example.status === 'pass' ).length,
		fail: examples.filter( ( example ) => example.status === 'fail' ).length,
		missingReplay: examples.filter( ( example ) => ! example.hasReplay ).length,
		missingCapture: examples.filter( ( example ) => ! example.hasCapture ).length,
	};

	return {
		generatedAt: new Date().toISOString(),
		paths: {
			results: RESULTS,
			shots: SHOTS,
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

	const normalized = validExampleName( name );
	if ( ! normalized ) {

		const err = new Error( 'Invalid example name' );
		err.statusCode = 400;
		throw err;

	}

	if ( ! knownExampleNames().has( normalized ) ) {

		const err = new Error( `Unknown example: ${ normalized }` );
		err.statusCode = 404;
		throw err;

	}

	const runMode = mode === 'replay' || mode === 'reuse-reference' ? mode : 'full';
	const runnerArgs = [
		resolve( SELF, 'run-e2e-with-coverage.mjs' ),
		`--filter=${ normalized }`,
		`--three-repo=${ threeRepo }`,
	];

	if ( runMode === 'replay' ) runnerArgs.push( '--replay-only' );
	if ( runMode === 'reuse-reference' ) runnerArgs.push( '--reuse-reference-shot' );

	const run = {
		id: ++ runSeq,
		name: normalized,
		mode: runMode,
		active: true,
		exitCode: null,
		startedAt: new Date().toISOString(),
		finishedAt: null,
		lines: [],
		child: null,
	};
	currentRun = run;

	addRunLine( run, `[ui] node ${ runnerArgs.map( ( part ) => part.includes( ' ' ) ? JSON.stringify( part ) : part ).join( ' ' ) }` );

	const child = spawn( process.execPath, runnerArgs, {
		cwd: SELF,
		env: { ...process.env, NO_COLOR: '1' },
		stdio: [ 'ignore', 'pipe', 'pipe' ],
		detached: process.platform !== 'win32',
	} );
	run.child = child;
	attachLines( child.stdout, run );
	attachLines( child.stderr, run );

	child.on( 'error', ( err ) => {

		addRunLine( run, `[ui] failed to start: ${ err.message }` );

	} );

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

function serveShot( res, pathname ) {

	const file = decodeURIComponent( pathname.slice( '/shots/'.length ) );
	if ( ! /^[A-Za-z0-9_.-]+\.png$/.test( file ) ) {

		sendText( res, 'Invalid shot path', 400 );
		return;

	}

	const filePath = resolve( SHOTS, file );
	const rel = relative( SHOTS, filePath );
	if ( rel.startsWith( '..' ) || rel.includes( `${ sep }..${ sep }` ) || ! existsSync( filePath ) ) {

		sendText( res, 'Not found', 404 );
		return;

	}

	res.writeHead( 200, {
		'content-type': 'image/png',
		'cache-control': 'public, max-age=60',
	} );
	createReadStream( filePath ).pipe( res );

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

		if ( req.method === 'GET' && url.pathname.startsWith( '/shots/' ) ) {

			serveShot( res, url.pathname );
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
				metric( 'examples', totals.total ),
				metric( 'pass', totals.pass ),
				metric( 'fail', totals.fail ),
				metric( 'no replay', totals.missingReplay ),
				metric( 'no capture', totals.missingCapture ),
			].join( '' );
		}

		function renderSubtitle() {
			const paths = state.data.paths;
			const suffix = paths.hasThreeRepo ? paths.threeRepo : 'three.js checkout not found; showing saved results';
			$( '#subtitle' ).textContent = 'Screenshots: ' + paths.shots + ' | three.js: ' + suffix;
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
			if ( example.status === 'pass' ) return 'pass';
			if ( example.status === 'fail' ) return 'fail';
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
			const psnr = example.psnr ? example.psnr + ' dB' : 'PSNR n/a';
			const artifacts = example.userArtifacts == null ? '' : '<span>' + escapeHtml( example.userArtifacts + '+' + example.auxArtifacts + ' artifacts' ) + '</span>';
			const errors = example.captureErrors || example.replayErrors
				? '<span>' + escapeHtml( ( example.captureErrors || 0 ) + ' capture errors, ' + ( example.replayErrors || 0 ) + ' replay errors' ) + '</span>'
				: '';
			const note = example.note ? '<span title="' + escapeHtml( example.note ) + '">' + escapeHtml( example.note ) + '</span>' : '';
			return '<article class="card' + ( active ? ' is-active' : '' ) + '" data-name="' + escapeHtml( example.name ) + '">'
				+ '<div class="card-head">'
				+ '<div><div class="name">' + escapeHtml( example.name ) + '</div><div class="meta"><span>' + escapeHtml( example.category ) + '</span><span>' + escapeHtml( psnr ) + '</span>' + artifacts + errors + note + '</div></div>'
				+ '<span class="badge ' + escapeHtml( example.status ) + '">' + escapeHtml( statusText( example ) ) + '</span>'
				+ '</div>'
				+ '<div class="compare">' + renderImage( example, 'capture' ) + renderImage( example, 'replay' ) + '</div>'
				+ '<div class="actions">'
				+ '<div class="actions-left">'
				+ '<button class="primary" type="button" data-run="full" data-name="' + escapeHtml( example.name ) + '"' + disabled + '>Regenerate</button>'
				+ '<button type="button" data-run="replay" data-name="' + escapeHtml( example.name ) + '"' + disabled + '>Replay only</button>'
				+ '<button type="button" data-run="reuse-reference" data-name="' + escapeHtml( example.name ) + '"' + disabled + '>Reuse capture</button>'
				+ '</div>'
				+ '<div class="actions-right"><a class="link" href="' + escapeHtml( example.threejsUrl ) + '" target="_blank" rel="noopener">three.js</a></div>'
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
			$( '#run-title' ).textContent = run.name + ' | ' + run.mode + ' | ' + stateText;
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

const server = createServer( ( req, res ) => {

	handleRequest( req, res ).catch( ( err ) => sendJson( res, { error: err.message }, 500 ) );

} );

server.listen( port, host, () => {

	const url = `http://${ host }:${ port }`;
	console.log( `[examples-ui] ${ url }` );
	console.log( `[examples-ui] results: ${ RESULTS }` );
	console.log( `[examples-ui] three.js: ${ threeRepo }` );
	console.log( '[examples-ui] press Ctrl+C to stop' );

} );
