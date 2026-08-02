import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync( new URL( '../e2e-slim-replay-module.mjs', import.meta.url ), 'utf8' );

function sourceBetween( startNeedle, endNeedle ) {
	const start = source.indexOf( startNeedle );
	const end = source.indexOf( endNeedle, start );
	assert.ok( start >= 0 && end > start, `expected ${ startNeedle } before ${ endNeedle }` );
	return source.slice( start, end );
}

test( 'Gaussian frame diagnostics capture each live pass input and safely shared texture identity', () => {
	const helperSource = sourceBetween(
		'function __frameEffectDiagnosticValue(',
		'function __shareGraphTexturesBetweenRenderers(',
	);
	const frameDiagnostics = {};
	const debugWindow = { __TSLP_DEBUG_FRAME_TEXTURES: false };
	let ownedTextures = new Set();
	const helpers = Function(
		'window',
		'__frameEffectDiagnostics',
		'__collectDirectOwnedRenderTargetTextures',
		`"use strict";\n${ helperSource }\nreturn {
			run: __runGaussianUpdateWithFrameTextureDiagnostics,
			recordShares: __recordGaussianTextureShareDiagnostics,
		};`,
	)(
		debugWindow,
		() => frameDiagnostics,
		() => ownedTextures,
	);

	const texture = ( name, uuid, version = 1 ) => ( {
		isTexture: true,
		name,
		uuid,
		version,
		image: { width: 512, height: 512 },
	} );
	const input = texture( 'checker', 'input-uuid' );
	const horizontal = texture( 'GaussianBlurNode.horizontal', 'horizontal-uuid', 4 );
	const vertical = texture( 'GaussianBlurNode.vertical', 'vertical-uuid', 5 );
	ownedTextures = new Set( [ horizontal, vertical ] );
	const sharedHorizontal = {};
	const sharedVertical = {};
	const sourceBackend = new Map( [
		[ input, { texture: {} } ],
		[ horizontal, { texture: sharedHorizontal } ],
		[ vertical, { texture: sharedVertical } ],
	] );
	const targetBackend = new Map( [
		[ horizontal, { texture: sharedHorizontal } ],
		[ vertical, { texture: sharedVertical } ],
	] );
	const renderer = ( backendEntries, generations ) => ( {
		backend: {
			has: ( value ) => backendEntries.has( value ),
			get: ( value ) => backendEntries.get( value ),
		},
		_textures: {
			has: ( value ) => generations.has( value ),
			get: ( value ) => ( { generation: generations.get( value ) } ),
		},
	} );
	const sourceRenderer = renderer( sourceBackend, new Map( [
		[ input, 1 ],
		[ horizontal, 4 ],
		[ vertical, 5 ],
	] ) );
	const targetRenderer = renderer( targetBackend, new Map( [
		[ horizontal, 4 ],
		[ vertical, 5 ],
	] ) );

	const vectorPrototype = {
		set( x, y ) {
			this.x = x;
			this.y = y;
			return this;
		},
	};
	const passDirection = Object.assign( Object.create( vectorPrototype ), { x: 0, y: 0 } );
	const node = {
		_passDirection: { value: passDirection },
		_invSize: { value: { x: 1 / 512, y: 1 / 512 } },
		directionNode: { value: 0.5 },
		textureNode: { value: input },
	};

	let updateCalls = 0;
	assert.equal(
		helpers.run( node, sourceRenderer, 'GaussianBlurNode', () => {
			updateCalls ++;
			return 'disabled';
		} ),
		'disabled',
	);
	assert.equal( updateCalls, 1 );
	assert.equal( frameDiagnostics.gaussian, undefined, 'the existing debug flag remains the only opt-in' );

	debugWindow.__TSLP_DEBUG_FRAME_TEXTURES = true;
	const result = helpers.run( node, sourceRenderer, 'GaussianBlurNode', () => {
		passDirection.set( 1, 0 );
		node.textureNode.value = horizontal;
		passDirection.set( 0, 1 );
		node.textureNode.value = input;
		return 'rendered';
	} );
	assert.equal( result, 'rendered' );
	assert.equal( Object.hasOwn( passDirection, 'set' ), false, 'the temporary setter wrapper is removed' );
	assert.deepEqual(
		frameDiagnostics.gaussian.passes.map( ( pass ) => ( {
			pass: pass.pass,
			passDirection: pass.passDirection,
			directionNode: pass.directionNode,
			invSize: pass.invSize,
			inputUuid: pass.input.uuid,
		} ) ),
		[
			{
				pass: 'horizontal',
				passDirection: [ 1, 0 ],
				directionNode: 0.5,
				invSize: [ 1 / 512, 1 / 512 ],
				inputUuid: 'input-uuid',
			},
			{
				pass: 'vertical',
				passDirection: [ 0, 1 ],
				directionNode: 0.5,
				invSize: [ 1 / 512, 1 / 512 ],
				inputUuid: 'horizontal-uuid',
			},
		],
	);

	helpers.recordShares( node, targetRenderer, sourceRenderer, 'GaussianBlurNode' );
	assert.equal( frameDiagnostics.gaussian.shares.length, 2 );
	for ( const share of frameDiagnostics.gaussian.shares ) {
		assert.equal( share.sameGPUTexture, true );
		assert.equal( share.source.gpuTexturePresent, true );
		assert.equal( share.target.gpuTexturePresent, true );
		assert.equal( share.source.uuid, share.target.uuid );
		assert.equal( share.source.generation, share.target.generation );
	}
} );

test( 'frame texture probes use a bounded center region and report blur intermediates plus a hash', async () => {
	const probeSource = sourceBetween(
		'function __probeFrameEffectTextureAsync(',
		'function __fullBloomStrengthScale(',
	);
	const diagnostics = {};
	const debugWindow = {
		__TSLP_DEBUG_FRAME_TEXTURES: false,
		__tslpComputePending: 0,
	};
	const probe = Function(
		'window',
		'__harnessDiagnostics',
		`"use strict";\n${ probeSource }\nreturn __probeFrameEffectTextureAsync;`,
	)( debugWindow, () => diagnostics );
	const texture = {
		isTexture: true,
		name: 'GaussianBlurNode.vertical',
		image: { width: 512, height: 512 },
	};
	const calls = [];
	const sample = new Uint8Array( 64 * 64 * 4 );
	for ( let i = 3; i < sample.length; i += 4 ) sample[ i ] = 255;
	sample[ 0 ] = 128;
	sample[ 1 ] = 128;
	sample[ 2 ] = 128;
	const renderer = {
		backend: {
			copyTextureToBuffer( ...args ) {
				calls.push( args );
				return sample;
			},
		},
	};

	probe( renderer, texture, 'GaussianBlurNode.vertical', { center: true } );
	assert.equal( calls.length, 0, 'no readback occurs without the existing debug flag' );

	debugWindow.__TSLP_DEBUG_FRAME_TEXTURES = true;
	probe( renderer, texture, 'GaussianBlurNode.vertical', { center: true } );
	for ( let i = 0; i < 10 && debugWindow.__tslpComputePending > 0; i ++ ) {
		await new Promise( ( resolve ) => setImmediate( resolve ) );
	}
	assert.equal( debugWindow.__tslpComputePending, 0 );
	assert.deepEqual( calls[ 0 ].slice( 1 ), [ 224, 224, 64, 64, 0 ] );
	assert.equal( diagnostics.frameTextureProbes.length, 1 );
	const recorded = diagnostics.frameTextureProbes[ 0 ];
	assert.equal( recorded.x, 224 );
	assert.equal( recorded.y, 224 );
	assert.equal( recorded.probeWidth, 64 );
	assert.equal( recorded.probeHeight, 64 );
	assert.match( recorded.hash, /^fnv1a32:[0-9a-f]{8}$/ );
	assert.equal( recorded.intermediateRGB, 3 );
	assert.equal( recorded.intermediateRGBFraction, 3 / ( 64 * 64 * 3 ) );
} );

test( 'Gaussian replay wires the opt-in diagnostics around update, readback, and sharing', () => {
	const helper = sourceBetween(
		'function __renderFrameEffectNodeWithFullRenderer(',
		'function __renderFrameEffectNodesForPipeline(',
	);
	assert.match( helper, /__runGaussianUpdateWithFrameTextureDiagnostics\([\s\S]*__invokeFrameEffectUpdateBefore/ );
	assert.match( helper, /const centerFrameEffectReadback = effectName === 'GaussianBlurNode';/ );
	assert.match( helper, /effectName \+ '\.horizontal'/ );
	assert.match( helper, /center: centerFrameEffectReadback/ );
	const share = helper.indexOf( '__shareDirectOwnedRenderTargetTexturesBetweenRenderers(' );
	const record = helper.indexOf( '__recordGaussianTextureShareDiagnostics(', share );
	assert.ok( share >= 0 && record > share, 'identity is recorded after the full texture is shared into slim' );
} );
