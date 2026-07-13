/** Product-side texture wiring for Screen-Space Shadows (SSSNode). */

import { attachTextureRefsWhere } from './artifact-texture-wiring.js';
import { getTRAACurrentDepthTexture } from './traa-replay.js';

/**
 * Resolve the live pass depth sampled by an SSS node.
 *
 * @param {Object} sssNode
 * @param {Array<unknown>} [passNodes=[]]
 * @return {unknown|null}
 */
export function getSSSDepthTexture( sssNode, passNodes = [] ) {

	// SSS and TRAA expose the same `depthNode` protocol. Reuse the mature pass
	// fallback ordering until that protocol moves to a generic pass-depth module.
	return getTRAACurrentDepthTexture( sssNode, passNodes );

}

/**
 * Rebind capture-time material-graph depth descriptors to the live pre-pass
 * depth texture used by SSS.
 *
 * @param {Object} artifact
 * @param {Object} sssNode
 * @param {{ passNodes?: Array<unknown> }} [opts]
 * @return {{ depthAttached: number }}
 */
export function wireSSSArtifact( artifact, sssNode, opts = {} ) {

	const stats = { depthAttached: 0 };
	if ( ! artifact || ! sssNode ) return stats;
	const depthTexture = getSSSDepthTexture( sssNode, Array.isArray( opts.passNodes ) ? opts.passNodes : [] );
	if ( ! ( depthTexture && depthTexture.isTexture === true ) ) return stats;

	const depthUuids = [];
	for ( const group of artifact.uniformPlan || [] ) {

		for ( const entry of group.textures || [] ) {

			const source = entry && entry.source;
			if ( ! isSSSDepthSource( source ) ) continue;
			if ( source.textureUuid && ! depthUuids.includes( source.textureUuid ) ) depthUuids.push( source.textureUuid );
			source.kind = 'artifact.texture';
			source.textureName = source.textureName || 'depth';
			source.__tslpSSSDepthAttached = true;

		}

	}
	if ( depthUuids.length === 0 ) return stats;
	if ( attachTextureRefsWhere( artifact, depthTexture, ( source ) => depthUuids.includes( source.textureUuid ) ) ) {

		stats.depthAttached = depthUuids.length;

	}
	return stats;

}

function isSSSDepthSource( source ) {

	return !! ( source && source.textureUuid && (
		source.kind === 'depth.texture'
		&& source.fromMaterialGraph === true
		&& ! source.lightUuid
		&& ! ( typeof source.lightIndex === 'number' && source.lightIndex >= 0 )
		|| source.kind === 'artifact.texture' && source.__tslpSSSDepthAttached === true
	) );

}
