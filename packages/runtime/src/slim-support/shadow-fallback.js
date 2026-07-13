/**
 * Standard-light shadow-map fallback for the slim renderer.
 *
 * The slim bundle can consume captured shadow bindings, but it cannot build the
 * live depth pass that allocates `light.shadow.map`. This primitive mirrors the
 * ordinary shadow casters into a full-three scene, lets a full WebGPU renderer
 * populate Directional/Spot/Point depth maps, then shares those GPU textures
 * back into slim.
 *
 * This is intentionally a narrow fidelity boundary. VSM, custom shadow nodes,
 * skinned/batched casters, clipping shadows, and unresolved node-displaced
 * materials are reported as unsupported and abort the pass. A caller can make
 * a node-displaced caster explicit with `resolveShadowMaterial(material,
 * object)`, which must synchronously return a full-renderer-compatible material.
 *
 * @module SlimSupport/ShadowFallback
 */

import { shareShadowGPUTextureIntoSlim } from './gpu-texture-share.js';

const DEFAULT_CACHE = new WeakMap();
const OBJECT_IDS = new WeakMap();
const SHADOW_NODE_KEYS = [
	'geometryNode',
	'positionNode',
	'vertexNode',
	'colorNode',
	'depthNode',
	'alphaTestNode',
	'maskNode',
	'maskShadowNode',
	'castShadowPositionNode',
	'castShadowNode',
];
const SHADOW_MATERIAL_KEYS = [
	'visible',
	'side',
	'shadowSide',
	'alphaTest',
	'alphaHash',
	'alphaToCoverage',
	'transparent',
	'opacity',
	'depthTest',
	'depthWrite',
	'colorWrite',
	'map',
	'alphaMap',
	'displacementMap',
	'displacementScale',
	'displacementBias',
];

let nextObjectId = 1;

function objectId( value ) {

	if ( ! value || ( typeof value !== 'object' && typeof value !== 'function' ) ) return String( value );
	if ( value.uuid ) return value.uuid;
	if ( value.id !== undefined ) return String( value.id );
	let id = OBJECT_IDS.get( value );
	if ( ! id ) {

		id = `anon-${ nextObjectId ++ }`;
		OBJECT_IDS.set( value, id );

	}
	return id;

}

function emptyResult() {

	return {
		rendered: false,
		complete: false,
		reused: false,
		proxyReused: false,
		lightsConsidered: 0,
		lightsPopulated: 0,
		castersMirrored: 0,
		receiversMirrored: 0,
		texturesShared: 0,
		unsupported: [],
	};

}

function describeValue( value ) {

	return {
		uuid: value && value.uuid || null,
		name: value && value.name || '',
		type: value && ( value.type || value.constructor && value.constructor.name ) || '',
	};

}

function pushUnsupported( result, seen, opts, kind, reason, value, detail = null ) {

	const key = `${ kind }:${ reason }:${ objectId( value ) }`;
	if ( seen.has( key ) ) return;
	seen.add( key );
	const entry = { kind, reason, ...describeValue( value ) };
	if ( detail ) entry.detail = detail;
	result.unsupported.push( entry );
	if ( typeof opts.onUnsupported === 'function' ) opts.onUnsupported( entry, value );

}

function reportError( opts, error, where ) {

	if ( typeof opts.onError === 'function' ) opts.onError( error, { where } );

}

function traverse( scene, callback ) {

	if ( scene && typeof scene.traverse === 'function' ) scene.traverse( callback );

}

function sourceMaterialOf( material ) {

	return material && material.__tslpSourceMaterial || material;

}

function materialList( material ) {

	return ( Array.isArray( material ) ? material : material ? [ material ] : [] ).map( sourceMaterialOf ).filter( Boolean );

}

function rawMaterialList( material ) {

	return ( Array.isArray( material ) ? material : material ? [ material ] : [] ).filter( Boolean );

}

function isEffectivelyVisible( object ) {

	let current = object;
	while ( current ) {

		if ( current.visible === false ) return false;
		current = current.parent;

	}
	return true;

}

function shadowNodeKeys( material ) {

	if ( ! material ) return [];
	return SHADOW_NODE_KEYS.filter( ( key ) => material[ key ] && material[ key ].isNode === true );

}

function hasShadowClipping( object, materials ) {

	for ( const material of materials ) {

		if ( material && Array.isArray( material.clippingPlanes ) && material.clippingPlanes.length > 0 ) return true;

	}
	let parent = object && object.parent;
	while ( parent ) {

		if ( parent.isClippingGroup === true && parent.enabled !== false && parent.clipShadows === true ) return true;
		parent = parent.parent;

	}
	return false;

}

function matrixSignature( object ) {

	const elements = object && object.matrixWorld && object.matrixWorld.elements;
	if ( ! elements ) return '';
	return Array.from( elements, Number ).join( ',' );

}

function valueSignature( value ) {

	if ( value === null ) return 'null';
	if ( value === undefined ) return '-';
	if ( typeof value === 'object' || typeof value === 'function' ) return `${ objectId( value ) }@${ value.version | 0 }`;
	return String( value );

}

function materialSignature( material ) {

	const source = sourceMaterialOf( material );
	if ( ! source ) return 'none';
	const nodes = shadowNodeKeys( source ).map( ( key ) => `${ key }:${ objectId( source[ key ] ) }` );
	const properties = SHADOW_MATERIAL_KEYS.map( ( key ) => `${ key }:${ valueSignature( source[ key ] ) }` );
	return [ objectId( source ), `version:${ source.version | 0 }`, ...nodes, ...properties ].join( ':' );

}

function geometrySignature( geometry ) {

	if ( ! geometry ) return 'none';
	const attributes = Object.entries( geometry.attributes || {} ).map( ( [ name, attribute ] ) => `${ name }:${ objectId( attribute ) }:${ attribute.version | 0 }` );
	const index = geometry.index ? `${ objectId( geometry.index ) }:${ geometry.index.version | 0 }` : '-';
	return `${ objectId( geometry ) }:${ index }:${ attributes.join( ',' ) }`;

}

function projectionSignature( camera ) {

	if ( ! camera ) return '';
	const keys = [ 'near', 'far', 'zoom', 'left', 'right', 'top', 'bottom', 'aspect', 'fov' ];
	const view = camera.view
		? Object.keys( camera.view ).sort().map( ( key ) => `${ key }:${ valueSignature( camera.view[ key ] ) }` ).join( ';' )
		: '-';
	return [
		...keys.map( ( key ) => `${ key }:${ valueSignature( camera[ key ] ) }` ),
		`layers:${ camera.layers && camera.layers.mask || 0 }`,
		`view:${ view }`,
	].join( ',' );

}

function shadowSettingsSignature( shadow ) {

	if ( ! shadow ) return '';
	const keys = [ 'bias', 'normalBias', 'radius', 'intensity', 'blurSamples', 'focus', 'aspect', 'mapType', 'autoUpdate', 'needsUpdate' ];
	return [
		...keys.map( ( key ) => `${ key }:${ valueSignature( shadow[ key ] ) }` ),
		`mapSize:${ shadow.mapSize && shadow.mapSize.x || 0 }x${ shadow.mapSize && shadow.mapSize.y || 0 }`,
		`camera:${ projectionSignature( shadow.camera ) }`,
	].join( ',' );

}

function lightSettingsSignature( light ) {

	const keys = [ 'distance', 'angle', 'penumbra', 'decay' ];
	return keys.map( ( key ) => `${ key }:${ valueSignature( light && light[ key ] ) }` ).join( ',' );

}

function sceneSignatures( scene, camera, slimRenderer ) {

	const topology = [];
	const frame = [];
	let alwaysUpdate = false;
	try { scene.updateMatrixWorld( true ); } catch ( _ ) {}
	traverse( scene, ( object ) => {

		if ( ! object || ! isEffectivelyVisible( object ) ) return;
		if ( object.isLight === true && object.castShadow === true && object.shadow ) {

			if ( object.shadow.autoUpdate !== false ) alwaysUpdate = true;
			const kind = object.isDirectionalLight ? 'directional' : object.isSpotLight ? 'spot' : object.isPointLight ? 'point' : 'other';
			topology.push( `l:${ objectId( object ) }:${ kind }:${ object.shadow.shadowNode ? 'custom' : 'standard' }` );
			frame.push( `l:${ matrixSignature( object ) }:${ matrixSignature( object.target ) }:layers:${ object.layers && object.layers.mask || 0 }:${ lightSettingsSignature( object ) }:${ shadowSettingsSignature( object.shadow ) }` );

		} else if ( object.geometry && ( object.castShadow === true || object.receiveShadow === true ) ) {

			const materials = Array.isArray( object.material ) ? object.material : [ object.material ];
			const materialState = materials.map( materialSignature ).join( '|' );
			const instanceState = object.isInstancedMesh && object.instanceMatrix
				? `${ objectId( object.instanceMatrix ) }:${ object.instanceMatrix.itemSize || 0 }:${ object.instanceMatrix.count || 0 }:${ object.instanceMatrix.array && object.instanceMatrix.array.length || 0 }`
				: '-';
			topology.push( `m:${ objectId( object ) }:${ geometrySignature( object.geometry ) }:${ object.castShadow ? 1 : 0 }:${ object.receiveShadow ? 1 : 0 }:${ object.isInstancedMesh ? 'i' : object.isSkinnedMesh ? 's' : object.isMesh ? 'm' : 'other' }:${ object.customDepthMaterial ? 1 : 0 }:${ object.customDistanceMaterial ? 1 : 0 }:instance:${ instanceState }:${ materialState }` );
			frame.push( `m:${ matrixSignature( object ) }:layers:${ object.layers && object.layers.mask || 0 }:${ object.count ?? 0 }:${ object.instanceMatrix && object.instanceMatrix.version || 0 }` );

		}

	} );
	const shadowType = slimRenderer && slimRenderer.shadowMap && slimRenderer.shadowMap.type;
	return {
		topology: topology.join( '|' ),
		frame: `${ shadowType ?? '' }:camera:${ matrixSignature( camera ) }:layers:${ camera && camera.layers && camera.layers.mask || 0 }:projection:${ projectionSignature( camera ) }:${ topology.join( '|' ) }:${ frame.join( '|' ) }`,
		alwaysUpdate,
	};

}

function cloneAttribute( attribute, Full ) {

	if ( ! attribute || ! attribute.array || ! Number.isInteger( attribute.itemSize ) ) return null;
	if ( attribute.isStorageBufferAttribute === true || attribute.isStorageInstancedBufferAttribute === true ) return null;
	try {

		let cloned = null;
		if ( attribute.isInterleavedBufferAttribute === true && Full.InterleavedBuffer && Full.InterleavedBufferAttribute ) {

			const data = attribute.data;
			if ( ! data || ! data.array || ! Number.isInteger( data.stride ) ) return null;
			const fullData = new Full.InterleavedBuffer( data.array, data.stride );
			if ( typeof data.usage === 'number' && typeof fullData.setUsage === 'function' ) fullData.setUsage( data.usage );
			cloned = new Full.InterleavedBufferAttribute( fullData, attribute.itemSize, attribute.offset, attribute.normalized );

		} else if ( attribute.isInstancedBufferAttribute === true && Full.InstancedBufferAttribute ) {

			cloned = new Full.InstancedBufferAttribute( attribute.array, attribute.itemSize, attribute.normalized === true, attribute.meshPerAttribute || 1 );

		} else if ( Full.BufferAttribute ) {

			cloned = new Full.BufferAttribute( attribute.array, attribute.itemSize, attribute.normalized === true );

		}
		if ( cloned && typeof attribute.usage === 'number' && typeof cloned.setUsage === 'function' ) cloned.setUsage( attribute.usage );
		return cloned;

	} catch ( _ ) {

		return null;

	}

}

function cloneGeometry( geometry, Full, geometryCache, ownedGeometries ) {

	if ( geometryCache.has( geometry ) ) return geometryCache.get( geometry );
	if ( ! Full.BufferGeometry ) return null;
	try {

		const cloned = new Full.BufferGeometry();
		ownedGeometries.add( cloned );
		if ( geometry.index ) {

			const index = cloneAttribute( geometry.index, Full );
			if ( ! index ) return null;
			cloned.setIndex( index );

		}
		for ( const [ name, attribute ] of Object.entries( geometry.attributes || {} ) ) {

			const fullAttribute = cloneAttribute( attribute, Full );
			if ( ! fullAttribute ) return null;
			cloned.setAttribute( name, fullAttribute );

		}
		for ( const [ name, attributes ] of Object.entries( geometry.morphAttributes || {} ) ) {

			const mapped = attributes.map( ( attribute ) => cloneAttribute( attribute, Full ) );
			if ( mapped.some( ( attribute ) => ! attribute ) ) return null;
			cloned.morphAttributes[ name ] = mapped;

		}
		cloned.morphTargetsRelative = geometry.morphTargetsRelative === true;
		if ( geometry.drawRange ) cloned.setDrawRange( geometry.drawRange.start || 0, geometry.drawRange.count === undefined ? Infinity : geometry.drawRange.count );
		for ( const group of geometry.groups || [] ) cloned.addGroup( group.start || 0, group.count || 0, group.materialIndex || 0 );
		geometryCache.set( geometry, cloned );
		return cloned;

	} catch ( _ ) {

		return null;

	}

}

function copyObjectTransform( source, target ) {

	if ( source && source.matrixWorld && typeof source.matrixWorld.decompose === 'function' && target.position && target.quaternion && target.scale ) {

		source.matrixWorld.decompose( target.position, target.quaternion, target.scale );

	} else {

		for ( const key of [ 'position', 'quaternion', 'scale' ] ) {

			if ( source && source[ key ] && target[ key ] && typeof target[ key ].copy === 'function' ) target[ key ].copy( source[ key ] );

		}

	}
	if ( source && source.layers && target.layers ) target.layers.mask = source.layers.mask;
	target.visible = source.visible !== false;

}

function copyShadowSettings( source, target ) {

	if ( ! source || ! target ) return;
	for ( const key of [ 'bias', 'normalBias', 'radius', 'intensity', 'blurSamples', 'focus', 'aspect', 'mapType', 'autoUpdate', 'needsUpdate' ] ) {

		if ( source[ key ] !== undefined ) target[ key ] = source[ key ];

	}
	if ( source.mapSize && target.mapSize ) {

		if ( typeof target.mapSize.copy === 'function' ) target.mapSize.copy( source.mapSize );
		else if ( typeof target.mapSize.set === 'function' ) target.mapSize.set( source.mapSize.x, source.mapSize.y );

	}
	const sourceCamera = source.camera;
	const targetCamera = target.camera;
	if ( sourceCamera && targetCamera ) {

		for ( const key of [ 'near', 'far', 'zoom', 'left', 'right', 'top', 'bottom', 'aspect', 'fov' ] ) {

			if ( sourceCamera[ key ] !== undefined ) targetCamera[ key ] = sourceCamera[ key ];

		}
		if ( sourceCamera.layers && targetCamera.layers ) targetCamera.layers.mask = sourceCamera.layers.mask;
		targetCamera.view = sourceCamera.view ? { ...sourceCamera.view } : null;
		if ( typeof targetCamera.updateProjectionMatrix === 'function' ) targetCamera.updateProjectionMatrix();

	}

}

function copyLightSettings( source, target ) {

	if ( ! source || ! target ) return;
	for ( const key of [ 'intensity', 'distance', 'angle', 'penumbra', 'decay' ] ) {

		if ( source[ key ] !== undefined ) target[ key ] = source[ key ];

	}
	if ( source.color && target.color && typeof target.color.copy === 'function' ) target.color.copy( source.color );

}

function makeLightClone( source, Full, ownedShadows ) {

	const color = source.color && typeof source.color.getHex === 'function' ? source.color.getHex() : source.color || 0xffffff;
	const intensity = source.intensity ?? 1;
	let clone = null;
	if ( source.isDirectionalLight === true && Full.DirectionalLight ) clone = new Full.DirectionalLight( color, intensity );
	else if ( source.isSpotLight === true && Full.SpotLight ) clone = new Full.SpotLight( color, intensity, source.distance, source.angle, source.penumbra, source.decay );
	else if ( source.isPointLight === true && Full.PointLight ) clone = new Full.PointLight( color, intensity, source.distance, source.decay );
	if ( ! clone || ! clone.shadow ) return null;
	ownedShadows.add( clone.shadow );
	clone.castShadow = true;
	clone.map = source.map || null;
	copyShadowSettings( source.shadow, clone.shadow );
	copyObjectTransform( source, clone );
	return clone;

}

function makeStandinMaterial( source, Full, ownedMaterials ) {

	const Material = Full.MeshLambertNodeMaterial || Full.MeshLambertMaterial;
	if ( ! Material ) return null;
	let material = null;
	try { material = new Material( { color: 0xffffff } ); } catch ( _ ) { material = new Material(); }
	ownedMaterials.add( material );
	for ( const key of SHADOW_MATERIAL_KEYS ) {

		if ( source && source[ key ] !== undefined ) material[ key ] = source[ key ];

	}
	return material;

}

function resolveProxyMaterials( object, Full, opts, result, unsupportedSeen, ownedMaterials ) {

	const inputs = rawMaterialList( object.material );
	if ( inputs.length === 0 ) {

		pushUnsupported( result, unsupportedSeen, opts, 'object', 'missing-shadow-material', object );
		return null;

	}
	const output = [];
	for ( const originalMaterial of inputs ) {

		const source = sourceMaterialOf( originalMaterial );
		const nodeKeys = shadowNodeKeys( source );
		let mapped = null;
		if ( typeof opts.resolveShadowMaterial === 'function' ) {

			try {

				mapped = opts.resolveShadowMaterial( source, object, { threeFullModule: Full, originalMaterial } ) || null;
				if ( mapped && typeof mapped.then === 'function' ) mapped = null;

			} catch ( error ) {

				reportError( opts, error, 'resolveShadowMaterial' );

			}

		}
		if ( nodeKeys.length > 0 && ( ! mapped || mapped.isPrecompiledMaterial === true ) ) {

			pushUnsupported( result, unsupportedSeen, opts, 'material', 'opaque-shadow-material', source, nodeKeys.join( ',' ) );
			return null;

		}
		const material = mapped || makeStandinMaterial( source, Full, ownedMaterials );
		if ( ! material ) {

			pushUnsupported( result, unsupportedSeen, opts, 'material', 'full-material-unavailable', source );
			return null;

		}
		output.push( material );

	}
	return Array.isArray( object.material ) ? output : output[ 0 ];

}

function buildShadowScene( scene, Full, opts, state, result, unsupportedSeen ) {

	if ( ! Full.Scene || ! Full.Mesh || ! Full.BufferGeometry || ( ! Full.MeshLambertNodeMaterial && ! Full.MeshLambertMaterial ) ) {

		pushUnsupported( result, unsupportedSeen, opts, 'module', 'missing-full-three-shadow-classes', Full );
		return null;

	}
	const shadowScene = new Full.Scene();
	const lightPairs = [];
	const objectPairs = [];
	const ownedGeometries = new Set();
	const ownedMaterials = new Set();
	const ownedShadows = new Set();
	const proxy = { scene: shadowScene, lightPairs, objectPairs, ownedGeometries, ownedMaterials, ownedShadows, disposed: false };
	let fatal = false;
	try { scene.updateMatrixWorld( true ); } catch ( _ ) {}
	try {

		traverse( scene, ( object ) => {

		if ( fatal || ! object || ! isEffectivelyVisible( object ) ) return;
		if ( object.isLight === true && object.castShadow === true && object.shadow ) {

			result.lightsConsidered ++;
			if ( object.shadow.shadowNode ) {

				pushUnsupported( result, unsupportedSeen, opts, 'light', 'custom-shadow-node', object );
				fatal = true;
				return;

			}
			const clone = makeLightClone( object, Full, ownedShadows );
			if ( ! clone ) {

				pushUnsupported( result, unsupportedSeen, opts, 'light', 'unsupported-shadow-light', object );
				fatal = true;
				return;

			}
			let targetClone = null;
			if ( object.target && Full.Object3D ) {

				targetClone = new Full.Object3D();
				copyObjectTransform( object.target, targetClone );
				shadowScene.add( targetClone );
				clone.target = targetClone;

			}
			shadowScene.add( clone );
			lightPairs.push( { source: object, clone, targetClone } );
			return;

		}
		if ( ! object.geometry || ( object.castShadow !== true && object.receiveShadow !== true ) ) return;
		if ( object.castShadow === true && ( object.isSkinnedMesh === true || object.isBatchedMesh === true ) ) {

			pushUnsupported( result, unsupportedSeen, opts, 'object', object.isSkinnedMesh ? 'skinned-shadow-caster' : 'batched-shadow-caster', object );
			fatal = true;
			return;

		}
		if ( object.castShadow === true && (
			object.morphTexture
			|| object.morphTargetInfluences && object.morphTargetInfluences.length > 0
			|| Object.values( object.geometry.morphAttributes || {} ).some( ( attributes ) => Array.isArray( attributes ) && attributes.length > 0 )
		) ) {

			pushUnsupported( result, unsupportedSeen, opts, 'object', 'morph-shadow-caster', object );
			fatal = true;
			return;

		}
		if ( object.castShadow === true && object.isInstancedMesh === true && object.instanceColor ) {

			pushUnsupported( result, unsupportedSeen, opts, 'object', 'instance-color-shadow-caster', object );
			fatal = true;
			return;

		}
		if ( object.isMesh !== true ) {

			if ( object.castShadow === true ) {

				pushUnsupported( result, unsupportedSeen, opts, 'object', 'unsupported-shadow-caster-type', object );
				fatal = true;

			}
			return;

		}
		if ( object.castShadow === true && ( object.customDepthMaterial || object.customDistanceMaterial ) ) {

			pushUnsupported( result, unsupportedSeen, opts, 'object', 'custom-depth-material', object );
			fatal = true;
			return;

		}
		const sources = materialList( object.material );
		if ( object.castShadow === true && hasShadowClipping( object, sources ) ) {

			pushUnsupported( result, unsupportedSeen, opts, 'object', 'clipped-shadow-caster', object );
			fatal = true;
			return;

		}
		const material = resolveProxyMaterials( object, Full, opts, result, unsupportedSeen, ownedMaterials );
		if ( ! material ) {

			if ( object.castShadow === true ) fatal = true;
			return;

		}
		const geometry = cloneGeometry( object.geometry, Full, state.geometryCache, ownedGeometries );
		if ( ! geometry ) {

			pushUnsupported( result, unsupportedSeen, opts, 'object', 'geometry-clone-failed', object );
			if ( object.castShadow === true ) fatal = true;
			return;

		}
		let clone = null;
		if ( object.isInstancedMesh === true ) {

			if ( ! Full.InstancedMesh || ! object.instanceMatrix ) {

				pushUnsupported( result, unsupportedSeen, opts, 'object', 'instanced-shadow-caster-unavailable', object );
				fatal = object.castShadow === true;
				return;

			}
			const instanceMatrix = cloneAttribute( object.instanceMatrix, Full );
			if ( ! instanceMatrix ) {

				pushUnsupported( result, unsupportedSeen, opts, 'object', 'gpu-owned-instance-matrix', object );
				fatal = object.castShadow === true;
				return;

			}
			clone = new Full.InstancedMesh( geometry, material, object.count ?? object.instanceMatrix.count ?? 1 );
			clone.instanceMatrix = instanceMatrix;

		} else {

			clone = new Full.Mesh( geometry, material );

		}
		clone.castShadow = object.castShadow === true;
		clone.receiveShadow = object.receiveShadow === true;
		clone.frustumCulled = false;
		copyObjectTransform( object, clone );
		shadowScene.add( clone );
		objectPairs.push( { source: object, clone } );
		if ( clone.castShadow ) result.castersMirrored ++;
		if ( clone.receiveShadow ) result.receiversMirrored ++;

		} );

	} catch ( error ) {

		reportError( opts, error, 'buildShadowScene' );
		fatal = true;

	}
	if ( fatal || lightPairs.length === 0 || result.castersMirrored === 0 ) {

		disposeShadowProxy( proxy );
		return null;

	}
	return proxy;

}

function safelyDispose( value ) {

	if ( ! value || typeof value.dispose !== 'function' ) return;
	try { value.dispose(); } catch ( _ ) {}

}

function restoreSourceShadow( pair ) {

	const restoration = pair && pair.sourceShadowRestoration;
	if ( ! restoration || ! pair.source || pair.source.shadow !== restoration.shadow ) return;
	const shadow = restoration.shadow;
	if ( shadow.map === restoration.proxyMap ) shadow.map = restoration.map;
	if ( shadow.camera === restoration.proxyCamera ) shadow.camera = restoration.camera;
	if ( shadow.matrix === restoration.proxyMatrix ) shadow.matrix = restoration.matrix;

}

function disposeShadowProxy( proxy ) {

	if ( ! proxy || proxy.disposed === true ) return false;
	proxy.disposed = true;
	for ( const pair of proxy.lightPairs || [] ) {

		restoreSourceShadow( pair );

	}
	for ( const shadow of proxy.ownedShadows || [] ) safelyDispose( shadow );
	for ( const material of proxy.ownedMaterials || [] ) safelyDispose( material );
	for ( const geometry of proxy.ownedGeometries || [] ) safelyDispose( geometry );
	if ( proxy.scene && typeof proxy.scene.clear === 'function' ) {

		try { proxy.scene.clear(); } catch ( _ ) {}

	}
	return true;

}

function resetStateResources( state ) {

	if ( ! state ) return false;
	let disposed = disposeShadowProxy( state.proxy );
	state.proxy = null;
	state.geometryCache = new WeakMap();
	if ( state.ownsRenderTarget === true && state.renderTarget ) {

		safelyDispose( state.renderTarget );
		disposed = true;

	}
	state.renderTarget = null;
	state.ownsRenderTarget = false;
	state.topologySignature = '';
	state.signature = '';
	state.lastResult = null;
	return disposed;

}

function createShadowState() {

	return {
		geometryCache: new WeakMap(),
		proxy: null,
		topologySignature: '',
		signature: '',
		lastResult: null,
		inflight: null,
		inflightSignature: '',
		renderTarget: null,
		ownsRenderTarget: false,
		fullRenderer: null,
		threeFullModule: null,
		disposeRequested: false,
		disposalPromise: null,
		disposed: false,
	};

}

function deleteCachedState( cache, scene, state ) {

	if ( ! cache || cache.get( scene ) !== state ) return;
	if ( typeof cache.delete === 'function' ) cache.delete( scene );
	else if ( typeof cache.set === 'function' ) cache.set( scene, null );

}

function refreshShadowScene( sourceScene, proxy ) {

	try { sourceScene.updateMatrixWorld( true ); } catch ( _ ) {}
	for ( const pair of proxy.lightPairs ) {

		copyObjectTransform( pair.source, pair.clone );
		copyLightSettings( pair.source, pair.clone );
		copyShadowSettings( pair.source.shadow, pair.clone.shadow );
		if ( pair.targetClone && pair.source.target ) copyObjectTransform( pair.source.target, pair.targetClone );

	}
	for ( const pair of proxy.objectPairs ) {

		copyObjectTransform( pair.source, pair.clone );
		pair.clone.visible = pair.source.visible !== false;
		if ( pair.source.isInstancedMesh === true && pair.clone.instanceMatrix && pair.source.instanceMatrix ) {

			pair.clone.count = pair.source.count;
			if ( pair.clone.instanceMatrix.array !== pair.source.instanceMatrix.array ) pair.clone.instanceMatrix.array.set( pair.source.instanceMatrix.array );
			pair.clone.instanceMatrix.needsUpdate = true;

		}

	}

}

function cloneCamera( camera, Full, fullRenderer ) {

	let clone = null;
	if ( camera && camera.isPerspectiveCamera === true && Full.PerspectiveCamera ) {

		clone = new Full.PerspectiveCamera( camera.fov, camera.aspect, camera.near, camera.far );

	} else if ( camera && camera.isOrthographicCamera === true && Full.OrthographicCamera ) {

		clone = new Full.OrthographicCamera( camera.left, camera.right, camera.top, camera.bottom, camera.near, camera.far );

	}
	if ( ! clone ) return null;
	clone.zoom = camera.zoom;
	copyObjectTransform( camera, clone );
	if ( fullRenderer.coordinateSystem !== undefined ) clone.coordinateSystem = fullRenderer.coordinateSystem;
	if ( typeof clone.updateProjectionMatrix === 'function' ) clone.updateProjectionMatrix();
	if ( typeof clone.updateMatrixWorld === 'function' ) clone.updateMatrixWorld( true );
	return clone;

}

async function populateOnce( opts, state, signatures ) {

	const { scene, camera, slimRenderer, fullRenderer, threeFullModule: Full } = opts;
	const result = emptyResult();
	const unsupportedSeen = new Set();
	if ( state.disposeRequested === true ) return result;
	const slimDevice = slimRenderer.backend && slimRenderer.backend.device;
	const fullDevice = fullRenderer.backend && fullRenderer.backend.device;
	if ( slimDevice && fullDevice && slimDevice !== fullDevice ) {

		pushUnsupported( result, unsupportedSeen, opts, 'renderer', 'gpu-device-mismatch', slimRenderer );
		return result;

	}
	if ( ( slimRenderer.reversedDepthBuffer === true ) !== ( fullRenderer.reversedDepthBuffer === true ) ) {

		pushUnsupported( result, unsupportedSeen, opts, 'renderer', 'reversed-depth-mismatch', slimRenderer );
		return result;

	}
	const shadowType = slimRenderer.shadowMap && slimRenderer.shadowMap.type !== undefined
		? slimRenderer.shadowMap.type
		: fullRenderer.shadowMap && fullRenderer.shadowMap.type;
	if ( Full.VSMShadowMap !== undefined && shadowType === Full.VSMShadowMap ) {

		pushUnsupported( result, unsupportedSeen, opts, 'renderer', 'vsm-shadow-map', slimRenderer );
		return result;

	}
	if ( slimRenderer.shadowMap && slimRenderer.shadowMap.transmitted === true ) {

		pushUnsupported( result, unsupportedSeen, opts, 'renderer', 'transmitted-shadow-map', slimRenderer );
		return result;

	}
	if ( camera.isArrayCamera === true ) {

		pushUnsupported( result, unsupportedSeen, opts, 'camera', 'array-shadow-camera', camera );
		return result;

	}
	let proxy = state.proxy;
	if ( ! proxy || state.topologySignature !== signatures.topology ) {

		result.proxyReused = false;
		resetStateResources( state );
		proxy = buildShadowScene( scene, Full, opts, state, result, unsupportedSeen );
		if ( ! proxy ) return result;
		state.proxy = proxy;
		state.topologySignature = signatures.topology;

	} else {

		result.proxyReused = true;
		result.lightsConsidered = proxy.lightPairs.length;
		result.castersMirrored = proxy.objectPairs.filter( ( pair ) => pair.clone.castShadow === true ).length;
		result.receiversMirrored = proxy.objectPairs.filter( ( pair ) => pair.clone.receiveShadow === true ).length;

	}
	refreshShadowScene( scene, proxy );
	const fullCamera = cloneCamera( camera, Full, fullRenderer );
	if ( ! fullCamera ) {

		pushUnsupported( result, unsupportedSeen, opts, 'camera', 'unsupported-shadow-camera', camera );
		return result;

	}
	let discardTarget = opts.renderTarget || state.renderTarget;
	if ( ! discardTarget && Full.RenderTarget ) {

		discardTarget = new Full.RenderTarget( opts.discardSize || 256, opts.discardSize || 256 );
		state.renderTarget = discardTarget;
		state.ownsRenderTarget = true;

	}
	if ( ! discardTarget || typeof fullRenderer.setRenderTarget !== 'function' || typeof fullRenderer.render !== 'function' ) {

		pushUnsupported( result, unsupportedSeen, opts, 'renderer', 'full-shadow-renderer-unavailable', fullRenderer );
		return result;

	}
	const previousTarget = typeof fullRenderer.getRenderTarget === 'function' ? fullRenderer.getRenderTarget() : null;
	const previousEnabled = fullRenderer.shadowMap && fullRenderer.shadowMap.enabled;
	const previousType = fullRenderer.shadowMap && fullRenderer.shadowMap.type;
	const previousTransmitted = fullRenderer.shadowMap && fullRenderer.shadowMap.transmitted;
	try {

		if ( fullRenderer.shadowMap ) {

			fullRenderer.shadowMap.enabled = true;
			if ( typeof shadowType === 'number' ) fullRenderer.shadowMap.type = shadowType;
			if ( slimRenderer.shadowMap && slimRenderer.shadowMap.transmitted !== undefined ) fullRenderer.shadowMap.transmitted = slimRenderer.shadowMap.transmitted;

		}
		fullRenderer.setRenderTarget( discardTarget );
		for ( const pair of proxy.lightPairs ) pair.clone.shadow.needsUpdate = true;
		await fullRenderer.render( proxy.scene, fullCamera );
		for ( const pair of proxy.lightPairs ) pair.clone.shadow.needsUpdate = true;
		await fullRenderer.render( proxy.scene, fullCamera );
		const queue = fullRenderer.backend && fullRenderer.backend.device && fullRenderer.backend.device.queue;
		if ( queue && typeof queue.onSubmittedWorkDone === 'function' ) await queue.onSubmittedWorkDone();
		if ( state.disposeRequested === true ) return result;
		result.rendered = true;

	} catch ( error ) {

		reportError( opts, error, 'renderShadowScene' );
		return result;

	} finally {

		try { fullRenderer.setRenderTarget( previousTarget ); } catch ( _ ) {}
		if ( fullRenderer.shadowMap ) {

			fullRenderer.shadowMap.enabled = previousEnabled;
			fullRenderer.shadowMap.type = previousType;
			fullRenderer.shadowMap.transmitted = previousTransmitted;

		}

	}
	for ( const pair of proxy.lightPairs ) {

		if ( state.disposeRequested === true ) return result;
		const sourceShadow = pair.source.shadow;
		const cloneShadow = pair.clone.shadow;
		const map = cloneShadow && cloneShadow.map;
		const depthTexture = map && ( map.depthTexture || ( map.texture && map.texture.isDepthTexture === true ? map.texture : null ) );
		if ( ! sourceShadow || ! map || ! depthTexture ) {

			pushUnsupported( result, unsupportedSeen, opts, 'light', 'shadow-depth-texture-missing', pair.source );
			continue;

		}
		if ( ! pair.sourceShadowRestoration ) {

			pair.sourceShadowRestoration = {
				shadow: sourceShadow,
				map: sourceShadow.map,
				camera: sourceShadow.camera,
				matrix: sourceShadow.matrix,
				proxyMap: null,
				proxyCamera: null,
				proxyMatrix: null,
			};

		}
		const restoration = pair.sourceShadowRestoration;
		restoration.proxyMap = map;
		restoration.proxyCamera = cloneShadow.camera;
		restoration.proxyMatrix = cloneShadow.matrix;
		sourceShadow.map = restoration.proxyMap;
		sourceShadow.camera = restoration.proxyCamera;
		sourceShadow.matrix = restoration.proxyMatrix;
		sourceShadow.needsUpdate = false;
		result.lightsPopulated ++;
		if ( shareShadowGPUTextureIntoSlim( depthTexture, fullRenderer, slimRenderer ) ) result.texturesShared ++;
		else pushUnsupported( result, unsupportedSeen, opts, 'light', 'shadow-gpu-texture-unavailable', pair.source );

	}
	result.complete = result.rendered
		&& result.lightsPopulated === proxy.lightPairs.length
		&& result.texturesShared === result.lightsPopulated
		&& result.unsupported.length === 0;
	return result;

}

/**
 * Populate standard PCF shadow maps through a full renderer and share their
 * depth GPU textures into slim.
 *
 * @param {Object} opts
 * @param {Object} opts.scene
 * @param {Object} opts.camera
 * @param {Object} opts.slimRenderer
 * @param {Object} opts.fullRenderer
 * @param {Object} opts.threeFullModule
 * @param {Function} [opts.resolveShadowMaterial] synchronous full-material mapper for node-displaced casters
 * @param {WeakMap|Map} [opts.cache]
 * @param {Object} [opts.renderTarget]
 * @param {number} [opts.discardSize=256]
 * @param {Function} [opts.onUnsupported]
 * @param {Function} [opts.onError]
 * @returns {Promise<Object>}
 */
export function populateShadowMapsWithFullRenderer( opts = {} ) {

	const { scene, camera, slimRenderer, fullRenderer, threeFullModule } = opts || {};
	if ( ! scene || ! camera || ! slimRenderer || ! fullRenderer || ! threeFullModule ) return Promise.resolve( emptyResult() );
	const cache = opts.cache && typeof opts.cache.get === 'function' && typeof opts.cache.set === 'function' ? opts.cache : DEFAULT_CACHE;
	let state = cache.get( scene );
	if ( state && state.disposeRequested === true ) {

		const disposal = state.disposalPromise || state.inflight;
		if ( disposal ) return Promise.resolve( disposal ).then( () => populateShadowMapsWithFullRenderer( opts ) );
		deleteCachedState( cache, scene, state );
		state = null;

	}
	if ( ! state || state.disposed === true ) {

		state = createShadowState();
		cache.set( scene, state );

	}
	const sceneState = sceneSignatures( scene, camera, slimRenderer );
	const ownerSignature = `${ objectId( slimRenderer ) }:${ objectId( fullRenderer ) }:${ objectId( threeFullModule ) }:resolver:${ objectId( opts.resolveShadowMaterial ) }`;
	const signatures = {
		topology: `${ ownerSignature }:${ sceneState.topology }`,
		frame: `${ ownerSignature }:${ sceneState.frame }`,
	};
	if ( sceneState.alwaysUpdate !== true && state.signature === signatures.frame && state.lastResult && state.lastResult.complete === true ) {

		return Promise.resolve( { ...state.lastResult, unsupported: state.lastResult.unsupported.slice(), reused: true, proxyReused: true } );

	}
	if ( state.inflight ) {

		if ( state.inflightSignature === signatures.frame ) return state.inflight;
		return state.inflight.then( () => populateShadowMapsWithFullRenderer( opts ) );

	}
	if ( state.fullRenderer !== fullRenderer || state.threeFullModule !== threeFullModule ) {

		resetStateResources( state );
		state.fullRenderer = fullRenderer;
		state.threeFullModule = threeFullModule;

	}
	state.inflightSignature = signatures.frame;
	const promise = populateOnce( opts, state, signatures ).then( ( result ) => {

		if ( result.complete && state.disposeRequested !== true ) {

			const completedSceneState = sceneSignatures( scene, camera, slimRenderer );
			state.signature = `${ ownerSignature }:${ completedSceneState.frame }`;
			state.lastResult = { ...result, unsupported: result.unsupported.slice() };

		}
		return result;

	} ).finally( () => {

		if ( state.inflight === promise ) {

			if ( state.disposeRequested === true ) {

				resetStateResources( state );
				state.disposed = true;

			}
			state.inflight = null;
			state.inflightSignature = '';

		}

	} );
	state.inflight = promise;
	return promise;

}

/**
 * Dispose the cached proxy state for a scene.
 *
 * Disposal is synchronous when no shadow render is active. If a render is in
 * flight, an unusable cache tombstone serializes replacement work until that
 * render settles and its owned resources have been released.
 *
 * @param {Object} opts
 * @param {Object} opts.scene
 * @param {WeakMap|Map} [opts.cache]
 * @returns {boolean|Promise<boolean>} whether cached state was found
 */
export function disposeShadowMapsWithFullRenderer( opts = {} ) {

	const scene = opts && opts.scene;
	if ( ! scene ) return false;
	const cache = opts.cache && typeof opts.cache.get === 'function' ? opts.cache : DEFAULT_CACHE;
	const state = cache.get( scene );
	if ( ! state ) return false;
	if ( state.disposeRequested === true ) return state.disposalPromise || false;
	state.disposeRequested = true;
	state.signature = '';
	state.lastResult = null;
	if ( state.inflight ) {

		const disposal = state.inflight.then( () => true, () => true ).then( ( disposed ) => {

			if ( state.disposed !== true ) {

				resetStateResources( state );
				state.disposed = true;

			}
			deleteCachedState( cache, scene, state );
			return disposed;

		} );
		state.disposalPromise = disposal;
		return disposal;

	}
	resetStateResources( state );
	state.disposed = true;
	deleteCachedState( cache, scene, state );
	return true;

}
