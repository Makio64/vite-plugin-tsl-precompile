/**
 * Decode PNG screenshots in the browser and summarize their RGBA pixels.
 *
 * Screenshot buffers are compressed PNG bytes; sampling those bytes says
 * nothing about rendered content. Keeping decoding in Chromium avoids adding
 * a second PNG implementation to the smoke-test packages.
 */
export async function primaryCanvasLocator( page ) {

	const canvases = page.locator( 'canvas' );
	const count = await canvases.count();
	const viewport = page.viewportSize();
	let selected = null;
	for ( let index = 0; index < count; index ++ ) {

		const candidate = canvases.nth( index );
		if ( ! await candidate.isVisible() ) continue;
		const box = await candidate.boundingBox();
		if ( ! box || box.width <= 0 || box.height <= 0 ) continue;
		const visibleWidth = viewport
			? Math.max( 0, Math.min( box.x + box.width, viewport.width ) - Math.max( box.x, 0 ) )
			: box.width;
		const visibleHeight = viewport
			? Math.max( 0, Math.min( box.y + box.height, viewport.height ) - Math.max( box.y, 0 ) )
			: box.height;
		const visibleArea = visibleWidth * visibleHeight;
		const area = box.width * box.height;
		if ( ! selected || visibleArea > selected.visibleArea || ( visibleArea === selected.visibleArea && area > selected.area ) ) {

			selected = { index, visibleArea, area };

		}

	}
	if ( ! selected || selected.visibleArea <= 0 ) {

		throw new Error( `no visible render canvas intersects the viewport (${ count } canvas element(s) found)` );

	}
	return canvases.nth( selected.index );

}

export async function analyzePngFrames( page, firstPng, secondPng = null, options = {} ) {

	if ( ! firstPng || firstPng.length === 0 ) throw new TypeError( 'analyzePngFrames requires a non-empty first PNG' );
	if ( secondPng !== null && secondPng.length === 0 ) throw new TypeError( 'analyzePngFrames received an empty second PNG' );

	const {
		maxSamples = 250_000,
		contentColorDistance = 18,
		changedColorDistance = 9,
	} = options;
	if ( ! Number.isFinite( maxSamples ) || maxSamples < 1 ) throw new RangeError( 'maxSamples must be a positive finite number' );
	if ( ! Number.isFinite( contentColorDistance ) || contentColorDistance < 0 ) throw new RangeError( 'contentColorDistance must be finite and non-negative' );
	if ( ! Number.isFinite( changedColorDistance ) || changedColorDistance < 0 ) throw new RangeError( 'changedColorDistance must be finite and non-negative' );

	return page.evaluate( async ( input ) => {

		async function decode( base64 ) {

			const response = await fetch( `data:image/png;base64,${ base64 }` );
			if ( ! response.ok ) throw new Error( `PNG data URL failed to load (${ response.status })` );
			const bitmap = await createImageBitmap( await response.blob() );
			try {

				if ( bitmap.width < 1 || bitmap.height < 1 ) throw new Error( 'decoded PNG has no pixels' );
				const canvas = new OffscreenCanvas( bitmap.width, bitmap.height );
				const context = canvas.getContext( '2d', { willReadFrequently: true } );
				if ( ! context ) throw new Error( '2D canvas context unavailable while decoding PNG' );
				context.drawImage( bitmap, 0, 0 );
				return {
					width: bitmap.width,
					height: bitmap.height,
					data: context.getImageData( 0, 0, bitmap.width, bitmap.height ).data,
				};

			} finally {

				bitmap.close();

			}

		}

		const first = await decode( input.firstBase64 );
		const second = input.secondBase64 ? await decode( input.secondBase64 ) : null;
		if ( second && ( second.width !== first.width || second.height !== first.height ) ) {

			throw new Error( `decoded frame dimensions differ (${ first.width }x${ first.height } vs ${ second.width }x${ second.height })` );

		}

		const pixelCount = first.width * first.height;
		const sampleStep = Math.max( 1, Math.ceil( Math.sqrt( pixelCount / input.maxSamples ) ) );
		const cornerOffsets = [
			0,
			( first.width - 1 ) * 4,
			( ( first.height - 1 ) * first.width ) * 4,
			( pixelCount - 1 ) * 4,
		];
		const background = [ 0, 0, 0 ];
		for ( const offset of cornerOffsets ) {

			background[ 0 ] += first.data[ offset ];
			background[ 1 ] += first.data[ offset + 1 ];
			background[ 2 ] += first.data[ offset + 2 ];

		}
		background[ 0 ] /= cornerOffsets.length;
		background[ 1 ] /= cornerOffsets.length;
		background[ 2 ] /= cornerOffsets.length;

		let sampleCount = 0;
		let opaqueSamples = 0;
		let contentSamples = 0;
		let changedSamples = 0;
		let frameDeltaSum = 0;
		let luminanceSum = 0;
		let luminanceSquaredSum = 0;
		let minLuminance = Infinity;
		let maxLuminance = - Infinity;
		const channelSums = [ 0, 0, 0 ];
		const channelSquaredSums = [ 0, 0, 0 ];

		for ( let y = 0; y < first.height; y += sampleStep ) {

			for ( let x = 0; x < first.width; x += sampleStep ) {

				const offset = ( y * first.width + x ) * 4;
				const red = first.data[ offset ];
				const green = first.data[ offset + 1 ];
				const blue = first.data[ offset + 2 ];
				const alpha = first.data[ offset + 3 ];
				const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;

				channelSums[ 0 ] += red;
				channelSums[ 1 ] += green;
				channelSums[ 2 ] += blue;
				channelSquaredSums[ 0 ] += red * red;
				channelSquaredSums[ 1 ] += green * green;
				channelSquaredSums[ 2 ] += blue * blue;
				luminanceSum += luminance;
				luminanceSquaredSum += luminance * luminance;
				minLuminance = Math.min( minLuminance, luminance );
				maxLuminance = Math.max( maxLuminance, luminance );
				if ( alpha > 0 ) opaqueSamples ++;

				const backgroundDistance = Math.sqrt(
					( red - background[ 0 ] ) ** 2
					+ ( green - background[ 1 ] ) ** 2
					+ ( blue - background[ 2 ] ) ** 2,
				);
				if ( backgroundDistance >= input.contentColorDistance ) contentSamples ++;

				if ( second ) {

					const frameDelta = Math.abs( red - second.data[ offset ] )
						+ Math.abs( green - second.data[ offset + 1 ] )
						+ Math.abs( blue - second.data[ offset + 2 ] );
					frameDeltaSum += frameDelta / 3;
					if ( frameDelta >= input.changedColorDistance ) changedSamples ++;

				}
				sampleCount ++;

			}

		}

		const denominator = Math.max( 1, sampleCount );
		const luminanceMean = luminanceSum / denominator;
		const channelVariance = channelSums.reduce( ( total, sum, index ) => {

			const mean = sum / denominator;
			return total + Math.max( 0, channelSquaredSums[ index ] / denominator - mean * mean );

		}, 0 ) / 3;
		const luminanceVariance = Math.max( 0, luminanceSquaredSum / denominator - luminanceMean * luminanceMean );
		return {
			width: first.width,
			height: first.height,
			pixelCount,
			sampleCount,
			sampleStep,
			backgroundRgb: background,
			opaqueFraction: opaqueSamples / denominator,
			contentFraction: contentSamples / denominator,
			rgbDeviation: Math.sqrt( channelVariance ),
			luminanceMean,
			luminanceDeviation: Math.sqrt( luminanceVariance ),
			luminanceRange: maxLuminance - minLuminance,
			framesCompared: Boolean( second ),
			changedFraction: second ? changedSamples / denominator : null,
			meanFrameDelta: second ? frameDeltaSum / denominator : null,
		};

	}, {
		firstBase64: Buffer.from( firstPng ).toString( 'base64' ),
		secondBase64: secondPng === null ? null : Buffer.from( secondPng ).toString( 'base64' ),
		maxSamples,
		contentColorDistance,
		changedColorDistance,
	} );

}

export function visualEvidenceFailures( evidence, thresholds = {} ) {

	const {
		minSampleCount = 64,
		minRgbDeviation = 4,
		minLuminanceDeviation = 2,
		minContentFraction = 0.005,
		minChangedFraction = null,
		minMeanFrameDelta = null,
	} = thresholds;
	const failures = [];
	for ( const [ name, value ] of Object.entries( {
		minSampleCount,
		minRgbDeviation,
		minLuminanceDeviation,
		minContentFraction,
		minChangedFraction,
		minMeanFrameDelta,
	} ) ) {

		if ( value !== null && ( ! Number.isFinite( value ) || value < 0 ) ) {

			failures.push( `visual threshold ${ name } must be finite and non-negative` );

		}

	}
	if ( ! evidence || typeof evidence !== 'object' ) return [ 'decoded pixel evidence is missing' ];

	const finiteMetrics = [
		'width',
		'height',
		'pixelCount',
		'sampleCount',
		'rgbDeviation',
		'luminanceDeviation',
		'luminanceRange',
		'contentFraction',
	];
	for ( const name of finiteMetrics ) {

		if ( ! Number.isFinite( evidence[ name ] ) ) failures.push( `decoded pixel metric ${ name } is not finite` );

	}
	if ( ! Number.isFinite( evidence.sampleCount ) || evidence.sampleCount < minSampleCount ) {

		failures.push( `decoded pixel sample count ${ String( evidence.sampleCount ) } is below ${ minSampleCount }` );

	}
	if ( Number.isFinite( evidence.rgbDeviation ) && evidence.rgbDeviation < minRgbDeviation ) {

		failures.push( `canvas RGB deviation ${ evidence.rgbDeviation.toFixed( 3 ) } is below ${ minRgbDeviation }` );

	}
	if ( Number.isFinite( evidence.luminanceDeviation ) && evidence.luminanceDeviation < minLuminanceDeviation ) {

		failures.push( `canvas luminance deviation ${ evidence.luminanceDeviation.toFixed( 3 ) } is below ${ minLuminanceDeviation }` );

	}
	if ( Number.isFinite( evidence.contentFraction ) && evidence.contentFraction < minContentFraction ) {

		failures.push( `canvas content fraction ${ evidence.contentFraction.toFixed( 4 ) } is below ${ minContentFraction }` );

	}

	const motionRequired = minChangedFraction !== null || minMeanFrameDelta !== null;
	if ( motionRequired && evidence.framesCompared !== true ) {

		failures.push( 'decoded motion evidence is missing a second frame' );

	}
	if ( minChangedFraction !== null ) {

		if ( ! Number.isFinite( evidence.changedFraction ) ) failures.push( 'decoded pixel metric changedFraction is not finite' );
		else if ( evidence.changedFraction < minChangedFraction ) failures.push(
			`changed pixel fraction ${ evidence.changedFraction.toFixed( 4 ) } is below ${ minChangedFraction }`,
		);

	}
	if ( minMeanFrameDelta !== null ) {

		if ( ! Number.isFinite( evidence.meanFrameDelta ) ) failures.push( 'decoded pixel metric meanFrameDelta is not finite' );
		else if ( evidence.meanFrameDelta < minMeanFrameDelta ) failures.push(
			`mean decoded frame delta ${ evidence.meanFrameDelta.toFixed( 4 ) } is below ${ minMeanFrameDelta }`,
		);

	}
	return failures;

}
