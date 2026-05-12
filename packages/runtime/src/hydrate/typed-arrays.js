export function resolveTypedArrayCtor( name ) {

	switch ( name ) {

		case 'Int8Array': return Int8Array;
		case 'Uint8Array': return Uint8Array;
		case 'Uint8ClampedArray': return Uint8ClampedArray;
		case 'Int16Array': return Int16Array;
		case 'Uint16Array': return Uint16Array;
		case 'Int32Array': return Int32Array;
		case 'Uint32Array': return Uint32Array;
		case 'Float32Array': return Float32Array;
		case 'Float64Array': return Float64Array;
		default: return Float32Array;

	}

}
