import test from 'node:test';
import assert from 'node:assert/strict';

import { findRenderedSlimCompilerModules, findRenderedSlimStockAdapterModules } from '../rollup.config.js';

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

test( 'slim replay-adapter policy rejects stock lighting and manager residue', () => {

	const found = findRenderedSlimStockAdapterModules( {
		'three.webgpu.slim.js': {
			modules: {
				'/three/src/renderers/common/Lighting.js': { renderedLength: 400 },
				'/three/src/renderers/common/Background.js': { renderedLength: 700 },
				'/three/src/nodes/lighting/LightsNode.js': { renderedLength: 900 },
				'/three/src/renderers/common/nodes/NodeManager.js': { renderedLength: 800 },
				'/three/src/renderers/common/nodes/NodeBuilderState.js': { renderedLength: 600 },
				'/three/src/renderers/common/Lighting-unused.js': { renderedLength: 0 },
			},
		},
	} );

	assert.deepEqual( found.map( ( item ) => item.label ), [ 'stock LightsNode', 'stock NodeManager', 'stock Background', 'stock NodeBuilderState', 'stock Lighting' ] );

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
