/**
 * UBO writers consumed by AOT-generated `updater.js` modules.
 *
 * Every writer takes (view, byteOffset, value) and writes directly — no
 * branching, no descriptor walk, no closure allocation. This is the hot
 * path that replaces `PrecompiledHydrator.compileSlotWriter`.
 *
 * Contract:
 *   - `view` is a DataView over the uniform buffer's staging ArrayBuffer.
 *   - `byteOffset` is a build-time inlined literal.
 *   - Little-endian. WebGPU uniform layout is LE on all platforms we ship.
 *
 * @module Writers
 */

const LE = true;

export function writeF32( view, byteOffset, value ) {

	view.setFloat32( byteOffset, value, LE );

}

export function writeI32( view, byteOffset, value ) {

	view.setInt32( byteOffset, value, LE );

}

export function writeU32( view, byteOffset, value ) {

	view.setUint32( byteOffset, value, LE );

}

export function writeVec2( view, byteOffset, value ) {

	view.setFloat32( byteOffset, value.x, LE );
	view.setFloat32( byteOffset + 4, value.y, LE );

}

export function writeVec3( view, byteOffset, value ) {

	view.setFloat32( byteOffset, value.x, LE );
	view.setFloat32( byteOffset + 4, value.y, LE );
	view.setFloat32( byteOffset + 8, value.z, LE );

}

export function writeVec4( view, byteOffset, value ) {

	view.setFloat32( byteOffset, value.x, LE );
	view.setFloat32( byteOffset + 4, value.y, LE );
	view.setFloat32( byteOffset + 8, value.z, LE );
	view.setFloat32( byteOffset + 12, value.w, LE );

}

export function writeColor( view, byteOffset, value ) {

	view.setFloat32( byteOffset, value.r, LE );
	view.setFloat32( byteOffset + 4, value.g, LE );
	view.setFloat32( byteOffset + 8, value.b, LE );

}

export function writeColorRGBA( view, byteOffset, color, alpha ) {

	view.setFloat32( byteOffset, color.r, LE );
	view.setFloat32( byteOffset + 4, color.g, LE );
	view.setFloat32( byteOffset + 8, color.b, LE );
	view.setFloat32( byteOffset + 12, alpha, LE );

}

export function writeMat3( view, byteOffset, mat ) {

	// std140: mat3 is stored as three vec4 rows with 16-byte stride.
	const e = mat.elements;
	view.setFloat32( byteOffset + 0, e[ 0 ], LE );
	view.setFloat32( byteOffset + 4, e[ 1 ], LE );
	view.setFloat32( byteOffset + 8, e[ 2 ], LE );
	view.setFloat32( byteOffset + 16, e[ 3 ], LE );
	view.setFloat32( byteOffset + 20, e[ 4 ], LE );
	view.setFloat32( byteOffset + 24, e[ 5 ], LE );
	view.setFloat32( byteOffset + 32, e[ 6 ], LE );
	view.setFloat32( byteOffset + 36, e[ 7 ], LE );
	view.setFloat32( byteOffset + 40, e[ 8 ], LE );

}

export function writeMat4( view, byteOffset, mat ) {

	const e = mat.elements;
	for ( let i = 0; i < 16; i ++ ) {

		view.setFloat32( byteOffset + ( i << 2 ), e[ i ], LE );

	}

}

const _bgRotScratch = { elements: new Float32Array( 16 ) };
let _bgRotImpl = null;
function _ensureBgRotImpl() {

	if ( _bgRotImpl ) return _bgRotImpl;
	// Use Three r185's complete Matrix4.makeRotationFromEuler branch table so
	// writers.js stays free of any `import 'three'` cost without silently
	// treating non-default Euler orders as XYZ.
	_bgRotImpl = function makeRotationFromEuler( te, x, y, z, order ) {

		const a = Math.cos( x ), b = Math.sin( x );
		const c = Math.cos( y ), d = Math.sin( y );
		const e = Math.cos( z ), f = Math.sin( z );

		if ( order === 'XYZ' ) {

			const ae = a * e, af = a * f, be = b * e, bf = b * f;
			te[ 0 ] = c * e; te[ 4 ] = - c * f; te[ 8 ] = d;
			te[ 1 ] = af + be * d; te[ 5 ] = ae - bf * d; te[ 9 ] = - b * c;
			te[ 2 ] = bf - ae * d; te[ 6 ] = be + af * d; te[ 10 ] = a * c;

		} else if ( order === 'YXZ' ) {

			const ce = c * e, cf = c * f, de = d * e, df = d * f;
			te[ 0 ] = ce + df * b; te[ 4 ] = de * b - cf; te[ 8 ] = a * d;
			te[ 1 ] = a * f; te[ 5 ] = a * e; te[ 9 ] = - b;
			te[ 2 ] = cf * b - de; te[ 6 ] = df + ce * b; te[ 10 ] = a * c;

		} else if ( order === 'ZXY' ) {

			const ce = c * e, cf = c * f, de = d * e, df = d * f;
			te[ 0 ] = ce - df * b; te[ 4 ] = - a * f; te[ 8 ] = de + cf * b;
			te[ 1 ] = cf + de * b; te[ 5 ] = a * e; te[ 9 ] = df - ce * b;
			te[ 2 ] = - a * d; te[ 6 ] = b; te[ 10 ] = a * c;

		} else if ( order === 'ZYX' ) {

			const ae = a * e, af = a * f, be = b * e, bf = b * f;
			te[ 0 ] = c * e; te[ 4 ] = be * d - af; te[ 8 ] = ae * d + bf;
			te[ 1 ] = c * f; te[ 5 ] = bf * d + ae; te[ 9 ] = af * d - be;
			te[ 2 ] = - d; te[ 6 ] = b * c; te[ 10 ] = a * c;

		} else if ( order === 'YZX' ) {

			const ac = a * c, ad = a * d, bc = b * c, bd = b * d;
			te[ 0 ] = c * e; te[ 4 ] = bd - ac * f; te[ 8 ] = bc * f + ad;
			te[ 1 ] = f; te[ 5 ] = a * e; te[ 9 ] = - b * e;
			te[ 2 ] = - d * e; te[ 6 ] = ad * f + bc; te[ 10 ] = ac - bd * f;

		} else {

			// Euler validates public orders; retain Three's XZY branch as the
			// deterministic fallback for malformed or future values.
			const ac = a * c, ad = a * d, bc = b * c, bd = b * d;
			te[ 0 ] = c * e; te[ 4 ] = - f; te[ 8 ] = d * e;
			te[ 1 ] = ac * f + bd; te[ 5 ] = a * e; te[ 9 ] = ad * f - bc;
			te[ 2 ] = bc * f - ad; te[ 6 ] = b * e; te[ 10 ] = bd * f + ac;

		}

		te[ 3 ] = 0; te[ 7 ] = 0; te[ 11 ] = 0;
		te[ 12 ] = 0; te[ 13 ] = 0; te[ 14 ] = 0; te[ 15 ] = 1;

	};
	return _bgRotImpl;

}

/**
 * Writer for `scene.backgroundRotation` — derived from the Euler at
 * runtime then transposed (mirrors three.js's SceneProperties.js).
 * Writes identity when there's no Euler or when the background isn't a
 * cubemap/equirect texture (matches the stock TSL helper's behavior).
 */
export function writeMat4FromEuler( view, byteOffset, euler, background ) {

	_writeEulerMatrix( view, byteOffset, euler, !! ( background && background.isTexture === true ) );

}

function _writeEulerMatrix( view, byteOffset, euler, enabled ) {

	const e = _bgRotScratch.elements;
	if ( enabled && euler ) {

		_ensureBgRotImpl()(
			e,
			euler._x ?? euler.x ?? 0,
			euler._y ?? euler.y ?? 0,
			euler._z ?? euler.z ?? 0,
			euler._order ?? euler.order ?? 'XYZ',
		);
		// Transpose: matches `_m1.transpose()` in stock SceneProperties.
		[ e[ 1 ], e[ 4 ] ] = [ e[ 4 ], e[ 1 ] ];
		[ e[ 2 ], e[ 8 ] ] = [ e[ 8 ], e[ 2 ] ];
		[ e[ 6 ], e[ 9 ] ] = [ e[ 9 ], e[ 6 ] ];

	} else {

		// Identity
		for ( let i = 0; i < 16; i ++ ) e[ i ] = ( i % 5 === 0 ) ? 1 : 0;

	}
	for ( let i = 0; i < 16; i ++ ) view.setFloat32( byteOffset + ( i << 2 ), e[ i ], LE );

}

/**
 * Writer for Three r185's `materialEnvRotation` singleton. Its owner is
 * selected per object: a material envMap wins, otherwise a scene environment
 * (including environmentNode) supplies the rotation.
 */
export function writeEnvironmentRotation( view, byteOffset, material, scene ) {

	const hasSceneEnvironment = !! (
		scene && (
			scene.environment !== null ||
			scene.environmentNode && scene.environmentNode.isNode === true
		)
	);
	const useScene = hasSceneEnvironment && material && material.envMap === null;
	const rotation = useScene
		? scene && scene.environmentRotation
		: material && material.envMapRotation;
	_writeEulerMatrix( view, byteOffset, rotation, !! rotation );

}

const PMREM_CUBE_UV_MAPPING = 306;

function _isPMREMTexture( texture ) {

	return !! (
		texture &&
		texture.isTexture === true &&
		(
			texture.isPMREMTexture === true ||
			texture.mapping === PMREM_CUBE_UV_MAPPING ||
			texture.name === 'PMREM.cubeUv'
		)
	);

}

function _pmremTextureForSource( artifact, source ) {

	const refs = artifact && artifact._textureRefs;
	if ( refs && source && source.textureUuid && typeof refs.get === 'function' ) {

		const exact = refs.get( source.textureUuid );
		if ( _isPMREMTexture( exact ) ) return exact;

	}
	return null;

}

/**
 * Recompute PMREM CubeUV addressing scalars from the live atlas wired into
 * artifact._textureRefs. This mirrors Three r185's private
 * PMREMNode._generateCubeUVSize() formula.
 */
export function writePMREMScalar( view, byteOffset, kind, artifact, material, frame, source = null ) {

	const ownerArtifact = artifact || material && material.precompiledArtifact || null;
	const texture = _pmremTextureForSource( ownerArtifact, source );
	const imageHeight = texture && texture.image && Number( texture.image.height );
	let value = NaN;
	if ( Number.isFinite( imageHeight ) && imageHeight > 0 ) {

		const maxMip = Math.log2( imageHeight ) - 2;
		if ( kind === 'pmrem.maxMip' ) value = maxMip;
		else if ( kind === 'pmrem.texelHeight' ) value = 1 / imageHeight;
		else if ( kind === 'pmrem.texelWidth' ) value = 1 / ( 3 * Math.max( 2 ** maxMip, 7 * 16 ) );

	}
	if ( ! Number.isFinite( value ) ) {

		const snapshot = source && source.valueSnapshot;
		const fallback = snapshot && Number( snapshot.data );
		value = Number.isFinite( fallback ) ? fallback : 0;

	}
	view.setFloat32( byteOffset, value, LE );

}

function _textureUVFlipSnapshot( source ) {

	const snapshot = source && source.valueSnapshot;
	const data = snapshot && snapshot.data;
	if ( data === true ) return 1;
	if ( data === false ) return 0;
	return typeof data === 'number' && Number.isFinite( data ) && data !== 0 ? 1 : 0;

}

function _isImageBitmap( image ) {

	const ImageBitmapConstructor = typeof globalThis !== 'undefined' ? globalThis.ImageBitmap : null;
	return typeof ImageBitmapConstructor === 'function' && image instanceof ImageBitmapConstructor;

}

/**
 * Recompute TextureNode's backend UV flip uniform from the live texture wired
 * into artifact._textureRefs. The branch is kept identical to Three r185's
 * TextureNode.update(); a captured uint snapshot is used only when that exact
 * texture relation is unavailable at replay time.
 */
export function writeTextureUVFlip( view, byteOffset, artifact, source ) {

	const refs = artifact && artifact._textureRefs;
	const texture = refs && source && source.textureUuid && typeof refs.get === 'function'
		? refs.get( source.textureUuid )
		: null;
	const value = texture
		? (
			( _isImageBitmap( texture.image ) && texture.flipY === true )
			|| texture.isRenderTargetTexture === true
			|| texture.isFramebufferTexture === true
			|| texture.isDepthTexture === true
		)
		: _textureUVFlipSnapshot( source ) === 1;
	view.setUint32( byteOffset, value ? 1 : 0, LE );

}

/**
 * Bulk-copy for prebuilt typed arrays — used for buffer attributes the
 * extractor captured as raw bytes.
 */
export function writeBytes( view, byteOffset, source, sourceByteOffset, byteLength ) {

	const dst = new Uint8Array( view.buffer, view.byteOffset + byteOffset, byteLength );
	const src = new Uint8Array( source.buffer, source.byteOffset + sourceByteOffset, byteLength );
	dst.set( src );

}
