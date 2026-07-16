import { Fn, cos, float, instanceIndex, sin, textureStore, time, uvec2, vec4 } from 'three/tsl';

export function createTextureComputeNode( output, size ) {

	const computeTexture = Fn( ( { tex } ) => {

		const x = instanceIndex.mod( size );
		const y = instanceIndex.div( size );
		const u = float( x ).div( size );
		const v = float( y ).div( size );
		const r = sin( u.mul( 12 ).add( time ) ).mul( 0.5 ).add( 0.5 );
		const g = cos( v.mul( 9 ).sub( time.mul( 0.7 ) ) ).mul( 0.5 ).add( 0.5 );
		const b = sin( u.add( v ).mul( 7 ).add( time.mul( 1.3 ) ) ).mul( 0.5 ).add( 0.5 );
		textureStore( tex, uvec2( x, y ), vec4( r, g, b, 1 ) ).toWriteOnly();

	} );

	return computeTexture( { tex: output } ).compute( size * size );

}
