import test from 'node:test';
import assert from 'node:assert/strict';

import {
	ARTIFACT_TEXTURE_STRATEGY_NAMES,
	getTextureResolutionDebugHook,
	recordTextureResolutionStrategy,
	resolveArtifactTextureBinding,
	setTextureResolutionDebugHook,
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

test( 'artifact texture resolver rejects wrong-sized PMREM material-node candidates', () => {

	const staleNodePMREM = { isTexture: true, name: 'PMREM.cubeUv', mapping: 306, image: { width: 256, height: 256 } };
	const wiredPMREM = { isTexture: true, name: 'PMREM.cubeUv', mapping: 306, image: { width: 1536, height: 2048 } };
	const artifact = {
		fragmentShader: 'var nodeTexture0: texture_2d<f32>;',
		_textureRefs: new Map( [ [ 'pmrem-a', wiredPMREM ] ] ),
	};
	const result = resolveArtifactTextureBinding( {
		artifact,
		bindingName: 'nodeTexture0',
		source: {
			kind: 'artifact.texture',
			textureUuid: 'pmrem-a',
			textureName: 'PMREM.cubeUv',
			mapping: 306,
			imageWidth: 1536,
			imageHeight: 2048,
		},
		deps: {
			lookupMaterialNodeTexture() {

				return staleNodePMREM;

			},
		},
	} );

	assert.equal( result.strategy, 'texture-ref' );
	assert.equal( result.texture, wiredPMREM );

} );

test( 'artifact texture resolver records strategies on non-enumerable artifact state', () => {

	const artifact = {};
	recordTextureResolutionStrategy( artifact, 'group', 'binding', 'snapshot' );

	assert.equal( artifact._textureResolutionStrategies.get( 'group:binding' ), 'snapshot' );
	assert.equal( Object.prototype.propertyIsEnumerable.call( artifact, '_textureResolutionStrategies' ), false );

} );

test( 'artifact texture resolver emits safe debug-hook diagnostics', () => {

	const artifact = {};
	const previous = setTextureResolutionDebugHook( null );
	const events = [];

	try {

		assert.equal( getTextureResolutionDebugHook(), null );
		assert.throws( () => setTextureResolutionDebugHook( {} ), /function or null/ );
		setTextureResolutionDebugHook( ( event ) => events.push( event ) );
		recordTextureResolutionStrategy( artifact, 'group', 'binding', 'texture-ref', {
			sourceKind: 'artifact.texture',
			textureUuid: 'tex-a',
			resolvedTextureUuid: 'tex-live',
		} );

		assert.equal( events.length, 1 );
		assert.equal( events[ 0 ].artifact, artifact );
		assert.equal( events[ 0 ].groupName, 'group' );
		assert.equal( events[ 0 ].bindingName, 'binding' );
		assert.equal( events[ 0 ].strategy, 'texture-ref' );
		assert.equal( events[ 0 ].sourceKind, 'artifact.texture' );
		assert.equal( events[ 0 ].textureUuid, 'tex-a' );
		assert.equal( events[ 0 ].resolvedTextureUuid, 'tex-live' );

		setTextureResolutionDebugHook( () => {

			throw new Error( 'diagnostic hook failed' );

		} );
		assert.doesNotThrow( () => recordTextureResolutionStrategy( artifact, 'group', 'binding', 'shader-fallback' ) );

	} finally {

		setTextureResolutionDebugHook( previous );

	}

} );
