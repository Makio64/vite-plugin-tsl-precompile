export const COMPARISON_SIDE = Object.freeze( {
	CAPTURE: 'capture',
	REPLAY: 'replay',
} );

export function clampComparisonPosition( value, fallback = 50 ) {

	if ( ! Number.isFinite( value ) ) return fallback;
	return Math.max( 0, Math.min( 100, value ) );

}

export function comparisonValueText( value ) {

	const livePercent = Math.round( clampComparisonPosition( value ) );
	const replayPercent = 100 - livePercent;
	if ( livePercent === 0 ) return 'All slim replay; live three.js is hidden';
	if ( livePercent === 100 ) return 'All live three.js; slim replay is hidden';
	return `${ livePercent }% live three.js on the left; ${ replayPercent }% slim replay on the right`;

}

export function comparisonImageAlt( displayName, side ) {

	const name = String( displayName || '' ).trim() || 'Selected example';
	if ( side === COMPARISON_SIDE.CAPTURE ) return `${ name }: live three.js reference frame`;
	if ( side === COMPARISON_SIDE.REPLAY ) return `${ name }: precompiled slim replay frame`;
	throw new Error( `Unknown comparison side: ${ side }` );

}

export function resolveSoloFrame( preferredSide, { captureSrc = null, replaySrc = null } = {} ) {

	if ( preferredSide !== COMPARISON_SIDE.CAPTURE && preferredSide !== COMPARISON_SIDE.REPLAY ) {

		throw new Error( `Unknown preferred comparison side: ${ preferredSide }` );

	}
	const preferredSrc = preferredSide === COMPARISON_SIDE.REPLAY ? replaySrc : captureSrc;
	if ( preferredSrc ) return { side: preferredSide, src: preferredSrc };
	if ( replaySrc ) return { side: COMPARISON_SIDE.REPLAY, src: replaySrc };
	if ( captureSrc ) return { side: COMPARISON_SIDE.CAPTURE, src: captureSrc };
	return { side: null, src: null };

}
