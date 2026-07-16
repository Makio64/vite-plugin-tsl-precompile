import { Fn, Loop, float, instanceIndex, sin, time } from 'three/tsl';

export function createReduceComputeNodes( { data, result, count } ) {

	// Refill the data buffer each frame, animated by time.
	const computeFill = Fn( () => {

		const i = float( instanceIndex );
		// Keep the reduced average visibly time-varying. A high spatial frequency
		// cancels almost perfectly across the buffer and makes a healthy compute
		// pipeline look static to both people and the site motion gate.
		data.element( instanceIndex ).assign( sin( i.mul( 0.01 ).add( time ) ).mul( 0.5 ).add( 0.5 ) );

	} )().compute( count );

	// Single-thread reduction (minimal — not a fast parallel reduce).
	const computeReduce = Fn( () => {

		const sum = float( 0 ).toVar();
		Loop( count, ( { i } ) => {

			sum.addAssign( data.element( i ) );

		} );
		result.element( 0 ).assign( sum.div( count ) );

	} )().compute( 1 );

	return { fill: computeFill, reduce: computeReduce };

}
