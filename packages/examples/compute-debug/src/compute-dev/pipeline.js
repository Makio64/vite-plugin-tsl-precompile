import { Fn, cos, float, instanceIndex, sin, time, vec3 } from 'three/tsl';

export function createPipelineComputeNodes( { source, display, count } ) {

	const sourceNode = Fn( () => {

		const i = float( instanceIndex );
		const angle = i.mul( 2.399963 );
		const radius = i.div( count ).sqrt().mul( 1.15 );
		source.element( instanceIndex ).assign( vec3( cos( angle ).mul( radius ), sin( angle ).mul( radius ), i.div( count ).sub( 0.5 ) ) );

	} )().compute( count );

	const displayNode = Fn( () => {

		const i = float( instanceIndex );
		const p = source.element( instanceIndex );
		const wobble = sin( time.mul( 1.1 ).add( i.mul( 0.13 ) ) ).mul( 0.3 );
		display.element( instanceIndex ).assign( vec3( p.x, p.y.add( wobble ), p.z ) );

	} )().compute( count );

	return { source: sourceNode, display: displayNode };

}
