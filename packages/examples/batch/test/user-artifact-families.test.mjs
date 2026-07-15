import { test } from 'node:test';
import assert from 'node:assert/strict';

import { coalesceUserArtifactVariantFamilies } from '../user-artifact-families.mjs';

test( 'coalesces separately named render contexts by authored material identity', () => {

	const materialUuid = 'shared-material';
	const rootName = 'example.html:MeshBasicNodeMaterial:48';
	const indexedName = 'example.html:MeshBasicNodeMaterial:60';
	const user = {
		[ indexedName ]: entry( artifact( {
			cacheKey: 60,
			materialUuid,
			selector: 'selector:indexed',
			sourceName: rootName,
		} ), 'indexed-hash' ),
		[ rootName ]: entry( artifact( {
			cacheKey: 48,
			materialUuid,
			selector: 'selector:non-indexed',
			sourceName: rootName,
		} ), 'root-hash' ),
		'unrelated.html:MeshBasicNodeMaterial:1': entry( artifact( {
			cacheKey: 1,
			materialUuid: 'unrelated-material',
			selector: 'selector:unrelated',
			sourceName: 'unrelated.html:MeshBasicNodeMaterial:1',
		} ), 'unrelated-hash' ),
	};

	const result = coalesceUserArtifactVariantFamilies( user );

	assert.deepEqual( result, { mergedFamilies: 1, removedEntries: 1 } );
	assert.deepEqual( Object.keys( user ).sort(), [ rootName, 'unrelated.html:MeshBasicNodeMaterial:1' ].sort() );
	assert.equal( user[ rootName ].__hash, undefined, 'partial-root hash is invalidated after family growth' );
	assert.equal( user[ 'unrelated.html:MeshBasicNodeMaterial:1' ].__hash, 'unrelated-hash' );
	assert.deepEqual( Object.keys( user[ rootName ].artifact.variants ), [ '48', '60' ] );
	assert.deepEqual( user[ rootName ].artifact.variants[ '48' ].renderContextSelectors, [ 'selector:non-indexed' ] );
	assert.deepEqual( user[ rootName ].artifact.variants[ '60' ].renderContextSelectors, [ 'selector:indexed' ] );

} );

test( 'prefers user material identity and a naturally ordered fallback root', () => {

	const user = {
		'example.html:MeshBasicNodeMaterial:10': entry( artifact( {
			cacheKey: 10,
			materialUuid: 'capture-copy-b',
			userMaterialUuid: 'authored-material',
			selector: 'selector:ten',
			sourceName: '',
		} ) ),
		'example.html:MeshBasicNodeMaterial:2': entry( artifact( {
			cacheKey: 2,
			materialUuid: 'capture-copy-a',
			userMaterialUuid: 'authored-material',
			selector: 'selector:two',
			sourceName: '',
		} ) ),
	};

	coalesceUserArtifactVariantFamilies( user );

	assert.deepEqual( Object.keys( user ), [ 'example.html:MeshBasicNodeMaterial:2' ] );
	assert.deepEqual(
		Object.keys( user[ 'example.html:MeshBasicNodeMaterial:2' ].artifact.variants ).sort( ( left, right ) => Number( left ) - Number( right ) ),
		[ '2', '10' ],
	);

} );

test( 'keeps divergent payload roots independent when they claim the same selector', () => {

	const firstName = 'example.html:MeshBasicNodeMaterial:1';
	const secondName = 'example.html:MeshBasicNodeMaterial:2';
	const first = artifact( {
		cacheKey: 1,
		materialUuid: 'shared-material',
		selector: 'selector:shared',
		sourceName: firstName,
	} );
	const second = artifact( {
		cacheKey: 2,
		materialUuid: 'shared-material',
		selector: 'selector:shared',
		sourceName: firstName,
	} );
	second.fragmentShader = 'different-fragment';
	const user = {
		[ firstName ]: entry( first, 'first-hash' ),
		[ secondName ]: entry( second, 'second-hash' ),
	};

	const result = coalesceUserArtifactVariantFamilies( user );

	assert.deepEqual( result, { mergedFamilies: 0, removedEntries: 0 } );
	assert.deepEqual( Object.keys( user ), [ firstName, secondName ] );
	assert.equal( user[ firstName ].__hash, 'first-hash' );
	assert.equal( user[ secondName ].__hash, 'second-hash' );

} );

function entry( artifactValue, hash = undefined ) {

	return {
		...( hash === undefined ? {} : { __hash: hash } ),
		artifact: artifactValue,
	};

}

function artifact( { cacheKey, materialUuid, userMaterialUuid, selector, sourceName } ) {

	return {
		version: '0.1.0',
		cacheKey,
		materialUuid,
		...( userMaterialUuid ? { userMaterialUuid } : {} ),
		materialShape: 'mesh-basic',
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		bindings: [],
		uniformPlan: [],
		renderContextSelectors: [ selector ],
		sourceMaterial: { name: sourceName },
	};

}
