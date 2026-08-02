const CALLBACK_TRACKED_LOADER_ADDONS = new Map( [
	[ 'loaders/GLTFLoader.js', 'GLTFLoader' ],
	[ 'loaders/KTX2Loader.js', 'KTX2Loader' ],
	[ 'loaders/UltraHDRLoader.js', 'UltraHDRLoader' ],
] );

export function isLoaderAddonReadinessPath( relativePath ) {

	return CALLBACK_TRACKED_LOADER_ADDONS.has( String( relativePath || '' ) );

}

/**
 * Keep loader readiness tied to the public loader callback, not only to the
 * underlying LoadingManager request. Some addons (notably UltraHDRLoader)
 * finish asynchronous image decoding after FileLoader has ended its item.
 *
 * @param {string} source
 * @param {string} relativePath
 * @return {string}
 */
export function rewriteLoaderAddonReadiness( source, relativePath ) {

	const text = String( source );
	const className = CALLBACK_TRACKED_LOADER_ADDONS.get( String( relativePath || '' ) );
	if ( ! className || text.includes( '__tslpPatchTextureLoaderClass' ) ) return text;
	const exportRe = new RegExp( `export\\s*\\{\\s*${ className }\\s*\\};` );
	if ( ! exportRe.test( text ) ) return text;
	return text.replace(
		exportRe,
		`if ( globalThis.__tslpPatchTextureLoaderClass ) globalThis.__tslpPatchTextureLoaderClass( ${ className }, '${ className }' );\nexport { ${ className } };`,
	);

}
