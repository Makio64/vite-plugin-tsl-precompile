/**
 * Compiler-free replay adapter for Renderer's output color transform.
 *
 * This module deliberately owns no RenderPipeline or postprocess behavior so
 * source-mode consumers pay only for the renderer output path they use.
 */

import { createRendererOutputConfig } from '@tsl-precompile/contract/output-config';
import PrecompiledMaterial from './_vendor-PrecompiledMaterial.js';
import {
	cloneAuxArtifactForReplay,
	resolveAuxArtifactForInput,
} from './aux-loader.js';
import { hashPlainConfigSync } from './graph-hash.js';
import {
	DEFAULT_HASH_OPTIONS,
	disposeReplacedMaterial,
	replayOutputError,
} from './slim-replay-output-common.js';

const FRAMEBUFFER_TEXTURE_MAPPING = 300;

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
		config.logarithmicDepthBuffer ? 1 : 0,
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
