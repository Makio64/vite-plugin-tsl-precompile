/**
 * Frame-scoped texture-resolution memo.
 *
 * Every render object sharing a material gets its own rebinder entry arrays,
 * so N instances of one material re-run the full `resolveTextureBinding`
 * strategy chain N times per frame with identical inputs. The resolver's
 * inputs are (artifact, groupName, bindingName, material, options.avoidTexture)
 * — no per-object parameter — so within one render pass the result is shared
 * across all of a material's render objects.
 *
 * The wrapped resolver reads `options.frame` (the NodeFrame the rebinder runs
 * under) and reuses the previous result while `frame.renderId`/`frame.frameId`
 * and the `avoidTexture` identity are unchanged. Calls without a stamped frame
 * pass straight through, so hydration-time resolution and environments whose
 * frame objects carry no ids keep today's behavior.
 *
 * First wedge of the P1.9 per-render resolution caching work — see
 * ARCHITECTURE_EVOLUTION.md.
 *
 * @module ResolutionMemo
 */

const NULL_MATERIAL = {};

export function createFrameScopedResolutionMemo( resolve ) {

	// artifact → WeakMap( material → Map( `group::binding` → { stamp, avoidTexture, value } ) )
	const cache = new WeakMap();

	return function memoizedResolveTextureBinding( artifact, groupName, bindingName, material, options = null ) {

		const frame = options && options.frame || null;
		const renderId = frame ? frame.renderId : undefined;
		const frameId = frame ? frame.frameId : undefined;
		if ( ! artifact || typeof artifact !== 'object' || ( renderId === undefined && frameId === undefined ) ) {

			return resolve( artifact, groupName, bindingName, material, options );

		}

		const stamp = `${ renderId }:${ frameId }`;
		const avoidTexture = options && options.avoidTexture || null;

		let byMaterial = cache.get( artifact );
		if ( ! byMaterial ) {

			byMaterial = new WeakMap();
			cache.set( artifact, byMaterial );

		}

		const materialKey = material && typeof material === 'object' ? material : NULL_MATERIAL;
		let byBinding = byMaterial.get( materialKey );
		if ( ! byBinding ) {

			byBinding = new Map();
			byMaterial.set( materialKey, byBinding );

		}

		const key = `${ groupName || '' }::${ bindingName || '' }`;
		const hit = byBinding.get( key );
		if ( hit && hit.stamp === stamp && hit.avoidTexture === avoidTexture ) return hit.value;

		const value = resolve( artifact, groupName, bindingName, material, options );
		byBinding.set( key, { stamp, avoidTexture, value } );
		return value;

	};

}
