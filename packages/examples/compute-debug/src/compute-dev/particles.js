import { Fn, cos, float, instanceIndex, sin, time, vec3 } from 'three/tsl';

/** Raw graph construction is development-only and absent from slim builds. */
export function createParticleComputeNodes( positions, count ) {

	const init = Fn( () => {

		const i = float( instanceIndex );
		const angle = i.mul( 2.399963 );
		const radius = i.div( count ).sqrt().mul( 1.3 );
		positions.element( instanceIndex ).assign( vec3( cos( angle ).mul( radius ), sin( angle ).mul( radius ), 0 ) );

	} )().compute( count );

	const update = Fn( () => {

		const i = float( instanceIndex );
		positions.element( instanceIndex ).z = sin( i.mul( 0.21 ).add( time.mul( 1.4 ) ) ).mul( 0.45 );

	} )().compute( count );

	return { init, update };

}
