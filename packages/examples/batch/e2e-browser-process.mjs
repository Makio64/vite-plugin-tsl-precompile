import childProcess from 'node:child_process';
import diagnostics from 'node:diagnostics_channel';
import { launchEvidenceBrowser } from './e2e-environment.mjs';

const owners = new WeakMap();
const closes = new WeakMap();
const POSIX_PLATFORMS = new Set( [ 'darwin', 'linux' ] );
const MAX_OBSERVED_CHILDREN = 32;
const MAX_GRACE_MS = 2 ** 31 - 1;

function hasExited( child ) {

	return Number.isInteger( child.exitCode ) || typeof child.signalCode === 'string';

}

function observeChild( child ) {

	const owner = { child, pid: null, exited: hasExited( child ), closed: false };
	owner.onExit = () => { owner.exited = true; };
	owner.close = new Promise( resolve => {

		owner.onClose = () => { owner.exited = true; owner.closed = true; resolve(); };

	} );
	child.once( 'exit', owner.onExit );
	child.once( 'close', owner.onClose );
	return owner;

}

function releaseChild( owner ) {

	owner.child.removeListener( 'exit', owner.onExit );
	owner.child.removeListener( 'close', owner.onClose );

}

function ownerIsAlive( owner ) {

	if ( hasExited( owner.child ) ) owner.exited = true;
	return ! owner.exited && ! owner.closed && owner.child.pid === owner.pid &&
		owner.child.exitCode === null && owner.child.signalCode === null;

}

async function browserProcessId( browser ) {

	let session;
	try {

		session = await browser.newBrowserCDPSession();
		const result = await session.send( 'SystemInfo.getProcessInfo' );
		const browsers = result?.processInfo?.filter( entry => entry.type === 'browser' );
		return browsers?.length === 1 && Number.isSafeInteger( browsers[ 0 ].id ) && browsers[ 0 ].id > 1
			? browsers[ 0 ].id : null;

	} catch { return null; }
	finally { await session?.detach(); }

}

/** Track a fresh private launcher without changing its transport or policy. */
export async function launchOwnedBrowser( launch, { platform = process.platform } = {} ) {

	if ( ! POSIX_PLATFORMS.has( platform ) || ! POSIX_PLATFORMS.has( process.platform ) ||
		typeof diagnostics.subscribe !== 'function' || typeof diagnostics.unsubscribe !== 'function' ) return launch();
	const children = new Map();
	let overflow = false;
	const collect = message => {

		try {

			const child = message?.process;
			if ( overflow || ! ( child instanceof childProcess.ChildProcess ) || children.has( child ) ) return;
			if ( children.size >= MAX_OBSERVED_CHILDREN ) {

				overflow = true;
				for ( const candidate of children.values() ) releaseChild( candidate );
				children.clear();
				return;

			}
			children.set( child, observeChild( child ) );

		} catch { /* Unsupported diagnostic payloads cannot establish ownership. */ }

	};
	let selected, owner, subscribed = true;
	const stopCapture = () => {

		if ( subscribed ) { diagnostics.unsubscribe( 'child_process', collect ); subscribed = false; }

	};
	diagnostics.subscribe( 'child_process', collect );
	try {

		selected = await launch();
		if ( ! overflow && children.size > 0 ) {

			const pid = await browserProcessId( selected.browser );
			const matches = [ ...children.values() ].filter( entry => entry.child.pid === pid );
			if ( Number.isSafeInteger( pid ) && pid > 1 && matches.length === 1 && pid !== process.pid ) {

				const candidate = matches[ 0 ];
				candidate.pid = pid;
				if ( ownerIsAlive( candidate ) ) { owner = candidate; owners.set( selected.browser, owner ); }

			}

		}
		return selected;

	} catch ( error ) {

		stopCapture();
		if ( selected ) {

			try { await selected.browser.close(); }
			catch ( cleanupError ) { throw new AggregateError( [ error, cleanupError ], 'Browser process probe and cleanup failed.' ); }

		}
		throw error;

	} finally {

		stopCapture();
		for ( const candidate of children.values() ) if ( candidate !== owner ) releaseChild( candidate );

	}

}

/** Preserve direct Playwright transport and the evidence environment policy. */
export function launchOwnedEvidenceBrowser( chromium, options = {} ) {

	return launchOwnedBrowser( () => launchEvidenceBrowser( chromium, options ), { platform: options.platform || process.platform } );

}

function contextsAreEmpty( browser ) {

	try {

		const contexts = browser.contexts();
		return Array.isArray( contexts ) && contexts.length === 0;

	} catch { return false; }

}

async function closeWithinGrace( graceful, graceMs ) {

	let timer;
	try {

		return await Promise.race( [
			graceful.then( () => true, () => false ),
			new Promise( resolve => { timer = setTimeout( () => resolve( false ), graceMs ); } ),
		] );

	} finally { clearTimeout( timer ); }

}

function readOwnedGroup( owner ) {

	return new Promise( resolve => {

		try { childProcess.execFile( '/bin/ps', [ '-p', String( owner.pid ), '-o', 'pid=,ppid=,pgid=' ],
			{ encoding: 'utf8', timeout: 1000, maxBuffer: 4096 }, ( error, stdout ) => {

				if ( error ) { resolve( false ); return; }
				const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec( stdout );
				resolve( !! row && Number( row[ 1 ] ) === owner.pid &&
					Number( row[ 2 ] ) === process.pid && Number( row[ 3 ] ) === owner.pid );

			} ); } catch { resolve( false ); }

	} );

}

async function closeProcessOwner( browser, owner, graceMs ) {

	const errors = [];
	const graceful = Promise.resolve().then( () => browser.close() );
	const settled = graceful.catch( error => { errors.push( error ); } );
	const ready = Promise.all( [ graceful, owner.close ] );
	// Observe readiness rejection even when active contexts require graceful cleanup.
	ready.catch( () => {} );
	try {

		let killFailed = false;
		if ( contextsAreEmpty( browser ) && ! await closeWithinGrace( ready, graceMs ) &&
			ownerIsAlive( owner ) && await readOwnedGroup( owner ) && ownerIsAlive( owner ) && contextsAreEmpty( browser ) ) {

			try { process.kill( - owner.pid, 'SIGKILL' ); }
			catch ( error ) { killFailed = true; errors.push( error ); }

		}
		if ( ! killFailed ) await owner.close;
		await settled;
		if ( errors.length ) throw new AggregateError( errors, 'Owned browser process cleanup failed.' );

	} finally {

		releaseChild( owner ); owners.delete( browser );

	}

}

/** Only use after evidence gates and context cleanup; borrowed browsers stay graceful. */
export function closeOwnedEvidenceBrowser( browser, { graceMs = 250 } = {} ) {

	if ( ! browser ) return Promise.resolve();
	if ( ! Number.isFinite( graceMs ) || graceMs < 0 || graceMs > MAX_GRACE_MS ) return Promise.reject( new TypeError( 'Browser close grace must be between 0 and 2147483647 milliseconds.' ) );
	if ( closes.has( browser ) ) return closes.get( browser );
	const owner = owners.get( browser );
	const close = owner ? closeProcessOwner( browser, owner, graceMs ) : Promise.resolve().then( () => browser.close() );
	closes.set( browser, close );
	return close;

}
