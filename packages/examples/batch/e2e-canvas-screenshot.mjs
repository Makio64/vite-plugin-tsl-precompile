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

function screenshotErrorMessage( error ) {

	return error && error.message || String( error );

}

/**
 * Capture the selected canvas through Playwright's element screenshot path,
 * then retry the exact compositor region if element screenshot bookkeeping
 * fails. Both paths capture real page pixels; no placeholder evidence is ever
 * synthesized.
 */
export async function captureCanvasRegion( page, canvas, box, {
	elementTimeout = 3000,
	fallbackTimeout = elementTimeout,
} = {} ) {

	try {

		return await canvas.screenshot( { timeout: elementTimeout } );

	} catch ( elementError ) {

		const clip = {
			x: Number( box && box.x ),
			y: Number( box && box.y ),
			width: Number( box && box.width ),
			height: Number( box && box.height ),
		};
		if (
			! page || typeof page.screenshot !== 'function' ||
			! Number.isFinite( clip.x ) || ! Number.isFinite( clip.y ) ||
			! Number.isFinite( clip.width ) || ! Number.isFinite( clip.height ) ||
			clip.width <= 0 || clip.height <= 0
		) {

			throw new Error(
				`Canvas element screenshot failed and its compositor clip is invalid: ${ screenshotErrorMessage( elementError ) }`,
				{ cause: elementError },
			);

		}
		try {

			return await page.screenshot( { clip, timeout: fallbackTimeout } );

		} catch ( fallbackError ) {

			throw new AggregateError(
				[ elementError, fallbackError ],
				`Canvas element screenshot failed (${ screenshotErrorMessage( elementError ) }); ` +
				`compositor-region fallback failed (${ screenshotErrorMessage( fallbackError ) }).`,
			);

		}

	}

}

/**
 * Return stable canvas indices for examples whose async renderer initialization
 * makes DOM append order nondeterministic. Candidate positions come from
 * Playwright bounding boxes, so the authored layout remains the identity.
 */
export function canvasIndicesByHorizontalPosition( candidates, { rightFirst = false } = {} ) {

	return [ ...( candidates || [] ) ]
		.sort( ( left, right ) => {

			const leftX = Number.isFinite( left && left.left ) ? left.left : 0;
			const rightX = Number.isFinite( right && right.left ) ? right.left : 0;
			const positionOrder = rightFirst ? rightX - leftX : leftX - rightX;
			return positionOrder || ( left && left.index || 0 ) - ( right && right.index || 0 );

		} )
		.map( ( candidate ) => candidate.index );

}

/**
 * Return stable canvas indices for examples that author WebGPU and WebGL
 * renderers concurrently. Capture/replay wrappers mark each canvas with its
 * authored backend; stock canvases fall back to horizontal position.
 */
export function canvasIndicesByBackendThenHorizontalPosition( candidates ) {

	const backendRank = ( backend ) => backend === 'webgpu' ? 0 : backend === 'webgl' ? 2 : 1;
	return [ ...( candidates || [] ) ]
		.sort( ( left, right ) => {

			const leftX = Number.isFinite( left && left.left ) ? left.left : 0;
			const rightX = Number.isFinite( right && right.left ) ? right.left : 0;
			return backendRank( left && left.backend ) - backendRank( right && right.backend )
				|| leftX - rightX
				|| ( left && left.index || 0 ) - ( right && right.index || 0 );

		} )
		.map( ( candidate ) => candidate.index );

}
