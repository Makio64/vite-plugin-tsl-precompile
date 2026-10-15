import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { createRenderObjectContextSelector } from '@tsl-precompile/contract/render-selector';
import {
	installDeterministicObjectIds,
	rewriteThreeCoreDeterministicObjectIds,
	rewriteSlimDeterministicObjectIds,
} from '../e2e-object-id-policy.mjs';

test( 'page-local ids preserve native light ordering through capture clones without stack allocation', async ( t ) => {

	const previous = Object.getOwnPropertyDescriptor( globalThis, '__tslpStableObject3DId' );
	t.after( () => {

		if ( previous ) Object.defineProperty( globalThis, '__tslpStableObject3DId', previous );
		else delete globalThis.__tslpStableObject3DId;

	} );
	const require = createRequire( import.meta.url );
	const nativeUrl = pathToFileURL( require.resolve( 'three/src/core/Object3D.js' ) );
	const nativeSource = readFileSync( nativeUrl, 'utf8' );
	const rewritten = rewriteThreeCoreDeterministicObjectIds( nativeSource );
	assert.notEqual( rewritten, nativeSource, 'the actual native constructor must match the harness seam' );
	const absoluteSource = rewritten.replace( /from '([^']+)'/g, ( _, specifier ) => `from '${ new URL( specifier, nativeUrl ).href }'` );
	const { Object3D } = await import( `data:text/javascript;base64,${ Buffer.from( absoluteSource ).toString( 'base64' ) }` );
	installDeterministicObjectIds();
	class Light extends Object3D {

		constructor() { super(); this.isLight = true; }
		copy( source ) { super.copy( source ); this.type = source.type; return this; }

	}
	const lights = [ new Light(), new Light() ];
	lights[ 0 ].type = 'PointLight';
	lights[ 1 ].type = 'HemisphereLight';
	// Synthetic extraction may allocate unrelated objects between clone calls.
	const clones = lights.map( light => { new Object3D(); return light.clone(); } );
	const selector = values => JSON.parse( createRenderObjectContextSelector( { lightsNode: { lights: values } } ) ).lights;
	assert.deepEqual( selector( clones.reverse() ), selector( lights ), 'native id sorting preserves the same binding order' );
	assert.equal( new Set( [ ...lights, ...clones ].map( light => light.id ) ).size, 4 );
	assert.doesNotMatch( installDeterministicObjectIds.toString(), /new Error|\.stack/ );

} );

test( 'serialized browser hook resets independently for each page and serves minified constructors', () => {

	const pages = [ {}, {} ];
	for ( const page of pages ) runInNewContext( `(${ installDeterministicObjectIds.toString() })()`, page );
	const source = 'let x=800; function Object3D(){this.isObject3D=!0,Object.defineProperty(this,"id",{value:x++})}';
	const rewritten = rewriteSlimDeterministicObjectIds( source );
	assert.notEqual( rewritten, source );
	for ( const page of pages ) {

		assert.deepEqual( Array.from( runInNewContext( `${ rewritten }; [new Object3D().id,new Object3D().id]`, page ) ), [ 0, 1 ] );

	}
	assert.equal( pages[ 0 ].__tslpStableObject3DId(), 2 );
	assert.equal( pages[ 1 ].__tslpStableObject3DId(), 2 );
	assert.equal( runInNewContext( `${ rewritten }; new Object3D().id` ), 800, 'without the harness native allocation stays intact' );

} );
