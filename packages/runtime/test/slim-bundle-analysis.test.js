import test from 'node:test';
import assert from 'node:assert/strict';

import {
	SLIM_BUNDLE_ANALYSIS_SCHEMA,
	SLIM_BUNDLE_ANALYSIS_REPORT_SCHEMA,
	analyzeSlimBundle,
	normalizeSlimBundleModuleId,
} from '../build-tools/slim-bundle-analysis.js';

test( 'slim analysis normalizes workspace and Windows module ids', () => {

	assert.notEqual( SLIM_BUNDLE_ANALYSIS_SCHEMA, SLIM_BUNDLE_ANALYSIS_REPORT_SCHEMA );
	assert.equal( normalizeSlimBundleModuleId( 'C:\\repo\\node_modules\\three\\src\\math\\Vector3.js?v=1' ), 'three/src/math/Vector3.js' );
	assert.equal( normalizeSlimBundleModuleId( '/three/src/nodes/core/Node.js' ), 'three/src/nodes/core/Node.js' );
	assert.equal( normalizeSlimBundleModuleId( '/repo/packages/runtime/src/hydrator.js' ), 'runtime/src/hydrator.js' );
	assert.equal( normalizeSlimBundleModuleId( '/repo/packages/contract/src/kinds.js' ), 'contract/src/kinds.js' );

} );

test( 'slim analysis reports policy residue, retained Nodes, and split Three identity', () => {

	const analysis = analyzeSlimBundle( {
		'entry.js': {
			modules: {
				'/repo/node_modules/three/src/nodes/core/NodeBuilder.js': { renderedLength: 1200 },
				'/repo/node_modules/three/src/nodes/math/MathNode.js': { renderedLength: 500 },
				'/repo/node_modules/three/src/materials/nodes/NodeMaterial.js': { renderedLength: 800 },
				'/repo/node_modules/three/src/renderers/common/Lighting.js': { renderedLength: 400 },
				'/repo/node_modules/three/build/three.module.js': { renderedLength: 2000 },
				'/repo/packages/runtime/src/hydrator.js': { renderedLength: 300 },
				'/repo/zero.js': { renderedLength: 0 },
			},
		},
	} );

	assert.equal( analysis.schema, SLIM_BUNDLE_ANALYSIS_SCHEMA );
	assert.equal( analysis.moduleCount, 6 );
	assert.equal( analysis.renderedBytes, 5200 );
	assert.deepEqual( analysis.compiler.modules.map( ( module ) => module.label ), [ 'NodeBuilder', 'NodeMaterial' ] );
	assert.deepEqual( analysis.stockAdapters.modules.map( ( module ) => module.label ), [ 'stock Lighting' ] );
	assert.deepEqual( analysis.retainedNodeRuntime, {
		count: 3,
		renderedBytes: 2500,
		modules: [
			{ id: 'three/src/nodes/core/NodeBuilder.js', renderedLength: 1200 },
			{ id: 'three/src/materials/nodes/NodeMaterial.js', renderedLength: 800 },
			{ id: 'three/src/nodes/math/MathNode.js', renderedLength: 500 },
		],
	} );
	assert.deepEqual( analysis.bareThreeIdentity.modules, [ { id: 'three/build/three.module.js', renderedLength: 2000 } ] );

} );

test( 'bare-only builds are not mislabeled as a split source identity', () => {

	const analysis = analyzeSlimBundle( {
		'entry.js': {
			modules: {
				'/repo/node_modules/three/build/three.module.js': { renderedLength: 2000 },
				'/repo/node_modules/three/build/three.core.js': { renderedLength: 4000 },
			},
		},
	} );
	assert.equal( analysis.bareThreeIdentity.count, 0 );

} );
