import test from 'node:test';
import assert from 'node:assert/strict';

import {
	ARTIFACT_TEXTURE_STRATEGY_NAMES,
	recordTextureResolutionStrategy,
	resolveArtifactTextureBinding,
} from '../src/hydrate/artifact-texture-resolver.js';

test( 'artifact texture resolver exposes stable named strategy order', () => {

	assert.deepEqual( ARTIFACT_TEXTURE_STRATEGY_NAMES, [
		'material-node-texture',
		'render-target-texture-ref',
		'live-texture-identity',
		'texture-ref',
		'material-slot-uuid',
		'anonymous-data-texture',
		'snapshot',
		'multisampled-depth-fallback',
		'anonymous-storage-texture',
	] );

} );

test( 'artifact texture resolver reports render-target sidecar refs before generic refs', () => {

	const texture = { isTexture: true, isRenderTargetTexture: true };
	const artifact = {
		fragmentShader: 'var nodeTexture0: texture_2d<f32>;',
		_textureRefs: new Map( [ [ 'tex-a', texture ] ] ),
	};
	const result = resolveArtifactTextureBinding( {
		artifact,
		bindingName: 'nodeTexture0',
		source: { kind: 'artifact.texture', textureUuid: 'tex-a' },
		deps: {
			applyTextureSourceSettings( tex ) {

				return { ...tex, settingsApplied: true };

			},
		},
	} );

	assert.equal( result.strategy, 'render-target-texture-ref' );
	assert.equal( result.texture.settingsApplied, true );

} );

test( 'artifact texture resolver records strategies on non-enumerable artifact state', () => {

	const artifact = {};
	recordTextureResolutionStrategy( artifact, 'group', 'binding', 'snapshot' );

	assert.equal( artifact._textureResolutionStrategies.get( 'group:binding' ), 'snapshot' );
	assert.equal( Object.prototype.propertyIsEnumerable.call( artifact, '_textureResolutionStrategies' ), false );

} );
