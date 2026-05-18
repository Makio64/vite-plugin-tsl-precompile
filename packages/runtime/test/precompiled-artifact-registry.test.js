import { test } from 'node:test';
import assert from 'node:assert/strict';

import { registerAuxArtifact, __resetAuxRegistryForTests } from '../src/aux-loader.js';
import {
	dumpPrecompiledRegistry,
	getShadowArtifact,
	registerPrecompiledArtifacts,
	unregisterPrecompiledArtifacts,
} from '../src/_vendor-PrecompiledArtifactRegistry.js';

function artifact( cacheKey, fragmentShader ) {

	return {
		materialShape: 'shadow-depth',
		cacheKey,
		vertexShader: `vertex:${ fragmentShader }`,
		fragmentShader,
		bindings: [],
		uniformPlan: [],
	};

}

test( 'precompiled registry: shadow-depth artifacts merge cache-key variants', () => {

	unregisterPrecompiledArtifacts();
	const base = artifact( 'base-key', 'base-shadow' );
	const custom = artifact( 'custom-key', 'custom-shadow' );
	const texture = { isTexture: true, uuid: 'tex-1' };
	Object.defineProperty( custom, '_textureRefs', {
		value: new Map( [ [ 'tex-1', texture ] ] ),
		enumerable: false,
		configurable: true,
		writable: true,
	} );

	registerPrecompiledArtifacts( [ base, custom ] );

	const registered = getShadowArtifact();
	assert.equal( registered, base );
	assert.equal( registered.variants[ 'base-key' ].fragmentShader, 'base-shadow' );
	assert.equal( registered.variants[ 'custom-key' ].fragmentShader, 'custom-shadow' );
	assert.equal( registered._textureRefs.get( 'tex-1' ), texture );

} );

test( 'aux loader: shadow-depth aux entries populate the shadow registry', () => {

	__resetAuxRegistryForTests();
	const shadowArtifact = artifact( 'aux-key', 'aux-shadow' );

	registerAuxArtifact( 'shadow-depth', 'hash-shadow', shadowArtifact );

	assert.equal( getShadowArtifact(), shadowArtifact );
	assert.equal( dumpPrecompiledRegistry().defaultShadow, shadowArtifact );
	__resetAuxRegistryForTests();

} );