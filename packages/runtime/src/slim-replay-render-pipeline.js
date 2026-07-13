/**
 * Compiler-free replay adapter for RenderPipeline's final full-screen pass.
 */

import { createRenderPipelineConfig } from '@tsl-precompile/contract/output-config';
import PrecompiledMaterial from './_vendor-PrecompiledMaterial.js';
import {
	attachPostprocessObject3DTargets,
	attachPostprocessTextureRefs,
	attachPostprocessUpdateBeforeNodes,
	cloneAuxArtifactForReplay,
	loadAux,
	resolveAuxArtifactForInput,
} from './aux-loader.js';
import { hashNodeGraphSync } from './graph-hash.js';
import { preparePrecompiledPostprocess } from './slim-support/postprocess-effects-replay.js';
import {
	DEFAULT_HASH_OPTIONS,
	disposeReplacedMaterial,
	replayOutputError,
} from './slim-replay-output-common.js';

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
