import { collectArtifactVariantCandidates } from './artifact-variants.js';

/**
 * Canonical input topology for CubeRenderTarget.fromEquirectangularTexture().
 *
 * The helper is intentionally duck-typed so full Three capture and the slim
 * runtime can hash the same source texture without importing Three here.
 * Resource identity, image contents, and dimensions stay live; only fields
 * that can change WGSL, sampled-texture bindings, or sampler state are signed.
 */

export const CUBE_RENDER_TARGET_AUX_CONFIG_SCHEMA = 'cube-render-target@1';

// Three r185 forces these effective source states inside
// fromEquirectangularTexture() before CubeCamera renders. The config helper is
// called at different points by offline and rewritten paths, so canonicalize
// the effective draw state instead of signing the caller's pre-call values.
const LINEAR_FILTER = 1006;
const LINEAR_MIPMAP_LINEAR_FILTER = 1008;
const RGBA_FORMAT = 1023;

/**
 * Describe the color 2D source sampled by Three's fixed
 * `texture( source, equirectUV( positionWorldDirection ), 0 )` graph.
 *
 * @param {Object} texture
 * @param {?Object} [cubeRenderTarget=null] - Destination target. Omit for
 *   Three's default CubeRenderTarget topology.
 * @return {{
 *   schema: 'cube-render-target@1',
 *   dimension: '2d',
 *   type: string|number|boolean|null,
 *   format: string|number|boolean|null,
 *   internalFormat: string|number|boolean|null,
 *   colorSpace: string|number|boolean|null,
 *   mapping: string|number|boolean|null,
 *   sampler: {
 *     minFilter: string|number|boolean|null,
 *     magFilter: string|number|boolean|null,
 *     wrapS: string|number|boolean|null,
 *     wrapT: string|number|boolean|null,
 *     anisotropy: string|number|boolean|null,
 *     compareFunction: string|number|boolean|null,
 *     generateMipmaps: boolean,
 *   },
 *   depth: boolean,
 *   renderTarget: boolean,
 *   framebuffer: boolean,
 *   storage: boolean,
 *   target: {
 *     format: string|number|boolean|null,
 *     internalFormat: string|number|boolean|null,
 *     colorCount: number,
 *     sampleCount: number,
 *     depth: boolean,
 *     stencil: boolean,
 *     resolveDepth: boolean,
 *     resolveStencil: boolean,
 *     multiview: boolean,
 *     depthTexture: null|{format: *, internalFormat: *, type: *},
 *   },
 * }}
 */
export function createCubeRenderTargetAuxConfig( texture, cubeRenderTarget = null ) {

	if ( ! texture || typeof texture !== 'object' || readFlag( texture, 'isTexture' ) !== true ) {

		throw new TypeError( 'createCubeRenderTargetAuxConfig: expected a Three Texture' );

	}

	assertSupported2DTexture( texture );
	const target = describeCubeDestination( cubeRenderTarget );

	return {
		schema: CUBE_RENDER_TARGET_AUX_CONFIG_SCHEMA,
		dimension: '2d',
		type: readScalar( texture, 'type' ),
		format: readScalar( texture, 'format' ),
		internalFormat: readScalar( texture, 'internalFormat' ),
		colorSpace: readScalar( texture, 'colorSpace' ),
		mapping: readScalar( texture, 'mapping' ),
		sampler: {
			minFilter: effectiveMinFilter( readScalar( texture, 'minFilter' ) ),
			magFilter: readScalar( texture, 'magFilter' ),
			wrapS: readScalar( texture, 'wrapS' ),
			wrapT: readScalar( texture, 'wrapT' ),
			anisotropy: readScalar( texture, 'anisotropy' ),
			compareFunction: readScalar( texture, 'compareFunction' ),
			generateMipmaps: true,
		},
		depth: false,
		renderTarget: readBoolean( texture, 'isRenderTargetTexture' ),
		framebuffer: readBoolean( texture, 'isFramebufferTexture' ),
		storage: readBoolean( texture, 'isStorageTexture' ),
		target,
	};

}

/**
 * Assert that every captured variant samples exactly one serialized
 * `artifact.texture` identity. Capture can additionally require that identity
 * to be the exact source UUID; replay omits `expectedTexture` and safely
 * rewires the one validated domain to its live source.
 *
 * @param {Object} artifact
 * @param {Object|string|null} [expectedTexture=null]
 * @param {string} [owner='cube-render-target']
 * @return {Set<string>}
 */
export function assertCubeRenderTargetTextureEvidence( artifact, expectedTexture = null, owner = 'cube-render-target' ) {

	const expectedUuid = typeof expectedTexture === 'string'
		? expectedTexture
		: expectedTexture && expectedTexture.uuid;
	if ( expectedTexture !== null && ( typeof expectedUuid !== 'string' || expectedUuid.length === 0 ) ) {

		throw new TypeError( `${ owner }: source texture must expose a stable uuid` );

	}
	const allTextureUuids = new Set();
	for ( const candidate of collectArtifactVariantCandidates( artifact ) ) {

		const textureUuids = new Set();
		let malformedUuid = false;
		for ( const group of candidate.uniformPlan || [] ) {

			for ( const entry of [ ...( group.slots || [] ), ...( group.textures || [] ) ] ) {

				const source = entry && entry.source;
				if ( ! source || source.kind !== 'artifact.texture' ) continue;
				if ( typeof source.textureUuid !== 'string' || source.textureUuid.length === 0 ) malformedUuid = true;
				else textureUuids.add( source.textureUuid );

			}

		}
		const exactExpected = expectedUuid === undefined || expectedUuid === null || textureUuids.has( expectedUuid );
		if ( malformedUuid || textureUuids.size !== 1 || ! exactExpected ) {

			const actual = malformedUuid ? [ ...textureUuids, '<missing>' ] : [ ...textureUuids ];
			throw new Error(
				`${ owner }: artifact.texture UUID domain ${ JSON.stringify( actual.sort() ) } ` +
				( expectedUuid ? `does not exactly match source ${ JSON.stringify( expectedUuid ) }` : 'must contain exactly one source texture' ),
			);

		}
		for ( const uuid of textureUuids ) allTextureUuids.add( uuid );

	}
	if ( allTextureUuids.size !== 1 ) {

		throw new Error(
			`${ owner }: artifact family artifact.texture UUID domain ${ JSON.stringify( [ ...allTextureUuids ].sort() ) } ` +
			'must contain exactly one source texture',
		);

	}
	return allTextureUuids;

}

function describeCubeDestination( target ) {

	if ( target !== null && target !== undefined && safeRead( target, 'isCubeRenderTarget' ) !== true ) {

		throw new TypeError( 'createCubeRenderTargetAuxConfig: destination must be a CubeRenderTarget' );

	}
	const texture = target && safeRead( target, 'texture' );
	const textures = target && safeRead( target, 'textures' );
	const rawSamples = target ? readFiniteNumberDefault( target, 'samples', 0 ) : 0;
	return {
		// fromEquirectangularTexture copies type/colorSpace/filter topology from
		// the source. Format and the remaining attachment axes stay owned by the
		// destination constructor and can select a different WebGPU pipeline.
		format: texture ? readScalar( texture, 'format' ) : RGBA_FORMAT,
		internalFormat: texture ? readScalar( texture, 'internalFormat' ) : null,
		colorCount: Array.isArray( textures ) ? textures.length : 1,
		sampleCount: rawSamples >= 4 ? 4 : 1,
		depth: readBooleanDefault( target, 'depthBuffer', true ),
		stencil: readBooleanDefault( target, 'stencilBuffer', false ),
		resolveDepth: readBooleanDefault( target, 'resolveDepthBuffer', true ),
		resolveStencil: readBooleanDefault( target, 'resolveStencilBuffer', true ),
		multiview: readBooleanDefault( target, 'multiview', false ),
		depthTexture: describeDepthAttachment( target && safeRead( target, 'depthTexture' ) ),
	};

}

function describeDepthAttachment( texture ) {

	if ( ! texture ) return null;
	return {
		format: readScalar( texture, 'format' ),
		internalFormat: readScalar( texture, 'internalFormat' ),
		type: readScalar( texture, 'type' ),
	};

}

function readBooleanDefault( owner, property, fallback ) {

	if ( ! owner ) return fallback;
	const value = safeRead( owner, property );
	if ( value === undefined || value === null ) return fallback;
	if ( typeof value !== 'boolean' ) {

		throw new TypeError( `createCubeRenderTargetAuxConfig: destination.${ property } must be boolean` );

	}
	return value;

}

function readFiniteNumberDefault( owner, property, fallback ) {

	const value = safeRead( owner, property );
	if ( value === undefined || value === null ) return fallback;
	if ( typeof value !== 'number' || ! Number.isFinite( value ) || value < 0 ) {

		throw new TypeError( `createCubeRenderTargetAuxConfig: destination.${ property } must be a non-negative finite number` );

	}
	return value;

}

function effectiveMinFilter( minFilter ) {

	return minFilter === LINEAR_MIPMAP_LINEAR_FILTER ? LINEAR_FILTER : minFilter;

}

function assertSupported2DTexture( texture ) {

	if ( readBoolean( texture, 'isDepthTexture' ) ) {

		throw new TypeError( 'createCubeRenderTargetAuxConfig: depth texture sources are not supported' );

	}

	for ( const [ flag, dimension ] of [
		[ 'isCubeTexture', 'cube' ],
		[ 'isCompressedCubeTexture', 'cube' ],
		[ 'isDataArrayTexture', '2d-array' ],
		[ 'isCompressedArrayTexture', '2d-array' ],
		[ 'isArrayTexture', '2d-array' ],
		[ 'isData3DTexture', '3d' ],
		[ 'is3DTexture', '3d' ],
	] ) {

		if ( readBoolean( texture, flag ) ) {

			throw new TypeError( `createCubeRenderTargetAuxConfig: expected a 2D texture, received ${ dimension }` );

		}

	}

	for ( const flag of [ 'isVideoTexture', 'isVideoFrameTexture', 'isExternalTexture' ] ) {

		if ( readBoolean( texture, flag ) ) {

			throw new TypeError( `createCubeRenderTargetAuxConfig: ${ flag } sources are not supported` );

		}

	}

}

function readScalar( texture, property ) {

	const value = safeRead( texture, property );
	if ( value === undefined || value === null ) return null;
	if ( typeof value === 'number' ) {

		if ( ! Number.isFinite( value ) ) {

			throw new TypeError( `createCubeRenderTargetAuxConfig: texture.${ property } must be finite` );

		}
		return Object.is( value, - 0 ) ? 0 : value;

	}
	if ( typeof value === 'string' || typeof value === 'boolean' ) return value;
	throw new TypeError( `createCubeRenderTargetAuxConfig: texture.${ property } must be JSON-safe scalar data` );

}

function readBoolean( texture, property ) {

	const value = safeRead( texture, property );
	if ( value === undefined || value === null ) return false;
	if ( typeof value !== 'boolean' ) {

		throw new TypeError( `createCubeRenderTargetAuxConfig: texture.${ property } must be boolean` );

	}
	return value;

}

function readFlag( texture, property ) {

	return safeRead( texture, property );

}

function safeRead( texture, property ) {

	try {

		return texture[ property ];

	} catch ( _ ) {

		throw new TypeError( `createCubeRenderTargetAuxConfig: could not read texture.${ property }` );

	}

}
