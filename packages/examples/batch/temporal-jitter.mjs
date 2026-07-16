// Three r184 builds 32 Halton offsets but advances modulo `length - 1`, so
// indices 0..30 are the active sequence used by TRAA and TAAU.
const DEFAULT_ACTIVE_JITTER_SAMPLES = 31;

function normalizedFrameId( value ) {

	const tick = Number( value );
	return Number.isFinite( tick ) ? Math.max( 0, Math.trunc( tick ) ) : 0;

}

function normalizedSampleCount( value ) {

	const count = Number( value );
	return Number.isInteger( count ) && count > 0 ? count : DEFAULT_ACTIVE_JITTER_SAMPLES;

}

/**
 * Map a one-based logical application-frame ID to Three's zero-based temporal
 * jitter sample. Frame zero covers setup renders before the first callback;
 * frame one uses the first Halton sample.
 */
export function temporalJitterIndexForFrameId( frameId, activeSampleCount = DEFAULT_ACTIVE_JITTER_SAMPLES ) {

	const frame = normalizedFrameId( frameId );
	const count = normalizedSampleCount( activeSampleCount );
	return Math.max( 0, frame - 1 ) % count;

}

export function temporalJitterFrameId( root = globalThis ) {

	const callbackCount = root && root.__tslpFrameCallbackCount | 0;
	if ( callbackCount > 0 ) return callbackCount;
	const animationLoopCalls = root && root.__tslpAnimationLoopCalls | 0;
	if ( animationLoopCalls > 0 ) return animationLoopCalls;
	return root && root.__tslpRafTick | 0;

}

function currentTemporalJitterIndex( root, activeSampleCount ) {

	return temporalJitterIndexForFrameId( temporalJitterFrameId( root ), activeSampleCount );

}

function temporalJitterDiagnostics( root ) {

	if ( ! root ) return null;
	const diagnostics = root.__tslpHarnessDiagnostics || ( root.__tslpHarnessDiagnostics = {} );
	return diagnostics.temporalJitter || ( diagnostics.temporalJitter = {
		setViewOffsetCalls: 0,
		clearViewOffsetCalls: 0,
		samples: [],
	} );

}

function recordTemporalJitterSample( root, node, index, frameId ) {

	const temporal = temporalJitterDiagnostics( root );
	if ( ! temporal ) return;
	const type = node && node.constructor && ( node.constructor.type || node.constructor.name ) || node && node.type || 'TemporalNode';
	const sample = { type, frameId: normalizedFrameId( frameId ), index };
	const previous = temporal.samples[ temporal.samples.length - 1 ];
	if ( temporal.samples.length < 128 && ( ! previous || previous.type !== type || previous.frameId !== sample.frameId || previous.index !== sample.index ) ) {
		temporal.samples.push( sample );
	}

}

/**
 * Keep a Three temporal-AA node on the Halton sample owned by the current
 * synthetic application frame. Three advances `_jitterIndex` in
 * `clearViewOffset()`, so restore the logical-frame sample after the original
 * clear instead of allowing extra pipeline or maintenance renders to advance
 * history.
 */
export function synchronizeTemporalJitterNode( node, options = {} ) {

	if ( ! node ) return false;
	const marker = typeof options.marker === 'string' && options.marker.length > 0
		? options.marker
		: '__tslpTemporalJitterSynchronized';
	if ( node[ marker ] === true ) return false;
	const root = options.root || globalThis;
	const activeSampleCount = normalizedSampleCount( options.activeSampleCount );
	const proto = Object.getPrototypeOf( node );
	const originalSetViewOffset = node.setViewOffset || ( proto && proto.setViewOffset );
	const originalClearViewOffset = node.clearViewOffset || ( proto && proto.clearViewOffset );
	const sync = ( target ) => {

		const index = currentTemporalJitterIndex( root, activeSampleCount );
		target._jitterIndex = index;
		return index;

	};
	if ( typeof originalSetViewOffset === 'function' ) {

		node.setViewOffset = function ( ...args ) {

			const index = sync( this );
			const diagnostics = temporalJitterDiagnostics( root );
			if ( diagnostics ) diagnostics.setViewOffsetCalls ++;
			recordTemporalJitterSample( root, this, index, temporalJitterFrameId( root ) );
			return originalSetViewOffset.apply( this, args );

		};

	}
	if ( typeof originalClearViewOffset === 'function' ) {

		node.clearViewOffset = function ( ...args ) {

			try {

				return originalClearViewOffset.apply( this, args );

			} finally {

				sync( this );
				const diagnostics = temporalJitterDiagnostics( root );
				if ( diagnostics ) diagnostics.clearViewOffsetCalls ++;

			}

		};

	}
	sync( node );
	try {

		Object.defineProperty( node, marker, { value: true, configurable: true } );

	} catch ( _ ) {

		node[ marker ] = true;

	}
	return true;

}

export { DEFAULT_ACTIVE_JITTER_SAMPLES };
