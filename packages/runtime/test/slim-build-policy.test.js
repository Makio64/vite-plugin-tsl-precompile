import test from 'node:test';
import assert from 'node:assert/strict';

import { findRenderedSlimCompilerModules } from '../rollup.config.js';

test( 'slim compiler policy ignores runtime NodeBuilderState carriers', () => {

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
