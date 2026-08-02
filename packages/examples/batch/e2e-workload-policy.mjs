const RASTERIZER_IBL_EXAMPLE = 'webgpu_compute_rasterizer_ibl.html';

export const RASTERIZER_IBL_WORKLOAD_POLICY = Object.freeze( {
	id: 'three-r185-rasterizer-ibl-bounded-workload-v1',
	example: RASTERIZER_IBL_EXAMPLE,
	reason: 'Bound the authored instance multiplicity so stock, capture, and replay can complete under the automated WebGPU evidence runner.',
	modeScope: Object.freeze( [ 'stock', 'capture', 'replay' ] ),
	original: Object.freeze( {
		instancePlaneSide: 125,
		instanceVolumeSide: 25,
		instanceCount: 15625,
		maxWorkItems: 2820000,
	} ),
	effective: Object.freeze( {
		instancePlaneSide: 8,
		instanceVolumeSide: 4,
		instanceCount: 64,
		maxWorkItems: 262144,
	} ),
} );

const RASTERIZER_IBL_REPLACEMENTS = Object.freeze( [
	Object.freeze( [
		'const instanceCount = 15625; // 125x125 plane or 25x25x25 volume',
		`const instancePlaneSide = ${ RASTERIZER_IBL_WORKLOAD_POLICY.effective.instancePlaneSide };
			const instanceVolumeSide = ${ RASTERIZER_IBL_WORKLOAD_POLICY.effective.instanceVolumeSide };
			const instanceCount = instancePlaneSide * instancePlaneSide; // 8x8 plane or 4x4x4 volume (bounded e2e workload)`,
	] ),
	Object.freeze( [ 'for ( let x = 0; x < 125; x ++ ) {', 'for ( let x = 0; x < instancePlaneSide; x ++ ) {' ] ),
	Object.freeze( [ 'for ( let z = 0; z < 125; z ++ ) {', 'for ( let z = 0; z < instancePlaneSide; z ++ ) {' ] ),
	Object.freeze( [ '( x - 62 ) * 4.0', '( x - ( instancePlaneSide - 1 ) / 2 ) * 4.0' ] ),
	Object.freeze( [ '( z - 62 ) * 4.0', '( z - ( instancePlaneSide - 1 ) / 2 ) * 4.0' ] ),
	Object.freeze( [ 'for ( let x = 0; x < 25; x ++ ) {', 'for ( let x = 0; x < instanceVolumeSide; x ++ ) {' ] ),
	Object.freeze( [ 'for ( let y = 0; y < 25; y ++ ) {', 'for ( let y = 0; y < instanceVolumeSide; y ++ ) {' ] ),
	Object.freeze( [ 'for ( let z = 0; z < 25; z ++ ) {', 'for ( let z = 0; z < instanceVolumeSide; z ++ ) {' ] ),
	Object.freeze( [ '( x - 12 ) * 4.0', '( x - ( instanceVolumeSide - 1 ) / 2 ) * 4.0' ] ),
	Object.freeze( [ '( y - 12 ) * 4.0', '( y - ( instanceVolumeSide - 1 ) / 2 ) * 4.0' ] ),
	Object.freeze( [ '( z - 12 ) * 4.0', '( z - ( instanceVolumeSide - 1 ) / 2 ) * 4.0' ] ),
	Object.freeze( [
		'const MAX_WORK_ITEMS = 2820000;',
		`const MAX_WORK_ITEMS = ${ RASTERIZER_IBL_WORKLOAD_POLICY.effective.maxWorkItems }; // bounded e2e workload`,
	] ),
] );

function occurrenceCount( source, fragment ) {

	let count = 0;
	let offset = 0;
	while ( true ) {

		const index = source.indexOf( fragment, offset );
		if ( index === - 1 ) return count;
		count ++;
		offset = index + fragment.length;

	}

}

function replaceExactlyOnce( source, before, after, policy ) {

	const count = occurrenceCount( source, before );
	if ( count !== 1 ) {

		throw new Error(
			`[batch-e2e] workload policy ${ policy.id } expected exactly one r185 source fragment `
			+ `${ JSON.stringify( before ) }, found ${ count }; refusing to transform drifted source.`
		);

	}
	return source.replace( before, after );

}

export function workloadPolicyForExample( name ) {

	return name === RASTERIZER_IBL_EXAMPLE ? RASTERIZER_IBL_WORKLOAD_POLICY : null;

}

/**
 * Reduce only the multiplicity of the exact r185 rasterizer-IBL workload.
 *
 * Every expected upstream fragment is guarded and the transform fails closed
 * if it drifts. The caller applies this before mode-specific instrumentation,
 * so stock, capture, and replay execute the same bounded authored program.
 */
export function applyExampleWorkloadPolicy( html, name ) {

	const policy = workloadPolicyForExample( name );
	if ( ! policy ) return { html, policy: null };

	let transformed = html;
	for ( const [ before, after ] of RASTERIZER_IBL_REPLACEMENTS ) {

		transformed = replaceExactlyOnce( transformed, before, after, policy );

	}
	return { html: transformed, policy };

}
