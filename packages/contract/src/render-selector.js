import { MATERIAL_TEXTURE_PROPS } from './texture-props.js';
import { stableJsonStringify } from './stable-json.js';

export const RENDER_BINDING_OWNER_KINDS = Object.freeze( {
	MATERIAL: 'render-material',
	SHADOW_CASTER: 'shadow-caster',
} );

// Non-serializable handoff used by the slim renderer rewrite. A shadow pass
// replaces the selected caster material before RenderObject exists, so the
// exact selected material cannot be recovered reliably from an array/group
// lookup later. Keeping it on the active replay material avoids adding
// process-local identity to persisted selectors while preserving the exact
// per-draw owner for runtime hydration.
export const RENDER_BINDING_OWNER_MATERIAL = Symbol.for( '@tsl-precompile/render-binding-owner-material' );

const RENDER_BINDING_OWNER_KIND_SET = new Set( Object.values( RENDER_BINDING_OWNER_KINDS ) );

export function isRenderBindingOwnerKind( value ) {

	return RENDER_BINDING_OWNER_KIND_SET.has( value );

}

/**
 * Resolve material-binding ownership with the source-local exception taking
 * precedence over the artifact-wide default. Callers apply this only to
 * descriptors whose logical owner is material.
 */
export function resolveArtifactSourceBindingOwner( artifact, source ) {

	if ( source && isRenderBindingOwnerKind( source.bindingOwner ) ) return source.bindingOwner;
	if ( artifact && isRenderBindingOwnerKind( artifact.bindingOwner ) ) return artifact.bindingOwner;
	return RENDER_BINDING_OWNER_KINDS.MATERIAL;

}

// Renderer.renderObject copies these source-material properties onto its
// shared shadow override before NodeMaterial builds/updates the pass. They
// therefore keep caster ownership even though the resulting
// MaterialReferenceNode has no explicit source-material target.
//
// `map` is intentionally absent: Three's shadow path creates an explicit
// `reference( 'map', 'texture', sourceMaterial )` instead of copying it.
export const SHADOW_CASTER_COPIED_BINDING_PROPERTIES = Object.freeze( [
	'alphaMap',
	'alphaTest',
] );

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
	const sourceGeometry = safeRead( renderObject, 'sourceGeometry' ) || safeRead( object, 'geometry' ) || null;
	const material = safeRead( renderObject, 'material' ) || safeRead( object, 'material' ) || null;
	const shadowCaster = describeShadowCaster( renderObject, material );
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
		object: describeObject( object, sourceGeometry ),
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
 * Describe only the render-target and MRT topology that survives the
 * background selector projection. Runtime capture uses this as its
 * identity-free key for owned, deferred target representatives.
 *
 * @param {?Object} renderer
 * @param {?Object} renderTarget
 * @param {?Object} [mrtNode]
 * @return {Object}
 */
export function describeBackgroundCaptureTargetTopology( renderer, renderTarget, mrtNode = null ) {

	const texturesValue = safeRead( renderTarget, 'textures' );
	const textureValue = safeRead( renderTarget, 'texture' );
	const textures = Array.isArray( texturesValue ) ? texturesValue : textureValue ? [ textureValue ] : [];
	const context = {
		renderTarget: renderTarget || null,
		textures,
		depthTexture: safeRead( renderTarget, 'depthTexture' ),
		mrt: mrtNode || null,
	};
	return {
		version: 'background-capture-target@1',
		target: projectBackgroundTargetTopology( describeRenderTargetTopology( context, renderer ) ),
		mrt: describeMRT( context ),
	};

}

/**
 * Return the canonical topology key used by deferred background capture.
 *
 * @param {?Object} renderer
 * @param {?Object} renderTarget
 * @param {?Object} [mrtNode]
 * @return {string}
 */
export function createBackgroundCaptureTargetTopologyKey( renderer, renderTarget, mrtNode = null ) {

	return stableJsonStringify(
		describeBackgroundCaptureTargetTopology( renderer, renderTarget, mrtNode ),
		'backgroundCaptureTargetTopology',
	);

}

/**
 * Project a general render-object selector onto topology that can affect a
 * renderer-owned auxiliary pass.
 *
 * Background materials explicitly disable lights and fog and do not consume
 * the scene environment. Shadow-depth materials likewise consume caster,
 * target, camera, clipping, and renderer topology rather than scene lighting,
 * fog, or environment. Render-output and CubeRenderTarget's fixed conversion
 * blits are also scene/light independent; the cube shader serves every mutable
 * face and mip while retaining the rest of the target topology. The final
 * post-process quad is captured on Three's private output-intermediate target
 * but replayed directly to the default surface; its persisted WGSL does not
 * depend on that adapter-owned target's attachment descriptors or on
 * NodeMaterial's fog default. Keeping those
 * unused fields in a signed auxiliary selector makes equivalent capture and
 * replay passes fail to match. Render-output is likewise a fixed one-color
 * shader that can target the canvas or an offscreen RTT; attachment identity
 * belongs to pipeline state, while sample count remains signed here.
 * MeshBasic materials can consume an explicit envMap/envNode but never
 * Scene.environment, so their profile removes only those two scene axes while
 * retaining fog, override-material, target, object, and material topology.
 *
 * Physical vertex-buffer stride and offset are projected out for ordinary and
 * known auxiliary material selectors. They choose the live WebGPU vertex
 * layout and pipeline cache entry, but do not change the WGSL attribute type;
 * item size and normalization remain signed shader topology. Unknown profiles
 * are returned unchanged so callers can opt in one adapter at a time.
 * Background WGSL is invariant across the output target's adapter-owned
 * surface label, attachment view kind/face/mip, and MSAA count: Three binds
 * those when it creates the render pipeline, not in the shader or hydrated
 * bindings. A cube face is still a 2D color attachment for the draw, so one
 * background artifact may serve both the output-intermediate scene pass and
 * every view of a dynamic cube target. NoColorSpace and LinearSRGBColorSpace
 * attachments are likewise the same linear shader-output domain; attachment
 * format/data type and nonlinear color spaces remain signed.
 *
 * @param {string} selector
 * @param {string|null|undefined} profile
 * @return {string}
 */
export function projectRenderObjectContextSelector( selector, profile ) {

	if ( typeof selector !== 'string' ) return '';
	const renderOutput = profile === 'render-output';
	const sceneIndependent = profile === 'background' || profile === 'shadow-depth' || renderOutput || profile === 'cube-render-target';
	const postProcess = profile === 'post-process';
	const meshBasic = profile === 'mesh-basic';
	const ordinaryMaterial = profile === null || profile === undefined || profile === '';
	if ( ( ! ordinaryMaterial && ! sceneIndependent && ! postProcess && ! meshBasic ) || selector.length === 0 ) return selector;
	let descriptor;
	try {

		descriptor = JSON.parse( selector );

	} catch ( _ ) {

		return selector;

	}
	if ( ! descriptor || typeof descriptor !== 'object' || descriptor.version !== 'render-object-selector@1' ) return selector;
	descriptor = projectShaderVertexLayout( descriptor );
	if ( ordinaryMaterial ) return stableJsonStringify( descriptor, 'renderObjectSelector' );

	if ( meshBasic ) {

		const projected = { ...descriptor };
		if ( projected.scene && typeof projected.scene === 'object' ) {

			projected.scene = { ...projected.scene };
			delete projected.scene.environment;
			delete projected.scene.environmentNode;

		}
		return stableJsonStringify( projected, 'renderObjectSelector' );

	}

	if ( postProcess || renderOutput ) {

		const projected = { ...descriptor };
		// Both paths install an explicit fragmentNode. Three's NodeMaterial
		// setup therefore ignores renderer.getMRT(); retaining the global MRT
		// here would distinguish identical fullscreen shaders.
		delete projected.mrt;
		if ( projected.renderer && typeof projected.renderer === 'object' ) {

			projected.renderer = { ...projected.renderer };
			// These fullscreen passes run after scene depth projection. Reversed
			// depth therefore cannot change their WGSL or bindings, so one
			// captured artifact must be reusable across renderer depth modes.
			delete projected.renderer.reversedDepthBuffer;
			// The output transform is also independent of the scene shadow
			// filtering that completed before this pass.
			if ( renderOutput ) {

				delete projected.renderer.shadowMap;

			}

		}
		if ( projected.material && typeof projected.material === 'object' ) {

			projected.material = { ...projected.material };
			delete projected.material.fog;

		}
		if ( projected.target && typeof projected.target === 'object' ) {

			projected.target = { ...projected.target };
			delete projected.target.surface;
			delete projected.target.colors;
			delete projected.target.depthTexture;
			// Depth/stencil attachment presence selects the WebGPU render
			// pipeline descriptor owned by the active RenderContext; it cannot
			// change a fullscreen fragmentNode's WGSL or hydrated bindings.
			delete projected.target.depth;
			delete projected.target.stencil;

		}
		if ( postProcess ) return stableJsonStringify( projected, 'renderObjectSelector' );
		descriptor = projected;

	}

	const projected = { ...descriptor, lights: [] };
	delete projected.scene;
	if ( profile === 'cube-render-target' && projected.renderer && typeof projected.renderer === 'object' ) {

		projected.renderer = { ...projected.renderer };
		delete projected.renderer.shadowMap;
		delete projected.renderer.contextNode;
		if ( projected.renderer.backend && typeof projected.renderer.backend === 'object' ) {

			projected.renderer.backend = { ...projected.renderer.backend };
			delete projected.renderer.backend.compatibilityMode;

		}

	}
	if ( profile === 'cube-render-target' && projected.target && typeof projected.target === 'object' ) {

		projected.target = { ...projected.target };
		delete projected.target.activeCubeFace;
		delete projected.target.activeMipmapLevel;
		if ( Array.isArray( projected.target.colors ) ) {

			projected.target.colors = projected.target.colors.map( ( color ) => {

				if ( ! color || typeof color !== 'object' ) return color;
				const attachment = { ...color };
				delete attachment.name;
				return attachment;

			} );

		}

	}
	if ( profile === 'background' && projected.renderer && typeof projected.renderer === 'object' ) {

		projected.renderer = { ...projected.renderer };
		delete projected.renderer.shadowMap;
		delete projected.renderer.contextNode;

	}
	if ( profile === 'background' && projected.target && typeof projected.target === 'object' ) {

		projected.target = projectBackgroundTargetTopology( projected.target );

	}
	return stableJsonStringify( projected, 'renderObjectSelector' );

}

function projectBackgroundTargetTopology( target ) {

	if ( ! target || typeof target !== 'object' ) return target;
	const projected = { ...target };
	delete projected.surface;
	delete projected.sampleCount;
	delete projected.activeCubeFace;
	delete projected.activeMipmapLevel;
	if ( Array.isArray( projected.colors ) ) {

		projected.colors = projected.colors.map( ( color ) => {

			if ( ! color || typeof color !== 'object' ) return color;
			const attachment = { ...color };
			delete attachment.kind;
			if ( attachment.colorSpace === '' || attachment.colorSpace === 'srgb-linear' ) delete attachment.colorSpace;
			return attachment;

		} );

	}
	return projected;

}

function projectShaderVertexLayout( descriptor ) {

	const object = descriptor.object;
	const geometry = object && object.geometry;
	if ( ! geometry || typeof geometry !== 'object' ) return descriptor;
	const projectedGeometry = { ...geometry };
	// Index buffers choose drawIndexed versus draw, but they do not alter the
	// vertex/fragment shader or its bindings.
	delete projectedGeometry.index;
	if ( Array.isArray( geometry.attributes ) ) {

		projectedGeometry.attributes = geometry.attributes
			.filter( ( entry ) => ! isCompilerOwnedRangeAttribute( entry ) )
			.map( ( entry ) => projectAttributeEntry( entry, false ) );

	}
	if ( Array.isArray( geometry.morphAttributes ) ) {

		projectedGeometry.morphAttributes = geometry.morphAttributes.map( ( entry ) => projectAttributeEntry( entry, true ) );

	}
	return {
		...descriptor,
		object: {
			...object,
			geometry: projectedGeometry,
		},
	};

}

function isCompilerOwnedRangeAttribute( entry ) {

	if ( ! Array.isArray( entry ) || entry.length < 2 || ! /^__range\d+$/.test( entry[ 0 ] ) ) return false;
	const shape = entry[ 1 ];
	return !! shape
		&& typeof shape === 'object'
		&& ! Array.isArray( shape )
		&& shape.itemSize === 4
		&& shape.normalized === false;

}

function projectAttributeEntry( entry, multiple ) {

	if ( ! Array.isArray( entry ) || entry.length < 2 ) return entry;
	const shapes = multiple && Array.isArray( entry[ 1 ] )
		? entry[ 1 ].map( projectAttributeShape )
		: projectAttributeShape( entry[ 1 ] );
	return [ entry[ 0 ], shapes ];

}

function projectAttributeShape( shape ) {

	if ( ! shape || typeof shape !== 'object' || Array.isArray( shape ) ) return shape;
	const projected = { ...shape };
	delete projected.stride;
	delete projected.offset;
	return projected;

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
function describeShadowCaster( renderObject, activeMaterial ) {

	if ( safeRead( activeMaterial, 'isShadowPassMaterial' ) !== true ) return null;
	const sourceMaterial = resolveRenderObjectBindingOwner( renderObject ).material;
	if ( ! sourceMaterial ) return null;
	return describeShadowCasterMaterial( sourceMaterial );

}

/**
 * Describe only source-material topology that can change Three's shadow pass.
 * Replay uses the same projection to invalidate a stable per-caster shadow
 * material without retaining or comparing live TSL graph identity.
 *
 * @param {?Object} sourceMaterial
 * @return {Object|null}
 */
export function describeShadowCasterMaterial( sourceMaterial ) {

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

/** Return the canonical topology key shared by capture and replay. */
export function createShadowCasterTopologySelector( sourceMaterial ) {

	return stableJsonStringify( describeShadowCasterMaterial( sourceMaterial ), 'shadowCasterTopology' );

}

/**
 * Resolve the material whose live values/resources own a RenderObject's
 * bindings. Renderer-owned shadow materials own the captured shader, but the
 * exact pre-override caster material owns every `material.*` binding.
 *
 * Capture supplies `renderObject.sourceMaterial` from Renderer.renderObject's
 * exact selected-material argument. Replay adapters should do the same. The
 * group lookup is a compatibility fallback for stock RenderObjects that do not
 * expose that pre-override dispatch evidence. Artifact-level ownership makes
 * that alternate material available; individual `material.*` sources opt into
 * it with a source-local `bindingOwner` exception when ownership differs from
 * the artifact default.
 *
 * @param {?Object} renderObject
 * @param {?Object} [exactSourceMaterial]
 * @return {{kind: string, material: Object|null, object: Object|null, group: Object|null, materialIndex: number|null, sourceMaterialSet: *}}
 */
export function resolveRenderObjectBindingOwner( renderObject, exactSourceMaterial = null ) {

	const object = safeRead( renderObject, 'object' ) || null;
	const activeMaterial = safeRead( renderObject, 'material' ) || null;
	const group = safeRead( renderObject, 'group' );
	const rawMaterialIndex = safeRead( group, 'materialIndex' );
	const materialIndex = Number.isInteger( rawMaterialIndex ) && rawMaterialIndex >= 0 ? rawMaterialIndex : null;
	const sourceMaterialSet = safeRead( object, 'material' );
	const isShadowCaster = safeRead( activeMaterial, 'isShadowPassMaterial' ) === true;
	let material = exactSourceMaterial
		|| safeRead( renderObject, 'sourceMaterial' )
		|| safeRead( activeMaterial, RENDER_BINDING_OWNER_MATERIAL )
		|| null;
	if ( ! material ) {

		if ( isShadowCaster ) {

			material = Array.isArray( sourceMaterialSet )
				? materialIndex !== null ? sourceMaterialSet[ materialIndex ] || null : null
				: sourceMaterialSet || null;

		} else {

			material = activeMaterial;

		}

	}
	return {
		kind: isShadowCaster ? RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER : RENDER_BINDING_OWNER_KINDS.MATERIAL,
		material,
		object,
		group: group || null,
		materialIndex,
		sourceMaterialSet,
	};

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
		reversedDepthBuffer: safeRead( renderer, 'reversedDepthBuffer' ) === true ? true : undefined,
		highPrecision: safeRead( renderer, 'highPrecision' ) === true ? true : null,
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
	const observedDepthTexture = safeRead( context, 'depthTexture' );
	const observedTargetOwnsAttachments = observedRenderTarget != null && renderTargetOwnsAttachments(
		observedRenderTarget,
		textures,
		observedDepthTexture,
	);
	// r185 may reuse a RenderContext keyed by attachment topology during
	// compileAsync(): its texture list is refreshed for the newly bound target
	// while renderTarget still points at the prior real-render target. Treat
	// that non-null identity as stale only when it no longer owns the exact
	// observed attachments; every recovery candidate below must prove ownership.
	const recoverCompileTarget = observedRenderTarget === null || (
		observedRenderTarget !== undefined &&
		! observedTargetOwnsAttachments &&
		Array.isArray( textures ) &&
		textures.length > 0
	);
	const activeRendererTarget = observedRenderTarget === undefined || recoverCompileTarget
		? safeCall( renderer, 'getRenderTarget' )
		: null;
	// Three r185 compileAsync() fills RenderContext.textures but leaves its
	// renderTarget field at the initial null. Depending on the path, the
	// renderer's public target is either still available or has already been
	// cleared while each attachment retains its exact RenderTarget owner.
	// Recover a compile target only when every observed attachment proves the
	// same owner. A real default surface, mixed MRT attachments, copied
	// textures, and stale owner back-references cannot pass these checks.
	const rendererCompileTarget = recoverCompileTarget && renderTargetOwnsAttachments(
		activeRendererTarget,
		textures,
		observedDepthTexture,
	);
	const attachmentCompileTarget = recoverCompileTarget
		? inferAttachmentRenderTarget( textures, observedDepthTexture )
		: null;
	// Prefer the renderer's exact active target when both sources agree on the
	// attachments. The attachment-owned fallback exists for Three's private
	// post-processing target, which compileAsync() does not expose publicly.
	const compileTarget = rendererCompileTarget ? activeRendererTarget : attachmentCompileTarget;
	const inferredCompileTarget = compileTarget !== null;
	const renderTarget = observedRenderTarget === undefined
		? activeRendererTarget
		: inferredCompileTarget ? compileTarget : observedRenderTarget;
	const activeCubeFace = resolveActiveTargetIndex( inferredCompileTarget ? undefined : observedActiveCubeFace, renderTarget, 'activeCubeFace', '_activeCubeFace', renderer, '_activeCubeFace', 'getActiveCubeFace' );
	const activeMipmapLevel = resolveActiveTargetIndex( inferredCompileTarget ? undefined : observedActiveMipmapLevel, renderTarget, 'activeMipmapLevel', '_activeMipmapLevel', renderer, '_activeMipmapLevel', 'getActiveMipmapLevel' );
	if ( ! Array.isArray( textures ) ) {

		textures = Array.isArray( safeRead( renderTarget, 'textures' ) )
			? renderTarget.textures
			: safeRead( renderTarget, 'texture' ) ? [ renderTarget.texture ] : [];

	}
	const outputTarget = safeCall( renderer, 'getOutputRenderTarget' );
	const surface = classifyRenderSurface( renderTarget, outputTarget, textures );
	const includeAttachmentNames = safeRead( context, 'mrt' ) != null;
	// Three r185 compileAsync() updates the target textures but leaves
	// RenderContext.renderTarget null and keeps depth/stencil at the renderer's
	// default-surface values. Once exact attachment identity proves which target
	// is bound, its attachment flags are the authoritative pipeline topology.
	// Ordinary real-render contexts continue to use their request-time values.
	const color = inferredCompileTarget
		? textures.length > 0
		: safeRead( context, 'color' ) ?? ( textures.length > 0 );
	const depth = inferredCompileTarget
		? safeRead( renderTarget, 'depthBuffer' ) ?? safeRead( context, 'depth' )
		: safeRead( context, 'depth' ) ?? safeRead( renderTarget, 'depthBuffer' );
	const stencil = inferredCompileTarget
		? safeRead( renderTarget, 'stencilBuffer' ) ?? safeRead( context, 'stencil' )
		: safeRead( context, 'stencil' ) ?? safeRead( renderTarget, 'stencilBuffer' );
	return compactObject( {
		surface,
		activeCubeFace,
		activeMipmapLevel,
		color: scalar( color ),
		depth: scalar( depth ),
		stencil: scalar( stencil ),
		sampleCount: effectiveSampleCount( context, renderTarget, renderer, textures ),
		multiview: safeRead( context, 'multiview' ) === true || safeRead( renderTarget, 'multiview' ) === true,
		colors: textures.map( ( texture ) => describeColorAttachment( texture, includeAttachmentNames ) ),
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

function renderTargetOwnsAttachments( renderTarget, observedTextures, observedDepthTexture ) {

	if ( ! renderTargetOwnsTextures( renderTarget, observedTextures ) ) return false;
	if ( observedDepthTexture === undefined || observedDepthTexture === null ) return true;
	const configuredDepthTexture = safeRead( renderTarget, 'depthTexture' );
	if ( configuredDepthTexture !== undefined && configuredDepthTexture !== null ) {

		return configuredDepthTexture === observedDepthTexture;

	}
	// Three r185 allocates an implicit depth attachment for depth/stencil
	// render targets without assigning it back to RenderTarget.depthTexture.
	// The generated texture still retains its exact RenderTarget owner.
	if (
		safeRead( renderTarget, 'depthBuffer' ) !== true &&
		safeRead( renderTarget, 'stencilBuffer' ) !== true
	) return false;
	return safeRead( observedDepthTexture, 'renderTarget' ) === renderTarget;

}

function inferAttachmentRenderTarget( observedTextures, observedDepthTexture ) {

	if ( ! Array.isArray( observedTextures ) || observedTextures.length === 0 ) return null;
	const renderTarget = safeRead( observedTextures[ 0 ], 'renderTarget' );
	if ( ! renderTarget ) return null;
	if ( ! observedTextures.every( ( texture ) => safeRead( texture, 'renderTarget' ) === renderTarget ) ) return null;
	if ( ! renderTargetOwnsAttachments( renderTarget, observedTextures, observedDepthTexture ) ) return null;
	if (
		observedDepthTexture !== undefined &&
		observedDepthTexture !== null &&
		safeRead( observedDepthTexture, 'renderTarget' ) !== renderTarget
	) return null;
	return renderTarget;

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

function describeColorAttachment( texture, includeName = false ) {

	return compactObject( {
		...resourceShape( texture ),
		...( includeName ? { name: scalar( safeRead( texture, 'name' ) ) } : {} ),
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

function describeObject( object, sourceGeometry = safeRead( object, 'geometry' ) ) {

	if ( ! object ) return null;
	const skeleton = safeRead( object, 'skeleton' );
	const instanceMatrix = safeRead( object, 'instanceMatrix' );
	return compactObject( {
		receiveShadow: safeRead( object, 'receiveShadow' ) === true,
		skinned: safeRead( object, 'isSkinnedMesh' ) === true,
		boneCount: Array.isArray( safeRead( skeleton, 'bones' ) ) ? skeleton.bones.length : 0,
		instanced: safeRead( object, 'isInstancedMesh' ) === true || Number( safeRead( object, 'count' ) ) > 1,
		batched: safeRead( object, 'isBatchedMesh' ) === true,
		morphInfluences: Array.isArray( safeRead( object, 'morphTargetInfluences' ) ),
		instanceMatrix: !! instanceMatrix,
		// Three r185 lowers InstanceNode matrices to a fixed-size
		// NodeUniformBuffer (`array<mat4x4<f32>, N>`). N is the physical
		// attribute capacity, not the mutable draw count, and therefore selects
		// both different WGSL and a different bind-group buffer size.
		instanceMatrixCount: instanceMatrixCapacity( instanceMatrix ),
		instanceColor: !! safeRead( object, 'instanceColor' ),
		batchColors: !! safeRead( object, '_colorsTexture' ),
		geometry: describeGeometry( sourceGeometry ),
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
		itemSize: effectiveAttributeItemSize( attribute ),
		normalized: scalar( safeRead( attribute, 'normalized' ) ),
	} );

}

function effectiveAttributeItemSize( attribute ) {

	const itemSize = scalar( safeRead( attribute, 'itemSize' ) );
	// WebGPUAttributeUtils in Three r185 pads storage vec3 data to vec4 and
	// mutates the live attribute during upload. Normalize both the pre-upload
	// and post-upload observations to the effective storage layout so selector
	// timing cannot split otherwise identical WGSL artifacts.
	if ( itemSize === 3 && (
		safeRead( attribute, 'isStorageBufferAttribute' ) === true
		|| safeRead( attribute, 'isStorageInstancedBufferAttribute' ) === true
	) ) return 4;
	return itemSize;

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
