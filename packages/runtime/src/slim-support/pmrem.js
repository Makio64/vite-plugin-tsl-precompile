export const PMREM_CUBE_UV_MAPPING = 306;

export function isPMREMTexture( texture ) {

	return !! ( texture && texture.isTexture === true && texture.isCubeTexture !== true && ! Array.isArray( texture.image ) && ( texture.mapping === PMREM_CUBE_UV_MAPPING || texture.name === 'PMREM.cubeUv' ) );

}

export function isPMREMArtifactTextureSource( source ) {

	return !! ( source && source.kind === 'artifact.texture' && ( source.mapping === PMREM_CUBE_UV_MAPPING || source.textureName === 'PMREM.cubeUv' ) );

}

export function artifactNeedsPMREM( artifact ) {

	for ( const group of artifact && artifact.uniformPlan || [] ) {

		for ( const entry of group.textures || [] ) {

			if ( isPMREMArtifactTextureSource( entry && entry.source || null ) ) return true;

		}

	}
	return false;

}

export function artifactPMREMSourceUuids( artifact ) {

	const out = [];
	const seen = new Set();
	for ( const group of artifact && artifact.uniformPlan || [] ) {

		for ( const entry of group.textures || [] ) {

			const source = entry && entry.source || {};
			if ( ! source.textureUuid || ! isPMREMArtifactTextureSource( source ) || seen.has( source.textureUuid ) ) continue;
			seen.add( source.textureUuid );
			out.push( source.textureUuid );

		}

	}
	return out;

}

export function pushUniqueTexture( out, texture ) {

	if ( ! texture || texture.isTexture !== true || out.includes( texture ) ) return false;
	out.push( texture );
	return true;

}

export function pmremTexturesForSources( sources, getCachedPMREMForSource ) {

	const out = [];
	if ( typeof getCachedPMREMForSource !== 'function' ) return out;
	for ( const source of sources || [] ) {

		const pmrem = getCachedPMREMForSource( source );
		pushUniqueTexture( out, pmrem );

	}
	return out;

}

export function textureListSignature( textures, count = 0 ) {

	const limit = Math.max( 0, count || textures && textures.length || 0 );
	return ( textures || [] ).slice( 0, limit ).map( ( texture, index ) => {

		return texture && ( texture.uuid || texture.name || String( index ) ) || String( index );

	} ).join( '|' );

}

export function attachPMREMRefsByOrder( artifact, pmremTextures ) {

	const sourceUuids = artifactPMREMSourceUuids( artifact );
	if ( sourceUuids.length === 0 ) return false;

	const pmrems = [];
	for ( const texture of pmremTextures || [] ) pushUniqueTexture( pmrems, texture );
	if ( pmrems.length < sourceUuids.length ) return false;

	const refs = artifact._textureRefs instanceof Map ? new Map( artifact._textureRefs ) : new Map();
	let changed = false;
	for ( let i = 0; i < sourceUuids.length; i ++ ) {

		const uuid = sourceUuids[ i ];
		const texture = pmrems[ i ];
		if ( refs.get( uuid ) === texture ) continue;
		refs.set( uuid, texture );
		changed = true;

	}

	if ( changed ) {

		Object.defineProperty( artifact, '_textureRefs', {
			value: refs,
			enumerable: false,
			configurable: true,
			writable: true,
		} );

	}
	return true;

}

export function selectPMREMTexturesForArtifact( artifact, opts = {} ) {

	const sourceUuids = artifactPMREMSourceUuids( artifact );
	if ( sourceUuids.length === 0 ) {

		return {
			sourceUuids,
			pmremTextures: [],
			strategy: 'none',
			nodePmrems: [],
			materialPmrem: null,
			environmentPmrems: [],
		};

	}

	const material = opts.material || null;
	const collectMaterialNodeTextures = typeof opts.collectMaterialNodeTextures === 'function' ? opts.collectMaterialNodeTextures : () => [];
	const getCachedPMREMForSource = typeof opts.getCachedPMREMForSource === 'function' ? opts.getCachedPMREMForSource : () => null;
	const environmentSources = Array.isArray( opts.environmentSources ) ? opts.environmentSources : [];

	const nodePmrems = [];
	for ( const texture of collectMaterialNodeTextures( material ) || [] ) {

		if ( isPMREMTexture( texture ) ) pushUniqueTexture( nodePmrems, texture );

	}

	const materialEnvMap = material && material.envMap && material.envMap.isTexture === true ? material.envMap : null;
	const materialPmrem = materialEnvMap ? getCachedPMREMForSource( materialEnvMap ) : null;
	const environmentPmrems = pmremTexturesForSources( environmentSources, getCachedPMREMForSource );

	if ( nodePmrems.length >= sourceUuids.length ) {

		return {
			sourceUuids,
			pmremTextures: nodePmrems,
			strategy: 'material-node',
			nodePmrems,
			materialPmrem,
			environmentPmrems,
		};

	}

	if ( materialPmrem && sourceUuids.length <= 1 ) {

		return {
			sourceUuids,
			pmremTextures: [ materialPmrem ],
			strategy: 'material-env-map',
			nodePmrems,
			materialPmrem,
			environmentPmrems,
		};

	}

	return {
		sourceUuids,
		pmremTextures: environmentPmrems,
		strategy: environmentPmrems.length > 0 ? 'scene-environment' : 'missing',
		nodePmrems,
		materialPmrem,
		environmentPmrems,
	};

}

export function createPMREMSupport( opts = {} ) {

	const cache = opts.cache || new WeakMap();
	const pending = opts.pending || new WeakMap();
	const failed = opts.failed || new WeakSet();
	const wiredArtifacts = opts.wiredArtifacts || new WeakMap();
	const getDiagnostics = typeof opts.getDiagnostics === 'function' ? opts.getDiagnostics : () => opts.diagnostics || null;
	const generatePMREM = typeof opts.generatePMREM === 'function' ? opts.generatePMREM : null;
	const textureImageReady = typeof opts.textureImageReady === 'function' ? opts.textureImageReady : () => true;
	const onPendingChange = typeof opts.onPendingChange === 'function' ? opts.onPendingChange : null;

	function bump( key ) {

		const diagnostics = getDiagnostics();
		if ( diagnostics && key ) diagnostics[ key ] = ( diagnostics[ key ] | 0 ) + 1;

	}

	function getCachedPMREMForSource( sourceTex ) {

		if ( ! sourceTex ) return null;
		const cached = cache.get( sourceTex );
		if ( cached && cached.isTexture === true ) return cached;
		return isPMREMTexture( sourceTex ) ? sourceTex : null;

	}

	function rememberPMREM( sourceTex, pmrem ) {

		if ( sourceTex && pmrem && pmrem.isTexture === true ) cache.set( sourceTex, pmrem );
		return pmrem && pmrem.isTexture === true ? pmrem : null;

	}

	function texturesForSources( sources ) {

		return pmremTexturesForSources( sources, getCachedPMREMForSource );

	}

	function wireArtifact( artifact, pmremTextures, material = null ) {

		const sourceUuids = artifactPMREMSourceUuids( artifact );
		if ( sourceUuids.length === 0 ) return false;
		if ( ! pmremTextures || pmremTextures.length < sourceUuids.length ) {

			bump( 'wireNoPmrem' );
			return false;

		}

		const signature = textureListSignature( pmremTextures, sourceUuids.length );
		if ( wiredArtifacts.get( artifact ) === signature ) {

			bump( 'wireAlreadyWired' );
			return true;

		}

		bump( 'wireNeedsPmrem' );
		if ( attachPMREMRefsByOrder( artifact, pmremTextures ) ) {

			wiredArtifacts.set( artifact, signature );
			if ( material ) material.needsUpdate = true;
			bump( 'wireAttached' );
			return true;

		}

		bump( 'wireNoPmrem' );
		return false;

	}

	function kickGenerate( renderer, sourceTex, onReady ) {

		bump( 'kickCalls' );
		const readyPMREM = getCachedPMREMForSource( sourceTex );
		if ( readyPMREM && readyPMREM.isTexture === true ) {

			bump( 'cacheHits' );
			if ( typeof onReady === 'function' ) onReady( readyPMREM );
			return Promise.resolve( readyPMREM );

		}
		if ( ! sourceTex || failed.has( sourceTex ) || ! generatePMREM ) return Promise.resolve( null );
		if ( pending.has( sourceTex ) ) {

			bump( 'pendingJoins' );
			const promise = pending.get( sourceTex );
			if ( typeof onReady === 'function' ) promise.then( ( pmrem ) => { if ( pmrem ) onReady( pmrem ); } ).catch( () => {} );
			return promise;

		}
		if ( ! textureImageReady( sourceTex ) ) {

			bump( 'skippedNotReady' );
			return Promise.resolve( null );

		}

		bump( 'generateCalls' );
		if ( onPendingChange ) onPendingChange( 1, sourceTex );
		const promise = Promise.resolve()
			.then( () => generatePMREM( renderer, sourceTex ) )
			.then( ( pmrem ) => {

				const ready = rememberPMREM( sourceTex, pmrem );
				if ( ready ) {

					bump( 'generateSuccess' );
					if ( typeof onReady === 'function' ) onReady( ready );

				}
				return ready;

			} )
			.catch( ( err ) => {

				failed.add( sourceTex );
				bump( 'generateFailed' );
				if ( opts.onError ) opts.onError( err, sourceTex );
				return null;

			} )
			.finally( () => {

				pending.delete( sourceTex );
				if ( onPendingChange ) onPendingChange( -1, sourceTex );

			} );
		pending.set( sourceTex, promise );
		return promise;

	}

	return {
		cache,
		pending,
		failed,
		wiredArtifacts,
		getCachedPMREMForSource,
		rememberPMREM,
		texturesForSources,
		wireArtifact,
		kickGenerate,
		isPMREMTexture,
		isPMREMArtifactTextureSource,
		artifactNeedsPMREM,
		artifactPMREMSourceUuids,
		attachPMREMRefsByOrder,
		selectPMREMTexturesForArtifact,
		textureListSignature,
	};

}
