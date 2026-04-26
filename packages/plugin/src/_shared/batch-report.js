/**
 * Batch-report helpers. Categorises per-example failures produced by the
 * Phase-6 batch harness into buckets that mirror the failure taxonomy the
 * monolithic-slim fork accumulated (see `EXPERIMENT_SUMMARY.md` in the
 * reference repo).
 *
 * @module BatchReport
 */

/**
 * @param {Object} detail - One element from `report.details`.
 * @return {string} The bucket label.
 */
export function categoriseFailure( detail ) {

	if ( ! detail ) return 'unknown';
	if ( detail.status !== 'fail' ) return detail.status;

	const err = String( detail.error || '' );
	const preErr = ( detail.preErrors && detail.preErrors[ 0 ] ) || '';
	const harnessErr = detail.harnessError || '';

	const text = [ err, preErr, harnessErr ].join( ' ' );

	if ( /navigation|timeout|goto/i.test( text ) ) return 'navigation-timeout';
	if ( /ShaderStage|BindGroup|Binding|BufferBindingType|validation|Invalid/i.test( text ) ) return 'gpu-validation';
	if ( /uniform\.live|uniform\.constant|snapshot|unsupported source\.kind|blocked kind/i.test( text ) ) return 'kind-unsupported';
	if ( /extractor|extractArtifact|compileTSL/i.test( text ) ) return 'extractor-threw';
	if ( /WGSL|shader module|invalid wgsl/i.test( text ) ) return 'wgsl-mismatch';
	if ( detail.baseBrightFrac === 0 || detail.preBrightFrac === 0 ) return 'no-render';
	if ( detail.diffFrac != null && detail.diffFrac > 0.01 ) return 'pixel-diff';
	return 'other';

}

/**
 * Aggregate a details array into per-bucket counts.
 *
 * @param {Array<Object>} details
 * @return {Object} Object keyed by bucket, valued by count.
 */
export function aggregateFailureCategories( details ) {

	const cats = {};
	for ( const d of details ) {

		const c = categoriseFailure( d );
		cats[ c ] = ( cats[ c ] || 0 ) + 1;

	}
	return cats;

}
