import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
	SLIM_THREE_COMPILER_MODULES,
	SLIM_THREE_REPLAY_ADAPTER_MODULES,
	getSlimThreeCompilerModule,
	getSlimThreeReplayAdapterModule,
	getSlimThreeRewriteTarget,
	normalizeSlimThreeSourceModuleId,
} from '@tsl-precompile/contract/slim-three-policy';
import {
	SLIM_COMPILER_MODULE_RULES,
	SLIM_REPLAY_ADAPTER_RULES,
	findRenderedSlimCompilerModules,
	findRenderedSlimStockAdapterModules,
} from '../rollup.config.js';

test( 'scene replay adapter cannot regain the broad TSL construction barrel', () => {

	const source = readFileSync( new URL( '../src/slim-replay-scene-nodes.js', import.meta.url ), 'utf8' );
	assert.doesNotMatch( source, /three\/src\/nodes\/TSL\.js/ );

} );

test( 'Rollup consumes the shared compiler and replay-adapter rule objects', () => {

	assert.equal( SLIM_COMPILER_MODULE_RULES, SLIM_THREE_COMPILER_MODULES );
	assert.equal( SLIM_REPLAY_ADAPTER_RULES, SLIM_THREE_REPLAY_ADAPTER_MODULES );

} );

test( 'shared Three source paths normalize Vite queries and Windows ids exactly', () => {

	assert.equal(
		normalizeSlimThreeSourceModuleId( 'C:\\repo\\node_modules\\three\\src\\nodes\\core\\NodeBuilder.js?v=184#x' ),
		'nodes/core/NodeBuilder.js',
	);
	assert.equal( getSlimThreeCompilerModule( 'three/src/nodes/core/NodeBuilder.js' )?.id, 'node-builder' );
	const threeRoot = '/repo/node_modules/three/src/';
	assert.equal(
		getSlimThreeRewriteTarget( '../webgl-fallback/WebGLBackend.js', threeRoot + 'renderers/webgpu/WebGPURenderer.js' )?.id,
		'webgl-backend',
	);
	assert.equal(
		getSlimThreeCompilerModule( './renderers/common/extras/PMREMGenerator.js', threeRoot + 'Three.WebGPU.js' )?.id,
		'pmrem-generator',
	);
	assert.equal(
		getSlimThreeReplayAdapterModule( './Lighting.js', threeRoot + 'renderers/common/Renderer.js' )?.id,
		'lighting',
	);
	assert.equal( normalizeSlimThreeSourceModuleId( '/repo/not-three/src/nodes/core/NodeBuilder.js' ), null );
	assert.equal( normalizeSlimThreeSourceModuleId( '\0virtual:three/src/nodes/core/NodeBuilder.js' ), null );

} );

test( 'Rollup residue guards cover every module declared by the shared policy', () => {

	const compilerModules = Object.fromEntries( SLIM_THREE_COMPILER_MODULES.map( ( rule, index ) => [
		`/repo/node_modules/three/src/${ rule.sourcePath }`,
		{ renderedLength: index + 1 },
	] ) );
	const replayModules = Object.fromEntries( SLIM_THREE_REPLAY_ADAPTER_MODULES.map( ( rule, index ) => [
		`/repo/node_modules/three/src/${ rule.sourcePath }`,
		{ renderedLength: index + 1 },
	] ) );
	const compilerFound = findRenderedSlimCompilerModules( { chunk: { modules: compilerModules } } );
	const replayFound = findRenderedSlimStockAdapterModules( { chunk: { modules: replayModules } } );

	assert.deepEqual(
		new Set( compilerFound.map( ( item ) => item.label ) ),
		new Set( SLIM_THREE_COMPILER_MODULES.map( ( rule ) => rule.label ) ),
	);
	assert.deepEqual(
		new Set( replayFound.map( ( item ) => item.label ) ),
		new Set( SLIM_THREE_REPLAY_ADAPTER_MODULES.map( ( rule ) => rule.label ) ),
	);

} );

test( 'slim compiler classifier delegates NodeBuilderState to the replay-adapter policy', () => {

	const found = findRenderedSlimCompilerModules( {
		'three.webgpu.slim.js': {
			modules: {
				'/three/src/renderers/common/nodes/NodeBuilderState.js': { renderedLength: 2048 },
				'/three/src/nodes/core/NodeBuilder.js': { renderedLength: 0 },
			},
		},
	} );

	assert.deepEqual( found, [] );

} );

test( 'slim replay-adapter policy rejects stock lighting, scene graph, and manager residue', () => {

	const found = findRenderedSlimStockAdapterModules( {
		'three.webgpu.slim.js': {
			modules: {
				'/three/src/renderers/common/Lighting.js': { renderedLength: 400 },
				'/three/src/renderers/common/Background.js': { renderedLength: 700 },
				'/three/src/nodes/lighting/LightsNode.js': { renderedLength: 900 },
				'/three/src/nodes/fog/Fog.js': { renderedLength: 650 },
				'/three/src/renderers/common/nodes/NodeManager.js': { renderedLength: 800 },
				'/three/src/renderers/common/nodes/NodeBuilderState.js': { renderedLength: 600 },
				'/three/src/renderers/common/Lighting-unused.js': { renderedLength: 0 },
			},
		},
	} );

	assert.deepEqual( found.map( ( item ) => item.label ), [ 'stock LightsNode', 'stock NodeManager', 'stock Background', 'stock scene Fog graph', 'stock NodeBuilderState', 'stock Lighting' ] );

} );

test( 'slim compiler policy reports rendered compiler and NodeMaterial roots', () => {

	const found = findRenderedSlimCompilerModules( {
		'three.webgpu.slim.js': {
			modules: {
				'/three/src/nodes/core/NodeBuilder.js': { renderedLength: 1200 },
				'/three/src/materials/nodes/NodeMaterial.js': { renderedLength: 800 },
				'/three/src/renderers/webgpu/nodes/WGSLNodeBuilder.js': { renderedLength: 2400 },
			},
		},
	} );

	assert.deepEqual( found.map( ( item ) => item.label ), [ 'WGSLNodeBuilder', 'NodeBuilder', 'NodeMaterial' ] );

} );
