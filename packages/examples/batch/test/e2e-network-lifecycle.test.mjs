import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
	e2eNetworkObservationIssues,
	installE2ENetworkCaptureCollector,
} from '../e2e-network-evidence.mjs';

class Context extends EventEmitter {

	async route( pattern, handler ) {

		this.routePattern = pattern;
		this.routeHandler = handler;

	}

	async routeWebSocket() {}

	async unroute( pattern, handler ) {

		assert.equal( pattern, this.routePattern );
		assert.equal( handler, this.routeHandler );
		this.routeHandler = null;

	}

}

function request( url = 'https://assets.example.test/texture.bin' ) {

	return {
		url: () => url,
		method: () => 'GET',
		resourceType: () => 'fetch',
		headers: () => ( {} ),
	};

}

const options = { pageUrl: 'http://localhost:8790/scene.html', serviceWorkersBlocked: true };

test( 'a failed collector installation removes the route it already installed', async () => {

	const context = new Context();
	const failure = new Error( 'WebSocket routing unsupported' );
	context.routeWebSocket = async () => { throw failure; };
	await assert.rejects( installE2ENetworkCaptureCollector( context, options ), ( error ) => error === failure );
	assert.equal( context.routeHandler, null );
	assert.deepEqual( context.eventNames(), [] );

} );

test( 'disposal preserves sealed evidence while removing live context handlers', async () => {

	const context = new Context();
	const collector = await installE2ENetworkCaptureCollector( context, options );
	const req = request();
	await context.routeHandler( { request: () => req, continue: async () => {} } );
	context.emit( 'request', req );
	const bytes = Buffer.alloc( 8192, 42 );
	context.emit( 'response', {
		request: () => req,
		status: () => 200,
		statusText: () => 'OK',
		headers: () => ( { 'content-type': 'application/octet-stream' } ),
		finished: async () => null,
		body: async () => bytes,
	} );
	context.emit( 'requestfinished', req );
	const sealed = await collector.drain( { settleMs: 0 } );
	assert.deepEqual( e2eNetworkObservationIssues( sealed.observation ), [] );
	assert.equal( sealed.bodies.size, 1 );
	await collector.dispose();
	await collector.dispose();
	assert.equal( context.routeHandler, null );
	assert.deepEqual( context.eventNames(), [] );
	assert.equal( sealed.bodies.get( sealed.observation.resources[ 0 ].sha256 ), bytes );
	assert.deepEqual( e2eNetworkObservationIssues( sealed.observation ), [] );
	collector.assertNoLateRequests();

} );

test( 'disposal waits for an in-flight body before releasing visit state', async () => {

	const context = new Context();
	const collector = await installE2ENetworkCaptureCollector( context, options );
	const req = request();
	let releaseBody;
	const body = new Promise( ( resolve ) => { releaseBody = resolve; } );
	context.emit( 'response', {
		request: () => req,
		status: () => 200,
		headers: () => ( {} ),
		finished: async () => null,
		body: () => body,
	} );
	let disposed = false;
	const disposing = collector.dispose().then( () => { disposed = true; } );
	await new Promise( ( resolve ) => setImmediate( resolve ) );
	assert.equal( disposed, false );
	releaseBody( Buffer.from( 'loaded' ) );
	await disposing;
	assert.equal( disposed, true );
	assert.deepEqual( context.eventNames(), [] );

} );

test( 'a rejected route does not leave an unhandled bookkeeping rejection', async () => {

	const context = new Context();
	const collector = await installE2ENetworkCaptureCollector( context, options );
	const failure = new Error( 'browser disconnected' );
	const unhandled = [];
	const onUnhandled = ( error ) => unhandled.push( error );
	process.on( 'unhandledRejection', onUnhandled );
	try {

		await assert.rejects( context.routeHandler( {
			request: () => request( options.pageUrl ),
			continue: async () => { throw failure; },
		} ), ( error ) => error === failure );
		await new Promise( ( resolve ) => setImmediate( resolve ) );
		assert.deepEqual( unhandled, [] );

	} finally {

		process.off( 'unhandledRejection', onUnhandled );
		await collector.dispose();

	}

} );
