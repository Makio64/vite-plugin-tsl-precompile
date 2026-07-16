import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DataTexture } from 'three/src/textures/DataTexture.js';
import StorageBufferAttribute from 'three/src/renderers/common/StorageBufferAttribute.js';
import StorageTexture from 'three/src/renderers/common/StorageTexture.js';

import { createPrecompiledComputeRunner } from '../src/precompiled-compute-runner.js';
import ReplayNodeManager from '../src/slim-replay-node-manager.js';
import * as computeEntry from '@tsl-precompile/runtime/compute';
import * as runtime from '@tsl-precompile/runtime';

const RUNTIME_ROOT = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );

function computeArtifact() {

	const positions = {
		name: 'positions',
		access: 'readWrite',
		arrayType: 'Float32Array',
		count: 1,
		itemSize: 4,
	};
	const output = {
		name: 'output',
		bindingKind: 'sampled-texture',
		textureType: '2d',
		access: 'writeOnly',
		source: { kind: 'artifact.texture', textureUuid: 'captured-output' },
	};
	const input = {
		name: 'input',
		bindingKind: 'sampled-texture',
		textureType: '2d',
		source: { kind: 'artifact.texture', textureUuid: 'captured-input' },
	};
	const sampler = {
		name: 'inputSampler',
		bindingKind: 'sampler',
		textureType: 'unknown',
		source: { kind: 'artifact.texture', textureUuid: 'captured-input' },
	};
	const threshold = {
		name: 'threshold',
		offset: 0,
		size: 4,
		dtype: 'number',
		source: { kind: 'uniform.live', valueSnapshot: { type: 'number', data: 0.25 } },
	};
	return {
		kind: 'compute',
		name: 'standalone-test',
		computeShader: '@compute @workgroup_size( 1 ) fn main() {}',
		dispatchSize: [ 4, 1, 1 ],
		workgroupSize: [ 1, 1, 1 ],
		bindings: [ {
			name: 'compute',
			bindings: [
				{ name: 'positions', kind: 'storage-buffer', access: 'readWrite', visibility: 4, byteLength: 16 },
				{ name: 'output', kind: 'sampled-texture', store: true, access: 'writeOnly', textureType: '2d', visibility: 4, byteLength: null },
				{ name: 'input', kind: 'sampled-texture', store: false, access: null, textureType: '2d', visibility: 4, byteLength: null },
				{ name: 'inputSampler', kind: 'sampler', visibility: 4, byteLength: null },
				{ name: 'compute', kind: 'uniform-buffer', visibility: 4, byteLength: 16 },
			],
		} ],
		uniformPlan: [ {
			name: 'compute',
			shared: false,
			byteLength: 16,
			slots: [ threshold ],
			textures: [ output, input, sampler ],
			storageBuffers: [ positions ],
			orderedBindings: [
				{ type: 'storage-buffer', ref: positions },
				{ type: 'sampled-texture', ref: output },
				{ type: 'sampled-texture', ref: input },
				{ type: 'sampler', ref: sampler },
				{ type: 'ubo', name: 'compute', slots: [ threshold ] },
			],
		} ],
		computeBindings: {
			version: 'compute-bindings@1',
			entries: [
				{ key: 'input', target: 'sampled-texture', group: 0, binding: 2, textureType: '2d' },
				{ key: 'input', target: 'sampler', group: 0, binding: 3 },
				{ key: 'output', target: 'storage-texture', group: 0, binding: 1, access: 'writeOnly', textureType: '2d' },
				{ key: 'positions', target: 'storage-buffer', group: 0, binding: 0, access: 'readWrite', arrayType: 'Float32Array', count: 1, itemSize: 4, byteLength: 16 },
				{ key: 'threshold', target: 'uniform-slot', group: 0, slot: 0, dtype: 'number' },
			],
		},
	};

}

function resources() {

	return {
		input: new DataTexture( new Uint8Array( [ 1, 2, 3, 4 ] ), 1, 1 ),
		output: new StorageTexture( 4, 4 ),
		positions: new StorageBufferAttribute( new Float32Array( [ 1, 2, 3, 4 ] ), 4 ),
		threshold: { value: 0.75 },
	};

}

function rendererSpy() {

	const calls = [];
	return {
		__TSLP_SLIM__: true,
		calls,
		compute( ...args ) {

			calls.push( [ 'sync', ...args ] );
			return 'sync-result';

		},
		computeAsync( ...args ) {

			calls.push( [ 'async', ...args ] );
			return Promise.resolve( 'async-result' );

		},
	};

}

function deepFreeze( value, seen = new Set() ) {

	if ( ! value || typeof value !== 'object' || seen.has( value ) ) return value;
	seen.add( value );
	for ( const key of Reflect.ownKeys( value ) ) deepFreeze( value[ key ], seen );
	return Object.freeze( value );

}

test( 'standalone compute runner binds caller-owned buffer, textures, sampler, and mutable uniform slots', () => {

	const artifact = computeArtifact();
	const boundResources = resources();
	let updateCalls = 0;
	const updateGroup = ( _frame, _material, view ) => {

		updateCalls ++;
		view.setFloat32( 0, - 1, true );

	};
	const renderer = rendererSpy();
	const runner = createPrecompiledComputeRunner( renderer, { artifact, updateGroup }, boundResources );
	const manager = new ReplayNodeManager( renderer, {} );
	const state = manager.getForCompute( runner.node );
	const group = state.bindings[ 0 ];

	assert.equal( group.bindings[ 0 ].attribute, boundResources.positions );
	assert.equal( group.bindings[ 1 ].texture, boundResources.output );
	assert.equal( group.bindings[ 1 ].store, true );
	assert.equal( group.bindings[ 1 ].access, 'writeOnly' );
	assert.equal( group.bindings[ 2 ].texture, boundResources.input );
	assert.equal( group.bindings[ 3 ].texture, boundResources.input, 'sampled texture and sampler share the caller texture identity' );

	manager.updateForCompute( runner.node );
	const uniformView = new DataView( group.bindings[ 4 ].buffer.buffer );
	assert.equal( uniformView.getFloat32( 0, true ), 0.75, 'the caller uniform overlays the generated updater' );
	boundResources.threshold.value = 0.5;
	manager.updateForCompute( runner.node );
	assert.equal( uniformView.getFloat32( 0, true ), 0.5, 'mutable uniform holders are read for every dispatch update' );
	assert.equal( updateCalls, 2, 'generated module updateGroup is attached to the local artifact' );

} );

test( 'standalone compute runner accepts frozen raw artifacts without mutating emitted data', () => {

	const artifact = deepFreeze( computeArtifact() );
	const module = Object.freeze( {
		artifact,
		updateGroup() {},
	} );
	const runner = createPrecompiledComputeRunner( rendererSpy(), module, resources() );

	assert.notEqual( runner.artifact, artifact );
	assert.equal( runner.node.precompiledArtifact, runner.artifact );
	assert.notEqual( runner.artifact.bindings[ 0 ].bindings[ 0 ], artifact.bindings[ 0 ].bindings[ 0 ] );
	assert.notEqual( runner.artifact.uniformPlan[ 0 ].slots[ 0 ], artifact.uniformPlan[ 0 ].slots[ 0 ] );
	assert.equal( Object.prototype.hasOwnProperty.call( artifact, '_generatedUpdateGroup' ), false );
	assert.equal( Object.prototype.hasOwnProperty.call( artifact.uniformPlan[ 0 ].slots[ 0 ], '_liveNode' ), false );
	assert.equal( Object.prototype.hasOwnProperty.call( artifact, '_textureRefs' ), false );
	assert.equal( artifact.uniformPlan[ 0 ].textures[ 0 ].source.textureUuid, 'captured-output' );
	assert.equal( runner.artifact.uniformPlan[ 0 ].textures[ 0 ].source.textureUuid, runner.resources.output.uuid );
	assert.equal( runner.artifact._textureRefs instanceof Map, true );
	assert.equal( typeof runner.artifact._generatedUpdateGroup, 'function' );

} );

test( 'standalone compute runner forwards default and override dispatches and disposes only its node', async () => {

	const renderer = rendererSpy();
	const boundResources = resources();
	let resourceDisposals = 0;
	boundResources.input.dispose = () => { resourceDisposals ++; };
	boundResources.output.dispose = () => { resourceDisposals ++; };
	const runner = createPrecompiledComputeRunner( renderer, computeArtifact(), boundResources );
	let nodeDisposals = 0;
	runner.node.addEventListener( 'dispose', () => { nodeDisposals ++; } );

	assert.equal( runner.dispatch(), 'sync-result' );
	assert.equal( runner.dispatch( [ 2, 3, 4 ] ), 'sync-result' );
	assert.equal( await runner.dispatchAsync(), 'async-result' );
	assert.equal( await runner.dispatchAsync( 128 ), 'async-result' );
	assert.deepEqual( renderer.calls.map( ( call ) => call.slice( 0, 1 ) ), [ [ 'sync' ], [ 'sync' ], [ 'async' ], [ 'async' ] ] );
	assert.deepEqual( renderer.calls[ 0 ], [ 'sync', runner.node ] );
	assert.deepEqual( renderer.calls[ 1 ], [ 'sync', runner.node, [ 2, 3, 4 ] ] );
	assert.deepEqual( renderer.calls[ 2 ], [ 'async', runner.node ] );
	assert.deepEqual( renderer.calls[ 3 ], [ 'async', runner.node, 128 ] );

	runner.dispose();
	runner.dispose();
	assert.equal( runner.disposed, true );
	assert.equal( nodeDisposals, 1 );
	assert.equal( resourceDisposals, 0, 'caller-owned resources are never disposed by the runner' );
	assert.throws( () => runner.dispatch(), ( error ) => error.code === 'TSLP_COMPUTE_RUNNER_DISPOSED' );
	await assert.rejects( async () => runner.dispatchAsync(), ( error ) => error.code === 'TSLP_COMPUTE_RUNNER_DISPOSED' );

} );

test( 'standalone compute runner fails closed on missing, unknown, and mismatched resources', () => {

	const artifact = computeArtifact();
	const renderer = rendererSpy();
	const valid = resources();
	const without = ( key ) => Object.fromEntries( Object.entries( valid ).filter( ( [ name ] ) => name !== key ) );

	assert.throws(
		() => createPrecompiledComputeRunner( renderer, artifact, without( 'positions' ) ),
		( error ) => error.code === 'TSLP_COMPUTE_RESOURCE_MISSING' && /positions/.test( error.message ),
	);
	assert.throws(
		() => createPrecompiledComputeRunner( renderer, artifact, { ...valid, extra: 1 } ),
		( error ) => error.code === 'TSLP_COMPUTE_RESOURCE_UNKNOWN' && /extra/.test( error.message ),
	);
	assert.throws(
		() => createPrecompiledComputeRunner( renderer, artifact, {
			...valid,
			positions: new StorageBufferAttribute( new Float32Array( [ 1, 2, 3 ] ), 3 ),
		} ),
		( error ) => error.code === 'TSLP_COMPUTE_RESOURCE_MISMATCH' && /itemSize must be 4/.test( error.message ),
		'padded vec4 storage layouts must not silently accept logical vec3 attributes',
	);
	assert.throws(
		() => createPrecompiledComputeRunner( renderer, artifact, { ...valid, output: valid.input } ),
		( error ) => error.code === 'TSLP_COMPUTE_RESOURCE_MISMATCH' && /StorageTexture/.test( error.message ),
	);
	assert.throws(
		() => createPrecompiledComputeRunner( renderer, artifact, { ...valid, threshold: '0.5' } ),
		( error ) => error.code === 'TSLP_COMPUTE_RESOURCE_MISMATCH' && /finite number/.test( error.message ),
	);

} );

test( 'standalone compute runner rejects malformed descriptors and non-slim renderers', () => {

	const artifact = computeArtifact();
	artifact.computeBindings.version = 'compute-bindings@0';
	assert.throws(
		() => createPrecompiledComputeRunner( rendererSpy(), artifact, resources() ),
		( error ) => error.code === 'TSLP_COMPUTE_BINDINGS_INVALID' && /compute-bindings@1/.test( error.message ),
	);
	assert.throws(
		() => createPrecompiledComputeRunner( { compute() {}, computeAsync() {} }, computeArtifact(), resources() ),
		( error ) => error.code === 'TSLP_COMPUTE_RENDERER_INVALID',
	);

} );

test( 'standalone compute entry, root export, package metadata, and implementation share one runner', () => {

	assert.equal( computeEntry.createPrecompiledComputeRunner, createPrecompiledComputeRunner );
	assert.equal( runtime.createPrecompiledComputeRunner, createPrecompiledComputeRunner );
	const pkg = JSON.parse( readFileSync( resolve( RUNTIME_ROOT, 'package.json' ), 'utf8' ) );
	assert.deepEqual( pkg.exports[ './compute' ], {
		types: './types/precompiled-compute-runner.d.ts',
		default: './src/precompiled-compute-runner.js',
	} );

} );
