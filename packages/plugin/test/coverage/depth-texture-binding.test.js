/**
 * Coverage: shadow depth-texture bindings flow from extractor → hydrator.
 *
 * Wires the full pipeline for a shadow-receiving material:
 *   1. extractArtifact with a synthetic NodeBuilderState whose SampledTexture
 *      binding is backed by a `DepthTexture` AND whose updateNodes carry an
 *      AnalyticLightNode-shaped object whose `light.shadow.map.depthTexture`
 *      matches the binding's texture.
 *   2. Assert the binding's plan source is tagged `kind: 'depth.texture'`
 *      with a `lightIndex` pointing at the right light.
 *   3. Hydrate the artifact and assert light-owned shadow bindings initially
 *      point at the 1×1 fallback (so bind groups validate before the first
 *      frame), while an exactly attached material-graph depth texture can bind
 *      immediately. In both cases the rebinder updateBefore-node follows the
 *      current live texture before the draw.
 *
 * This guards against regression: if the extractor stops tagging
 * depth.texture bindings, or the hydrator stops emitting the rebinder, the
 * 1×1 placeholder reaches the GPU and shadowed materials look uniformly lit.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	DepthTexture, DataTexture, RGBAFormat,
	DirectionalLight, Scene,
} from 'three';

import { extractArtifact } from '../../src/vendor/compileTSL.js';
import { hydrateNodeBuilderState } from '../../../runtime/src/hydrator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake AnalyticLightNode whose `.light.shadow.map.depthTexture`
 * points at a real DepthTexture instance — exactly the shape three.js's
 * own ShadowNode produces in `setupRenderTarget`.
 */
function makeShadowReceivingState() {

	const depthTexture = new DepthTexture( 4, 4 );
	depthTexture.name = 'ShadowDepthTexture';

	const dirLight = new DirectionalLight( 0xffffff, 1 );
	dirLight.castShadow = true;
	dirLight.shadow.map = {
		texture: new DataTexture( new Uint8Array( [ 255, 0, 0, 255 ] ), 1, 1, RGBAFormat ),
		depthTexture,
	};

	// Synthetic AnalyticLightNode: the `isAnalyticLightNode` flag is what
	// `findLightForDepthTexture` matches on. `light` carries the shadow chain.
	const lightNode = {
		isAnalyticLightNode: true,
		light: dirLight,
		shadowNode: null,
	};

	// Build a SampledTexture binding shaped the way three.js's WGSLNodeBuilder
	// emits one for a shadow lookup: the textureNode wraps the DepthTexture.
	const samplerBinding = {
		name: 'shadowMapSampler',
		isSampledTexture: false,
		isSampler: true,
		isUniformBuffer: false,
		isStorageBuffer: false,
		visibility: 2,
		groupNode: { shared: false, version: 0 },
		textureNode: { value: depthTexture, _value: null, compareNode: { isNode: true }, constructor: { type: 'TextureNode' } },
		texture: depthTexture,
	};
	const textureBinding = {
		name: 'shadowMap',
		isSampledTexture: true,
		isSampler: false,
		isUniformBuffer: false,
		isStorageBuffer: false,
		visibility: 2,
		groupNode: { shared: false, version: 0 },
		textureNode: { value: depthTexture, _value: null, compareNode: { isNode: true }, constructor: { type: 'TextureNode' } },
		texture: depthTexture,
	};

	const fragmentShader = '@group(1) @binding(2) var shadowMap : texture_depth_2d;\n';

	const state = {
		vertexShader: 'vertex',
		fragmentShader,
		computeShader: '',
		nodeAttributes: [],
		updateNodes: [ lightNode ],
		updateBeforeNodes: [],
		updateAfterNodes: [],
		bindings: [ {
			name: 'mat',
			bindings: [ textureBinding, samplerBinding ],
		} ],
	};

	return { state, dirLight, depthTexture };

}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test( 'depth-texture/extractor: SampledTexture wrapping DepthTexture is tagged kind=depth.texture', () => {

	const { state, dirLight } = makeShadowReceivingState();

	const artifact = extractArtifact( 99, state );

	// Find the shadowMap entry in the plan.
	const allTextures = artifact.uniformPlan.flatMap( ( g ) => g.textures || [] );
	const shadowEntry = allTextures.find( ( t ) => t.name === 'shadowMap' );
	assert.ok( shadowEntry, 'shadowMap binding must appear in uniformPlan textures' );
	assert.equal( shadowEntry.source.kind, 'depth.texture',
		'depth-texture binding must be tagged kind: depth.texture (was ' + shadowEntry.source.kind + ')' );
	assert.equal( shadowEntry.source.lightIndex, 0,
		'lightIndex should be 0 for the only AnalyticLightNode in updateNodes' );
	assert.equal( shadowEntry.source.lightUuid, dirLight.uuid,
		'lightUuid should match the captured directional light' );
	assert.equal( artifact.lightIdentities[ shadowEntry.source.lightIdentity ].captureUuid, dirLight.uuid,
		'depth texture should share the owning light identity record' );
	assert.equal( shadowEntry.source.vsm, false,
		'standard shadow path (not VSM) — vsm flag should be false' );
	assert.equal( shadowEntry.source.shadowMapColor, false,
		'standard shadow depth must not be tagged as the shadow color attachment' );
	const samplerEntry = allTextures.find( ( t ) => t.name === 'shadowMapSampler' );
	assert.equal( samplerEntry.comparison, true,
		'the uniform plan preserves authored comparison-sampler intent' );
	const samplerDescriptor = artifact.bindings[ 0 ].bindings.find( ( binding ) => binding.name === 'shadowMapSampler' );
	assert.equal( samplerDescriptor.comparison, true,
		'the replay binding descriptor preserves authored comparison-sampler intent' );

	// The companion sampler binding can either inherit the same kind or stay
	// at its own classification — our hydrator only swaps SampledTexture
	// bindings, so what matters is that the SAMPLED-TEXTURE entry is tagged.

} );

test( 'depth-texture/extractor: shadow map color attachment keeps its non-VSM role', () => {

	const depthTexture = new DepthTexture( 4, 4 );
	const shadowColor = new DataTexture( new Uint8Array( [ 255, 128, 0, 255 ] ), 1, 1, RGBAFormat );
	const dirLight = new DirectionalLight( 0xffffff, 1 );
	dirLight.shadow.map = { texture: shadowColor, depthTexture };

	const state = {
		vertexShader: 'v',
		fragmentShader: '@group(1) @binding(2) var transmittedShadow : texture_2d<f32>;\n',
		computeShader: '',
		nodeAttributes: [],
		updateNodes: [ {
			isAnalyticLightNode: true,
			light: dirLight,
			shadowNode: null,
		} ],
		updateBeforeNodes: [],
		updateAfterNodes: [],
		bindings: [ {
			name: 'mat',
			bindings: [ {
				name: 'transmittedShadow',
				isSampledTexture: true,
				isSampler: false,
				isUniformBuffer: false,
				isStorageBuffer: false,
				visibility: 2,
				groupNode: { shared: false, version: 0 },
				textureNode: { value: shadowColor, _value: null, constructor: { type: 'TextureNode' } },
				texture: shadowColor,
			} ],
		} ],
	};

	const artifact = extractArtifact( 100, state );
	const entry = artifact.uniformPlan
		.flatMap( ( group ) => group.textures || [] )
		.find( ( texture ) => texture.name === 'transmittedShadow' );

	assert.equal( entry.source.kind, 'depth.texture' );
	assert.equal( entry.source.lightUuid, dirLight.uuid );
	assert.equal( entry.source.vsm, false );
	assert.equal( entry.source.shadowMapColor, true );

} );

test( 'depth-texture/extractor: VSM intermediate texture is tagged kind=depth.texture with vsm=true', () => {

	const depthTexture = new DepthTexture( 4, 4 );
	const vsmBlur = new DataTexture( new Uint8Array( 4 ), 1, 1, RGBAFormat );
	const dirLight = new DirectionalLight( 0xffffff, 1 );
	dirLight.shadow.map = { texture: depthTexture, depthTexture };

	const lightNode = {
		isAnalyticLightNode: true,
		light: dirLight,
		shadowNode: { vsmShadowMapHorizontal: { texture: vsmBlur } },
	};

	const state = {
		vertexShader: 'v', fragmentShader: 'f', computeShader: '',
		nodeAttributes: [],
		updateNodes: [ lightNode ],
		updateBeforeNodes: [],
		updateAfterNodes: [],
		bindings: [ {
			name: 'mat',
			bindings: [ {
				name: 'vsmShadow',
				isSampledTexture: true, isSampler: false,
				isUniformBuffer: false, isStorageBuffer: false,
				visibility: 2,
				groupNode: { shared: false, version: 0 },
				textureNode: { value: vsmBlur, _value: null, constructor: { type: 'TextureNode' } },
				texture: vsmBlur,
			} ],
		} ],
	};

	const artifact = extractArtifact( 1, state );
	const allTextures = artifact.uniformPlan.flatMap( ( g ) => g.textures || [] );
	const vsmEntry = allTextures.find( ( t ) => t.name === 'vsmShadow' );

	assert.ok( vsmEntry, 'vsm binding entry exists' );
	assert.equal( vsmEntry.source.kind, 'depth.texture' );
	assert.equal( vsmEntry.source.vsm, true );
	assert.equal( vsmEntry.source.shadowMapColor, false );

} );

test( 'depth-texture/extractor: orphan DepthTexture (no owning light) is tagged lightIndex=-1 + fromMaterialGraph=true', () => {

	// `webgpu_depth_texture.html` shape: a `RenderTarget.depthTexture` is
	// sampled via `material.colorNode = texture(depthTexture)`. There is no
	// AnalyticLightNode in updateNodes, so `findLightForDepthTexture` returns
	// null and the source must signal "resolve from material graph at runtime".
	const depthTexture = new DepthTexture( 4, 4 );
	depthTexture.name = 'RT_DepthTexture';

	const state = {
		vertexShader: 'v',
		fragmentShader: '@group(1) @binding(2) var rtDepth : texture_depth_2d;\n',
		computeShader: '',
		nodeAttributes: [],
		updateNodes: [],
		updateBeforeNodes: [],
		updateAfterNodes: [],
		bindings: [ {
			name: 'mat',
			bindings: [ {
				name: 'rtDepth',
				isSampledTexture: true, isSampler: false,
				isUniformBuffer: false, isStorageBuffer: false,
				visibility: 2,
				groupNode: { shared: false, version: 0 },
				textureNode: { value: depthTexture, _value: null, constructor: { type: 'TextureNode' } },
				texture: depthTexture,
			} ],
		} ],
	};

	const artifact = extractArtifact( 7, state );
	const allTextures = artifact.uniformPlan.flatMap( ( g ) => g.textures || [] );
	const entry = allTextures.find( ( t ) => t.name === 'rtDepth' );
	assert.ok( entry, 'rtDepth binding must appear in uniformPlan textures' );
	assert.equal( entry.source.kind, 'depth.texture',
		'orphan DepthTexture must still be tagged kind: depth.texture' );
	assert.equal( entry.source.lightIndex, -1,
		'orphan DepthTexture must use lightIndex: -1 (no owning AnalyticLightNode)' );
	assert.equal( entry.source.lightUuid, null,
		'orphan DepthTexture must have lightUuid: null' );
	assert.equal( entry.source.fromMaterialGraph, true,
		'orphan DepthTexture must set fromMaterialGraph: true so the runtime resolves via the material node graph' );
	assert.equal( entry.source.textureUuid, depthTexture.uuid,
		'orphan DepthTexture must keep the captured texture uuid as a hint' );

} );

test( 'depth-texture/hydrator: orphan DepthTexture binding is rebound from material.colorNode', () => {

	// End-to-end for the orphan path: extract → hydrate(with material whose
	// colorNode embeds a DepthTexture) → rebinder runs → binding.texture
	// becomes the live DepthTexture (no scene/light needed).
	const depthTexture = new DepthTexture( 4, 4 );
	depthTexture.name = 'RT_DepthTexture';

	const state = {
		vertexShader: 'v',
		fragmentShader: '@group(1) @binding(2) var rtDepth : texture_depth_2d;\n',
		computeShader: '',
		nodeAttributes: [],
		updateNodes: [],
		updateBeforeNodes: [],
		updateAfterNodes: [],
		bindings: [ {
			name: 'mat',
			bindings: [ {
				name: 'rtDepth',
				isSampledTexture: true, isSampler: false,
				isUniformBuffer: false, isStorageBuffer: false,
				visibility: 2,
				groupNode: { shared: false, version: 0 },
				textureNode: { value: depthTexture, _value: null, constructor: { type: 'TextureNode' } },
				texture: depthTexture,
			} ],
		} ],
	};

	const artifact = extractArtifact( 7, state );

	// Fake material whose `colorNode` mirrors `texture(depthTexture)` — a
	// TextureNode whose `.value` is the live DepthTexture. The runtime's
	// `collectLiveMaterialTextures` walks `_NODE_GRAPH_KEYS` (incl. colorNode)
	// and detects the texture by `isTextureNode && value.isTexture`.
	const material = {
		colorNode: {
			isTextureNode: true,
			value: depthTexture,
		},
	};

	const hydrated = hydrateNodeBuilderState( artifact, material );

	const allBindings = hydrated.bindings.flatMap( ( g ) => g.bindings );
	const rtBinding = allBindings.find( ( b ) => b.name === 'rtDepth' );
	assert.ok( rtBinding, 'hydrated state must contain a rtDepth SampledTexture binding' );

	const initialTex = rtBinding.texture;
	assert.ok( initialTex && initialTex.isDepthTexture,
		'initial binding must be a DepthTexture instance' );
	assert.equal( initialTex, depthTexture,
		'in-process extraction must preserve an exactly attached material-graph DepthTexture' );

	assert.ok( Array.isArray( hydrated.updateBeforeNodes ) && hydrated.updateBeforeNodes.length > 0,
		'hydrator must register a rebinder for orphan depth.texture bindings' );
	const rebinder = hydrated.updateBeforeNodes[ 0 ];

	// Replace the graph texture after hydration. Orphan rebinding does NOT
	// require a scene; it walks the material's current node graph each frame.
	const replacementDepthTexture = new DepthTexture( 8, 8 );
	replacementDepthTexture.name = 'RT_DepthTexture_Replacement';
	material.colorNode.value = replacementDepthTexture;
	rebinder.updateBefore( {} );

	assert.equal( rtBinding.texture, replacementDepthTexture,
		'after updateBefore, orphan binding must follow the current DepthTexture from material.colorNode' );
	assert.notEqual( rtBinding.texture, initialTex,
		'after updateBefore, orphan binding must no longer point at the previously attached texture' );

} );

test( 'depth-texture/hydrator: depth.texture binding starts on fallback then swaps to live shadow map', () => {

	const { state, dirLight, depthTexture } = makeShadowReceivingState();
	const artifact = extractArtifact( 99, state );

	const hydrated = hydrateNodeBuilderState( artifact );

	// Locate the shadowMap binding in the hydrated bind groups.
	const allBindings = hydrated.bindings.flatMap( ( g ) => g.bindings );
	const shadowBinding = allBindings.find( ( b ) => b.name === 'shadowMap' );
	assert.ok( shadowBinding, 'hydrated state must contain a shadowMap SampledTexture binding' );
	assert.equal( shadowBinding.isSampledTexture, true,
		'hydrated shadowMap must be a SampledTexture binding' );

	// Initial state: a 1×1 fallback DepthTexture (NOT the captured live one).
	const initialTex = shadowBinding.texture;
	assert.ok( initialTex && initialTex.isDepthTexture,
		'pre-frame fallback must be a DepthTexture instance' );
	assert.notEqual( initialTex, depthTexture,
		'pre-frame fallback must NOT be the captured live DepthTexture (it is the 1×1 placeholder)' );
	assert.equal( initialTex.image.width, 1, 'fallback is 1×1' );

	// The hydrator must have registered an updateBefore node that performs
	// the per-frame rebind.
	assert.ok( Array.isArray( hydrated.updateBeforeNodes ) && hydrated.updateBeforeNodes.length > 0,
		'hydrator must register at least one updateBefore node for shadow rebinding' );
	const rebinder = hydrated.updateBeforeNodes[ 0 ];
	assert.equal( typeof rebinder.updateBefore, 'function',
		'rebinder must implement updateBefore(frame)' );
	assert.equal( rebinder.getUpdateBeforeType(), 'render',
		'rebinder must declare RENDER update type' );

	// Drive the rebinder with a frame whose scene contains the live light
	// with a populated shadow.map.depthTexture. After running, the
	// SampledTexture binding's `texture` should point at the live texture.
	const scene = new Scene();
	scene.add( dirLight );

	rebinder.updateBefore( { scene } );

	assert.equal( shadowBinding.texture, depthTexture,
		'after updateBefore, binding must point at the live light.shadow.map.depthTexture' );
	assert.notEqual( shadowBinding.texture, initialTex,
		'after updateBefore, binding must no longer point at the 1×1 fallback' );

} );

test( 'depth-texture/hydrator: rebinder is a no-op when the matching light has no shadow map', () => {

	const { state } = makeShadowReceivingState();
	const artifact = extractArtifact( 99, state );

	const hydrated = hydrateNodeBuilderState( artifact );
	const allBindings = hydrated.bindings.flatMap( ( g ) => g.bindings );
	const shadowBinding = allBindings.find( ( b ) => b.name === 'shadowMap' );
	const initialTex = shadowBinding.texture;

	// Build a fresh light WITHOUT a shadow.map (the typical state before the
	// renderer's shadow pass has run for the first time).
	const dirLight = new DirectionalLight( 0xffffff, 1 );
	dirLight.shadow.map = null;
	const scene = new Scene();
	scene.add( dirLight );

	const rebinder = hydrated.updateBeforeNodes[ 0 ];
	rebinder.updateBefore( { scene } );

	assert.equal( shadowBinding.texture, initialTex,
		'binding must remain on the fallback when light.shadow.map is null' );

} );

test( 'depth-texture/hydrator: no rebinder is created for materials without depth.texture bindings', () => {

	// A plain material with only a regular sampled-texture binding (no
	// shadow). The hydrator should NOT install a rebinder.
	const regularTex = new DataTexture( new Uint8Array( 4 ), 1, 1, RGBAFormat );
	const state = {
		vertexShader: 'v', fragmentShader: 'f', computeShader: '',
		nodeAttributes: [], updateNodes: [], updateBeforeNodes: [], updateAfterNodes: [],
		bindings: [ {
			name: 'mat',
			bindings: [ {
				name: 'myTex',
				isSampledTexture: true, isSampler: false,
				isUniformBuffer: false, isStorageBuffer: false,
				visibility: 2,
				groupNode: { shared: false, version: 0 },
				textureNode: { value: regularTex, _value: null, constructor: { type: 'TextureNode' } },
				texture: regularTex,
			} ],
		} ],
	};

	const artifact = extractArtifact( 1, state );
	const hydrated = hydrateNodeBuilderState( artifact );

	// updateBeforeNodes may be empty or contain only liveUpdateBeforeNodes;
	// the key assertion is that NO entry shaped like our rebinder
	// (getUpdateBeforeType() returning 'render' + reading frame.scene) exists.
	const hasShadowRebinder = ( hydrated.updateBeforeNodes || [] ).some( ( n ) => {

		try {

			return typeof n.getUpdateBeforeType === 'function'
				&& n.getUpdateBeforeType() === 'render'
				&& typeof n.updateBefore === 'function'
				// Cheap shape check: our rebinder closes over a non-empty
				// entry list. If the function source mentions 'shadow' we
				// flag it. This isn't airtight but catches the common case.
				&& /shadow/i.test( n.updateBefore.toString() );

		} catch ( _ ) {

			return false;

		}

	} );
	assert.equal( hasShadowRebinder, false,
		'no shadow-rebinder should be installed when there are no depth.texture bindings' );

} );

test( 'depth-texture/extractor: documented-blocked kinds list now includes depth.texture', async () => {

	const { DOCUMENTED_BLOCKED_KINDS } = await import( '../../src/emit-updater.js' );
	assert.ok(
		'depth.texture' in DOCUMENTED_BLOCKED_KINDS,
		'emit-updater must declare depth.texture as documented-blocked so the drift gate accepts it'
	);

} );
