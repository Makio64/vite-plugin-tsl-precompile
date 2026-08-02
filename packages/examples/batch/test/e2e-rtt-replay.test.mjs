import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync( new URL( '../e2e-slim-replay-module.mjs', import.meta.url ), 'utf8' );

test( 'owned effect target collection treats producer pass textures as leaves', () => {

	const start = source.indexOf( 'function __collectOwnedRenderTargetTextures(' );
	const end = source.indexOf( 'function __rememberRenderTargetTextureSet(', start );
	assert.ok( start >= 0 && end > start, 'expected the owned-target collector' );
	const collect = Function(
		'__isGraphTraversalCandidate',
		'__readGraphOwnValue',
		`"use strict";\n${ source.slice( start, end ) }\nreturn __collectOwnedRenderTargetTextures;`,
	)(
		() => true,
		( node, key ) => node[ key ],
	);
	const producerOutput = { isTexture: true };
	const producerDepth = { isTexture: true };
	const producerTarget = {
		setSize() {},
		texture: producerOutput,
		depthTexture: producerDepth,
		textures: [ producerOutput ],
	};
	producerOutput.renderTarget = producerTarget;
	const ownedTexture = { isTexture: true };
	const ownedTarget = {
		setSize() {},
		texture: ownedTexture,
		textures: [ ownedTexture ],
	};

	const owned = collect( { inputTexture: producerOutput, _CoCRT: ownedTarget } );
	assert.deepEqual( [ ...owned ], [ ownedTexture ] );
	assert.equal( owned.has( producerOutput ), false );
	assert.equal( owned.has( producerDepth ), false );

} );

test( 'inline RenderOutput RTTs render their complete node graph before using a generic fallback', () => {

	const fragmentHelperStart = source.indexOf( 'function __fullRTTMaterialFragmentForIdentity' );
	const start = source.indexOf( 'function __renderRTTNodeWithFullRenderer' );
	const end = source.indexOf( 'function __rttPrecompiledShape', start );
	assert.ok( fragmentHelperStart >= 0 && start > fragmentHelperStart && end > start, 'expected the RTT full-renderer replay helpers' );
	const fragmentHelper = source.slice( fragmentHelperStart, start );
	const helper = source.slice( start, end );

	assert.doesNotMatch( helper, /if \( __rttPrecompiledShape\( rttNode \) === 'render-output' \) return/ );
	assert.match( helper, /const fragmentIdentity = rttNode\._rttNode \|\| rttNode\.node;/ );
	assert.match( fragmentHelper, /fragmentIdentity\.context\( \{/ );
	assert.match( fragmentHelper, /toneMapping: slimRenderer\.toneMapping,/ );
	assert.match( fragmentHelper, /outputColorSpace: slimRenderer\.outputColorSpace,/ );
	assert.match( helper, /__refreshRTTMaterialFragmentIdentity\(/ );
	assert.doesNotMatch(
		helper,
		/ssrDependencies\.length > 0 &&\s*rttNode\.__tslpFullRTTMaterial/,
		'authored-to-prepared fragment transitions must not be limited to SSR graphs',
	);
	assert.match( helper, /return __renderRTTNodeWithPrecompiledSlim\( rttNode, slimRenderer \);/ );

} );
