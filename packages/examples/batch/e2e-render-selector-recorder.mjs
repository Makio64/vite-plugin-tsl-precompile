/**
 * Install selector-mismatch diagnostics into a browser-like target.
 *
 * Keep the implementation self-contained: Playwright serializes this
 * function into an init script without preserving module closures. The
 * exposed recorder also lets harness fallbacks retain structured details for
 * errors they intentionally catch before `error`/`unhandledrejection` fires.
 */
export function installRenderSelectorMismatchRecorder( { target = globalThis, phase = null } = {} ) {

	const diagnostics = target.__tslpHarnessDiagnostics || ( target.__tslpHarnessDiagnostics = {
		colorTransferFallbacks: Object.create( null ),
		healedNullTextureImages: 0,
	} );
	const recordRenderSelectorMismatch = ( error, origin ) => {

		try {

			const jsonClone = ( value ) => {

				try {

					return value === undefined ? null : JSON.parse( JSON.stringify( value ) );

				} catch ( _ ) {

					return null;

				}

			};
			const details = error && error.details && typeof error.details === 'object' ? error.details : {};
			const message = String( error && error.message || error || '' );
			const code = typeof error?.code === 'string' ? error.code : null;
			if (
				error?.tslPrecompileVariantSelection !== true &&
				! /^TSLP_VARIANT_SELECTOR_/.test( code || '' ) &&
				! /captured artifact variant matches/i.test( message )
			) return;

			const selector = typeof details.selector === 'string' ? details.selector : null;
			const availableSelectors = Array.isArray( details.availableSelectors )
				? details.availableSelectors.filter( ( value ) => typeof value === 'string' )
				: [];
			const activeHashMatch = message.match( /\((selector:[a-z0-9]+)\)/i );
			const record = {
				phase,
				origin,
				code,
				message,
				selector,
				activeHash: activeHashMatch ? activeHashMatch[ 1 ] : null,
				availableSelectors,
				cacheKeys: Array.isArray( details.cacheKeys ) ? details.cacheKeys : null,
				selectorCount: Number.isFinite( details.selectorCount ) ? details.selectorCount : null,
				closestDifferencePaths: Array.isArray( details.closestDifferencePaths )
					? details.closestDifferencePaths.filter( ( value ) => typeof value === 'string' )
					: [],
				artifactContext: jsonClone( details.artifactContext ),
				remediation: jsonClone( details.remediation ),
			};
			const list = diagnostics.renderSelectorMismatches || ( diagnostics.renderSelectorMismatches = [] );
			const identity = JSON.stringify( [ record.code, record.selector, record.activeHash, record.availableSelectors ] );
			if ( list.length < 20 && ! list.some( ( item ) => item && item.identity === identity ) ) {

				list.push( { ...record, identity } );

			}

		} catch ( _ ) {}

	};

	target.__tslpRecordRenderSelectorMismatch = recordRenderSelectorMismatch;
	if ( typeof target.addEventListener === 'function' && target.__tslpRenderSelectorRecorderListenersInstalled !== true ) {

		target.__tslpRenderSelectorRecorderListenersInstalled = true;
		target.addEventListener( 'error', ( event ) => recordRenderSelectorMismatch( event && ( event.error || event.message ), 'error' ) );
		target.addEventListener( 'unhandledrejection', ( event ) => recordRenderSelectorMismatch( event && event.reason, 'unhandledrejection' ) );

	}
	return recordRenderSelectorMismatch;

}
