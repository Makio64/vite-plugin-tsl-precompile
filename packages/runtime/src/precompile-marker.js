/**
 * `material.precompile(name)` — the only author-facing API.
 *
 * Dev-mode behaviour:
 *   - Borrows the active WebGPURenderer (registered via `setDevRenderer`)
 *     and runs the extractor on this material against a synthetic minimal
 *     scene.
 *   - POSTs the artifact JSON to the dev-capture endpoint.
 *   - Returns the material itself (chainable).
 *   - If the dev endpoint is unreachable, logs once and becomes a no-op for
 *     the rest of the session (so prod-like non-plugin runs still work).
 *
 * Prod-mode behaviour:
 *   - The Vite/Babel transform replaces `.precompile(name)` call sites with
 *     `__applyPrecompiled(material, import('virtual:tsl-precompile/<name>'), '<hash>')`
 *     at build time. This marker method is then never called.
 *
 * If the marker IS called in a prod build (user mounted the runtime without
 * the plugin), it logs a clear warning and no-ops — the full three.js node
 * builder handles rendering, slightly defeating the point but never breaking
 * the app.
 *
 * @module PrecompileMarker
 */

import { MARKER_METHOD_NAME } from './_constants.js';
import { normalizeRevision } from './_normalize-revision.js';
import { hashMaterialSync } from './graph-hash.js';
import { registerArtifact } from './artifact-loader.js';
import { MATERIAL_NODE_TEXTURE_KEYS } from '@tsl-precompile/contract/texture-props';

let installed = false;
let devEndpoint = null;
let devEndpointDead = false;
let threeModule = null;
let devRenderer = null;
let extractor = null;
// `hasher` was a dynamic import of plugin/hash.js; replaced by direct
// `hashMaterialSync` import above (node:crypto-free, browser-safe).
let codegen = null;   // emitUpdaterSource — used to check for unknown kinds at capture time.

// Last ArrayCamera seen in a devRenderer.render() call. Used to auto-detect
// ArrayCamera captures: when the user renders with an ArrayCamera the
// synthetic capture scene must also use one, otherwise three.js's Camera.js
// nodes emit the scalar `cameraViewMatrix` uniform path instead of the
// per-element `cameraViewMatrices[cameraIndex]` path.
let lastSeenArrayCamera = null;

const inflight = new Set();   // names currently being captured (suppresses dup POSTs)
const sessionDone = new Set();   // names captured this session (suppresses needless re-POST)

const LIGHT_NODE_GRAPH_PROPS = [
	'colorNode',
];

function objectSourceMetadata( object ) {

	if ( ! object ) return null;
	return {
		type: object.type || object.constructor && object.constructor.name || null,
		renderOrder: Number.isFinite( object.renderOrder ) ? object.renderOrder : 0,
		castShadow: object.castShadow === true,
		receiveShadow: object.receiveShadow === true,
		isInstancedMesh: object.isInstancedMesh === true,
		isSkinnedMesh: object.isSkinnedMesh === true,
		position: object.position ? [ object.position.x, object.position.y, object.position.z ] : null,
		scale: object.scale ? [ object.scale.x, object.scale.y, object.scale.z ] : null,
	};

}

function materialSourceMetadata( material, sourceObject = null ) {

	const nodeProps = [];
	if ( material ) {

		for ( const key of MATERIAL_NODE_TEXTURE_KEYS ) {

			const value = material[ key ];
			if ( value && value.isNode === true ) nodeProps.push( key );

		}

	}
	return {
		type: material && typeof material.type === 'string' ? material.type : null,
		nodeProps,
		object: objectSourceMetadata( sourceObject ),
	};

}

/**
 * Install `.precompile(name)` on the three.js Material prototype. Safe to call
 * multiple times; subsequent calls update the dev endpoint.
 *
 * @param {Object} three - A `three` or `three/webgpu` module, providing `Material`.
 * @param {Object} [opts]
 * @param {?string} [opts.devEndpoint] - e.g. 'http://localhost:5173/__tsl-precompile/capture'.
 * @param {?Function} [opts.extractor] - `(renderer, scene, camera, options) => Promise<artifacts>`.
 *   Defaults to a dynamic import of `vite-plugin-tsl-precompile/src/vendor/compileTSL.js`.
 */
export function installPrecompileMarker( three, opts = {} ) {

	threeModule = three;
	devEndpoint = opts.devEndpoint || null;
	devEndpointDead = false;
	extractor = opts.extractor || null;

	if ( installed ) return;
	installed = true;

	const Material = three.Material;
	if ( ! Material || ! Material.prototype ) {

		throw new Error( '[tsl-precompile] installPrecompileMarker requires the three.Material class on the passed module.' );

	}

	if ( typeof Material.prototype[ MARKER_METHOD_NAME ] === 'function' ) return; // already installed (e.g. duplicate bundle)

	// PassNode.setMRT hook: `pass(scene, cam).setMRT(mrtNode)` (the dominant
	// MRT pattern in three.js examples) doesn't write `material.mrtNode` until
	// the pass actually renders — too late for our synthetic warm-up. Stamp
	// the descriptor on `passNode.scene.userData.__tslp_mrtNode` so the marker
	// (and aux-marker, and compileTSL) can find it during capture.
	const PassNode = three.PassNode;
	if ( PassNode && PassNode.prototype && ! PassNode.prototype.__tslpSetMRTHooked ) {

		const _origSetMRT = PassNode.prototype.setMRT;
		PassNode.prototype.setMRT = function ( mrtNode ) {

			const ret = _origSetMRT.call( this, mrtNode );
			if ( this.scene && mrtNode ) {

				this.scene.userData = this.scene.userData || {};
				this.scene.userData.__tslp_mrtNode = mrtNode;

			}
			return ret;

		};
		PassNode.prototype.__tslpSetMRTHooked = true;

	}

	Material.prototype[ MARKER_METHOD_NAME ] = function precompile( name ) {

		if ( typeof name !== 'string' || name.length === 0 ) {

			throw new TypeError( `[tsl-precompile] material.precompile(name): "name" must be a non-empty string; got ${ typeof name }` );

		}

		// Prod fallback path — transform should have replaced this call.
		if ( typeof window === 'undefined' || ! devEndpoint ) {

			logOnce( 'no-endpoint:' + name, () => console.warn( `[tsl-precompile] .precompile(${ JSON.stringify( name ) }) was called but no dev endpoint is configured. If this is production, the Babel transform did not run — check your Vite config.` ) );
			return this;

		}

		if ( devEndpointDead ) return this;
		if ( sessionDone.has( name ) || inflight.has( name ) ) return this;

		inflight.add( name );
		if ( typeof window !== 'undefined' ) window.__tslpPrecompilePending = ( window.__tslpPrecompilePending | 0 ) + 1;
		// Defer to microtask so the user's first render isn't blocked on the
		// extractor — the marker must always return synchronously.
		Promise.resolve().then( () => captureMaterialInDev( this, name ) ).finally( () => {

			inflight.delete( name );
			if ( typeof window !== 'undefined' ) window.__tslpPrecompilePending = Math.max( 0, ( window.__tslpPrecompilePending | 0 ) - 1 );

		} );

		return this;

	};

}

/**
 * Register the active WebGPURenderer so the marker can borrow it for
 * extraction. Call once after `renderer.init()`. The marker no-ops until
 * this is called.
 *
 * Side-effect: if the renderer carries a `three/addons/inspector/Inspector.js`
 * instance and `@tsl-precompile/inspector-panel` is installed, auto-register
 * the precompile panel. Zero-setup for the common case; users who prefer
 * explicit control can import `attachToInspector` directly.
 *
 * @param {Object} renderer
 */
export function setDevRenderer( renderer ) {

	devRenderer = renderer || null;
	if ( renderer && renderer.inspector ) autoAttachInspectorPanel( renderer.inspector );

	// Intercept renderer.render() to track when an ArrayCamera is in use.
	// This lets the synthetic capture scene mirror the array-camera shader
	// path without requiring the harness to explicitly tag each material.
	// We only wrap once per renderer instance (guard via __tslpRenderWrapped).
	if ( renderer && typeof renderer.render === 'function' && ! renderer.__tslpRenderWrapped ) {

		renderer.__tslpRenderWrapped = true;
		const _originalRender = renderer.render.bind( renderer );
		renderer.render = function ( scene, camera, ...rest ) {

			if ( camera && camera.isArrayCamera && camera.cameras && camera.cameras.length > 0 ) {

				lastSeenArrayCamera = camera;

			}
			return _originalRender( scene, camera, ...rest );

		};

	}

}

let _inspectorAttachTried = false;
async function autoAttachInspectorPanel( inspector ) {

	if ( _inspectorAttachTried ) return;
	_inspectorAttachTried = true;
	if ( inspector.__tslPrecompilePanel ) return; // already attached
	try {

		// The specifier is held in a variable so Vite's import-analysis does
		// not statically try to resolve it at dev-server boot. The panel is
		// optional; consumers without it just hit the catch below at runtime.
		const inspectorPanelSpecifier = '@tsl-precompile/inspector-panel';
		const mod = await import( /* @vite-ignore */ inspectorPanelSpecifier );
		if ( typeof mod.attachToInspector === 'function' ) mod.attachToInspector( inspector );

	} catch ( err ) {

		// Not installed. That's fine — the panel is optional. Log once so
		// users who WANTED auto-register see a hint; nobody else is spammed.
		logOnce( 'no-inspector-panel', () => console.info( '[tsl-precompile] `@tsl-precompile/inspector-panel` is not installed; skipping auto-attach. (Install it to see live captures in the three.js Inspector.)' ) );

	}

}

/**
 * Drop the dev-renderer reference. Useful when the user replaces the renderer
 * mid-session.
 */
export function clearDevRenderer() {

	devRenderer = null;

}

async function captureMaterialInDev( material, name ) {

	try {

		if ( ! devRenderer ) {

			logOnce( 'no-renderer:' + name, () => console.warn( `[tsl-precompile] .precompile(${ JSON.stringify( name ) }): no dev renderer registered. Call setDevRenderer(renderer) once after renderer.init() so the marker can borrow it for extraction.` ) );
			return;

		}

		if ( ! extractor ) {

			const mod = await import( /* @vite-ignore */ 'vite-plugin-tsl-precompile/src/vendor/compileTSL.js' );
			extractor = mod.compileTSL;

		}

		if ( ! codegen ) {

			const mod = await import( /* @vite-ignore */ 'vite-plugin-tsl-precompile/src/emit-updater.js' );
			codegen = mod.emitUpdaterSource;

		}

		// Build a minimal synthetic scene that drives this single material.
		// Scene-driven capture can attach a source object so custom update nodes
		// that read `frame.object` fields see the same shape they saw in the app.
		const { Scene, Mesh, BoxGeometry, PerspectiveCamera, Color, ClippingGroup, REVISION } = threeModule;
		const scene = new Scene();
		scene.userData = scene.userData || {};
		scene.userData.__tslpSyntheticCaptureScene = true;

		// Determine the capture camera. Priority order:
		//   1. material.__tslpArrayCamera — explicit hint set by user or harness
		//   2. lastSeenArrayCamera — auto-detected from the last devRenderer.render() call
		//   3. Fallback: plain PerspectiveCamera (pre-existing behaviour)
		//
		// Using an ArrayCamera with at least one sub-camera causes three.js's
		// Camera.js TSL nodes to emit the `cameraViewMatrices[cameraIndex]`
		// array-uniform path instead of the scalar `cameraViewMatrix` path.
		// Without this, all 36 cells of webgpu_camera_array render the same
		// view because the precompiled WGSL bakes the scalar path.
		let sourceArrayCamera = null;
		if ( Object.prototype.hasOwnProperty.call( material, '__tslpArrayCamera' ) ) {

			if ( material.__tslpArrayCamera && material.__tslpArrayCamera.isArrayCamera ) {

				sourceArrayCamera = material.__tslpArrayCamera;

			}

		} else if ( lastSeenArrayCamera ) {

			sourceArrayCamera = lastSeenArrayCamera;

		}

		let camera;
		const sourceCamera = material.__tslpPrecompileCamera || null;
		if ( sourceArrayCamera ) {

			// Clone the ArrayCamera shell so we don't mutate the live camera, but
			// re-use the same sub-camera array (read-only during extraction).
			const ArrayCamera = sourceArrayCamera.constructor;
			camera = new ArrayCamera( sourceArrayCamera.cameras );
			camera.position.copy( sourceArrayCamera.position );
			camera.quaternion.copy( sourceArrayCamera.quaternion );
			camera.updateMatrixWorld( true );

		} else if ( sourceCamera && typeof sourceCamera.clone === 'function' && ( sourceCamera.isPerspectiveCamera === true || sourceCamera.isOrthographicCamera === true ) ) {

			camera = sourceCamera.clone();
			if ( typeof camera.updateProjectionMatrix === 'function' ) camera.updateProjectionMatrix();
			camera.updateMatrixWorld( true );

		} else {

			camera = new PerspectiveCamera( 45, 1, 0.1, 100 );
			camera.position.set( 0, 0, 3 );
			camera.lookAt( 0, 0, 0 );

		}
		const sourceObject = material.__tslpPrecompileObject || null;

		// Inherit scene-level state that drives PBR shader binding
		// generation. Without this, MeshStandard/MeshPhysical materials
		// extract WITHOUT the envMap (IBL) binding even when the user's
		// scene has `scene.environment` set — three.js's NodeBuilder reads
		// these off the active scene at compile time. We copy the scalar
		// scene-level fields (environment, fog, background); we do NOT
		// reparent lights, since `Object3D.add()` would detach them from
		// the user's actual scene and break their real render pass.
		const sourceScene = material.__tslpPrecompileScene || findParentScene( sourceObject );
		if ( sourceScene ) {

			scene.environment = sourceScene.environment || null;
			scene.environmentIntensity = sourceScene.environmentIntensity != null ? sourceScene.environmentIntensity : 1;
			scene.environmentRotation = sourceScene.environmentRotation || scene.environmentRotation;
			scene.background = sourceScene.background || null;
			scene.backgroundIntensity = sourceScene.backgroundIntensity != null ? sourceScene.backgroundIntensity : 1;
			scene.backgroundBlurriness = sourceScene.backgroundBlurriness || 0;
			scene.backgroundRotation = sourceScene.backgroundRotation || scene.backgroundRotation;
			scene.fog = sourceScene.fog || null;
			// Node-graph forms of fog/environment/background — TSL fog like
			// `scene.fogNode = fog(color(0x0000ff), rangeFogFactor(...))`
			// drives per-fragment color mixing at extraction time, and the
			// captured WGSL bakes it in. Without this copy, sprites fade
			// out / blue-shift in capture but render flat in replay.
			if ( sourceScene.fogNode ) scene.fogNode = sourceScene.fogNode;
			if ( sourceScene.environmentNode ) scene.environmentNode = sourceScene.environmentNode;
			if ( sourceScene.backgroundNode ) scene.backgroundNode = sourceScene.backgroundNode;

			// Clone (don't reparent) the user's lights into the throwaway
			// scene. Without this, `LightsNode` sees zero lights at
			// extraction time and emits a no-light shader path, so PBR
			// materials capture WITHOUT per-light uniform bindings — the
			// resulting shader can never light the surface at replay.
			// `Object3D.add()` would detach the original lights from the
			// user's real render pass, so we deep-clone instead.
			cloneLightsInto( sourceScene, scene );

		}

		const mesh = new Mesh( sourceObject && sourceObject.geometry || new BoxGeometry( 1, 1, 1 ), material );
		if ( sourceObject ) {

			for ( const key of Object.keys( sourceObject ) ) {

				if ( key === 'material' || key === 'geometry' || key === 'parent' || key === 'children' ) continue;
				// `boundingSphere` and `boundingBox` are subclass-coupled to a
				// `computeBoundingSphere`/`computeBoundingBox` method that lives
				// on the source object's class (e.g. InstancedMesh, BatchedMesh,
				// SkinnedMesh). Copying the field onto a plain `Mesh` makes
				// `Frustum.intersectsObject` think the object owns these caches
				// and call the missing `mesh.computeBoundingSphere()`, which
				// throws during `compileAsync` projection. Skip them — frustum
				// culling on the throwaway scene is meaningless anyway.
				if ( key === 'boundingSphere' || key === 'boundingBox' ) continue;
				if ( key in mesh && key !== 'color' ) continue;
				mesh[ key ] = sourceObject[ key ];

			}

			// A plain Mesh starts with count=1, so the generic property-copy loop
			// above intentionally skips the InstancedMesh count that Three's
			// MorphNode uses to select the per-instance morph texture path.
			// Preserve it explicitly for synthetic capture so instanced morph demos
			// compile the same shader branch as the live object.
			if ( sourceObject.isInstancedMesh === true && sourceObject.count > 1 ) mesh.count = sourceObject.count;

		}
		// Force-disable frustum culling on the throwaway mesh. Even after the
		// `boundingSphere` skip above, the source object may still have other
		// subclass-specific cull paths (e.g. `intersectsSprite`); the throwaway
		// camera is a placeholder so culling decisions here are meaningless.
		mesh.frustumCulled = false;
		// Propagate shadow flags. The `for...in Object.keys(sourceObject)` loop
		// above SKIPS `receiveShadow` / `castShadow` because they're inherited
		// `Object3D` defaults (so `key in mesh` returns true). Without this,
		// three.js's NodeBuilder compiles materials WITHOUT shadow sampling,
		// so the captured WGSL has no `getShadow()` call and replay shadows
		// can never appear regardless of runtime depth-texture wiring.
		if ( sourceObject ) {

			if ( sourceObject.receiveShadow ) mesh.receiveShadow = true;
			if ( sourceObject.castShadow ) mesh.castShadow = true;

		}
		if ( mesh.color === undefined && Color ) mesh.color = sourceObject && sourceObject.color || material.color || new Color( 1, 1, 1 );

		// ClippingGroup ancestry — when the source mesh is descended from one
		// or more ClippingGroups, three.js's renderer walks that chain at
		// render time to build a per-renderObject ClippingContext, which
		// `NodeMaterial.setupClipping(builder)` then turns into ClippingNode
		// WGSL (`discard()` for default scope, `discard()` + alpha-modulation
		// for `alphaToCoverage:true`). The throwaway scene must mirror that
		// ancestry or the extractor sees `builder.clippingContext === null`,
		// `setupClipping()` returns early, and the captured shader has no
		// clipping logic. Without this, replay can't render examples that
		// rely on `ClippingGroup` (`webgpu_clipping.html`) — the slim runtime
		// has no `Fn(...)`-based ClippingNode to fall back on.
		//
		// Clone the groups (don't reparent — the live groups are still in the
		// user's scene). Order outermost → innermost to preserve parent
		// chaining, matching how `ClippingContext.getGroupContext()` composes
		// nested contexts.
		const clipMountPoint = mountClippingGroupsInto( ClippingGroup, sourceObject, scene );
		clipMountPoint.add( mesh );

		// MRT propagation — the pass/global MRT defines the render-target
		// attachment layout, while `material.mrtNode` can override individual
		// outputs inside that layout. Prefer the pass/global descriptor when it
		// exists so NodeMaterial.setup() can perform the same
		// `rendererMRT.merge(materialMRT)` step it performs during live render.
		// Fall back to a pure material-level MRT when there is no surrounding
		// pass/global MRT.
		//
		// Heuristic: skip the renderer-scope fallback for fullscreen quad
		// meshes (post-process pipelines) — those render to the canvas, not
		// to the user's multi-target RT, so forcing MRT there would emit an
		// empty `OutputType { }` struct and crash WGSL.
		const materialMRTNode = material && material.mrtNode || null;
		let mrtNode = null;
		const isFullscreenQuad = sourceObject && ( sourceObject.isQuadMesh || sourceObject.constructor && sourceObject.constructor.name === 'QuadMesh' );
		// PassNode-driven MRT (`pass(scene, cam).setMRT(...)`): aux-marker
		// stamps the descriptor on `scene.userData.__tslp_mrtNode` because the
		// PassNode only writes `material.mrtNode` during a live render — after
		// our synthetic warm-up runs.
		if ( ! isFullscreenQuad && sourceScene && sourceScene.userData && sourceScene.userData.__tslp_mrtNode ) {

			mrtNode = sourceScene.userData.__tslp_mrtNode;

		}
		if ( ! mrtNode && ! isFullscreenQuad && typeof devRenderer.getMRT === 'function' ) {

			mrtNode = devRenderer.getMRT();

		}
		if ( ! mrtNode ) mrtNode = materialMRTNode;
		let extractorOpts = undefined;
		if ( mrtNode ) {

			extractorOpts = { mrtNode };
			const mrtOutputs = mrtNode.nodes || mrtNode.outputNodes || null;
			if ( mrtOutputs && Object.keys( mrtOutputs ).length > 1 ) extractorOpts.skipWarmupRender = true;

		}

		const artifacts = await extractor( devRenderer, scene, camera, extractorOpts );

		let artifact = artifacts.byMaterialUuid && artifacts.byMaterialUuid.get( material.uuid );
		if ( ! artifact ) {

			for ( const a of artifacts ) {

				if ( a.materialUuid === material.uuid ) { artifact = a; break; }

			}

		}

		if ( ! artifact ) {

			console.error( `[tsl-precompile] .precompile(${ JSON.stringify( name ) }): extraction returned no artifact for material uuid=${ material.uuid }. The material may not have produced a NodeBuilderState.` );
			return;

		}

		// Tier C — variant-keyed artifact family.
		//
		// `extractor` walks the renderer's `nodeBuilderCache` and emits one
		// artifact per cacheKey. A single user material can produce multiple
		// cacheKey entries when its render state varies (clipping context,
		// MRT layout, blending, multiview, shadow signatures, …). Today we
		// only carry the "preferred" artifact through, which means scenes
		// whose live `renderObject.cacheKey` doesn't match the captured one
		// render with the wrong WGSL. Attach all variants on the preferred
		// artifact so the runtime can pick the right one per render.
		const variantList = artifacts.byMaterialVariants && artifacts.byMaterialVariants.get( material.uuid );
		if ( Array.isArray( variantList ) && variantList.length > 1 ) {

			const variants = {};
			for ( const v of variantList ) {

				if ( ! v || v.cacheKey === undefined || v.cacheKey === null ) continue;
				// Lightweight per-variant payload — only the fields the
				// hydrator actually needs to swap. Top-level artifact carries
				// everything else (textureRefs, mrtOutputCount, captureClock).
				variants[ String( v.cacheKey ) ] = {
					cacheKey: v.cacheKey,
					vertexShader: v.vertexShader,
					fragmentShader: v.fragmentShader,
					computeShader: v.computeShader,
					transforms: v.transforms,
					attributes: v.attributes,
					nodeAttributes: v.nodeAttributes,
					bindings: v.bindings,
					uniformPlan: v.uniformPlan,
					mrtOutputCount: v.mrtOutputCount,
					mrtOutputNames: v.mrtOutputNames,
					mrtBlendModes: v.mrtBlendModes,
				};

			}
			if ( Object.keys( variants ).length > 1 ) artifact.variants = variants;

		}

		const hash = hashMaterialSync( material, {
			name,
			threeVersion: normalizeRevision( REVISION ),
			pluginVersion: '0.0.0',
		} );

		// Phase 2 gate: any `severity: 'unknown'` kind in the codegen means we
		// hit a case the updater can't emit. Throw at capture time so the
		// developer sees the kind name next to their `.precompile()` call
		// (surfaces as an unhandled rejection in the console). Blocked kinds
		// are tolerated — they're known-deferred and get a warning instead.
		const { unsupportedKinds } = codegen( artifact );
		const unknowns = unsupportedKinds.filter( ( u ) => u.severity === 'unknown' );
		if ( unknowns.length > 0 ) {

			const summary = unknowns.map( ( u ) => `${ u.kind } @ byteOffset ${ u.byteOffset } — ${ u.reason }` ).join( '\n    ' );
			throw new Error( `[tsl-precompile] .precompile(${ JSON.stringify( name ) }): codegen has no case for ${ unknowns.length } kind(s) the extractor produced:\n    ${ summary }\nAdd a case to packages/plugin/src/emit-updater.js or document-block this kind in DOCUMENTED_BLOCKED_KINDS.` );

		}
		const blocked = unsupportedKinds.filter( ( u ) => u.severity === 'blocked' );
		if ( blocked.length > 0 ) {

			logOnce( 'blocked:' + name, () => console.warn( `[tsl-precompile] .precompile(${ JSON.stringify( name ) }): ${ blocked.length } kind(s) are documented-blocked and fall back to frozen snapshots. Animation paths that depend on them won't update. Kinds: ${ blocked.map( ( b ) => b.kind ).join( ', ' ) }` ) );

		}

		// Strip non-serialisable side-cars before POST; dev capture only needs
		// the JSON-safe portion of the artifact.
		const sanitized = jsonSafeArtifact( artifact );
		sanitized.sourceMaterial = materialSourceMetadata( material, sourceObject );

		// Also register the artifact in the runtime's in-memory registry
		// so the inspector panel (and any other local consumer) can see
		// captures live — in DEV the disk write happens async via the POST
		// below; the panel would stay empty if we only wrote to disk.
		try {

			registerArtifact( name, {
				__hash: hash,
				__name: name,
				artifact: sanitized,
				__unsupportedKinds: unsupportedKinds,
			} );

		} catch ( _ ) {
			/* double-registration with a different hash throws; tolerate it in dev. */
		}

		const response = await fetch( devEndpoint, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify( { name, hash, artifact: sanitized } ),
		} );

		if ( ! response.ok ) {

			const txt = await response.text();
			console.error( `[tsl-precompile] dev capture failed for ${ JSON.stringify( name ) }: ${ response.status } ${ txt }` );
			return;

		}

		sessionDone.add( name );
		console.info( `[tsl-precompile] captured "${ name }" (hash ${ hash.slice( 0, 12 ) })` );

	} catch ( err ) {

		// Connection refused → mark dead so we don't flood the console on HMR.
		const msg = err && err.message ? err.message : String( err );
		if ( /fetch|ECONN|NetworkError|Failed to fetch/i.test( msg ) ) {

			devEndpointDead = true;
			console.warn( `[tsl-precompile] dev capture endpoint ${ devEndpoint } unreachable (${ msg }). Further .precompile() calls in this session will be silent.` );

		} else {

			console.error( `[tsl-precompile] .precompile(${ JSON.stringify( name ) }) threw during capture:`, err );

		}

	}

}

/**
 * Strip non-enumerable / non-JSON-serialisable side-cars from an artifact.
 * The vendored `extractArtifact` attaches Maps and live node references via
 * `Object.defineProperty(... { enumerable: false })`; JSON.stringify drops
 * those automatically, but we also clean up known mutable fields.
 *
 * @param {Object} artifact
 * @return {Object}
 */
function jsonSafeArtifact( artifact ) {

	// JSON.stringify already drops non-enumerable properties; the round-trip
	// is enough to guarantee a clean payload.
	return JSON.parse( JSON.stringify( artifact ) );

}

/**
 * Clone every light from the source scene into the destination throwaway
 * scene. We must clone — never reparent — because `Object3D.add()` removes
 * the light from its existing parent and breaks the user's real render pass.
 *
 * three.js's `Light.clone()` (inherited via `Object3D.clone()`) covers every
 * built-in light class: AmbientLight, DirectionalLight, HemisphereLight,
 * PointLight, RectAreaLight, SpotLight, plus the IES/probe variants. It
 * preserves `color`, `intensity`, `position`, `distance`, `decay`, `angle`,
 * `penumbra`, `castShadow`, etc. via the standard `copy()` chain.
 *
 * Targets (DirectionalLight.target, SpotLight.target) are themselves Object3Ds
 * that live in the user's scene graph; `light.clone()` deep-clones the target
 * by default, so the cloned target carries the original target's transform
 * but is unparented. We add it to the throwaway scene alongside the light so
 * `updateMatrixWorld()` finds it during extraction.
 *
 * Lights nested inside transformed parents (e.g. a `PointLight` child of a
 * moving `particleLight` mesh) need their world transform baked in — the
 * throwaway scene won't replicate the parent chain. We compute the source
 * light's world matrix and decompose it onto the clone's local transform.
 *
 * @param {Object} sourceScene - The user's real scene (any Object3D with .traverse).
 * @param {Object} destScene - The throwaway scene to populate.
 */
function cloneLightsInto( sourceScene, destScene ) {

	if ( ! sourceScene || typeof sourceScene.traverse !== 'function' ) return;
	const lights = [];
	sourceScene.traverse( ( o ) => {

		if ( o && o.isLight === true ) lights.push( o );

	} );
	if ( lights.length === 0 ) return;

	// Make sure world matrices are current; users typically call
	// `scene.updateMatrixWorld()` once per frame before render, but the
	// extraction marker can fire from a microtask outside the render loop.
	if ( typeof sourceScene.updateMatrixWorld === 'function' ) sourceScene.updateMatrixWorld( true );

	for ( const light of lights ) {

		let cloned;
		try {

			cloned = typeof light.clone === 'function' ? light.clone() : null;

		} catch ( _ ) {

			cloned = null;

		}
		if ( ! cloned ) continue;
		stripClonedLightChildren( cloned );
		copyLightNodeGraphProps( light, cloned );

		// Bake world transform into the clone so a light parented under a
		// moving rig still illuminates from the right place during capture.
		// We only bother when the source has a non-identity world matrix
		// different from its local matrix (i.e. a non-Scene parent).
		if ( light.matrixWorld && light.parent && light.parent.isScene !== true ) {

			cloned.matrix.copy( light.matrixWorld );
			cloned.matrix.decompose( cloned.position, cloned.quaternion, cloned.scale );
			cloned.matrixWorldNeedsUpdate = true;

		}

		destScene.add( cloned );

		// SpotLight / DirectionalLight carry a separate `target` Object3D.
		// `Light.clone()` already deep-clones it, but the cloned target
		// stays unparented, so its world matrix never updates. Mirror the
		// source target's world transform onto the clone's target and add
		// it to the destination scene.
		if ( cloned.target && cloned.target.isObject3D && cloned.target !== cloned ) {

			const srcTarget = light.target;
			if ( srcTarget && srcTarget.matrixWorld ) {

				cloned.target.matrix.copy( srcTarget.matrixWorld );
				cloned.target.matrix.decompose( cloned.target.position, cloned.target.quaternion, cloned.target.scale );
				cloned.target.matrixWorldNeedsUpdate = true;

			}
			// Only attach if the target isn't already a descendant of the
			// cloned light (some custom Light subclasses parent target to
			// themselves).
			if ( ! cloned.target.parent ) destScene.add( cloned.target );

		}

	}

}

function copyLightNodeGraphProps( source, target ) {

	if ( ! source || ! target ) return;
	for ( const key of LIGHT_NODE_GRAPH_PROPS ) {

		if ( source[ key ] !== undefined ) target[ key ] = source[ key ];

	}

}

function stripClonedLightChildren( light ) {

	if ( ! light || ! Array.isArray( light.children ) ) return;
	const keep = light.target && light.target.isObject3D ? light.target : null;
	for ( const child of [ ...light.children ] ) {

		if ( child === keep ) continue;
		try { light.remove( child ); } catch ( _ ) {}

	}

}

/**
 * Mirror the source object's ClippingGroup ancestry into the throwaway
 * extraction scene. Returns the Object3D the throwaway mesh should be
 * attached to — either the innermost cloned ClippingGroup, or the destScene
 * itself when the source has no ClippingGroup ancestors.
 *
 * Clones, never reparents — the live groups remain in the user's scene.
 * Order is outermost → innermost so the cloned chain matches the user's,
 * which matters because `ClippingContext.getGroupContext()` composes nested
 * contexts by walking parent → child and merging plane sets.
 *
 * @param {Function|undefined} ClippingGroup - The three.js ClippingGroup constructor.
 * @param {Object|null} sourceObject - The user's source mesh, may be null.
 * @param {Object} destScene - The throwaway scene root.
 * @return {Object} The Object3D the throwaway mesh should be added to.
 */
function mountClippingGroupsInto( ClippingGroup, sourceObject, destScene ) {

	if ( ! ClippingGroup || ! sourceObject ) return destScene;

	const chain = [];
	let cursor = sourceObject.parent || null;
	while ( cursor ) {

		if ( cursor.isClippingGroup === true ) chain.unshift( cursor );
		cursor = cursor.parent || null;

	}
	if ( chain.length === 0 ) return destScene;

	let parent = destScene;
	for ( const group of chain ) {

		const cloned = new ClippingGroup();
		// `clippingPlanes` is an array of `Plane` instances. Share the same
		// references so the cloned group reflects live plane mutations during
		// extraction (the user might tweak plane.constant in a GUI between
		// scene mount and our extractor run; the captured shader is invariant
		// to the values, only the count/scope matters for shader shape).
		cloned.clippingPlanes = group.clippingPlanes;
		cloned.enabled = group.enabled;
		cloned.clipIntersection = group.clipIntersection;
		cloned.clipShadows = group.clipShadows;
		parent.add( cloned );
		parent = cloned;

	}
	return parent;

}

/**
 * Walk up an Object3D's parent chain to find the Scene it lives in. Returns
 * the Scene instance (anything with `.isScene === true`) or null. Used by
 * the precompile marker so the throwaway extraction scene can inherit the
 * real scene's environment / lights / fog — without that, PBR materials
 * extract without IBL bindings even when scene.environment is set.
 *
 * @param {Object3D|null} obj
 * @return {Object|null}
 */
function findParentScene( obj ) {

	let cursor = obj;
	while ( cursor ) {

		if ( cursor.isScene === true ) return cursor;
		cursor = cursor.parent || null;

	}
	return null;

}

const logged = new Set();
function logOnce( key, fn ) {

	if ( logged.has( key ) ) return;
	logged.add( key );
	fn();

}

/**
 * Reset internal state — test-only helper.
 */
export function __resetForTests() {

	installed = false;
	devEndpoint = null;
	devEndpointDead = false;
	threeModule = null;
	devRenderer = null;
	extractor = null;
	codegen = null;
	lastSeenArrayCamera = null;
	logged.clear();
	sessionDone.clear();
	inflight.clear();

}

export function __cloneLightsIntoForTests( sourceScene, destScene ) {

	return cloneLightsInto( sourceScene, destScene );

}
