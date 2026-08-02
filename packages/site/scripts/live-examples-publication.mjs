import { randomUUID } from 'node:crypto';
import { existsSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';

import {
	assertOutputDirectoryTarget,
	assertOutputFileTarget,
	ensureOutputDirectory,
	removeOutputPath,
} from '../../examples/batch/output-path-safety.mjs';

function assertVacantTarget( publicRoot, path, kind, label ) {

	if ( kind === 'directory' ) assertOutputDirectoryTarget( publicRoot, path, { label } );
	else assertOutputFileTarget( publicRoot, path, { label } );
	if ( existsSync( path ) ) throw new Error( `${ label } already exists: ${ path }.` );

}

function assertPresentTarget( publicRoot, path, kind, label ) {

	if ( kind === 'directory' ) assertOutputDirectoryTarget( publicRoot, path, { label } );
	else assertOutputFileTarget( publicRoot, path, { label } );
	if ( ! existsSync( path ) ) throw new Error( `${ label } is missing: ${ path }.` );

}

function renameCheckedTarget(
	transaction,
	source,
	destination,
	kind,
	sourceLabel,
	destinationLabel,
	rename,
	onRenamed = () => {},
) {

	assertPresentTarget( transaction.publicRoot, source, kind, sourceLabel );
	assertVacantTarget( transaction.publicRoot, destination, kind, destinationLabel );
	rename( source, destination );
	onRenamed();
	assertPresentTarget( transaction.publicRoot, destination, kind, destinationLabel );

}

function createTransaction( publicRoot ) {

	const token = `${ process.pid }-${ randomUUID() }`;
	const transaction = Object.freeze( {
		publicRoot,
		publishedLiveRoot: resolve( publicRoot, 'live' ),
		publishedManifestPath: resolve( publicRoot, 'live-examples.json' ),
		stagedLiveRoot: resolve( publicRoot, `.live-stage-${ token }` ),
		stagedManifestPath: resolve( publicRoot, `.live-examples-stage-${ token }.json` ),
		backupLiveRoot: resolve( publicRoot, `.live-backup-${ token }` ),
		backupManifestPath: resolve( publicRoot, `.live-examples-backup-${ token }.json` ),
	} );
	assertOutputDirectoryTarget( publicRoot, transaction.publishedLiveRoot, {
		label: 'Published live examples directory',
	} );
	assertOutputFileTarget( publicRoot, transaction.publishedManifestPath, {
		label: 'Published live examples manifest',
	} );
	assertVacantTarget( publicRoot, transaction.stagedLiveRoot, 'directory', 'Staged live examples directory' );
	assertVacantTarget( publicRoot, transaction.stagedManifestPath, 'file', 'Staged live examples manifest' );
	assertVacantTarget( publicRoot, transaction.backupLiveRoot, 'directory', 'Live examples backup directory' );
	assertVacantTarget( publicRoot, transaction.backupManifestPath, 'file', 'Live examples backup manifest' );
	ensureOutputDirectory( publicRoot, transaction.stagedLiveRoot, {
		label: 'Staged live examples directory',
	} );
	return transaction;

}

function rollbackCommit( transaction, state, rename ) {

	const errors = [];
	const attempt = ( operation ) => {

		try {

			operation();

		} catch ( error ) {

			errors.push( error );

		}

	};
	if ( state.manifestPublished ) attempt( () => renameCheckedTarget(
		transaction,
		transaction.publishedManifestPath,
		transaction.stagedManifestPath,
		'file',
		'Failed publication manifest',
		'Restored staged manifest',
		rename,
	) );
	if ( state.livePublished ) attempt( () => renameCheckedTarget(
		transaction,
		transaction.publishedLiveRoot,
		transaction.stagedLiveRoot,
		'directory',
		'Failed publication live directory',
		'Restored staged live directory',
		rename,
	) );
	if ( state.manifestBackedUp ) attempt( () => renameCheckedTarget(
		transaction,
		transaction.backupManifestPath,
		transaction.publishedManifestPath,
		'file',
		'Previous live examples manifest backup',
		'Restored live examples manifest',
		rename,
	) );
	if ( state.liveBackedUp ) attempt( () => renameCheckedTarget(
		transaction,
		transaction.backupLiveRoot,
		transaction.publishedLiveRoot,
		'directory',
		'Previous live examples directory backup',
		'Restored live examples directory',
		rename,
	) );
	return errors;

}

function commitTransaction( transaction, { rename = renameSync } = {} ) {

	assertPresentTarget(
		transaction.publicRoot,
		transaction.stagedLiveRoot,
		'directory',
		'Staged live examples directory',
	);
	assertPresentTarget(
		transaction.publicRoot,
		transaction.stagedManifestPath,
		'file',
		'Staged live examples manifest',
	);
	const state = {
		liveBackedUp: false,
		manifestBackedUp: false,
		livePublished: false,
		manifestPublished: false,
	};
	try {

		if ( existsSync( transaction.publishedLiveRoot ) ) {

			renameCheckedTarget(
				transaction,
				transaction.publishedLiveRoot,
				transaction.backupLiveRoot,
				'directory',
				'Published live examples directory',
				'Live examples backup directory',
				rename,
				() => { state.liveBackedUp = true; },
			);

		}
		if ( existsSync( transaction.publishedManifestPath ) ) {

			renameCheckedTarget(
				transaction,
				transaction.publishedManifestPath,
				transaction.backupManifestPath,
				'file',
				'Published live examples manifest',
				'Live examples backup manifest',
				rename,
				() => { state.manifestBackedUp = true; },
			);

		}
		renameCheckedTarget(
			transaction,
			transaction.stagedLiveRoot,
			transaction.publishedLiveRoot,
			'directory',
			'Staged live examples directory',
			'Published live examples directory',
			rename,
			() => { state.livePublished = true; },
		);
		renameCheckedTarget(
			transaction,
			transaction.stagedManifestPath,
			transaction.publishedManifestPath,
			'file',
			'Staged live examples manifest',
			'Published live examples manifest',
			rename,
			() => { state.manifestPublished = true; },
		);

	} catch ( cause ) {

		const rollbackErrors = rollbackCommit( transaction, state, rename );
		if ( rollbackErrors.length > 0 ) throw new AggregateError(
			rollbackErrors,
			'Live example publication failed and its previous output could not be fully restored.',
			{ cause },
		);
		throw cause;

	}
	removeOutputPath( transaction.publicRoot, transaction.backupLiveRoot, {
		recursive: true,
		label: 'Live examples backup directory',
	} );
	removeOutputPath( transaction.publicRoot, transaction.backupManifestPath, {
		label: 'Live examples backup manifest',
	} );

}

function discardStagedTransaction( transaction ) {

	removeOutputPath( transaction.publicRoot, transaction.stagedLiveRoot, {
		recursive: true,
		label: 'Staged live examples directory',
	} );
	removeOutputPath( transaction.publicRoot, transaction.stagedManifestPath, {
		label: 'Staged live examples manifest',
	} );

}

export async function publishLiveExamplesAtomically( publicRoot, buildStagedPublication, options = {} ) {

	if ( typeof buildStagedPublication !== 'function' ) throw new TypeError(
		'Live example publication requires a staging build callback.',
	);
	const transaction = createTransaction( publicRoot );
	try {

		const result = await buildStagedPublication( {
			liveRoot: transaction.stagedLiveRoot,
			manifestPath: transaction.stagedManifestPath,
		} );
		commitTransaction( transaction, options );
		return result;

	} finally {

		discardStagedTransaction( transaction );

	}

}
