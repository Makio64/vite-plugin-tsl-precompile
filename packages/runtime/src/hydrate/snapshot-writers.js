/**
 * Snapshot-aware DataView writers for the hydrator's per-frame UBO update path.
 *
 * Distinct from `packages/runtime/src/writers.js` — that file is the
 * AOT-generated updater's hot-path writer set with the signature
 * `(view, offset, value)`. These hydrator-side writers carry the snapshot
 * fallback semantics `(view, offset, value, snapshot)`: when the live value
 * is missing or non-finite, fall back to the captured `source.valueSnapshot`
 * recorded at extract time. Used by both `material-writers.js` (UBO writes
 * for camera / object / renderer / material / scene slots) and
 * `light-writers.js` (per-light writes).
 *
 * Contract:
 *   - `view` is a DataView over the UBO's staging ArrayBuffer.
 *   - `offset` is the slot byte offset (per `slot.offset` / `slot.byteOffset`).
 *   - Little-endian; matches WebGPU std140 layout.
 *
 * @module hydrate/snapshot-writers
 */

export function writeSnapshot( view, offset, snapshot, dtype = null ) {

	if ( ! snapshot ) return;
	const { type, data } = snapshot;
	const effectiveType = dtype || type;
	if ( effectiveType === 'number' || effectiveType === 'float' || effectiveType === 'f32' ) writeNumber( view, offset, data );
	else if ( effectiveType === 'int' || effectiveType === 'i32' ) writeInt( view, offset, data );
	else if ( effectiveType === 'uint' || effectiveType === 'u32' ) writeUint( view, offset, data );
	else if ( effectiveType === 'color' ) writeColor( view, offset, { r: data[ 0 ], g: data[ 1 ], b: data[ 2 ] } );
	else if ( effectiveType === 'vec2' ) writeVec2( view, offset, { x: data[ 0 ], y: data[ 1 ] } );
	else if ( effectiveType === 'vec3' ) writeVec3( view, offset, { x: data[ 0 ], y: data[ 1 ], z: data[ 2 ] } );
	else if ( effectiveType === 'vec4' ) writeVec4( view, offset, { x: data[ 0 ], y: data[ 1 ], z: data[ 2 ], w: data[ 3 ] } );
	else if ( effectiveType === 'mat3' ) writeMat3( view, offset, { elements: data } );
	else if ( effectiveType === 'mat4' ) writeMat4( view, offset, { elements: data } );

}

export function writeNumber( view, offset, value, snapshot ) {

	const n = Number.isFinite( value ) ? value : snapshot && Number( snapshot.data ) || 0;
	view.setFloat32( offset, n, true );

}

export function writeInt( view, offset, value, snapshot ) {

	const n = Number.isFinite( value ) ? value : snapshot && Number( snapshot.data ) || 0;
	view.setInt32( offset, n | 0, true );

}

export function writeUint( view, offset, value, snapshot ) {

	const n = Number.isFinite( value ) ? value : snapshot && Number( snapshot.data ) || 0;
	view.setUint32( offset, n >>> 0, true );

}

export function writeColor( view, offset, value, snapshot ) {

	if ( ! value && snapshot ) return writeSnapshot( view, offset, snapshot );
	view.setFloat32( offset, value && value.r || 0, true );
	view.setFloat32( offset + 4, value && value.g || 0, true );
	view.setFloat32( offset + 8, value && value.b || 0, true );
	if ( typeof globalThis !== 'undefined' && globalThis.__tslpHarnessDiagnostics ) {
		const list = globalThis.__tslpHarnessDiagnostics.snapshotWriterColors || ( globalThis.__tslpHarnessDiagnostics.snapshotWriterColors = [] );
		if ( list.length < 32 ) list.push( { offset, r: value && value.r || 0, g: value && value.g || 0, b: value && value.b || 0 } );
	}

}

export function writeVec2( view, offset, value, snapshot ) {

	if ( ! value && snapshot ) return writeSnapshot( view, offset, snapshot );
	view.setFloat32( offset, value && value.x || 0, true );
	view.setFloat32( offset + 4, value && value.y || 0, true );

}

export function writeVec3( view, offset, value, snapshot ) {

	if ( ! value && snapshot ) return writeSnapshot( view, offset, snapshot );
	view.setFloat32( offset, value && value.x || 0, true );
	view.setFloat32( offset + 4, value && value.y || 0, true );
	view.setFloat32( offset + 8, value && value.z || 0, true );

}

export function writeVec4( view, offset, value, snapshot ) {

	if ( ! value && snapshot ) return writeSnapshot( view, offset, snapshot );
	view.setFloat32( offset, value && value.x || 0, true );
	view.setFloat32( offset + 4, value && value.y || 0, true );
	view.setFloat32( offset + 8, value && value.z || 0, true );
	view.setFloat32( offset + 12, value && value.w || 0, true );

}

export function writeMat3( view, offset, value, snapshot ) {

	if ( ! value && snapshot ) return writeSnapshot( view, offset, snapshot );
	const e = value && value.elements || [];
	view.setFloat32( offset + 0, e[ 0 ] || 0, true );
	view.setFloat32( offset + 4, e[ 1 ] || 0, true );
	view.setFloat32( offset + 8, e[ 2 ] || 0, true );
	view.setFloat32( offset + 16, e[ 3 ] || 0, true );
	view.setFloat32( offset + 20, e[ 4 ] || 0, true );
	view.setFloat32( offset + 24, e[ 5 ] || 0, true );
	view.setFloat32( offset + 32, e[ 6 ] || 0, true );
	view.setFloat32( offset + 36, e[ 7 ] || 0, true );
	view.setFloat32( offset + 40, e[ 8 ] || 0, true );

}

export function writeMat4( view, offset, value, snapshot ) {

	if ( ! value && snapshot ) return writeSnapshot( view, offset, snapshot );
	const e = value && value.elements || [];
	for ( let i = 0; i < 16; i ++ ) view.setFloat32( offset + i * 4, e[ i ] || 0, true );

}

/**
 * Write a live UniformNode value to a DataView. Dispatches by the value's
 * runtime type. Called for `uniform.live` slots when `_liveNode` is present
 * (in-process flows where the original TSL node instances are alive).
 *
 * @param {DataView} view
 * @param {number} offset
 * @param {any} value - The `UniformNode.value` field.
 * @param {string} [dtype] - Hint from the plan slot ('number','vec2',…,'mat4').
 */
export function writeLiveValue( view, offset, value, dtype ) {

	if ( typeof value === 'number' ) {

		if ( dtype === 'int' || dtype === 'i32' ) view.setInt32( offset, value | 0, true );
		else if ( dtype === 'uint' || dtype === 'u32' ) view.setUint32( offset, value >>> 0, true );
		else view.setFloat32( offset, value, true );
		return;

	}
	if ( value && value.isColor ) { writeColor( view, offset, value ); return; }
	if ( value && value.isMatrix4 ) { writeMat4( view, offset, value ); return; }
	if ( value && value.isMatrix3 ) { writeMat3( view, offset, value ); return; }
	if ( value && value.isVector4 ) { writeVec4( view, offset, value ); return; }
	if ( value && value.isVector3 ) { writeVec3( view, offset, value ); return; }
	if ( value && value.isVector2 ) { writeVec2( view, offset, value ); return; }
	// Fallback: try dtype hint
	if ( dtype === 'mat4' ) { writeMat4( view, offset, value ); return; }
	if ( dtype === 'mat3' ) { writeMat3( view, offset, value ); return; }
	if ( dtype === 'vec4' ) { writeVec4( view, offset, value ); return; }
	if ( dtype === 'vec3' ) { writeVec3( view, offset, value ); return; }
	if ( dtype === 'vec2' ) { writeVec2( view, offset, value ); return; }
	if ( dtype === 'color' ) { writeColor( view, offset, value ); return; }
	// Scalar fallback
	view.setFloat32( offset, Number( value ) || 0, true );

}
