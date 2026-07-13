/**
 * Dev-only adapters around Three's private NodeManager.getForRender and
 * RenderObjects.get seams.
 *
 * All consumers subscribe through one Symbol-backed wrapper so live capture,
 * compileTSL, duplicate plugin copies, and HMR cannot stack competing method
 * replacements. The original return value is passed through unchanged.
 */

const OBSERVER_STATE = Symbol.for( '@tsl-precompile/plugin/render-object-observer@1' );
const REQUEST_OBSERVER_STATE = Symbol.for( '@tsl-precompile/plugin/render-object-request-observer@1' );

/**
 * @param {Object} renderer
 * @param {(event: { renderObject: Object, cacheKey: *, nodeBuilderState: * }) => void} listener
 * @returns {() => void}
 */
export function observeRenderObjects( renderer, listener ) {

	if ( typeof listener !== 'function' ) throw new TypeError( 'observeRenderObjects: listener must be a function.' );
	const manager = renderer && renderer._nodes;
	if ( ! manager || typeof manager.getForRender !== 'function' ) return () => {};

	let state = manager[ OBSERVER_STATE ];
	if ( ! state || state.version !== 1 || manager.getForRender !== state.wrapper ) {

		const original = manager.getForRender;
		state = {
			version: 1,
			original,
			listeners: new Set(),
			wrapper: null,
		};
		state.wrapper = function observedGetForRender( renderObject, ...args ) {

			let cacheKey = null;
			if ( typeof this.getForRenderCacheKey === 'function' ) {

				try { cacheKey = this.getForRenderCacheKey( renderObject ); } catch ( _ ) {}

			}
			const nodeBuilderState = state.original.call( this, renderObject, ...args );
			const event = { renderObject, cacheKey, nodeBuilderState };
			for ( const subscriber of [ ...state.listeners ] ) {

				// Instrumentation must never turn a successful Three render into a
				// failure. Capture consumers surface their own diagnostics later.
				try { subscriber( event ); } catch ( _ ) {}

			}
			return nodeBuilderState;

		};
		Object.defineProperty( manager, OBSERVER_STATE, {
			value: state,
			configurable: true,
		} );
		manager.getForRender = state.wrapper;

	}

	state.listeners.add( listener );
	let active = true;
	return () => {

		if ( ! active ) return;
		active = false;
		state.listeners.delete( listener );
		if ( state.listeners.size > 0 ) return;
		if ( manager.getForRender === state.wrapper ) manager.getForRender = state.original;
		if ( manager[ OBSERVER_STATE ] === state ) {

			try { delete manager[ OBSERVER_STATE ]; } catch ( _ ) {}

		}

	};

}

/**
 * Observe every renderer request for a RenderObject, including an object whose
 * NodeBuilderState is already cached and therefore no longer flows through
 * NodeManager.getForRender. This is needed to correlate Three's private output
 * quad with its exact accumulated cache entry without invalidating pipelines.
 *
 * @param {Object} renderer
 * @param {(event: { renderObject: Object, cacheKey: *, nodeBuilderState: * }) => void} listener
 * @returns {() => void}
 */
export function observeRenderObjectRequests( renderer, listener ) {

	if ( typeof listener !== 'function' ) throw new TypeError( 'observeRenderObjectRequests: listener must be a function.' );
	const renderObjects = renderer && renderer._objects;
	const manager = renderer && renderer._nodes;
	if ( ! renderObjects || typeof renderObjects.get !== 'function' ||
		! manager || typeof manager.getForRenderCacheKey !== 'function' ) return () => {};

	let state = renderObjects[ REQUEST_OBSERVER_STATE ];
	if ( ! state || state.version !== 1 || renderObjects.get !== state.wrapper ) {

		const original = renderObjects.get;
		state = {
			version: 1,
			original,
			listeners: new Set(),
			wrapper: null,
		};
		state.wrapper = function observedRenderObjectRequest( ...args ) {

			const renderObject = state.original.apply( this, args );
			let cacheKey = null;
			try { cacheKey = manager.getForRenderCacheKey( renderObject ); } catch ( _ ) {}
			const event = {
				renderObject,
				cacheKey,
				nodeBuilderState: renderObject && renderObject._nodeBuilderState || null,
			};
			for ( const subscriber of [ ...state.listeners ] ) {

				try { subscriber( event ); } catch ( _ ) {}

			}
			return renderObject;

		};
		Object.defineProperty( renderObjects, REQUEST_OBSERVER_STATE, {
			value: state,
			configurable: true,
		} );
		renderObjects.get = state.wrapper;

	}

	state.listeners.add( listener );
	let active = true;
	return () => {

		if ( ! active ) return;
		active = false;
		state.listeners.delete( listener );
		if ( state.listeners.size > 0 ) return;
		if ( renderObjects.get === state.wrapper ) renderObjects.get = state.original;
		if ( renderObjects[ REQUEST_OBSERVER_STATE ] === state ) {

			try { delete renderObjects[ REQUEST_OBSERVER_STATE ]; } catch ( _ ) {}

		}

	};

}
