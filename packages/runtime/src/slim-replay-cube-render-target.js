/**
 * Compiler-free replay adapter for CubeRenderTarget's equirectangular
 * conversion material.
 *
 * The stock helper creates an equirectUV/texture node graph on every call.
 * Slim replay selects the artifact captured for the source texture topology,
 * clones that registry template for this conversion, and binds the live source
 * texture without retaining any graph nodes.
 */

import {
	assertCubeRenderTargetTextureEvidence,
	createCubeRenderTargetAuxConfig,
} from '@tsl-precompile/contract/cube-render-target';
import { stableJsonStringify } from '@tsl-precompile/contract/stable-json';
import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';
import PrecompiledMaterial from './_vendor-PrecompiledMaterial.js';
import {
	attachArtifactTextureRefs,
	cloneAuxArtifactForReplay,
	resolveAuxArtifactForInput,
} from './aux-loader.js';
import { hashPlainConfigSync } from './graph-hash.js';
import { RUNTIME_SLIM_THREE_PACKAGE_VERSION } from './slim-source-policy.js';

const SHAPE = 'cube-render-target';
const DEFAULT_HASH_OPTIONS = Object.freeze( {
	threeVersion: RUNTIME_SLIM_THREE_PACKAGE_VERSION,
	pluginVersion: ARTIFACT_TOOLCHAIN_VERSION,
} );

/**
 * Resolve and instantiate CubeRenderTarget's captured equirectangular
 * conversion material. Selection is exact: this adapter never falls back to
 * the only artifact registered for the shape.
 *
 * @param {Object} sourceTexture - The live equirectangular source texture.
 * @param {?Object} [cubeRenderTarget=null] - Active destination target. The
 *   rewrite always provides `this`; omission selects Three's default target
 *   topology for direct tests and private integrations.
 * @return {PrecompiledMaterial}
 */
export function createReplayCubeRenderTargetMaterial( sourceTexture, cubeRenderTarget = null ) {

	if ( ! sourceTexture || sourceTexture.isTexture !== true ) {

		throw new TypeError( 'createReplayCubeRenderTargetMaterial: a live source texture is required.' );

	}

	const config = createCubeRenderTargetAuxConfig( sourceTexture, cubeRenderTarget );
	const selection = resolveAuxArtifactForInput( SHAPE, sourceTexture, {
		computeConfigHash: ( _input, hashOptions ) => hashPlainConfigSync( config, hashOptions ),
		defaultHashOptions: DEFAULT_HASH_OPTIONS,
		allowUniqueFallback: false,
	} );
	assertReplayConfig( selection.artifact, config );
	assertCubeRenderTargetTextureEvidence( selection.artifact, null, 'createReplayCubeRenderTargetMaterial' );

	let artifact = cloneAuxArtifactForReplay( selection.artifact );
	artifact = attachArtifactTextureRefs( artifact, sourceTexture );

	const material = new PrecompiledMaterial( artifact );
	material.name = 'CubeRenderTarget.material';
	return material;

}

function assertReplayConfig( artifact, activeConfig ) {

	const capturedConfig = artifact && artifact.replayConfig;
	if ( ! capturedConfig || typeof capturedConfig !== 'object' || Array.isArray( capturedConfig ) ) {

		throw replayCubeRenderTargetError(
			'REPLAY_CUBE_RENDER_TARGET_CONFIG_REQUIRED',
			'The captured cube-render-target artifact has no replayConfig. Recapture the equirectangular conversion before replay.',
			activeConfig,
			capturedConfig,
		);

	}

	let capturedJson;
	let activeJson;
	try {

		capturedJson = stableJsonStringify( capturedConfig, 'artifact.replayConfig' );
		activeJson = stableJsonStringify( activeConfig, 'activeCubeRenderTargetConfig' );

	} catch ( cause ) {

		const error = replayCubeRenderTargetError(
			'REPLAY_CUBE_RENDER_TARGET_CONFIG_INVALID',
			'The captured cube-render-target replayConfig is not a canonical plain configuration. Recapture this conversion.',
			activeConfig,
			capturedConfig,
		);
		error.cause = cause;
		throw error;

	}

	if ( capturedJson !== activeJson ) {

		throw replayCubeRenderTargetError(
			'REPLAY_CUBE_RENDER_TARGET_CONFIG_MISMATCH',
			`Captured cube-render-target topology ${ capturedJson } does not match the active source/destination topology ${ activeJson }. ` +
			'Recapture this texture configuration before replay.',
			activeConfig,
			capturedConfig,
		);

	}

}

function replayCubeRenderTargetError( code, message, config, capturedConfig ) {

	const error = new Error( `[tsl-precompile/slim] ${ message }` );
	error.name = 'ReplayCubeRenderTargetError';
	error.code = code;
	error.config = config;
	error.capturedConfig = capturedConfig || null;
	return error;

}
