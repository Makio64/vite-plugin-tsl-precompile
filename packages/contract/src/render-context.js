import { normalizeNode, normalizeRenderContextSignature } from './graph-normalize.js';
import { ARTIFACT_TOOLCHAIN_VERSION } from './versions.js';

/**
 * Describe only the render-context state that can select a different shader or
 * binding/pipeline shape. Positions, colors, matrices, intensities, plane
 * equations, and other live scalar data are intentionally omitted.
 *
 * The helper is duck-typed so capture can use it with full three.js while the
 * runtime/contract package stays free of a three.js dependency.
 *
 * @param {{
 *   renderer?: Object,
 *   scene?: Object,
 *   camera?: Object,
 *   object?: Object,
 *   material?: Object,
 *   renderTarget?: Object|null,
 *   mrt?: Object|null,
 * }} context
 * @return {Object}
 */
export function describeRenderContext( context = {} ) {

	const renderer = context.renderer || null;
	const scene = context.scene || null;
	const camera = context.camera || null;
	const object = context.object || null;
	const material = context.material || ( object && object.material ) || null;
	const renderTarget = context.renderTarget !== undefined
		? context.renderTarget
		: safeCall( renderer, 'getRenderTarget' );
	const mrt = context.mrt !== undefined ? context.mrt : safeCall( renderer, 'getMRT' );

	return {
		version: `render-context@${ ARTIFACT_TOOLCHAIN_VERSION }`,
		renderer: describeRenderer( renderer ),
		renderTarget: describeRenderTarget( renderTarget ),
		mrt: describeMRT( mrt ),
		scene: describeScene( scene, camera ),
		camera: describeCamera( camera ),
		object: describeObject( object ),
		clipping: describeClipping( material, object ),
	};

}

/**
 * Return the canonical string accepted by the material hashers as
 * `renderContextSignature` and safe to persist directly in artifact JSON.
 *
 * @param {Parameters<typeof describeRenderContext>[0]} context
 * @return {string}
 */
export function createRenderContextSignature( context = {} ) {

	return normalizeRenderContextSignature( describeRenderContext( context ) );

}

function describeRenderer( renderer ) {

	if ( ! renderer ) return null;
	const shadowMap = safeRead( renderer, 'shadowMap' );
	const backend = safeRead( renderer, 'backend' );
	return compactObject( {
		type: typeTag( renderer ),
		backend: backend ? typeTag( backend ) : null,
		coordinateSystem: topologyScalar( safeRead( renderer, 'coordinateSystem' ) ),
		depth: topologyScalar( safeRead( renderer, 'depth' ) ),
		logarithmicDepthBuffer: topologyScalar( safeRead( renderer, 'logarithmicDepthBuffer' ) ),
		highPrecision: safeRead( renderer, 'highPrecision' ) === true ? true : null,
		outputColorSpace: topologyScalar( safeRead( renderer, 'outputColorSpace' ) ),
		toneMapping: topologyScalar( safeRead( renderer, 'toneMapping' ) ),
		transparent: topologyScalar( safeRead( renderer, 'transparent' ) ),
		currentSamples: topologyScalar( safeRead( renderer, 'currentSamples' ) ),
		shadowMap: shadowMap ? compactObject( {
			enabled: topologyScalar( safeRead( shadowMap, 'enabled' ) ),
			type: topologyScalar( safeRead( shadowMap, 'type' ) ),
		} ) : null,
	} );

}

function describeScene( scene, camera ) {

	if ( ! scene ) return null;
	const lights = [];
	traverseObjects( scene, ( object ) => {

		if ( safeRead( object, 'isLight' ) !== true ) return;
		lights.push( describeLight( object, camera ) );

	} );

	return compactObject( {
		type: typeTag( scene ),
		fog: describeFog( safeRead( scene, 'fog' ) ),
		environment: resourceShape( safeRead( scene, 'environment' ) ),
		environmentNode: nodeShape( safeRead( scene, 'environmentNode' ) ),
		backgroundNode: nodeShape( safeRead( scene, 'backgroundNode' ) ),
		overrideMaterial: safeRead( scene, 'overrideMaterial' ) ? typeTag( safeRead( scene, 'overrideMaterial' ) ) : null,
		lights,
	} );

}

function describeLight( light, camera ) {

	const shadow = safeRead( light, 'shadow' );
	const lightLayers = safeRead( safeRead( light, 'layers' ), 'mask' );
	const cameraLayers = safeRead( safeRead( camera, 'layers' ), 'mask' );
	return compactObject( {
		type: typeTag( light ),
		visible: safeRead( light, 'visible' ) !== false,
		layers: topologyScalar( lightLayers ),
		visibleToCameraLayers: typeof lightLayers === 'number' && typeof cameraLayers === 'number'
			? ( lightLayers & cameraLayers ) !== 0
			: null,
		castShadow: safeRead( light, 'castShadow' ) === true,
		map: resourceShape( safeRead( light, 'map' ) ),
		colorNode: nodeShape( safeRead( light, 'colorNode' ) ),
		shadow: shadow ? compactObject( {
			type: typeTag( shadow ),
			camera: safeRead( shadow, 'camera' ) ? typeTag( safeRead( shadow, 'camera' ) ) : null,
		} ) : null,
	} );

}

function describeFog( fog ) {

	if ( ! fog ) return null;
	return compactObject( {
		type: typeTag( fog ),
		isFog: safeRead( fog, 'isFog' ) === true,
		isFogExp2: safeRead( fog, 'isFogExp2' ) === true,
	} );

}

function describeCamera( camera ) {

	if ( ! camera ) return null;
	const childCameras = Array.isArray( safeRead( camera, 'cameras' ) ) ? camera.cameras : [];
	const view = safeRead( camera, 'view' );
	return compactObject( {
		type: typeTag( camera ),
		perspective: safeRead( camera, 'isPerspectiveCamera' ) === true,
		orthographic: safeRead( camera, 'isOrthographicCamera' ) === true,
		array: safeRead( camera, 'isArrayCamera' ) === true,
		views: childCameras.map( ( child ) => typeTag( child ) ),
		viewEnabled: !! ( view && safeRead( view, 'enabled' ) !== false ),
		coordinateSystem: topologyScalar( safeRead( camera, 'coordinateSystem' ) ),
		layers: topologyScalar( safeRead( safeRead( camera, 'layers' ), 'mask' ) ),
	} );

}

function describeObject( object ) {

	if ( ! object ) return null;
	const geometry = safeRead( object, 'geometry' );
	const instanceMatrix = safeRead( object, 'instanceMatrix' );
	return compactObject( {
		type: typeTag( object ),
		visible: safeRead( object, 'visible' ) !== false,
		castShadow: safeRead( object, 'castShadow' ) === true,
		receiveShadow: safeRead( object, 'receiveShadow' ) === true,
		skinned: safeRead( object, 'isSkinnedMesh' ) === true,
		instanced: safeRead( object, 'isInstancedMesh' ) === true,
		batched: safeRead( object, 'isBatchedMesh' ) === true,
		instanceMatrix: !! instanceMatrix,
		// r185 emits a fixed-size uniform array for InstanceNode. Persist its
		// physical capacity so capture cannot coalesce incompatible shaders
		// merely because both render objects are instanced.
		instanceMatrixCount: instanceMatrixCapacity( instanceMatrix ),
		instanceColor: !! safeRead( object, 'instanceColor' ),
		batchColors: !! safeRead( object, '_colorsTexture' ),
		geometry: describeGeometry( geometry ),
	} );

}

function instanceMatrixCapacity( instanceMatrix ) {

	if ( ! instanceMatrix ) return undefined;
	const count = Number( safeRead( instanceMatrix, 'count' ) );
	if ( Number.isSafeInteger( count ) && count >= 0 ) return count;
	const array = safeRead( instanceMatrix, 'array' );
	const itemSize = Number( safeRead( instanceMatrix, 'itemSize' ) ) || 16;
	if ( ! array || ! Number.isSafeInteger( array.length ) || itemSize <= 0 || array.length % itemSize !== 0 ) return undefined;
	return array.length / itemSize;

}

function describeGeometry( geometry ) {

	if ( ! geometry ) return null;
	const attributes = safeRead( geometry, 'attributes' ) || {};
	const morphAttributes = safeRead( geometry, 'morphAttributes' ) || {};
	return compactObject( {
		type: typeTag( geometry ),
		index: describeAttribute( safeRead( geometry, 'index' ) ),
		attributes: Object.keys( attributes ).sort().map( ( name ) => [ name, describeAttribute( attributes[ name ] ) ] ),
		morphAttributes: Object.keys( morphAttributes ).sort().map( ( name ) => [
			name,
			Array.isArray( morphAttributes[ name ] ) ? morphAttributes[ name ].map( describeAttribute ) : [],
		] ),
		morphTargetsRelative: topologyScalar( safeRead( geometry, 'morphTargetsRelative' ) ),
	} );

}

function describeAttribute( attribute ) {

	if ( ! attribute ) return null;
	const array = safeRead( attribute, 'array' );
	return compactObject( {
		type: typeTag( attribute ),
		arrayType: array ? typeTag( array ) : null,
		itemSize: topologyScalar( safeRead( attribute, 'itemSize' ) ),
		normalized: topologyScalar( safeRead( attribute, 'normalized' ) ),
		gpuType: topologyScalar( safeRead( attribute, 'gpuType' ) ),
		instanced: safeRead( attribute, 'isInstancedBufferAttribute' ) === true,
		meshPerAttribute: topologyScalar( safeRead( attribute, 'meshPerAttribute' ) ),
	} );

}

function describeClipping( material, object ) {

	const groups = [];
	let current = object;
	const seen = new Set();
	while ( current && ! seen.has( current ) ) {

		seen.add( current );
		if ( safeRead( current, 'isClippingGroup' ) === true ) {

			const planes = safeRead( current, 'clippingPlanes' );
			groups.push( compactObject( {
				enabled: safeRead( current, 'enabled' ) !== false,
				intersection: safeRead( current, 'clipIntersection' ) === true,
				shadows: safeRead( current, 'clipShadows' ) === true,
				planeCount: Array.isArray( planes ) ? planes.length : 0,
			} ) );

		}
		current = safeRead( current, 'parent' );

	}
	const materialPlanes = safeRead( material, 'clippingPlanes' );
	return compactObject( {
		materialPlaneCount: Array.isArray( materialPlanes ) ? materialPlanes.length : 0,
		intersection: safeRead( material, 'clipIntersection' ) === true,
		shadows: safeRead( material, 'clipShadows' ) === true,
		groups,
	} );

}

function describeRenderTarget( target ) {

	if ( ! target ) return null;
	const textures = Array.isArray( safeRead( target, 'textures' ) )
		? target.textures
		: safeRead( target, 'texture' ) ? [ target.texture ] : [];
	return compactObject( {
		type: typeTag( target ),
		textures: textures.map( resourceShape ),
		depthTexture: resourceShape( safeRead( target, 'depthTexture' ) ),
		depthBuffer: topologyScalar( safeRead( target, 'depthBuffer' ) ),
		stencilBuffer: topologyScalar( safeRead( target, 'stencilBuffer' ) ),
		samples: topologyScalar( safeRead( target, 'samples' ) ),
	} );

}

function describeMRT( mrt ) {

	if ( ! mrt ) return null;
	const outputs = safeRead( mrt, 'outputNodes' ) || safeRead( mrt, 'nodes' );
	const names = outputs && typeof outputs === 'object' ? Object.keys( outputs ).sort() : [];
	return compactObject( {
		type: typeTag( mrt ),
		outputs: names.map( ( name ) => [ name, nodeShape( outputs[ name ] ) ] ),
		graph: safeRead( mrt, 'isNode' ) === true ? normalizeNode( mrt, new Set(), 0 ) : null,
	} );

}

function nodeShape( node ) {

	return node && ( typeof node === 'object' || typeof node === 'function' )
		? normalizeNode( node, new Set(), 0 )
		: null;

}

function resourceShape( resource ) {

	if ( ! resource ) return null;
	const texture = safeRead( resource, 'texture' ) && safeRead( resource.texture, 'isTexture' ) === true
		? resource.texture
		: resource;
	return compactObject( {
		type: typeTag( texture ),
		kind: textureKind( texture ),
		format: topologyScalar( safeRead( texture, 'format' ) ),
		internalFormat: topologyScalar( safeRead( texture, 'internalFormat' ) ),
		dataType: topologyScalar( safeRead( texture, 'type' ) ),
		compare: topologyScalar( safeRead( texture, 'compareFunction' ) ),
		mapping: topologyScalar( safeRead( texture, 'mapping' ) ),
		channel: topologyScalar( safeRead( texture, 'channel' ) ),
		colorSpace: topologyScalar( safeRead( texture, 'colorSpace' ) ),
	} );

}

function textureKind( texture ) {

	for ( const [ flag, kind ] of [
		[ 'isCubeTexture', 'cube' ],
		[ 'isDataArrayTexture', '2d-array' ],
		[ 'isData3DTexture', '3d' ],
		[ 'isDepthTexture', 'depth' ],
		[ 'isVideoTexture', 'video' ],
		[ 'isCompressedArrayTexture', 'compressed-array' ],
		[ 'isCompressedCubeTexture', 'compressed-cube' ],
		[ 'isCompressedTexture', 'compressed-2d' ],
		[ 'isStorageTexture', 'storage' ],
		[ 'isRenderTargetTexture', 'render-target' ],
	] ) {

		if ( safeRead( texture, flag ) === true ) return kind;

	}
	return safeRead( texture, 'isTexture' ) === true ? '2d' : 'resource';

}

function traverseObjects( root, callback ) {

	if ( ! root ) return;
	if ( typeof root.traverse === 'function' ) {

		root.traverse( callback );
		return;

	}
	const queue = [ root ];
	const seen = new Set();
	while ( queue.length > 0 ) {

		const object = queue.shift();
		if ( ! object || seen.has( object ) ) continue;
		seen.add( object );
		callback( object );
		const children = safeRead( object, 'children' );
		if ( Array.isArray( children ) ) queue.push( ...children );

	}

}

function typeTag( value ) {

	if ( ! value ) return null;
	const ctor = safeRead( value, 'constructor' );
	for ( const candidate of [ safeRead( value, 'type' ), safeRead( ctor, 'type' ), safeRead( ctor, 'name' ) ] ) {

		if ( typeof candidate === 'string' && candidate.length > 0 ) return candidate;

	}
	return typeof value;

}

function topologyScalar( value ) {

	return value === null || typeof value === 'string' || typeof value === 'boolean' || ( typeof value === 'number' && Number.isFinite( value ) )
		? value
		: undefined;

}

function compactObject( object ) {

	return Object.fromEntries( Object.entries( object ).filter( ( [ , value ] ) => value !== undefined ) );

}

function safeCall( object, method ) {

	try {

		return object && typeof object[ method ] === 'function' ? object[ method ]() : null;

	} catch ( _ ) {

		return null;

	}

}

function safeRead( object, key ) {

	try {

		return object && object[ key ];

	} catch ( _ ) {

		return undefined;

	}

}
