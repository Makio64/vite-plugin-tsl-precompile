import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';

import { assertThreeAtLeast184 } from './_three-version.mjs';

const SELF = dirname( fileURLToPath( import.meta.url ) );
const OUT  = resolve( SELF, 'results' );

const args = process.argv.slice( 2 );

function getArg( prefix, def ) {
	const found = args.find( a => a.startsWith( prefix ) );
	return found ? found.slice( prefix.length ) : def;
}

const workers  = parseInt( getArg( '--workers=', '6' ), 10 );
const basePort = parseInt( getArg( '--base-port=', '8730' ), 10 );
const filter   = getArg( '--filter=', '' );
const threeRepo = resolve( getArg( '--three-repo=', resolve( SELF, '../../../../three.js' ) ) );

// Forward all flags to workers except the orchestrator-only ones
const forwarded = args.filter( a =>
	! a.startsWith( '--workers=' ) &&
	! a.startsWith( '--base-port=' ) &&
	! a.startsWith( '--port=' ) &&
	! a.startsWith( '--offset=' ) &&
	! a.startsWith( '--limit=' ) &&
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
	.filter( f => ! filter || f.includes( filter ) );

const total = allExamples.length;
const actualWorkers = Math.min( workers, total );
const chunk = Math.ceil( total / actualWorkers );

mkdirSync( OUT, { recursive: true } );

const jobs = [];
for ( let i = 0; i < actualWorkers; i++ ) {
	const off = i * chunk;
	const lim = Math.min( chunk, total - off );
	if ( lim <= 0 ) break;
	jobs.push( { off, lim, port: basePort + i, report: `e2e-report-worker-${ i }.json`, idx: i } );
}

console.log( `[e2e-parallel] ${ total } examples → ${ jobs.length } workers, ~${ chunk } each (base-port ${ basePort })` );

function attachLinePrefix( stream, outStream, prefix, onLine ) {
	let buf = '';
	stream.on( 'data', ( chunk ) => {
		buf += chunk.toString();
		const lines = buf.split( '\n' );
		buf = lines.pop();
		for ( const line of lines ) {
			outStream.write( `${ prefix } ${ line }\n` );
			if ( onLine ) onLine( line );
		}
	} );
	stream.on( 'end', () => {
		if ( buf ) {
			outStream.write( `${ prefix } ${ buf }\n` );
			if ( onLine ) onLine( buf );
		}
	} );
}

const promises = jobs.map( ( { off, lim, port, report, idx } ) =>
	new Promise( ( resolve ) => {
		const child = spawn(
			process.execPath,
			[
				'run-e2e.mjs',
				`--offset=${ off }`,
				`--limit=${ lim }`,
				`--port=${ port }`,
				`--report=${ report }`,
				...forwarded,
			],
			{ cwd: SELF, stdio: [ 'ignore', 'pipe', 'pipe' ] }
		);

		const prefix = `[w${ idx }]`;
		let summary = '';
		attachLinePrefix( child.stdout, process.stdout, prefix, ( line ) => {
			if ( line.includes( ' pass,' ) ) summary = line.trim();
		} );
		attachLinePrefix( child.stderr, process.stderr, prefix );

		child.on( 'close', ( code ) => {
			console.log( `[e2e-parallel] worker ${ idx } done (exit=${ code })${ summary ? ' — ' + summary : '' }` );
			resolve( { code, idx, report } );
		} );
	} )
);

const results = await Promise.all( promises );

// Merge worker reports into a single e2e-report.json
console.log( '\n[e2e-parallel] merging reports...' );

const merged = { total: 0, pass: 0, fail: 0, skip: 0, details: [] };

for ( const { report } of jobs ) {
	const reportPath = resolve( OUT, report );
	if ( ! existsSync( reportPath ) ) {
		console.warn( `[e2e-parallel] missing report: ${ report }` );
		continue;
	}
	const w = JSON.parse( readFileSync( reportPath, 'utf8' ) );
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
console.log( `  ${ merged.pass } pass, ${ merged.fail } fail, ${ merged.skip } skip, ${ merged.total } candidates` );
console.log( `  report: ${ finalReport }` );

process.exit( results.some( r => r.code !== 0 ) ? 1 : 0 );
