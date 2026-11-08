export const DEFAULT_E2E_CASE_TIMEOUT_MS = 300_000;
export const E2E_CASE_TIMEOUT_CODE = 'TSLP_E2E_CASE_TIMEOUT';

export class E2ECaseTimeoutError extends Error {

	constructor( caseName, timeoutMs ) {

		super( `E2E case ${ JSON.stringify( caseName ) } exceeded the ${ timeoutMs }ms fail-closed watchdog.` );
		this.name = 'E2ECaseTimeoutError';
		this.code = E2E_CASE_TIMEOUT_CODE;
		this.caseName = caseName;
		this.timeoutMs = timeoutMs;

	}

}

export function isE2ECaseTimeoutError( error ) {

	return error?.code === E2E_CASE_TIMEOUT_CODE;

}

/**
 * Bound one complete stock -> capture -> replay case. The work promise is not
 * cancellable; callers must terminate the owning process when this rejects so
 * the losing operation cannot continue mutating shared campaign state.
 */
export async function runE2ECaseWithWatchdog( caseName, timeoutMs, run ) {

	if ( typeof caseName !== 'string' || caseName.length === 0 ) {

		throw new TypeError( 'E2E case watchdog requires a non-empty case name.' );

	}
	if ( ! Number.isSafeInteger( timeoutMs ) || timeoutMs < 1 ) {

		throw new RangeError( 'E2E case watchdog timeout must be a positive safe integer.' );

	}
	if ( typeof run !== 'function' ) throw new TypeError( 'E2E case watchdog requires a run function.' );

	let timeoutId = null;
	const work = Promise.resolve().then( run );
	const deadline = new Promise( ( _resolve, reject ) => {

		timeoutId = setTimeout( () => {

			reject( new E2ECaseTimeoutError( caseName, timeoutMs ) );

		}, timeoutMs );

	} );
	try {

		return await Promise.race( [ work, deadline ] );

	} finally {

		if ( timeoutId !== null ) clearTimeout( timeoutId );

	}

}
