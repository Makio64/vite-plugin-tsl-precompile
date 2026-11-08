import { Fn, float, instanceIndex, storage, vec4 } from 'three/tsl';

export function createUniformKernel( output, gain, count ) {

	const values = storage( output, 'vec4', count );
	return Fn( () => {

		const value = float( instanceIndex ).div( count ).add( gain );
		values.element( instanceIndex ).assign( vec4( value, value.mul( 0.5 ), value.mul( 2 ), 1 ) );

	} )().compute( count, [ 64, 1, 1 ] );

}
