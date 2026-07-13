/**
 * Compiler-free replay adapters for renderer output transforms and
 * RenderPipeline's final full-screen pass.
 *
 * These helpers are called from the slim Three source rewrite. They own
 * deterministic artifact selection, per-owner texture sidecars, topology
 * validation, and material replacement so the rewritten Three modules do not
 * grow another copy of that policy.
 */

import { REVISION } from 'three/src/constants.js';
import {
	createRendererOutputConfig,
	createRenderPipelineConfig,
} from '@tsl-precompile/contract/output-config';
import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';
import PrecompiledMaterial from './_vendor-PrecompiledMaterial.js';
import {
	attachPostprocessObject3DTargets,
	attachPostprocessTextureRefs,
	attachPostprocessUpdateBeforeNodes,
	cloneAuxArtifactForReplay,
	loadAux,
	resolveAuxArtifactForInput,
} from './aux-loader.js';
import { hashNodeGraphSync, hashPlainConfigSync } from './graph-hash.js';
import { preparePrecompiledPostprocess } from './slim-support/postprocess-effects-replay.js';

const FRAMEBUFFER_TEXTURE_MAPPING = 300;
const DEFAULT_HASH_OPTIONS = Object.freeze( {
	threeVersion: threePackageVersionFromRevision( REVISION ),
	pluginVersion: ARTIFACT_TOOLCHAIN_VERSION,
} );

/**
 * Cache identity used by Three's `_quadCache`. Exposure is intentionally
 * absent: it is a live renderer uniform and must update without rebuilding a
 * pipeline. The sampled texture dimension is shader topology, unlike the old
 * `xr.isPresenting` proxy.
 */
export function getReplayRenderOutputCacheKey( renderer, outputTexture ) {

	const config = createRendererOutputConfig( renderer, outputTexture );
	return [
		config.schema,
		config.toneMapping,
		config.currentColorSpace,
		config.sampledTexture,
		config.multiview ? 1 : 0,
	].join( ',' );

}

/**
 * Resolve and instantiate the renderer-owned output color transform.
 * Registry artifacts remain immutable templates and the previous material is
 * disposed only after the replacement is fully valid.
 */
export function createReplayRenderOutputMaterial( renderer, outputTexture, previousMaterial = null ) {

	const config = createRendererOutputConfig( renderer, outputTexture );
	const selection = resolveAuxArtifactForInput( 'render-output', outputTexture, {
		computeConfigHash: ( _input, hashOptions ) => hashPlainConfigSync( config, hashOptions ),
		defaultHashOptions: DEFAULT_HASH_OPTIONS,
		allowUniqueFallback: false,
	} );
	const artifact = cloneAuxArtifactForReplay( selection.artifact );
	const sampledSource = rendererOutputSampledSource( artifact );
	const artifactTextureType = normalizeSampledTextureType( sampledSource.entry.textureType, artifact.fragmentShader );
	if ( artifactTextureType !== config.sampledTexture ) {

		throw replayOutputError(
			'REPLAY_OUTPUT_TOPOLOGY_MISMATCH',
			`Captured render-output samples ${ artifactTextureType }, but the active renderer output is ${ config.sampledTexture }. ` +
			`Capture this output topology before replay.`,
			config,
		);

	}
	const refs = artifact._textureRefs instanceof Map ? new Map( artifact._textureRefs ) : new Map();
	refs.set( sampledSource.uuid, outputTexture );
	Object.defineProperty( artifact, '_textureRefs', {
		value: refs,
		enumerable: false,
		configurable: true,
		writable: true,
	} );

	const material = new PrecompiledMaterial( artifact );
	material.name = 'outputColorTransform';
	disposeReplacedMaterial( previousMaterial, material );
	return material;

}

/**
 * Resolve and instantiate the real captured RenderPipeline final pass. The
 * capture includes Three's context wrapper and, when enabled, its implicit
 * tone-mapping/output-color transform.
 */
export function createReplayRenderPipelineMaterial( pipeline, previousMaterial = null ) {

	if ( ! pipeline || ! pipeline.renderer || ! pipeline.outputNode ) {

		throw new TypeError( 'createReplayRenderPipelineMaterial: a RenderPipeline with renderer and outputNode is required.' );

	}
	const config = createRenderPipelineConfig( pipeline );
	const selection = resolveAuxArtifactForInput( 'post-process', pipeline.outputNode, {
		computeConfigHash: ( _input, hashOptions ) => hashNodeGraphSync( config, hashOptions ),
		defaultHashOptions: DEFAULT_HASH_OPTIONS,
	} );
	assertPipelineReplayConfig( selection.artifact, config, selection.matchedBy === 'unique' );

	preparePrecompiledPostprocess( {
		outputNode: pipeline.outputNode,
		loadAux,
		PrecompiledMaterial,
		sharedContext: pipeline._context || null,
		renderer: pipeline.renderer,
	} );

	let artifact = cloneAuxArtifactForReplay( selection.artifact );
	artifact = attachPostprocessTextureRefs( artifact, pipeline.outputNode );
	artifact = attachPostprocessUpdateBeforeNodes( artifact, pipeline.outputNode );
	let material = new PrecompiledMaterial( artifact );
	material.name = 'RenderPipeline';
	material = attachPostprocessObject3DTargets( material, pipeline.outputNode );
	disposeReplacedMaterial( previousMaterial, material );
	return material;

}

function rendererOutputSampledSource( artifact ) {

	const sources = new Map();
	for ( const group of artifact && artifact.uniformPlan || [] ) {

		for ( const entry of group.textures || [] ) {

			if ( ! entry || entry.bindingKind === 'sampler' ) continue;
			const source = entry.source || {};
			if ( source.kind !== 'artifact.texture' || ! source.textureUuid ) continue;
			if ( source.mapping !== FRAMEBUFFER_TEXTURE_MAPPING ) continue;
			sources.set( source.textureUuid, { uuid: source.textureUuid, entry } );

		}

	}
	if ( sources.size !== 1 ) {

		throw replayOutputError(
			'REPLAY_OUTPUT_TEXTURE_ROLE_AMBIGUOUS',
			`Captured render-output must expose exactly one framebuffer sampled texture; found ${ sources.size }.`,
			null,
		);

	}
	return sources.values().next().value;

}

function normalizeSampledTextureType( textureType, fragmentShader = '' ) {

	const normalized = String( textureType || '' ).toLowerCase().replace( /_/g, '-' );
	if ( normalized === '2d-array' || normalized === 'array' ) return '2d-array';
	if ( normalized === '2d' ) return '2d';
	return /texture_2d_array\s*</.test( String( fragmentShader ) ) ? '2d-array' : '2d';

}

function assertPipelineReplayConfig( artifact, activeConfig, required = false ) {

	const captured = artifact && artifact.replayConfig;
	if ( ! captured || captured.schema !== activeConfig.schema ) {

		if ( ! required ) return;
		throw replayOutputError(
			'REPLAY_PIPELINE_CONFIG_REQUIRED',
			'A RenderPipeline graph-hash miss can use a unique capture only when it carries matching renderer-output metadata. ' +
			'Recapture this pipeline or bind outputNode explicitly to a known capture.',
			activeConfig,
		);

	}
	for ( const key of [ 'outputColorTransform', 'toneMapping', 'outputColorSpace' ] ) {

		if ( captured[ key ] === activeConfig[ key ] ) continue;
		throw replayOutputError(
			'REPLAY_PIPELINE_CONFIG_MISMATCH',
			`Captured RenderPipeline ${ key }=${ JSON.stringify( captured[ key ] ) }, but replay requested ${ JSON.stringify( activeConfig[ key ] ) }. ` +
			`Capture this pipeline configuration or bind the outputNode to the intended capture.`,
			activeConfig,
		);

	}

}

function disposeReplacedMaterial( previousMaterial, replacement ) {

	if ( ! previousMaterial || previousMaterial === replacement || typeof previousMaterial.dispose !== 'function' ) return;
	previousMaterial.dispose();

}

function replayOutputError( code, message, config ) {

	const error = new Error( `[tsl-precompile/slim] ${ message }` );
	error.name = 'ReplayOutputError';
	error.code = code;
	error.config = config;
	return error;

}

function threePackageVersionFromRevision( revision ) {

	const match = String( revision || '' ).match( /\d+/ );
	return match ? `0.${ match[ 0 ] }.0` : String( revision || 'unknown' );

}
