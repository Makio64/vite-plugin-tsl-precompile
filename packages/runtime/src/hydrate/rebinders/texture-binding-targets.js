export function textureBindingTargets( binding ) {

	if ( ! binding ) return [];
	const source = binding.__tslpRebindSource || binding;
	const clones = source.__tslpRebindClones;

	// Clone sets are add-only (see installRebindableTextureBindingClone), so
	// the target list only changes when a clone count changes — cache the
	// array on the source instead of rebuilding it per rebinder per frame.
	const cloneCount = clones ? ( typeof clones.size === 'number' ? clones.size : - 1 ) : 0;
	const cached = source.__tslpRebindTargets;
	if ( cached && cloneCount !== - 1 && source.__tslpRebindTargetsCloneCount === cloneCount ) return cached;

	const out = [ source ];
	if ( clones && typeof clones.forEach === 'function' ) {

		clones.forEach( ( clone ) => {

			if ( clone && ! out.includes( clone ) ) out.push( clone );

		} );

	}

	if ( cloneCount !== - 1 ) {

		source.__tslpRebindTargets = out;
		source.__tslpRebindTargetsCloneCount = cloneCount;

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

export function invalidateOnTextureResourceChange( target, renderer, lastSeen ) {

	if ( ! target || ! lastSeen ) return;
	const texture = target.texture || null;
	const backend = renderer && renderer.backend && typeof renderer.backend.get === 'function' ? renderer.backend : null;
	const data = texture && backend ? backend.get( texture ) : null;
	const gpuTexture = data ? data.texture || null : null;
	const version = texture && Number.isFinite( texture.version ) ? texture.version : null;
	const previous = lastSeen.get( target );
	if ( previous && previous.texture === texture && previous.gpuTexture === gpuTexture && previous.version === version ) return;
	lastSeen.set( target, { texture, gpuTexture, version } );
	if ( previous ) invalidateTextureBindingTarget( target );

}
