import test from 'node:test';
import assert from 'node:assert/strict';

import {
	SLIM_BUNDLE_ANALYSIS_SCHEMA,
	SLIM_BUNDLE_ANALYSIS_REPORT_SCHEMA,
	SLIM_PREBUILT_RUNTIME_MODULE_ID,
	analyzeSlimBundle,
	normalizeSlimBundleModuleId,
} from '../build-tools/slim-bundle-analysis.js';

test( 'slim analysis normalizes workspace and Windows module ids', () => {

	assert.notEqual( SLIM_BUNDLE_ANALYSIS_SCHEMA, SLIM_BUNDLE_ANALYSIS_REPORT_SCHEMA );
	assert.equal( normalizeSlimBundleModuleId( 'C:\\repo\\node_modules\\three\\src\\math\\Vector3.js?v=1' ), 'three/src/math/Vector3.js' );
	assert.equal( normalizeSlimBundleModuleId( '/three/src/nodes/core/Node.js' ), 'three/src/nodes/core/Node.js' );
	assert.equal( normalizeSlimBundleModuleId( '/repo/packages/runtime/src/hydrator.js' ), 'runtime/src/hydrator.js' );
	assert.equal( normalizeSlimBundleModuleId( '/consumer/node_modules/@tsl-precompile/runtime/build/three.webgpu.slim.js' ), SLIM_PREBUILT_RUNTIME_MODULE_ID );
	assert.equal( normalizeSlimBundleModuleId( 'C:\\consumer\\node_modules\\@tsl-precompile\\runtime\\src\\writers.js?v=1' ), 'runtime/src/writers.js' );
	assert.equal( normalizeSlimBundleModuleId( '/repo/packages/contract/src/kinds.js' ), 'contract/src/kinds.js' );

} );

test( 'slim analysis separates one installed prebuilt runtime from source duplicates', () => {

	const analysis = analyzeSlimBundle( {
		'entry.js': {
			modules: {
				'/consumer/node_modules/@tsl-precompile/runtime/build/three.webgpu.slim.js': { renderedLength: 4000 },
				'/consumer/node_modules/@tsl-precompile/runtime/src/writers.js': { renderedLength: 0 },
				'/consumer/src/main.js': { renderedLength: 50 },
			},
		},
	} );

	assert.deepEqual( analysis.runtime.modules, [
		{ id: SLIM_PREBUILT_RUNTIME_MODULE_ID, renderedLength: 4000 },
		{ id: 'runtime/src/writers.js', renderedLength: 0 },
	] );
	assert.deepEqual( analysis.prebuiltRuntime.modules, [ { id: SLIM_PREBUILT_RUNTIME_MODULE_ID, renderedLength: 4000 } ] );
	assert.deepEqual( analysis.runtimeSource.modules, [ { id: 'runtime/src/writers.js', renderedLength: 0 } ] );

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
