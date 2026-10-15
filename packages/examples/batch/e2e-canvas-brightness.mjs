// Serialized into the page by Playwright: keep this function self-contained.
export function readCanvasBrightFraction() {

	const cacheKey = Symbol.for( 'tslp.e2e.canvas-brightness.surface' );
	let bestBright = 0;
	for ( const canvas of document.querySelectorAll( 'canvas' ) ) {

		if ( ! canvas.width || ! canvas.height ) continue;
		try {

			let sample = Object.getOwnPropertyDescriptor( canvas, cacheKey )?.value;
			if ( ! sample ) {

				const surface = new OffscreenCanvas( canvas.width, canvas.height );
				const context = surface.getContext( '2d' );
				if ( ! context ) continue;
				sample = { surface, context };
				// Frozen host objects can still be sampled without keeping a cache.
				try { Object.defineProperty( canvas, cacheKey, { value: sample, configurable: true } ); } catch { /* Uncached readback. */ }

			}
			const { surface, context } = sample;
			if ( surface.width !== canvas.width ) surface.width = canvas.width;
			if ( surface.height !== canvas.height ) surface.height = canvas.height;
			// Transparent pixels must replace old samples instead of accumulating.
			context.clearRect( 0, 0, surface.width, surface.height );
			context.drawImage( canvas, 0, 0 );
			const pixels = context.getImageData( 0, 0, surface.width, surface.height ).data;
			let bright = 0;
			for ( let index = 0; index < pixels.length; index += 4 ) {

				if ( pixels[ index ] + pixels[ index + 1 ] + pixels[ index + 2 ] > 30 ) bright ++;

			}
			bestBright = Math.max( bestBright, bright / ( pixels.length / 4 ) );

		} catch { /* Keep the screenshot brightness gate as the authority. */ }

	}
	return bestBright;

}
