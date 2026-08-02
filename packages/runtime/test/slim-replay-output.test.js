import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DataArrayTexture, Material, Texture } from 'three';
import {
	createRendererOutputConfig,
	createRenderPipelineConfig,
} from '@tsl-precompile/contract/output-config';
import { SLIM_THREE_PACKAGE_VERSION } from '@tsl-precompile/contract/slim-three-policy';
import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';
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

const HASH_OPTIONS = {
	threeVersion: SLIM_THREE_PACKAGE_VERSION,
	pluginVersion: ARTIFACT_TOOLCHAIN_VERSION,
};

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
			...( replayConfig.logarithmicDepthBuffer === true ? { logarithmicDepthBuffer: true } : {} ),
			...( replayConfig.reversedDepthBuffer === true ? { reversedDepthBuffer: true } : {} ),
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

test( 'renderer output adapter does not retain RenderPipeline postprocess dependencies', () => {

	const rendererSource = readFileSync( new URL( '../src/slim-replay-renderer-output.js', import.meta.url ), 'utf8' );
	const pipelineSource = readFileSync( new URL( '../src/slim-replay-render-pipeline.js', import.meta.url ), 'utf8' );
	const compatibilitySource = readFileSync( new URL( '../src/slim-replay-output.js', import.meta.url ), 'utf8' );

	assert.doesNotMatch( rendererSource, /postprocess-effects-replay|attachPostprocess|createRenderPipelineConfig|hashNodeGraphSync/ );
	assert.match( pipelineSource, /postprocess-effects-replay/ );
	assert.match( pipelineSource, /createRenderPipelineConfig/ );
	assert.match( compatibilitySource, /slim-replay-renderer-output\.js/ );
	assert.match( compatibilitySource, /slim-replay-render-pipeline\.js/ );

} );

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

test( 'renderer output wires the live target across backend variant texture UUIDs', () => {

	const sourceRenderer = renderer();
	const texture = new Texture();
	const captured = outputArtifact( '2d', 'webgpu-root' );
	Object.assign( captured, {
		cacheKey: 'shared-output-cache',
		variantKey: 'webgpu:shared-output-cache',
		shaderLanguage: 'wgsl',
	} );
	const webgpu = structuredClone( captured );
	const webgl = outputArtifact( '2d', 'webgl-variant' );
	Object.assign( webgl, {
		cacheKey: 'shared-output-cache',
		variantKey: 'webgl:shared-output-cache',
		shaderLanguage: 'glsl',
	} );
	captured.variants = {
		[ webgl.variantKey ]: webgl,
		[ webgpu.variantKey ]: webgpu,
	};
	registerOutput( sourceRenderer, texture, captured );

	const material = createReplayRenderOutputMaterial( sourceRenderer, texture );
	assert.equal( material.precompiledArtifact._textureRefs.get( 'captured-webgpu-root' ), texture );
	assert.equal( material.precompiledArtifact._textureRefs.get( 'captured-webgl-variant' ), texture );

} );

test( 'renderer output selection and cache identity distinguish logarithmic depth', () => {

	const normalRenderer = renderer( { logarithmicDepthBuffer: false } );
	const logarithmicRenderer = renderer( { logarithmicDepthBuffer: true } );
	const texture = new Texture();
	registerOutput( normalRenderer, texture, outputArtifact( '2d', 'normal-depth' ) );
	registerOutput( logarithmicRenderer, texture, outputArtifact( '2d', 'logarithmic-depth' ) );

	assert.notEqual(
		getReplayRenderOutputCacheKey( normalRenderer, texture ),
		getReplayRenderOutputCacheKey( logarithmicRenderer, texture ),
	);
	assert.match( createReplayRenderOutputMaterial( normalRenderer, texture ).precompiledArtifact.vertexShader, /normal-depth/ );
	assert.match( createReplayRenderOutputMaterial( logarithmicRenderer, texture ).precompiledArtifact.vertexShader, /logarithmic-depth/ );

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

test( 'RenderPipeline hashes and selects normal, logarithmic, and reversed depth independently', () => {

	const makePipeline = ( depthOptions ) => ( {
		renderer: renderer( depthOptions ),
		outputNode: { isNode: true, graph: { value: 1 } },
		outputColorTransform: true,
	} );
	const pipelines = [
		[ 'normal-depth', makePipeline( {
			logarithmicDepthBuffer: false,
			reversedDepthBuffer: false,
		} ) ],
		[ 'logarithmic-depth', makePipeline( {
			logarithmicDepthBuffer: true,
			reversedDepthBuffer: false,
		} ) ],
		[ 'reversed-depth', makePipeline( {
			logarithmicDepthBuffer: false,
			reversedDepthBuffer: true,
		} ) ],
	];
	const hashes = pipelines.map( ( [ name, pipeline ] ) => {

		const artifact = pipelineArtifact( createRenderPipelineConfig( pipeline ), name );
		return registerPipeline( pipeline, artifact );

	} );

	assert.equal( new Set( hashes ).size, 3 );
	const normalConfig = createRenderPipelineConfig( pipelines[ 0 ][ 1 ] );
	assert.equal(
		hashNodeGraphSync( normalConfig, { shape: 'post-process', ...HASH_OPTIONS } ),
		hashNodeGraphSync( {
			schema: 'render-pipeline@1',
			outputNode: normalConfig.outputNode,
			outputColorTransform: normalConfig.outputColorTransform,
			toneMapping: normalConfig.toneMapping,
			outputColorSpace: normalConfig.outputColorSpace,
		}, { shape: 'post-process', ...HASH_OPTIONS } ),
		'default-depth capture keeps the legacy @1 hash',
	);

	for ( const [ name, pipeline ] of pipelines ) {

		assert.match(
			createReplayRenderPipelineMaterial( pipeline ).precompiledArtifact.fragmentShader,
			new RegExp( name ),
		);

	}

} );

test( 'RenderPipeline rejects legacy default-depth metadata for a non-default unique fallback', () => {

	const outputNode = { isNode: true, graph: { value: 1 } };
	const logarithmicPipeline = {
		renderer: renderer( { logarithmicDepthBuffer: true } ),
		outputNode,
		outputColorTransform: true,
	};
	const defaultConfig = createRenderPipelineConfig( {
		...logarithmicPipeline,
		renderer: renderer(),
	} );
	registerAuxArtifact(
		'post-process',
		'legacy-default-depth-hash',
		pipelineArtifact( defaultConfig, 'legacy-default-depth' ),
		HASH_OPTIONS,
	);

	assert.throws(
		() => createReplayRenderPipelineMaterial( logarithmicPipeline ),
		( error ) => error.name === 'ReplayOutputError' && error.code === 'REPLAY_PIPELINE_CONFIG_MISMATCH',
	);

} );

test( 'RenderPipeline accepts explicit false depth metadata but rejects malformed values', () => {

	const compatiblePipeline = {
		renderer: renderer(),
		outputNode: { isNode: true, graph: { value: 'compatible-false' } },
		outputColorTransform: true,
	};
	const compatible = pipelineArtifact( createRenderPipelineConfig( compatiblePipeline ), 'compatible-false' );
	compatible.replayConfig.logarithmicDepthBuffer = false;
	compatible.replayConfig.reversedDepthBuffer = false;
	registerPipeline( compatiblePipeline, compatible );
	assert.match(
		createReplayRenderPipelineMaterial( compatiblePipeline ).precompiledArtifact.fragmentShader,
		/compatible-false/,
	);

	const malformedPipeline = {
		renderer: renderer(),
		outputNode: { isNode: true, graph: { value: 'malformed-depth' } },
		outputColorTransform: true,
	};
	const malformed = pipelineArtifact( createRenderPipelineConfig( malformedPipeline ), 'malformed-depth' );
	malformed.replayConfig.reversedDepthBuffer = 'true';
	registerPipeline( malformedPipeline, malformed );
	assert.throws(
		() => createReplayRenderPipelineMaterial( malformedPipeline ),
		( error ) => error.name === 'ReplayOutputError' && error.code === 'REPLAY_PIPELINE_CONFIG_MISMATCH',
	);

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
