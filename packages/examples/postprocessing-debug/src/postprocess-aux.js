export const POSTPROCESS_AUX_NAMES = Object.freeze( {
	passthrough: 'postprocessing-debug-passthrough',
	bloom: 'postprocessing-debug-bloom',
	fxaa: 'postprocessing-debug-fxaa',
	fxaaColor: 'postprocessing-debug-fxaa-color',
	gtao: 'postprocessing-debug-gtao',
	variantsPlain: 'postprocessing-debug-variants-plain',
	variantsBloom: 'postprocessing-debug-variants-bloom',
} );

/**
 * Bind a compiler-free pipeline to one exact named capture without importing
 * the broad runtime namespace. The generated aux module already owns the
 * registry and exposes the exact name/hash pair needed by replay.
 */
export async function bindPostprocessAuxByName( node, name ) {

	if ( ! node || ( typeof node !== 'object' && typeof node !== 'function' ) ) {

		throw new TypeError( 'bindPostprocessAuxByName: output node is required.' );

	}
	const { default: entries } = await import( 'virtual:tsl-precompile/__aux' );
	const matches = entries.filter( ( entry ) => entry.shape === 'post-process' && entry.name === name );
	if ( matches.length !== 1 ) {

		const known = entries
			.filter( ( entry ) => entry.shape === 'post-process' )
			.map( ( entry ) => entry.name || entry.configHash );
		throw new Error(
			`[postprocessing-debug] expected one post-process capture named ${ JSON.stringify( name ) }, ` +
			`found ${ matches.length }. Known captures: ${ known.length > 0 ? known.join( ', ' ) : '(none)' }. ` +
			'Recapture this route in dev mode before building the compiler-free site.'
		);

	}
	Object.defineProperty( node, '__tslpAuxShape', {
		value: 'post-process',
		enumerable: false,
		configurable: true,
		writable: true,
	} );
	Object.defineProperty( node, '__tslpAuxConfigHash', {
		value: matches[ 0 ].configHash,
		enumerable: false,
		configurable: true,
		writable: true,
	} );
	return node;

}
