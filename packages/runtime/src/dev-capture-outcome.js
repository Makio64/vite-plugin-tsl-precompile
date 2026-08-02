function activityRoot() {

	if ( typeof window !== 'undefined' ) return window;
	if ( typeof self !== 'undefined' ) return self;
	return globalThis;

}

function captureClockNow() {

	const root = activityRoot();
	// Capture/replay automation may deliberately freeze application time while
	// exposing a real monotonic clock for readiness and timeout bookkeeping.
	if ( typeof root.__tslpRealNow === 'function' ) {

		try {

			const value = Number( root.__tslpRealNow() );
			if ( Number.isFinite( value ) ) return value;

		} catch {

			// Fall back to the normal wall clock when an optional harness hook fails.

		}

	}
	return Date.now();

}

const CAPTURE_STATUS = Symbol.for( '@tsl-precompile/runtime/dev-capture-status' );
const MAX_CAPTURE_FAILURES = 20;

function captureState() {

	const root = activityRoot();
	if ( ! root[ CAPTURE_STATUS ] ) {

		Object.defineProperty( root, CAPTURE_STATUS, {
			value: {
				acceptedCaptures: 0,
				failedCaptures: 0,
				failures: [],
			},
			configurable: true,
		} );

	}
	return root[ CAPTURE_STATUS ];

}

export function getDevCaptureStatus() {

	const root = activityRoot();
	const state = captureState();
	const failures = Array.isArray( state.failures ) ? state.failures : [];
	return Object.freeze( {
		pending: Math.max( 0, Number( root.__tslpPrecompilePending ) | 0 ),
		acceptedCaptures: state.acceptedCaptures,
		failedCaptures: state.failedCaptures,
		failures: Object.freeze( failures.map( ( failure ) => Object.freeze( { ...failure } ) ) ),
	} );

}

/**
 * Report capture acceptance to the optional recapture observer installed by
 * the CLI. Normal applications do not install the observer, so this is a
 * tiny process-local counter rather than an artifact registry.
 */
export function recordDevCaptureOutcome( accepted, failure = null ) {

	const state = captureState();
	if ( accepted === true ) state.acceptedCaptures ++;
	else {

		state.failedCaptures ++;
		appendCaptureFailure( state, failure );

	}

	const activity = activityRoot().__tslpRecaptureActivity;
	if ( ! activity || typeof activity !== 'object' ) return;
	if ( accepted === true ) activity.acceptedPosts = ( activity.acceptedPosts | 0 ) + 1;
	else {

		activity.failedCaptures = ( activity.failedCaptures | 0 ) + 1;
		appendCaptureFailure( activity, failure );

	}

}

export function recordDevCaptureResults( results ) {

	if ( ! Array.isArray( results ) ) {

		recordDevCaptureOutcome( false, {
			code: 'CAPTURE_RESULT_INVALID',
			shape: 'capture',
			message: 'Capture did not return a result array.',
		} );
		return;

	}
	for ( const result of results ) recordDevCaptureOutcome( result?.ok === true, result );

}

function appendCaptureFailure( target, value ) {

	if ( ! Array.isArray( target.failures ) ) target.failures = [];
	target.failures.push( normalizeCaptureFailure( value ) );
	if ( target.failures.length > MAX_CAPTURE_FAILURES ) {

		target.failures.splice( 0, target.failures.length - MAX_CAPTURE_FAILURES );

	}

}

function normalizeCaptureFailure( value ) {

	const input = value && typeof value === 'object' ? value : {};
	const shape = typeof input.shape === 'string' && input.shape.length > 0 ? input.shape : 'capture';
	const message = typeof input.error === 'string' && input.error.length > 0
		? input.error
		: typeof input.message === 'string' && input.message.length > 0
			? input.message
			: `${ shape } capture failed without an error message.`;
	return {
		code: typeof input.code === 'string' && input.code.length > 0 ? input.code : 'CAPTURE_FAILED',
		shape,
		error: message,
		message,
		profile: typeof input.profile === 'string' && input.profile.length > 0 ? input.profile : null,
		configHash: typeof input.configHash === 'string' && input.configHash.length > 0 ? input.configHash : null,
		...( typeof input.stack === 'string' && input.stack.length > 0 ? { stack: input.stack } : {} ),
	};

}

/**
 * Resolve after a capture wave has produced an outcome, the shared pending
 * counter has returned to zero, and it has remained unchanged for `settleMs`.
 *
 * Pass a snapshot returned by `getDevCaptureStatus()` as `since` when the
 * caller needs to distinguish a new render/capture wave from earlier work.
 */
export async function waitForDevCaptureSettled( {
	since = null,
	timeoutMs = 30_000,
	settleMs = 100,
	allowEmpty = false,
	rejectOnFailure = true,
} = {} ) {

	if ( ! Number.isFinite( timeoutMs ) || timeoutMs <= 0 ) {

		throw new TypeError( 'waitForDevCaptureSettled: timeoutMs must be a finite positive number.' );

	}
	if ( ! Number.isFinite( settleMs ) || settleMs < 0 ) {

		throw new TypeError( 'waitForDevCaptureSettled: settleMs must be a finite non-negative number.' );

	}
	const baseline = since && typeof since === 'object' ? since : {
		acceptedCaptures: 0,
		failedCaptures: 0,
	};
	const acceptedBefore = Math.max( 0, Number( baseline.acceptedCaptures ) | 0 );
	const failedBefore = Math.max( 0, Number( baseline.failedCaptures ) | 0 );
	const startedAt = captureClockNow();
	let idleSince = startedAt;
	let previousSignature = '';

	while ( true ) {

		const now = captureClockNow();
		if ( now - startedAt >= timeoutMs ) break;
		const status = getDevCaptureStatus();
		const signature = `${ status.pending }:${ status.acceptedCaptures }:${ status.failedCaptures }`;
		if ( signature !== previousSignature ) {

			previousSignature = signature;
			idleSince = now;

		}
		const acceptedDelta = status.acceptedCaptures - acceptedBefore;
		const failedDelta = status.failedCaptures - failedBefore;
		const observedOutcome = acceptedDelta > 0 || failedDelta > 0;
		if (
			status.pending === 0 &&
			( allowEmpty || observedOutcome ) &&
			now - idleSince >= settleMs
		) {

			if ( rejectOnFailure && failedDelta > 0 ) {

				throw new Error( `[tsl-precompile] ${ failedDelta } development capture operation${ failedDelta === 1 ? '' : 's' } failed while waiting for capture settlement.` );

			}
			return status;

		}
		await new Promise( ( resolve ) => setTimeout( resolve, Math.min( 25, Math.max( 1, settleMs || 1 ) ) ) );

	}
	const status = getDevCaptureStatus();
	throw new Error( `[tsl-precompile] capture did not settle within ${ timeoutMs }ms (pending=${ status.pending }, accepted=${ status.acceptedCaptures - acceptedBefore }, failed=${ status.failedCaptures - failedBefore }).` );

}
