import { relative } from 'node:path';
import { inspect } from 'node:util';

function bounded( value, limit ) {

	if ( value.length <= limit ) return value;
	const marker = '\n... truncated; see full log below ...\n';
	const beginning = Math.ceil( ( limit - marker.length ) * 0.7 );
	const ending = limit - marker.length - beginning;
	return value.slice( 0, beginning ) + marker + value.slice( -ending );

}

function fullLog() {

	// This reporter runs in the CLI process, whose complete spec destination is
	// already explicit. Standalone uses can still point to the printed directory.
	const destination = process.execArgv.find( ( arg ) => arg.startsWith( '--test-reporter-destination=' ) && ! [ 'stdout', 'stderr' ].includes( arg.slice( 28 ) ) );
	return destination ? destination.slice( 28 ) : 'the printed complete-log directory';

}

// Node writes the complete spec report to a separate file. Keep terminal output
// bounded on success, with actionable failures and timings for the next run.
export default async function* report( events ) {

	const files = [];
	const log = fullLog();
	for await ( const { type, data } of events ) {

		// The child summary times only its test bodies. File completion includes
		// imports, fixture setup and process startup, which often dominate this suite.
		if ( type === 'test:complete' && data.nesting === 0 && data.name === data.file ) {

			files.push( { file: data.file, duration_ms: data.details.duration_ms } );
			files.sort( ( a, b ) => b.duration_ms - a.duration_ms );
			if ( files.length > 3 ) files.pop();

		}
		if ( type === 'test:fail' ) {

			yield `${ bounded( `FAIL ${ data.file || '' }:${ data.line || '' } ${ data.name }`, 500 ) }\n`;
			// Error.message and stack can contain a complete source file and bypass
			// inspect's string limits. The outer cap bounds those fields too, without
			// changing the original error seen by the independent full spec reporter.
			const detail = inspect( data.details.error, { colors: false, depth: 4, maxStringLength: 1200, maxArrayLength: 20, customInspect: false } );
			yield `${ bounded( detail, 4000 ) }\n`;
			yield `${ bounded( `Full log: ${ log }`, 500 ) }\n`;

		}
		if ( type !== 'test:summary' ) continue;
		if ( data.file ) continue;
		const counts = data.counts;
		yield `${ data.success ? 'PASS' : 'FAIL' } ${ counts.tests } tests: ${ counts.passed } passed, ${ counts.failed } failed, ${ counts.cancelled } cancelled, ${ counts.skipped } skipped, ${ counts.todo } todo (${ ( data.duration_ms / 1000 ).toFixed( 2 ) }s)\n`;
		for ( const file of files ) {

			yield `  ${ ( file.duration_ms / 1000 ).toFixed( 2 ) }s ${ relative( process.cwd(), file.file ) }\n`;

		}

	}

}
