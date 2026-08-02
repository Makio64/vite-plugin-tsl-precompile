import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { ARTIFACT_CONTENT_HASH_VERSION } from '@tsl-precompile/contract/artifact-content';
import { computeArtifactContentHash } from '../../src/hash.js';
import { autoMarkSource, injectMarkerBootstrapSource } from '../../src/auto-mark.js';
import {
	instrumentLiveContextDependencies,
	instrumentLiveUniformIdentities,
} from '../../src/babel-transform.js';
import { canonicalModuleIdentity, markerSourceRevision } from '../../src/_shared/module-identity.js';
import {
	MARKER_SOURCE_PROVENANCE_SCHEMA,
	dependencyContentRevision,
} from '../../src/_shared/source-provenance.js';

const VERIFY_CLI = resolve( import.meta.dirname, '../../src/cli/verify.js' );

function runVerify( cwd, ...args ) {

	return spawnSync( process.execPath, [ VERIFY_CLI, ...args ], {
		cwd,
		encoding: 'utf8',
	} );

}

function writeSignedMaterial( artifactsDir, name, sourceOwners = [] ) {

	const artifact = {
		uniformPlan: [],
		vertexShader: '',
		fragmentShader: '',
		sourceGraphHash: 'a'.repeat( 64 ),
		sourceThreeVersion: '0.185.1',
		sourceHashVersion: '0.1.0',
		artifactContentHashVersion: ARTIFACT_CONTENT_HASH_VERSION,
	};
	const hash = computeArtifactContentHash( artifact, {
		shape: `material:${ name }`,
		threeVersion: artifact.sourceThreeVersion,
		pluginVersion: artifact.sourceHashVersion,
	} );
	const file = `${ name }.json`;
	writeFileSync( join( artifactsDir, file ), JSON.stringify( {
		__name: name,
		__hash: hash,
		...( sourceOwners.length > 0 ? { __sourceOwners: sourceOwners } : {} ),
		artifact,
	} ) );
	return { file, hash, sourceOwners };

}

function transformedMarkerSource( sourceFile, source, root, { autoMark = true } = {} ) {

	let code = source;
	if ( autoMark ) {

		const marked = autoMarkSource( code, { filename: sourceFile, root } );
		if ( marked.injectedNames.length > 0 ) code = marked.code;

	}
	const markerBootstrap = injectMarkerBootstrapSource( code, { filename: sourceFile } );
	if ( markerBootstrap.touched ) code = markerBootstrap.code;
	const liveUniforms = instrumentLiveUniformIdentities( code, { filename: sourceFile, root } );
	if ( liveUniforms.touched ) code = liveUniforms.code;
	const contexts = instrumentLiveContextDependencies( code, { filename: sourceFile } );
	if ( contexts.touched ) code = contexts.code;
	return code;

}

function markerOwner( sourceFile, source, root, callIndex = 0, options = {} ) {

	const transformed = transformedMarkerSource( sourceFile, source, root, options );
	const { moduleIdentity } = canonicalModuleIdentity( sourceFile, root );
	return {
		identity: `${ moduleIdentity }:precompile:${ callIndex }`,
		revision: markerSourceRevision( transformed ),
	};

}

test( 'verify rejects an explicitly requested missing artifact directory', () => {

	const cwd = mkdtempSync( join( tmpdir(), 'tslp-verify-missing-' ) );
	try {

		const result = runVerify( cwd, 'missing-artifacts' );
		assert.equal( result.status, 1 );
		assert.match( result.stderr, /missing-artifacts: artifact directory does not exist/ );
		assert.doesNotMatch( result.stdout, /verify ok/ );

	} finally {

		rmSync( cwd, { recursive: true, force: true } );

	}

} );

test( 'verify rejects an invocation that checks zero artifact JSON files', () => {

	const cwd = mkdtempSync( join( tmpdir(), 'tslp-verify-empty-' ) );
	try {

		mkdirSync( resolve( cwd, 'artifacts' ) );
		const result = runVerify( cwd );
		assert.equal( result.status, 1 );
		assert.doesNotMatch( result.stderr, /artifact directory does not exist/ );
		assert.match( result.stderr, /no artifact JSON files were checked in: artifacts/ );
		assert.doesNotMatch( result.stdout, /verify ok/ );

	} finally {

		rmSync( cwd, { recursive: true, force: true } );

	}

} );

test( 'verify requires exact current provenance on auxiliary envelopes and manifests', () => {

	const cwd = mkdtempSync( join( tmpdir(), 'tslp-verify-aux-provenance-' ) );
	const artifactsDir = resolve( cwd, 'artifacts' );
	mkdirSync( artifactsDir );
	const writeSignedAux = ( threeVersion, hashOverride = null ) => {

		const artifact = {
			materialShape: 'background',
			uniformPlan: [],
			vertexShader: '',
			fragmentShader: '',
			// Auxiliary captures may retain Three-private graph labels. They are
			// content, not user-material source-freshness hashes.
			sourceGraphHash: 'Background.material',
			sourceThreeVersion: threeVersion,
			sourceHashVersion: '0.1.0',
			artifactContentHashVersion: ARTIFACT_CONTENT_HASH_VERSION,
		};
		const contentHash = computeArtifactContentHash( artifact, {
			shape: 'background',
			threeVersion,
			pluginVersion: '0.1.0',
		} );
		const envelope = {
			__name: 'aux-background',
			__materialShape: 'background',
			__configHash: 'a'.repeat( 64 ),
			__hash: hashOverride || contentHash,
			threeVersion,
			pluginVersion: '0.1.0',
			artifact,
		};
		writeFileSync( join( artifactsDir, 'aux-background.json' ), JSON.stringify( envelope ) );
		writeFileSync( join( artifactsDir, 'manifest.json' ), JSON.stringify( {
			__aux: {
				[ `background:${ envelope.__configHash }` ]: {
					file: 'aux-background.json',
					shape: 'background',
					configHash: envelope.__configHash,
					hash: envelope.__hash,
					threeVersion: envelope.threeVersion,
					pluginVersion: envelope.pluginVersion,
				},
			},
		} ) );

	};
	writeSignedAux( '0.184.0' );

	try {

		const stale = runVerify( cwd );
		assert.equal( stale.status, 1 );
		assert.match( stale.stderr, /threeVersion must be exact current baseline 0\.185\.1/ );

		writeSignedAux( '0.185.1' );
		const current = runVerify( cwd );
		assert.equal( current.status, 0, current.stderr );
		assert.match( current.stdout, /verify ok \(1 artifact file checked/ );
		assert.match( current.stdout, /Marker coverage was not checked/ );

		writeSignedAux( '0.185.1', 'b'.repeat( 64 ) );
		const tampered = runVerify( cwd );
		assert.equal( tampered.status, 1 );
		assert.match( tampered.stderr, /stored __hash does not match artifact runtime content/ );

	} finally {

		rmSync( cwd, { recursive: true, force: true } );

	}

} );

test( 'verify rejects each empty requested directory even when another directory is populated', () => {

	const cwd = mkdtempSync( join( tmpdir(), 'tslp-verify-per-directory-' ) );
	try {

		mkdirSync( resolve( cwd, 'empty' ) );
		mkdirSync( resolve( cwd, 'populated' ) );
		writeFileSync( resolve( cwd, 'populated/material.json' ), JSON.stringify( {
			__name: 'material',
			__hash: 'legacy-hash',
			artifact: { uniformPlan: [], vertexShader: '', fragmentShader: '' },
		} ) );

		const result = runVerify( cwd, 'empty', 'populated' );
		assert.equal( result.status, 1 );
		assert.match( result.stderr, /no artifact JSON files were checked in: empty/ );
		assert.doesNotMatch( result.stderr, /no artifact JSON files were checked in: populated/ );

	} finally {

		rmSync( cwd, { recursive: true, force: true } );

	}

} );

test( 'verify applies authoritative manifest filename, name, and hash validation', () => {

	const cwd = mkdtempSync( join( tmpdir(), 'tslp-verify-manifest-authority-' ) );
	const artifactsDir = resolve( cwd, 'artifacts' );
	mkdirSync( artifactsDir );
	writeFileSync( resolve( artifactsDir, 'capture.json' ), JSON.stringify( {
		__name: 'actual',
		__hash: 'actual-hash',
		artifact: { uniformPlan: [], vertexShader: '', fragmentShader: '' },
	} ) );

	try {

		writeFileSync( resolve( artifactsDir, 'manifest.json' ), JSON.stringify( {
			actual: { file: '../capture.json', hash: 'actual-hash' },
		} ) );
		let result = runVerify( cwd );
		assert.equal( result.status, 1 );
		assert.match( result.stderr, /unsafe artifact filename/ );

		writeFileSync( resolve( artifactsDir, 'manifest.json' ), JSON.stringify( {
			expected: { file: 'capture.json', hash: 'actual-hash' },
		} ) );
		result = runVerify( cwd );
		assert.equal( result.status, 1 );
		assert.match( result.stderr, /whose __name is "actual"/ );

		writeFileSync( resolve( artifactsDir, 'manifest.json' ), JSON.stringify( {
			actual: { file: 'capture.json', hash: 'wrong-hash' },
		} ) );
		result = runVerify( cwd );
		assert.equal( result.status, 1 );
		assert.match( result.stderr, /does not match envelope __hash/ );

		writeFileSync( resolve( artifactsDir, 'manifest.json' ), '[]' );
		result = runVerify( cwd );
		assert.equal( result.status, 1 );
		assert.match( result.stderr, /manifest root must be an object/ );

	} finally {

		rmSync( cwd, { recursive: true, force: true } );

	}

} );

test( 'verify rejects stale duplicate identities after manifest replacement settles', () => {

	const cwd = mkdtempSync( join( tmpdir(), 'tslp-verify-duplicate-' ) );
	const artifactsDir = resolve( cwd, 'artifacts' );
	mkdirSync( artifactsDir );
	for ( const [ file, hash ] of [ [ 'current.json', 'current' ], [ 'stale.json', 'stale' ] ] ) {

		writeFileSync( resolve( artifactsDir, file ), JSON.stringify( {
			__name: 'same',
			__hash: hash,
			artifact: { uniformPlan: [], vertexShader: '', fragmentShader: '' },
		} ) );

	}
	writeFileSync( resolve( artifactsDir, 'manifest.json' ), JSON.stringify( {
		same: { file: 'current.json', hash: 'current' },
	} ) );

	try {

		const result = runVerify( cwd );
		assert.equal( result.status, 1 );
		assert.match( result.stderr, /duplicate artifact identity "same"/ );

	} finally {

		rmSync( cwd, { recursive: true, force: true } );

	}

} );

test( 'verify rejects a unique artifact omitted from an authoritative manifest', () => {

	const cwd = mkdtempSync( join( tmpdir(), 'tslp-verify-orphan-' ) );
	const artifactsDir = resolve( cwd, 'artifacts' );
	mkdirSync( artifactsDir );
	try {

		writeFileSync( join( artifactsDir, 'kept.json' ), JSON.stringify( {
			__name: 'kept',
			__hash: 'kept-hash',
			artifact: { uniformPlan: [], vertexShader: '', fragmentShader: '' },
		} ) );
		writeFileSync( join( artifactsDir, 'orphan.json' ), JSON.stringify( {
			__name: 'orphan',
			__hash: 'orphan-hash',
			artifact: { uniformPlan: [], vertexShader: '', fragmentShader: '' },
		} ) );
		writeFileSync( join( artifactsDir, 'manifest.json' ), JSON.stringify( {
			kept: { file: 'kept.json', hash: 'kept-hash' },
		} ) );

		const result = runVerify( cwd );
		assert.equal( result.status, 1 );
		assert.match( result.stderr, /unreferenced artifact file "orphan\.json"/ );

	} finally {

		rmSync( cwd, { recursive: true, force: true } );

	}

} );

test( 'verify recomputes signed auxiliary content with the auxiliary shape', () => {

	const cwd = mkdtempSync( join( tmpdir(), 'tslp-verify-aux-integrity-' ) );
	const artifactsDir = resolve( cwd, 'artifacts' );
	mkdirSync( artifactsDir );
	const configHash = 'd'.repeat( 64 );
	const artifact = {
		materialShape: 'background',
		uniformPlan: [],
		vertexShader: 'vertex',
		fragmentShader: 'original',
		sourceThreeVersion: '0.185.1',
		sourceHashVersion: '0.1.0',
		artifactContentHashVersion: ARTIFACT_CONTENT_HASH_VERSION,
	};
	const storedHash = computeArtifactContentHash( artifact, {
		shape: 'background',
		threeVersion: artifact.sourceThreeVersion,
		pluginVersion: artifact.sourceHashVersion,
	} );
	artifact.fragmentShader = 'tampered';
	writeFileSync( resolve( artifactsDir, 'aux-background.json' ), JSON.stringify( {
		__name: 'aux-background',
		__materialShape: 'background',
		__configHash: configHash,
		__hash: storedHash,
		threeVersion: '0.185.1',
		pluginVersion: '0.1.0',
		artifact,
	} ) );
	writeFileSync( resolve( artifactsDir, 'manifest.json' ), JSON.stringify( {
		__aux: {
			[ `background:${ configHash }` ]: {
				file: 'aux-background.json',
				shape: 'background',
				configHash,
				hash: storedHash,
				threeVersion: '0.185.1',
				pluginVersion: '0.1.0',
			},
		},
	} ) );

	try {

		const result = runVerify( cwd );
		assert.equal( result.status, 1 );
		assert.match( result.stderr, /stored __hash does not match artifact runtime content/ );

	} finally {

		rmSync( cwd, { recursive: true, force: true } );

	}

} );

test( 'verify --json emits a stable machine-readable failure and nonzero status', () => {

	const cwd = mkdtempSync( join( tmpdir(), 'tslp-verify-json-' ) );
	try {

		const result = runVerify( cwd, '--json', 'missing-artifacts' );
		assert.equal( result.status, 1 );
		assert.equal( result.stderr, '' );
		const report = JSON.parse( result.stdout );
		assert.equal( report.schemaVersion, 1 );
		assert.equal( report.ok, false );
		assert.equal( report.status, 'failed' );
		assert.equal( report.command, 'tsl-precompile-verify' );
		assert.equal( report.checkedArtifactFiles, 0 );
		assert.deepEqual( report.directories, [ {
			input: 'missing-artifacts',
			checkedArtifactFiles: 0,
			manifestEntries: 0,
		} ] );
		assert.deepEqual( report.markerCoverage, {
			enabled: false,
			sourceRoot: null,
			checkedSourceFiles: 0,
			total: 0,
			covered: 0,
			missing: [],
			markers: [],
			issues: [],
		} );
		assert.match( report.issues[ 0 ], /artifact directory does not exist/ );
		assert.deepEqual( report.diagnostics, [ {
			code: 'ARTIFACT_DIRECTORY_MISSING',
			severity: 'error',
			message: report.issues[ 0 ],
		} ] );
		assert.equal( report.nextActions[ 0 ].kind, 'command' );
		assert.equal( report.nextActions[ 0 ].code, 'run-doctor' );
		assert.equal( report.nextActions[ 0 ].cwd, realpathSync( cwd ) );
		assert.deepEqual(
			report.nextActions[ 0 ].argv,
			[
				process.execPath,
				resolve( VERIFY_CLI, '../doctor.js' ),
				'--json',
				'--compact',
				'--artifacts',
				'missing-artifacts',
			],
		);
		assert.deepEqual( report.nextActions[ 0 ].commands, [ report.nextActions[ 0 ].argv ] );

	} finally {

		rmSync( cwd, { recursive: true, force: true } );

	}

} );

test( 'verify source-aware doctor action is directly executable with the exact source root', () => {

	const cwd = mkdtempSync( join( tmpdir(), 'tslp-verify-doctor-source-root-' ) );
	try {

		mkdirSync( join( cwd, 'client' ), { recursive: true } );
		writeFileSync( join( cwd, 'client/main.js' ), 'export const fixture = true;\n' );
		const result = runVerify(
			cwd,
			'--json',
			'--source',
			'client',
			'--source-root',
			'.',
			'missing-artifacts',
		);
		assert.equal( result.status, 1 );
		const report = JSON.parse( result.stdout );
		const action = report.nextActions[ 0 ];
		assert.equal( action.kind, 'command' );
		assert.equal( action.code, 'run-doctor' );
		assert.equal( action.cwd, realpathSync( cwd ) );
		assert.equal(
			action.argv.join( '\0' ).includes( `--source-root\0${ realpathSync( cwd ) }` ),
			true,
		);

		const [ command, ...args ] = action.argv;
		const followup = spawnSync( command, args, {
			cwd: action.cwd,
			encoding: 'utf8',
		} );
		assert.equal( followup.stderr, '' );
		const doctor = JSON.parse( followup.stdout );
		assert.equal( doctor.command, 'tsl-precompile-doctor' );
		assert.notEqual( doctor.readiness, 'invalid-invocation' );
		assert.equal( doctor.project.root, realpathSync( cwd ) );
		assert.equal( doctor.project.sourceRoot, realpathSync( cwd ) );
		assert.deepEqual( doctor.project.sourcePaths, [ 'client' ] );

	} finally {

		rmSync( cwd, { recursive: true, force: true } );

	}

} );

test( 'verify JSON never invents the default doctor artifact directory after checking multiple directories', () => {

	const cwd = mkdtempSync( join( tmpdir(), 'tslp-verify-json-multiple-' ) );
	try {

		const result = runVerify(
			cwd,
			'--json',
			'--source',
			'client',
			'first-artifacts',
			'second-artifacts',
		);
		assert.equal( result.status, 1 );
		assert.equal( result.stderr, '' );
		const report = JSON.parse( result.stdout );
		assert.deepEqual(
			report.directories.map( ( directory ) => directory.input ),
			[ 'first-artifacts', 'second-artifacts' ],
		);
		assert.equal( report.nextActions.length, 1 );
		const action = report.nextActions[ 0 ];
		assert.equal( action.kind, 'manual' );
		assert.equal( action.code, 'select-doctor-artifact-directory' );
		assert.equal( action.cwd, realpathSync( cwd ) );
		assert.equal( action.argv, null );
		assert.deepEqual( action.requiresInput, [ 'artifactDirectory' ] );
		assert.deepEqual(
			action.context.artifactDirectories,
			[ 'first-artifacts', 'second-artifacts' ],
		);
		assert.deepEqual(
			action.commandTemplate,
			[
				process.execPath,
				resolve( VERIFY_CLI, '../doctor.js' ),
				'--json',
				'--compact',
				'--source',
				'client',
				'--source-root',
				realpathSync( cwd ),
				'--artifacts',
				'<artifact-directory>',
			],
		);
		assert.equal( JSON.stringify( action ).includes( '\"artifacts\"' ), false );

	} finally {

		rmSync( cwd, { recursive: true, force: true } );

	}

} );

test( 'verify --json keeps argument failures machine-readable', () => {

	const result = runVerify( process.cwd(), '--json', '--not-an-option' );
	assert.equal( result.status, 1 );
	assert.equal( result.stderr, '' );
	const report = JSON.parse( result.stdout );
	assert.equal( report.schemaVersion, 1 );
	assert.equal( report.ok, false );
	assert.equal( report.status, 'failed' );
	assert.equal( report.command, 'tsl-precompile-verify' );
	assert.match( report.issues[ 0 ], /Unknown verify option/ );
	assert.equal( report.diagnostics[ 0 ].code, 'INVALID_ARGUMENTS' );
	assert.equal( report.nextActions[ 0 ].kind, 'command' );
	assert.equal( report.nextActions[ 0 ].code, 'show-help' );
	assert.equal( report.nextActions[ 0 ].cwd, process.cwd() );
	assert.deepEqual( report.nextActions[ 0 ].argv, [ process.execPath, VERIFY_CLI, '--help' ] );
	const [ command, ...args ] = report.nextActions[ 0 ].argv;
	const followup = spawnSync( command, args, {
		cwd: report.nextActions[ 0 ].cwd,
		encoding: 'utf8',
	} );
	assert.equal( followup.status, 0 );
	assert.match( followup.stdout, /Usage: tsl-precompile-verify/ );

} );

test( 'verify JSON help remains one machine-readable result', () => {

	const result = runVerify( process.cwd(), '--json', '--help' );
	assert.equal( result.status, 0 );
	assert.equal( result.stderr, '' );
	const report = JSON.parse( result.stdout );
	assert.equal( report.schemaVersion, 1 );
	assert.equal( report.ok, true );
	assert.equal( report.status, 'help' );
	assert.equal( report.command, 'tsl-precompile-verify' );
	assert.deepEqual( report.nextActions, [] );
	assert.match( report.help, /--source/ );

} );

test( 'verify source coverage maps missing authored and auto markers to source locations', () => {

	const cwd = mkdtempSync( join( tmpdir(), 'tslp-verify-marker-coverage-' ) );
	const artifactsDir = resolve( cwd, 'artifacts' );
	const sourceDir = resolve( cwd, 'src' );
	mkdirSync( artifactsDir );
	mkdirSync( sourceDir );
	const source = [
		'const authored = material.precompile( "hero" );',
		'const automatic = new MeshStandardNodeMaterial();',
	].join( '\n' );
	writeFileSync( resolve( sourceDir, 'main.js' ), source );
	const heroOwner = markerOwner( resolve( sourceDir, 'main.js' ), source, cwd );
	const hero = writeSignedMaterial( artifactsDir, 'hero', [ heroOwner ] );
	writeFileSync( resolve( artifactsDir, 'manifest.json' ), JSON.stringify( {
		hero: { file: hero.file, hash: hero.hash, sourceOwners: hero.sourceOwners },
	} ) );

	try {

		const result = runVerify(
			cwd,
			'--json',
			'--source', 'src',
			'--source-root', '.',
			'artifacts',
		);
		assert.equal( result.status, 1, result.stderr );
		const report = JSON.parse( result.stdout );
		assert.equal( report.markerCoverage.enabled, true );
		assert.equal( report.markerCoverage.checkedSourceFiles, 1 );
		assert.equal( report.markerCoverage.total, 2 );
		assert.equal( report.markerCoverage.covered, 1 );
		assert.equal( report.markerCoverage.missing.length, 1 );
		const missing = report.markerCoverage.missing[ 0 ];
		assert.equal( missing.name, autoMarkSource( source, {
			filename: resolve( sourceDir, 'main.js' ),
			root: cwd,
		} ).injectedNames[ 0 ] );
		assert.equal( missing.source, 'src/main.js' );
		assert.equal( missing.line, 2 );
		assert.equal( missing.column, 19 );
		assert.equal( missing.autoMarked, true );
		assert.equal( missing.covered, false );
		assert.match( report.issues.at( - 1 ), /missing captured artifact for auto marker/ );

	} finally {

		rmSync( cwd, { recursive: true, force: true } );

	}

} );

test( 'verify source coverage succeeds when every transformed marker is captured', () => {

	const cwd = mkdtempSync( join( tmpdir(), 'tslp-verify-marker-covered-' ) );
	const artifactsDir = resolve( cwd, 'artifacts' );
	const sourceDir = resolve( cwd, 'src' );
	mkdirSync( artifactsDir );
	mkdirSync( sourceDir );
	const sourceFile = resolve( sourceDir, 'main.js' );
	const source = 'const automatic = new MeshStandardNodeMaterial();\n';
	writeFileSync( sourceFile, source );
	const name = autoMarkSource( source, { filename: sourceFile, root: cwd } ).injectedNames[ 0 ];
	const entry = writeSignedMaterial( artifactsDir, name, [ markerOwner( sourceFile, source, cwd ) ] );
	writeFileSync( resolve( artifactsDir, 'manifest.json' ), JSON.stringify( {
		[ name ]: { file: entry.file, hash: entry.hash, sourceOwners: entry.sourceOwners },
	} ) );

	try {

		const result = runVerify( cwd, '--json', '--source=src/main.js', '--source-root=.', 'artifacts' );
		assert.equal( result.status, 0, result.stdout || result.stderr );
		const report = JSON.parse( result.stdout );
		assert.equal( report.ok, true );
		assert.equal( report.markerCoverage.total, 1 );
		assert.equal( report.markerCoverage.covered, 1 );
		assert.deepEqual( report.markerCoverage.missing, [] );
		assert.equal( report.markerCoverage.markers[ 0 ].source, 'src/main.js' );
		assert.equal( report.nextActions[ 0 ].code, 'run-doctor' );
		assert.match( report.nextActions[ 0 ].message, /real renderer route\/state/ );
		assert.match( report.nextActions[ 0 ].message, /WebGPURenderer production preview/ );
		assert.match( report.nextActions[ 0 ].message, /WebGPU or WebGL2 backend/ );

	} finally {

		rmSync( cwd, { recursive: true, force: true } );

	}

} );

test( 'verify source coverage requires every same-name call site owner', () => {

	const cwd = mkdtempSync( join( tmpdir(), 'tslp-verify-marker-owners-' ) );
	const artifactsDir = resolve( cwd, 'artifacts' );
	const sourceDir = resolve( cwd, 'src' );
	mkdirSync( artifactsDir );
	mkdirSync( sourceDir );
	const sourceFile = resolve( sourceDir, 'main.js' );
	const source = [
		`first.precompile( 'shared' );`,
		`second.precompile( 'shared' );`,
	].join( '\n' );
	writeFileSync( sourceFile, source );
	const entry = writeSignedMaterial( artifactsDir, 'shared', [
		markerOwner( sourceFile, source, cwd, 0 ),
	] );
	writeFileSync( resolve( artifactsDir, 'manifest.json' ), JSON.stringify( {
		shared: { file: entry.file, hash: entry.hash, sourceOwners: entry.sourceOwners },
	} ) );

	try {

		const result = runVerify( cwd, '--json', '--no-auto-mark', '--source=src', '--source-root=.', 'artifacts' );
		assert.equal( result.status, 1 );
		const report = JSON.parse( result.stdout );
		assert.equal( report.markerCoverage.total, 2 );
		assert.equal( report.markerCoverage.covered, 1 );
		assert.equal( report.markerCoverage.missing.length, 1 );
		assert.equal( report.markerCoverage.missing[ 0 ].sourceIdentity, 'src/main.js:precompile:1' );
		assert.equal( report.markerCoverage.missing[ 0 ].coverageReason, 'wrong-callsite' );
		assert.match( report.issues.at( -1 ), /was not captured from call site src\/main\.js:precompile:1/ );

	} finally {

		rmSync( cwd, { recursive: true, force: true } );

	}

} );

test( 'verify source coverage never trusts manifest-only call-site owners', () => {

	const cwd = mkdtempSync( join( tmpdir(), 'tslp-verify-marker-manifest-owner-' ) );
	const artifactsDir = resolve( cwd, 'artifacts' );
	const sourceDir = resolve( cwd, 'src' );
	mkdirSync( artifactsDir );
	mkdirSync( sourceDir );
	const sourceFile = resolve( sourceDir, 'main.js' );
	const source = `material.precompile( 'hero' );\n`;
	writeFileSync( sourceFile, source );
	const entry = writeSignedMaterial( artifactsDir, 'hero' );
	writeFileSync( resolve( artifactsDir, 'manifest.json' ), JSON.stringify( {
		hero: {
			file: entry.file,
			hash: entry.hash,
			sourceOwners: [ markerOwner( sourceFile, source, cwd, 0, { autoMark: false } ) ],
		},
	} ) );

	try {

		const result = runVerify( cwd, '--json', '--no-auto-mark', '--source=src', '--source-root=.', 'artifacts' );
		assert.equal( result.status, 1 );
		const marker = JSON.parse( result.stdout ).markerCoverage.missing[ 0 ];
		assert.equal( marker.coverageReason, 'missing-source-owners' );

	} finally {

		rmSync( cwd, { recursive: true, force: true } );

	}

} );

test( 'verify source coverage rejects stale call-site revisions', () => {

	const cwd = mkdtempSync( join( tmpdir(), 'tslp-verify-marker-revision-' ) );
	const artifactsDir = resolve( cwd, 'artifacts' );
	const sourceDir = resolve( cwd, 'src' );
	mkdirSync( artifactsDir );
	mkdirSync( sourceDir );
	const sourceFile = resolve( sourceDir, 'main.js' );
	const capturedSource = `material.precompile( 'hero' );\n`;
	const currentSource = `const changed = true;\n${ capturedSource }`;
	writeFileSync( sourceFile, currentSource );
	const entry = writeSignedMaterial( artifactsDir, 'hero', [
		markerOwner( sourceFile, capturedSource, cwd, 0, { autoMark: false } ),
	] );
	writeFileSync( resolve( artifactsDir, 'manifest.json' ), JSON.stringify( {
		hero: { file: entry.file, hash: entry.hash, sourceOwners: entry.sourceOwners },
	} ) );

	try {

		const result = runVerify( cwd, '--json', '--no-auto-mark', '--source=src/main.js', '--source-root=.', 'artifacts' );
		assert.equal( result.status, 1 );
		const marker = JSON.parse( result.stdout ).markerCoverage.missing[ 0 ];
		assert.equal( marker.sourceIdentity, 'src/main.js:precompile:0' );
		assert.equal( marker.coverageReason, 'stale-source-revision' );

	} finally {

		rmSync( cwd, { recursive: true, force: true } );

	}

} );

test( 'verify source coverage recomputes recorded transitive project-local dependencies', () => {

	const cwd = mkdtempSync( join( tmpdir(), 'tslp-verify-marker-dependency-' ) );
	const artifactsDir = resolve( cwd, 'artifacts' );
	const sourceDir = resolve( cwd, 'src' );
	mkdirSync( artifactsDir );
	mkdirSync( sourceDir );
	const sourceFile = resolve( sourceDir, 'main.js' );
	const helperFile = resolve( sourceDir, 'material-helper.js' );
	const source = [
		`import { material } from './material-helper.js';`,
		`material.precompile( 'hero' );`,
	].join( '\n' );
	const helperSource = `export const material = {};\n`;
	writeFileSync( sourceFile, source );
	writeFileSync( helperFile, helperSource );
	const transformed = transformedMarkerSource( sourceFile, source, cwd, { autoMark: false } );
	const dependencies = [ {
		identity: 'src/material-helper.js',
		revision: dependencyContentRevision( helperSource ),
	} ];
	const sourceOwner = {
		identity: 'src/main.js:precompile:0',
		revision: markerSourceRevision( transformed, dependencies ),
		provenance: {
			schema: MARKER_SOURCE_PROVENANCE_SCHEMA,
			dependencies: dependencies.map( ( dependency ) => dependency.identity ),
		},
	};
	const entry = writeSignedMaterial( artifactsDir, 'hero', [ sourceOwner ] );
	writeFileSync( resolve( artifactsDir, 'manifest.json' ), JSON.stringify( {
		hero: { file: entry.file, hash: entry.hash, sourceOwners: entry.sourceOwners },
	} ) );

	try {

		const current = runVerify( cwd, '--json', '--no-auto-mark', '--source=src/main.js', '--source-root=.', 'artifacts' );
		assert.equal( current.status, 0, current.stderr );
		assert.equal( JSON.parse( current.stdout ).markerCoverage.markers[ 0 ].coverageReason, 'exact-owner-dependency-revision' );

		writeFileSync( helperFile, `export const material = { changed: true };\n` );
		const stale = runVerify( cwd, '--json', '--no-auto-mark', '--source=src/main.js', '--source-root=.', 'artifacts' );
		assert.equal( stale.status, 1 );
		const report = JSON.parse( stale.stdout );
		assert.equal( report.markerCoverage.missing[ 0 ].coverageReason, 'stale-source-revision' );
		assert.match( report.issues.at( -1 ), /stale source revision/ );

	} finally {

		rmSync( cwd, { recursive: true, force: true } );

	}

} );

test( 'verify source coverage rejects unsupported files and empty supported-source directories', () => {

	const cwd = mkdtempSync( join( tmpdir(), 'tslp-verify-marker-source-kind-' ) );
	const artifactsDir = resolve( cwd, 'artifacts' );
	const sourceDir = resolve( cwd, 'src' );
	mkdirSync( artifactsDir );
	mkdirSync( sourceDir );
	const entry = writeSignedMaterial( artifactsDir, 'hero' );
	writeFileSync( resolve( artifactsDir, 'manifest.json' ), JSON.stringify( {
		hero: { file: entry.file, hash: entry.hash },
	} ) );
	writeFileSync( resolve( sourceDir, 'component.vue' ), '<script>material.precompile(\"hero\")</script>' );

	try {

		const unsupported = runVerify( cwd, '--json', '--source=src/component.vue', 'artifacts' );
		assert.equal( unsupported.status, 1 );
		assert.match( JSON.parse( unsupported.stdout ).issues.at( -1 ), /unsupported expected-marker source extension/ );

		const empty = runVerify( cwd, '--json', '--source=src', 'artifacts' );
		assert.equal( empty.status, 1 );
		assert.match( JSON.parse( empty.stdout ).issues.at( -1 ), /matched zero supported files/ );

	} finally {

		rmSync( cwd, { recursive: true, force: true } );

	}

} );
