import { Fn, float, globalId, sin, textureStore, time, uvec2, vec4 } from 'three/tsl';

export function createDispatch2DComputeNode( output, size, workgroup ) {

	const computeTexture = Fn( ( { tex } ) => {

		const x = globalId.x;
		const y = globalId.y;
		const u = float( x ).div( size - 1 );
		const v = float( y ).div( size - 1 );
		const checker = x.add( y ).mod( 2 );
		const b = float( checker ).mul( 0.25 ).add( sin( time.add( u.mul( 6 ) ) ).mul( 0.25 ).add( 0.5 ) );
		textureStore( tex, uvec2( x, y ), vec4( u, v, b, 1 ) ).toWriteOnly();

	} );

	return computeTexture( { tex: output } ).compute(
		[ size / workgroup, size / workgroup, 1 ],
		[ workgroup, workgroup, 1 ],
	);

}
