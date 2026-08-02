import assert from 'node:assert/strict';
import test from 'node:test';

import { isLoaderAddonReadinessPath, rewriteLoaderAddonReadiness } from '../e2e-loader-readiness.mjs';

test( 'UltraHDR readiness remains pending through asynchronous gainmap decoding', () => {

	const source = [
		'class UltraHDRLoader {}',
		'export { UltraHDRLoader };',
	].join( '\n' );
	const rewritten = rewriteLoaderAddonReadiness( source, 'loaders/UltraHDRLoader.js' );

	assert.match(
		rewritten,
		/globalThis\.__tslpPatchTextureLoaderClass\( UltraHDRLoader, 'UltraHDRLoader' \);/,
	);
	assert.equal(
		rewriteLoaderAddonReadiness( rewritten, 'loaders/UltraHDRLoader.js' ),
		rewritten,
		'rewrite is idempotent',
	);

} );

test( 'loader readiness rewrite remains scoped to tracked addon loaders', () => {

	const source = 'class OtherLoader {}\nexport { OtherLoader };';
	assert.equal( rewriteLoaderAddonReadiness( source, 'loaders/OtherLoader.js' ), source );
	assert.equal( isLoaderAddonReadinessPath( 'loaders/OtherLoader.js' ), false );
	for ( const [ path, className ] of [
		[ 'loaders/GLTFLoader.js', 'GLTFLoader' ],
		[ 'loaders/KTX2Loader.js', 'KTX2Loader' ],
		[ 'loaders/UltraHDRLoader.js', 'UltraHDRLoader' ],
	] ) {

		assert.equal( isLoaderAddonReadinessPath( path ), true, path );
		assert.match(
			rewriteLoaderAddonReadiness( `class ${ className } {}\nexport { ${ className } };`, path ),
			new RegExp( `__tslpPatchTextureLoaderClass\\( ${ className }, '${ className }' \\)` ),
		);

	}

} );
