import assert from 'node:assert/strict';
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
	EvidenceSourceRecorder,
	classifyEvidenceRun,
	describeEvidenceBytes,
	evidenceAffectingEnvironmentOverrides,
	fingerprintJson,
	readEvidenceCatalogue,
	readSafeContainedFile,
	resolveRepositoryStaticImportClosure,
	sha256,
	verifyEvidenceDescriptor,
} from '../e2e-evidence.mjs';

test( 'canonical environment override policy distinguishes behavior from logging', () => {

	assert.deepEqual( evidenceAffectingEnvironmentOverrides( {} ), [] );
	assert.deepEqual(
		evidenceAffectingEnvironmentOverrides( {
			TSLP_DEBUG_REPLAY_OPS: '1',
			TSLP_DEBUG_FRAME_TEXTURES: '1',
			TSLP_E2E_MAX_RUNS_PER_BROWSER: '12',
			TSLP_E2E_VERBOSE: '1',
			TSLP_DEBUG_TORNADO_TRACE: '1',
		} ),
		[
			'TSLP_DEBUG_FRAME_TEXTURES',
			'TSLP_DEBUG_REPLAY_OPS',
			'TSLP_E2E_MAX_RUNS_PER_BROWSER',
		],
	);
	assert.deepEqual(
		evidenceAffectingEnvironmentOverrides( {
			TSLP_DEBUG_REPLAY_OPS: '0',
			TSLP_E2E_BROWSER_RESPAWN_DELAY_MS: '',
		} ),
		[],
	);

} );

test( 'repository static import closure recursively binds local behavior dependencies', ( t ) => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-static-import-closure-' ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	writeFileSync( join( root, 'entry.mjs' ), [
		"import { value } from './dependency.mjs';",
		"import 'node:fs';",
		"export { value };",
	].join( '\n' ) );
	writeFileSync( join( root, 'dependency.mjs' ), [
		"export { leaf } from './leaf.js';",
		"export const value = import('./dynamic.mjs');",
	].join( '\n' ) );
	writeFileSync( join( root, 'leaf.js' ), 'export const leaf = 1;\n' );
	writeFileSync( join( root, 'dynamic.mjs' ), 'export const dynamic = true;\n' );
	assert.deepEqual(
		resolveRepositoryStaticImportClosure( [ 'entry.mjs' ], root ),
		[
			realpathSync( join( root, 'dependency.mjs' ) ),
			realpathSync( join( root, 'dynamic.mjs' ) ),
			realpathSync( join( root, 'entry.mjs' ) ),
			realpathSync( join( root, 'leaf.js' ) ),
		],
	);

} );

test( 'evidence catalogue rejects non-canonical IDs before exposing consumer records', ( t ) => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-evidence-catalogue-id-' ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	const cataloguePath = join( root, 'example-catalogue.json' );
	for ( const id of [ '', '../../escape', '/absolute', 'C:\\escape', 'folder\\escape' ] ) {

		writeFileSync( cataloguePath, JSON.stringify( {
			schemaVersion: 1,
			cases: [ { id, source: { kind: 'three' } } ],
		} ) );
		assert.throws(
			() => readEvidenceCatalogue( cataloguePath ),
			/canonical path-segment identifier/,
			`expected ${ JSON.stringify( id ) } to be rejected`,
		);

	}

} );

test( 'evidence catalogue binds Three source metadata to its canonical route and HTTPS URL', ( t ) => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-evidence-three-source-' ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	const cataloguePath = join( root, 'example-catalogue.json' );
	const validSource = {
		kind: 'three',
		path: 'examples/webgpu_fixture.html',
		route: 'webgpu_fixture.html',
		originalUrl: 'https://threejs.org/examples/#webgpu_fixture',
	};
	for ( const source of [
		{ ...validSource, path: '../webgpu_fixture.html' },
		{ ...validSource, route: '/webgpu_fixture.html' },
		{ ...validSource, route: 'nested\\webgpu_fixture.html' },
		{ ...validSource, originalUrl: 'javascript:alert(1)' },
		{ ...validSource, originalUrl: 'http://threejs.org/examples/#webgpu_fixture' },
	] ) {

		writeFileSync( cataloguePath, JSON.stringify( {
			schemaVersion: 1,
			cases: [ { id: 'webgpu_fixture', source } ],
		} ) );
		assert.throws(
			() => readEvidenceCatalogue( cataloguePath ),
			/canonical Three\.js path, route, and HTTPS example URL/,
		);

	}

} );

test( 'evidence catalogue validates local project, repository path, and route pathname', ( t ) => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-evidence-local-source-' ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	const cataloguePath = join( root, 'example-catalogue.json' );
	const validSource = {
		kind: 'local',
		project: 'fixture-project',
		path: 'packages/examples/fixture-project/nested/case.html',
		route: 'nested/case.html?next=javascript:alert(1)#safe-fragment',
	};
	writeFileSync( cataloguePath, JSON.stringify( {
		schemaVersion: 1,
		cases: [ { id: 'local-fixture', source: validSource } ],
	} ) );
	const accepted = readEvidenceCatalogue( cataloguePath );
	assert.deepEqual( accepted.records[ 0 ].source, validSource );

	for ( const source of [
		{ ...validSource, project: '../fixture-project' },
		{ ...validSource, path: '/packages/examples/fixture-project/case.html' },
		{ ...validSource, path: 'packages/examples/fixture-project/../escape.html' },
		{ ...validSource, path: 'packages/examples/fixture-project//case.html' },
		{ ...validSource, path: 'packages\\examples\\fixture-project\\case.html' },
		{ ...validSource, path: 'packages/examples/other-project/case.html' },
		{ ...validSource, route: '/case.html' },
		{ ...validSource, route: '../case.html' },
		{ ...validSource, route: 'nested//case.html' },
		{ ...validSource, route: 'nested\\case.html' },
		{ ...validSource, route: 'javascript:case.html' },
	] ) {

		writeFileSync( cataloguePath, JSON.stringify( {
			schemaVersion: 1,
			cases: [ { id: 'local-fixture', source } ],
		} ) );
		assert.throws(
			() => readEvidenceCatalogue( cataloguePath ),
			/canonical|inside packages\/examples|relative HTML route/,
		);

	}

} );

test( 'canonical evidence accepts only the exact fresh default upstream corpus', () => {

	const base = {
		canonicalRoot: '/repo/results',
		outputRoot: '/repo/results',
		catalogueUpstreamCaseNames: [ 'a.html', 'b.html' ],
		candidates: [ 'b.html', 'a.html' ],
		defaultSlimBundle: '/repo/slim.js',
		slimBundle: '/repo/slim.js',
	};
	assert.deepEqual( classifyEvidenceRun( base ), {
		canonical: true,
		writesCanonicalRoot: true,
		exactCorpus: true,
		freshDefaultConfiguration: true,
	} );
	for ( const override of [
		{ candidates: [ 'a.html' ] },
		{ tier: 'tier1' },
		{ filter: 'a' },
		{ replayOnly: true },
		{ reuseReferenceShot: true },
		{ pixelGateEnabled: false },
		{ saveShots: false },
		{ hasExplicitPsnrThreshold: true },
		{ hasEvidenceAffectingOverrides: true },
		{ slimBundle: '/tmp/custom.js' },
		{ reportFile: 'tier.json' },
	] ) {

		assert.throws( () => classifyEvidenceRun( { ...base, ...override } ), /Use --output-root/ );

	}

} );

test( 'partial evidence is accepted under an isolated output root', () => {

	const result = classifyEvidenceRun( {
		canonicalRoot: '/repo/results',
		outputRoot: '/tmp/tier1',
		catalogueUpstreamCaseNames: [ 'a.html', 'b.html' ],
		candidates: [ 'a.html' ],
		tier: 'tier1',
		defaultSlimBundle: '/repo/slim.js',
		slimBundle: '/repo/slim.js',
		reportFile: 'tier1.json',
	} );
	assert.equal( result.canonical, false );
	assert.equal( result.writesCanonicalRoot, false );
	assert.equal( result.exactCorpus, false );

} );

test( 'an exact fresh campaign can certify evidence in an isolated output root', () => {

	const result = classifyEvidenceRun( {
		canonicalRoot: '/repo/results',
		outputRoot: '/tmp/campaign',
		catalogueUpstreamCaseNames: [ 'a.html', 'b.html' ],
		candidates: [ 'b.html', 'a.html' ],
		defaultSlimBundle: '/repo/slim.js',
		slimBundle: '/repo/slim.js',
		canonicalEvidenceRequested: true,
	} );
	assert.equal( result.canonical, true );
	assert.equal( result.writesCanonicalRoot, false );
	assert.equal( result.exactCorpus, true );
	assert.equal( result.freshDefaultConfiguration, true );
	assert.throws(
		() => classifyEvidenceRun( {
			...result,
			canonicalRoot: '/repo/results',
			outputRoot: '/tmp/campaign',
			catalogueUpstreamCaseNames: [ 'a.html', 'b.html' ],
			candidates: [ 'a.html' ],
			defaultSlimBundle: '/repo/slim.js',
			slimBundle: '/repo/slim.js',
			canonicalEvidenceRequested: true,
		} ),
		/Remove --canonical-evidence/,
	);

} );

test( 'evidence descriptors are run-bound and detect byte or path drift', ( t ) => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-evidence-' ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	const file = join( root, 'evidence', 'run-1', 'shots', 'case.capture.png' );
	mkdirSync( join( root, 'evidence', 'run-1', 'shots' ), { recursive: true } );
	const bytes = Buffer.from( 'capture' );
	writeFileSync( file, bytes );
	const descriptor = describeEvidenceBytes( { outputRoot: root, file, bytes, runId: 'run-1' } );
	assert.deepEqual( verifyEvidenceDescriptor( root, descriptor, 'run-1' ).bytes, bytes );
	assert.throws( () => verifyEvidenceDescriptor( root, descriptor, 'other-run' ), /runId/ );
	writeFileSync( file, 'tampered' );
	assert.throws( () => verifyEvidenceDescriptor( root, descriptor, 'run-1' ), /size drifted|hash drifted/ );
	assert.throws(
		() => describeEvidenceBytes( { outputRoot: root, file: join( root, '..', 'escape' ), bytes, runId: 'run-1' } ),
		/not a file below/,
	);

} );

test( 'evidence descriptors reject symlinked files before reading their bytes', ( t ) => {

	const scratch = mkdtempSync( join( tmpdir(), 'tslp-evidence-symlink-' ) );
	t.after( () => rmSync( scratch, { recursive: true, force: true } ) );
	const root = join( scratch, 'root' );
	const evidenceDirectory = join( root, 'evidence' );
	const outside = join( scratch, 'outside.capture.png' );
	const link = join( evidenceDirectory, 'linked.capture.png' );
	const bytes = Buffer.from( 'outside capture' );
	mkdirSync( evidenceDirectory, { recursive: true } );
	writeFileSync( outside, bytes );
	symlinkSync( outside, link );
	const descriptor = {
		runId: 'run-symlink',
		file: 'evidence/linked.capture.png',
		bytes: bytes.length,
		sha256: sha256( bytes ),
	};

	assert.throws(
		() => describeEvidenceBytes( { outputRoot: root, file: link, bytes, runId: descriptor.runId } ),
		/symbolic link/,
	);
	assert.throws(
		() => verifyEvidenceDescriptor( root, descriptor, descriptor.runId ),
		/symbolic link/,
	);

} );

test( 'contained reads reject a final symlink introduced after validation', ( t ) => {

	const scratch = mkdtempSync( join( tmpdir(), 'tslp-contained-read-final-race-' ) );
	t.after( () => rmSync( scratch, { recursive: true, force: true } ) );
	const root = join( scratch, 'root' );
	const file = join( root, 'evidence.bin' );
	const saved = join( root, 'saved.bin' );
	const outside = join( scratch, 'outside.bin' );
	mkdirSync( root );
	writeFileSync( file, 'safe bytes' );
	writeFileSync( outside, 'outside bytes' );

	assert.throws(
		() => readSafeContainedFile( root, file, {
			label: 'race fixture',
			hooks: {
				afterValidation() {

					renameSync( file, saved );
					symlinkSync( outside, file );

				},
			},
		} ),
		/stable filesystem identity/,
	);

} );

test( 'contained reads reject a restored final symlink without O_NOFOLLOW', ( t ) => {

	const scratch = mkdtempSync( join( tmpdir(), 'tslp-contained-read-no-follow-fallback-' ) );
	t.after( () => rmSync( scratch, { recursive: true, force: true } ) );
	const root = join( scratch, 'root' );
	const file = join( root, 'evidence.bin' );
	const saved = join( root, 'saved.bin' );
	const outside = join( scratch, 'outside.bin' );
	mkdirSync( root );
	writeFileSync( file, 'safe bytes' );
	writeFileSync( outside, 'outside bytes' );

	assert.throws(
		() => readSafeContainedFile( root, file, {
			label: 'fallback race fixture',
			noFollowFlag: 0,
			hooks: {
				afterValidation() {

					renameSync( file, saved );
					symlinkSync( outside, file );

				},
				afterRead() {

					unlinkSync( file );
					renameSync( saved, file );

				},
			},
		} ),
		/changed filesystem identity/,
	);

} );

test( 'contained reads reject an ancestor symlink even when the safe path is restored', ( t ) => {

	const scratch = mkdtempSync( join( tmpdir(), 'tslp-contained-read-ancestor-race-' ) );
	t.after( () => rmSync( scratch, { recursive: true, force: true } ) );
	const root = join( scratch, 'root' );
	const directory = join( root, 'evidence' );
	const savedDirectory = join( root, 'saved-evidence' );
	const file = join( directory, 'case.bin' );
	const outsideDirectory = join( scratch, 'outside' );
	mkdirSync( directory, { recursive: true } );
	mkdirSync( outsideDirectory );
	writeFileSync( file, 'safe bytes' );
	writeFileSync( join( outsideDirectory, 'case.bin' ), 'outside bytes' );

	assert.throws(
		() => readSafeContainedFile( root, file, {
			label: 'ancestor race fixture',
			hooks: {
				afterValidation() {

					renameSync( directory, savedDirectory );
					symlinkSync( outsideDirectory, directory, 'dir' );

				},
				afterRead() {

					unlinkSync( directory );
					renameSync( savedDirectory, directory );

				},
			},
		} ),
		/changed filesystem identity/,
	);

} );

test( 'contained reads resolve a relative root once even if cwd changes', ( t ) => {

	const scratch = mkdtempSync( join( tmpdir(), 'tslp-contained-read-relative-root-' ) );
	t.after( () => rmSync( scratch, { recursive: true, force: true } ) );
	const previousCwd = process.cwd();
	const root = join( scratch, 'root' );
	mkdirSync( root );
	writeFileSync( join( root, 'evidence.bin' ), 'stable bytes' );
	process.chdir( scratch );
	try {

		const bytes = readSafeContainedFile( 'root', 'root/evidence.bin', {
			label: 'relative root fixture',
			hooks: {
				afterValidation() {

					process.chdir( previousCwd );

				},
			},
		} );
		assert.equal( bytes.toString( 'utf8' ), 'stable bytes' );

	} finally {

		process.chdir( previousCwd );

	}

} );

test( 'source recorder fingerprints the exact bytes and rejects mid-run mutation', ( t ) => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-source-evidence-' ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	const repo = join( root, 'repo' );
	const three = join( root, 'three' );
	mkdirSync( repo );
	mkdirSync( three );
	const harness = join( repo, 'run.mjs' );
	const source = join( three, 'build.js' );
	writeFileSync( harness, 'harness' );
	writeFileSync( source, 'source' );
	const recorder = new EvidenceSourceRecorder( { repoRoot: repo, threeRoot: three } );
	assert.deepEqual( recorder.classify( harness ), { domain: 'repository', path: 'run.mjs' } );
	recorder.record( harness );
	recorder.record( source );
	const snapshot = recorder.snapshot();
	assert.equal( snapshot.fileCount, 2 );
	assert.equal( snapshot.sha256, fingerprintJson( snapshot.files ) );
	assert.deepEqual( recorder.record( source ), readFileSync( source ) );
	writeFileSync( source, 'changed' );
	assert.throws( () => recorder.record( source, Buffer.from( 'source' ) ), /changed before it was recorded/ );
	assert.throws( () => recorder.record( source ), /changed during the run/ );

} );

test( 'source recorder rejects a source reached through a symlink', ( t ) => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-source-symlink-' ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	const repo = join( root, 'repo' );
	const three = join( root, 'three' );
	const outside = join( root, 'outside.mjs' );
	const linkedSource = join( repo, 'linked.mjs' );
	mkdirSync( repo );
	mkdirSync( three );
	writeFileSync( outside, 'external source' );
	symlinkSync( outside, linkedSource );

	const recorder = new EvidenceSourceRecorder( { repoRoot: repo, threeRoot: three } );
	assert.throws( () => recorder.record( linkedSource ), /symbolic link/ );
	assert.equal( recorder.snapshot().fileCount, 0 );

} );
