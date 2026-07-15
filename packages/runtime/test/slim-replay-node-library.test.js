import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import ReplayNodeLibrary, { ReplayNodeLibrary as NamedReplayNodeLibrary } from '../src/slim-replay-node-library.js';

test( 'ReplayNodeLibrary starts empty and preserves precompiled node materials', () => {

	assert.equal( ReplayNodeLibrary, NamedReplayNodeLibrary );
	const library = new ReplayNodeLibrary();
	assert.equal( library.lightNodes instanceof WeakMap, true );
	assert.equal( library.materialNodes instanceof Map, true );
	assert.equal( library.toneMappingNodes instanceof Map, true );
	assert.equal( library.getMaterialNodeClass( 'MeshStandardMaterial' ), null );
	assert.equal( library.getToneMappingFunction( 1 ), null );
	assert.equal( library.getLightNodeClass( class Light {} ), null );
	assert.equal( library.fromMaterial( { type: 'MeshStandardMaterial' } ), null );

	const precompiled = { isNodeMaterial: true };
	assert.equal( library.fromMaterial( precompiled ), precompiled );

} );

test( 'ReplayNodeLibrary retains the private registration and conversion surface', () => {

	class SourceLight {}
	class ReplayLightNode {}
	class ReplayMaterialNode {

		constructor() { this.created = true; }

	}
	const toneMapping = () => {};
	const library = new ReplayNodeLibrary();

	library.addLight( ReplayLightNode, SourceLight );
	library.addMaterial( ReplayMaterialNode, 'SourceMaterial' );
	library.addToneMapping( toneMapping, 7 );

	assert.equal( library.getLightNodeClass( SourceLight ), ReplayLightNode );
	assert.equal( library.getMaterialNodeClass( 'SourceMaterial' ), ReplayMaterialNode );
	assert.equal( library.getToneMappingFunction( 7 ), toneMapping );

	const source = { type: 'SourceMaterial', opacity: 0.4, nested: { live: true } };
	const converted = library.fromMaterial( source );
	assert.equal( converted instanceof ReplayMaterialNode, true );
	assert.equal( converted.created, true );
	assert.equal( converted.opacity, 0.4 );
	assert.equal( converted.nested, source.nested );

	const types = new Map();
	const classes = new WeakMap();
	library.addType( ReplayMaterialNode, 'direct', types );
	library.addClass( ReplayLightNode, SourceLight, classes );
	assert.equal( types.get( 'direct' ), ReplayMaterialNode );
	assert.equal( classes.get( SourceLight ), ReplayLightNode );

} );

test( 'ReplayNodeLibrary validates registration inputs without importing compiler modules', () => {

	const library = new ReplayNodeLibrary();
	assert.throws( () => library.addType( {}, 'invalid', new Map() ), /Node class .* is not a class/ );
	assert.throws( () => library.addType( class Node {}, class Base {}, new Map() ), /Base class .* is not a class/ );
	assert.throws( () => library.addClass( {}, class Base {}, new WeakMap() ), /Node class .* is not a class/ );
	assert.throws( () => library.addClass( class Node {}, {}, new WeakMap() ), /Base class .* is not a class/ );

	const source = readFileSync( new URL( '../src/slim-replay-node-library.js', import.meta.url ), 'utf8' );
	assert.doesNotMatch( source, /three\/src\/(?:nodes|materials\/nodes)\// );
	assert.doesNotMatch( source, /^\s*import[^\n]*(?:NodeBuilder|\bTSL\b)/m );

} );
