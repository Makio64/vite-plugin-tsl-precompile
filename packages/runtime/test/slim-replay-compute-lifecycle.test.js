import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import ReplayNodeManager from '../src/slim-replay-node-manager.js';
import PrecompiledComputeNode from '../src/precompiled-compute-node.js';

function computeArtifact( before = [], update = [], after = [] ) {

	return {
		kind: 'compute', computeShader: 'compute', bindings: [], uniformPlan: [],
		_liveUpdateBeforeNodes: before, _liveUpdateNodes: update, _liveUpdateAfterNodes: after,
	};

}

function lifecycleNode( phase, calls ) {

	const suffix = phase === 'update' ? '' : phase === 'before' ? 'Before' : 'After';
	return {
		[ `getUpdate${ suffix }Type` ]: frame => {

			assert.ok( frame, 'native update-type hooks receive the current NodeFrame' );
			return 'object';

		},
		updateReference: frame => frame.compute,
		[ `update${ suffix }` ]: frame => calls.push( [ phase, frame.compute, frame.renderer ] ),
	};

}

async function assertNativeRendererCompute( Renderer ) {

	const calls = [];
	const node = new PrecompiledComputeNode( computeArtifact(
		[ lifecycleNode( 'before', calls ) ],
		[ lifecycleNode( 'update', calls ) ],
		[ lifecycleNode( 'after', calls ) ],
	) );
	const renderer = {
		_initialized: true, _isDeviceLost: false,
		info: { calls: 4, compute: { calls: 0, frameCalls: 0 } },
		getRenderTarget: () => null,
		backend: {
			isWebGPUBackend: true,
			updateTimeStampUID() {}, getTimestampUID: () => 1,
			beginCompute: () => calls.push( [ 'begin' ] ),
			compute: ( list, actual, bindings, pipeline, dispatchSize ) => {

				assert.equal( list, node );
				assert.equal( actual, node );
				assert.deepEqual( bindings, [] );
				assert.equal( pipeline, 'pipeline' );
				assert.deepEqual( dispatchSize, [ 2, 1, 1 ] );
				calls.push( [ 'dispatch' ] );

			},
			finishCompute: () => calls.push( [ 'finish' ] ),
		},
		inspector: { beginCompute() {}, finishCompute() {} },
	};
	const manager = new ReplayNodeManager( renderer, renderer.backend );
	renderer._updateDispatchSize = Renderer.prototype._updateDispatchSize;
	renderer._nodes = manager;
	const pipelines = new Set();
	renderer._pipelines = {
		has: compute => pipelines.has( compute ),
		getForCompute: compute => {

			assert.equal( manager.getForCompute( compute ).computeShader, 'compute' );
			pipelines.add( compute );
			calls.push( [ 'pipeline' ] );
			return 'pipeline';

		},
		delete: compute => { pipelines.delete( compute ); calls.push( [ 'delete-pipeline' ] ); },
	};
	renderer._bindings = {
		updateForCompute: () => calls.push( [ 'bindings' ] ),
		getForCompute: compute => manager.getForCompute( compute ).bindings,
		deleteForCompute: () => calls.push( [ 'delete-bindings' ] ),
	};
	node.onInit( ( { renderer: actual } ) => { assert.equal( actual, renderer ); calls.push( [ 'init' ] ); } );
	await Renderer.prototype.compileComputeAsync.call( renderer, node );
	assert.deepEqual( calls.map( call => call[ 0 ] ), [ 'init', 'before', 'update', 'bindings', 'pipeline', 'after' ] );
	const state = manager.getForCompute( node );
	assert.equal( await manager.getForComputeAsync( node ), state );
	await assert.rejects( manager.getForComputeAsync( {} ), /only PrecompiledComputeNode/ );
	calls.length = 0;
	manager.nodeFrame.renderId = 7;
	Renderer.prototype.compute.call( renderer, node, [ 2, 1, 1 ] );
	assert.deepEqual( calls.map( call => call[ 0 ] ), [ 'begin', 'before', 'update', 'bindings', 'pipeline', 'dispatch', 'after', 'finish' ] );
	for ( const call of calls.filter( call => [ 'before', 'update', 'after' ].includes( call[ 0 ] ) ) ) {

		assert.equal( call[ 1 ], node );
		assert.equal( call[ 2 ], renderer );

	}
	assert.equal( manager.nodeFrame.renderId, 7 );
	assert.equal( renderer.info.compute.calls, 1 );
	node.dispose();
	assert.equal( pipelines.size, 0 );
	assert.equal( manager.has( node ), false, 'native dispose removes hydrated state as well as its pipeline and bindings' );
	assert.deepEqual( calls.slice( - 2 ).map( call => call[ 0 ] ), [ 'delete-pipeline', 'delete-bindings' ] );
	manager.dispose();

}

test( 'actual native r186 Renderer compiles and dispatches a hydrated standalone compute lifecycle', async () => {

	const { default: Renderer } = await import( 'three/src/renderers/common/Renderer.js' );
	await assertNativeRendererCompute( Renderer );

} );

test( 'actual pinned native Renderer compiles and dispatches the same hydrated standalone compute lifecycle', { skip: ! process.env.TSLP_THREE_SOURCE_ROOT }, async () => {

	const url = pathToFileURL( resolve( process.env.TSLP_THREE_SOURCE_ROOT, 'src/renderers/common/Renderer.js' ) );
	const { default: Renderer } = await import( url.href );
	await assertNativeRendererCompute( Renderer );

} );

test( 'compute before/after callbacks match native frame ownership and reset context after nested activity', async () => {

	const { default: NativeNodeManager } = await import( 'three/src/renderers/common/nodes/NodeManager.js' );
	const renderer = { backend: {}, getRenderTarget: () => null };
	const compute = new PrecompiledComputeNode( computeArtifact() );
	for ( const Manager of [ NativeNodeManager, ReplayNodeManager ] ) {

		const manager = new Manager( renderer, renderer.backend );
		const calls = [];
		const node = {
			getUpdateBeforeType: frame => { assert.equal( frame.compute, compute ); return 'object'; },
			getUpdateAfterType: frame => { assert.equal( frame.compute, compute ); return 'object'; },
			updateReference: frame => frame.compute,
			updateBefore: frame => { calls.push( frame.compute ); manager.getNodeFrame( {}, {}, {}, {}, {} ); },
			updateAfter: frame => { calls.push( frame.compute ); manager.getNodeFrame( {}, {}, {}, {}, {} ); },
		};
		manager.getForCompute = () => ( { updateBeforeNodes: [ node, node ], updateAfterNodes: [ node, node ] } );
		manager.updateBeforeForCompute( compute );
		manager.updateAfterForCompute( compute );
		assert.deepEqual( calls, [ compute, compute, compute, compute ] );
		const frame = manager.getNodeFrameForCompute( compute );
		assert.equal( frame.renderer, renderer );
		for ( const key of [ 'scene', 'object', 'camera', 'material' ] ) assert.equal( frame[ key ], null );
		manager.getNodeFrameForRender( { renderer, scene: {}, object: {}, camera: {}, material: {} } );
		assert.equal( frame.compute, null, 'subsequent render callbacks do not retain a compute owner' );
		manager.dispose();

	}

} );

test( 'all material-owned compute phases receive the exact owner context', () => {

	const renderer = { backend: {}, getRenderTarget: () => null };
	const manager = new ReplayNodeManager( renderer, renderer.backend );
	const owner = { renderer, scene: {}, object: {}, camera: {}, material: {} };
	const calls = [];
	const callback = suffix => ( {
		[ `getUpdate${ suffix }Type` ]: () => 'object',
		updateReference: frame => frame.object,
		[ `update${ suffix }` ]: frame => {

			for ( const [ key, value ] of Object.entries( owner ) ) assert.equal( frame[ key ], value );
			assert.equal( frame.compute, compute );
			assert.equal( frame.renderObject, null );
			assert.equal( frame.lightsNode, null );
			calls.push( suffix );

		},
	} );
	const compute = new PrecompiledComputeNode( computeArtifact( [ callback( 'Before' ) ], [ callback( '' ) ], [ callback( 'After' ) ] ) );
	compute.__tslpMaterialComputeFrame = owner;
	compute.__tslpMaterialComputeOwner = owner.material;
	manager.updateBeforeForCompute( compute );
	manager.updateForCompute( compute );
	manager.updateAfterForCompute( compute );
	assert.deepEqual( calls, [ 'Before', '', 'After' ] );
	manager.dispose();

} );
