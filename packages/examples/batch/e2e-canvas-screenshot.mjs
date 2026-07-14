/**
 * Hide every body descendant that is not the selected canvas or one of its
 * ancestors. Playwright implements element screenshots as page clips, so a
 * fixed DOM overlay (for example three.js's `#info`) can otherwise be
 * composited over a WebGPU canvas nondeterministically.
 *
 * This callback is intentionally self-contained: Playwright serializes its
 * source into the page rather than preserving module closures.
 */
export function isolateCanvasForScreenshot( target ) {

	if ( ! target || ! target.ownerDocument ) return 0;
	const view = target.ownerDocument.defaultView;
	if ( ! view ) return 0;
	const stateKey = '__tslpCanvasScreenshotVisibilityState';
	const previous = view[ stateKey ];
	if ( Array.isArray( previous ) ) {

		for ( const record of previous ) {

			if ( ! record || ! record.element || ! record.element.style ) continue;
			record.element.style.setProperty( 'visibility', record.value, record.priority );

		}

	}

	const hidden = [];
	for ( const element of target.ownerDocument.querySelectorAll( 'body *' ) ) {

		if ( element === target || typeof element.contains === 'function' && element.contains( target ) ) continue;
		if ( ! element.style || typeof element.style.setProperty !== 'function' ) continue;
		hidden.push( {
			element,
			value: element.style.getPropertyValue( 'visibility' ),
			priority: element.style.getPropertyPriority( 'visibility' ),
		} );
		element.style.setProperty( 'visibility', 'hidden', 'important' );

	}
	view[ stateKey ] = hidden;
	return hidden.length;

}

/** Restore the inline visibility state saved by isolateCanvasForScreenshot. */
export function restoreCanvasAfterScreenshot( target ) {

	if ( ! target || ! target.ownerDocument ) return 0;
	const view = target.ownerDocument.defaultView;
	if ( ! view ) return 0;
	const stateKey = '__tslpCanvasScreenshotVisibilityState';
	const hidden = view[ stateKey ];
	if ( ! Array.isArray( hidden ) ) return 0;
	delete view[ stateKey ];
	for ( const record of hidden ) {

		if ( ! record || ! record.element || ! record.element.style ) continue;
		record.element.style.setProperty( 'visibility', record.value, record.priority );

	}
	return hidden.length;

}
