/**
 * Owner-scoped, once-per-logical-frame scheduling for postprocess work.
 *
 * A RenderPipeline can be entered more than once during one application frame,
 * and fallback renderers may enter separate temporal scopes for the same frame.
 * This scheduler keeps claims on the pipeline owner rather than on an ephemeral
 * scope, while still requiring the explicit `(frameId, renderId)` pair.
 */

import { createTemporalNodeFrame } from './temporal-frame.js';

const OWNER_SCHEDULERS = new WeakMap();

export const POSTPROCESS_FRAME_ROLES = Object.freeze( {
	PRODUCER: 'producer',
	CONTEXT_EFFECT: 'context-effect',
	CONSUMER: 'consumer',
	EFFECT: 'effect',
	TERMINAL_EFFECT: 'terminal-effect',
} );

function isIdentity( value ) {

	return value !== undefined && value !== null;

}

function validateRole( role ) {

	if ( typeof role !== 'string' || role.length === 0 ) throw new TypeError( 'PostprocessFrameScheduler.run: role must be a non-empty string.' );

}

function entryStatus( entry ) {

	if ( ! entry ) return { status: 'missing', role: null, attempts: 0 };
	return {
		status: entry.status,
		role: entry.role,
		attempts: entry.attempts,
		value: entry.value,
		error: entry.error,
		reason: entry.reason,
		blockedBy: entry.blockedBy ? entry.blockedBy.slice() : [],
		promise: entry.promise,
	};

}

function frameMatches( record, nodeFrame ) {

	return Object.is( record.frameId, nodeFrame.frameId ) && Object.is( record.renderId, nodeFrame.renderId );

}

function hasPendingClaims( record ) {

	for ( const entry of record.entries.values() ) if ( entry.status === 'pending' ) return true;
	return false;

}

function createScheduler( owner, options ) {

	const frames = [];
	const maxFrames = Number.isInteger( options.maxFrames ) && options.maxFrames > 0 ? options.maxFrames : 8;

	function frameRecord( nodeFrame ) {

		let record = frames.find( ( candidate ) => frameMatches( candidate, nodeFrame ) );
		if ( record ) {

			const index = frames.indexOf( record );
			if ( index >= 0 && index !== frames.length - 1 ) frames.push( ...frames.splice( index, 1 ) );
			return record;

		}
		record = {
			frameId: nodeFrame.frameId,
			renderId: nodeFrame.renderId,
			entries: new Map(),
			conflicts: [],
		};
		frames.push( record );
		while ( frames.length > maxFrames ) {

			const removable = frames.findIndex( ( candidate ) => candidate !== record && ! hasPendingClaims( candidate ) );
			if ( removable < 0 ) break;
			frames.splice( removable, 1 );

		}
		return record;

	}

	function begin( renderer, overrides = {} ) {

		const nodeFrame = createTemporalNodeFrame( renderer, overrides );
		const record = frameRecord( nodeFrame );

		function getStatus( identity ) {

			return entryStatus( record.entries.get( identity ) );

		}

		function hasSucceeded( identity, role ) {

			const entry = record.entries.get( identity );
			return !! ( entry && entry.status === 'succeeded' && ( role === undefined || entry.role === role ) );

		}

		function blockForDependencies( entry, dependencies ) {

			const blockedBy = [];
			for ( const dependency of dependencies ) {

				const dependencyEntry = record.entries.get( dependency );
				if ( ! dependencyEntry || dependencyEntry.status !== 'succeeded' ) blockedBy.push( {
					identity: dependency,
					status: dependencyEntry ? dependencyEntry.status : 'missing',
					role: dependencyEntry ? dependencyEntry.role : null,
				} );

			}
			if ( blockedBy.length === 0 ) return false;
			entry.status = 'blocked';
			entry.reason = 'dependency-not-succeeded';
			entry.blockedBy = blockedBy;
			entry.value = false;
			entry.error = null;
			entry.promise = null;
			return true;

		}

		function run( identity, role, callback, runOptions = {} ) {

			if ( ! isIdentity( identity ) ) throw new TypeError( 'PostprocessFrameScheduler.run: identity is required.' );
			validateRole( role );
			if ( typeof callback !== 'function' ) throw new TypeError( 'PostprocessFrameScheduler.run: callback must be a function.' );

			let entry = record.entries.get( identity );
			if ( entry && entry.role !== role ) {

				record.conflicts.push( { identity, claimedRole: entry.role, requestedRole: role } );
				return false;

			}
			if ( entry && entry.status === 'succeeded' ) return entry.value;
			if ( entry && entry.status === 'pending' ) return entry.promise;
			if ( ! entry ) {

				entry = {
					role,
					status: 'unclaimed',
					attempts: 0,
					value: undefined,
					error: null,
					reason: null,
					blockedBy: [],
					promise: null,
				};
				record.entries.set( identity, entry );

			}

			const dependencies = Array.isArray( runOptions.dependsOn )
				? runOptions.dependsOn.filter( isIdentity )
				: [];
			if ( blockForDependencies( entry, dependencies ) ) return false;

			entry.status = 'pending';
			entry.attempts ++;
			entry.value = undefined;
			entry.error = null;
			entry.reason = null;
			entry.blockedBy = [];
			let result;
			try {

				result = callback( nodeFrame );

			} catch ( error ) {

				entry.status = 'failed';
				entry.error = error;
				entry.reason = 'callback-threw';
				entry.promise = null;
				throw error;

			}

			let isThenable = false;
			try {

				isThenable = !! ( result && typeof result.then === 'function' );

			} catch ( error ) {

				entry.status = 'failed';
				entry.error = error;
				entry.reason = 'callback-result-invalid';
				entry.promise = null;
				throw error;

			}
			if ( isThenable ) {

				const shared = Promise.resolve( result ).then( ( value ) => {

					entry.promise = null;
					entry.value = value;
					if ( value === false ) {

						entry.status = 'failed';
						entry.reason = 'callback-returned-false';
						return false;

					}
					entry.status = 'succeeded';
					return value;

				}, ( error ) => {

					entry.status = 'failed';
					entry.error = error;
					entry.reason = 'callback-rejected';
					entry.promise = null;
					throw error;

				} );
				entry.promise = shared;
				return shared;

			}

			entry.value = result;
			entry.promise = null;
			if ( result === false ) {

				entry.status = 'failed';
				entry.reason = 'callback-returned-false';
				return false;

			}
			entry.status = 'succeeded';
			return result;

		}

		return Object.freeze( {
			frameId: record.frameId,
			renderId: record.renderId,
			nodeFrame,
			run,
			getStatus,
			hasSucceeded,
			getConflicts: () => record.conflicts.slice(),
		} );

	}

	return Object.freeze( {
		owner,
		begin,
		clear: () => { frames.length = 0; },
	} );

}

/**
 * Return the stable scheduler owned by an application RenderPipeline (or any
 * other durable owner object). Different owners never share claims.
 *
 * @param {Object|Function} owner
 * @param {{ maxFrames?: number }} options
 * @return {{ owner:any, begin:Function, clear:Function }}
 */
export function createPostprocessFrameScheduler( owner, options = {} ) {

	if ( ! owner || ( typeof owner !== 'object' && typeof owner !== 'function' ) ) {

		throw new TypeError( 'createPostprocessFrameScheduler: owner must be an object or function.' );

	}
	let scheduler = OWNER_SCHEDULERS.get( owner );
	if ( ! scheduler ) {

		scheduler = createScheduler( owner, options || {} );
		OWNER_SCHEDULERS.set( owner, scheduler );

	}
	return scheduler;

}
