import test from 'node:test';
import assert from 'node:assert/strict';

import {
	createRendererOutputConfig,
	createRenderPipelineConfig,
} from '@tsl-precompile/contract/output-config';
import * as contract from '@tsl-precompile/contract';

test( 'output config builders are available from the contract root', () => {

	assert.equal( contract.createRendererOutputConfig, createRendererOutputConfig );
	assert.equal( contract.createRenderPipelineConfig, createRenderPipelineConfig );

} );

test( 'renderer output config captures color topology without live exposure', () => {

	const renderer = {
		toneMapping: 4,
		toneMappingExposure: 1.75,
		outputColorSpace: 'fallback-output-space',
		currentColorSpace: 'display-p3',
		getOutputRenderTarget: () => ( { multiview: false } ),
	};
	const config = createRendererOutputConfig( renderer, { isArrayTexture: false } );

	assert.deepEqual( config, {
		schema: 'renderer-output@1',
		toneMapping: 4,
		currentColorSpace: 'display-p3',
		logarithmicDepthBuffer: false,
		sampledTexture: '2d',
		multiview: false,
	} );
	assert.equal( Object.hasOwn( config, 'toneMappingExposure' ), false );

} );

test( 'renderer output config distinguishes array sampling and multiview', () => {

	const renderer = {
		toneMapping: 0,
		outputColorSpace: 'srgb',
		getOutputRenderTarget: () => ( { multiview: true } ),
	};
	assert.deepEqual( createRendererOutputConfig( renderer, { isArrayTexture: true } ), {
		schema: 'renderer-output@1',
		toneMapping: 0,
		currentColorSpace: 'srgb',
		logarithmicDepthBuffer: false,
		sampledTexture: '2d-array',
		multiview: true,
	} );

	const xrRenderer = {
		toneMapping: 0,
		currentColorSpace: 'srgb-linear',
		xr: { useMultiview: () => true },
	};
	assert.equal( createRendererOutputConfig( xrRenderer, { isArrayTexture: false } ).multiview, true );

} );

test( 'render pipeline config keeps the graph and static output transform only', () => {

	const outputNode = { isNode: true, type: 'PassTextureNode' };
	const pipeline = {
		outputNode,
		outputColorTransform: true,
		_toneMapping: 1,
		_outputColorSpace: 'stale-space',
		renderer: {
			toneMapping: 4,
			toneMappingExposure: 2.5,
			outputColorSpace: 'display-p3',
		},
	};
	const config = createRenderPipelineConfig( pipeline );

	assert.deepEqual( config, {
		schema: 'render-pipeline@1',
		outputNode,
		outputColorTransform: true,
		toneMapping: 4,
		outputColorSpace: 'display-p3',
	} );
	assert.equal( Object.hasOwn( config, 'toneMappingExposure' ), false );

} );

test( 'render pipeline config falls back to the synchronized pipeline cache', () => {

	assert.deepEqual( createRenderPipelineConfig( {
		outputNode: null,
		outputColorTransform: false,
		_toneMapping: 2,
		_outputColorSpace: 'srgb-linear',
	} ), {
		schema: 'render-pipeline@1',
		outputNode: null,
		outputColorTransform: false,
		toneMapping: 2,
		outputColorSpace: 'srgb-linear',
	} );

} );
