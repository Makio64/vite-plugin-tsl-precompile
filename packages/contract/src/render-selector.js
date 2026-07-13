import { MATERIAL_TEXTURE_PROPS } from './texture-props.js';
import { stableJsonStringify } from './stable-json.js';

const POSITIVE_MATERIAL_FEATURES = Object.freeze( [
	'alphaTest',
	'anisotropy',
	'clearcoat',
	'dispersion',
	'iridescence',
	'sheen',
	'transmission',
] );

/**
 * Describe only topology that both a full Three RenderObject and the
 * compiler-free slim replay can reproduce. Unlike renderContextSignature,
 * this intentionally excludes normalized TSL graphs and private cache IDs.
 *
 * @param {?Object} renderObject
 * @param {?Object} [renderer]
 * @return {Object|null}
 */
export function describeRenderObjectContext( renderObject, renderer = renderObject && renderObject.renderer ) {

	if ( ! renderObject ) return null;
	const context = safeRead( renderObject, 'context' ) || null;
	const scene = safeRead( renderObject, 'scene' ) || null;
	const camera = safeRead( renderObject, 'camera' ) || null;
	const object = safeRead( renderObject, 'object' ) || null;
	const material = safeRead( renderObject, 'material' ) || safeRead( object, 'material' ) || null;
	return {
		version: 'render-object-selector@1',
		renderer: describeRenderer( renderer ),
		target: describeTarget( context, renderer ),
		mrt: describeMRT( context ),
		scene: describeScene( scene ),
		lights: describeLights( safeRead( renderObject, 'lightsNode' ), scene, camera ),
		camera: describeCamera( camera, renderer ),
		object: describeObject( object ),
		material: describeMaterial( material ),
		clipping: describeClipping( material, safeRead( renderObject, 'clippingContext' ) ),
	};

}

/**
 * Return the canonical, JSON-safe selector persisted on an artifact variant.
 *
 * @param {?Object} renderObject
 * @param {?Object} [renderer]
 * @return {string}
 */
export function createRenderObjectContextSelector( renderObject, renderer = renderObject && renderObject.renderer ) {

	const descriptor = describeRenderObjectContext( renderObject, renderer );
	return descriptor ? stableJsonStringify( descriptor, 'renderObjectSelector' ) : '';

}

function describeRenderer( renderer ) {

	if ( ! renderer ) return null;
	const shadowMap = safeRead( renderer, 'shadowMap' );
	const backend = safeRead( renderer, 'backend' );
	return compactObject( {
		backend: backend ? compactObject( {
			kind: safeRead( backend, 'isWebGPUBackend' ) === true
				? 'webgpu'
				: safeRead( backend, 'isWebGLBackend' ) === true ? 'webgl' : 'custom',
			compatibilityMode: scalar( safeRead( backend, 'compatibilityMode' ) ),
		} ) : null,
		coordinateSystem: scalar( safeRead( renderer, 'coordinateSystem' ) ),
		logarithmicDepthBuffer: scalar( safeRead( renderer, 'logarithmicDepthBuffer' ) ),
		shadowMap: shadowMap ? compactObject( {
			enabled: safeRead( shadowMap, 'enabled' ) === true,
			type: scalar( safeRead( shadowMap, 'type' ) ),
		} ) : null,
		contextNode: nodePresence( safeRead( renderer, 'contextNode' ) ),
	} );

}

function describeTarget( context, renderer ) {

	if ( ! context ) return null;
	const renderTarget = safeRead( context, 'renderTarget' );
	let textures = safeRead( context, 'textures' );
	if ( ! Array.isArray( textures ) ) {

		textures = Array.isArray( safeRead( renderTarget, 'textures' ) )
			? renderTarget.textures
			: safeRead( renderTarget, 'texture' ) ? [ renderTarget.texture ] : [];

	}
	const outputTarget = safeCall( renderer, 'getOutputRenderTarget' );
	return compactObject( {
		color: scalar( safeRead( context, 'color' ) ),
		depth: scalar( safeRead( context, 'depth' ) ),
		stencil: scalar( safeRead( context, 'stencil' ) ),
		sampleCount: scalar( safeRead( context, 'sampleCount' ) ?? safeRead( renderTarget, 'samples' ) ),
		multiview: safeRead( renderTarget, 'multiview' ) === true || safeRead( outputTarget, 'multiview' ) === true,
		colors: textures.map( resourceShape ),
		depthTexture: resourceShape( safeRead( context, 'depthTexture' ) || safeRead( renderTarget, 'depthTexture' ) ),
	} );

}

function describeMRT( context ) {

	const mrt = safeRead( context, 'mrt' );
	if ( ! mrt ) return null;
	const outputs = safeRead( mrt, 'outputNodes' ) || safeRead( mrt, 'nodes' );
	const names = outputs && typeof outputs === 'object' ? Object.keys( outputs ) : [];
	return { count: names.length, names };

}

function describeScene( scene ) {

	if ( ! scene ) return null;
	const fog = safeRead( scene, 'fog' );
	const overrideMaterial = safeRead( scene, 'overrideMaterial' );
	return compactObject( {
		fog: safeRead( scene, 'fogNode' )
			? 'node'
			: fog
				? safeRead( fog, 'isFogExp2' ) === true ? 'FogExp2' : safeRead( fog, 'isFog' ) === true ? 'Fog' : 'node'
				: null,
		environment: resourceShape( safeRead( scene, 'environment' ), { sampler: true } ),
		environmentNode: nodePresence( safeRead( scene, 'environmentNode' ) ),
		overrideMaterial: overrideMaterial ? compactObject( {
			present: true,
			shadowPass: safeRead( overrideMaterial, 'isShadowPassMaterial' ) === true,
		} ) : null,
	} );

}

function describeLights( lightsNode, scene, camera ) {

	let lights = safeCall( lightsNode, 'getLights' );
	if ( ! Array.isArray( lights ) ) lights = safeRead( lightsNode, 'lights' );
	if ( ! Array.isArray( lights ) ) lights = safeRead( lightsNode, '_lights' );
	if ( ! Array.isArray( lights ) ) {

		lights = [];
		traverseObjects( scene, ( object ) => {

			if ( safeRead( object, 'isLight' ) === true ) lights.push( object );

		} );

	}
	return lights.map( ( light ) => describeLight( light, camera ) );

}

function describeLight( light, _camera ) {

	const shadow = safeRead( light, 'shadow' );
	const lightType = stableLightType( light );
	return compactObject( {
		type: lightType,
		castShadow: safeRead( light, 'castShadow' ) === true,
		map: resourceShape( safeRead( light, 'map' ), { sampler: true } ),
		colorNode: nodePresence( safeRead( light, 'colorNode' ) ),
		shadow: shadow ? compactObject( {
			type: stableShadowType( shadow, lightType ),
			cameraType: projectionType( safeRead( shadow, 'camera' ) ),
		} ) : null,
	} );

}

function describeCamera( camera, renderer ) {

	if ( ! camera ) return null;
	const views = Array.isArray( safeRead( camera, 'cameras' ) ) ? camera.cameras : [];
	const logarithmicDepth = safeRead( renderer, 'logarithmicDepthBuffer' ) === true;
	return compactObject( {
		array: safeRead( camera, 'isArrayCamera' ) === true,
		arrayViewCount: views.length,
		projection: logarithmicDepth
			? safeRead( camera, 'isPerspectiveCamera' ) === true
				? 'perspective'
				: safeRead( camera, 'isOrthographicCamera' ) === true ? 'orthographic' : 'other'
			: null,
		coordinateSystem: scalar( safeRead( camera, 'coordinateSystem' ) ),
	} );

}

function describeObject( object ) {

	if ( ! object ) return null;
	const skeleton = safeRead( object, 'skeleton' );
	const geometry = safeRead( object, 'geometry' );
	return compactObject( {
		receiveShadow: safeRead( object, 'receiveShadow' ) === true,
		skinned: safeRead( object, 'isSkinnedMesh' ) === true,
		boneCount: Array.isArray( safeRead( skeleton, 'bones' ) ) ? skeleton.bones.length : 0,
		instanced: safeRead( object, 'isInstancedMesh' ) === true || Number( safeRead( object, 'count' ) ) > 1,
		batched: safeRead( object, 'isBatchedMesh' ) === true,
		morphInfluences: Array.isArray( safeRead( object, 'morphTargetInfluences' ) ),
		instanceMatrix: !! safeRead( object, 'instanceMatrix' ),
		instanceColor: !! safeRead( object, 'instanceColor' ),
		batchColors: !! safeRead( object, '_colorsTexture' ),
		geometry: describeGeometry( geometry ),
	} );

}

function describeGeometry( geometry ) {

	if ( ! geometry ) return null;
	const attributes = safeRead( geometry, 'attributes' ) || {};
	const morphAttributes = safeRead( geometry, 'morphAttributes' ) || {};
	return compactObject( {
		index: !! safeRead( geometry, 'index' ),
		attributes: Object.keys( attributes ).sort().map( ( name ) => [ name, attributeShape( attributes[ name ] ) ] ),
		morphAttributes: Object.keys( morphAttributes ).sort().map( ( name ) => [
			name,
			Array.isArray( morphAttributes[ name ] ) ? morphAttributes[ name ].map( attributeShape ) : [],
		] ),
		morphTargetsRelative: scalar( safeRead( geometry, 'morphTargetsRelative' ) ),
	} );

}

function attributeShape( attribute ) {

	if ( ! attribute ) return null;
	const data = safeRead( attribute, 'data' );
	return compactObject( {
		stride: scalar( safeRead( data, 'stride' ) ),
		offset: scalar( safeRead( attribute, 'offset' ) ),
		itemSize: scalar( safeRead( attribute, 'itemSize' ) ),
		normalized: scalar( safeRead( attribute, 'normalized' ) ),
	} );

}

function describeMaterial( material ) {

	if ( ! material ) return null;
	const positive = {};
	for ( const key of POSITIVE_MATERIAL_FEATURES ) positive[ key ] = Number( safeRead( material, key ) ) > 0;
	const transmission = Number( safeRead( material, 'transmission' ) );
	const thickness = Number( safeRead( material, 'thickness' ) );
	const side = safeRead( material, 'side' );
	const derivedTransmissionPass = transmission > 0 && Math.abs( Number.isFinite( thickness ) ? thickness : 0 ) <= 1e-7 && side === 2;
	const maps = [];
	for ( const property of MATERIAL_TEXTURE_PROPS ) {

		const texture = safeRead( material, property );
		if ( texture ) maps.push( [ property, resourceShape( texture, { sampler: true } ) ] );

	}
	return compactObject( {
		side: scalar( safeRead( material, 'side' ) ),
		shadowSide: scalar( safeRead( material, 'shadowSide' ) ),
		alphaHash: safeRead( material, 'alphaHash' ) === true,
		alphaToCoverage: safeRead( material, 'alphaToCoverage' ) === true,
		flatShading: safeRead( material, 'flatShading' ) === true,
		fog: safeRead( material, 'fog' ) !== false,
		forceSinglePass: safeRead( material, 'forceSinglePass' ) === true || derivedTransmissionPass,
		lights: safeRead( material, 'lights' ) === true,
		normalMapType: scalar( safeRead( material, 'normalMapType' ) ),
		premultipliedAlpha: safeRead( material, 'premultipliedAlpha' ) === true,
		sizeAttenuation: safeRead( material, 'sizeAttenuation' ) !== false,
		transparent: safeRead( material, 'transparent' ) === true || transmission > 0,
		vertexColors: safeRead( material, 'vertexColors' ) === true,
		wireframe: safeRead( material, 'wireframe' ) === true,
		dashed: safeRead( material, 'dashed' ) === true,
		dithering: safeRead( material, 'dithering' ) === true,
		worldUnits: safeRead( material, 'worldUnits' ) === true,
		positive,
		maps,
	} );

}

function describeClipping( material, clippingContext ) {

	const materialPlanes = safeRead( material, 'clippingPlanes' );
	const intersectionPlanes = safeRead( clippingContext, 'intersectionPlanes' );
	const unionPlanes = safeRead( clippingContext, 'unionPlanes' );
	return compactObject( {
		materialPlaneCount: Array.isArray( materialPlanes ) ? materialPlanes.length : 0,
		intersection: safeRead( material, 'clipIntersection' ) === true,
		shadows: safeRead( material, 'clipShadows' ) === true,
		intersectionPlaneCount: Array.isArray( intersectionPlanes ) ? intersectionPlanes.length : 0,
		unionPlaneCount: Array.isArray( unionPlanes ) ? unionPlanes.length : 0,
		contextIntersection: scalar( safeRead( clippingContext, 'clipIntersection' ) ),
		shadowPass: safeRead( clippingContext, 'shadowPass' ) === true,
	} );

}

function nodePresence( node ) {

	return !! node;

}

function resourceShape( resource, opts = {} ) {

	if ( ! resource ) return null;
	const texture = safeRead( resource, 'texture' ) && safeRead( resource.texture, 'isTexture' ) === true
		? resource.texture
		: resource;
	return compactObject( {
		kind: textureKind( texture ),
		format: scalar( safeRead( texture, 'format' ) ),
		internalFormat: scalar( safeRead( texture, 'internalFormat' ) ),
		dataType: scalar( safeRead( texture, 'type' ) ),
		colorSpace: scalar( safeRead( texture, 'colorSpace' ) ),
		...( opts.sampler === true ? {
			compare: scalar( safeRead( texture, 'compareFunction' ) ),
			mapping: scalar( safeRead( texture, 'mapping' ) ),
			channel: scalar( safeRead( texture, 'channel' ) ),
			magFilter: scalar( safeRead( texture, 'magFilter' ) ),
			minFilter: scalar( safeRead( texture, 'minFilter' ) ),
			wrapS: scalar( safeRead( texture, 'wrapS' ) ),
			wrapT: scalar( safeRead( texture, 'wrapT' ) ),
			wrapR: scalar( safeRead( texture, 'wrapR' ) ),
		} : {} ),
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

function stableLightType( light ) {

	if ( ! light ) return null;
	const explicit = safeRead( light, 'type' );
	if ( typeof explicit === 'string' && explicit.length > 0 ) return explicit;
	for ( const [ flag, type ] of [
		[ 'isDirectionalLight', 'DirectionalLight' ],
		[ 'isPointLight', 'PointLight' ],
		[ 'isSpotLight', 'SpotLight' ],
		[ 'isRectAreaLight', 'RectAreaLight' ],
		[ 'isHemisphereLight', 'HemisphereLight' ],
		[ 'isAmbientLight', 'AmbientLight' ],
		[ 'isLightProbe', 'LightProbe' ],
	] ) {

		if ( safeRead( light, flag ) === true ) return type;

	}
	return safeRead( light, 'isNode' ) === true ? 'CustomLightNode' : 'CustomLight';

}

function stableShadowType( shadow, lightType ) {

	if ( safeRead( shadow, 'isDirectionalLightShadow' ) === true ) return 'DirectionalLightShadow';
	if ( safeRead( shadow, 'isPointLightShadow' ) === true ) return 'PointLightShadow';
	if ( safeRead( shadow, 'isSpotLightShadow' ) === true ) return 'SpotLightShadow';
	return lightType ? `${ lightType }Shadow` : 'LightShadow';

}

function projectionType( camera ) {

	if ( ! camera ) return null;
	if ( safeRead( camera, 'isPerspectiveCamera' ) === true ) return 'perspective';
	if ( safeRead( camera, 'isOrthographicCamera' ) === true ) return 'orthographic';
	return safeRead( camera, 'isArrayCamera' ) === true ? 'array' : 'camera';

}

function scalar( value ) {

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
