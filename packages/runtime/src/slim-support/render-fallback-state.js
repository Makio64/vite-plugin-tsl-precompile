/**
 * Convert a full-renderer NodeBuilderState or legacy raw NodeBuilder into the
 * dual state/builder surface consumed by replay and older rewritten managers.
 */

import BindGroup from 'three/src/renderers/common/BindGroup.js';

export function normalizeSlimRenderFallbackState( state ) {

	if ( ! state || typeof state !== 'object' ) return null;
	const isRawBuilder = typeof state.createBindings !== 'function' && typeof state.build === 'function';
	if ( isRawBuilder ) state.build();

	const nodeAttributes = Array.isArray( state.nodeAttributes )
		? state.nodeAttributes
		: typeof state.getAttributesArray === 'function' ? state.getAttributesArray() : [];
	const bindings = Array.isArray( state.bindings )
		? state.bindings
		: typeof state.getBindings === 'function' ? state.getBindings() : [];
	const createBindings = typeof state.createBindings === 'function'
		? () => state.createBindings()
		: () => cloneFallbackBindings( bindings );

	return {
		vertexShader: state.vertexShader || '',
		fragmentShader: state.fragmentShader || '',
		computeShader: state.computeShader || '',
		nodeAttributes,
		bindings,
		updateNodes: Array.isArray( state.updateNodes ) ? state.updateNodes : [],
		updateBeforeNodes: Array.isArray( state.updateBeforeNodes ) ? state.updateBeforeNodes : [],
		updateAfterNodes: Array.isArray( state.updateAfterNodes ) ? state.updateAfterNodes : [],
		observer: state.observer || { needsRefresh() { return true; } },
		transforms: Array.isArray( state.transforms ) ? state.transforms : [],
		usedTimes: 0,
		createBindings,
		getAttributesArray() { return this.nodeAttributes; },
		getBindings() { return this.bindings; },
		build() {},
		buildAsync: async () => {},
	};

}

function cloneFallbackBindings( bindings ) {

	const out = [];
	for ( const group of bindings ) {

		if ( ! group || ! Array.isArray( group.bindings ) || group.bindings.length === 0 ) {

			out.push( group );
			continue;

		}
		const firstBinding = group.bindings[ 0 ];
		if ( firstBinding && firstBinding.groupNode && firstBinding.groupNode.shared === true ) {

			out.push( group );
			continue;

		}
		out.push( new BindGroup( group.name || '', group.bindings.map( ( binding ) => (
			binding && typeof binding.clone === 'function' ? binding.clone() : binding
		) ) ) );

	}
	return out;

}
