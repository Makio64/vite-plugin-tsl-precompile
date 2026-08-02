import test from 'node:test';
import assert from 'node:assert/strict';

import { Texture } from 'three';
import { texture } from 'three/tsl';
import AfterImageNodeImpl from 'three/addons/tsl/display/AfterImageNode.js';

import {
	AFTERIMAGE_HISTORY_TEXTURE_NAME,
	AFTERIMAGE_OUTPUT_TEXTURE_NAME,
	AfterImageReplayResourceError,
	getAfterImageReplayTextures,
	prepareAfterImageReplayResources,
} from '../src/slim-support/afterimage-replay.js';
import {
	prepareAfterImageReplayResources as prepareFromSlimSupport,
} from '../src/slim-support/index.js';

class AfterImageNode {

	static get type() {

		return 'AfterImageNode';

	}

}

function makeTexture( name, type = 1009 ) {

	return { isTexture: true, name, type };

}

function makeRenderTarget( name ) {

	return {
		isRenderTarget: true,
		width: 1,
		height: 1,
		texture: makeTexture( name ),
	};

}

function makeFixture() {

	const node = new AfterImageNode();
	node.textureNode = { value: makeTexture( 'input', 1016 ) };
	node._oldRT = makeRenderTarget( AFTERIMAGE_HISTORY_TEXTURE_NAME );
	node._compRT = makeRenderTarget( AFTERIMAGE_OUTPUT_TEXTURE_NAME );
	node._textureNodeOld = { value: node._oldRT.texture };
	node._textureNode = { value: node._compRT.texture };
	node.getTextureNode = () => node._textureNode;

	let setSizeCalls = 0;
	let updateBeforeCalls = 0;
	node.setSize = ( width, height ) => {

		setSizeCalls ++;
		for ( const target of [ node._oldRT, node._compRT ] ) {

			target.width = width;
			target.height = height;

		}

	};
	node.updateBefore = () => {

		updateBeforeCalls ++;
		throw new Error( 'updateBefore must not run during resource preparation' );

	};

	const renderer = {
		getDrawingBufferSize( target ) {

			return target.set( 640.9, 480.9 ).floor();

		},
	};

	return {
		node,
		renderer,
		get setSizeCalls() {

			return setSizeCalls;

		},
		get updateBeforeCalls() {

			return updateBeforeCalls;

		},
	};

}

test( 'prepareAfterImageReplayResources mirrors r185 resource preflight without rendering', () => {

	const fixture = makeFixture();
	const result = prepareAfterImageReplayResources( fixture.node, fixture.renderer );

	assert.equal( prepareFromSlimSupport, prepareAfterImageReplayResources );
	assert.equal( result.inputTexture, fixture.node.textureNode.value );
	assert.equal( result.historyTexture, fixture.node._textureNodeOld.value );
	assert.equal( result.outputTexture, fixture.node._textureNode.value );
	assert.notEqual( result.historyTexture, result.outputTexture );
	assert.equal( result.width, 640 );
	assert.equal( result.height, 480 );
	assert.equal( result.textureType, 1016 );
	assert.equal( fixture.node._oldRT.texture.type, 1016 );
	assert.equal( fixture.node._compRT.texture.type, 1016 );
	assert.equal( fixture.node._oldRT.width, 640 );
	assert.equal( fixture.node._compRT.height, 480 );
	assert.equal( fixture.setSizeCalls, 1 );
	assert.equal( fixture.updateBeforeCalls, 0 );

} );

test( 'prepareAfterImageReplayResources matches the installed r185 AfterImageNode lifecycle', () => {

	const inputTexture = new Texture();
	inputTexture.type = 1016;
	const node = new AfterImageNodeImpl( texture( inputTexture ) );
	let updateBeforeCalls = 0;
	node.updateBefore = () => {

		updateBeforeCalls ++;

	};

	const result = prepareAfterImageReplayResources( node, {
		getDrawingBufferSize( target ) {

			return target.set( 640, 480 );

		},
	} );

	assert.equal( result.inputTexture, inputTexture );
	assert.equal( result.historyTexture, node._textureNodeOld.value );
	assert.equal( result.outputTexture, node.getTextureNode().value );
	assert.equal( node._oldRT.texture.type, inputTexture.type );
	assert.equal( node._compRT.texture.type, inputTexture.type );
	assert.equal( node._oldRT.width, 640 );
	assert.equal( node._compRT.height, 480 );
	assert.equal( updateBeforeCalls, 0 );

	node.dispose();

} );

test( 'getAfterImageReplayTextures preserves history/output semantics after render-target swaps', () => {

	const { node } = makeFixture();

	// This is the alias assignment and target swap performed by r185 at the
	// end of AfterImageNode.updateBefore().
	node._textureNode.value = node._compRT.texture;
	node._textureNodeOld.value = node._oldRT.texture;
	const previousOld = node._oldRT;
	node._oldRT = node._compRT;
	node._compRT = previousOld;

	const result = getAfterImageReplayTextures( node );
	assert.equal( result.historyTexture, node._compRT.texture );
	assert.equal( result.outputTexture, node._oldRT.texture );
	assert.equal( result.historyTexture.name, AFTERIMAGE_HISTORY_TEXTURE_NAME );
	assert.equal( result.outputTexture.name, AFTERIMAGE_OUTPUT_TEXTURE_NAME );
	assert.notEqual( result.historyTexture, result.outputTexture );

} );

test( 'prepareAfterImageReplayResources fails before mutation for ambiguous resources', () => {

	const cases = [
		{
			reason: 'input-texture-type-unavailable',
			change( fixture ) {

				fixture.node.textureNode.value.type = undefined;

			},
		},
		{
			reason: 'texture-aliases-collapsed',
			change( fixture ) {

				fixture.node._textureNodeOld.value = fixture.node._textureNode.value;

			},
		},
		{
			reason: 'drawing-buffer-size-unavailable',
			change( fixture ) {

				fixture.renderer.getDrawingBufferSize = null;

			},
		},
		{
			reason: 'drawing-buffer-size-invalid',
			change( fixture ) {

				fixture.renderer.getDrawingBufferSize = ( target ) => target.set( 0, -1 );

			},
		},
	];

	for ( const entry of cases ) {

		const fixture = makeFixture();
		entry.change( fixture );
		assert.throws(
			() => prepareAfterImageReplayResources( fixture.node, fixture.renderer ),
			( error ) => error instanceof AfterImageReplayResourceError
				&& error.code === 'TSLP_AFTERIMAGE_REPLAY_RESOURCES_UNAVAILABLE'
				&& error.reason === entry.reason,
			entry.reason,
		);
		assert.equal( fixture.node._oldRT.texture.type, 1009, entry.reason );
		assert.equal( fixture.node._compRT.texture.type, 1009, entry.reason );
		assert.equal( fixture.setSizeCalls, 0, entry.reason );
		assert.equal( fixture.updateBeforeCalls, 0, entry.reason );

	}

} );

test( 'prepareAfterImageReplayResources restores texture types when sizing fails', () => {

	const fixture = makeFixture();
	fixture.node.setSize = () => {

		throw new Error( 'resize failed' );

	};

	assert.throws(
		() => prepareAfterImageReplayResources( fixture.node, fixture.renderer ),
		( error ) => error instanceof AfterImageReplayResourceError
			&& error.reason === 'resource-preflight-failed'
			&& error.details.cause.message === 'resize failed',
	);
	assert.equal( fixture.node._oldRT.texture.type, 1009 );
	assert.equal( fixture.node._compRT.texture.type, 1009 );
	assert.equal( fixture.updateBeforeCalls, 0 );

} );
