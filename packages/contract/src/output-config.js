/**
 * Canonical configuration inputs for renderer-owned output passes.
 *
 * These descriptors contain only state that can change the generated output
 * graph. Live values such as tone-mapping exposure deliberately stay out of
 * the configuration identity and continue to flow through runtime uniforms.
 * The helpers are duck-typed so capture and compiler-free replay can share the
 * vocabulary without making the contract package depend on three.js.
 */

/**
 * Describe the graph topology used by `Renderer._renderOutput()`.
 *
 * @param {?Object} renderer
 * @param {?Object} outputTexture - Texture sampled by the output pass.
 * @return {{
 *   schema: 'renderer-output@1',
 *   toneMapping: string|number|boolean|null,
 *   currentColorSpace: string|number|boolean|null,
 *   sampledTexture: '2d'|'2d-array',
 *   multiview: boolean,
 * }}
 */
export function createRendererOutputConfig( renderer, outputTexture ) {

	const currentColorSpace = scalar( safeRead( renderer, 'currentColorSpace' ) )
		?? scalar( safeRead( renderer, 'outputColorSpace' ) );

	return {
		schema: 'renderer-output@1',
		toneMapping: scalar( safeRead( renderer, 'toneMapping' ) ),
		currentColorSpace,
		sampledTexture: safeRead( outputTexture, 'isArrayTexture' ) === true ? '2d-array' : '2d',
		multiview: rendererUsesMultiview( renderer ),
	};

}

/**
 * Describe the graph topology used by `RenderPipeline._update()`.
 *
 * The live output node remains in the descriptor so the shared graph
 * normalizer can fingerprint it together with the static output transform.
 *
 * @param {?Object} pipeline
 * @return {{
 *   schema: 'render-pipeline@1',
 *   outputNode: *,
 *   outputColorTransform: boolean,
 *   toneMapping: string|number|boolean|null,
 *   outputColorSpace: string|number|boolean|null,
 * }}
 */
export function createRenderPipelineConfig( pipeline ) {

	const renderer = safeRead( pipeline, 'renderer' );
	const toneMapping = scalar( safeRead( renderer, 'toneMapping' ) )
		?? scalar( safeRead( pipeline, '_toneMapping' ) );
	const outputColorSpace = scalar( safeRead( renderer, 'outputColorSpace' ) )
		?? scalar( safeRead( pipeline, '_outputColorSpace' ) );

	return {
		schema: 'render-pipeline@1',
		outputNode: safeRead( pipeline, 'outputNode' ) ?? null,
		outputColorTransform: safeRead( pipeline, 'outputColorTransform' ) === true,
		toneMapping,
		outputColorSpace,
	};

}

function rendererUsesMultiview( renderer ) {

	const outputTarget = safeCall( renderer, 'getOutputRenderTarget' );
	if ( safeRead( outputTarget, 'multiview' ) === true ) return true;

	const xr = safeRead( renderer, 'xr' );
	return safeCall( xr, 'useMultiview' ) === true;

}

function scalar( value ) {

	return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
		? value
		: null;

}

function safeRead( object, property ) {

	if ( ! object ) return null;
	try {

		return object[ property ];

	} catch ( _ ) {

		return null;

	}

}

function safeCall( object, method ) {

	const callback = safeRead( object, method );
	if ( typeof callback !== 'function' ) return null;
	try {

		return callback.call( object );

	} catch ( _ ) {

		return null;

	}

}
