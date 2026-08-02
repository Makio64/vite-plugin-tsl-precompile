function unwrapShadowNode( lightNode ) {

	const shadowNode = lightNode && lightNode.shadowNode;
	return shadowNode && shadowNode.node ? shadowNode.node : shadowNode;

}

function horizontalVsmTexture( lightNode, cloneLight ) {

	if ( ! lightNode || lightNode.isAnalyticLightNode !== true || lightNode.light !== cloneLight ) return null;
	const shadowNode = unwrapShadowNode( lightNode );
	const horizontal = shadowNode && shadowNode.vsmShadowMapHorizontal;
	return horizontal && horizontal.texture && horizontal.texture.isTexture === true
		? horizontal.texture
		: null;

}

function findBuiltLightTexture( fullRenderer, cloneLight ) {

	const cache = fullRenderer && fullRenderer._nodes && fullRenderer._nodes.nodeBuilderCache;
	if ( ! cache || typeof cache.values !== 'function' ) return null;

	for ( const state of cache.values() ) {

		for ( const collection of [ state && state.updateNodes, state && state.updateBeforeNodes ] ) {

			if ( ! collection || typeof collection[ Symbol.iterator ] !== 'function' ) continue;
			for ( const node of collection ) {

				const texture = horizontalVsmTexture( node, cloneLight );
				if ( texture ) return texture;

			}

		}

	}

	return null;

}

function rebuildLightTexture( fullRenderer, shadowScene, shadowRenderCamera, cloneLight ) {

	const lists = fullRenderer && fullRenderer._renderLists;
	const renderList = lists && typeof lists.get === 'function'
		? lists.get( shadowScene, shadowRenderCamera )
		: null;
	const lightsNodeCarrier = renderList && renderList.lightsNode || null;
	const lightsNode = lightsNodeCarrier && lightsNodeCarrier.node
		? lightsNodeCarrier.node
		: lightsNodeCarrier;
	if ( ! lightsNode || typeof lightsNode.getLightNodes !== 'function' ) return null;

	const dataMap = new WeakMap();
	const canSeedLights = typeof lightsNode.getLights === 'function' && typeof lightsNode.setLights === 'function';
	const previousLights = canSeedLights ? lightsNode.getLights() : null;
	const fakeBuilder = {
		renderer: fullRenderer,
		context: { materialLightings: canSeedLights ? [] : [ cloneLight ] },
		getDataFromNode( node ) {

			let data = dataMap.get( node );
			if ( ! data ) {

				data = {};
				dataMap.set( node, data );

			}
			return data;

		},
	};

	try {

		if ( canSeedLights ) lightsNode.setLights( [ cloneLight ] );
		const lightNodes = lightsNode.getLightNodes( fakeBuilder );
		if ( ! lightNodes || typeof lightNodes[ Symbol.iterator ] !== 'function' ) return null;
		for ( const lightNode of lightNodes ) {

			const texture = horizontalVsmTexture( lightNode, cloneLight );
			if ( texture ) return texture;

		}

	} finally {

		if ( canSeedLights ) lightsNode.setLights( previousLights );

	}

	return null;

}

/**
 * Find the horizontal VSM moments target produced by the full r185 renderer.
 *
 * Lighting.finishRender() restores a scene's LightsNode to its pre-render
 * (usually empty) light list. Prefer the already-built NodeBuilderState and use
 * a fresh, temporarily seeded LightsNode builder only as a compatibility
 * fallback. No fake-builder data may survive between lights.
 */
export function findVsmBlurTexture( fullRenderer, shadowScene, shadowRenderCamera, cloneLight ) {

	try {

		const map = cloneLight && cloneLight.shadow && cloneLight.shadow.map;
		const layered = map && map._vsmShadowMapHorizontal;
		if ( layered && layered.texture && layered.texture.isTexture === true ) return layered.texture;
		return findBuiltLightTexture( fullRenderer, cloneLight )
			|| rebuildLightTexture( fullRenderer, shadowScene, shadowRenderCamera, cloneLight );

	} catch ( _ ) {

		return null;

	}

}
