import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { totalmem } from 'node:os';

import { assertThreeAtLeast184 } from './_three-version.mjs';

const SELF = dirname( fileURLToPath( import.meta.url ) );
const OUT  = resolve( SELF, 'results' );

const args = process.argv.slice( 2 );

function getArg( prefix, def ) {
	const found = args.find( a => a.startsWith( prefix ) );
	return found ? found.slice( prefix.length ) : def;
}

function parseIntAtLeast( value, fallback, min ) {
	const n = parseInt( value, 10 );
	return Number.isFinite( n ) && n >= min ? n : fallback;
}

// ─── Why this is a batched worker pool, not one long-lived worker per chunk ───
//
// The e2e harness drives Chromium + WebGPU. Even with browser.close() between
// examples, neither Chromium's GPU helper process nor the worker's Node heap
// reliably return all memory to the OS — on Apple Silicon's unified memory the
// GPU pressure plus the climbing RSS eventually freezes the whole machine
// (users hit it around the 150-example mark). The only thing that *guarantees*
// the OS reclaims everything — Node heap, the entire Chromium process tree,
// GPU buffers, file descriptors — is the worker process exiting. So instead of
// 2 workers each chewing through ~100 examples, we run a fixed pool of slots
// and feed each slot a small batch (~12 examples); the worker handles its
// batch, writes its partial report, and exits, and the slot immediately spawns
// a fresh worker for the next batch. Peak resident set is bounded by one
// batch's worth of work, no matter how long the full run is.
//
// Each slot = its own Chromium + WebGPU + Node heap. Default to one slot on
// ordinary developer machines; allow two only when there is enough RAM to keep
// Chrome's GPU process, Node, the editor, and the OS out of unified-memory
// pressure. Override with --workers=N when speed matters more than stability.
const DEFAULT_WORKERS = totalmem() >= 24 * 1024 ** 3 ? 2 : 1;
const workers   = parseIntAtLeast( getArg( '--workers=', process.env.TSLP_E2E_WORKERS || String( DEFAULT_WORKERS ) ), DEFAULT_WORKERS, 1 );
const basePort  = parseIntAtLeast( getArg( '--base-port=', '8730' ), 8730, 1 );
const filter    = getArg( '--filter=', '' );
const limit     = parseIntAtLeast( getArg( '--limit=', '9999' ), 9999, 0 );
const offset    = parseIntAtLeast( getArg( '--offset=', '0' ), 0, 0 );
const threeRepo = resolve( getArg( '--three-repo=', resolve( SELF, '../../../../three.js' ) ) );
const verbose   = args.includes( '--verbose' ) || process.env.TSLP_E2E_VERBOSE === '1';

// Examples per worker process before it exits and a fresh one takes over.
// Smaller = tighter memory ceiling but more per-batch startup (slim-bundle
// parse + three-version check + static server + Chromium launch, ~2 s each).
// 12 keeps a worker comfortably under the danger zone while adding only a
// handful of extra startups across a full ~200-example run.
const batchSize = parseIntAtLeast( process.env.TSLP_E2E_BATCH_SIZE || getArg( '--batch-size=', '12' ), 12, 1 );
// Pause after a batch worker exits before spawning the next one in that slot,
// so the dying worker's Chromium process tree (and its GPU buffers) is gone
// before the replacement's appears — avoids a brief 3-way overlap of Chromium
// trees when both slots cross over at once.
const slotCooldownMs = parseIntAtLeast( process.env.TSLP_E2E_SLOT_COOLDOWN_MS || '750', 750, 0 );

// Forward all flags to workers except the orchestrator-only ones. Note --offset
// and --limit are consumed here (we slice the example list ourselves and hand
// each batch an absolute --offset), so they must NOT reach the worker.
const forwarded = args.filter( a =>
	a !== '--' &&
	! a.startsWith( '--workers=' ) &&
	! a.startsWith( '--base-port=' ) &&
	! a.startsWith( '--port=' ) &&
	! a.startsWith( '--offset=' ) &&
	! a.startsWith( '--limit=' ) &&
	! a.startsWith( '--batch-size=' ) &&
	! a.startsWith( '--worker-max-old-space-mb=' ) &&
	! a.startsWith( '--report=' )
);

const examplesDir = join( threeRepo, 'examples' );
if ( ! existsSync( examplesDir ) ) {
	console.error( `[e2e-parallel] three.js examples not found at ${ examplesDir }. Pass --three-repo=<path>` );
	process.exit( 1 );
}
assertThreeAtLeast184( threeRepo, 'e2e-parallel' );
const allExamples = readdirSync( examplesDir )
	.filter( f => f.startsWith( 'webgpu_' ) && f.endsWith( '.html' ) )
	.filter( f => ! filter || f.includes( filter ) )
	.slice( offset, offset + limit );

const total = allExamples.length;
if ( total === 0 ) {
	const finalReport = resolve( OUT, 'e2e-report.json' );
	mkdirSync( OUT, { recursive: true } );
	writeFileSync( finalReport, JSON.stringify( { total: 0, pass: 0, fail: 0, skip: 0, details: [] }, null, 2 ) );
	console.log( `[e2e-parallel] 0 examples matched filter="${ filter }" offset=${ offset } limit=${ limit }` );
	console.log( `  report: ${ finalReport }` );
	process.exit( 0 );
}
const actualWorkers = Math.min( workers, total );

mkdirSync( OUT, { recursive: true } );

// Build the batch list. Each batch carries an *absolute* offset into the
// (already filter+offset+limit-sliced) example list — the worker re-reads the
// examples directory and re-applies the same --filter, so absolute offsets
// keep it pointed at the right slice even when the orchestrator was itself
// invoked with --offset.
const batches = [];
let nextBatchSerial = 0;
function makeBatch( absOffset, lim, exampleNames, parentIdx = null ) {
	const idx = nextBatchSerial ++;
	return {
		absOffset,
		lim,
		idx,
		parentIdx,
		exampleNames,
		report: `e2e-report-batch-${ idx }.json`,
	};
}

for ( let off = 0; off < total; off += batchSize ) {
	const lim = Math.min( batchSize, total - off );
	batches.push( makeBatch( offset + off, lim, allExamples.slice( off, off + lim ) ) );
}

// Clear any stale per-batch / per-worker report shards from a previous run so
// the merge step can't pick them up. (Old runs used e2e-report-worker-N.json.)
for ( const f of readdirSync( OUT ) ) {
	if ( /^e2e-report-(batch|worker)-\d+\.json$/.test( f ) ) {
		try { rmSync( join( OUT, f ) ); } catch {}
	}
}

const ramGb = ( totalmem() / 1024 ** 3 ).toFixed( 1 );
console.log( `[e2e-parallel] ${ total } examples → ${ batches.length } batches of ≤${ batchSize }, ${ actualWorkers } worker slot(s) (auto from ${ ramGb } GB RAM, override with --workers=N / --batch-size=N), base-port ${ basePort }` );
if ( ! verbose ) console.log( '[e2e-parallel] showing per-example results only; pass --verbose for page logs and worker boilerplate' );

function shouldForwardWorkerLine( line ) {
	if ( verbose ) return true;
	const text = line.trim();
	if ( ! text ) return false;
	if ( text.startsWith( '[batch-e2e]' ) ) return false;
	if ( text.startsWith( '[page-warn' ) || text.startsWith( '[page-log' ) ) return false;
	if ( text.startsWith( '═══ e2e summary' ) ) return false;
	if ( /^\d+ pass, \d+ fail/.test( text ) ) return false;
	if ( text.startsWith( 'report:' ) ) return false;
	return true;
}

function attachLinePrefix( stream, outStream, prefix, onLine, shouldForward = () => true ) {
	let buf = '';
	stream.on( 'data', ( chunk ) => {
		buf += chunk.toString();
		const lines = buf.split( '\n' );
		buf = lines.pop();
		for ( const line of lines ) {
			if ( onLine ) onLine( line );
			if ( shouldForward( line ) ) outStream.write( `${ prefix } ${ line }\n` );
		}
	} );
	stream.on( 'end', () => {
		if ( buf ) {
			if ( onLine ) onLine( buf );
			if ( shouldForward( buf ) ) outStream.write( `${ prefix } ${ buf }\n` );
		}
	} );
}

function formatPercent( value ) {
	if ( typeof value !== 'number' || ! Number.isFinite( value ) ) return 'n/a';
	return ( value * 100 ).toFixed( 1 ) + '%';
}

function compactText( value, max = 220 ) {
	const text = String( value || '' ).replace( /\s+/g, ' ' ).trim();
	return text.length > max ? text.slice( 0, max - 1 ) + '…' : text;
}

function formatPixelGate( gate ) {
	if ( ! gate ) return 'psnr n/a';
	if ( gate.skipped ) return `psnr skipped (${ compactText( gate.reason, 48 ) })`;
	if ( gate.pass === undefined ) return 'psnr n/a';
	return `psnr ${ gate.psnr }/${ gate.threshold } dB ${ gate.pass ? 'ok' : 'FAIL' }`;
}

function diagnosticNote( diagnostics ) {
	if ( ! diagnostics ) return '';
	const parts = [];
	if ( diagnostics.healedNullTextureImages > 0 ) parts.push( `healed-null-images=${ diagnostics.healedNullTextureImages }` );
	const fallbacks = diagnostics.colorTransferFallbacks || {};
	const fallbackTotal = Object.values( fallbacks ).reduce( ( sum, count ) => sum + ( count | 0 ), 0 );
	if ( fallbackTotal > 0 ) parts.push( `color-fallbacks=${ fallbackTotal }` );
	return parts.join( ', ' );
}

function printFailureSummary( details, max = 25 ) {
	const failures = details.filter( ( result ) => result && result.status === 'fail' );
	if ( failures.length === 0 ) return;
	console.log( '\nTop failures:' );
	for ( const result of failures.slice( 0, max ) ) {
		const captureErrors = Array.isArray( result.captureErrors ) ? result.captureErrors.length : 0;
		const replayErrors = Array.isArray( result.replayErrors ) ? result.replayErrors.length : 0;
		const diag = diagnosticNote( result.replayDiagnostics );
		console.log( `  - ${ result.name }: ${ formatPixelGate( result.pixelGate ) }; replay ${ formatPercent( result.replayBrightFrac ) }; artifacts ${ result.userArtifacts }+${ result.auxArtifacts }; captureErrors=${ captureErrors }; replayErrors=${ replayErrors }${ diag ? '; ' + diag : '' }` );
		if ( result.error ) console.log( `    ${ compactText( result.error ) }` );
	}
	if ( failures.length > max ) console.log( `  ... ${ failures.length - max } more failures in ${ join( OUT, 'e2e-report.json' ) }` );
}

// Track live children so we can reap them on signals / crashes. Without this,
// a non-TTY kill of the orchestrator leaves orphaned Chromium workers eating
// RAM/GPU until the user notices and kills them by hand.
const liveChildren = new Set();
let shuttingDown = false;
const USE_DETACHED_WORKERS = process.platform !== 'win32';

function shutdown( reason ) {
	if ( shuttingDown ) return;
	shuttingDown = true;
	if ( liveChildren.size === 0 ) return;
	console.error( `\n[e2e-parallel] ${ reason } — terminating ${ liveChildren.size } worker(s)` );
	for ( const c of liveChildren ) {
		terminateChildProcessTree( c, 'SIGTERM' );
	}
	// Force-kill stragglers after a grace period (Playwright closes Chromium on SIGTERM).
	setTimeout( () => {
		for ( const c of liveChildren ) {
			terminateChildProcessTree( c, 'SIGKILL' );
		}
	}, 5000 ).unref();
}

process.on( 'SIGINT',  () => { shutdown( 'SIGINT' );  process.exitCode = 130; } );
process.on( 'SIGTERM', () => { shutdown( 'SIGTERM' ); process.exitCode = 143; } );
process.on( 'SIGHUP',  () => { shutdown( 'SIGHUP' );  process.exitCode = 129; } );
process.on( 'uncaughtException',  ( err ) => { console.error( err ); shutdown( 'uncaughtException' );  process.exitCode = 1; } );
process.on( 'unhandledRejection', ( err ) => { console.error( err ); shutdown( 'unhandledRejection' ); process.exitCode = 1; } );

// Cap each worker's V8 old-space and expose GC so the per-example browser
// recycle in run-e2e.mjs can hint a heap sweep. Belt-and-braces with the
// batch-and-exit model: even if a single batch leaks pathologically, the
// worker dies with a clean Node OOM the orchestrator can surface, rather than
// dragging the OS down. Override with TSLP_E2E_WORKER_MAX_OLD_SPACE_MB.
const workerMaxOldSpaceMb = parseIntAtLeast(
	process.env.TSLP_E2E_WORKER_MAX_OLD_SPACE_MB || getArg( '--worker-max-old-space-mb=', '1536' ),
	1536,
	512
);

let batchesDone = 0;
let unrecoveredCrash = false;
const supersededReports = new Set();

function terminateChildProcessTree( child, signal = 'SIGTERM' ) {
	if ( ! child || ! child.pid ) return;
	try {
		if ( USE_DETACHED_WORKERS ) process.kill( - child.pid, signal );
		else child.kill( signal );
	} catch {}
}

function reportStateForBatch( batch ) {
	const reportPath = resolve( OUT, batch.report );
	if ( ! existsSync( reportPath ) ) {
		return { reportPath, exists: false, complete: false, total: 0, details: 0 };
	}
	try {
		const report = JSON.parse( readFileSync( reportPath, 'utf8' ) );
		const totalInReport = report.total | 0;
		const detailsInReport = Array.isArray( report.details ) ? report.details.length : 0;
		return {
			reportPath,
			exists: true,
			complete: detailsInReport >= totalInReport,
			total: totalInReport,
			details: detailsInReport,
		};
	} catch ( err ) {
		return {
			reportPath,
			exists: true,
			complete: false,
			total: 0,
			details: 0,
			error: err && err.message || String( err ),
		};
	}
}

function crashText( batch, exit ) {
	const bits = [ `batch ${ batch.idx }` ];
	if ( batch.parentIdx !== null ) bits.push( `retry-of=${ batch.parentIdx }` );
	if ( exit.signal ) bits.push( `signal=${ exit.signal }` );
	else bits.push( `exit=${ exit.code }` );
	if ( exit.reportState && exit.reportState.exists ) {
		bits.push( `report ${ exit.reportState.details }/${ exit.reportState.total }` );
	} else {
		bits.push( 'missing report' );
	}
	return bits.join( ', ' );
}

function writeSyntheticCrashReport( batch, exit ) {
	const names = batch.exampleNames && batch.exampleNames.length
		? batch.exampleNames
		: Array.from( { length: Math.max( 1, batch.lim ) }, ( _, i ) => `offset-${ batch.absOffset + i }` );
	const error = `worker crashed before completing its batch (${ crashText( batch, exit ) })`;
	const details = names.map( ( name ) => ( { name, status: 'fail', error } ) );
	writeFileSync( resolve( OUT, batch.report ), JSON.stringify( {
		total: details.length,
		pass: 0,
		fail: details.length,
		skip: 0,
		details,
	}, null, 2 ) );
}

function requeueCrashedBatch( batch, exit ) {
	supersededReports.add( batch.report );
	const retryBatches = [];
	for ( let i = 0; i < batch.lim; i ++ ) {
		const name = batch.exampleNames && batch.exampleNames[ i ] ? batch.exampleNames[ i ] : `offset-${ batch.absOffset + i }`;
		retryBatches.push( makeBatch( batch.absOffset + i, 1, [ name ], batch.idx ) );
	}
	batches.push( ...retryBatches );
	console.warn( `[e2e-parallel] ${ crashText( batch, exit ) }; retrying as ${ retryBatches.length } single-example batch(es)` );
}

function runBatch( batch, slot ) {
	return new Promise( ( resolveExit ) => {
		const port = basePort + batch.idx;
		const child = spawn(
			process.execPath,
			[
				`--max-old-space-size=${ workerMaxOldSpaceMb }`,
				'--expose-gc',
				'run-e2e.mjs',
				`--offset=${ batch.absOffset }`,
				`--limit=${ batch.lim }`,
				`--port=${ port }`,
				`--report=${ batch.report }`,
				...forwarded,
			],
			{ cwd: SELF, stdio: [ 'ignore', 'pipe', 'pipe' ], detached: USE_DETACHED_WORKERS }
		);
		liveChildren.add( child );

		const prefix = `[s${ slot }·b${ batch.idx }]`;
		attachLinePrefix( child.stdout, process.stdout, prefix, null, shouldForwardWorkerLine );
		attachLinePrefix( child.stderr, process.stderr, prefix, null, shouldForwardWorkerLine );

		let settled = false;
		const finish = ( exit ) => {
			if ( settled ) return;
			settled = true;
			liveChildren.delete( child );
			batchesDone ++;
			resolveExit( exit );
		};

		child.on( 'close', ( code, signal ) => {
			const reportState = reportStateForBatch( batch );
			const crashed = !! signal || ! reportState.complete;
			if ( crashed ) terminateChildProcessTree( child, 'SIGKILL' );
			const how = signal ? `signal=${ signal }` : `exit=${ code }`;
			console.log( `[e2e-parallel] batch ${ batch.idx } done (${ how }) — ${ batchesDone + 1 }/${ batches.length } batches complete` );
			finish( {
				code: code ?? ( signal ? 1 : 0 ),
				signal,
				idx: batch.idx,
				batch,
				reportState,
				crashed,
				retryable: crashed && ! signal?.startsWith?.( 'SIGINT' ) && code !== 2,
			} );
		} );
		child.on( 'error', ( err ) => {
			console.error( `[e2e-parallel] batch ${ batch.idx } failed to start: ${ err && err.message || err }` );
			finish( {
				code: 1,
				signal: null,
				idx: batch.idx,
				batch,
				reportState: reportStateForBatch( batch ),
				crashed: true,
				retryable: false,
			} );
		} );
	} );
}

let nextBatchIdx = 0;
async function runSlot( slot ) {
	const results = [];
	while ( ! shuttingDown ) {
		const idx = nextBatchIdx ++;
		if ( idx >= batches.length ) break;
		const exit = await runBatch( batches[ idx ], slot );
		results.push( exit );
		if ( exit.crashed && ! shuttingDown ) {
			if ( exit.retryable && exit.batch.lim > 1 ) {
				requeueCrashedBatch( exit.batch, exit );
			} else {
				unrecoveredCrash = true;
				writeSyntheticCrashReport( exit.batch, exit );
			}
		}
		if ( ! shuttingDown && nextBatchIdx < batches.length && slotCooldownMs > 0 ) {
			await new Promise( ( r ) => setTimeout( r, slotCooldownMs ) );
		}
	}
	return results;
}

await Promise.all(
	Array.from( { length: actualWorkers }, ( _, s ) => runSlot( s ) )
);

// Merge per-batch reports into a single e2e-report.json
console.log( '\n[e2e-parallel] merging reports...' );

const merged = { total: 0, pass: 0, fail: 0, skip: 0, details: [] };
for ( const batch of batches ) {
	if ( supersededReports.has( batch.report ) ) continue;
	const reportPath = resolve( OUT, batch.report );
	if ( ! existsSync( reportPath ) ) {
		if ( ! shuttingDown ) console.warn( `[e2e-parallel] missing report: ${ batch.report }` );
		continue;
	}
	let w;
	try { w = JSON.parse( readFileSync( reportPath, 'utf8' ) ); }
	catch ( err ) { console.warn( `[e2e-parallel] unreadable report ${ batch.report }: ${ err && err.message || err }` ); continue; }
	merged.total += w.total || 0;
	merged.pass  += w.pass  || 0;
	merged.fail  += w.fail  || 0;
	merged.skip  += w.skip  || 0;
	merged.details.push( ...( w.details || [] ) );
}

merged.details.sort( ( a, b ) => ( a.name || '' ).localeCompare( b.name || '' ) );

const finalReport = resolve( OUT, 'e2e-report.json' );
writeFileSync( finalReport, JSON.stringify( merged, null, 2 ) );

console.log( '\n═══ e2e-parallel summary ═══' );
console.log( `  ${ merged.pass } pass, ${ merged.fail } fail, ${ merged.total } candidates tested, ${ merged.skip } skipped` );
console.log( `  report: ${ finalReport }` );
printFailureSummary( merged.details );

const finalExitCode = shuttingDown ? ( process.exitCode || 1 ) : ( unrecoveredCrash || merged.fail > 0 ? 1 : 0 );
process.exit( finalExitCode );
