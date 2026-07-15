import { readFileSync } from 'node:fs';

import { PNG } from 'pngjs';

const COVERAGE_CONFIG_URL = new URL( './coverage-config.json', import.meta.url );

export function readCoverageConfig() {

	return JSON.parse( readFileSync( COVERAGE_CONFIG_URL, 'utf8' ) );

}

export const coverageConfig = readCoverageConfig();

export function psnrIgnoreRegionsForExample( name, config = coverageConfig ) {

	return config.pixelGate?.ignoreRegions?.[ name ] || [];

}

export function pixelGateDisabledReasonForExample( name, config = coverageConfig ) {

	const disabled = config.pixelGate?.disabled || {};
	for ( const [ reason, examples ] of Object.entries( disabled ) ) {

		if ( Array.isArray( examples ) && examples.includes( name ) ) return reason;

	}
	return null;

}

export function tierExamples( tierName, config = coverageConfig ) {

	const examples = config.pixelGate?.tiers?.[ tierName ];
	return Array.isArray( examples ) ? examples.slice() : [];

}

export function captureWaitOverrideForExample( name, config = coverageConfig ) {

	const override = config.pixelGate?.captureWaitOverrides?.[ name ];
	return typeof override === 'number' && override > 0 ? override : 0;

}

export function psnrThresholdForExample( name, defaultThreshold, config = coverageConfig ) {

	const override = config.pixelGate?.psnrThresholdOverrides?.[ name ];
	return typeof override === 'number' && override > 0 ? override : defaultThreshold;

}

export function minimumBrightFractionForExample( name, defaultMinimum, config = coverageConfig ) {

	const override = config.pixelGate?.minimumBrightFractionOverrides?.[ name ];
	return typeof override === 'number' && Number.isFinite( override ) && override >= 0 ? override : defaultMinimum;

}

export function expectedReplayErrorPatternsForExample( name, config = coverageConfig ) {

	const patterns = config.pixelGate?.expectedReplayErrors?.[ name ];
	if ( ! Array.isArray( patterns ) ) return [];
	return patterns.map( ( p ) => {
		try { return new RegExp( p ); } catch ( _ ) { return null; }
	} ).filter( Boolean );

}

export function decodePngBuffer( buffer ) {

	const png = PNG.sync.read( buffer );
	return { width: png.width, height: png.height, data: png.data };

}

export function comparePngFiles( capturePath, replayPath, opts = {} ) {

	return comparePngBuffers( readFileSync( capturePath ), readFileSync( replayPath ), opts );

}

export function comparePngBuffers( captureBuffer, replayBuffer, opts = {} ) {

	if ( ! captureBuffer || ! replayBuffer ) return { error: 'missing screenshot' };
	const name = opts.name || '';
	const round = opts.round !== false;
	const ignoreRegions = Array.isArray( opts.ignoreRegions )
		? opts.ignoreRegions
		: psnrIgnoreRegionsForExample( name, opts.config || coverageConfig );

	try {

		const a = decodePngBuffer( captureBuffer );
		const b = decodePngBuffer( replayBuffer );
		if ( a.width !== b.width || a.height !== b.height ) {

			return { error: `dim mismatch capture=${ a.width }x${ a.height } replay=${ b.width }x${ b.height }`, width: a.width, height: a.height };

		}

		const isIgnored = ( x, y ) => ignoreRegions.some( ( region ) => (
			x >= region.x && y >= region.y &&
			x < region.x + region.width && y < region.y + region.height
		) );

		let sumSq = 0;
		let comparedPixels = 0;
		for ( let i = 0, pxIndex = 0; i < a.data.length; i += 4, pxIndex ++ ) {

			const x = pxIndex % a.width;
			const y = Math.floor( pxIndex / a.width );
			if ( isIgnored( x, y ) ) continue;

			const dr = a.data[ i ] - b.data[ i ];
			const dg = a.data[ i + 1 ] - b.data[ i + 1 ];
			const db = a.data[ i + 2 ] - b.data[ i + 2 ];
			sumSq += dr * dr + dg * dg + db * db;
			comparedPixels ++;

		}

		const mse = comparedPixels === 0 ? 0 : sumSq / ( comparedPixels * 3 );
		const psnr = mse === 0 ? Infinity : 10 * Math.log10( ( 255 * 255 ) / mse );
		return {
			psnr: psnr === Infinity ? 'inf' : ( round ? +psnr.toFixed( 2 ) : psnr ),
			width: a.width,
			height: a.height,
			ignoredRegions: ignoreRegions,
		};

	} catch ( err ) {

		return { error: err && err.message || String( err ) };

	}

}
