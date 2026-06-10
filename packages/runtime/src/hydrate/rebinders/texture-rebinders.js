import {
	invalidateOnTextureResourceChange,
	invalidateTextureBindingTarget,
	rebindTextureBindingTargets,
	textureBindingTargets,
} from './texture-binding-targets.js';

export function createMaterialTextureRebinder( entries, deps ) {

	const { resolveTextureBinding } = deps;
	const lastSeen = new WeakMap();

	return {
		getUpdateBeforeType() {

			return 'render';

		},
		updateReference() {

			return this;

		},
		updateBefore( frame ) {

			const renderer = frame && frame.renderer ? frame.renderer : null;

			for ( const entry of entries ) {

				const binding = entry && entry.binding;
				if ( ! binding ) continue;

				const candidate = resolveTextureBinding( entry.artifact, entry.groupName, entry.bindingName, entry.material, { frame } );
				if ( candidate ) rebindTextureBindingTargets( binding, candidate );

				for ( const target of textureBindingTargets( binding ) ) {

					invalidateOnTextureResourceChange( target, renderer, lastSeen );

				}

			}

		},
	};

}

export function createArtifactTextureRebinder( entries, deps ) {

	const { resolveTextureBinding } = deps;
	// Track the last-seen GPUTexture per binding so we only invalidate when
	// it actually swaps, preserving three.js's bind-group cache on stable frames.
	const lastSeen = new WeakMap();

	return {
		getUpdateBeforeType() {

			return 'render';

		},
		updateReference() {

			return this;

		},
		updateBefore( frame ) {

			const renderer = frame && frame.renderer ? frame.renderer : null;
			let avoidTexture = null;
			try {

				const renderTarget = renderer && typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : null;
				avoidTexture = renderTarget && renderTarget.texture || null;

			} catch ( _ ) {}

			for ( const entry of entries ) {

				const binding = entry.binding;
				if ( ! binding ) continue;

				const candidate = resolveTextureBinding( entry.artifact, entry.groupName, entry.bindingName, entry.material, { avoidTexture, frame } );
				if ( candidate ) {

					rebindTextureBindingTargets( binding, candidate );

				}

				// Detect a swap of the underlying GPUTexture after the bind group
				// has already been built and force three.js to rebuild the view.
				if ( ! renderer || ! renderer.backend ) continue;
				for ( const target of textureBindingTargets( binding ) ) {

					const tex = target.texture;
					if ( ! tex ) continue;
					const data = renderer.backend.get( tex );
					const gpuTexture = data ? data.texture : null;
					if ( ! gpuTexture ) continue;

					const prev = lastSeen.get( target );
					if ( prev === gpuTexture ) continue;

					lastSeen.set( target, gpuTexture );
					if ( prev === undefined ) continue;

					invalidateTextureBindingTarget( target );

				}

			}

		},
	};

}
