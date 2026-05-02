/**
 * Precompiled artifact → NodeBuilderState hydration.
 *
 * The slim bundle deletes `WGSLNodeBuilder` and short-circuits
 * `Nodes.js:getForRender` to call `hydrateNodeBuilderState` instead of
 * `this.backend.createNodeBuilder()`. This function produces a plain
 * object shaped like three.js's internal `NodeBuilderState` from a
 * precompiled artifact — enough for the renderer's pipeline dispatch
 * (`Pipelines.js`), render-object wiring (`RenderObject.js`), and the
 * per-frame update loop to find the fields they read off of it.
 *
 * Non-goals of this POC hydrator:
 *   - Full runtime parity with the TSL builder. Live-binding / shadow /
 *     complex-uniform paths that depend on the full binding class tree
 *     are deferred. This version returns empty bindings, empty update
 *     arrays, and a minimal observer, which is enough for static-material rendering but NOT for
 *     materials that need per-frame updates through the node system.
 *   - The UBO write path goes through `PrecompiledMaterial`'s generated
 *     updater instead — that's already wired via `apply-precompiled.js`.
 *
 * @module Hydrator
 */

import BindGroup from 'three/src/renderers/common/BindGroup.js';
import UniformBuffer from 'three/src/renderers/common/UniformBuffer.js';
import StorageBuffer from 'three/src/renderers/common/StorageBuffer.js';
import StorageBufferAttribute from 'three/src/renderers/common/StorageBufferAttribute.js';
import Sampler from 'three/src/renderers/common/Sampler.js';
import { SampledTexture, SampledCubeTexture, Sampled3DTexture, SampledArrayTexture } from 'three/src/renderers/common/SampledTexture.js';
import { DataTexture, Data3DTexture, DataArrayTexture, DepthTexture, CubeTexture, RGBAFormat, DepthFormat, UnsignedByteType, UnsignedIntType, LessEqualCompare, Vector2, Vector3, Vector4, Matrix4 } from 'three';
import { getDFGLUT } from './dfg-lut.js';

const fallbackTexture = new DataTexture( new Uint8Array( [ 255, 255, 255, 255 ] ), 1, 1, RGBAFormat );
fallbackTexture.needsUpdate = true;

// Cube fallback: a six-face neutral grey cube. Supplied to texture_cube
// bindings whose live cubemap could not be resolved (e.g. capture-side
// uuids no longer match anything on replay). Without this fallback a
// pipeline that declares texture_cube<f32> ends up bound to a 2D fallback
// texture, the WebGPU validator silently rejects the bind group, and the
// draw is skipped — producing an empty canvas with no error surfaced.
function makeCubeFallback() {

	const faces = [];
	for ( let i = 0; i < 6; i ++ ) {

		const data = new Uint8Array( [ 128, 128, 128, 255 ] );
		const tex = new DataTexture( data, 1, 1, RGBAFormat );
		tex.needsUpdate = true;
		faces.push( tex.image );

	}
	const cube = new CubeTexture( faces );
	cube.format = RGBAFormat;
	cube.type = UnsignedByteType;
	cube.needsUpdate = true;
	return cube;

}
const fallbackCubeTexture = makeCubeFallback();
const fallback3DTexture = new Data3DTexture( new Uint8Array( [ 255, 255, 255, 255 ] ), 1, 1, 1 );
fallback3DTexture.format = RGBAFormat;
fallback3DTexture.type = UnsignedByteType;
fallback3DTexture.needsUpdate = true;
const fallbackArrayTexture = new DataArrayTexture( new Uint8Array( [ 255, 255, 255, 255 ] ), 1, 1, 1 );
fallbackArrayTexture.format = RGBAFormat;
fallbackArrayTexture.type = UnsignedByteType;
fallbackArrayTexture.needsUpdate = true;
const fallbackDepthTexture = new DepthTexture( 1, 1 );
fallbackDepthTexture.format = DepthFormat;
fallbackDepthTexture.type = UnsignedIntType;
fallbackDepthTexture.isFramebufferTexture = true;
const fallbackComparisonDepthTexture = new DepthTexture( 1, 1 );
fallbackComparisonDepthTexture.format = DepthFormat;
fallbackComparisonDepthTexture.type = UnsignedIntType;
fallbackComparisonDepthTexture.isFramebufferTexture = true;
fallbackComparisonDepthTexture.compareFunction = LessEqualCompare;
const fallbackMultisampledDepthTexture = new DepthTexture( 1, 1 );
fallbackMultisampledDepthTexture.format = DepthFormat;
fallbackMultisampledDepthTexture.type = UnsignedIntType;
fallbackMultisampledDepthTexture.renderTarget = { samples: 4 };

// Live-texture identity index. Hosts (harness / app) call
// `registerLiveTexture(tex)` on every freshly-loaded Texture they want the
// hydrator to be able to relink to. The hydrator looks up by `imageSrc`
// (loader URL) first, then `textureName`. Production code that keeps the
// same Texture instance hits the UUID path and never touches this index.
const _liveTexturesBySrc = new Map();
const _liveTexturesByName = new Map();

export function registerLiveTexture( texture ) {

	if ( ! texture || ! texture.isTexture ) return;
	const image = texture.image || null;
	const src = image && ( image.src || image.currentSrc || ( Array.isArray( image ) && image[ 0 ] && ( image[ 0 ].src || image[ 0 ].currentSrc ) ) || null );
	if ( typeof src === 'string' && src.length > 0 ) _liveTexturesBySrc.set( src, texture );
	if ( typeof texture.name === 'string' && texture.name.length > 0 && ! _liveTexturesByName.has( texture.name ) ) _liveTexturesByName.set( texture.name, texture );

}

export function clearLiveTextureIndex() {

	_liveTexturesBySrc.clear();
	_liveTexturesByName.clear();

}

function lookupLiveTextureByIdentity( source ) {

	if ( ! source ) return null;
	if ( source.imageSrc && _liveTexturesBySrc.has( source.imageSrc ) ) return _liveTexturesBySrc.get( source.imageSrc );
	if ( source.textureName && _liveTexturesByName.has( source.textureName ) ) return _liveTexturesByName.get( source.textureName );
	return null;

}

// Module-level scratch objects — reused per frame to avoid GC pressure.
const _rSize = new Vector2( 1, 1 );
const _rViewport = new Vector4( 0, 0, 1, 1 );
const _ovp = new Vector3();
const _odir = new Vector3();
const _mwi = new Matrix4();
const _lvec = new Vector3();

// Find the Nth light in a scene by traversal order. Mirrors the cache
// strategy emit-updater.js bakes into AOT modules — both the AOT and
// snapshot-based hydration paths read lights through this lookup so the
// captured `lightIndex` resolves to the same Light at replay time.
//
// The cache key is the Scene instance; lights added/removed mid-session
// won't invalidate the cache. That's acceptable for now: scene-graph
// lighting changes are rare and the alternative (per-frame retraversal)
// would tax every UBO update for materials with many light-driven slots.
function findLightInScene( scene, index ) {

	if ( ! scene ) return null;
	let cache = scene._tslpLightCache;
	if ( ! cache || cache.scene !== scene ) {

		cache = { scene, lights: [] };
		scene._tslpLightCache = cache;
		if ( typeof scene.traverse === 'function' ) {

			scene.traverse( ( o ) => {

				if ( o && o.isLight === true ) cache.lights.push( o );

			} );

		}

	}
	return cache.lights[ index ] || null;

}

/**
 * Produce a NodeBuilderState-compatible object for a precompiled material.
 *
 * @param {Object} artifact - The `precompiledArtifact` carried on the material.
 * @return {Object} A plain object with the fields `Pipelines.js` + `RenderObject.js` read.
 */
export function hydrateNodeBuilderState( artifact, material = null ) {

	if ( ! artifact ) {

		throw new Error( '[tsl-precompile/hydrator] artifact is required (material.isPrecompiledMaterial but material.precompiledArtifact is null)' );

	}

	const { bindings, uniformBuffers } = hydrateRuntimeBindings( artifact, material );
	const updateNode = createUniformUpdateNode( artifact, uniformBuffers, material );

	// In-process flows (dev-server capture → immediate render) carry live
	// update node instances as non-enumerable sidecars on the artifact. Include
	// them BEFORE the snapshot-based updater so LightNode.update() / ShadowNode
	// / onRenderUpdate closures write fresh values into _liveNode.value before
	// the snapshot writer reads them. In JSON-loaded flows these are absent and
	// the snapshot-only path is used instead.
	const liveUpdateNodes = Array.isArray( artifact._liveUpdateNodes ) ? artifact._liveUpdateNodes : [];
	const liveUpdateBeforeNodes = Array.isArray( artifact._liveUpdateBeforeNodes ) ? artifact._liveUpdateBeforeNodes : [];
	const liveUpdateAfterNodes = Array.isArray( artifact._liveUpdateAfterNodes ) ? artifact._liveUpdateAfterNodes : [];

	const base = {
		vertexShader: String( artifact.vertexShader || '' ),
		fragmentShader: String( artifact.fragmentShader || '' ),
		computeShader: String( artifact.computeShader || '' ),
		transforms: artifact.transforms || [],
		nodeAttributes: hydrateNodeAttributes( artifact.nodeAttributes || artifact.attributes || [] ),
		bindings,
		updateNodes: [ ...liveUpdateNodes, ...( updateNode ? [ updateNode ] : [] ) ],
		updateBeforeNodes: [ ...liveUpdateBeforeNodes ],
		updateAfterNodes: [ ...liveUpdateAfterNodes ],
		observer: createStaticObserver(),
		usedTimes: 0,
		// Three.js's renderer/pipeline calls these methods across versions.
		// Each returns a structurally-correct default; in slim mode the
		// rendering paths that need richer semantics aren't exercised.
		// `createBindings()` is called per-renderObject by RenderObject.js;
		// for materials shared across many objects (e.g. 200 sprites all
		// using the same SpriteNodeMaterial) we MUST return per-call
		// instances of any non-shared UBO so each object writes its own
		// per-frame uniforms. Shared UBOs (render group: camera matrices)
		// keep the same instance.
		createBindings() {

			return cloneBindingsForObject( this.bindings, artifact, material );

		},
		getAttributesArray() {

			return this.nodeAttributes;

		},
		getBindings() {

			return this.bindings;

		},
		build() { /* no-op: artifact is already baked */ },
		buildAsync: async () => { /* no-op */ },
	};

	// Wrap in a Proxy that returns a no-op function for any OTHER method
	// lookup the renderer might do. Keeps forward-compatibility with
	// three.js version bumps without shape-gating every method name.
	return new Proxy( base, {
		get( target, prop ) {

			if ( prop in target ) return target[ prop ];
			// Unknown property: return a no-op function. Common for
			// renderer helpers that probe for optional methods.
			return () => undefined;

		},
	} );

}

function hydrateNodeAttributes( attributes ) {

	if ( ! Array.isArray( attributes ) ) return [];

	return attributes.map( ( attribute ) => {

		if ( ! attribute || attribute.source !== 'node' ) return attribute;

		const liveAttribute = attribute._liveAttribute || ( attribute.node && attribute.node.attribute );
		if ( liveAttribute ) return { ...attribute, node: { attribute: liveAttribute } };

		const itemSize = attribute.itemSize || itemSizeFromAttributeType( attribute.type );
		const count = Math.max( 1, attribute.count || 1 );
		const TypeArray = resolveTypedArrayCtor( attribute.arrayType );

		return {
			...attribute,
			node: {
				attribute: new StorageBufferAttribute( count, itemSize, TypeArray ),
			},
		};

	} );

}

function itemSizeFromAttributeType( type ) {

	switch ( type ) {

		case 'float':
		case 'number':
		case 'int':
		case 'uint':
			return 1;
		case 'vec2':
		case 'ivec2':
		case 'uvec2':
			return 2;
		case 'vec4':
		case 'ivec4':
		case 'uvec4':
			return 4;
		case 'vec3':
		case 'ivec3':
		case 'uvec3':
		default:
			return 3;

	}

}

/**
 * Per-renderObject bindings. Materials shared across many meshes (e.g.
 * 200 sprites all using the same SpriteNodeMaterial) need their own
 * per-object UBO instance so each frame each object writes its own
 * model/position/rotation values into a distinct GPU buffer; without
 * this, every object overwrites the previous one and only the LAST
 * draw's uniforms reach the GPU.
 *
 * Shared groups (the 'render' group with camera/time uniforms) keep the
 * same instance so the renderer uploads them once per frame.
 *
 * @param {Array<BindGroup>} bindings - The base bindings created at hydration time.
 * @param {Object} artifact
 * @param {?Material} material
 * @return {Array<BindGroup>}
 */
function cloneBindingsForObject( bindings, artifact, material ) {

	if ( ! Array.isArray( bindings ) || bindings.length === 0 ) return bindings;
	const out = [];
	for ( const bg of bindings ) {

		if ( ! bg ) { out.push( bg ); continue; }
		if ( isBindGroupShared( bg ) ) { out.push( bg ); continue; }
		const clonedBindings = ( bg.bindings || [] ).map( ( b ) => cloneBinding( b ) );
		const newGroup = new BindGroup( bg.name || '', clonedBindings );
		out.push( newGroup );

	}
	return out;

}

function isBindGroupShared( bg ) {

	const list = bg.bindings || [];
	for ( const b of list ) {

		if ( b && b.groupNode && b.groupNode.shared === true ) return true;

	}
	return false;

}

function cloneBinding( binding ) {

	if ( ! binding ) return binding;
	// UniformBuffer: clone the underlying Float32Array so each
	// per-object UBO has its own backing storage. Three.js's
	// `_bindings.updateForRender` copies bytes from this JS buffer
	// into the GPU buffer per-object; without the clone, every object
	// shares one Float32Array and the LAST writer wins.
	if ( binding.isUniformBuffer ) {

		const view = binding.buffer;
		const newBuffer = view ? new view.constructor( view ) : new Float32Array( 0 );
		const cloned = new UniformBuffer( binding.name, newBuffer );
		cloned.visibility = binding.visibility | 0;
		cloned.groupNode = { shared: false, version: 0 };
		return cloned;

	}
	// SampledTexture / Sampler / StorageBuffer share their resources
	// across objects (textures are global; storage buffers are
	// compute-shared). Reuse instances to keep the renderer's
	// resource cache hot.
	return binding;

}

function hydrateRuntimeBindings( artifact, material ) {

	const uniformBuffers = new Map();
	const bindings = artifact.bindings;
	if ( ! Array.isArray( bindings ) ) return { bindings: [], uniformBuffers };

	// Full three.js artifacts contain JSON descriptors. Rehydrate the subset
	// needed by WGSL pipeline layout creation and UBO uploads. Texture/storage
	// descriptors still need dedicated runtime registries, so leave them out
	// until those resources can be resolved safely.
	const groups = [];

	for ( const group of bindings ) {

		const runtimeBindings = [];
		const groupNode = {
			shared: findUniformGroupShared( artifact, group.name ),
			version: 0,
		};

		for ( const descriptor of group.bindings || [] ) {

			const runtimeBinding = createRuntimeBinding( artifact, group, descriptor, material, groupNode );
			if ( ! runtimeBinding ) continue;

			runtimeBindings.push( runtimeBinding );
			if ( runtimeBinding.isUniformBuffer ) uniformBuffers.set( descriptor.name || group.name || '', runtimeBinding );

		}

		if ( runtimeBindings.length > 0 ) groups.push( new BindGroup( group.name || '', runtimeBindings ) );

	}

	return { bindings: groups, uniformBuffers };

}

function createRuntimeBinding( artifact, group, descriptor, material, groupNode ) {

	const name = descriptor.name || group.name || '';

	if ( descriptor.kind === 'uniform-buffer' ) {

		const byteLength = Math.max(
			descriptor.byteLength || 0,
			findUniformGroupByteLength( artifact, group.name, descriptor.name ),
			findUniformGroupRequiredByteLength( artifact, group.name, descriptor.name )
		);
		const buffer = new Float32Array( Math.max( 4, Math.ceil( byteLength / 4 ) ) );
		seedUniformBufferSnapshots( artifact, group.name, name, buffer );

		// Seed a NodeUniformBuffer (flat typed-array UBO used by FXAA, DoF,
		// and similar post-process shaders) from its compile-time snapshot.
		// These buffers have no slot decomposition in the plan, so the normal
		// per-slot write path skips them. A one-time snapshot seed at
		// least gives correct initial parameters for static post-process.
		const ubPlanEntry = resolvePlanBufferUniform( artifact, group.name, name );
		if ( ubPlanEntry ) {

			const snap = ubPlanEntry._liveArray || ubPlanEntry.valueSnapshot;
			if ( snap ) {

				for ( let i = 0; i < Math.min( snap.length, buffer.length ); i ++ ) buffer[ i ] = snap[ i ];

			}

		}

		const uniformBuffer = new UniformBuffer( name, buffer );
		uniformBuffer.visibility = descriptor.visibility | 0;
		uniformBuffer.groupNode = groupNode;
		return uniformBuffer;

	}

	if ( descriptor.kind === 'sampled-texture' ) {

		const texture = resolveTextureBinding( artifact, group.name, descriptor.name, material );
		const textureType = descriptor.textureType || inferTextureTypeFromShader( artifact, descriptor.name );
		let binding;
		if ( textureType === 'cube' ) binding = new SampledCubeTexture( name, texture );
		else if ( textureType === '3d' ) {

			binding = new Sampled3DTexture( name, texture );
			binding.isSampledTexture3D = true;

		}
		else if ( textureType === '2d-array' ) binding = new SampledArrayTexture( name, texture );
		else binding = new SampledTexture( name, texture );
		binding.visibility = descriptor.visibility | 0;
		binding.groupNode = groupNode;
		return binding;

	}

	if ( descriptor.kind === 'sampler' ) {

		const texture = resolveTextureBinding( artifact, group.name, descriptor.name, material );
		const binding = new Sampler( name, texture );
		binding.visibility = descriptor.visibility | 0;
		binding.groupNode = groupNode;
		return binding;

	}

	// Storage buffers — compute shaders bind typed arrays for read/write by
	// the compute kernel. Reconstruct from captured metadata. In-process flows
	// carry the live attribute as `_liveAttribute` on the plan entry; use it
	// directly to share the same typed array the compute kernel wrote into.
	if ( descriptor.kind === 'storage-buffer' ) {

		const sbEntry = resolvePlanStorageBuffer( artifact, group.name, name );
		let attr;
		// In-process flows attach a live StorageBufferAttribute; out-of-
		// process (JSON-loaded) flows lose the prototype + TypedArray view
		// to the round-trip. Trust `_liveAttribute` only when its
		// `.array` is still a real TypedArray — otherwise allocate fresh
		// from count/itemSize/arrayType so WebGPU's `createBuffer` sees a
		// finite byteLength.
		const liveAttr = sbEntry && sbEntry._liveAttribute;
		const liveAttrIsLive = liveAttr && liveAttr.array && ArrayBuffer.isView( liveAttr.array );
		if ( liveAttrIsLive ) {

			attr = liveAttr;

		} else {

			const count = sbEntry ? ( sbEntry.count || 1 ) : 1;
			const itemSize = sbEntry ? ( sbEntry.itemSize || 1 ) : 1;
			const TypedArray = resolveTypedArrayCtor( sbEntry ? sbEntry.arrayType : null );
			attr = new StorageBufferAttribute( count, itemSize, TypedArray );
			// Seed from `_liveArray` only if it survived as a TypedArray.
			// JSON round-trip drops the buffer view; the plain-object form
			// can still seed values via numeric-key iteration.
			const liveArr = sbEntry && sbEntry._liveArray;
			if ( liveArr ) {

				if ( ArrayBuffer.isView( liveArr ) ) {

					attr.array.set( liveArr.subarray( 0, attr.array.length ) );

				} else if ( typeof liveArr === 'object' ) {

					const keys = Object.keys( liveArr );
					for ( let i = 0; i < keys.length; i ++ ) {

						const k = keys[ i ];
						const idx = +k;
						if ( idx >= 0 && idx < attr.array.length ) attr.array[ idx ] = liveArr[ k ];

					}

				}

			}

		}
		const storageBuffer = new StorageBuffer( name, attr );
		storageBuffer.access = descriptor.access || 'read_write';
		storageBuffer.visibility = descriptor.visibility | 0;
		storageBuffer.groupNode = groupNode;
		return storageBuffer;

	}

	return null;

}

function seedUniformBufferSnapshots( artifact, groupName, bindingName, buffer ) {

	const group = findUniformGroup( artifact, groupName, bindingName );
	if ( ! group || ! Array.isArray( group.slots ) || group.slots.length === 0 ) return;

	const view = new DataView( buffer.buffer, buffer.byteOffset, buffer.byteLength );
	for ( const slot of group.slots ) {

		const source = slot.source || {};
		const snapshot = source.valueSnapshot || ( source.valueType ? { type: source.valueType, data: source.value } : null );
		if ( ! snapshot ) continue;
		writeSnapshot( view, slot.offset ?? slot.byteOffset ?? 0, snapshot );

	}

}

function resolveTextureBinding( artifact, groupName, bindingName, material ) {

	const plan = Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [];
	const group = plan.find( ( item ) => item.name === groupName );
	const texture = group && ( group.textures || [] ).find( ( item ) => item.name === bindingName );
	const source = texture && texture.source || {};

	// Built-in DFG LUT for IBL: static precomputed 16×16 RG16F texture.
	// Identical to three.js's own DFGLUT.js — no renderer required.
	if ( source.kind === 'builtin.dfgLUT' ) {

		return getDFGLUT() || fallbackTextureForBinding( artifact, bindingName );

	}

	if ( source.kind && source.kind.startsWith( 'material.' ) ) {

		const property = source.property || source.kind.split( '.' )[ 1 ];
		return material && material[ property ] || fallbackTextureForBinding( artifact, bindingName );

	}

	// artifact.texture: resolve by UUID first (production path — same Texture
	// instance is used). Fall back to imageSrc/textureName matching against a
	// runtime-registered texture index so harness/test paths that re-create
	// Texture instances on each load can still relink. Snapshot data is the
	// last resort.
	if ( source.kind === 'artifact.texture' && source.textureUuid ) {

		const wantsDepthTexture = shaderDeclaresDepthTexture( artifact, bindingName );
		const wantsMultisampledTexture = shaderDeclaresMultisampledTexture( artifact, bindingName );
		if ( wantsDepthTexture && ! wantsMultisampledTexture ) return fallbackDepthTexture;

		if ( artifact._textureRefs ) {

			const tex = artifact._textureRefs.get( source.textureUuid );
			if ( tex && textureMatchesShaderMultisample( artifact, bindingName, tex ) ) return tex;

		}

		if ( material ) {

			const TEXTURE_PROPS = [
				'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap',
				'emissiveMap', 'envMap', 'lightMap', 'displacementMap',
				'alphaMap', 'bumpMap', 'clearcoatMap', 'clearcoatNormalMap',
				'clearcoatRoughnessMap', 'transmissionMap', 'thicknessMap',
				'iridescenceMap', 'iridescenceThicknessMap', 'sheenColorMap',
				'sheenRoughnessMap', 'specularMap', 'specularColorMap',
				'specularIntensityMap', 'gradientMap', 'matcap',
			];
			for ( const prop of TEXTURE_PROPS ) {

				const tex = material[ prop ];
				if ( tex && tex.isTexture && tex.uuid === source.textureUuid && textureMatchesShaderMultisample( artifact, bindingName, tex ) ) return tex;

			}

		}

		// Identity-based relink (imageSrc / textureName). The runtime keeps
		// a global index updated by the host (harness or app) via
		// `registerLiveTexture`. This is what allows TSL `texture(uvTex)`
		// closures to resolve when the example reloads with fresh Texture
		// instances whose uuids no longer match the captured artifact.
		const byIdent = lookupLiveTextureByIdentity( source );
		if ( byIdent && textureMatchesShaderMultisample( artifact, bindingName, byIdent ) ) return byIdent;

		if ( source.snapshot ) {

			return textureFromSnapshot( artifact, source.textureUuid, source.snapshot, bindingName );

		}

		if ( wantsDepthTexture && wantsMultisampledTexture ) return fallbackMultisampledDepthTexture;

	}

	return fallbackTextureForBinding( artifact, bindingName );

}

function shaderDeclaresDepthTexture( artifact, bindingName ) {

	const wgsl = `${ artifact.vertexShader || '' }\n${ artifact.fragmentShader || '' }\n${ artifact.computeShader || '' }`;
	const escaped = bindingName.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
	return new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_depth`, 'm' ).test( wgsl );

}
function textureMatchesShaderMultisample( artifact, bindingName, texture ) {

	if ( ! texture ) return true;
	const wantsMultisampledTexture = shaderDeclaresMultisampledTexture( artifact, bindingName );
	if ( texture.isRenderTargetTexture === true && texture.isDepthTexture !== true ) return wantsMultisampledTexture === false;
	const isMultisampledTexture = isLikelyMultisampledTexture( texture );
	return wantsMultisampledTexture ? isMultisampledTexture : ! isMultisampledTexture;

}

function isLikelyMultisampledTexture( texture ) {

	return !! ( texture && texture.renderTarget && texture.renderTarget.samples > 1 );

}

function shaderDeclaresMultisampledTexture( artifact, bindingName ) {

	const wgsl = `${ artifact.vertexShader || '' }\n${ artifact.fragmentShader || '' }\n${ artifact.computeShader || '' }`;
	const escaped = bindingName.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
	return new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_(?:depth_)?multisampled_2d`, 'm' ).test( wgsl );

}
function shaderDeclaresArrayTexture( artifact, bindingName ) {

	const wgsl = `${ artifact.vertexShader || '' }\n${ artifact.fragmentShader || '' }\n${ artifact.computeShader || '' }`;
	const escaped = bindingName.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
	return new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_2d_array`, 'm' ).test( wgsl );

}
function textureFromSnapshot( artifact, uuid, snapshot, bindingName = null ) {

	if ( ! snapshot || ! Array.isArray( snapshot.data ) || ! snapshot.width || ! snapshot.height ) return fallbackTexture;
	const key = uuid || `${ snapshot.width }x${ snapshot.height }:${ snapshot.data.length }`;
	if ( ! artifact._textureSnapshotCache ) Object.defineProperty( artifact, '_textureSnapshotCache', { value: new Map(), enumerable: false } );
	if ( artifact._textureSnapshotCache.has( key ) ) return artifact._textureSnapshotCache.get( key );

	const TypeArray = resolveTypedArrayCtor( snapshot.arrayType || 'Uint8Array' );
	const data = new TypeArray( snapshot.data );
	const wantsArrayTexture = bindingName && shaderDeclaresArrayTexture( artifact, bindingName );
	const texture = wantsArrayTexture ?
		new DataArrayTexture( data, snapshot.width, snapshot.height, snapshot.depth || 1 ) :
		new DataTexture(
			data,
			snapshot.width,
			snapshot.height,
			snapshot.format || RGBAFormat,
			snapshot.type || UnsignedByteType
		);
	if ( snapshot.colorSpace !== undefined ) texture.colorSpace = snapshot.colorSpace;
	for ( const prop of [ 'mapping', 'wrapS', 'wrapT', 'magFilter', 'minFilter', 'flipY' ] ) {

		if ( snapshot[ prop ] !== undefined && snapshot[ prop ] !== null ) texture[ prop ] = snapshot[ prop ];

	}
	texture.needsUpdate = true;
	artifact._textureSnapshotCache.set( key, texture );
	return texture;

}

function fallbackTextureForBinding( artifact, bindingName ) {

	const wgsl = `${ artifact.vertexShader || '' }\n${ artifact.fragmentShader || '' }\n${ artifact.computeShader || '' }`;
	const escaped = bindingName.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
	if ( new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_depth`, 'm' ).test( wgsl ) ) {

		return shaderDeclaresMultisampledTexture( artifact, bindingName ) ? fallbackMultisampledDepthTexture : fallbackDepthTexture;

	}
	if ( new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_cube`, 'm' ).test( wgsl ) ) return fallbackCubeTexture;
	if ( new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_3d`, 'm' ).test( wgsl ) ) return fallback3DTexture;
	if ( new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_2d_array`, 'm' ).test( wgsl ) ) return fallbackArrayTexture;
	if ( new RegExp( `var\\s+${ escaped }\\s*:\\s*sampler_comparison`, 'm' ).test( wgsl ) ) return fallbackComparisonDepthTexture;
	if ( /sampler/i.test( bindingName ) && /sampler_comparison/.test( wgsl ) ) return fallbackComparisonDepthTexture;
	return fallbackTexture;

}

function inferTextureTypeFromShader( artifact, bindingName ) {

	const wgsl = `${ artifact.vertexShader || '' }\n${ artifact.fragmentShader || '' }\n${ artifact.computeShader || '' }`;
	const escaped = bindingName.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
	if ( new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_cube`, 'm' ).test( wgsl ) ) return 'cube';
	if ( new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_3d`, 'm' ).test( wgsl ) ) return '3d';
	if ( new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_2d_array`, 'm' ).test( wgsl ) ) return '2d-array';
	return null;

}

function findUniformGroup( artifact, groupName, bindingName ) {

	const plan = Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [];
	return plan.find( ( group ) => group.name === groupName || group.name === bindingName ) || null;

}

function findUniformGroupByteLength( artifact, groupName, bindingName ) {

	const group = findUniformGroup( artifact, groupName, bindingName );
	return group && group.byteLength || 16;

}

function findUniformGroupRequiredByteLength( artifact, groupName, bindingName ) {

	const group = findUniformGroup( artifact, groupName, bindingName );
	if ( ! group || ! Array.isArray( group.slots ) ) return 16;
	let byteLength = group.byteLength || 16;
	for ( const slot of group.slots ) {

		const offset = slot.offset ?? slot.byteOffset ?? 0;
		const source = slot.source || {};
		const snapshot = source.valueSnapshot || ( source.valueType ? { type: source.valueType, data: source.value } : null );
		const snapshotSize = snapshot && Array.isArray( snapshot.data ) ? snapshot.data.length * 4 : 0;
		const slotSize = slot.byteLength || snapshotSize || uniformSlotByteLength( slot.type || slot.valueType || source.valueType );
		byteLength = Math.max( byteLength, offset + slotSize );

	}
	return Math.ceil( byteLength / 16 ) * 16;

}

function uniformSlotByteLength( type ) {

	switch ( type ) {

		case 'float':
		case 'int':
		case 'uint':
		case 'bool':
			return 4;
		case 'vec2':
			return 8;
		case 'vec3':
		case 'vec4':
			return 16;
		case 'mat3':
			return 48;
		case 'mat4':
			return 64;
		default:
			return 64;

	}

}

/**
 * Locate a storage-buffer plan entry by group and binding name.
 *
 * @param {Object} artifact
 * @param {string} groupName
 * @param {string} bindingName
 * @return {?Object}
 */
function resolvePlanStorageBuffer( artifact, groupName, bindingName ) {

	const plan = Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [];
	const group = plan.find( ( g ) => g.name === groupName );
	if ( ! group ) return null;

	// storageBuffers list on the group entry
	const sbList = group.storageBuffers || [];
	const sb = sbList.find( ( s ) => s.name === bindingName );
	if ( sb ) return sb;

	// Also search orderedBindings in case only that list was serialised
	for ( const ob of group.orderedBindings || [] ) {

		if ( ob.type === 'storage-buffer' && ob.ref && ob.ref.name === bindingName ) return ob.ref;

	}

	return null;

}

/**
 * Locate a NodeUniformBuffer (buffer-uniform) plan entry by group and name.
 * These are flat UBOs used by post-process shaders (FXAA, DoF, etc.) —
 * they carry a valueSnapshot of the full typed array at capture time.
 *
 * @param {Object} artifact
 * @param {string} groupName
 * @param {string} bindingName
 * @return {?Object}
 */
function resolvePlanBufferUniform( artifact, groupName, bindingName ) {

	const plan = Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [];
	const group = plan.find( ( g ) => g.name === groupName || g.name === bindingName );
	if ( ! group ) return null;

	for ( const ob of group.orderedBindings || [] ) {

		if ( ob.type === 'buffer-uniform' && ob.ref && ( ob.ref.name === bindingName || ob.ref.name === groupName ) ) return ob.ref;

	}

	return null;

}

/**
 * Resolve a typed-array constructor name to the actual constructor.
 * Defaults to Float32Array for unknown / missing names.
 *
 * @param {?string} name
 * @return {typeof Float32Array}
 */
function resolveTypedArrayCtor( name ) {

	switch ( name ) {

		case 'Int8Array': return Int8Array;
		case 'Uint8Array': return Uint8Array;
		case 'Uint8ClampedArray': return Uint8ClampedArray;
		case 'Int16Array': return Int16Array;
		case 'Uint16Array': return Uint16Array;
		case 'Int32Array': return Int32Array;
		case 'Uint32Array': return Uint32Array;
		case 'Float32Array': return Float32Array;
		case 'Float64Array': return Float64Array;
		default: return Float32Array;

	}

}

function findUniformGroupShared( artifact, groupName, bindingName ) {

	const group = findUniformGroup( artifact, groupName, bindingName );
	return !! ( group && group.shared );

}

function createUniformUpdateNode( artifact, uniformBuffers, material ) {

	const plan = Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [];
	if ( plan.length === 0 || uniformBuffers.size === 0 ) return null;
	const generatedUpdateGroup = typeof artifact._generatedUpdateGroup === 'function' ? artifact._generatedUpdateGroup : null;

	return {
		getUpdateType() {

			return 'object';

		},
		updateReference() {

			return this;

		},
		update( frame ) {

			const frameMaterial = frame.material || material || null;
			for ( const group of plan ) {

				const binding = uniformBuffers.get( group.name );
				if ( ! binding ) continue;

				const view = new DataView( binding.buffer.buffer, binding.buffer.byteOffset, binding.buffer.byteLength );
				if ( generatedUpdateGroup ) generatedUpdateGroup( frame, frameMaterial, view, 0, group.name || '' );
				else writeUniformGroup( group, frame, view, frameMaterial );
				binding.groupNode.version ++;

			}

		},
	};

}

function writeUniformGroup( group, frame, view, material ) {

	for ( const slot of group.slots || [] ) {

		const source = slot.source || {};
		const offset = slot.offset ?? slot.byteOffset ?? 0;
		const kind = source.kind || 'unknown';

		if ( kind === 'camera.projectionMatrix' ) writeMat4( view, offset, frame.camera && frame.camera.projectionMatrix, source.valueSnapshot );
		else if ( kind === 'camera.projectionMatrixInverse' ) writeMat4( view, offset, frame.camera && frame.camera.projectionMatrixInverse, source.valueSnapshot );
		else if ( kind === 'camera.viewMatrix' ) writeMat4( view, offset, frame.camera && frame.camera.matrixWorldInverse, source.valueSnapshot );
		else if ( kind === 'camera.worldMatrix' ) writeMat4( view, offset, frame.camera && frame.camera.matrixWorld, source.valueSnapshot );
		else if ( kind === 'camera.position' ) writeVec3( view, offset, frame.camera && frame.camera.position, source.valueSnapshot );
		else if ( kind === 'camera.near' ) writeNumber( view, offset, frame.camera && frame.camera.near, source.valueSnapshot );
		else if ( kind === 'camera.far' ) writeNumber( view, offset, frame.camera && frame.camera.far, source.valueSnapshot );
		else if ( kind === 'frame.time' ) writeNumber( view, offset, frame.time, source.valueSnapshot );
		else if ( kind === 'frame.deltaTime' ) writeNumber( view, offset, frame.deltaTime, source.valueSnapshot );
		else if ( kind === 'frame.frameId' ) writeUint( view, offset, frame.frameId, source.valueSnapshot );
		else if ( kind === 'object.worldMatrix' || kind === 'object3d.worldMatrix' ) writeMat4( view, offset, frame.object && frame.object.matrixWorld, source.valueSnapshot );
		else if ( kind === 'object.worldMatrixInverse' ) {

			if ( frame.object ) { _mwi.copy( frame.object.matrixWorld ).invert(); writeMat4( view, offset, _mwi ); }
			else writeSnapshot( view, offset, source.valueSnapshot );

		} else if ( kind === 'object.normalMatrix' || kind === 'object3d.normalMatrix' ) writeMat3( view, offset, frame.object && frame.object.normalMatrix, source.valueSnapshot );
		else if ( kind === 'object.modelViewMatrix' || kind === 'object3d.modelViewMatrix' ) writeMat4( view, offset, frame.object && frame.object.modelViewMatrix, source.valueSnapshot );
		else if ( kind === 'object.position' || kind === 'object3d.position' ) writeVec3( view, offset, frame.object && frame.object.position, source.valueSnapshot );
		else if ( kind === 'object.scale' || kind === 'object3d.scale' ) writeVec3( view, offset, frame.object && frame.object.scale, source.valueSnapshot );
		else if ( kind === 'object3d.viewPosition' ) {

			if ( frame.object && frame.camera ) {

				_ovp.setFromMatrixPosition( frame.object.matrixWorld ).applyMatrix4( frame.camera.matrixWorldInverse );
				writeVec3( view, offset, _ovp );

			} else writeSnapshot( view, offset, source.valueSnapshot );

		} else if ( kind === 'object3d.direction' ) {

			if ( frame.object ) { frame.object.getWorldDirection( _odir ); writeVec3( view, offset, _odir ); }
			else writeSnapshot( view, offset, source.valueSnapshot );

		} else if ( kind === 'object3d.radius' ) {

			const geom = frame.object && frame.object.geometry;
			const radius = geom && geom.boundingSphere ? geom.boundingSphere.radius : null;
			writeNumber( view, offset, radius, source.valueSnapshot );

		} else if ( kind === 'renderer.dpr' ) {

			writeNumber( view, offset, frame.renderer ? frame.renderer.getPixelRatio() : null, source.valueSnapshot );

		} else if ( kind === 'renderer.size' ) {

			if ( frame.renderer ) { frame.renderer.getDrawingBufferSize( _rSize ); writeVec2( view, offset, _rSize ); }
			else writeSnapshot( view, offset, source.valueSnapshot );

		} else if ( kind === 'renderer.halfHeight' ) {

			if ( frame.renderer ) { frame.renderer.getSize( _rSize ); writeNumber( view, offset, 0.5 * _rSize.y, source.valueSnapshot ); }
			else writeSnapshot( view, offset, source.valueSnapshot );

		} else if ( kind === 'renderer.viewport' ) {

			if ( frame.renderer ) { frame.renderer.getViewport( _rViewport ); writeVec4( view, offset, _rViewport ); }
			else writeSnapshot( view, offset, source.valueSnapshot );

		}
		else if ( kind.startsWith( 'material.' ) ) writeMaterialValue( view, offset, frame.material || material, source, kind, slot.dtype );
		else if ( kind === 'scene.fog.color' ) writeColor( view, offset, frame.scene && frame.scene.fog && frame.scene.fog.color, source.valueSnapshot );
		else if ( kind === 'scene.fog.near' || kind === 'scene.fog.far' || kind === 'scene.fog.density' ) {

			const property = source.property || kind.split( '.' )[ 2 ];
			writeNumber( view, offset, frame.scene && frame.scene.fog && frame.scene.fog[ property ], source.valueSnapshot );

		} else if ( kind === 'scene.environmentIntensity' || kind === 'scene.backgroundIntensity' || kind === 'scene.backgroundBlurriness' ) {

			const property = source.property || kind.split( '.' )[ 1 ];
			writeNumber( view, offset, frame.scene && frame.scene[ property ], source.valueSnapshot );

		} else if ( kind === 'scene.backgroundRotation' ) {

			// Three.js's `backgroundRotation` TSL is a Matrix4 derived from
			// scene.backgroundRotation (Euler) — only emitted when the
			// background is a textured cube/equirect map. Mirror three.js's
			// SceneProperties: rotate-from-euler then transpose. Skip for
			// non-rotated scenes (Euler is zero) by writing identity.
			if ( frame.scene && frame.scene.backgroundRotation && frame.scene.background && frame.scene.background.isTexture ) {

				_mwi.makeRotationFromEuler( frame.scene.backgroundRotation ).transpose();
				writeMat4( view, offset, _mwi );

			} else writeMat4( view, offset, null, source.valueSnapshot );

		} else if ( kind && kind.startsWith( 'light.' ) ) {

			writeLightValue( view, offset, kind, source, frame );

		} else if ( kind === 'constant' || kind === 'uniform.constant' ) {

			writeSnapshot( view, offset, source.valueSnapshot || { type: source.valueType, data: source.value } );

		} else if ( kind === 'uniform.live' ) {

			// Prefer the live node's current value (updated by _liveUpdateNodes
			// that ran earlier this frame). Fall back to the compile-time snapshot
			// when no live node is available (JSON-loaded artifacts).
			if ( slot._liveNode && slot._liveNode.value !== null && slot._liveNode.value !== undefined ) {

				writeLiveValue( view, offset, slot._liveNode.value, slot.dtype );

			} else {

				writeSnapshot( view, offset, source.valueSnapshot || { type: source.valueType, data: source.value } );

			}

		}

	}

}

function writeMaterialValue( view, offset, material, source, kind, dtype ) {

	const property = source.property || kind.split( '.' )[ 1 ];
	const materialValue = material && material[ property ];
	const value = kind.endsWith( '.matrix' ) && materialValue ? materialValue.matrix : materialValue;
	const snapshot = source.valueSnapshot;

	if ( dtype === 'color' || ( value && value.isColor ) ) writeColor( view, offset, value, snapshot );
	else if ( dtype === 'vec2' ) writeVec2( view, offset, value, snapshot );
	else if ( dtype === 'vec3' ) writeVec3( view, offset, value, snapshot );
	else if ( dtype === 'vec4' ) writeVec4( view, offset, value, snapshot );
	else if ( dtype === 'mat3' ) writeMat3( view, offset, value, snapshot );
	else if ( dtype === 'mat4' ) writeMat4( view, offset, value, snapshot );
	else writeNumber( view, offset, value, snapshot );

}

/**
 * Per-frame writer for direct-light uniforms. Looks up the live `Light`
 * object on `frame.scene` by the `lightIndex` baked into the source at
 * extract time, then writes the live value (intensity-scaled color, decay
 * exponent, view-space position, ...) into the UBO. Without this, captures
 * freeze at extraction-time light state and animated `light.intensity` /
 * `light.position` etc. never reach the GPU.
 *
 * Falls back to the captured snapshot (if any) when the indexed light
 * can't be resolved — e.g. JSON-loaded artifact replayed against a scene
 * that no longer has that light. Three.js itself would render with the
 * frozen value too in that case.
 */
function writeLightValue( view, offset, kind, source, frame ) {

	const lightIndex = source && Number.isInteger( source.lightIndex ) ? source.lightIndex : 0;
	const light = frame && frame.scene ? findLightInScene( frame.scene, lightIndex ) : null;

	if ( ! light ) {

		// Captured fallback — keeps PSNR within reach when the runtime
		// scene differs from capture (no light at the captured index).
		writeSnapshot( view, offset, source.valueSnapshot );
		return;

	}

	switch ( kind ) {

		case 'light.colorScaled': {

			// Mirror AnalyticLightNode.update(): copy color + scale by
			// intensity. Re-use a scratch field on `frame.scene` to avoid
			// allocating per call; small enough to inline directly via
			// component math instead of a Color helper.
			const c = light.color || null;
			const intensity = Number.isFinite( light.intensity ) ? light.intensity : 1;
			const r = c ? c.r * intensity : 0;
			const g = c ? c.g * intensity : 0;
			const b = c ? c.b * intensity : 0;
			view.setFloat32( offset, r, true );
			view.setFloat32( offset + 4, g, true );
			view.setFloat32( offset + 8, b, true );
			return;

		}
		case 'light.distance':
			writeNumber( view, offset, Number.isFinite( light.distance ) ? light.distance : 0 );
			return;
		case 'light.decay':
			writeNumber( view, offset, Number.isFinite( light.decay ) ? light.decay : 2 );
			return;
		case 'light.coneCos':
			writeNumber( view, offset, Math.cos( light.angle || 0 ) );
			return;
		case 'light.penumbraCos':
			writeNumber( view, offset, Math.cos( ( light.angle || 0 ) * ( 1 - ( light.penumbra || 0 ) ) ) );
			return;
		case 'light.position':
			if ( light.matrixWorld ) {

				_lvec.setFromMatrixPosition( light.matrixWorld );
				writeVec3( view, offset, _lvec );

			} else writeSnapshot( view, offset, source.valueSnapshot );
			return;
		case 'light.viewPosition':
			if ( light.matrixWorld && frame.camera && frame.camera.matrixWorldInverse ) {

				_lvec.setFromMatrixPosition( light.matrixWorld );
				_lvec.applyMatrix4( frame.camera.matrixWorldInverse );
				writeVec3( view, offset, _lvec );

			} else writeSnapshot( view, offset, source.valueSnapshot );
			return;
		case 'light.targetPosition':
			if ( light.target && light.target.matrixWorld ) {

				_lvec.setFromMatrixPosition( light.target.matrixWorld );
				writeVec3( view, offset, _lvec );

			} else writeSnapshot( view, offset, source.valueSnapshot );
			return;
		default:
			// Unknown light.* kind — fall back to snapshot.
			writeSnapshot( view, offset, source.valueSnapshot );
			return;

	}

}

function writeSnapshot( view, offset, snapshot ) {

	if ( ! snapshot ) return;
	const { type, data } = snapshot;
	if ( type === 'number' || type === 'float' || type === 'f32' ) writeNumber( view, offset, data );
	else if ( type === 'int' || type === 'i32' ) writeInt( view, offset, data );
	else if ( type === 'uint' || type === 'u32' ) writeUint( view, offset, data );
	else if ( type === 'color' ) writeColor( view, offset, { r: data[ 0 ], g: data[ 1 ], b: data[ 2 ] } );
	else if ( type === 'vec2' ) writeVec2( view, offset, { x: data[ 0 ], y: data[ 1 ] } );
	else if ( type === 'vec3' ) writeVec3( view, offset, { x: data[ 0 ], y: data[ 1 ], z: data[ 2 ] } );
	else if ( type === 'vec4' ) writeVec4( view, offset, { x: data[ 0 ], y: data[ 1 ], z: data[ 2 ], w: data[ 3 ] } );
	else if ( type === 'mat3' ) writeMat3( view, offset, { elements: data } );
	else if ( type === 'mat4' ) writeMat4( view, offset, { elements: data } );

}

function writeNumber( view, offset, value, snapshot ) {

	const n = Number.isFinite( value ) ? value : snapshot && Number( snapshot.data ) || 0;
	view.setFloat32( offset, n, true );

}

function writeInt( view, offset, value, snapshot ) {

	const n = Number.isFinite( value ) ? value : snapshot && Number( snapshot.data ) || 0;
	view.setInt32( offset, n | 0, true );

}

function writeUint( view, offset, value, snapshot ) {

	const n = Number.isFinite( value ) ? value : snapshot && Number( snapshot.data ) || 0;
	view.setUint32( offset, n >>> 0, true );

}

function writeColor( view, offset, value, snapshot ) {

	if ( ! value && snapshot ) return writeSnapshot( view, offset, snapshot );
	view.setFloat32( offset, value && value.r || 0, true );
	view.setFloat32( offset + 4, value && value.g || 0, true );
	view.setFloat32( offset + 8, value && value.b || 0, true );

}

function writeVec2( view, offset, value, snapshot ) {

	if ( ! value && snapshot ) return writeSnapshot( view, offset, snapshot );
	view.setFloat32( offset, value && value.x || 0, true );
	view.setFloat32( offset + 4, value && value.y || 0, true );

}

function writeVec3( view, offset, value, snapshot ) {

	if ( ! value && snapshot ) return writeSnapshot( view, offset, snapshot );
	view.setFloat32( offset, value && value.x || 0, true );
	view.setFloat32( offset + 4, value && value.y || 0, true );
	view.setFloat32( offset + 8, value && value.z || 0, true );

}

function writeVec4( view, offset, value, snapshot ) {

	if ( ! value && snapshot ) return writeSnapshot( view, offset, snapshot );
	view.setFloat32( offset, value && value.x || 0, true );
	view.setFloat32( offset + 4, value && value.y || 0, true );
	view.setFloat32( offset + 8, value && value.z || 0, true );
	view.setFloat32( offset + 12, value && value.w || 0, true );

}

function writeMat3( view, offset, value, snapshot ) {

	if ( ! value && snapshot ) return writeSnapshot( view, offset, snapshot );
	const e = value && value.elements || [];
	view.setFloat32( offset + 0, e[ 0 ] || 0, true );
	view.setFloat32( offset + 4, e[ 1 ] || 0, true );
	view.setFloat32( offset + 8, e[ 2 ] || 0, true );
	view.setFloat32( offset + 16, e[ 3 ] || 0, true );
	view.setFloat32( offset + 20, e[ 4 ] || 0, true );
	view.setFloat32( offset + 24, e[ 5 ] || 0, true );
	view.setFloat32( offset + 32, e[ 6 ] || 0, true );
	view.setFloat32( offset + 36, e[ 7 ] || 0, true );
	view.setFloat32( offset + 40, e[ 8 ] || 0, true );

}

function writeMat4( view, offset, value, snapshot ) {

	if ( ! value && snapshot ) return writeSnapshot( view, offset, snapshot );
	const e = value && value.elements || [];
	for ( let i = 0; i < 16; i ++ ) view.setFloat32( offset + i * 4, e[ i ] || 0, true );

}

/**
 * Write a live UniformNode value to a DataView. Dispatches by the value's
 * runtime type. Called for `uniform.live` slots when `_liveNode` is present
 * (in-process flows where the original TSL node instances are alive).
 *
 * @param {DataView} view
 * @param {number} offset
 * @param {any} value - The `UniformNode.value` field.
 * @param {string} [dtype] - Hint from the plan slot ('number','vec2',…,'mat4').
 */
function writeLiveValue( view, offset, value, dtype ) {

	if ( typeof value === 'number' ) { view.setFloat32( offset, value, true ); return; }
	if ( value && value.isColor ) { writeColor( view, offset, value ); return; }
	if ( value && value.isMatrix4 ) { writeMat4( view, offset, value ); return; }
	if ( value && value.isMatrix3 ) { writeMat3( view, offset, value ); return; }
	if ( value && value.isVector4 ) { writeVec4( view, offset, value ); return; }
	if ( value && value.isVector3 ) { writeVec3( view, offset, value ); return; }
	if ( value && value.isVector2 ) { writeVec2( view, offset, value ); return; }
	// Fallback: try dtype hint
	if ( dtype === 'mat4' ) { writeMat4( view, offset, value ); return; }
	if ( dtype === 'mat3' ) { writeMat3( view, offset, value ); return; }
	if ( dtype === 'vec4' ) { writeVec4( view, offset, value ); return; }
	if ( dtype === 'vec3' ) { writeVec3( view, offset, value ); return; }
	if ( dtype === 'vec2' ) { writeVec2( view, offset, value ); return; }
	if ( dtype === 'color' ) { writeColor( view, offset, value ); return; }
	// Scalar fallback
	view.setFloat32( offset, Number( value ) || 0, true );

}


function createStaticObserver() {

	// Always-refresh observer. Returning anything other than `true` here
	// causes three.js's renderer to skip `updateForRender(renderObject)`
	// for that draw — and since multiple renderObjects can share the same
	// node-builder state (cached by cacheKey), the second+ object in a
	// frame would re-use the FIRST object's UBO contents. That's why a
	// scene with 200 sprites of the same material would render every
	// sprite at the first sprite's position.
	//
	// Stock NodeMaterialObserver gates this with a per-render-object
	// equality check; we don't have the bandwidth for that yet, so just
	// always refresh. The cost is one DataView write + one writeBuffer
	// per object per frame, which is what stock three.js does for
	// non-bundled scenes anyway.
	return { needsRefresh() { return true; } };

}
