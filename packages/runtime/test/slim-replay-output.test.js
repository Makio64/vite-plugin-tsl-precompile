import test from 'node:test';
import assert from 'node:assert/strict';

import { DataArrayTexture, Material, Texture } from 'three';
import {
	createRendererOutputConfig,
	createRenderPipelineConfig,
} from '@tsl-precompile/contract/output-config';
import {
	__resetAuxRegistryForTests,
	bindAuxConfig,
	registerAuxArtifact,
} from '../src/aux-loader.js';
import { hashNodeGraphSync, hashPlainConfigSync } from '../src/graph-hash.js';
import {
	createReplayRenderOutputMaterial,
	createReplayRenderPipelineMaterial,
	getReplayRenderOutputCacheKey,
} from '../src/slim-replay-output.js';

const HASH_OPTIONS = { threeVersion: '0.184.0', pluginVersion: '0.1.0' };

function renderer( overrides = {} ) {

	return {
		toneMapping: 4,
		toneMappingExposure: 1,
		currentColorSpace: 'srgb',
		outputColorSpace: 'srgb',
		getOutputRenderTarget: () => null,
		xr: { useMultiview: () => false },
		...overrides,
	};

}

function outputArtifact( textureType = '2d', name = textureType ) {

	return {
		name,
		materialShape: 'render-output',
		vertexShader: `vertex:${ name }`,
		fragmentShader: textureType === '2d-array' ? 'var outputTexture: texture_2d_array<f32>;' : 'var outputTexture: texture_2d<f32>;',
		bindings: [],
		uniformPlan: [ {
			name: 'object',
			textures: [ {
				bindingKind: 'sampled-texture',
				name: 'outputTexture',
				textureType,
				source: { kind: 'artifact.texture', textureUuid: `captured-${ name }`, mapping: 300 },
			} ],
		} ],
	};

}

function pipelineArtifact( replayConfig, name = 'pipeline' ) {

	return {
		name,
		materialShape: 'post-process',
		replayConfig: {
			schema: replayConfig.schema,
			outputColorTransform: replayConfig.outputColorTransform,
			toneMapping: replayConfig.toneMapping,
			outputColorSpace: replayConfig.outputColorSpace,
		},
		vertexShader: `vertex:${ name }`,
		fragmentShader: `fragment:${ name }`,
		bindings: [],
		uniformPlan: [],
	};

}

function registerOutput( sourceRenderer, texture, artifact ) {

	const config = createRendererOutputConfig( sourceRenderer, texture );
	const hash = hashPlainConfigSync( config, { shape: 'render-output', ...HASH_OPTIONS } );
	registerAuxArtifact( 'render-output', hash, artifact, HASH_OPTIONS );
	return hash;

}

function registerPipeline( pipeline, artifact ) {

	const config = createRenderPipelineConfig( pipeline );
	const hash = hashNodeGraphSync( config, { shape: 'post-process', ...HASH_OPTIONS } );
	registerAuxArtifact( 'post-process', hash, artifact, HASH_OPTIONS );
	return hash;

}

test.afterEach( () => __resetAuxRegistryForTests() );

test( 'renderer output selection is exact, per-target, and exposure-independent', () => {

	const sourceRenderer = renderer();
	const captured = outputArtifact();
	const firstTexture = new Texture();
	const secondTexture = new Texture();
	registerOutput( sourceRenderer, firstTexture, captured );

	const first = createReplayRenderOutputMaterial( sourceRenderer, firstTexture );
	const second = createReplayRenderOutputMaterial( sourceRenderer, secondTexture );
	assert.equal( first.name, 'outputColorTransform' );
	assert.notEqual( first.precompiledArtifact, captured );
	assert.notEqual( first.precompiledArtifact, second.precompiledArtifact );
	assert.equal( first.precompiledArtifact._textureRefs.get( 'captured-2d' ), firstTexture );
	assert.equal( second.precompiledArtifact._textureRefs.get( 'captured-2d' ), secondTexture );
	assert.notEqual( captured._textureRefs && captured._textureRefs.get( 'captured-2d' ), firstTexture );

	const before = getReplayRenderOutputCacheKey( sourceRenderer, firstTexture );
	sourceRenderer.toneMappingExposure = 2.5;
	assert.equal( getReplayRenderOutputCacheKey( sourceRenderer, firstTexture ), before );

} );

test( 'renderer output distinguishes 2d-array topology and preserves old material on a miss', () => {

	const sourceRenderer = renderer();
	const texture2d = new Texture();
	const textureArray = new DataArrayTexture( new Uint8Array( 4 ), 1, 1, 1 );
	textureArray.isArrayTexture = true;
	registerOutput( sourceRenderer, texture2d, outputArtifact( '2d', 'flat' ) );
	registerOutput( sourceRenderer, textureArray, outputArtifact( '2d-array', 'layers' ) );

	const flat = createReplayRenderOutputMaterial( sourceRenderer, texture2d );
	const layers = createReplayRenderOutputMaterial( sourceRenderer, textureArray );
	assert.match( flat.precompiledArtifact.fragmentShader, /texture_2d</ );
	assert.match( layers.precompiledArtifact.fragmentShader, /texture_2d_array</ );

	const old = new Material();
	let disposed = 0;
	old.addEventListener( 'dispose', () => { disposed ++; } );
	sourceRenderer.currentColorSpace = 'display-p3';
	assert.throws(
		() => createReplayRenderOutputMaterial( sourceRenderer, texture2d, old ),
		( error ) => error.name === 'AuxArtifactSelectionError' && error.code === 'AUX_ARTIFACT_AMBIGUOUS',
	);
	assert.equal( disposed, 0 );

} );

test( 'renderer output rejects an artifact whose sampled binding topology lies', () => {

	const sourceRenderer = renderer();
	const texture = new Texture();
	registerOutput( sourceRenderer, texture, outputArtifact( '2d-array', 'wrong' ) );
	assert.throws(
		() => createReplayRenderOutputMaterial( sourceRenderer, texture ),
		( error ) => error.name === 'ReplayOutputError' && error.code === 'REPLAY_OUTPUT_TOPOLOGY_MISMATCH',
	);

} );

test( 'RenderPipeline selects the full config, clones artifacts, and disposes after replacement', () => {

	const outputNode = { isNode: true, graph: { value: 1 } };
	const pipeline = {
		renderer: renderer(),
		outputNode,
		outputColorTransform: true,
		_context: { renderPipeline: null },
	};
	pipeline._context.renderPipeline = pipeline;
	const config = createRenderPipelineConfig( pipeline );
	const captured = pipelineArtifact( config );
	registerPipeline( pipeline, captured );

	const old = new Material();
	let disposed = 0;
	old.addEventListener( 'dispose', () => { disposed ++; } );
	const material = createReplayRenderPipelineMaterial( pipeline, old );
	assert.equal( disposed, 1 );
	assert.equal( material.name, 'RenderPipeline' );
	assert.notEqual( material.precompiledArtifact, captured );

	const rebound = { isNode: true, graph: { value: 999 } };
	bindAuxConfig( rebound, 'post-process', captured.__tslpAuxConfigHash );
	pipeline.outputNode = rebound;
	assert.equal( createReplayRenderPipelineMaterial( pipeline ).precompiledArtifact.fragmentShader, captured.fragmentShader );

} );

test( 'RenderPipeline refuses stale output-transform metadata without disposing the live material', () => {

	const outputNode = { isNode: true, graph: { value: 1 } };
	const pipeline = { renderer: renderer(), outputNode, outputColorTransform: true };
	const captured = pipelineArtifact( createRenderPipelineConfig( pipeline ) );
	registerPipeline( pipeline, captured );

	const old = new Material();
	let disposed = 0;
	old.addEventListener( 'dispose', () => { disposed ++; } );
	pipeline.outputColorTransform = false;
	assert.throws(
		() => createReplayRenderPipelineMaterial( pipeline, old ),
		( error ) => error.name === 'ReplayOutputError' && error.code === 'REPLAY_PIPELINE_CONFIG_MISMATCH',
	);
	assert.equal( disposed, 0 );

} );

test( 'RenderPipeline requires metadata before using a unique graph-hash fallback', () => {

	const outputNode = { isNode: true, graph: { value: 1 } };
	const pipeline = { renderer: renderer(), outputNode, outputColorTransform: true };
	const legacy = pipelineArtifact( createRenderPipelineConfig( pipeline ), 'legacy' );
	delete legacy.replayConfig;
	registerAuxArtifact( 'post-process', 'legacy-hash', legacy, HASH_OPTIONS );

	assert.throws(
		() => createReplayRenderPipelineMaterial( pipeline ),
		( error ) => error.name === 'ReplayOutputError' && error.code === 'REPLAY_PIPELINE_CONFIG_REQUIRED',
	);

	bindAuxConfig( outputNode, 'post-process', 'legacy-hash' );
	assert.equal( createReplayRenderPipelineMaterial( pipeline ).precompiledArtifact.fragmentShader, legacy.fragmentShader );

} );

test( 'RenderPipeline rejects wrong-schema metadata on a unique fallback', () => {

	const outputNode = { isNode: true, graph: { value: 1 } };
	const pipeline = { renderer: renderer(), outputNode, outputColorTransform: true };
	const stale = pipelineArtifact( createRenderPipelineConfig( pipeline ), 'stale-schema' );
	stale.replayConfig.schema = 'render-pipeline@0';
	registerAuxArtifact( 'post-process', 'stale-hash', stale, HASH_OPTIONS );
	assert.throws(
		() => createReplayRenderPipelineMaterial( pipeline ),
		( error ) => error.name === 'ReplayOutputError' && error.code === 'REPLAY_PIPELINE_CONFIG_REQUIRED',
	);

} );
