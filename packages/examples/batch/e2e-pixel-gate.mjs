/**
 * Normalize raw image comparison metrics into an explicit gate result.
 */
export function pixelGateOf( metrics, threshold ) {

	if ( ! metrics ) return { skipped: true, reason: 'no metrics' };
	if ( metrics.skipped ) return metrics;
	if ( metrics.error ) return { skipped: true, reason: metrics.error };
	const { psnr } = metrics;
	if ( psnr === 'inf' ) return { pass: true, psnr: 'inf', threshold };
	if ( typeof psnr !== 'number' ) return { skipped: true, reason: 'no psnr' };
	return { pass: psnr >= threshold, psnr, threshold };

}

/**
 * Enabled visual gates are fail-closed: missing screenshots, empty frames,
 * comparison errors, and other skipped metrics are not successful evidence.
 */
export function pixelGatePassed( gate, enabled ) {

	return ! enabled || gate?.pass === true;

}
