import { viewportMipTexture, viewportTexture } from 'three/src/nodes/display/ViewportTextureNode.js';
import { viewportDepthTexture } from 'three/src/nodes/display/ViewportDepthTextureNode.js';

import {
	invalidateOnTextureResourceChange,
	invalidateTextureBindingTarget,
	rebindTextureBindingTargets,
	textureBindingTargets,
} from './texture-binding-targets.js';

export function shouldSkipViewportCopyForZeroThicknessTransmission( artifact ) {

	const defaults = artifact && artifact.defaults;
	if ( ! defaults || ! ( defaults.transmission > 0 ) ) return false;
	if ( defaults.thickness !== 0 ) return false;

	const plan = Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [];
	for ( const group of plan ) {

		const textures = Array.isArray( group && group.textures ) ? group.textures : [];
		for ( const texture of textures ) {

			const source = texture && texture.source;
			if ( source && source.kind === 'material.thicknessMap' ) return false;

		}

	}

	return true;

}

export function shouldUseViewportFallbackForFrame( entry ) {

	if ( ! entry || entry.isDepth === true || entry.skipZeroThicknessTransmission !== true ) return false;
	const material = entry.material || {};
	const transmission = Number.isFinite( material.transmission ) ? material.transmission : 1;
	const thickness = Number.isFinite( material.thickness ) ? material.thickness : 0;
	return transmission > 0 && Math.abs( thickness ) <= 1e-7;

}

export function createViewportTextureRebinder( entries, deps = {} ) {

	const createMipNode = deps.viewportMipTexture || viewportMipTexture;
	const createPlainNode = deps.viewportTexture || viewportTexture;
	const createDepthNode = deps.viewportDepthTexture || viewportDepthTexture;
	let mipNode = null;
	let plainNode = null;
	let depthNode = null;
	const lastCopyRenderId = { mip: -1, plain: -1, depth: -1 };
	const lastSeen = new WeakMap();

	return {
		getUpdateBeforeType() {

			return 'render';

		},
		updateReference() {

			return this;

		},
		updateBefore( frame ) {

			if ( ! frame || ! frame.renderer ) return;

			for ( const entry of entries ) {

				if ( shouldUseViewportFallbackForFrame( entry ) ) {

					const changed = entry.fallbackTexture
						? rebindTextureBindingTargets( entry.binding, entry.fallbackTexture )
						: false;
					for ( const target of textureBindingTargets( entry.binding ) ) {

						invalidateOnTextureResourceChange( target, frame.renderer, lastSeen );
						if ( changed ) invalidateTextureBindingTarget( target );

					}
					continue;

				}

				const variant = entry.isDepth ? 'depth' : entry.generateMipmaps ? 'mip' : 'plain';
				let node = variant === 'depth' ? depthNode : variant === 'mip' ? mipNode : plainNode;
				if ( ! node ) {

					node = variant === 'depth' ? createDepthNode() : variant === 'mip' ? createMipNode() : createPlainNode();
					if ( variant === 'depth' ) depthNode = node;
					else if ( variant === 'mip' ) mipNode = node;
					else plainNode = node;

				}

				if ( typeof node.updateReference === 'function' ) node.updateReference( frame );

				const renderId = frame.renderId != null ? frame.renderId : 0;
				if ( lastCopyRenderId[ variant ] !== renderId ) {

					node.updateBefore( frame );
					lastCopyRenderId[ variant ] = renderId;

				}

				const liveTex = node.value;
				if ( ! liveTex ) continue;

				const changed = rebindTextureBindingTargets( entry.binding, liveTex );
				for ( const target of textureBindingTargets( entry.binding ) ) {

					invalidateOnTextureResourceChange( target, frame.renderer, lastSeen );
					if ( changed ) invalidateTextureBindingTarget( target );

				}

			}

		},
	};

}
