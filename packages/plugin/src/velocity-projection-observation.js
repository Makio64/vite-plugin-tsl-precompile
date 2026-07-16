const VELOCITY_PROJECTION_SOURCES = Symbol.for(
	'@tsl-precompile/plugin/velocity-projection-sources@1',
);

const observedPromises = new WeakSet();

/**
 * Remember explicit VelocityNode projection objects while a RenderObject is
 * active. TRAA clears `VelocityNode.projectionMatrix` after the pass, but its
 * anonymous UniformNode retains the same object inside NodeBuilderState.
 */
export function observeVelocityProjectionSources( nodeBuilderState ) {

	try {

		observeVelocityProjectionSourcesUnsafe( nodeBuilderState );

	} catch ( _ ) {}
	return nodeBuilderState;

}

function observeVelocityProjectionSourcesUnsafe( nodeBuilderState ) {

	if ( ! nodeBuilderState || ( typeof nodeBuilderState !== 'object' && typeof nodeBuilderState !== 'function' ) ) return nodeBuilderState;
	if ( typeof nodeBuilderState.then === 'function' ) {

		if ( ! observedPromises.has( nodeBuilderState ) ) {

			observedPromises.add( nodeBuilderState );
			Promise.resolve( nodeBuilderState ).then( observeVelocityProjectionSources, () => {} );

		}
		return;

	}
	let sources = nodeBuilderState[ VELOCITY_PROJECTION_SOURCES ];
	for ( const node of velocityLifecycleNodes( nodeBuilderState ) ) {

		const projectionMatrix = node && node.constructor && node.constructor.type === 'VelocityNode'
			? node.projectionMatrix
			: null;
		if ( ! projectionMatrix || ( typeof projectionMatrix !== 'object' && typeof projectionMatrix !== 'function' ) ) continue;
		if ( ! sources ) {

			sources = new WeakSet();
			try {

				Object.defineProperty( nodeBuilderState, VELOCITY_PROJECTION_SOURCES, {
					value: sources,
					configurable: true,
				} );

			} catch ( _ ) {

				return;

			}

		}
		sources.add( projectionMatrix );

	}
}

export function isObservedVelocityProjectionSource( nodeBuilderState, value ) {

	if ( ! nodeBuilderState || ! value || ( typeof value !== 'object' && typeof value !== 'function' ) ) return false;
	const sources = nodeBuilderState[ VELOCITY_PROJECTION_SOURCES ];
	return !! sources && typeof sources.has === 'function' && sources.has( value );

}

function velocityLifecycleNodes( state ) {

	return [
		...( Array.isArray( state.updateNodes ) ? state.updateNodes : [] ),
		...( Array.isArray( state.updateBeforeNodes ) ? state.updateBeforeNodes : [] ),
		...( Array.isArray( state.updateAfterNodes ) ? state.updateAfterNodes : [] ),
	];

}
