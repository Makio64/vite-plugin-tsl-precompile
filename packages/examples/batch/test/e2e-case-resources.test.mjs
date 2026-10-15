import assert from 'node:assert/strict';
import test from 'node:test';

import { withE2ECaseResources } from '../e2e-case-resources.mjs';

function visit( cleanup ) {

	return { cleanup, context: {}, page: {}, shot: Buffer.alloc( 1024 ) };

}

test( 'a completed case releases visits and captures after its result is constructed', async () => {

	const captures = new Map( [ [ 'scene.html', { stale: true } ], [ 'other.html', {} ] ] );
	const events = [];
	const stock = visit( async () => events.push( 'stock' ) );
	const replay = visit( async () => events.push( 'replay' ) );
	const result = { status: 'pass' };
	assert.equal( await withE2ECaseResources( captures, 'scene.html', async ( ownVisit ) => {

		assert.equal( captures.has( 'scene.html' ), false );
		captures.set( 'scene.html', { user: { large: [] }, aux: [] } );
		assert.equal( ownVisit( stock ), stock );
		ownVisit( replay );
		assert.ok( stock.shot );
		assert.ok( replay.page );
		return result;

	} ), result );
	assert.deepEqual( events, [ 'stock', 'replay' ] );
	assert.equal( captures.has( 'scene.html' ), false );
	assert.equal( captures.has( 'other.html' ), true );
	for ( const owned of [ stock, replay ] ) {

		assert.deepEqual( owned, { cleanup: null, context: null, page: null, shot: null } );

	}

} );

test( 'evidence failure releases partial visits and payloads before the next case', async () => {

	const captures = new Map();
	const failure = new Error( 'artifact evidence serialization failed' );
	let disposed = 0;
	const partial = visit( async () => disposed ++ );
	await assert.rejects( withE2ECaseResources( captures, 'failed.html', async ( ownVisit ) => {

		ownVisit( partial );
		captures.set( 'failed.html', { user: { huge: [] }, aux: [] } );
		throw failure;

	} ), ( error ) => error === failure );
	assert.equal( disposed, 1 );
	assert.equal( captures.size, 0 );
	assert.equal( partial.page, null );
	assert.equal( partial.shot, null );
	await withE2ECaseResources( captures, 'next.html', async () => {

		assert.equal( captures.has( 'failed.html' ), false );

	} );

} );

test( 'failed page cleanup still releases other visits and preserves the case failure', async () => {

	const captures = new Map();
	const failure = new Error( 'capture failed' );
	let disposed = 0;
	const broken = visit( async () => { throw new Error( 'browser disconnected' ); } );
	const remaining = visit( async () => disposed ++ );
	await assert.rejects( withE2ECaseResources( captures, 'failed.html', async ( ownVisit ) => {

		ownVisit( broken );
		ownVisit( remaining );
		captures.set( 'failed.html', {} );
		throw failure;

	} ), ( error ) => error === failure );
	assert.equal( disposed, 1 );
	assert.equal( captures.size, 0 );
	assert.equal( broken.context, null );
	assert.equal( remaining.context, null );

} );

test( 'already closed stock and capture visits are not closed twice', async () => {

	let disposed = 0;
	const stock = visit( async () => disposed ++ );
	await withE2ECaseResources( new Map(), 'scene.html', async ( ownVisit ) => {

		ownVisit( stock );
		ownVisit( stock );
		await stock.cleanup();
		stock.cleanup = null;

	} );
	assert.equal( disposed, 1 );
	assert.equal( stock.shot, null );

} );
