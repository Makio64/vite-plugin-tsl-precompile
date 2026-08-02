import assert from 'node:assert/strict';
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import test from 'node:test';

import {
	assertCanonicalExampleId,
	assertCanonicalExampleName,
	assertSafeJsonOutputName,
	commitTemporaryOutputFile,
	prepareOutputRoot,
	removeOutputPath,
	temporaryOutputFile,
	writeOutputFileAtomic,
} from '../output-path-safety.mjs';

test( 'selected output roots cannot overwrite repository or filesystem roots', ( t ) => {

	const scratch = mkdtempSync( join( tmpdir(), 'tslp-output-root-' ) );
	t.after( () => rmSync( scratch, { recursive: true, force: true } ) );
	const repository = join( scratch, 'repository' );
	const generated = join( repository, 'generated' );
	mkdirSync( generated, { recursive: true } );
	const packageJson = join( repository, 'package.json' );
	writeFileSync( packageJson, 'preserve-package-json' );

	assert.throws(
		() => prepareOutputRoot( repository, {
			repositoryRoot: repository,
			allowedRepositoryRoots: [ generated ],
		} ),
		/declared generated directory/,
	);
	assert.equal( readFileSync( packageJson, 'utf8' ), 'preserve-package-json' );
	assert.throws(
		() => prepareOutputRoot( join( repository, 'scratch' ), {
			repositoryRoot: repository,
			allowedRepositoryRoots: [ generated ],
		} ),
		/declared generated directory/,
	);
	assert.equal( existsSync( join( repository, 'scratch' ) ), false );
	assert.throws( () => prepareOutputRoot( '', { repositoryRoot: repository } ), /non-empty/ );
	assert.throws( () => prepareOutputRoot( parse( scratch ).root, { repositoryRoot: repository } ), /filesystem root/ );
	assert.throws( () => prepareOutputRoot( tmpdir(), { repositoryRoot: repository } ), /temporary root/ );
	assert.throws( () => prepareOutputRoot( scratch, { repositoryRoot: repository } ), /broad ancestor/ );

	const accepted = prepareOutputRoot( join( generated, 'cohort' ), {
		repositoryRoot: repository,
		allowedRepositoryRoots: [ generated ],
	} );
	assert.equal( existsSync( accepted ), true );

} );

test( 'the conventional shared temp root is rejected while a unique descendant is allowed', ( t ) => {

	let conventionalTemporaryRoot;
	try {

		conventionalTemporaryRoot = realpathSync( '/tmp' );

	} catch ( error ) {

		if ( error?.code === 'ENOENT' ) return t.skip( 'This platform has no conventional /tmp root.' );
		throw error;

	}
	if ( conventionalTemporaryRoot === realpathSync( tmpdir() ) ) {

		return t.skip( 'The conventional shared temp root is already tmpdir().' );

	}
	const scratch = mkdtempSync( join( tmpdir(), 'tslp-shared-temp-contract-' ) );
	const repository = join( scratch, 'repository' );
	const uniqueOutput = mkdtempSync( join( conventionalTemporaryRoot, 'tslp-output-child-' ) );
	t.after( () => rmSync( scratch, { recursive: true, force: true } ) );
	t.after( () => rmSync( uniqueOutput, { recursive: true, force: true } ) );
	mkdirSync( repository );

	assert.throws(
		() => prepareOutputRoot( conventionalTemporaryRoot, { repositoryRoot: repository } ),
		/conventional shared temporary root/,
	);
	assert.equal(
		prepareOutputRoot( uniqueOutput, { repositoryRoot: repository } ),
		realpathSync( uniqueOutput ),
	);

} );

test( 'output writes and removals preserve victims behind symlinks', ( t ) => {

	const scratch = mkdtempSync( join( tmpdir(), 'tslp-output-symlink-' ) );
	t.after( () => rmSync( scratch, { recursive: true, force: true } ) );
	const repository = join( scratch, 'repository' );
	const selectedRoot = join( scratch, 'output' );
	const outside = join( scratch, 'outside' );
	mkdirSync( repository );
	mkdirSync( outside );
	const root = prepareOutputRoot( selectedRoot, { repositoryRoot: repository } );
	const victim = join( outside, 'victim.json' );
	writeFileSync( victim, 'preserve-victim' );
	symlinkSync( outside, join( root, 'linked' ), 'dir' );

	assert.throws(
		() => writeOutputFileAtomic( root, join( root, 'linked', 'victim.json' ), 'replacement' ),
		/symbolic link/,
	);
	assert.throws(
		() => removeOutputPath( root, join( root, 'linked', 'victim.json' ) ),
		/symbolic link/,
	);
	assert.equal( readFileSync( victim, 'utf8' ), 'preserve-victim' );

	const finalLink = join( root, 'report.json' );
	symlinkSync( victim, finalLink );
	assert.throws(
		() => writeOutputFileAtomic( root, finalLink, 'replacement' ),
		/symbolic link/,
	);
	assert.equal( readFileSync( victim, 'utf8' ), 'preserve-victim' );

} );

test( 'future roots cannot enter the repository through a symlinked parent', ( t ) => {

	const scratch = mkdtempSync( join( tmpdir(), 'tslp-output-future-' ) );
	t.after( () => rmSync( scratch, { recursive: true, force: true } ) );
	const repository = join( scratch, 'repository' );
	const generated = join( repository, 'generated' );
	const outside = join( scratch, 'outside' );
	mkdirSync( generated, { recursive: true } );
	mkdirSync( outside );
	symlinkSync( repository, join( outside, 'repository' ), 'dir' );
	const escaped = join( outside, 'repository', 'scratch-output' );

	assert.throws(
		() => prepareOutputRoot( escaped, {
			repositoryRoot: repository,
			allowedRepositoryRoots: [ generated ],
		} ),
		/declared generated directory/,
	);
	assert.equal( existsSync( join( repository, 'scratch-output' ) ), false );

} );

test( 'temporary-file commits reject a replaced inode', ( t ) => {

	const scratch = mkdtempSync( join( tmpdir(), 'tslp-output-temp-identity-' ) );
	t.after( () => rmSync( scratch, { recursive: true, force: true } ) );
	const repository = join( scratch, 'repository' );
	const root = join( scratch, 'output' );
	mkdirSync( repository );
	const outputRoot = prepareOutputRoot( root, { repositoryRoot: repository } );
	const prepared = temporaryOutputFile( outputRoot, join( outputRoot, 'report.json' ) );
	writeFileSync( prepared.temporary, 'original-temp' );
	const originalStat = lstatSync( prepared.temporary );
	const originalIdentity = { dev: originalStat.dev, ino: originalStat.ino };
	const replacement = join( outputRoot, 'replacement-temp' );
	writeFileSync( replacement, 'replacement-temp' );
	unlinkSync( prepared.temporary );
	renameSync( replacement, prepared.temporary );

	assert.throws(
		() => commitTemporaryOutputFile(
			outputRoot,
			prepared.temporary,
			prepared.absolute,
			{
				expectedParentIdentity: prepared.parentIdentity,
				expectedTemporaryIdentity: originalIdentity,
			},
		),
		/changed filesystem identity/,
	);
	assert.equal( existsSync( prepared.absolute ), false );

} );

test( 'report names and example names reject control-file and traversal basenames', () => {

	assert.equal( assertSafeJsonOutputName( 'tier1-report.json' ), 'tier1-report.json' );
	assert.throws( () => assertSafeJsonOutputName( 'package.json' ), /reserved/ );
	assert.throws( () => assertSafeJsonOutputName( 'NUL.json' ), /reserved device/ );
	assert.throws( () => assertSafeJsonOutputName( 'report..json' ), /basename/ );
	assert.throws( () => assertSafeJsonOutputName( `${ 'x'.repeat( 124 ) }.json` ), /basename/ );
	assert.throws( () => assertSafeJsonOutputName( '../report.json' ), /basename/ );
	assert.equal( assertCanonicalExampleName( 'directional-pcf.html' ), 'directional-pcf.html' );
	assert.throws( () => assertCanonicalExampleName( 'con.html' ), /canonical HTML basename/ );
	assert.throws( () => assertCanonicalExampleName( '../../../../outside.html' ), /canonical HTML basename/ );
	assert.equal( assertCanonicalExampleId( 'directional-pcf' ), 'directional-pcf' );
	assert.throws( () => assertCanonicalExampleId( 'LPT1' ), /canonical path-segment/ );
	assert.throws( () => assertCanonicalExampleId( '../../../../outside' ), /canonical path-segment/ );

} );
