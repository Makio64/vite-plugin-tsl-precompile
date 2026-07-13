/**
 * Logical-frame ownership shared by slim and full-renderer fallback work.
 *
 * Three's renderer frameId advances for every render call, including shadow,
 * loader-refresh, pass, and effect renders. Temporal resources instead need an
 * application-frame key: all work for one visible frame must observe the same
 * previous/current history, and maintenance renders must be able to opt out of
 * advancing it entirely.
 */

const TEMPORAL_FRAME_STATE = Symbol.for( '@tsl-precompile/runtime/temporal-frame@1' );

function rendererFrom( value ) {

	if ( value && value.renderer ) return value.renderer;
	return value || null;

}

export function getTemporalFrameState( value ) {

	const renderer = rendererFrom( value );
	return renderer && renderer[ TEMPORAL_FRAME_STATE ] || null;

}

export function logicalFrameKey( frame, fallback = 0 ) {

	const state = getTemporalFrameState( frame );
	if ( state && state.frameId !== undefined && state.frameId !== null ) return state.frameId;
	if ( frame && frame.__tslpLogicalFrameId !== undefined && frame.__tslpLogicalFrameId !== null ) return frame.__tslpLogicalFrameId;
	if ( frame && Number.isFinite( frame.frameId ) ) return frame.frameId;
	if ( frame && Number.isFinite( frame.renderId ) ) return frame.renderId;
	return fallback;

}

export function shouldAdvanceTemporalState( frame ) {

	const state = getTemporalFrameState( frame );
	if ( state && state.advance === false ) return false;
	if ( frame && frame.__tslpAdvanceTemporal === false ) return false;
	const root = typeof globalThis !== 'undefined' ? globalThis : null;
	if ( root && root.__tslpSuppressVelocityStateAdvance === true ) return false;
	const renderer = rendererFrom( frame );
	if ( renderer && renderer.__tslpSuppressVelocityStateAdvance === true ) return false;
	return true;

}

/**
 * Run sync or async fallback work under one logical temporal frame.
 * Renderer state is restored exactly, including nested scopes and failures.
 *
 * @param {Object|Object[]} renderers
 * @param {{ frameId?: number|string, time?: number, advance?: boolean }} options
 * @param {Function} callback
 * @return {*|Promise<*>}
 */
export function withTemporalFrame( renderers, options = {}, callback ) {

	if ( typeof callback !== 'function' ) throw new TypeError( 'withTemporalFrame: callback must be a function.' );
	const list = ( Array.isArray( renderers ) ? renderers : [ renderers ] )
		.filter( ( renderer, index, all ) => renderer && ( typeof renderer === 'object' || typeof renderer === 'function' ) && all.indexOf( renderer ) === index );
	const state = {
		frameId: options.frameId,
		time: Number.isFinite( options.time ) ? options.time : null,
		advance: options.advance !== false,
	};
	const previous = list.map( ( renderer ) => ( {
		renderer,
		descriptor: Object.getOwnPropertyDescriptor( renderer, TEMPORAL_FRAME_STATE ),
	} ) );
	for ( const renderer of list ) {

		Object.defineProperty( renderer, TEMPORAL_FRAME_STATE, {
			value: state,
			configurable: true,
			writable: true,
		} );

	}
	let restored = false;
	const restore = () => {

		if ( restored ) return;
		restored = true;
		for ( const entry of previous ) {

			if ( entry.descriptor ) Object.defineProperty( entry.renderer, TEMPORAL_FRAME_STATE, entry.descriptor );
			else delete entry.renderer[ TEMPORAL_FRAME_STATE ];

		}

	};
	let result;
	try {

		result = callback( state );

	} catch ( error ) {

		restore();
		throw error;

	}
	if ( result && typeof result.then === 'function' ) return Promise.resolve( result ).finally( restore );
	restore();
	return result;

}
