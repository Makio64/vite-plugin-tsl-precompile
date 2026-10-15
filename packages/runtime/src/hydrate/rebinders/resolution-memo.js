/**
 * Share texture resolution across render objects of one material. Entries
 * expire when the renderer, render/frame ID or avoided texture changes.
 * Unstamped hydration calls always resolve; null results are cached too.
 * Material-node discovery is shared across bindings for the same render.
 *
 * @module ResolutionMemo
 */

const NULL_OWNER = {};

export function createFrameScopedResolutionMemo( resolve ) {

	// Keep keys and render stamps separate: lookups allocate no strings and
	// cannot collide when names or logical frame IDs contain delimiters.
	// Weak renderer ownership also releases its cache when the renderer goes away.
	const cache = new WeakMap();

	return function memoizedResolveTextureBinding( artifact, groupName, bindingName, material, options = null, planBinding = null ) {

		const frame = options && options.frame || null;
		const renderId = frame ? frame.renderId : undefined;
		const frameId = frame ? frame.frameId : undefined;
		if ( ! artifact || typeof artifact !== 'object' || ( renderId === undefined && frameId === undefined ) ) {

			return resolve( artifact, groupName, bindingName, material, options, planBinding );

		}
		const avoidTexture = options && options.avoidTexture || null;
		const renderer = options && options.renderer || frame.renderer || null;

		const rendererKey = renderer && typeof renderer === 'object' ? renderer : NULL_OWNER;
		let byArtifact = cache.get( rendererKey );
		if ( ! byArtifact ) cache.set( rendererKey, byArtifact = new WeakMap() );
		let byMaterial = byArtifact.get( artifact );
		if ( ! byMaterial ) {

			byMaterial = new WeakMap();
			byArtifact.set( artifact, byMaterial );

		}

		const materialKey = material && typeof material === 'object' ? material : NULL_OWNER;
		let materialState = byMaterial.get( materialKey );
		if ( ! materialState ) {

			materialState = {
				groups: new Map(),
				epoch: 0,
				frameId, renderId,
				materialNodeTextureCache: new WeakMap(),
			};
			byMaterial.set( materialKey, materialState );

		}
		if ( materialState.frameId !== frameId || materialState.renderId !== renderId ) {

			materialState.frameId = frameId;
			materialState.renderId = renderId;
			materialState.epoch ++;
			materialState.materialNodeTextureCache = new WeakMap();

		}

		const groupKey = groupName || '';
		let bindings = materialState.groups.get( groupKey );
		if ( ! bindings ) materialState.groups.set( groupKey, bindings = new Map() );
		const key = bindingName || '';
		const epoch = materialState.epoch;
		const hit = bindings.get( key );
		if ( hit && hit.epoch === epoch && hit.avoidTexture === avoidTexture && hit.planBinding === planBinding ) return hit.value;

		const scopedOptions = {
			...( options || {} ),
			materialNodeTextureCache: materialState.materialNodeTextureCache,
		};
		const value = resolve( artifact, groupName, bindingName, material, scopedOptions, planBinding );
		const entry = hit || {};
		entry.epoch = epoch;
		entry.avoidTexture = avoidTexture;
		entry.planBinding = planBinding;
		entry.value = value;
		if ( ! hit ) bindings.set( key, entry );
		return value;

	};

}
