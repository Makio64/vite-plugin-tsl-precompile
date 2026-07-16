import { Fn, float, globalId, textureStore, uvec2, vec4 } from 'three/tsl';

export function createUniformComputeNode( { output, threshold, tint, size, workgroup } ) {

	const computeTexture = Fn( ( { tex } ) => {

		const x = globalId.x;
		const y = globalId.y;
		const u = float( x ).div( size - 1 );
		const v = float( y ).div( size - 1 );
		const band = u.add( v.mul( 0.5 ) ).greaterThan( threshold );
		const r = band.select( tint, u.mul( 0.25 ) );
		const g = band.select( v.mul( 0.45 ), tint.mul( 0.7 ) );
		const b = band.select( u.oneMinus().mul( 0.8 ), v.oneMinus().mul( 0.45 ) );
		textureStore( tex, uvec2( x, y ), vec4( r, g, b, 1 ) ).toWriteOnly();

	} );

	return computeTexture( { tex: output } ).compute(
		[ size / workgroup, size / workgroup, 1 ],
		[ workgroup, workgroup, 1 ],
	);

}
