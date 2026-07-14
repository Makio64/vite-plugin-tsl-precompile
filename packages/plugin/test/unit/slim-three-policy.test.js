import test from 'node:test';
import assert from 'node:assert/strict';

import {
	SLIM_THREE_PACKAGE_VERSION,
	SLIM_THREE_REWRITE_TARGETS,
	getSlimThreeCompilerModule,
	getSlimThreeReplayAdapterModule,
	getSlimThreeRewriteTarget,
	isSlimThreeBareBuildModule,
	isSlimThreeRetainedNodeRuntimeModule,
	isSlimThreeSourceModule,
} from '@tsl-precompile/contract/slim-three-policy';
import { isThreeRewriteTarget } from '../../src/three-rewrite.js';

test( 'Vite rewrite routing recognizes every target in the shared slim policy', () => {

	assert.match( SLIM_THREE_PACKAGE_VERSION, /^\d+\.\d+\.\d+$/ );
	for ( const target of SLIM_THREE_REWRITE_TARGETS ) {

		const posixId = `/project/node_modules/three/src/${ target.sourcePath }?import`;
		const windowsId = `C:\\project\\node_modules\\three\\src\\${ target.sourcePath.replace( /\//g, '\\' ) }#source`;
		assert.equal( getSlimThreeRewriteTarget( posixId ), target );
		assert.equal( isThreeRewriteTarget( posixId ), true, target.id );
		assert.equal( isThreeRewriteTarget( windowsId ), true, `${ target.id } (Windows)` );

	}

} );

test( 'Node core primitive rewrites are also hard stock-residue guards', () => {

	for ( const [ sourcePath, label ] of [
		[ 'nodes/core/NodeUtils.js', 'stock NodeUtils' ],
		[ 'nodes/core/constants.js', 'stock node constants' ],
	] ) {

		const id = `/project/node_modules/three/src/${ sourcePath }`;
		assert.equal( getSlimThreeRewriteTarget( id )?.sourcePath, sourcePath );
		assert.equal( getSlimThreeReplayAdapterModule( id )?.label, label );

	}

} );

test( 'compiler and broad source-residue classifiers match the installed Three layout', () => {

	assert.equal(
		getSlimThreeCompilerModule( '/project/node_modules/three/src/renderers/webgpu/nodes/StandardNodeLibrary.js' )?.label,
		'StandardNodeLibrary',
	);
	assert.equal(
		getSlimThreeCompilerModule( 'C:\\project\\node_modules\\three\\src\\nodes\\parsers\\GLSLNodeParser.js?source' )?.label,
		'GLSLNodeParser',
	);
	assert.equal( isSlimThreeSourceModule( '/project/node_modules/three/src/math/Vector3.js' ), true );
	assert.equal( isSlimThreeRetainedNodeRuntimeModule( '/project/node_modules/three/src/nodes/math/MathNode.js' ), true );
	assert.equal( isSlimThreeRetainedNodeRuntimeModule( '/project/node_modules/three/src/renderers/common/nodes/NodeLibrary.js' ), false );
	assert.equal( isSlimThreeBareBuildModule( '/project/node_modules/three/build/three.module.js' ), true );
	assert.equal( isSlimThreeBareBuildModule( '/project/node_modules/three/build/three.webgpu.js' ), false );

} );

test( 'Vite rewrite routing rejects lookalikes outside the Three source root', () => {

	assert.equal( isThreeRewriteTarget( '/project/vendor/renderers/common/Renderer.js' ), false );
	assert.equal( isThreeRewriteTarget( '/project/node_modules/three/src/renderers/common/Renderer.js.backup' ), false );
	assert.equal( isThreeRewriteTarget( '\0virtual:/three/src/renderers/common/Renderer.js' ), false );

} );
