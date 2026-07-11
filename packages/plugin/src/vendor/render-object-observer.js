/**
 * Dev-only adapter around Three's private NodeManager.getForRender seam.
 *
 * All consumers subscribe through one Symbol-backed wrapper so live capture,
 * compileTSL, duplicate plugin copies, and HMR cannot stack competing method
 * replacements. The original return value is passed through unchanged.
 */

const OBSERVER_STATE = Symbol.for( '@tsl-precompile/plugin/render-object-observer@1' );

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
