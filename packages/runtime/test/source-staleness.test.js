import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';
import { __applyPrecompiled } from '../src/apply-precompiled.js';
import { hashMaterialSync } from '../src/graph-hash.js';

const THREE_VERSION = '0.184.0';

test( '__applyPrecompiled accepts matching source metadata without hashing live uniform values', () => {

	withDetectedThreeVersion( THREE_VERSION, () => {

		const material = fakeMaterial( 0.25 );
		const module = capturedModule( material, 'fresh' );
		material.colorNode.value = 0.75;

		const adopted = __applyPrecompiled( material, module, module.__hash );
		assert.equal( adopted.isPrecompiledMaterial, true );

	} );

} );

test( '__applyPrecompiled rejects a changed material topology before adoption', () => {

	withDetectedThreeVersion( THREE_VERSION, () => {

		const material = fakeMaterial();
		const module = capturedModule( material, 'stale-topology' );
		material.map = { isTexture: true, uuid: 'runtime-random-id' };

		assert.throws(
			() => __applyPrecompiled( material, module, module.__hash ),
			/stale source graph detected.*Recapture/s,
		);
		assert.equal( material.isPrecompiledMaterial, undefined );

	} );

} );

test( '__applyPrecompiled defers auto-marked graph freshness to the build call-site gate', () => {

	withDetectedThreeVersion( THREE_VERSION, () => {

		const capturedMaterial = fakeMaterial();
		const module = capturedModule( capturedMaterial, 'auto-marked' );
		module.artifact.sourceValidationMode = 'callsite';
		const constructorStageMaterial = {
			name: 'source',
			side: 0,
			transparent: false,
			map: null,
		};

		assert.doesNotThrow( () => __applyPrecompiled( constructorStageMaterial, module, module.__hash ) );

	} );

} );

test( '__applyPrecompiled rejects incomplete or old source-hash metadata', () => {

	const material = fakeMaterial();
	const partial = capturedModule( material, 'partial' );
	delete partial.artifact.sourceGraphHash;
	assert.throws( () => __applyPrecompiled( material, partial, partial.__hash ), /incomplete source-hash metadata/ );

	const old = capturedModule( fakeMaterial(), 'old-toolchain' );
	old.artifact.sourceHashVersion = '0.0.0';
	assert.throws( () => __applyPrecompiled( fakeMaterial(), old, old.__hash ), /requires 0\.1\.0/ );

} );

test( '__applyPrecompiled rejects an artifact captured with a different exact three version', () => {

	withDetectedThreeVersion( '0.185.0', () => {

		const material = fakeMaterial();
		const module = capturedModule( material, 'three-mismatch' );
		assert.throws( () => __applyPrecompiled( material, module, module.__hash ), /captured with three 0\.184\.0.*uses three 0\.185\.0/ );

	} );

} );

function capturedModule( material, name ) {

	const sourceGraphHash = hashMaterialSync( material, {
		name,
		threeVersion: THREE_VERSION,
		toolchainVersion: ARTIFACT_TOOLCHAIN_VERSION,
		renderContextSignature: { lights: [ 'Ambient' ], shadows: false },
	} );
	return {
		__hash: `outer:${ name }`,
		name,
		artifact: {
			__hash: `outer:${ name }`,
			uniformPlan: [],
			vertexShader: 'vertex',
			fragmentShader: 'fragment',
			sourceGraphHash,
			sourceHashVersion: ARTIFACT_TOOLCHAIN_VERSION,
			sourceThreeVersion: THREE_VERSION,
			renderContextSignature: { shadows: false, lights: [ 'Ambient' ] },
		},
	};

}

function fakeMaterial( uniformValue = 0.5 ) {

	return {
		name: 'source',
		side: 0,
		transparent: false,
		map: null,
		colorNode: {
			isNode: true,
			isUniformNode: true,
			nodeType: 'float',
			value: uniformValue,
		},
	};

}

function withDetectedThreeVersion( version, callback ) {

	const previous = globalThis.__TSLP_THREE_PACKAGE_VERSION__;
	globalThis.__TSLP_THREE_PACKAGE_VERSION__ = version;
	try {

		callback();

	} finally {

		if ( previous === undefined ) delete globalThis.__TSLP_THREE_PACKAGE_VERSION__;
		else globalThis.__TSLP_THREE_PACKAGE_VERSION__ = previous;

	}

}
