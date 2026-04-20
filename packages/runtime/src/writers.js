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

/**
 * Bulk-copy for prebuilt typed arrays — used for buffer attributes the
 * extractor captured as raw bytes.
 */
export function writeBytes( view, byteOffset, source, sourceByteOffset, byteLength ) {

	const dst = new Uint8Array( view.buffer, view.byteOffset + byteOffset, byteLength );
	const src = new Uint8Array( source.buffer, source.byteOffset + sourceByteOffset, byteLength );
	dst.set( src );

}
