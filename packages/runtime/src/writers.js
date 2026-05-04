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
const _bgRotEuler = { _x: 0, _y: 0, _z: 0, _order: 'XYZ' };
let _bgRotImpl = null;
function _ensureBgRotImpl() {

	if ( _bgRotImpl ) return _bgRotImpl;
	// Use an inlined rotation-from-euler so writers.js stays free of any
	// `import 'three'` cost. Order defaults to XYZ which matches three.js's
	// scene.backgroundRotation default.
	_bgRotImpl = function makeRotationFromEulerXYZ( e, x, y, z ) {

		const a = Math.cos( x ), b = Math.sin( x );
		const c = Math.cos( y ), d = Math.sin( y );
		const f = Math.cos( z ), g = Math.sin( z );
		const ae = a * f, af = a * g, be = b * f, bg = b * g;
		// Three.js uses the column-major elements layout; this matches
		// Euler.set( x, y, z, 'XYZ' ).makeRotationFromEuler( ... ).
		e[ 0 ] = c * f; e[ 4 ] = bg * c - af; e[ 8 ] = ae * d + b * g; e[ 12 ] = 0;
		e[ 1 ] = c * g; e[ 5 ] = bg * d + ae; e[ 9 ] = af * d - be; e[ 13 ] = 0;
		e[ 2 ] = - d; e[ 6 ] = b * c; e[ 10 ] = a * c; e[ 14 ] = 0;
		e[ 3 ] = 0; e[ 7 ] = 0; e[ 11 ] = 0; e[ 15 ] = 1;

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

	const e = _bgRotScratch.elements;
	if ( background && background.isTexture === true && euler ) {

		_ensureBgRotImpl()( e, euler._x || euler.x || 0, euler._y || euler.y || 0, euler._z || euler.z || 0 );
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
 * Bulk-copy for prebuilt typed arrays — used for buffer attributes the
 * extractor captured as raw bytes.
 */
export function writeBytes( view, byteOffset, source, sourceByteOffset, byteLength ) {

	const dst = new Uint8Array( view.buffer, view.byteOffset + byteOffset, byteLength );
	const src = new Uint8Array( source.buffer, source.byteOffset + sourceByteOffset, byteLength );
	dst.set( src );

}
