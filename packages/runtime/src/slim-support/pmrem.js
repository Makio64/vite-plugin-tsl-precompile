import { NODE_GRAPH_TEXTURE_KEYS } from '@tsl-precompile/contract/texture-props';

export const PMREM_CUBE_UV_MAPPING = 306;
export const CUBE_REFLECTION_MAPPING = 301;
export const CUBE_REFRACTION_MAPPING = 302;
export const EQUIRECTANGULAR_REFLECTION_MAPPING = 303;
export const EQUIRECTANGULAR_REFRACTION_MAPPING = 304;

export function isPMREMTexture( texture ) {

	return !! ( texture && texture.isTexture === true && texture.isCubeTexture !== true && ! Array.isArray( texture.image ) && ( texture.mapping === PMREM_CUBE_UV_MAPPING || texture.name === 'PMREM.cubeUv' ) );

}

export function isCubeTextureSource( texture ) {

	return !! ( texture && texture.isTexture === true && ( texture.isCubeTexture === true || texture.mapping === CUBE_REFLECTION_MAPPING || texture.mapping === CUBE_REFRACTION_MAPPING ) );

}

export function isEnvironmentTextureSource( texture ) {

	if ( ! ( texture && texture.isTexture === true ) ) return false;
	if ( isPMREMTexture( texture ) ) return false;
	return isCubeTextureSource( texture ) || texture.mapping === EQUIRECTANGULAR_REFLECTION_MAPPING || texture.mapping === EQUIRECTANGULAR_REFRACTION_MAPPING;

}

function readGraphValue( object, key ) {

	if ( ! object || ! key ) return null;
	try {
		const descriptor = Object.getOwnPropertyDescriptor( object, key );
		if ( descriptor && Object.prototype.hasOwnProperty.call( descriptor, 'value' ) ) return descriptor.value;
	} catch ( _ ) {}
	try { return object[ key ]; } catch ( _ ) { return null; }

}

function isPMREMNodeLike( node ) {

	if ( ! node || node.isNode !== true ) return false;
	const type = node.constructor && ( node.constructor.type || node.constructor.name ) || node.type || '';
	return type === 'PMREMNode' || node.isPMREMNode === true || ( readGraphValue( node, '_texture' ) && readGraphValue( node, '_width' ) && readGraphValue( node, '_height' ) && readGraphValue( node, '_value' ) );

}

export function collectPMREMSourceTexturesInNode( node, opts = {}, out = [], depth = 0, seen = new Set() ) {

	if ( ! node || ( typeof node !== 'object' && typeof node !== 'function' ) || depth > 64 || seen.has( node ) ) return out;
	seen.add( node );
	const getPmremStubSource = typeof opts.getPmremStubSource === 'function' ? opts.getPmremStubSource : null;
	if ( isPMREMNodeLike( node ) ) {

		const source = readGraphValue( node, '_value' ) || readGraphValue( node, 'value' );
		if ( isEnvironmentTextureSource( source ) ) pushUniqueTexture( out, source );

	}
	if ( getPmremStubSource ) {

		const source = getPmremStubSource( node );
		if ( isEnvironmentTextureSource( source ) ) pushUniqueTexture( out, source );

	}
	let children = [];
	try {
		if ( typeof node.getChildren === 'function' ) {
			const list = node.getChildren();
			if ( Array.isArray( list ) ) children = children.concat( list );
			else if ( list && typeof list[ Symbol.iterator ] === 'function' ) children = children.concat( Array.from( list ) );
		}
	} catch ( _ ) {}
	const childKeys = [ '_children', 'children', 'node', 'inputNode', 'textureNode', 'uvNode', 'levelNode', 'valueNode', 'aNode', 'bNode' ];
	for ( const key of childKeys ) {

		const value = readGraphValue( node, key );
		if ( Array.isArray( value ) ) children = children.concat( value );
		else if ( value && ( typeof value === 'object' || typeof value === 'function' ) ) children.push( value );

	}
	for ( const child of children ) collectPMREMSourceTexturesInNode( child, opts, out, depth + 1, seen );
	return out;

}

export function collectPMREMSourceTexturesFromMaterial( material, opts = {} ) {

	const out = [];
	if ( ! material ) return out;
	const keys = Array.isArray( opts.nodeGraphKeys ) ? opts.nodeGraphKeys : NODE_GRAPH_TEXTURE_KEYS;
	for ( const key of keys ) collectPMREMSourceTexturesInNode( readGraphValue( material, key ), opts, out );
	return out;

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

	return artifactPMREMSourceEntries( artifact ).map( ( entry ) => entry.textureUuid );

}

function artifactPMREMSourceEntries( artifact ) {

	const out = [];
	const seen = new Set();
	for ( const group of artifact && artifact.uniformPlan || [] ) {

		for ( const entry of group.textures || [] ) {

			const source = entry && entry.source || {};
			if ( ! source.textureUuid || ! isPMREMArtifactTextureSource( source ) || seen.has( source.textureUuid ) ) continue;
			seen.add( source.textureUuid );
			out.push( source );

		}

	}
	return out;

}

function sourceHasImageSize( source ) {

	return !! ( source && typeof source.imageWidth === 'number' && typeof source.imageHeight === 'number' );

}

function textureMatchesPMREMSourceSize( texture, source ) {

	if ( ! sourceHasImageSize( source ) ) return true;
	const image = texture && texture.image || null;
	if ( ! image || image.width !== source.imageWidth || image.height !== source.imageHeight ) return false;
	return typeof source.imageDepth !== 'number' || image.depth === source.imageDepth;

}

function filterPMREMTexturesBySourceSize( textures, sources ) {

	const candidates = [];
	const sourceList = sources || [];
	const hasSizeHints = sourceList.some( sourceHasImageSize );
	if ( ! hasSizeHints ) return textures || [];
	for ( const texture of textures || [] ) {

		if ( sourceList.some( ( source ) => textureMatchesPMREMSourceSize( texture, source ) ) ) pushUniqueTexture( candidates, texture );

	}
	return candidates;

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

function sourcePMREMVersion( texture ) {

	return texture && typeof texture.pmremVersion === 'number' ? texture.pmremVersion : null;

}

function readCachedPMREM( cache, sourceTex ) {

	if ( ! sourceTex ) return null;
	if ( isPMREMTexture( sourceTex ) ) return sourceTex;
	const cached = cache.get( sourceTex );
	if ( ! cached ) return null;
	const sourceVersion = sourcePMREMVersion( sourceTex );
	if ( cached.isTexture === true ) {

		const cachedVersion = sourcePMREMVersion( cached );
		if ( sourceVersion !== null && cachedVersion !== null && cachedVersion !== sourceVersion ) return null;
		return cached;

	}
	const texture = cached.texture;
	if ( texture && texture.isTexture === true ) {

		if ( sourceVersion !== null && cached.pmremVersion !== sourceVersion ) return null;
		return texture;

	}
	return null;

}

function writeCachedPMREM( cache, sourceTex, pmrem ) {

	if ( ! sourceTex || ! pmrem || pmrem.isTexture !== true ) return null;
	const version = sourcePMREMVersion( sourceTex );
	if ( version !== null ) {

		try { pmrem.pmremVersion = version; } catch ( _ ) {}
		cache.set( sourceTex, { texture: pmrem, pmremVersion: version } );

	} else {

		cache.set( sourceTex, pmrem );

	}
	return pmrem;

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

	const sourceEntries = artifactPMREMSourceEntries( artifact );
	const sourceUuids = sourceEntries.map( ( source ) => source.textureUuid );
	if ( sourceUuids.length === 0 ) {

		return {
			sourceUuids,
			pmremTextures: [],
			strategy: 'none',
			nodePmrems: [],
			materialPmrem: null,
			environmentPmrems: [],
			materialPMREMSources: [],
			materialNodeSourcePmrems: [],
		};

	}

	const material = opts.material || null;
	const collectMaterialNodeTextures = typeof opts.collectMaterialNodeTextures === 'function' ? opts.collectMaterialNodeTextures : () => [];
	const collectMaterialPMREMSources = typeof opts.collectMaterialPMREMSources === 'function' ? opts.collectMaterialPMREMSources : () => [];
	const getCachedPMREMForSource = typeof opts.getCachedPMREMForSource === 'function' ? opts.getCachedPMREMForSource : () => null;
	const environmentSources = Array.isArray( opts.environmentSources ) ? opts.environmentSources : [];

	const nodePmrems = [];
	for ( const texture of collectMaterialNodeTextures( material ) || [] ) {

		if ( isPMREMTexture( texture ) ) pushUniqueTexture( nodePmrems, texture );

	}
	const matchingNodePmrems = filterPMREMTexturesBySourceSize( nodePmrems, sourceEntries );
	const materialPMREMSources = [];
	for ( const texture of collectMaterialPMREMSources( material ) || [] ) pushUniqueTexture( materialPMREMSources, texture );
	const materialNodeSourcePmrems = filterPMREMTexturesBySourceSize( pmremTexturesForSources( materialPMREMSources, getCachedPMREMForSource ), sourceEntries );

	const materialEnvMap = material && material.envMap && material.envMap.isTexture === true ? material.envMap : null;
	const materialPmrem = materialEnvMap ? getCachedPMREMForSource( materialEnvMap ) : null;
	const environmentPmrems = pmremTexturesForSources( environmentSources, getCachedPMREMForSource );

	if ( materialNodeSourcePmrems.length >= sourceUuids.length ) {

		return {
			sourceUuids,
			pmremTextures: materialNodeSourcePmrems,
			strategy: 'material-node-source',
			nodePmrems,
			materialPmrem,
			environmentPmrems,
			materialPMREMSources,
			materialNodeSourcePmrems,
		};

	}

	if ( matchingNodePmrems.length >= sourceUuids.length ) {

		return {
			sourceUuids,
			pmremTextures: matchingNodePmrems,
			strategy: 'material-node',
			nodePmrems,
			materialPmrem,
			environmentPmrems,
			materialPMREMSources,
			materialNodeSourcePmrems,
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
			materialPMREMSources,
			materialNodeSourcePmrems,
		};

	}

	return {
		sourceUuids,
		pmremTextures: environmentPmrems,
		strategy: environmentPmrems.length > 0 ? 'scene-environment' : 'missing',
		nodePmrems,
		materialPmrem,
		environmentPmrems,
		materialPMREMSources,
		materialNodeSourcePmrems,
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

		return readCachedPMREM( cache, sourceTex );

	}

	function rememberPMREM( sourceTex, pmrem ) {

		return writeCachedPMREM( cache, sourceTex, pmrem );

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
