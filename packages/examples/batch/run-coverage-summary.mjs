#!/usr/bin/env node
/**
 * Score every paired capture/replay PNG in `results/shots/` and emit a
 * categorized markdown summary. Answers the question: "for which three.js
 * webgpu_* examples does the slim runtime produce the same pixels as live
 * three.js right now?"
 *
 * For each `<name>.capture.png` + `<name>.replay.png` pair found on disk:
 *   - Decode both PNGs and compute PSNR through the shared psnr.mjs helper.
 *     Default verdict threshold is 30 dB to match run-e2e.mjs's existing
 *     pixel gate.
 *   - Capture-only entries (no replay file) are flagged as "no replay".
 *   - Dimension mismatches between capture and replay are flagged as well.
 *
 * Existing e2e-report.json `pixelGate.psnr` values are merged in for any
 * example that doesn't have a paired PNG on disk, so the table doesn't
 * lose information when shots get pruned.
 *
 * Output: results/coverage-summary.md (overwritten each run).
 *
 *   node packages/examples/batch/run-coverage-summary.mjs
 *   node packages/examples/batch/run-coverage-summary.mjs --threshold=25
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import { comparePngFiles, pixelGateDisabledReasonForExample, psnrThresholdForExample } from './psnr.mjs';

const SELF = dirname( fileURLToPath( import.meta.url ) );
const SHOTS = resolve( SELF, 'results/shots' );
const E2E_REPORT = resolve( SELF, 'results/e2e-report.json' );
const OUT = resolve( SELF, 'results/coverage-summary.md' );

const args = process.argv.slice( 2 );
function getArg( prefix, def ) {

	const a = args.find( ( x ) => x.startsWith( prefix ) );
	return a ? a.slice( prefix.length ) : def;

}

const threshold = parseFloat( getArg( '--threshold=', '30' ) );
const reportArgs = args
	.filter( ( x ) => x.startsWith( '--report=' ) )
	.map( ( x ) => x.slice( '--report='.length ) )
	.filter( Boolean );

if ( ! existsSync( SHOTS ) ) {

	console.error( `[coverage-summary] shots directory not found: ${ SHOTS }` );
	process.exit( 2 );

}

const files = readdirSync( SHOTS );
const captures = new Map();
const replays = new Map();
for ( const f of files ) {

	const cap = f.match( /^(.+)\.capture\.png$/ );
	const rep = f.match( /^(.+)\.replay\.png$/ );
	if ( cap ) captures.set( cap[ 1 ], join( SHOTS, f ) );
	if ( rep ) replays.set( rep[ 1 ], join( SHOTS, f ) );

}

const allNames = new Set( [ ...captures.keys(), ...replays.keys() ] );

function comparePSNR( capPath, repPath ) {

	const name = capPath.split( '/' ).pop().replace( /\.capture\.png$/, '' );
	const result = comparePngFiles( capPath, repPath, { name, round: false } );
	return {
		...result,
		psnr: result.psnr === 'inf' ? Infinity : result.psnr,
	};

}

function resolveReportPath( value ) {

	if ( ! value ) return null;
	if ( isAbsolute( value ) ) return value;
	return resolve( SELF, 'results', value );

}

const reportPaths = [ E2E_REPORT, ...reportArgs.map( resolveReportPath ) ].filter( Boolean );
const e2eByName = new Map();
for ( const reportPath of reportPaths ) {

	if ( ! existsSync( reportPath ) ) continue;

	const r = JSON.parse( readFileSync( reportPath, 'utf8' ) );
	for ( const d of r.details || [] ) {

		if ( d.pixelGate ) e2eByName.set( d.name, {
			gate: d.pixelGate,
			source: reportPath === E2E_REPORT ? 'e2e-report.json' : reportPath.split( '/' ).pop()
		} );

	}

}

function classifyPixelGate( name, psnr, gate = null ) {

	const effectiveThreshold = psnrThresholdForExample( name, threshold );
	const disabledReason = gate && gate.disabled
		? ( pixelGateDisabledReasonForExample( name ) || 'disabled' )
		: pixelGateDisabledReasonForExample( name );

	if ( psnr === Infinity ) return { verdict: 'pass', note: '' };
	if ( typeof psnr !== 'number' ) return { verdict: 'fail', note: '' };
	if ( psnr >= effectiveThreshold ) return { verdict: 'pass', note: '' };
	if ( disabledReason ) return { verdict: 'diagnostic', note: `pixel gate disabled: ${ disabledReason }` };
	return { verdict: 'fail', note: '' };

}

function rowFromReportEntry( name, reportEntry ) {

	const gate = reportEntry.gate;
	let psnr = null;
	let verdict = 'fail';
	let note = '';
	if ( gate.skipped ) {

		note = `e2e-report: skipped — ${ gate.reason }`;

	} else if ( gate.psnr === 'inf' ) {

		psnr = Infinity;
		verdict = 'pass';
		note = `${ reportEntry.source } only`;

	} else if ( typeof gate.psnr === 'number' ) {

		psnr = gate.psnr;
		const classified = classifyPixelGate( name, psnr, gate );
		verdict = classified.verdict;
		note = classified.note || `${ reportEntry.source } only`;

	}
	return { psnr, verdict, note };

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

const rows = [];
for ( const name of allNames ) {

	const hasCapture = captures.has( name );
	const hasReplay = replays.has( name );
	let psnr = null;
	let verdict = '';
	let note = '';

	if ( hasCapture && hasReplay ) {

		const r = comparePSNR( captures.get( name ), replays.get( name ) );
		if ( r.error ) {

			verdict = 'fail';
			note = r.error;

		} else {

			psnr = r.psnr;
			const classified = classifyPixelGate( name, psnr );
			verdict = classified.verdict;
			note = classified.note;

		}

	} else if ( hasCapture && ! hasReplay ) {

		const reportEntry = e2eByName.get( name );
		if ( reportEntry ) {
			( { psnr, verdict, note } = rowFromReportEntry( name, reportEntry ) );
		} else {
			verdict = 'fail';
			note = 'no replay (slim runtime did not produce a frame)';
		}

	} else if ( ! hasCapture && hasReplay ) {

		const reportEntry = e2eByName.get( name );
		if ( reportEntry ) {
			( { psnr, verdict, note } = rowFromReportEntry( name, reportEntry ) );
		} else {
			verdict = 'fail';
			note = 'no capture (live three.js did not produce a frame)';
		}

	}

	rows.push( { name, hasCapture, hasReplay, psnr, verdict, note } );

}

// Merge in e2e-report entries for examples not on disk so nothing is lost
// if shots get pruned. These entries are tagged so the reader can tell.
for ( const [ name, reportEntry ] of e2eByName ) {

	if ( allNames.has( name ) ) continue;
	const { psnr, verdict, note } = rowFromReportEntry( name, reportEntry );

	rows.push( { name, hasCapture: false, hasReplay: false, psnr, verdict, note } );

}

rows.sort( ( a, b ) => a.name.localeCompare( b.name ) );

const byCategory = new Map();
for ( const row of rows ) {

	const cat = categoryOf( row.name );
	if ( ! byCategory.has( cat ) ) byCategory.set( cat, [] );
	byCategory.get( cat ).push( row );

}

const totalRows = rows.length;
const passRows = rows.filter( ( r ) => r.verdict === 'pass' ).length;
const diagnosticRows = rows.filter( ( r ) => r.verdict === 'diagnostic' ).length;
const failRows = rows.filter( ( r ) => r.verdict === 'fail' ).length;
const pct = totalRows === 0 ? 0 : Math.round( ( passRows / totalRows ) * 100 );

function fmtPSNR( psnr ) {

	if ( psnr === null ) return '—';
	if ( psnr === Infinity ) return 'inf';
	return psnr.toFixed( 2 );

}

function tick( on ) {

	return on ? '✓' : '✗';

}

function verdictTag( v ) {

	if ( v === 'pass' ) return '✅ matches';
	if ( v === 'diagnostic' ) return '⚠ diagnostic';
	return '❌ regression';

}

const lines = [];
lines.push( `# Feature coverage — capture vs replay` );
lines.push( '' );
lines.push( `Generated by \`packages/examples/batch/run-coverage-summary.mjs\`. Threshold: PSNR ≥ ${ threshold } dB.` );
lines.push( '' );
lines.push( `**${ passRows } / ${ totalRows } graded examples match (${ pct }%).** ${ diagnosticRows } diagnostics, ${ failRows } regressions.` );
lines.push( '' );
lines.push( `An example **matches** if the slim-runtime replay screenshot is within ${ threshold } dB PSNR of live three.js. **Diagnostic** rows are configured pixel-gate exclusions, so they are tracked but not counted as regressions. "no replay" means the slim runtime failed to produce any frame for that example. "no capture" means live three.js failed.` );
lines.push( '' );

const categoryOrder = [ 'Lights', 'Materials', 'Shadows', 'Sprites', 'Compute', 'Camera', 'MRT / RenderTargets', 'Particles', 'Postprocessing', 'Misc' ];
const seen = new Set();
const ordered = [];
for ( const c of categoryOrder ) {

	if ( byCategory.has( c ) ) {

		ordered.push( c );
		seen.add( c );

	}

}
for ( const c of byCategory.keys() ) {

	if ( ! seen.has( c ) ) ordered.push( c );

}

for ( const cat of ordered ) {

	const items = byCategory.get( cat );
	const catPass = items.filter( ( r ) => r.verdict === 'pass' ).length;
	const catDiagnostic = items.filter( ( r ) => r.verdict === 'diagnostic' ).length;
	const suffix = catDiagnostic > 0 ? `, ${ catDiagnostic } diagnostic` : '';
	lines.push( `## ${ cat } (${ catPass } / ${ items.length } match${ suffix })` );
	lines.push( '' );
	lines.push( '| Example | Capture | Replay | PSNR (dB) | Verdict | Note |' );
	lines.push( '|---|---|---|---|---|---|' );
	for ( const r of items ) {

		lines.push( `| ${ r.name } | ${ tick( r.hasCapture ) } | ${ tick( r.hasReplay ) } | ${ fmtPSNR( r.psnr ) } | ${ verdictTag( r.verdict ) } | ${ r.note } |` );

	}

	lines.push( '' );

}

writeFileSync( OUT, lines.join( '\n' ) );
console.log( `[coverage-summary] wrote ${ OUT }` );
console.log( `[coverage-summary] ${ passRows } / ${ totalRows } match at PSNR >= ${ threshold } dB (${ pct }%); ${ diagnosticRows } diagnostic; ${ failRows } regression` );
