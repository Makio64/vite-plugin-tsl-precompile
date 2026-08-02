import {
	detectArtifactShaderLanguage,
	shaderLanguageBackend,
} from '@tsl-precompile/contract/shader-language';

export function rendererShaderBackend( renderer ) {

	const backend = renderer && renderer.backend || renderer;
	if ( backend && backend.isWebGLBackend === true ) return 'webgl';
	if ( backend && backend.isWebGPUBackend === true ) return 'webgpu';
	return null;

}

export function assertArtifactShaderLanguageForRenderer( artifact, renderer ) {

	const activeBackend = rendererShaderBackend( renderer );
	if ( activeBackend === null || ! artifact || typeof artifact !== 'object' ) return;
	const shaderLanguage = artifact.shaderLanguage || detectArtifactShaderLanguage( artifact );
	const capturedBackend = shaderLanguageBackend( shaderLanguage );
	if ( capturedBackend === null || capturedBackend === activeBackend ) return;

	const error = new Error(
		`[tsl-precompile/slim] Captured ${ String( shaderLanguage ).toUpperCase() } shader artifact targets the ${ capturedBackend } backend, ` +
		`but the active WebGPURenderer uses ${ activeBackend }. Capture and register this material for the active backend.`,
	);
	error.name = 'ArtifactShaderLanguageMismatchError';
	error.code = 'TSLP_SHADER_LANGUAGE_MISMATCH';
	error.details = { shaderLanguage, capturedBackend, activeBackend };
	error.tslPrecompileShaderLanguage = true;
	throw error;

}
