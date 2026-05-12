import { rebindTextureBindingTargets } from './texture-binding-targets.js';

export function resolveReflectorRenderTarget( baseNode, camera ) {

	if ( ! baseNode || ! baseNode.renderTargets ) return null;
	let rt = null;
	if ( camera ) {

		let renderTargetCamera = camera;
		if ( typeof baseNode.getVirtualCamera === 'function' ) {

			try {

				renderTargetCamera = baseNode.getVirtualCamera( camera );

			} catch ( _ ) {

				renderTargetCamera = camera;

			}

		}
		rt = baseNode.renderTargets.get( renderTargetCamera ) || baseNode.renderTargets.get( camera );

	}
	if ( ! rt && baseNode.renderTargets.size > 0 ) {

		// Replay-time slim camera identity may not match the first keyed camera.
		rt = baseNode.renderTargets.values().next().value;

	}
	return rt || null;

}

export function createReflectorTextureRebinder( entries ) {

	return {
		getUpdateBeforeType() {

			return 'render';

		},
		updateReference() {

			return this;

		},
		updateBefore( frame ) {

			const camera = frame ? frame.camera : null;

			for ( const entry of entries ) {

				const baseNode = entry.baseNode;
				if ( ! baseNode || ! baseNode.renderTargets ) continue;

				const rt = resolveReflectorRenderTarget( baseNode, camera );

				const liveTexture = rt && rt.texture || baseNode.textureNode && baseNode.textureNode.value;
				if ( ! liveTexture ) continue;

				rebindTextureBindingTargets( entry.binding, liveTexture );

			}

		},
	};

}
