/**
 * VENDORED from three.js fork branch `tsl-precompile`
 * Source: src/nodes/precompile/extractUniformPlan.js
 * See VENDORING.md for provenance and upgrade policy.
 *
 * Uniform-slot provenance extractor.
 *
 * Walks a compiled `NodeBuilderState` and tags each uniform slot with a
 * serializable `source` descriptor. The precompiled hydrator uses these
 * descriptors to produce per-frame updaters without any `src/nodes/**`
 * classes on the runtime side.
 *
 * Emits plan entries for `UniformsGroup` UBOs (slot-level provenance) AND
 * for sampled-texture / sampler bindings (binding-level provenance). Storage
 * buffers and depth textures are still deferred.
 *
 * @module ExtractUniformPlan
 */

// Vendor note: these symbols live inside three.js under '../accessors/ModelNode.js'
// and '../utils/Timer.js'. The stock three package re-exports them via 'three/tsl'.
// If a future three.js release drops them from 'three/tsl', bump the vendor
// version in VENDORING.md and add a compat shim in _shared/three-compat.js.
import { modelNormalMatrix, modelWorldMatrixInverse, time, deltaTime, frameId, backgroundBlurriness, backgroundIntensity, backgroundRotation, toneMappingExposure, lightPosition, lightTargetPosition, lightViewPosition } from 'three/tsl';

/**
 * Resolve a TSL update node to a `source` descriptor for the uniform slot
 * it drives. Return `null` if the node does not drive a per-slot uniform
 * (e.g. UniformGroupNode stubs that also appear in `updateNodes`).
 *
 * Dispatch is by `constructor.type` — the `is<Foo>Node` flags are not set
 * on most base classes (ReferenceNode, Object3DNode), so relying on them
 * misses the vast majority of update nodes.
 *
 * @param {Object} node - A TSL update node pulled from `state.updateNodes`.
 * @return {?{ uniformNode: Object, source: Object }}
 */
function resolveFromUpdateNode( node ) {

	const type = node.constructor ? node.constructor.type : null;

	// ReferenceNode / MaterialReferenceNode expose the live property on the
	// referenced object. Their internal `node` field is the TSL UniformNode
	// that ends up in the UBO.
	//
	// MaterialReferenceNode always targets the active material. Plain
	// ReferenceNode carries a heterogeneous target — inspect `node.reference`
	// for well-known scene objects (Fog, FogExp2, Scene) so the hydrator
	// reads the right live state:
	//
	//   sceneFog  → 'scene.fog.<prop>'   (scene.fog.color / near / far / density)
	//   scene     → 'scene.<prop>'       (scene.environment, background, ...)
	//   other     → 'reference.<prop>'   (generic; hydrator reads frame.object)
	// UserDataNode — a ReferenceNode subclass whose `updateReference()` binds
	// to `state.object.userData[property]` each draw. Emit a per-draw
	// `object3d.userData` kind so the hydrator/updater reads the live value
	// from `frame.object.userData[property]` at render time instead of
	// freezing the compile-time snapshot (which is always 0 for unset keys).
	if ( type === 'UserDataNode' ) {

		if ( ! node.node ) return null;
		return {
			uniformNode: node.node,
			source: {
				kind: 'object3d.userData',
				property: node.property,
				uniformType: node.uniformType || 'float',
			},
		};

	}

	if ( type === 'ReferenceNode' || type === 'MaterialReferenceNode' ) {

		// Route by target identity. Material + scene + fog references
		// resolve against stable runtime objects (frame.material, frame.scene,
		// frame.scene.fog) that the hydrator walks each frame.
		// ANY other target — LightShadow, Object3D, an app-specific object —
		// falls through to `null` so the slot's fallback path becomes
		// `uniform.live`. That reads the internal UniformNode.value, which
		// the preserved state.updateNodes' ReferenceNode.update() keeps
		// refreshed from the live `this.reference` object.
		let prefix = null;
		if ( type === 'MaterialReferenceNode' ) {

			prefix = 'material';

		} else if ( node.reference && ( node.reference.isFog || node.reference.isFogExp2 ) ) {

			prefix = 'scene.fog';

		} else if ( node.reference && node.reference.isScene ) {

			prefix = 'scene';

		}

		if ( prefix === null ) return null;

		const source = {
			kind: prefix + '.' + node.property,
			property: node.property,
			uniformType: node.uniformType || null
		};

		return node.node ? { uniformNode: node.node, source } : null;

	}

	// Object3DNode / ModelNode — the `scope` selects which object3d metric
	// is written into the embedded UniformNode each frame.
	if ( type === 'Object3DNode' || type === 'ModelNode' ) {

		const prefix = type === 'ModelNode' ? 'object.' : 'object3d.';
		const kind = prefix + ( node.scope || 'unknown' );

		return node.uniformNode ? { uniformNode: node.uniformNode, source: { kind } } : null;

	}

	// Bare UniformNode with onRenderUpdate / onObjectUpdate: the node itself
	// holds the uniform slot. Classify by module-level identity first — these
	// TSL helpers don't set an explicit `.name`, so name-based dispatch can't
	// reach them. Fall back to name dispatch for the named camera uniforms.
	if ( type === 'UniformNode' ) {

		const known = classifyByIdentity( node );
		if ( known ) return { uniformNode: node, source: known };

		return { uniformNode: node, source: classifyByName( node.name ) };

	}

	// ScreenNode — writes viewport / screen-size / DPR uniforms each frame
	// from the live renderer. The internal UniformNode is lazily created by
	// setup() and stored on `node._output`. By the time extractUniformPlan
	// runs the NodeBuilderState is fully compiled, so `_output` is always set.
	// Scopes COORDINATE and UV do not drive a UBO slot (they expand to
	// built-in WGSL expressions), so we return null for them.
	if ( type === 'ScreenNode' ) {

		const scope = node.scope;
		let kind = null;
		if ( scope === 'size' ) kind = 'renderer.size';
		else if ( scope === 'viewport' ) kind = 'renderer.viewport';
		else if ( scope === 'dpr' ) kind = 'renderer.dpr';

		if ( kind === null || ! node._output ) return null;

		return { uniformNode: node._output, source: { kind } };

	}

	return null;

}

/**
 * Match against well-known module-level TSL UniformNode instances (the ones
 * that don't set a descriptive `.name`). Keeps the hydrator dispatch
 * uniform across materials that use these helpers.
 *
 * @param {Object} node
 * @return {?Object}
 */
function classifyByIdentity( node ) {

	if ( node === modelNormalMatrix ) return { kind: 'object.normalMatrix' };
	if ( node === modelWorldMatrixInverse ) return { kind: 'object.worldMatrixInverse' };
	if ( node === time ) return { kind: 'frame.time' };
	if ( node === deltaTime ) return { kind: 'frame.deltaTime' };
	if ( node === frameId ) return { kind: 'frame.frameId' };
	// Scene-state TSL helpers used by Background.js (and any user TSL
	// graph that imports them). These are bare `uniform()` calls with
	// `onRenderUpdate(({scene}) => scene.<prop>)` — the extractor would
	// otherwise classify them as anonymous `uniform.live` and freeze
	// them at extraction-time values, which makes
	// `scene.backgroundBlurriness` ramps invisible at runtime.
	if ( node === backgroundBlurriness ) return { kind: 'scene.backgroundBlurriness', property: 'backgroundBlurriness' };
	if ( node === backgroundIntensity ) return { kind: 'scene.backgroundIntensity', property: 'backgroundIntensity' };
	if ( node === backgroundRotation ) return { kind: 'scene.backgroundRotation', property: 'backgroundRotation' };
	// toneMappingExposure is a bare `uniform()` with onRenderUpdate that reads
	// renderer.toneMappingExposure. Without this identity check the slot falls
	// through to `uniform.live` and freezes at extraction-time — animated
	// exposure ramps never propagate on replay.
	if ( node === toneMappingExposure ) return { kind: 'renderer.toneMappingExposure' };
	return null;

}

/**
 * Map a declared uniform name to a known source kind. Unknown names get
 * a `constant` kind — the hydrator snapshots the current value at
 * extraction time and emits a no-op updater.
 *
 * @param {string} name
 * @return {Object} A source descriptor.
 */
function classifyByName( name ) {

	switch ( name ) {

		case 'cameraProjectionMatrix': return { kind: 'camera.projectionMatrix' };
		case 'cameraProjectionMatrixInverse': return { kind: 'camera.projectionMatrixInverse' };
		case 'cameraViewMatrix': return { kind: 'camera.viewMatrix' };
		case 'cameraWorldMatrix': return { kind: 'camera.worldMatrix' };
		case 'cameraPosition': return { kind: 'camera.position' };
		case 'cameraNear': return { kind: 'camera.near' };
		case 'cameraFar': return { kind: 'camera.far' };
		// Unnamed UniformNode in updateNodes → live-read from its `.value`.
		// The extractor attaches `_liveNode` on the slot; the hydrator's
		// `uniform.live` path picks up whatever onRenderUpdate / onFrameUpdate
		// / LightNode.update() writes to the node. Covers shadow matrices,
		// light positions / directions, and any other dynamically-driven
		// UniformNode that doesn't route through a ReferenceNode.
		default: return { kind: 'uniform.live', name: name || null };

	}

}

/**
 * Serialize a current uniform value so a hydrator running in a different
 * bundle can reconstruct it without introspecting Color / Matrix4 etc.
 *
 * @param {any} value
 * @return {?{ type: string, data: Array<number>|number }}
 */
function snapshotUniformValue( value ) {

	if ( value === null || value === undefined ) return null;

	if ( typeof value === 'number' ) {

		return { type: 'number', data: value };

	}

	if ( value.isColor ) {

		return { type: 'color', data: [ value.r, value.g, value.b ] };

	}

	if ( value.isVector2 ) return { type: 'vec2', data: [ value.x, value.y ] };
	if ( value.isVector3 ) return { type: 'vec3', data: [ value.x, value.y, value.z ] };
	if ( value.isVector4 ) return { type: 'vec4', data: [ value.x, value.y, value.z, value.w ] };

	if ( value.isMatrix3 ) return { type: 'mat3', data: Array.from( value.elements ) };
	if ( value.isMatrix4 ) return { type: 'mat4', data: Array.from( value.elements ) };

	return null;

}

/**
 * Classify an internal `Uniform` (std140 slot inside a UniformsGroup) into
 * a shader-facing dtype the hydrator switches on.
 *
 * @param {Object} uniform
 * @return {string}
 */
function uniformDtype( uniform ) {

	if ( uniform.isNumberUniform ) {

		const type = typeof uniform.getType === 'function' ? uniform.getType() : null;
		if ( type === 'int' || type === 'uint' ) return type;
		return 'number';

	}
	if ( uniform.isVector2Uniform ) return 'vec2';
	if ( uniform.isVector3Uniform ) return 'vec3';
	if ( uniform.isVector4Uniform ) return 'vec4';
	if ( uniform.isColorUniform ) return 'color';
	if ( uniform.isMatrix3Uniform ) return 'mat3';
	if ( uniform.isMatrix4Uniform ) return 'mat4';

	return 'unknown';

}

/**
 * Classify a sampled-texture binding by its texture-type dimensionality.
 *
 * @param {Object} binding
 * @return {string}
 */
function classifyTextureBinding( binding ) {

	if ( binding.isSampledCubeTexture ) return 'cube';
	if ( binding.isSampledArrayTexture ) return '2d-array';
	if ( binding.isSampled3DTexture || binding.isSampledTexture3D ) return '3d';
	if ( binding.isSampledTexture ) return '2d';
	return 'unknown';

}

/**
 * Walk `state.updateNodes` for `AnalyticLightNode` instances and harvest the
 * UniformNodes each one owns. Each entry maps a UniformNode to a `light.<prop>`
 * source descriptor tagged with the light's traversal index (0..N-1) so the
 * runtime hydrator can locate the live `Light` object on `frame.scene` at
 * render time. Without this, three.js's per-light uniforms (color * intensity,
 * cutoff distance, decay exponent, cone/penumbra cosines, view-space position)
 * fall through to the unnamed `uniform.live` path and freeze at extraction-time
 * snapshots — so animated `light.intensity` / `light.position` never propagate.
 *
 * The matching helpers `lightPosition()` / `lightTargetPosition()` /
 * `lightViewPosition()` from `three/tsl` are memoised by the live light
 * instance, so calling them here returns the SAME UniformNode the original
 * setup built — no duplicate uniform allocation.
 *
 * @param {Object} state - A built NodeBuilderState.
 * @return {Map<Object, Object>} UniformNode → light source descriptor.
 */
function collectLightUniformSources( state ) {

	const out = new Map();
	if ( ! state || ! Array.isArray( state.updateNodes ) ) return out;

	let lightIndex = 0;
	for ( const node of state.updateNodes ) {

		if ( ! node || node.isAnalyticLightNode !== true ) continue;
		const light = node.light;
		if ( ! light ) continue;

		const lightUuid = typeof light.uuid === 'string' ? light.uuid : null;
		const base = { lightIndex, lightUuid };

		// `colorNode` is `uniform(this.color)` — `this.color` is the
		// AnalyticLightNode's internal Color that `update()` sets to
		// `light.color * light.intensity`. We want the runtime to compute
		// the same product live, so we tag it as `light.colorScaled` and
		// the hydrator/emit-updater multiply at write time.
		if ( node.colorNode ) {

			out.set( node.colorNode, { kind: 'light.colorScaled', ...base } );

		}
		// PointLight / SpotLight expose cutoffDistance + decay as uniforms.
		if ( node.cutoffDistanceNode ) {

			out.set( node.cutoffDistanceNode, { kind: 'light.distance', property: 'distance', ...base } );

		}
		if ( node.decayExponentNode ) {

			out.set( node.decayExponentNode, { kind: 'light.decay', property: 'decay', ...base } );

		}
		// SpotLight only — `coneCos = cos(angle)`, `penumbraCos = cos(angle*(1-penumbra))`.
		// `update()` writes Math.cos products into these UniformNodes; the runtime
		// recomputes the same product live so animated angle/penumbra propagate.
		if ( node.coneCosNode ) {

			out.set( node.coneCosNode, { kind: 'light.coneCos', ...base } );

		}
		if ( node.penumbraCosNode ) {

			out.set( node.penumbraCosNode, { kind: 'light.penumbraCos', ...base } );

		}

		// Position / target / view-space-position uniforms are NOT owned by
		// the AnalyticLightNode — they live on a WeakMap keyed by light in
		// `three/src/nodes/accessors/Lights.js`. Calling the public TSL
		// helpers re-resolves them from the same WeakMap and returns the
		// already-built UniformNode without allocating a new one. Wrapped
		// in try/catch because not every light pulls in every helper at
		// build-time — calling `lightTargetPosition` for a PointLight (no
		// `.target`) would break onRenderUpdate at write time.
		try {

			if ( typeof lightPosition === 'function' ) {

				const u = lightPosition( light );
				if ( u && u.value ) out.set( u, { kind: 'light.position', ...base } );

			}

		} catch ( _ ) { /* not all lights expose position */ }

		try {

			if ( typeof lightViewPosition === 'function' ) {

				const u = lightViewPosition( light );
				if ( u && u.value ) out.set( u, { kind: 'light.viewPosition', ...base } );

			}

		} catch ( _ ) { /* not all lights expose viewPosition */ }

		try {

			if ( typeof lightTargetPosition === 'function' && light.target ) {

				const u = lightTargetPosition( light );
				if ( u && u.value ) out.set( u, { kind: 'light.targetPosition', ...base } );

			}

		} catch ( _ ) { /* PointLight has no target */ }

		// RectAreaLightNode — view-space half-width / half-height (vec3 each)
		if ( node.halfWidth ) {

			out.set( node.halfWidth, { kind: 'light.halfWidth', ...base } );

		}
		if ( node.halfHeight ) {

			out.set( node.halfHeight, { kind: 'light.halfHeight', ...base } );

		}

		lightIndex ++;

	}

	return out;

}

/**
 * Extract a uniform plan from a built `NodeBuilderState`.
 *
 * @param {NodeBuilderState} state
 * @return {Array<Object>} One entry per bind group, in bind-order. Each
 *   entry has `{ name, shared, visibility, byteLength, slots, textures }`.
 *   Slots are per-uniform (UBO std140), textures are per-binding (sampled-
 *   textures and samplers). Either list can be empty.
 */
export function extractUniformPlan( state ) {

	if ( ! state || ! Array.isArray( state.bindings ) ) return [];

	// Build the light-uniform map FIRST — we want light sources to win over
	// the unnamed `uniform.live` fallback when both apply (a LightNode-owned
	// UniformNode is technically also reachable via `state.updateNodes` as a
	// bare UniformNode, but `resolveFromUpdateNode` returns null for it
	// because we strip the AnalyticLightNode container).
	const lightUniformSources = collectLightUniformSources( state );

	// Walk updateNodes once, build two maps:
	//   - uniformNode → source (UBO slots)
	//   - textureNode → source (SampledTexture / Sampler bindings)
	const uniformNodeToSource = new Map();
	const textureNodeToSource = new Map();

	// Seed the UBO map with every light-owned UniformNode found above.
	for ( const [ uniformNode, source ] of lightUniformSources ) {

		uniformNodeToSource.set( uniformNode, source );

	}

	for ( const node of state.updateNodes || [] ) {

		const entry = resolveFromUpdateNode( node );
		if ( ! entry || ! entry.uniformNode ) continue;

		// Don't overwrite a pre-seeded light source — bare UniformNode
		// classification returns `uniform.live` for unnamed uniforms, which
		// would clobber the precise `light.<prop>` mapping we just built.
		if ( lightUniformSources.has( entry.uniformNode ) ) continue;

		// MaterialReferenceNode with uniformType 'texture' binds its `node`
		// to a TextureNode rather than a plain UniformNode. Route it into
		// the texture map instead of the UBO map.
		const nodeType = entry.uniformNode.constructor && entry.uniformNode.constructor.type;
		if ( nodeType === 'TextureNode' || nodeType === 'CubeTextureNode' ) {

			textureNodeToSource.set( entry.uniformNode, entry.source );

		} else {

			uniformNodeToSource.set( entry.uniformNode, entry.source );

		}

	}

	// Second pass: for each textured material.<prop>, if the TextureNode has
	// lazily allocated a UV matrix uniform, tag that matrix slot so the
	// hydrator can push live `material.<prop>.matrix` every frame.
	for ( const [ textureNode, source ] of textureNodeToSource ) {

		if ( textureNode._matrixUniform && source.kind && source.kind.startsWith( 'material.' ) ) {

			uniformNodeToSource.set( textureNode._matrixUniform, {
				kind: source.kind + '.matrix',
				property: source.property,
				uniformType: 'mat3'
			} );

		}

	}

	const plan = [];

	for ( const bindGroup of state.bindings ) {

		// Treat the first binding's groupNode as representative for the
		// group's shared-ness and visibility. This matches how the
		// existing backends set these flags.
		const firstBinding = bindGroup.bindings[ 0 ];
		const shared = firstBinding && firstBinding.groupNode ? firstBinding.groupNode.shared === true : false;
		const visibility = firstBinding ? ( firstBinding.visibility | 0 ) : 0;

		const groupEntry = {
			name: bindGroup.name || '',
			shared,
			visibility,
			byteLength: 0,
			// Flat per-type convenience lists — filled in below. Backward-
			// compatible with earlier plan consumers.
			slots: [],
			textures: [],
			storageBuffers: [],
			// Ordered list: each entry is one WGSL binding slot, in the
			// exact order the builder emitted. The hydrator walks THIS list
			// to preserve binding indices — without this the UBO could
			// collide with a storage buffer at @binding(0), producing
			// BufferBindingType mismatches at pipeline creation.
			orderedBindings: []
		};

		for ( const binding of bindGroup.bindings ) {

			if ( binding.isUniformsGroup ) {

				// Reading byteLength on UniformsGroup also materializes each
				// uniform's `offset` / `index`, so we must read it before we
				// iterate the slot list.
				const byteLength = binding.byteLength;
				if ( byteLength > groupEntry.byteLength ) groupEntry.byteLength = byteLength;

				const uboSlots = [];
				for ( const uniform of binding.uniforms ) {

					const dtype = uniformDtype( uniform );
					const tslUniformNode = uniform.nodeUniform ? uniform.nodeUniform.node : null;
					let source = tslUniformNode ? uniformNodeToSource.get( tslUniformNode ) : null;

					if ( ! source ) {

						// Fall back to a live read on the UniformNode's
						// `.value` each frame. `state.updateNodes` is
						// preserved side-car on the artifact so LightNode
						// / ShadowNode update() closures keep refreshing
						// those values — see hydrateArtifact.
						//
						// Serialisable snapshot kept too, so in offline
						// / cross-process flows the compile-time value is
						// at least correct as a fallback.
						source = tslUniformNode ?
							{ kind: 'uniform.live', valueSnapshot: snapshotUniformValue( uniform.getValue() ) } :
							{ kind: 'constant', valueSnapshot: snapshotUniformValue( uniform.getValue() ) };

					} else if ( source.valueSnapshot === undefined ) {

						// `uniformNodeToSource` sources come from
						// `resolveFromUpdateNode` and describe how to
						// live-read the value at runtime (material.color,
						// scene.fog.density, …). Decorate them with the
						// compile-time snapshot too so out-of-process
						// hydrators that can't evaluate the live update
						// closure still have the baked fallback —
						// critical for light directions / positions
						// written by LightNode.update().
						const snap = snapshotUniformValue( uniform.getValue() );
						if ( snap ) source = { ...source, valueSnapshot: snap };

					}

					const slot = {
						name: uniform.name || '',
						offset: uniform.offset * 4, // float-index → byte offset
						size: uniform.itemSize * 4, // float-count → byte count
						dtype,
						source
					};
					// Side-car to support `uniform.live` reads. Non-enumerable
					// so JSON.stringify skips it.
					if ( tslUniformNode ) {

						Object.defineProperty( slot, '_liveNode', { value: tslUniformNode, enumerable: false, writable: true } );

					}

					groupEntry.slots.push( slot );
					uboSlots.push( slot );

				}

				groupEntry.orderedBindings.push( {
					type: 'ubo',
					name: binding.name || '',
					byteLength,
					visibility: binding.visibility | 0,
					slots: uboSlots
				} );

				continue;

			}

			if ( binding.isSampledTexture || binding.isSampler ) {

				const textureNode = binding.textureNode || null;
				let source = textureNode ? textureNodeToSource.get( textureNode ) : null;

				// If we failed to resolve a source via updateNodes, try a few
				// fallbacks in order:
				//
				//   1. Well-known built-ins (DFG LUT for IBL) — identifiable
				//      by Texture.name. The slim runtime reconstructs these
				//      from shared data modules, no compile step needed.
				//
				//   2. Generic artifact-level textures — keyed by uuid and
				//      carried on `artifact._textureRefs`. Non-serialisable,
				//      but fine for single-process compile+hydrate flows.
				if ( ! source && textureNode ) {

					const tex = textureNode.value || ( textureNode._value ) || null;
					if ( tex && tex.isTexture ) {

						if ( tex.name === 'DFG_LUT' ) {

							source = { kind: 'builtin.dfgLUT' };

						} else {

							source = {
								kind: 'artifact.texture',
								textureUuid: tex.uuid
							};

							// Stable identifiers that survive a fresh Texture
							// instance on replay (same image.src, same name).
							// Production uses UUID match; harness/test paths
							// use these to relink a freshly-loaded texture.
							const ident = textureIdentity( tex );
							if ( ident ) Object.assign( source, ident );

							const snapshot = snapshotTexture( tex );
							if ( snapshot ) source.snapshot = snapshot;

						}


// Stable identifying info that survives a fresh Texture instance on replay.
// Used to relink a captured artifact.texture binding (whose textureUuid is
// dead after the example reloads) back to a freshly-loaded live texture.
function textureIdentity( texture ) {

	if ( ! texture ) return null;
	const out = {};
	const image = texture.image || null;

	// HTMLImageElement / HTMLVideoElement loaded via *Loader: image.src is
	// the loader URL. ImageBitmap exposes the source URL through its
	// underlying option in some loaders; we grab .src as a best-effort.
	const src = image && ( image.src || image.currentSrc || null );
	if ( typeof src === 'string' && src.length > 0 ) out.imageSrc = src;

	// CubeTexture / DataArrayTexture: image is an array of faces. Capture
	// the first face's src so cubemaps can be reattached too.
	if ( Array.isArray( image ) && image.length > 0 ) {

		const first = image[ 0 ];
		const firstSrc = first && ( first.src || first.currentSrc || null );
		if ( typeof firstSrc === 'string' && firstSrc.length > 0 ) out.imageSrc = firstSrc;

	}

	if ( typeof texture.name === 'string' && texture.name.length > 0 ) out.textureName = texture.name;
	if ( typeof texture.mapping === 'number' ) out.mapping = texture.mapping;
	// Capture flipY so the replay texture matches the original orientation.
	// HTMLImageElement textures loaded by TextureLoader default to flipY=true;
	// RenderTarget / DataTexture textures typically default to flipY=false.
	// Without capturing this, replay may reconstruct a texture with the wrong
	// Y-axis orientation and sprites appear flipped vs capture.
	if ( typeof texture.flipY === 'boolean' ) out.flipY = texture.flipY;

	return Object.keys( out ).length > 0 ? out : null;

}

function snapshotTexture( texture ) {

	const image = texture && texture.image;
	if ( ! image ) return null;

	const colorSpace = texture.colorSpace || '';
	const format = texture.format || null;
	const type = texture.type || null;
	const sampler = {
		mapping: texture.mapping,
		wrapS: texture.wrapS,
		wrapT: texture.wrapT,
		magFilter: texture.magFilter,
		minFilter: texture.minFilter,
		flipY: texture.flipY,
	};

	if ( image.data && ArrayBuffer.isView( image.data ) && image.width && image.height ) {

		const data = image.data;
		if ( image.width * image.height > 262144 ) return null;
		return {
			width: image.width,
			height: image.height,
			arrayType: data.constructor && data.constructor.name || 'Uint8Array',
			data: Array.from( data ),
			format,
			type,
			colorSpace,
			...sampler,
		};

	}

	if ( typeof image.getContext === 'function' && image.width && image.height ) {

		if ( image.width * image.height > 262144 ) return null;
		try {

			const ctx = image.getContext( '2d' );
			if ( ! ctx || typeof ctx.getImageData !== 'function' ) return null;
			const imageData = ctx.getImageData( 0, 0, image.width, image.height );
			return {
				width: image.width,
				height: image.height,
				arrayType: 'Uint8Array',
				data: Array.from( imageData.data ),
				format,
				type,
				colorSpace,
				...sampler,
			};

		} catch ( _ ) {

			return null;

		}

	}

	return null;

}
					}

				}

				const texEntry = {
					bindingKind: binding.isSampledTexture ? 'sampled-texture' : 'sampler',
					name: binding.name || '',
					textureType: classifyTextureBinding( binding ),
					access: binding.access || null,
					visibility: binding.visibility | 0,
					source: source || { kind: 'unsupported' }
				};
				groupEntry.textures.push( texEntry );
				groupEntry.orderedBindings.push( {
					type: binding.isSampledTexture ? 'sampled-texture' : 'sampler',
					ref: texEntry
				} );

			}

			// Storage buffers — backing data for compute shaders. Capture the
			// attribute's typed array, length, and access so the hydrator
			// can reconstruct an equivalent StorageBufferAttribute without
			// running the builder. The actual array bytes ride along in-
			// process; downstream serialisers can discard and re-seed if
			// they know the init kernel runs first at runtime.
			// Standalone uniform buffers (NodeUniformBuffer) — a single
			// named BufferNode mapped to a whole UBO, distinct from the
			// multi-uniform `UniformsGroup` path. FXAA + DoF + several
			// post-process shaders use these.
			if ( binding.isNodeUniformBuffer || ( binding.isUniformBuffer && ! binding.isUniformsGroup ) ) {

				const nodeUniform = binding.nodeUniform || null;
				const array = nodeUniform && nodeUniform.value && nodeUniform.value.buffer ? nodeUniform.value : null;
				const ubEntry = {
					name: binding.name || '',
					byteLength: array ? array.byteLength : ( binding.byteLength | 0 ),
					arrayType: array ? array.constructor.name : 'Float32Array',
					visibility: binding.visibility | 0
				};
				// Side-car live reference — the in-process hydrator shares
				// the same Float32Array, so any update-path that writes
				// into it (user code, a nodeUniform.update closure)
				// shows up on the GPU without extra wiring.
				if ( array ) {

					Object.defineProperty( ubEntry, '_liveArray', { value: array, enumerable: false, writable: true } );

					// Serialisable snapshot of the array contents so an
					// out-of-process hydrator (JSON-loaded artifact) can
					// seed the UBO with the same values. Typed arrays
					// round-trip as plain Arrays through JSON, which the
					// hydrator handles.
					ubEntry.valueSnapshot = Array.from( array );

				}

				if ( nodeUniform ) {

					Object.defineProperty( ubEntry, '_liveNode', { value: nodeUniform, enumerable: false, writable: true } );

				}

				groupEntry.orderedBindings.push( { type: 'buffer-uniform', ref: ubEntry } );

				continue;

			}

			if ( binding.isStorageBuffer ) {

				const attr = binding.attribute || null;
				const array = attr && attr.array ? attr.array : null;
				const arrayType = array ? array.constructor.name : 'Float32Array';

				const sbEntry = {
					name: binding.name || '',
					access: binding.access || 'read_write',
					// Visibility is a GPUShaderStage bitmask. The backend
					// reads it when building the BindGroupLayout — if we
					// don't propagate it the compute pipeline fails with
					// "entry-point's stage is not in the binding visibility
					// (ShaderStage::None)".
					visibility: binding.visibility | 0,
					arrayType,
					// Capture count + itemSize instead of full array for
					// hydrators that seed via an init kernel. Keep a live
					// reference on the plan for the in-process path so the
					// demo flow doesn't need separate serialisation.
					count: attr && typeof attr.count === 'number' ? attr.count : ( array ? array.length : 0 ),
					itemSize: attr && typeof attr.itemSize === 'number' ? attr.itemSize : 1,
					_liveArray: array,
					_liveAttribute: attr
				};
				groupEntry.storageBuffers.push( sbEntry );
				groupEntry.orderedBindings.push( { type: 'storage-buffer', ref: sbEntry } );

				continue;

			}

			// Unrecognised binding type. Record a placeholder entry so the
			// hydrator preserves the binding-index and the WGSL layout
			// validation in the backend doesn't choke. The placeholder
			// carries the `is*` flags so future hydrator work can
			// materialise the right binding kind.
			const flags = [];
			for ( const k of Object.keys( binding ) ) {

				if ( typeof binding[ k ] === 'boolean' && binding[ k ] && k.startsWith( 'is' ) ) flags.push( k );

			}

			groupEntry.orderedBindings.push( {
				type: 'unknown',
				name: binding.name || '',
				flags,
				visibility: binding.visibility | 0
			} );

		}

		plan.push( groupEntry );

	}

	return plan;

}
