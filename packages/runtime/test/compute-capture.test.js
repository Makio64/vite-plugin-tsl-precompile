import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as runtime from '../src/index.js';
import * as captureEntry from '../src/compute-capture.js';
import { precompileCompute, precompileComputes } from '../src/compute-capture.js';
import { getDevCaptureStatus } from '../src/dev-capture-outcome.js';
import { hashArtifactContentSync } from '../src/graph-hash.js';

const RUNTIME_ROOT = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );

function storageArtifact() {

	const storage = {
		name: 'positions',
		access: 'readWrite',
		arrayType: 'Float32Array',
		count: 1,
		itemSize: 4,
	};
	return {
		version: 3,
		kind: 'compute',
		cacheKey: 1,
		name: '',
		computeShader: '@compute @workgroup_size(1) fn main() {}',
		vertexShader: '',
		fragmentShader: '',
		attributes: [],
		bindings: [ {
			name: 'compute',
			bindings: [ { name: 'positions', kind: 'storage-buffer', access: 'readWrite', byteLength: 16 } ],
		} ],
		uniformPlan: [ {
			name: 'compute',
			slots: [],
			textures: [],
			storageBuffers: [ storage ],
			orderedBindings: [ { type: 'storage-buffer', ref: storage } ],
		} ],
		defaults: {},
		dispatchSize: 1,
		workgroupSize: [ 1, 1, 1 ],
		meta: { updateNodes: 0, updateBeforeNodes: 0, updateAfterNodes: 0 },
		computeBindings: {
			version: 'compute-bindings@1',
			entries: [ {
				key: 'positions',
				target: 'storage-buffer',
				group: 0,
				binding: 0,
				access: 'readWrite',
				arrayType: 'Float32Array',
				count: 1,
				itemSize: 4,
				byteLength: 16,
			} ],
		},
	};

}

function fixture() {

	const calls = { compile: [], fetch: [] };
	const fetch = async ( endpoint, request ) => {

		calls.fetch.push( { endpoint, request, payload: JSON.parse( request.body ) } );
		return { ok: true, status: 200, text: async () => '' };

	};
	const compileTSL = async ( renderer, scene, camera, options ) => {

		calls.compile.push( { renderer, scene, camera, options } );
		const artifacts = [];
		artifacts.byComputeNode = new Map( options.computeNodes.map( node => {

			const artifact = storageArtifact();
			artifacts.push( artifact );
			return [ node, artifact ];

		} ) );
		return artifacts;

	};
	return { calls, fetch, compileTSL };

}

test( 'precompileComputes extracts a named batch with exact public resource identity and signed payloads', async () => {

	const { calls, fetch, compileTSL } = fixture();
	const renderer = {};
	const scene = {};
	const camera = {};
	const first = { isNode: true, id: 'first' };
	const second = { isNode: true, id: 'second' };
	const firstResource = { isStorageBufferAttribute: true };
	const secondResource = { isStorageBufferAttribute: true };
	const captures = await precompileComputes( renderer, [
		{ name: 'compute-first', node: first, resources: { positions: firstResource } },
		{ name: 'compute-second', node: second, resources: new Map( [ [ 'positions', secondResource ] ] ) },
	], {
		scene,
		camera,
		threeVersion: '0.184.0',
		compileTSL,
		fetch,
		devEndpoint: '/capture',
	} );

	assert.equal( calls.compile.length, 1 );
	assert.deepEqual( calls.compile[ 0 ].options.computeNodes, [ first, second ] );
	assert.equal( calls.compile[ 0 ].options.computeBindingResources.get( first ).get( 'positions' ), firstResource );
	assert.equal( calls.compile[ 0 ].options.computeBindingResources.get( second ).get( 'positions' ), secondResource );
	assert.equal( calls.compile[ 0 ].options.skipWarmupRender, true );
	assert.equal( calls.fetch.length, 2 );
	assert.deepEqual( captures.map( capture => capture.name ), [ 'compute-first', 'compute-second' ] );
	for ( const capture of captures ) {

		assert.equal( capture.artifact.kind, 'compute' );
		assert.equal( capture.artifact.name, capture.name );
		assert.equal( capture.artifact.sourceThreeVersion, '0.184.0' );
		assert.equal( capture.artifact.sourceHashVersion, '0.1.0' );
		assert.match( capture.artifact.sourceGraphHash, /^[a-f0-9]{64}$/ );
		assert.equal( capture.hash, hashArtifactContentSync( capture.artifact, {
			shape: `material:${ capture.name }`,
			threeVersion: '0.184.0',
			pluginVersion: '0.1.0',
		} ) );

	}

} );

test( 'precompileCompute wraps one kernel and rejects missing extraction evidence', async () => {

	const { fetch } = fixture();
	const node = { isNode: true };
	const baseline = getDevCaptureStatus();
	await assert.rejects( precompileCompute( {}, node, {
		name: 'compute-missing',
		resources: { positions: {} },
		scene: {},
		camera: {},
		threeVersion: '0.184.0',
		fetch,
		compileTSL: async () => Object.assign( [], { byComputeNode: new Map() } ),
	} ), /returned no artifact/ );
	assert.equal( getDevCaptureStatus().failedCaptures, baseline.failedCaptures + 1 );

} );

test( 'precompileComputes fails closed on duplicate names, invalid resources, and capture errors', async () => {

	const node = { isNode: true };
	const base = { scene: {}, camera: {}, threeVersion: '0.184.0', compileTSL: async () => [] };
	await assert.rejects( precompileComputes( {}, [
		{ name: 'duplicate', node, resources: {} },
		{ name: 'duplicate', node: {}, resources: {} },
	], base ), /duplicate artifact name/ );
	await assert.rejects( precompileComputes( {}, [
		{ name: 'invalid-resources', node, resources: null },
	], base ), /resources must be a Map or plain object/ );

	const { compileTSL } = fixture();
	await assert.rejects( precompileCompute( {}, node, {
		name: 'compute-http-error',
		resources: { positions: {} },
		scene: {},
		camera: {},
		threeVersion: '0.184.0',
		compileTSL,
		fetch: async () => ( { ok: false, status: 409, text: async () => 'conflict' } ),
	} ), /409 conflict/ );

} );

test( 'compute batch keeps its pending wave open until every sibling POST settles', async () => {

	const originalWindow = globalThis.window;
	const originalPending = globalThis.__tslpPrecompilePending;
	globalThis.window = globalThis;
	globalThis.__tslpPrecompilePending = 0;
	let releaseSecond;
	const secondCanFinish = new Promise( ( resolve ) => { releaseSecond = resolve; } );
	let fetchCalls = 0;
	const { compileTSL } = fixture();
	const capture = precompileComputes( {}, [
		{ name: 'compute-fast-failure', node: { id: 'fast' }, resources: { positions: {} } },
		{ name: 'compute-slow-success', node: { id: 'slow' }, resources: { positions: {} } },
	], {
		scene: {},
		camera: {},
		threeVersion: '0.184.0',
		compileTSL,
		fetch: async () => {

			fetchCalls ++;
			if ( fetchCalls === 1 ) return { ok: false, status: 409, text: async () => 'conflict' };
			await secondCanFinish;
			return { ok: true, status: 200, text: async () => '' };

		},
	} );
	let settled = false;
	void capture.finally( () => { settled = true; } ).catch( () => {} );
	try {

		while ( fetchCalls < 2 ) await Promise.resolve();
		await Promise.resolve();
		assert.equal( globalThis.__tslpPrecompilePending, 1 );
		assert.equal( settled, false );
		releaseSecond();
		await assert.rejects( capture, /409 conflict/ );
		assert.equal( globalThis.__tslpPrecompilePending, 0 );
		assert.equal( settled, true );

	} finally {

		if ( originalWindow === undefined ) delete globalThis.window;
		else globalThis.window = originalWindow;
		if ( originalPending === undefined ) delete globalThis.__tslpPrecompilePending;
		else globalThis.__tslpPrecompilePending = originalPending;

	}

} );

test( 'compute capture entry, root export, and package metadata share one API', () => {

	assert.equal( captureEntry.precompileCompute, precompileCompute );
	assert.equal( captureEntry.precompileComputes, precompileComputes );
	assert.equal( runtime.precompileCompute, precompileCompute );
	assert.equal( runtime.precompileComputes, precompileComputes );
	const pkg = JSON.parse( readFileSync( resolve( RUNTIME_ROOT, 'package.json' ), 'utf8' ) );
	assert.deepEqual( pkg.exports[ './compute-capture' ], {
		types: './types/compute-capture.d.ts',
		default: './src/compute-capture.js',
	} );

} );
