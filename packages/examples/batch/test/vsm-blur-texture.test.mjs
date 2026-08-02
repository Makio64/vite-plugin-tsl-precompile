import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findVsmBlurTexture } from '../vsm-blur-texture.mjs';

function texture( name ) {

	return { isTexture: true, name };

}

function analyticLightNode( light, output ) {

	return {
		isAnalyticLightNode: true,
		light,
		shadowNode: {
			node: {
				vsmShadowMapHorizontal: { texture: output },
			},
		},
	};

}

test( 'VSM blur discovery selects the exact built light from the node-builder cache', () => {

	const firstLight = { shadow: { map: {} } };
	const secondLight = { shadow: { map: {} } };
	const firstOutput = texture( 'first-moments' );
	const secondOutput = texture( 'second-moments' );
	const firstNode = analyticLightNode( firstLight, firstOutput );
	const secondNode = analyticLightNode( secondLight, secondOutput );
	const renderer = {
		_nodes: {
			nodeBuilderCache: new Map( [
				[ 'first', { updateNodes: [ firstNode ] } ],
				[ 'second', { updateBeforeNodes: new Set( [ secondNode ] ) } ],
			] ),
		},
	};

	assert.equal( findVsmBlurTexture( renderer, {}, {}, firstLight ), firstOutput );
	assert.equal( findVsmBlurTexture( renderer, {}, {}, secondLight ), secondOutput );

} );

test( 'post-render LightsNode fallback restores lights and never reuses fake-builder data across lights', () => {

	const firstLight = { id: 1, shadow: { map: {} } };
	const secondLight = { id: 2, shadow: { map: {} } };
	const firstOutput = texture( 'first-fallback-moments' );
	const secondOutput = texture( 'second-fallback-moments' );
	const lightNodes = new Map( [
		[ firstLight, analyticLightNode( firstLight, firstOutput ) ],
		[ secondLight, analyticLightNode( secondLight, secondOutput ) ],
	] );
	const restoredLights = [];
	const builderData = [];
	const lightsNode = {
		_lights: restoredLights,
		getLights() {

			return this._lights;

		},
		setLights( lights ) {

			this._lights = lights;
			return this;

		},
		getLightNodes( builder ) {

			const data = builder.getDataFromNode( this );
			builderData.push( data );
			if ( data.lightNodes === undefined ) {

				data.lightNodes = [ ...builder.context.materialLightings, ...this._lights ].map( ( light ) => lightNodes.get( light ) );

			}
			return data.lightNodes;

		},
	};
	const renderer = {
		_renderLists: {
			get: () => ( { lightsNode } ),
		},
	};

	assert.equal( findVsmBlurTexture( renderer, {}, {}, firstLight ), firstOutput );
	assert.equal( lightsNode.getLights(), restoredLights );
	assert.equal( findVsmBlurTexture( renderer, {}, {}, secondLight ), secondOutput );
	assert.equal( lightsNode.getLights(), restoredLights );
	assert.equal( builderData.length, 2 );
	assert.notEqual( builderData[ 0 ], builderData[ 1 ], 'each light receives fresh fake-builder data' );
	assert.equal( lightsNode.__tslpFakeBuilderData, undefined );

} );

test( 'layered VSM maps use their direct horizontal moments target', () => {

	const output = texture( 'layered-moments' );
	const light = {
		shadow: {
			map: {
				_vsmShadowMapHorizontal: { texture: output },
			},
		},
	};

	assert.equal( findVsmBlurTexture( null, null, null, light ), output );

} );
