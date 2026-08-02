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
const TEMPORAL_FRAME_COORDINATION = Symbol.for( '@tsl-precompile/runtime/temporal-frame-coordination@1' );

function createTemporalFrameCoordination() {

	return {
		version: 1,
		activeScopes: new WeakMap(),
		invokingScopes: [],
	};

}

function sharedTemporalFrameCoordination() {

	const root = typeof globalThis !== 'undefined' ? globalThis : null;
	if ( ! root ) return createTemporalFrameCoordination();
	const existing = root[ TEMPORAL_FRAME_COORDINATION ];
	if (
		existing &&
		existing.version === 1 &&
		existing.activeScopes instanceof WeakMap &&
		Array.isArray( existing.invokingScopes )
	) return existing;

	const coordination = createTemporalFrameCoordination();
	Object.defineProperty( root, TEMPORAL_FRAME_COORDINATION, {
		value: coordination,
	});
	return coordination;

}

// Prebuilt slim and source runtime modules can be separate ESM instances in
// one realm. The visible renderer state already uses Symbol.for(); scope
// ownership must share the same lifetime or duplicate modules can settle each
// other's descriptors out of order and leave a stale logical frame installed.
const TEMPORAL_FRAME_COORDINATION_STATE = sharedTemporalFrameCoordination();
const ACTIVE_TEMPORAL_SCOPES = TEMPORAL_FRAME_COORDINATION_STATE.activeScopes;
const INVOKING_TEMPORAL_SCOPES = TEMPORAL_FRAME_COORDINATION_STATE.invokingScopes;

export class TemporalFrameIdentityError extends Error {

	constructor( message ) {

		super( message );
		this.name = 'TemporalFrameIdentityError';
		this.code = 'TSLP_TEMPORAL_FRAME_IDENTITY_MISSING';

	}

}

function rendererFrom( value ) {

	if ( value && value.renderer ) return value.renderer;
	return value || null;

}

function overlapError() {

	const error = new Error( 'withTemporalFrame: overlapping async scopes on the same renderer are unsupported. Await the active scope before starting another.' );
	error.name = 'TemporalFrameOverlapError';
	error.code = 'TSLP_TEMPORAL_FRAME_OVERLAP';
	return error;

}

function restoreDescriptor( renderer, descriptor ) {

	if ( descriptor ) Object.defineProperty( renderer, TEMPORAL_FRAME_STATE, descriptor );
	else delete renderer[ TEMPORAL_FRAME_STATE ];

}

function settleTemporalScope( scope ) {

	if ( scope.settled ) return;
	scope.settled = true;
	for ( const entry of scope.entries ) entry.settled = true;

	for ( const entry of scope.entries ) {

		if ( ACTIVE_TEMPORAL_SCOPES.get( entry.renderer ) !== entry ) continue;
		let active = entry;
		let restore = entry.previousDescriptor;
		while ( active && active.settled ) {

			restore = active.previousDescriptor;
			active = active.previousEntry;

		}
		if ( active ) {

			ACTIVE_TEMPORAL_SCOPES.set( entry.renderer, active );
			Object.defineProperty( entry.renderer, TEMPORAL_FRAME_STATE, {
				value: active.scope.state,
				configurable: true,
				writable: true,
			} );

		} else {

			ACTIVE_TEMPORAL_SCOPES.delete( entry.renderer );
			restoreDescriptor( entry.renderer, restore );

		}

	}

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
 * Build the canonical frame object passed to TSL `updateBefore()` handlers.
 * Logical IDs always come from the renderer's active temporal scope; callers
 * may only supply live time/context values for the node invocation itself.
 *
 * @param {Object} renderer
 * @param {{ time?: number|null, context?: Object }} overrides
 * @return {{ renderer:Object, frameId:number|string, renderId:number|string, time:number|null, context:Object }}
 */
export function createTemporalNodeFrame( renderer, overrides = {} ) {

	const state = getTemporalFrameState( renderer );
	const frameId = state && state.frameId;
	const renderId = state && state.renderId;
	if ( frameId === undefined || frameId === null || renderId === undefined || renderId === null ) {

		throw new TemporalFrameIdentityError( 'createTemporalNodeFrame: an active temporal scope with both frameId and renderId is required.' );

	}
	return {
		renderer,
		frameId,
		renderId,
		time: overrides.time !== undefined ? overrides.time : state.time,
		context: overrides && overrides.context && typeof overrides.context === 'object' ? overrides.context : {},
	};

}

/**
 * Run sync or async fallback work under one logical temporal frame.
 * Renderer state is restored exactly, including nested scopes and failures.
 *
 * @param {Object|Object[]} renderers
 * @param {{ frameId?: number|string, renderId?: number|string, time?: number, advance?: boolean }} options
 * @param {Function} callback
 * @return {*|Promise<*>}
 */
export function withTemporalFrame( renderers, options = {}, callback ) {

	if ( typeof callback !== 'function' ) throw new TypeError( 'withTemporalFrame: callback must be a function.' );
	const list = ( Array.isArray( renderers ) ? renderers : [ renderers ] )
		.filter( ( renderer, index, all ) => renderer && ( typeof renderer === 'object' || typeof renderer === 'function' ) && all.indexOf( renderer ) === index );
	for ( const renderer of list ) {

		const active = ACTIVE_TEMPORAL_SCOPES.get( renderer );
		if ( active && ! INVOKING_TEMPORAL_SCOPES.includes( active.scope ) ) throw overlapError();

	}
	const state = {
		frameId: options.frameId,
		renderId: options.renderId !== undefined && options.renderId !== null ? options.renderId : options.frameId,
		time: Number.isFinite( options.time ) ? options.time : null,
		advance: options.advance !== false,
	};
	const scope = { state, entries: [], settled: false };
	try {

		for ( const renderer of list ) {

			const entry = {
				renderer,
				scope,
				previousEntry: ACTIVE_TEMPORAL_SCOPES.get( renderer ) || null,
				previousDescriptor: Object.getOwnPropertyDescriptor( renderer, TEMPORAL_FRAME_STATE ),
				settled: false,
			};
			Object.defineProperty( renderer, TEMPORAL_FRAME_STATE, {
				value: state,
				configurable: true,
				writable: true,
			} );
			scope.entries.push( entry );
			ACTIVE_TEMPORAL_SCOPES.set( renderer, entry );

		}

	} catch ( error ) {

		settleTemporalScope( scope );
		throw error;

	}
	let result;
	INVOKING_TEMPORAL_SCOPES.push( scope );
	try {

		result = callback( state );

	} catch ( error ) {

		settleTemporalScope( scope );
		throw error;

	} finally {

		const index = INVOKING_TEMPORAL_SCOPES.lastIndexOf( scope );
		if ( index >= 0 ) INVOKING_TEMPORAL_SCOPES.splice( index, 1 );

	}
	let isThenable;
	try {

		isThenable = !! ( result && typeof result.then === 'function' );

	} catch ( error ) {

		settleTemporalScope( scope );
		throw error;

	}
	if ( isThenable ) return Promise.resolve( result ).finally( () => settleTemporalScope( scope ) );
	settleTemporalScope( scope );
	return result;

}
