import test from 'node:test';
import assert from 'node:assert/strict';

import { hydrateNodeBuilderState } from '../src/hydrator.js';
import {
	createRendererRenderTargetTextureRegistry,
	createRendererRenderTargetTextureSelector,
} from '../src/slim-support/render-target-texture-registry.js';
import { RENDER_TARGET_TEXTURE_RESOLUTION_ERROR_CODE } from '../src/hydrate/artifact-texture-resolver.js';

let nextTextureId = 1;

function makeTexture( name = 'producer-output' ) {

	return {
		isTexture: true,
		isRenderTargetTexture: true,
		uuid: `${ name }:${ nextTextureId ++ }`,
		name,
		format: 1023,
		type: 1009,
		colorSpace: 'srgb-linear',
		image: { width: 64, height: 32, depth: 1 },
	};

}

function makeTarget( texture = makeTexture() ) {

	const target = {
		isRenderTarget: true,
		width: 64,
		height: 32,
		depth: 1,
		texture,
		textures: [ texture ],
		depthTexture: null,
	};
	texture.renderTarget = target;
	return target;

}

function makeRenderer() {

	return {
		_target: null,
		getRenderTarget() {

			return this._target;

		},
		setRenderTarget( target ) {

			this._target = target;

		},
	};

}

function makeRendererWithRegistry() {

	const renderer = makeRenderer();
	createRendererRenderTargetTextureRegistry( renderer );
	return renderer;

}

function observe( renderer, ...targets ) {

	for ( const target of targets ) renderer.setRenderTarget( target );
	renderer.setRenderTarget( null );

}

function artifactForSelector(
	selector,
	legacyTexture = makeTexture( 'legacy-wrong' ),
	sourceKind = 'artifact.texture',
	includeSampler = false,
) {

	const source = {
		kind: sourceKind,
		textureUuid: 'dead-capture-uuid',
		renderTargetSelector: selector,
		...( sourceKind === 'depth.texture'
			? { lightIndex: -1, lightUuid: null, fromMaterialGraph: true, vsm: false, shadowMapColor: false }
			: {} ),
	};
	const artifact = {
		vertexShader: '',
		fragmentShader: sourceKind === 'depth.texture'
			? '@group(0) @binding(0) var nodeTexture0: texture_depth_2d;'
			: '@group(0) @binding(0) var nodeTexture0: texture_2d<f32>;' +
				( includeSampler ? '\n@group(0) @binding(1) var nodeTexture0_sampler: sampler;' : '' ),
		bindings: [ {
			name: 'object',
			bindings: [ {
				name: 'nodeTexture0',
				kind: 'sampled-texture',
				visibility: 2,
				textureType: '2d',
			}, ...( includeSampler ? [ {
				name: 'nodeTexture0_sampler',
				kind: 'sampler',
				visibility: 2,
				textureType: '2d',
				comparison: false,
			} ] : [] ) ],
		} ],
		uniformPlan: [ {
			name: 'object',
			slots: [],
			textures: [ {
				name: 'nodeTexture0',
				bindingKind: 'sampled-texture',
				textureType: '2d',
				source,
			}, ...( includeSampler ? [ {
				name: 'nodeTexture0_sampler',
				bindingKind: 'sampler',
				textureType: '2d',
				source,
			} ] : [] ) ],
		} ],
	};
	Object.defineProperty( artifact, '_textureRefs', {
		value: new Map( [ [ source.textureUuid, legacyTexture ] ] ),
		configurable: true,
	} );
	return artifact;

}

function hydratedTextureBinding( artifact, renderer ) {

	const state = hydrateNodeBuilderState( artifact, null, null, { renderer } );
	return {
		state,
		binding: state.bindings[ 0 ].bindings[ 0 ],
		sampler: state.bindings[ 0 ].bindings.find( binding => binding.isSampler === true ) || null,
	};

}

test( 'hydration resolves an exact render-target selector before legacy refs and follows attachment replacement', () => {

	const renderer = makeRenderer();
	createRendererRenderTargetTextureRegistry( renderer );
	const target = makeTarget();
	const selector = createRendererRenderTargetTextureSelector( target, { texture: target.texture } );
	observe( renderer, target );
	const artifact = artifactForSelector( selector );

	const { state, binding } = hydratedTextureBinding( artifact, renderer );
	assert.equal( binding.texture, target.texture, 'authoritative selector wins over the deliberately wrong _textureRefs entry' );
	assert.equal( artifact._textureResolutionStrategies.get( 'object:nodeTexture0' ), 'render-target-selector' );

	const replacement = makeTexture();
	replacement.renderTarget = target;
	target.texture = replacement;
	target.textures = [ replacement ];
	state.updateBeforeNodes[ 0 ].updateBefore( { renderer, renderId: 1, frameId: 1 } );
	assert.equal( binding.texture, replacement, 'per-frame rebinding reads the target current attachment' );

} );

test( 'non-light depth selectors use the same authoritative registry path', () => {

	const renderer = makeRenderer();
	createRendererRenderTargetTextureRegistry( renderer );
	const depth = makeTexture( 'pass-depth' );
	depth.isDepthTexture = true;
	depth.format = 1026;
	depth.type = 1014;
	depth.colorSpace = '';
	const target = makeTarget();
	target.depthTexture = depth;
	depth.renderTarget = target;
	const selector = createRendererRenderTargetTextureSelector( target, { texture: depth } );
	observe( renderer, target );
	const artifact = artifactForSelector( selector, makeTexture( 'legacy-depth-wrong' ), 'depth.texture' );

	const { state, binding } = hydratedTextureBinding( artifact, renderer );
	assert.equal( binding.texture, depth );
	assert.equal( state.updateBeforeNodes.length, 1, 'selector-backed depth uses the generic exact rebinder, not material graph search' );

} );

test( 'reflector depth selectors defer until the owner creates its target, then resolve late by exact owner identity', () => {

	const renderer = makeRendererWithRegistry();
	const capturedDepth = makeTexture( 'captured-reflector-depth' );
	capturedDepth.isDepthTexture = true;
	capturedDepth.format = 1026;
	capturedDepth.type = 1014;
	capturedDepth.colorSpace = '';
	capturedDepth.image = { width: 320, height: 240, depth: 1 };
	const capturedTarget = makeTarget();
	capturedTarget.width = 320;
	capturedTarget.height = 240;
	capturedTarget.depthTexture = capturedDepth;
	capturedDepth.renderTarget = capturedTarget;
	const selector = createRendererRenderTargetTextureSelector( capturedTarget, { texture: capturedDepth } );

	const liveDepth = makeTexture( 'live-reflector-depth' );
	liveDepth.isDepthTexture = true;
	liveDepth.format = 1026;
	liveDepth.type = 1014;
	liveDepth.colorSpace = '';
	const liveTarget = makeTarget();
	liveTarget.depthTexture = liveDepth;
	liveDepth.renderTarget = liveTarget;
	const camera = { name: 'camera' };
	const baseNode = {
		constructor: { type: 'ReflectorBaseNode' },
		renderTargets: new Map(),
		updateBefore( frame ) {

			this.renderTargets.set( frame.camera, liveTarget );
			renderer.setRenderTarget( liveTarget );
			renderer.setRenderTarget( null );

		},
	};
	const material = { __tslpReflectorBaseNodes: [ baseNode ] };
	const artifact = artifactForSelector( selector, capturedDepth, 'depth.texture' );
	artifact.uniformPlan[ 0 ].textures[ 0 ].source.reflectorIndex = 0;

	const state = hydrateNodeBuilderState( artifact, material, null, { renderer } );
	const binding = state.bindings[ 0 ].bindings[ 0 ];
	assert.notEqual( binding.texture, capturedDepth, 'a capture-process texture is never accepted as renderer ownership proof' );
	assert.notEqual( binding.texture, liveDepth, 'the live target does not exist during hydration' );
	assert.equal(
		artifact._textureResolutionStrategies.get( 'object:nodeTexture0' ),
		'render-target-selector-pending',
	);

	for ( const node of state.updateBeforeNodes ) {

		node.updateBefore( { renderer, camera, renderId: 1, frameId: 1 } );

	}
	assert.equal( binding.texture, liveDepth );
	assert.equal(
		artifact._textureResolutionStrategies.get( 'object:nodeTexture0' ),
		'render-target-selector',
	);

} );

test( 'pending hydration stays inert until renderer observation, then sampled-texture and sampler converge', () => {

	const renderer = makeRenderer();
	const registry = createRendererRenderTargetTextureRegistry( renderer );
	const target = makeTarget();
	const selector = createRendererRenderTargetTextureSelector( target, { texture: target.texture } );
	const artifact = artifactForSelector( selector, target.texture, 'artifact.texture', true );

	assert.equal( registry.observedTargetCount, 0 );
	const { state, binding, sampler } = hydratedTextureBinding( artifact, renderer );
	assert.equal( registry.observedTargetCount, 0, 'artifact refs must not mutate renderer ownership observations' );
	assert.notEqual( binding.texture, target.texture );
	assert.notEqual( sampler.texture, target.texture );
	assert.equal( binding.texture, sampler.texture, 'sampled texture and sampler share the pending color target' );
	assert.deepEqual(
		Array.from( binding.texture.image.data ),
		[ 0, 0, 0, 0 ],
		'pending 2D color targets preserve the zero-initialized render-target history',
	);
	assert.equal( artifact._textureResolutionStrategies.get( 'object:nodeTexture0' ), 'render-target-selector-pending' );
	assert.equal( artifact._textureResolutionStrategies.get( 'object:nodeTexture0_sampler' ), 'render-target-selector-pending' );

	observe( renderer, target );
	state.updateBeforeNodes[ 0 ].updateBefore( { renderer, renderId: 1, frameId: 1 } );
	assert.equal( binding.texture, target.texture );
	assert.equal( sampler.texture, target.texture );
	assert.equal( artifact._textureResolutionStrategies.get( 'object:nodeTexture0' ), 'render-target-selector' );
	assert.equal( artifact._textureResolutionStrategies.get( 'object:nodeTexture0_sampler' ), 'render-target-selector' );

} );

test( 'preferred artifact ownership disambiguates same-shaped observed targets', () => {

	const renderer = makeRendererWithRegistry();
	const preferredTarget = makeTarget();
	const otherTarget = makeTarget();
	const selector = createRendererRenderTargetTextureSelector( preferredTarget, { texture: preferredTarget.texture } );
	observe( renderer, preferredTarget, otherTarget );

	const artifact = artifactForSelector( selector, preferredTarget.texture );
	const { binding } = hydratedTextureBinding( artifact, renderer );
	assert.equal( binding.texture, preferredTarget.texture );
	assert.equal( artifact._textureResolutionStrategies.get( 'object:nodeTexture0' ), 'render-target-selector' );

} );

test( 'preferred post-process attachment identity lets renamed sampled-texture and sampler bindings converge', () => {

	const renderer = makeRendererWithRegistry();
	const capturedTexture = makeTexture( 'UnrealBloomPass.bright' );
	const capturedTarget = makeTarget( capturedTexture );
	const selector = createRendererRenderTargetTextureSelector( capturedTarget, { texture: capturedTexture } );
	const liveTexture = makeTexture( 'UnrealBloomPass.h0' );
	liveTexture.image.width = 32;
	liveTexture.image.height = 16;
	const liveTarget = makeTarget( liveTexture );
	liveTarget.width = 32;
	liveTarget.height = 16;
	observe( renderer, liveTarget );

	const artifact = artifactForSelector( selector, liveTexture, 'artifact.texture', true );
	const { binding, sampler } = hydratedTextureBinding( artifact, renderer );
	assert.equal( binding.texture, liveTexture );
	assert.equal( sampler.texture, liveTexture );
	assert.equal( artifact._textureResolutionStrategies.get( 'object:nodeTexture0' ), 'render-target-selector' );
	assert.equal( artifact._textureResolutionStrategies.get( 'object:nodeTexture0_sampler' ), 'render-target-selector' );

} );

test( 'foreign-renderer artifact refs stay inert and converge only after local ownership is wired', () => {

	const rendererA = makeRendererWithRegistry();
	const rendererB = makeRendererWithRegistry();
	const foreignTarget = makeTarget();
	const selector = createRendererRenderTargetTextureSelector( foreignTarget, { texture: foreignTarget.texture } );
	observe( rendererB, foreignTarget );

	const artifact = artifactForSelector( selector, foreignTarget.texture );
	const { state, binding } = hydratedTextureBinding( artifact, rendererA );
	assert.notEqual( binding.texture, foreignTarget.texture );

	const localTarget = makeTarget();
	artifact._textureRefs.set( 'dead-capture-uuid', localTarget.texture );
	observe( rendererA, localTarget );
	state.updateBeforeNodes[ 0 ].updateBefore( { renderer: rendererA, renderId: 2, frameId: 2 } );
	assert.equal( binding.texture, localTarget.texture );
	assert.notEqual( binding.texture, foreignTarget.texture );

} );

test( 'selector-backed hydration fails closed on missing registry, ambiguity, and active-write hazards', () => {

	const sourceTarget = makeTarget();
	const selector = createRendererRenderTargetTextureSelector( sourceTarget, { texture: sourceTarget.texture } );

	const noRegistry = makeRenderer();
	assert.throws(
		() => hydratedTextureBinding( artifactForSelector( selector ), noRegistry ),
		( error ) => error.code === RENDER_TARGET_TEXTURE_RESOLUTION_ERROR_CODE
			&& error.status === 'pending'
			&& error.reason === 'registry-not-installed'
			&& error.message.includes( 'normal slim renderer/setup path so ReplayNodeManager installs discovery' )
			&& error.message.includes( 'Only custom integrations that call hydrateNodeBuilderState() directly' )
			&& error.message.includes( 'createRendererRenderTargetTextureRegistry(renderer)' )
			&& error.message.includes( 'before any setRenderTarget() call' ),
	);

	const ambiguousRenderer = makeRenderer();
	createRendererRenderTargetTextureRegistry( ambiguousRenderer );
	observe( ambiguousRenderer, makeTarget(), makeTarget() );
	assert.throws(
		() => hydratedTextureBinding( artifactForSelector( selector ), ambiguousRenderer ),
		( error ) => error.code === RENDER_TARGET_TEXTURE_RESOLUTION_ERROR_CODE
			&& error.status === 'ambiguous'
			&& error.reason === 'multiple-exact-matches',
	);

	const hazardRenderer = makeRenderer();
	createRendererRenderTargetTextureRegistry( hazardRenderer );
	const hazardTarget = makeTarget();
	hazardRenderer.setRenderTarget( hazardTarget );
	assert.throws(
		() => hydratedTextureBinding(
			artifactForSelector( createRendererRenderTargetTextureSelector( hazardTarget, { texture: hazardTarget.texture } ) ),
			hazardRenderer,
		),
		( error ) => error.code === RENDER_TARGET_TEXTURE_RESOLUTION_ERROR_CODE
			&& error.status === 'hazard'
			&& error.reason === 'active-write-attachment',
	);

} );

test( 'selector-backed hydration fails closed on shader binding incompatibility', () => {

	const renderer = makeRendererWithRegistry();
	const target = makeTarget();
	const selector = createRendererRenderTargetTextureSelector( target, { texture: target.texture } );
	observe( renderer, target );
	const artifact = artifactForSelector( selector );
	artifact.fragmentShader = '@group(0) @binding(0) var nodeTexture0: texture_depth_2d;';

	assert.throws(
		() => hydratedTextureBinding( artifact, renderer ),
		( error ) => error.code === RENDER_TARGET_TEXTURE_RESOLUTION_ERROR_CODE
			&& error.status === 'missing'
			&& error.reason === 'shader-binding-mismatch',
	);

} );

test( 'PMREM sources ignore legacy generic selectors and use authoritative PMREM refs', () => {

	const renderer = makeRenderer();
	const pmrem = makeTexture( 'PMREM.cubeUv' );
	pmrem.mapping = 306;
	pmrem.isPMREMTexture = true;
	const target = makeTarget( pmrem );
	const selector = createRendererRenderTargetTextureSelector( target, { texture: pmrem } );
	const artifact = artifactForSelector( selector, pmrem );
	const source = artifact.uniformPlan[ 0 ].textures[ 0 ].source;
	source.mapping = 306;
	source.textureName = 'PMREM.cubeUv';
	source.imageWidth = pmrem.image.width;
	source.imageHeight = pmrem.image.height;
	source.imageDepth = pmrem.image.depth;

	const { binding } = hydratedTextureBinding( artifact, renderer );
	assert.equal( binding.texture, pmrem );
	assert.equal( artifact._textureResolutionStrategies.get( 'object:nodeTexture0' ), 'texture-ref' );

} );
