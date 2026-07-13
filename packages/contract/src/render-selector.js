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
	const shadowCaster = describeShadowCaster( renderObject, object, material );
	// RenderContext instances are mutable and reused by Three. Snapshot target
	// topology before reading any other renderer-owned state so a nested render
	// cannot relabel the observed face or mip level underneath this descriptor.
	const target = describeRenderTargetTopology( context, renderer );
	return {
		version: 'render-object-selector@1',
		renderer: describeRenderer( renderer ),
		target,
		mrt: describeMRT( context ),
		scene: describeSceneRenderTopology( scene ),
		lights: describeLights( safeRead( renderObject, 'lightsNode' ), scene, camera ),
		camera: describeCamera( camera, renderer ),
		object: describeObject( object ),
		material: describeMaterial( material ),
		clipping: describeClipping( material, safeRead( renderObject, 'clippingContext' ) ),
		...( shadowCaster ? { shadowCaster } : {} ),
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

/**
 * Describe scene-owned shader topology without retaining or traversing a TSL
 * graph. Fog scalar values and texture identities are live runtime data; only
 * the branches and resource shapes that can select different captured WGSL
 * belong in this descriptor.
 *
 * @param {?Object} scene
 * @return {Object|null}
 */
export function describeSceneRenderTopology( scene ) {

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

/**
 * Return the canonical scene-topology string used by compiler-free replay's
 * RenderObject invalidation key. Artifact variants use the same descriptor as
 * part of their full render-object selector.
 *
 * @param {?Object} scene
 * @return {string}
 */
export function createSceneRenderTopologySelector( scene ) {

	return stableJsonStringify( describeSceneRenderTopology( scene ), 'sceneRenderTopology' );

}

/**
 * Project a general render-object selector onto topology that can affect a
 * renderer-owned auxiliary pass.
 *
 * Background materials explicitly disable lights and fog and do not consume
 * the scene environment. Shadow-depth materials likewise consume caster,
 * target, camera, clipping, and renderer topology rather than scene lighting,
 * fog, or environment. The final post-process quad is captured on Three's
 * private output-intermediate target but replayed directly to the default
 * surface; its persisted WGSL does not depend on that adapter-owned target's
 * attachment descriptors or on NodeMaterial's fog default. Keeping those
 * unused fields in a signed auxiliary selector makes equivalent capture and
 * replay passes fail to match.
 *
 * Unknown profiles are returned unchanged so callers can opt in one adapter
 * at a time without weakening ordinary material selection.
 *
 * @param {string} selector
 * @param {string|null|undefined} profile
 * @return {string}
 */
export function projectRenderObjectContextSelector( selector, profile ) {

	if ( typeof selector !== 'string' ) return '';
	const sceneIndependent = profile === 'background' || profile === 'shadow-depth';
	const postProcess = profile === 'post-process';
	if ( ( ! sceneIndependent && ! postProcess ) || selector.length === 0 ) return selector;
	let descriptor;
	try {

		descriptor = JSON.parse( selector );

	} catch ( _ ) {

		return selector;

	}
	if ( ! descriptor || typeof descriptor !== 'object' || descriptor.version !== 'render-object-selector@1' ) return selector;

	if ( postProcess ) {

		const projected = { ...descriptor };
		if ( projected.material && typeof projected.material === 'object' ) {

			projected.material = { ...projected.material };
			delete projected.material.fog;

		}
		if ( projected.target && typeof projected.target === 'object' ) {

			projected.target = { ...projected.target };
			delete projected.target.surface;
			delete projected.target.colors;
			delete projected.target.depthTexture;

		}
		return stableJsonStringify( projected, 'renderObjectSelector' );

	}

	const projected = { ...descriptor, lights: [] };
	delete projected.scene;
	if ( profile === 'background' && projected.renderer && typeof projected.renderer === 'object' ) {

		projected.renderer = { ...projected.renderer };
		delete projected.renderer.shadowMap;
		delete projected.renderer.contextNode;

	}
	return stableJsonStringify( projected, 'renderObjectSelector' );

}

/**
 * Describe the source-material branches that Three copies into its shared
 * shadow override material for the current object. The active RenderObject
 * material alone is insufficient here: `getShadowMaterial()` always owns a
 * color node, while `Renderer._getShadowNodes()` temporarily replaces that
 * node for map/custom-shadow casters. The original material remains reachable
 * through `renderObject.object.material` during both capture and replay.
 *
 * Keep this descriptor branch-shaped and graph-free so full TSL nodes and the
 * compiler-free runtime's inert node stubs produce the same selector.
 */
function describeShadowCaster( renderObject, object, activeMaterial ) {

	if ( safeRead( activeMaterial, 'isShadowPassMaterial' ) !== true ) return null;
	const sourceMaterial = resolveShadowSourceMaterial( renderObject, object );
	if ( ! sourceMaterial ) return null;

	const map = safeRead( sourceMaterial, 'map' );
	const colorNode = isNode( safeRead( sourceMaterial, 'colorNode' ) );
	const castShadowNode = isNode( safeRead( sourceMaterial, 'castShadowNode' ) );
	const maskShadowNode = isNode( safeRead( sourceMaterial, 'maskShadowNode' ) );
	const maskNode = isNode( safeRead( sourceMaterial, 'maskNode' ) );
	const castShadowPositionNode = isNode( safeRead( sourceMaterial, 'castShadowPositionNode' ) );
	const positionNode = isNode( safeRead( sourceMaterial, 'positionNode' ) );

	return compactObject( {
		color: map || colorNode || castShadowNode || maskShadowNode || maskNode
			? compactObject( {
				map: resourceShape( map, { sampler: true } ),
				colorNode,
				castShadowNode,
				mask: maskShadowNode ? 'maskShadowNode' : maskNode ? 'maskNode' : null,
			} )
			: null,
		depthNode: isNode( safeRead( sourceMaterial, 'depthNode' ) ),
		positionNode: castShadowPositionNode ? 'castShadowPositionNode' : positionNode ? 'positionNode' : null,
		alphaMap: resourceShape( safeRead( sourceMaterial, 'alphaMap' ), { sampler: true } ),
		alphaTest: Number( safeRead( sourceMaterial, 'alphaTest' ) ) > 0,
	} );

}

function resolveShadowSourceMaterial( renderObject, object ) {

	const material = safeRead( object, 'material' );
	if ( ! Array.isArray( material ) ) return material || null;
	const group = safeRead( renderObject, 'group' );
	const materialIndex = Number( safeRead( group, 'materialIndex' ) );
	return Number.isInteger( materialIndex ) && materialIndex >= 0 ? material[ materialIndex ] || null : null;

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

/**
 * Describe the active render surface without retaining target, texture, or
 * node-graph identity. Dimensions are deliberately excluded: resizing a
 * target changes live viewport state, not its shader/pipeline topology.
 *
 * @param {?Object} context
 * @param {?Object} renderer
 * @return {Object|null}
 */
export function describeRenderTargetTopology( context, renderer = null ) {

	if ( ! context ) return null;
	const observedRenderTarget = safeRead( context, 'renderTarget' );

	// These values are mutated in-place for every cube face / array layer and
	// mip render. Read them before renderer callbacks such as
	// getOutputRenderTarget() and copy only finite primitives into the result.
	const observedActiveCubeFace = safeRead( context, 'activeCubeFace' );
	const observedActiveMipmapLevel = safeRead( context, 'activeMipmapLevel' );
	let textures = safeRead( context, 'textures' );
	const activeRendererTarget = observedRenderTarget === undefined || observedRenderTarget === null
		? safeCall( renderer, 'getRenderTarget' )
		: null;
	// Three r184 compileAsync() fills RenderContext.textures but leaves its
	// renderTarget field at the initial null. Recover the explicitly bound
	// target only when every observed texture is the exact attachment owned by
	// renderer.getRenderTarget(); a real default surface cannot pass this check.
	const inferredCompileTarget = observedRenderTarget === null && renderTargetOwnsTextures( activeRendererTarget, textures );
	const renderTarget = observedRenderTarget === undefined
		? activeRendererTarget
		: inferredCompileTarget ? activeRendererTarget : observedRenderTarget;
	const activeCubeFace = resolveActiveTargetIndex( inferredCompileTarget ? undefined : observedActiveCubeFace, renderTarget, 'activeCubeFace', '_activeCubeFace', renderer, '_activeCubeFace', 'getActiveCubeFace' );
	const activeMipmapLevel = resolveActiveTargetIndex( inferredCompileTarget ? undefined : observedActiveMipmapLevel, renderTarget, 'activeMipmapLevel', '_activeMipmapLevel', renderer, '_activeMipmapLevel', 'getActiveMipmapLevel' );
	if ( ! Array.isArray( textures ) ) {

		textures = Array.isArray( safeRead( renderTarget, 'textures' ) )
			? renderTarget.textures
			: safeRead( renderTarget, 'texture' ) ? [ renderTarget.texture ] : [];

	}
	const outputTarget = safeCall( renderer, 'getOutputRenderTarget' );
	const surface = classifyRenderSurface( renderTarget, outputTarget, textures );
	return compactObject( {
		surface,
		activeCubeFace,
		activeMipmapLevel,
		color: scalar( safeRead( context, 'color' ) ?? ( textures.length > 0 ) ),
		depth: scalar( safeRead( context, 'depth' ) ?? safeRead( renderTarget, 'depthBuffer' ) ),
		stencil: scalar( safeRead( context, 'stencil' ) ?? safeRead( renderTarget, 'stencilBuffer' ) ),
		sampleCount: effectiveSampleCount( context, renderTarget, renderer, textures ),
		multiview: safeRead( context, 'multiview' ) === true || safeRead( renderTarget, 'multiview' ) === true,
		colors: textures.map( describeColorAttachment ),
		depthTexture: resourceShape( safeRead( context, 'depthTexture' ) || safeRead( renderTarget, 'depthTexture' ) ),
	} );

}

function renderTargetOwnsTextures( renderTarget, observedTextures ) {

	if ( ! renderTarget || ! Array.isArray( observedTextures ) || observedTextures.length === 0 ) return false;
	const targetTextureList = safeRead( renderTarget, 'textures' );
	const targetTexture = safeRead( renderTarget, 'texture' );
	const targetTextures = Array.isArray( targetTextureList ) ? targetTextureList : targetTexture ? [ targetTexture ] : [];
	return targetTextures.length === observedTextures.length && observedTextures.every( ( texture, index ) => texture === targetTextures[ index ] );

}

function resolveActiveTargetIndex( observedValue, renderTarget, targetKey, targetPrivateKey, renderer, rendererPrivateKey, rendererMethod ) {

	if ( typeof observedValue === 'number' && Number.isFinite( observedValue ) ) return observedValue;
	const targetValue = safeRead( renderTarget, targetKey );
	if ( typeof targetValue === 'number' && Number.isFinite( targetValue ) ) return targetValue;
	const targetPrivateValue = safeRead( renderTarget, targetPrivateKey );
	if ( typeof targetPrivateValue === 'number' && Number.isFinite( targetPrivateValue ) ) return targetPrivateValue;
	const rendererPrivateValue = safeRead( renderer, rendererPrivateKey );
	if ( typeof rendererPrivateValue === 'number' && Number.isFinite( rendererPrivateValue ) ) return rendererPrivateValue;
	const methodValue = safeCall( renderer, rendererMethod );
	return typeof methodValue === 'number' && Number.isFinite( methodValue ) ? methodValue : 0;

}

function classifyRenderSurface( renderTarget, outputTarget, textures ) {

	if ( ! renderTarget ) return 'default';
	if ( safeRead( renderTarget, 'isPostProcessingRenderTarget' ) === true ) return 'output-intermediate';
	if ( renderTarget === outputTarget || safeRead( renderTarget, 'isOutputRenderTarget' ) === true || safeRead( renderTarget, 'isXRRenderTarget' ) === true ) return 'output';

	const texture = textures[ 0 ] || safeRead( renderTarget, 'texture' ) || null;
	if ( safeRead( renderTarget, 'isRenderTarget3D' ) === true || safeRead( renderTarget, 'isWebGL3DRenderTarget' ) === true || safeRead( texture, 'isData3DTexture' ) === true ) return 'offscreen-3d';
	if (
		safeRead( renderTarget, 'isWebGLArrayRenderTarget' ) === true ||
		safeRead( renderTarget, 'isRenderTargetArray' ) === true ||
		safeRead( texture, 'isDataArrayTexture' ) === true ||
		safeRead( texture, 'isCompressedArrayTexture' ) === true ||
		safeRead( texture, 'isArrayTexture' ) === true
	) return 'offscreen-array';
	if (
		safeRead( renderTarget, 'isCubeRenderTarget' ) === true ||
		safeRead( renderTarget, 'isWebGLCubeRenderTarget' ) === true ||
		safeRead( texture, 'isCubeTexture' ) === true ||
		safeRead( texture, 'isCompressedCubeTexture' ) === true
	) return 'offscreen-cube';
	return 'offscreen-2d';

}

function effectiveSampleCount( context, renderTarget, renderer, textures ) {

	const backend = safeRead( renderer, 'backend' );
	const backendUtils = safeRead( backend, 'utils' );
	const backendValue = safeCall( backendUtils, 'getSampleCountRenderContext', context );
	if ( typeof backendValue === 'number' && Number.isFinite( backendValue ) && backendValue > 0 ) return backendValue;

	const hasTargetAttachments = renderTarget != null || textures.length > 0;
	const value = hasTargetAttachments
		? firstFiniteNumber( [ safeRead( context, 'sampleCount' ), safeRead( renderTarget, 'samples' ) ], 1 )
		: firstFiniteNumber( [ safeRead( renderer, 'currentSamples' ), safeRead( renderer, 'samples' ), safeRead( context, 'sampleCount' ) ], 1 );

	// Match WebGPUUtils.getSampleCount(): WebGPU pipelines support the effective
	// counts 1 and 4 even when a caller requested another raw value. WebGL and
	// custom backends keep the positive count reported by their context.
	if ( safeRead( backend, 'isWebGPUBackend' ) === true ) return value >= 4 ? 4 : 1;
	return value > 0 ? value : 1;

}

function describeColorAttachment( texture ) {

	return compactObject( {
		...resourceShape( texture ),
		name: scalar( safeRead( texture, 'name' ) ),
	} );

}

function describeMRT( context ) {

	const mrt = safeRead( context, 'mrt' );
	if ( ! mrt ) return null;
	const outputs = safeRead( mrt, 'outputNodes' ) || safeRead( mrt, 'nodes' );
	const names = outputs && typeof outputs === 'object' ? Object.keys( outputs ) : [];
	const configuredBlendModes = safeRead( mrt, 'blendModes' );
	const blendModes = Object.fromEntries( names.map( ( name ) => {

		const fromMethod = safeCall( mrt, 'getBlendMode', name );
		const mode = fromMethod == null ? safeRead( configuredBlendModes, name ) : fromMethod;
		return [ name, describeBlendMode( mode ) ];

	} ) );
	return { count: names.length, names, blendModes };

}

function describeBlendMode( mode ) {

	// Replay's inert MRT surface persists the effective Three blending enum in
	// artifact.mrtBlendModes. Custom factor fields are not independently
	// reproducible there, so signing them would make capture and replay diverge
	// even though both select the same persisted mode.
	if ( typeof mode === 'number' && Number.isFinite( mode ) ) return mode;
	if ( ! mode ) return null;
	return scalar( safeRead( mode, 'blending' ) ) ?? null;

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
	// Three orders analytic light nodes by Object3D.id while building WGSL, but
	// those process-local ids are intentionally absent from persisted selectors.
	// Canonicalize the semantic multiset as well: capture may expose traversal
	// order while replay exposes id order, and that implementation detail changed
	// between Three revisions without changing the resulting light topology.
	return lights
		.map( ( light ) => describeLight( light, camera ) )
		.map( ( descriptor ) => ( {
			descriptor,
			key: stableJsonStringify( descriptor, 'renderObjectLight' ),
		} ) )
		.sort( ( a, b ) => a.key < b.key ? - 1 : a.key > b.key ? 1 : 0 )
		.map( ( entry ) => entry.descriptor );

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

function isNode( node ) {

	return safeRead( node, 'isNode' ) === true;

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

function firstFiniteNumber( values, fallback ) {

	for ( const value of values ) {

		if ( typeof value === 'number' && Number.isFinite( value ) ) return value;

	}
	return fallback;

}

function compactObject( object ) {

	return Object.fromEntries( Object.entries( object ).filter( ( [ , value ] ) => value !== undefined ) );

}

function safeCall( object, method, ...args ) {

	try {

		return object && typeof object[ method ] === 'function' ? object[ method ]( ...args ) : null;

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
