import { classifyBrowserFailureEvent } from '../browser-failure-policy.mjs';

export const E2E_FATAL_PAGE_ERROR_CODE = 'TSLP_E2E_FATAL_PAGE_ERROR';

export function isE2EFatalPageError( error ) {

	return error?.code === E2E_FATAL_PAGE_ERROR_CODE;

}

/** Keep the original blocking exception visible in the compact failed row. */
export function firstFatalPageErrorMessage( phases ) {

	for ( const { phase, visit } of phases ) {

		if ( visit?.timings?.fatalPageError !== true ) continue;
		const original = ( visit.errors || [] ).find( message => typeof message === 'string' && message.startsWith( 'pageerror: ' ) );
		if ( original ) return `${ phase } ${ original }`;

	}
	return null;

}

/** Stop readiness waits once an unexpected uncaught page exception makes the visit invalid. */
export function installE2EFatalPageErrorGuard( page, { pageUrl, expectedPatterns = [] } = {} ) {

	let fatalError = null;
	const waiters = new Set();
	const onPageError = error => {

		const failure = classifyBrowserFailureEvent( { kind: 'pageerror', message: error?.message || String( error ) }, { pageUrl } );
		if ( expectedPatterns.some( pattern => {

			pattern.lastIndex = 0;
			return pattern.test( failure.text );

		} ) ) return;
		if ( fatalError ) return;
		fatalError = new Error( failure.text );
		fatalError.code = E2E_FATAL_PAGE_ERROR_CODE;
		for ( const reject of waiters ) reject( fatalError );

	};
	page.on( 'pageerror', onPageError );
	return {
		async run( operation ) {

			if ( fatalError ) throw fatalError;
			let rejectOnError;
			const errorObserved = new Promise( ( _resolve, reject ) => { rejectOnError = reject; } );
			waiters.add( rejectOnError );
			try {

				return await Promise.race( [ Promise.resolve().then( operation ), errorObserved ] );

			} finally {

				waiters.delete( rejectOnError );

			}

		},
		dispose() {

			page.off( 'pageerror', onPageError );
			waiters.clear();

		},
	};

}
