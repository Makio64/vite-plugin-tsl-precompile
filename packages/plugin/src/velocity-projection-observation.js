const VELOCITY_PROJECTION_SOURCES = Symbol.for(
	'@tsl-precompile/plugin/velocity-projection-sources@1',
);
const VELOCITY_PROJECTION_SOURCE_VALUES = Symbol.for(
	'@tsl-precompile/plugin/velocity-projection-source-values@1',
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
	let sourceValues = nodeBuilderState[ VELOCITY_PROJECTION_SOURCE_VALUES ];
	for ( const node of velocityLifecycleNodes( nodeBuilderState ) ) {

		const projectionMatrix = node && node.constructor && node.constructor.type === 'VelocityNode'
			? node.projectionMatrix
			: null;
		if ( ! projectionMatrix || ( typeof projectionMatrix !== 'object' && typeof projectionMatrix !== 'function' ) ) continue;
		if ( ! sources ) {

			sources = new WeakSet();
			sourceValues = [];
			try {

				Object.defineProperty( nodeBuilderState, VELOCITY_PROJECTION_SOURCES, {
					value: sources,
					configurable: true,
				} );
				Object.defineProperty( nodeBuilderState, VELOCITY_PROJECTION_SOURCE_VALUES, {
					value: sourceValues,
					configurable: true,
				} );

			} catch ( _ ) {

				return;

			}

		}
		if ( ! sources.has( projectionMatrix ) ) {

			sources.add( projectionMatrix );
			sourceValues.push( projectionMatrix );

		}

	}
}

export function isObservedVelocityProjectionSource( nodeBuilderState, value ) {

	if ( ! nodeBuilderState || ! value || ( typeof value !== 'object' && typeof value !== 'function' ) ) return false;
	const sources = nodeBuilderState[ VELOCITY_PROJECTION_SOURCES ];
	return !! sources && typeof sources.has === 'function' && sources.has( value );

}

/**
 * Enumerate exact projection identities previously observed on a state.
 *
 * The WeakSet remains the primary local membership index. This bounded array
 * exists so a completed render-object harvest can carry request-time evidence
 * into extraction even when Three replaces or clears the live VelocityNode.
 */
export function observedVelocityProjectionSources( nodeBuilderState ) {

	if ( ! nodeBuilderState || ( typeof nodeBuilderState !== 'object' && typeof nodeBuilderState !== 'function' ) ) return [];
	const values = nodeBuilderState[ VELOCITY_PROJECTION_SOURCE_VALUES ];
	return Array.isArray( values ) ? values.slice() : [];

}

function velocityLifecycleNodes( state ) {

	return [
		...( Array.isArray( state.updateNodes ) ? state.updateNodes : [] ),
		...( Array.isArray( state.updateBeforeNodes ) ? state.updateBeforeNodes : [] ),
		...( Array.isArray( state.updateAfterNodes ) ? state.updateAfterNodes : [] ),
	];

}
