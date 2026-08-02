import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
	BROWSER_FAILURE_POLICY_SHA256,
	classifyBrowserFailureEvent,
	installBrowserFailureCollector,
	isSameOriginExactFaviconUrl,
} from '../../browser-failure-policy.mjs';
import {
	SLIM_BROWSER_GATE_POLICY_SHA256,
	classifySlimBrowserFailures,
	isExpectedSlimBrowserFailure,
} from '../slim-browser-gate.mjs';

const PAGE_URL = 'http://127.0.0.1:5192/scene.html';

function mockRequest( url, { errorText = null, method = 'GET' } = {} ) {

	return {
		failure: () => errorText === null ? null : { errorText },
		method: () => method,
		url: () => url,
	};

}

function emitResponse( page, request, status = 200 ) {

	page.emit( 'response', {
		request: () => request,
		status: () => status,
		url: () => request.url(),
	} );

}

test( 'favicon exemption is exact, same-origin, and query-free', () => {

	assert.equal( isSameOriginExactFaviconUrl( 'http://127.0.0.1:5192/favicon.ico', PAGE_URL ), true );
	assert.equal( isSameOriginExactFaviconUrl( 'http://127.0.0.1:5192/assets/favicon.ico', PAGE_URL ), false );
	assert.equal( isSameOriginExactFaviconUrl( 'http://127.0.0.1:5192/favicon.ico?v=1', PAGE_URL ), false );
	assert.equal( isSameOriginExactFaviconUrl( 'http://localhost:5192/favicon.ico', PAGE_URL ), false );
	assert.equal( isSameOriginExactFaviconUrl( 'https://example.invalid/favicon.ico', PAGE_URL ), false );

} );

test( 'generic resource errors and non-favicon HTTP failures fail closed', () => {

	assert.match( classifyBrowserFailureEvent( {
		kind: 'console',
		level: 'error',
		message: 'Failed to load resource: the server responded with a status of 404',
		url: 'http://127.0.0.1:5192/assets/model.glb',
	}, { pageUrl: PAGE_URL } ).text, /model\.glb/ );
	assert.match( classifyBrowserFailureEvent( {
		kind: 'requestfailed',
		method: 'GET',
		message: 'net::ERR_FAILED',
		url: 'http://127.0.0.1:5192/assets/model.glb',
	}, { pageUrl: PAGE_URL } ).text, /requestfailed/ );
	assert.match( classifyBrowserFailureEvent( {
		kind: 'response',
		method: 'GET',
		status: 404,
		url: 'http://127.0.0.1:5192/assets/model.glb',
	}, { pageUrl: PAGE_URL } ).text, /HTTP 404/ );

} );

test( 'failed console assertions are fatal browser failures', () => {

	const failure = classifyBrowserFailureEvent( {
		kind: 'console',
		level: 'assert',
		message: 'Assertion failed: renderer invariant',
		url: 'http://127.0.0.1:5192/scene.js',
	}, { pageUrl: PAGE_URL } );
	assert.match( failure.text, /console\.assert: Assertion failed: renderer invariant/ );
	assert.equal( classifyBrowserFailureEvent( {
		kind: 'console',
		level: 'warning',
		message: 'ordinary warning',
	}, { pageUrl: PAGE_URL } ), null );

} );

test( 'only exact favicon resource failures are exempt', () => {

	for ( const event of [
		{
			kind: 'console',
			level: 'error',
			message: 'Failed to load resource: the server responded with a status of 404',
			url: 'http://127.0.0.1:5192/favicon.ico',
		},
		{
			kind: 'requestfailed',
			message: 'net::ERR_FAILED',
			url: 'http://127.0.0.1:5192/favicon.ico',
		},
		{
			kind: 'response',
			status: 404,
			url: 'http://127.0.0.1:5192/favicon.ico',
		},
	] ) assert.equal( classifyBrowserFailureEvent( event, { pageUrl: PAGE_URL } ), null );

	assert.notEqual( classifyBrowserFailureEvent( {
		kind: 'console',
		level: 'error',
		message: 'application failed while handling favicon',
		url: 'http://127.0.0.1:5192/favicon.ico',
	}, { pageUrl: PAGE_URL } ), null );
	assert.notEqual( classifyBrowserFailureEvent( {
		kind: 'response',
		method: 'POST',
		status: 500,
		url: 'http://127.0.0.1:5192/favicon.ico',
	}, { pageUrl: PAGE_URL } ), null );

} );

test( 'collector correlates only the URL-less console duplicate of an observed favicon failure', () => {

	const page = new EventEmitter();
	const collector = installBrowserFailureCollector( page, { pageUrl: PAGE_URL } );
	page.emit( 'response', {
		status: () => 404,
		url: () => 'http://127.0.0.1:5192/favicon.ico',
		request: () => ( {
			method: () => 'GET',
			url: () => 'http://127.0.0.1:5192/favicon.ico',
		} ),
	} );
	page.emit( 'console', {
		type: () => 'error',
		text: () => 'Failed to load resource: the server responded with a status of 404 (Not Found)',
		location: () => ( { url: '' } ),
	} );
	assert.deepEqual( collector.failures(), [] );

	page.emit( 'console', {
		type: () => 'error',
		text: () => 'Failed to load resource: the server responded with a status of 404 (Not Found)',
		location: () => ( { url: '' } ),
	} );
	assert.match( collector.failures()[ 0 ].text, /console\.error: Failed to load resource/ );
	collector.dispose();

} );

test( 'collector keeps non-favicon resource failures fatal beside a favicon duplicate', () => {

	const page = new EventEmitter();
	const collector = installBrowserFailureCollector( page, { pageUrl: PAGE_URL } );
	for ( const url of [
		'http://127.0.0.1:5192/favicon.ico',
		'http://127.0.0.1:5192/assets/model.glb',
	] ) page.emit( 'response', {
		status: () => 404,
		url: () => url,
		request: () => ( { method: () => 'GET', url: () => url } ),
	} );
	page.emit( 'console', {
		type: () => 'error',
		text: () => 'Failed to load resource: the server responded with a status of 404 (Not Found)',
		location: () => ( { url: '' } ),
	} );
	assert.equal( collector.failures().length, 1 );
	assert.match( collector.failures()[ 0 ].text, /HTTP 404.*model\.glb/ );
	collector.dispose();

} );

test( 'redirects and intentional non-network requests are not failures', () => {

	assert.equal( classifyBrowserFailureEvent( {
		kind: 'response',
		status: 308,
		url: 'http://127.0.0.1:5192/redirect',
	}, { pageUrl: PAGE_URL } ), null );
	for ( const url of [ 'about:blank', 'blob:http://127.0.0.1:5192/abc', 'data:image/png;base64,AA==' ] ) {

		assert.equal( classifyBrowserFailureEvent( {
			kind: 'requestfailed',
			message: 'aborted',
			url,
		}, { pageUrl: PAGE_URL } ), null );

	}

} );

test( 'collector reconciles an exact aborted duplicate only after a successful response finishes', () => {

	const page = new EventEmitter();
	const collector = installBrowserFailureCollector( page, { pageUrl: PAGE_URL } );
	const url = 'https://threejs.org/examples/models/gltf/Soldier.glb';
	const aborted = mockRequest( url, { errorText: 'net::ERR_ABORTED' } );
	const completed = mockRequest( url );

	page.emit( 'requestfailed', aborted );
	assert.match( collector.messages()[ 0 ], /Soldier\.glb.*net::ERR_ABORTED/ );
	emitResponse( page, completed, 200 );
	assert.match( collector.messages()[ 0 ], /Soldier\.glb.*net::ERR_ABORTED/ );
	page.emit( 'requestfinished', completed );
	assert.deepEqual( collector.failures(), [] );
	collector.dispose();

} );

test( 'collector requires the successful completion to belong to a distinct duplicate request', () => {

	const page = new EventEmitter();
	const collector = installBrowserFailureCollector( page, { pageUrl: PAGE_URL } );
	const request = mockRequest( 'https://cdn.example.invalid/model.glb', { errorText: 'net::ERR_ABORTED' } );
	page.emit( 'requestfailed', request );
	emitResponse( page, request, 200 );
	page.emit( 'requestfinished', request );
	assert.equal( collector.failures().some( entry => entry.kind === 'requestfailed' ), true );
	collector.dispose();

} );

test( 'aborted-request reconciliation is exact and remains fail-closed', () => {

	for ( const scenario of [
		{
			name: 'method mismatch',
			failure: mockRequest( 'https://cdn.example.invalid/model.glb', { errorText: 'net::ERR_ABORTED', method: 'GET' } ),
			completed: mockRequest( 'https://cdn.example.invalid/model.glb', { method: 'HEAD' } ),
			status: 200,
		},
		{
			name: 'URL mismatch',
			failure: mockRequest( 'https://cdn.example.invalid/model.glb?v=1', { errorText: 'net::ERR_ABORTED' } ),
			completed: mockRequest( 'https://cdn.example.invalid/model.glb?v=2' ),
			status: 200,
		},
		{
			name: 'non-exact abort message',
			failure: mockRequest( 'https://cdn.example.invalid/model.glb', { errorText: 'net::ERR_ABORTED (canceled)' } ),
			completed: mockRequest( 'https://cdn.example.invalid/model.glb' ),
			status: 200,
		},
		{
			name: 'failed HTTP response',
			failure: mockRequest( 'https://cdn.example.invalid/model.glb', { errorText: 'net::ERR_ABORTED' } ),
			completed: mockRequest( 'https://cdn.example.invalid/model.glb' ),
			status: 404,
		},
	] ) {

		const page = new EventEmitter();
		const collector = installBrowserFailureCollector( page, { pageUrl: PAGE_URL } );
		page.emit( 'requestfailed', scenario.failure );
		emitResponse( page, scenario.completed, scenario.status );
		page.emit( 'requestfinished', scenario.completed );
		assert.equal( collector.failures().some( entry => entry.kind === 'requestfailed' ), true, scenario.name );
		collector.dispose();

	}

} );

test( 'aborted-request reconciliation is one-for-one and checkpoint-scoped', () => {

	const page = new EventEmitter();
	const collector = installBrowserFailureCollector( page, { pageUrl: PAGE_URL } );
	const url = 'https://cdn.example.invalid/model.fbx';
	const abort = () => page.emit( 'requestfailed', mockRequest( url, { errorText: 'net::ERR_ABORTED' } ) );
	const finish = () => {

		const request = mockRequest( url );
		emitResponse( page, request, 204 );
		page.emit( 'requestfinished', request );

	};

	abort();
	abort();
	finish();
	assert.equal( collector.failures().length, 1 );
	finish();
	assert.deepEqual( collector.failures(), [] );

	const checkpoint = collector.checkpoint();
	abort();
	assert.equal( collector.failuresSince( checkpoint ).length, 1 );
	finish();
	assert.deepEqual( collector.failuresSince( checkpoint ), [] );
	collector.dispose();

} );

test( 'slim allowance accepts only a complete expected diagnostic', () => {

	const exact = {
		kind: 'pageerror',
		message: '[tsl-precompile/slim] TSL.Fn() is not available in the slim bundle. Slim mode supports only PrecompiledMaterial — the TSL builder and its auxiliary nodes are stripped at build time.',
		text: 'pageerror: expected',
	};
	assert.equal( isExpectedSlimBrowserFailure( exact ), true );
	assert.equal( isExpectedSlimBrowserFailure( {
		...exact,
		message: `unrelated crash; ${ exact.message }`,
	} ), false );
	assert.equal( isExpectedSlimBrowserFailure( {
		...exact,
		message: `${ exact.message }\nadditional non-stack failure`,
	} ), false );
	assert.equal( isExpectedSlimBrowserFailure( {
		kind: 'pageerror',
		message: '[tsl-precompile/slim] new NodeMaterial() is not available. Use .precompile(name) in dev and PrecompiledMaterial at runtime.',
	} ), true );
	assert.match( BROWSER_FAILURE_POLICY_SHA256, /^[a-f0-9]{64}$/ );
	assert.match( SLIM_BROWSER_GATE_POLICY_SHA256, /^[a-f0-9]{64}$/ );

} );

test( 'an expected slim diagnostic cannot hide another browser failure', () => {

	const expected = {
		kind: 'pageerror',
		message: '[tsl-precompile/slim] only PrecompiledComputeNode is supported in the slim bundle. Did you forget to wrap a compute artifact?',
		text: 'pageerror: expected slim failure',
	};
	const unrelated = {
		kind: 'console',
		message: 'ReferenceError: unrelated',
		text: 'console.error: ReferenceError: unrelated',
	};
	const network = {
		kind: 'response',
		message: 'HTTP 500',
		text: 'HTTP 500: GET http://127.0.0.1:5192/data.bin',
	};
	assert.deepEqual(
		{
			status: classifySlimBrowserFailures( [ expected ] ).status,
			category: classifySlimBrowserFailures( [ expected ] ).category,
		},
		{ status: 'pass', category: 'expected-slim-fail' },
	);
	assert.deepEqual(
		{
			status: classifySlimBrowserFailures( [ expected, unrelated ] ).status,
			category: classifySlimBrowserFailures( [ expected, unrelated ] ).category,
		},
		{ status: 'fail', category: 'other-error' },
	);
	assert.deepEqual(
		{
			status: classifySlimBrowserFailures( [ expected, network ] ).status,
			category: classifySlimBrowserFailures( [ expected, network ] ).category,
		},
		{ status: 'fail', category: 'resource-load-error' },
	);

} );
