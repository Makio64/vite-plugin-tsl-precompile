import { Fn, cos, float, instanceIndex, sin, time, vec3 } from 'three/tsl';

export function createInstancedComputeNodes( { base, display, count } ) {

	const init = Fn( () => {

		const i = float( instanceIndex );
		const angle = i.mul( 2.399963 );
		const radius = i.div( count ).sqrt().mul( 1.7 );
		base.element( instanceIndex ).assign( vec3( cos( angle ).mul( radius ), 0, sin( angle ).mul( radius ) ) );

	} )().compute( count );

	const update = Fn( () => {

		const i = float( instanceIndex );
		const b = base.element( instanceIndex );
		const angle = time.mul( 0.5 );
		const x = b.x.mul( cos( angle ) ).sub( b.z.mul( sin( angle ) ) );
		const z = b.x.mul( sin( angle ) ).add( b.z.mul( cos( angle ) ) );
		const y = sin( time.mul( 1.6 ).add( i.mul( 0.4 ) ) ).mul( 0.3 );
		display.element( instanceIndex ).assign( vec3( x, y, z ) );

	} )().compute( count );

	return { init, update };

}
