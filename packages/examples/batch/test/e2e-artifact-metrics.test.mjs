import assert from 'node:assert/strict';
import test from 'node:test';

import {
	assertE2EArtifactMetricsBinding,
	bindE2EArtifactMetrics,
	computeE2EArtifactMetrics,
} from '../e2e-artifact-metrics.mjs';

test( 'artifact metrics include variants and compute kernels without double-counting aliases', () => {

	const sharedVariant = {
		materialShape: 'variant',
		vertexShader: 'v',
		fragmentShader: 'ƒ',
	};
	const computeKernel = {
		materialShape: 'compute',
		computeShader: 'compute',
	};
	const root = {
		materialShape: 'root',
		vertexShader: 'root-v',
		fragmentShader: 'root-f',
		variants: { one: sharedVariant, alias: sharedVariant },
		materialCompute: { kernels: [ { artifact: computeKernel } ] },
	};
	const metrics = computeE2EArtifactMetrics( {
		user: { first: { artifact: root } },
		aux: [ { shape: 'render-output', artifact: sharedVariant } ],
	} );
	assert.deepEqual( metrics, {
		schema: 'tslp-e2e-artifact-metrics@1',
		artifactCount: 3,
		materialCount: 2,
		totalWgslBytes: Buffer.byteLength( 'root-vroot-fvƒcompute' ),
		hasCompute: true,
		userArtifactCount: 1,
		auxArtifactCount: 1,
		shapes: [ 'render-output' ],
		materialShapes: [ 'compute', 'root', 'variant' ],
	} );

} );

test( 'artifact metrics preserve distinct byte-identical payloads', () => {

	const first = { materialShape: 'same', vertexShader: 'v', fragmentShader: 'f' };
	const second = { materialShape: 'same', vertexShader: 'v', fragmentShader: 'f' };
	const metrics = computeE2EArtifactMetrics( {
		user: {
			first: { artifact: first },
			second: { artifact: second },
		},
		aux: [],
	} );
	assert.equal( metrics.artifactCount, 2 );
	assert.equal( metrics.materialCount, 2 );
	assert.equal( metrics.totalWgslBytes, 4 );

} );

test( 'artifact metrics binding rejects descriptor and run drift', () => {

	const descriptors = {
		runId: 'run-1',
		userArtifacts: { file: 'user.json', bytes: 10, sha256: 'a'.repeat( 64 ) },
		auxArtifacts: { file: 'aux.json', bytes: 20, sha256: 'b'.repeat( 64 ) },
	};
	const metrics = bindE2EArtifactMetrics( computeE2EArtifactMetrics( { user: {}, aux: [] } ), descriptors );
	assert.equal( assertE2EArtifactMetricsBinding( metrics, descriptors ), metrics );
	assert.throws(
		() => assertE2EArtifactMetricsBinding( metrics, { ...descriptors, runId: 'run-2' } ),
		/not bound/,
	);
	assert.throws(
		() => assertE2EArtifactMetricsBinding( metrics, {
			...descriptors,
			userArtifacts: { ...descriptors.userArtifacts, sha256: 'c'.repeat( 64 ) },
		} ),
		/not bound/,
	);

} );
