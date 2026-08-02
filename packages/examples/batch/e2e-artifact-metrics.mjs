import { forEachArtifactPayload } from '@tsl-precompile/contract/artifact-traversal';

export const E2E_ARTIFACT_METRICS_SCHEMA = 'tslp-e2e-artifact-metrics@1';

function sortedStrings( values ) {

	return [ ...new Set( values.filter( ( value ) => typeof value === 'string' && value.length > 0 ) ) ].sort();

}

/**
 * Compute public campaign metrics from the complete captured artifact graph.
 *
 * Artifact variants and material-compute kernels are independent compiled
 * payloads and therefore contribute to the artifact/material/WGSL totals.
 * `forEachArtifactPayload` de-duplicates shared object identities so aliases
 * in generated module wrappers cannot inflate the result.
 */
export function computeE2EArtifactMetrics( bucket ) {

	const user = bucket && bucket.user && typeof bucket.user === 'object' && ! Array.isArray( bucket.user )
		? bucket.user
		: {};
	const aux = bucket && Array.isArray( bucket.aux ) ? bucket.aux : [];
	const materialShapes = [];
	const auxiliaryShapes = aux.map( ( entry ) => entry && entry.shape );
	let artifactCount = 0;
	let materialCount = 0;
	let totalWgslBytes = 0;
	let hasCompute = false;

	forEachArtifactPayload( [ ...Object.values( user ), ...aux ], ( artifact ) => {

		artifactCount ++;
		const vertexShader = typeof artifact.vertexShader === 'string' ? artifact.vertexShader : '';
		const fragmentShader = typeof artifact.fragmentShader === 'string' ? artifact.fragmentShader : '';
		const computeShader = typeof artifact.computeShader === 'string' ? artifact.computeShader : '';
		if ( vertexShader || fragmentShader ) materialCount ++;
		if ( computeShader ) hasCompute = true;
		totalWgslBytes += Buffer.byteLength( vertexShader ) + Buffer.byteLength( fragmentShader ) + Buffer.byteLength( computeShader );
		materialShapes.push( artifact.materialShape );

	} );

	return Object.freeze( {
		schema: E2E_ARTIFACT_METRICS_SCHEMA,
		artifactCount,
		materialCount,
		totalWgslBytes,
		hasCompute,
		userArtifactCount: Object.keys( user ).length,
		auxArtifactCount: aux.length,
		shapes: Object.freeze( sortedStrings( auxiliaryShapes ) ),
		materialShapes: Object.freeze( sortedStrings( materialShapes ) ),
	} );

}

function evidenceIdentity( descriptor ) {

	if ( ! descriptor ) return null;
	return {
		file: descriptor.file,
		bytes: descriptor.bytes,
		sha256: descriptor.sha256,
	};

}

export function bindE2EArtifactMetrics( metrics, {
	runId,
	userArtifacts,
	auxArtifacts,
} ) {

	if ( ! metrics || metrics.schema !== E2E_ARTIFACT_METRICS_SCHEMA ) {

		throw new Error( `artifact metrics must use ${ E2E_ARTIFACT_METRICS_SCHEMA }` );

	}
	return {
		...metrics,
		evidence: {
			runId,
			userArtifacts: evidenceIdentity( userArtifacts ),
			auxArtifacts: evidenceIdentity( auxArtifacts ),
		},
	};

}

export function assertE2EArtifactMetricsBinding( metrics, {
	runId,
	userArtifacts,
	auxArtifacts,
}, label = 'artifact metrics' ) {

	if ( ! metrics || metrics.schema !== E2E_ARTIFACT_METRICS_SCHEMA ) {

		throw new Error( `${ label } must use ${ E2E_ARTIFACT_METRICS_SCHEMA }` );

	}
	for ( const key of [ 'artifactCount', 'materialCount', 'totalWgslBytes', 'userArtifactCount', 'auxArtifactCount' ] ) {

		if ( ! Number.isSafeInteger( metrics[ key ] ) || metrics[ key ] < 0 ) {

			throw new Error( `${ label }.${ key } must be a non-negative safe integer` );

		}

	}
	if ( metrics.materialCount > metrics.artifactCount ) throw new Error( `${ label } material count exceeds artifact count` );
	if ( typeof metrics.hasCompute !== 'boolean' ) throw new Error( `${ label }.hasCompute must be boolean` );
	for ( const key of [ 'shapes', 'materialShapes' ] ) {

		if (
			! Array.isArray( metrics[ key ] ) ||
			metrics[ key ].some( ( value ) => typeof value !== 'string' || value.length === 0 ) ||
			metrics[ key ].some( ( value, index ) => index > 0 && value <= metrics[ key ][ index - 1 ] )
		) {

			throw new Error( `${ label }.${ key } must be sorted unique non-empty strings` );

		}

	}
	const expected = bindE2EArtifactMetrics( {
		schema: metrics.schema,
		artifactCount: metrics.artifactCount,
		materialCount: metrics.materialCount,
		totalWgslBytes: metrics.totalWgslBytes,
		hasCompute: metrics.hasCompute,
		userArtifactCount: metrics.userArtifactCount,
		auxArtifactCount: metrics.auxArtifactCount,
		shapes: metrics.shapes,
		materialShapes: metrics.materialShapes,
	}, { runId, userArtifacts, auxArtifacts } );
	const actualEvidence = metrics.evidence;
	const sameDescriptor = ( actual, wanted ) => (
		( actual === null && wanted === null ) ||
		(
			actual &&
			wanted &&
			actual.file === wanted.file &&
			actual.bytes === wanted.bytes &&
			actual.sha256 === wanted.sha256
		)
	);
	if (
		! actualEvidence ||
		actualEvidence.runId !== expected.evidence.runId ||
		! sameDescriptor( actualEvidence.userArtifacts, expected.evidence.userArtifacts ) ||
		! sameDescriptor( actualEvidence.auxArtifacts, expected.evidence.auxArtifacts )
	) {

		throw new Error( `${ label } is not bound to its run-scoped full artifact descriptors` );

	}
	return metrics;

}
