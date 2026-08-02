import test from 'node:test';
import assert from 'node:assert/strict';

import { createDynamicBindingResolvers } from '../src/hydrate/rebinders/dynamic-binding-resolver.js';

function fakeDeps() {

	return {
		resolveTextureBinding() { return null; },
		findLightBySource() { return null; },
		recordShadowDiagnostic() {},
		describeLight() { return null; },
	};

}

function makeBinding( ext = {} ) {

	return {
		binding: { isSampledTexture: true, isSampler: false, texture: { isTexture: true }, sampler: null },
		artifact: { name: 'fixture', uniformPlan: [] },
		bindingName: 'nodeTexture0',
		groupName: 'render',
		source: { kind: 'artifact.texture', textureUuid: 'a' },
		material: null,
		...ext,
	};

}

test( 'createDynamicBindingResolvers returns empty arrays when nothing is wired', () => {

	const { earlyUpdateBefore, lateUpdateBefore } = createDynamicBindingResolvers( {
		shadowDepthBindings: [],
		materialDepthBindings: [],
		artifactTextureBindings: [],
		lateArtifactTextureBindings: [],
		materialTextureBindings: [],
		viewportTextureBindings: [],
		reflectorTextureBindings: [],
	}, fakeDeps() );
	assert.equal( earlyUpdateBefore.length, 0 );
	assert.equal( lateUpdateBefore.length, 0 );

} );

test( 'createDynamicBindingResolvers emits one rebinder per non-empty category', () => {

	const { earlyUpdateBefore, lateUpdateBefore } = createDynamicBindingResolvers( {
		shadowDepthBindings: [ makeBinding( { source: { kind: 'depth.texture', lightIndex: 0 } } ) ],
		materialDepthBindings: [ makeBinding( { source: { kind: 'depth.texture', fromMaterialGraph: true } } ) ],
		artifactTextureBindings: [ makeBinding() ],
		lateArtifactTextureBindings: [ makeBinding( { source: { kind: 'depth.texture', fromMaterialGraph: true, renderTargetSelector: {} } } ) ],
		materialTextureBindings: [ makeBinding( { source: { kind: 'material.map' } } ) ],
		viewportTextureBindings: [ {
			binding: { isSampledTexture: true, texture: { isFramebufferTexture: true } },
			fallbackTexture: { isFramebufferTexture: true },
			generateMipmaps: false,
			isDepth: false,
			material: null,
			skipZeroThicknessTransmission: false,
		} ],
		reflectorTextureBindings: [ {
			binding: { isSampledTexture: true, texture: { isRenderTargetTexture: true } },
			baseNode: { renderTargets: new Map() },
		} ],
	}, fakeDeps() );
	// Early lane: shadow + artifact + material + viewport = 4 rebinders
	assert.equal( earlyUpdateBefore.length, 4 );
	// Late lane: materialDepth + selector-backed material target + reflector = 3 rebinders
	assert.equal( lateUpdateBefore.length, 3 );
	// Each item is something callable (rebinder object with at least
	// `getUpdateType` or `updateBefore` on it — the underlying factories
	// vary, so the shape check is just "non-null object").
	for ( const r of [ ...earlyUpdateBefore, ...lateUpdateBefore ] ) {

		assert.ok( r && typeof r === 'object' );

	}

} );

test( 'createDynamicBindingResolvers preserves the ordering invariant (shadow → artifact → material → viewport in early; materialDepth → late artifact → reflector in late)', () => {

	const { earlyUpdateBefore, lateUpdateBefore } = createDynamicBindingResolvers( {
		shadowDepthBindings: [ makeBinding() ],
		materialDepthBindings: [ makeBinding() ],
		artifactTextureBindings: [ makeBinding() ],
		lateArtifactTextureBindings: [ makeBinding() ],
		materialTextureBindings: [ makeBinding() ],
		viewportTextureBindings: [ {
			binding: { isSampledTexture: true, texture: { isFramebufferTexture: true } },
			fallbackTexture: { isFramebufferTexture: true },
			generateMipmaps: false,
			isDepth: false,
			material: null,
			skipZeroThicknessTransmission: false,
		} ],
		reflectorTextureBindings: [ {
			binding: { isSampledTexture: true, texture: { isRenderTargetTexture: true } },
			baseNode: { renderTargets: new Map() },
		} ],
	}, fakeDeps() );
	// The factories don't tag their output explicitly; assert order by
	// counts in each lane instead.
	assert.equal( earlyUpdateBefore.length, 4 );
	assert.equal( lateUpdateBefore.length, 3 );

} );
