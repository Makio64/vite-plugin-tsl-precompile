/**
 * Readiness state for deterministic replay presentation.
 *
 * A deferred top-level draw consumes an application callback without putting
 * pixels on the default framebuffer. The settle gate must therefore observe a
 * successful presentation after the most recent deferral, not merely zero
 * loader counters.
 */
export function createPresentationReadinessState() {

	return {
		deferred: 0,
		requiredAfter: 0,
		successful: 0,
	};

}

export function markPresentationDeferred( state ) {

	if ( ! state || typeof state !== 'object' ) return state;
	state.deferred = ( state.deferred | 0 ) + 1;
	state.requiredAfter = state.successful | 0;
	return state;

}

export function markPresentationSuccessful( state ) {

	if ( ! state || typeof state !== 'object' ) return state;
	state.successful = ( state.successful | 0 ) + 1;
	return state;

}

export function presentationReadinessSatisfied( state ) {

	return !! state && ( state.successful | 0 ) > ( state.requiredAfter | 0 );

}
