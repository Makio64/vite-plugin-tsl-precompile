/**
 * Observe assignments made after `texture()` created a TextureNode.
 *
 * Three.js stores TextureNode.value behind a prototype accessor. Defining an
 * equivalent instance accessor lets the replay TSL shim catalogue a texture
 * assigned later without changing the node's value/reference semantics.
 */
export function trackLateTextureNodeAssignments( node, onTexture ) {

	if ( ! node || typeof onTexture !== 'function' ) return node;
	try {

		if ( node.__tslpLateTextureAssignmentsTracked === true ) return node;
		let owner = node;
		let descriptor = null;
		while ( owner && ! descriptor ) {

			descriptor = Object.getOwnPropertyDescriptor( owner, 'value' );
			owner = Object.getPrototypeOf( owner );

		}
		if ( ! descriptor || typeof descriptor.get !== 'function' || typeof descriptor.set !== 'function' ) return node;
		Object.defineProperty( node, 'value', {
			configurable: true,
			enumerable: descriptor.enumerable === true,
			get() {

				return descriptor.get.call( this );

			},
			set( value ) {

				descriptor.set.call( this, value );
				if ( value && value.isTexture === true ) onTexture( value );

			},
		} );
		Object.defineProperty( node, '__tslpLateTextureAssignmentsTracked', {
			value: true,
			configurable: true,
		} );

	} catch ( _ ) {}
	return node;

}

/**
 * Select one identity-proven live color/depth render-target pair for an
 * artifact that captured `textureNode.value = rt.texture/depthTexture`.
 *
 * The caller supplies only textures initialized by the current renderer.
 * This helper additionally requires both values to point back to the same
 * RenderTarget and requires an exact captured image shape. Any ambiguity
 * fails closed.
 */
export function selectLateRenderTargetTexturePair( artifact, textures ) {

	if ( ! artifact || ! Array.isArray( textures ) || textures.length === 0 ) return null;
	const colorSources = new Map();
	const depthSources = new Map();
	for ( const group of artifact.uniformPlan || [] ) {

		for ( const entry of group.textures || [] ) {

			if ( ! entry || entry.bindingKind === 'sampler' ) continue;
			const source = entry.source || {};
			if (
				source.kind === 'artifact.texture' &&
				source.textureUuid &&
				! source.textureName &&
				! source.imageSrc &&
				! source.snapshot &&
				Number( source.imageWidth || 0 ) > 0 &&
				Number( source.imageHeight || 0 ) > 0
			) {

				colorSources.set( source.textureUuid, source );

			} else if (
				source.kind === 'depth.texture' &&
				source.textureUuid &&
				source.fromMaterialGraph === true &&
				! source.lightUuid &&
				! ( typeof source.lightIndex === 'number' && source.lightIndex >= 0 )
			) {

				depthSources.set( source.textureUuid, source );

			}

		}

	}
	if ( colorSources.size !== 1 || depthSources.size !== 1 ) return null;

	const [ colorTextureUuid, colorSource ] = colorSources.entries().next().value;
	const depthTextureUuid = depthSources.keys().next().value;
	const width = Number( colorSource.imageWidth );
	const height = Number( colorSource.imageHeight );
	const depth = Number( colorSource.imageDepth || 0 );
	const live = new Set( textures.filter( ( texture ) => texture && texture.isTexture === true ) );
	const shapeMatches = ( texture ) => {

		const image = texture && ( texture.image || texture.source && texture.source.data ) || null;
		if ( ! image ) return false;
		if ( Number( image.width || 0 ) !== width || Number( image.height || 0 ) !== height ) return false;
		const imageDepth = Number( image.depth || image.depthOrArrayLayers || 0 );
		return ! depth || ! imageDepth || imageDepth === depth;

	};
	const pairs = [];
	const seenTargets = new Set();
	for ( const colorTexture of live ) {

		if ( colorTexture.isRenderTargetTexture !== true || colorTexture.isDepthTexture === true ) continue;
		const target = colorTexture.renderTarget || null;
		const depthTexture = target && target.depthTexture || null;
		if (
			! target ||
			seenTargets.has( target ) ||
			target.texture !== colorTexture ||
			! ( depthTexture && depthTexture.isTexture === true && depthTexture.isDepthTexture === true ) ||
			depthTexture.renderTarget !== target ||
			! live.has( depthTexture ) ||
			! shapeMatches( colorTexture ) ||
			! shapeMatches( depthTexture )
		) continue;
		seenTargets.add( target );
		pairs.push( { target, colorTexture, depthTexture } );

	}
	if ( pairs.length !== 1 ) return null;
	return {
		...pairs[ 0 ],
		colorTextureUuid,
		depthTextureUuid,
	};

}
