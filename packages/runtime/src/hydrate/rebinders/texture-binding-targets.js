export function textureBindingTargets( binding ) {

	if ( ! binding ) return [];
	const source = binding.__tslpRebindSource || binding;
	const out = [ source ];
	const clones = source.__tslpRebindClones;
	if ( clones && typeof clones.forEach === 'function' ) {

		clones.forEach( ( clone ) => {

			if ( clone && ! out.includes( clone ) ) out.push( clone );

		} );

	}
	return out;

}

export function invalidateTextureBindingTarget( binding ) {

	if ( ! binding ) return;
	if ( binding.groupNode ) binding.groupNode.version ++;
	binding.version = - 1;
	binding.generation = null;

}

export function rebindTextureBindingTargets( binding, texture ) {

	let changed = false;
	for ( const target of textureBindingTargets( binding ) ) {

		if ( target.texture !== texture ) {

			target.texture = texture;
			changed = true;

		}

		if ( changed ) invalidateTextureBindingTarget( target );

	}
	return changed;

}

export function textureBindingResourceSignature( target, renderer ) {

	const texture = target && target.texture || null;
	const backend = renderer && renderer.backend && typeof renderer.backend.get === 'function' ? renderer.backend : null;
	const data = texture && backend ? backend.get( texture ) : null;
	return {
		texture,
		gpuTexture: data ? data.texture || null : null,
		version: texture && Number.isFinite( texture.version ) ? texture.version : null,
	};

}

export function invalidateOnTextureResourceChange( target, renderer, lastSeen ) {

	if ( ! target || ! lastSeen ) return;
	const current = textureBindingResourceSignature( target, renderer );
	const previous = lastSeen.get( target );
	lastSeen.set( target, current );
	if ( ! previous ) return;
	if ( previous.texture !== current.texture ||
		previous.gpuTexture !== current.gpuTexture ||
		previous.version !== current.version ) {

		invalidateTextureBindingTarget( target );

	}

}
