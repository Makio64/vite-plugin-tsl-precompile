/**
 * Hash-key parity test.
 *
 * CRITICAL invariant: the `configHash` that `aux-capture.js` stamps on an
 * artifact during dev capture MUST equal what `hashNodeGraphSync` produces
 * in the runtime when the Babel rewrite calls `loadAux(shape, <hash>)`.
 *
 * If these two diverge, every rewritten site misses the manifest lookup
 * at runtime and falls through to the loud-failure path. That's the
 * cheapest class of bug to prevent and the most expensive to debug.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractBackgroundArtifact } from '../../src/aux-capture.js';
import {
	computeNodeGraphHash,
	computePlainConfigHash,
	computeArtifactHash,
	computeArtifactContentHash,
} from '../../src/hash.js';
import {
	hashNodeGraphSync,
	hashPlainConfigSync,
	hashMaterialSync,
	hashArtifactContentSync,
} from '../../../runtime/src/graph-hash.js';

test( 'parity: aux-capture Background configHash === runtime hashNodeGraphSync(backgroundNode)', async () => {

	// Same factory used twice: once to extract via the capture path, once to
	// pull out the bare input node and hash it the way the runtime rewrite
	// would at render time.
	let capturedInput = null;
	const factory = ( { tsl } ) => {
		const backgroundNode = tsl.color( 0xabcdef );
		capturedInput = backgroundNode;
		return { backgroundNode, name: 'parity-test' };
	};

	const { configHash: captureHash } = await extractBackgroundArtifact( factory, {
		threeVersion: '175',
		pluginVersion: '0.0.0',
	} );

	// Runtime side: hash the same input with the SAME versions + shape.
	const runtimeHash = hashNodeGraphSync( capturedInput, {
		shape: 'background',
		threeVersion: '175',
		pluginVersion: '0.0.0',
	} );

	assert.equal( captureHash, runtimeHash, `capture and runtime must agree on configHash for identical inputs.\n  capture : ${ captureHash }\n  runtime : ${ runtimeHash }` );

} );

test( 'parity: plugin-side computeNodeGraphHash matches runtime hashNodeGraphSync on arbitrary TSL-shaped objects', () => {

	const cases = [
		{ label: 'primitive constant', node: { isConstNode: true, value: 3.14 } },
		{ label: 'uniform with color', node: { isUniformNode: true, value: { isColor: true, r: 1, g: 0.5, b: 0.25 } } },
		{ label: 'attribute', node: { isAttributeNode: true, attributeName: 'uv', nodeType: 'vec2' } },
		{ label: 'operator graph', node: {
			constructor: { type: 'OperatorNode' },
			a: { isUniformNode: true, value: { isVector3: true, x: 1, y: 2, z: 3 } },
			b: { isConstNode: true, value: 0.5 },
		} },
	];

	for ( const { label, node } of cases ) {

		const opts = { shape: 'background', threeVersion: '175', pluginVersion: '0.0.0' };
		assert.equal(
			computeNodeGraphHash( node, opts ),
			hashNodeGraphSync( node, opts ),
			`parity must hold for ${ label }`,
		);

	}

} );

test( 'parity: plain-config hashers (PMREM-style) agree across plugin and runtime', () => {

	const cfg = { kind: 'equirect', width: 2048, height: 1024, format: 1023, type: 1009 };
	const opts = { shape: 'pmrem', threeVersion: '175', pluginVersion: '0.0.0' };
	assert.equal(
		computePlainConfigHash( cfg, opts ),
		hashPlainConfigSync( cfg, opts ),
	);

} );

test( 'parity: computeArtifactHash (plugin, Node) === hashMaterialSync (runtime, browser-safe)', () => {

	// Plain-object stand-in for a three.js material — our walker only cares
	// about constructor.type/.name + keys ending in `Node`. Enough to prove
	// the two hash algorithms agree for arbitrary material-shaped input.
	const material = {
		// Simulate a typed material with `*Node` slots.
		colorNode: { isUniformNode: true, value: { isColor: true, r: 1, g: 0.5, b: 0.25 } },
		roughnessNode: { isConstNode: true, value: 0.42 },
	};
	// Fake constructor tag so both walkers see the same `material<…>` prefix.
	Object.defineProperty( material.constructor, 'name', { value: 'MeshStandardNodeMaterial' } );

	const opts = { name: 'test-mat', threeVersion: '0.175.0', pluginVersion: '0.0.0' };
	assert.equal(
		computeArtifactHash( material, opts ),
		hashMaterialSync( material, opts ),
		'plugin + runtime material-hashers must produce byte-identical output',
	);

} );

test( 'parity: material source hash excludes the separate render-context signature', () => {

	const material = {
		side: 2,
		transparent: true,
		map: { isTexture: true, uuid: 'capture-only-id', colorSpace: 'srgb', channel: 0 },
		colorNode: { isUniformNode: true, value: { isColor: true, r: 0.25, g: 0.5, b: 1 } },
	};
	const pluginOpts = {
		name: 'contextual-material',
		threeVersion: '0.184.0',
		toolchainVersion: '0.1.0',
		renderContextSignature: { shadows: [ 'Directional:pcf' ], fog: 'FogExp2', mrt: [ 'color', 'normal' ] },
	};
	const runtimeOpts = {
		...pluginOpts,
		renderContextSignature: { mrt: [ 'color', 'normal' ], fog: 'FogExp2', shadows: [ 'Directional:pcf' ] },
	};
	assert.equal( computeArtifactHash( material, pluginOpts ), hashMaterialSync( material, runtimeOpts ) );
	assert.equal(
		computeArtifactHash( material, pluginOpts ),
		computeArtifactHash( material, { ...pluginOpts, renderContextSignature: { fog: null, mrt: [] } } ),
	);

} );

test( 'parity: computeArtifactContentHash (plugin) === hashArtifactContentSync (runtime)', () => {

	const artifact = {
		vertexShader: '@vertex fn main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }',
		fragmentShader: '@fragment fn main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }',
		uniformPlan: [
			{ name: 'scene', byteLength: 128, slots: [
				{ name: 'cam', offset: 0, size: 64, dtype: 'mat4', source: { kind: 'camera.projectionMatrix' } },
				{ name: 'col', offset: 64, size: 12, dtype: 'color', source: { kind: 'material.color', property: 'color' } },
			], textures: [] },
		],
	};
	const opts = { shape: 'post-process', threeVersion: '0.175.0', pluginVersion: '0.0.0' };
	assert.equal(
		computeArtifactContentHash( artifact, opts ),
		hashArtifactContentSync( artifact, opts ),
		'plugin + runtime artifact-content hashers must agree byte-for-byte',
	);
	const withVariant = {
		...artifact,
		variants: {
			color: { vertexShader: artifact.vertexShader, fragmentShader: artifact.fragmentShader, bindings: [], uniformPlan: [] },
		},
	};
	assert.notEqual( computeArtifactContentHash( artifact, opts ), computeArtifactContentHash( withVariant, opts ) );
	assert.equal(
		computeArtifactContentHash( { ...artifact, sourceGraphHash: 'a'.repeat( 64 ) }, opts ),
		computeArtifactContentHash( { ...artifact, sourceGraphHash: 'b'.repeat( 64 ) }, opts ),
		'capture provenance is not part of runtime content identity',
	);

} );
