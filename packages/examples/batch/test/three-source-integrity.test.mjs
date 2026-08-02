import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
	createThreeGitSourceVerifier,
	fingerprintThreeSourceVerificationRecords,
	THREE_SOURCE_INTEGRITY_MISMATCH,
} from '../_three-version.mjs';
import { EvidenceSourceRecorder } from '../e2e-evidence.mjs';

function git( root, ...args ) {

	return execFileSync( 'git', args, {
		cwd: root,
		encoding: 'utf8',
		stdio: [ 'ignore', 'pipe', 'pipe' ],
	} ).trim();

}

function gitFixture( t ) {

	const root = mkdtempSync( join( tmpdir(), 'tslp-three-source-integrity-' ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	git( root, 'init', '-b', 'main' );
	git( root, 'config', 'user.name', 'Three Source Integrity Test' );
	git( root, 'config', 'user.email', 'three-source-integrity@example.invalid' );
	const source = join( root, 'served.js' );
	writeFileSync( source, 'export const value = "official";\n' );
	git( root, 'add', 'served.js' );
	git( root, 'commit', '-m', 'official fixture' );
	return {
		commit: git( root, 'rev-parse', 'HEAD' ),
		official: readFileSync( source ),
		root,
		source,
	};

}

test( 'Git source verifier rejects a transient served mutation even when pre/post checkout checks are clean', ( t ) => {

	const fixture = gitFixture( t );
	assert.equal( git( fixture.root, 'status', '--porcelain=v1', '--untracked-files=all' ), '' );
	assert.equal( git( fixture.root, 'rev-parse', 'HEAD' ), fixture.commit );
	const verifier = createThreeGitSourceVerifier(
		fixture.root,
		fixture.commit,
		'transient mutation regression',
	);

	writeFileSync( fixture.source, 'export const value = "transient bypass";\n' );
	const bytesActuallyServed = readFileSync( fixture.source );
	writeFileSync( fixture.source, fixture.official );
	assert.equal(
		git( fixture.root, 'status', '--porcelain=v1', '--untracked-files=all' ),
		'',
		'the old pre/post clean-only gate cannot observe the transient bytes',
	);
	assert.equal( git( fixture.root, 'rev-parse', 'HEAD' ), fixture.commit );

	assert.throws(
		() => verifier.verify( fixture.source, bytesActuallyServed ),
		( error ) => {

			assert.equal( error.code, THREE_SOURCE_INTEGRITY_MISMATCH );
			assert.match( error.message, /served source served\.js has Git blob .* expected .* from commit/ );
			return true;

		},
	);
	assert.throws(
		() => verifier.assertValid(),
		/transient mutation regression.*served source served\.js/,
		'a later restore cannot clear the verifier failure',
	);

} );

test( 'evidence source recorder stores Git-blob proof for accepted bytes and rejects untracked Three input', ( t ) => {

	const fixture = gitFixture( t );
	const repositoryRoot = mkdtempSync( join( tmpdir(), 'tslp-source-recorder-repo-' ) );
	t.after( () => rmSync( repositoryRoot, { recursive: true, force: true } ) );
	const verifier = createThreeGitSourceVerifier( fixture.root, fixture.commit, 'recorder Git proof' );
	const recorder = new EvidenceSourceRecorder( {
		repoRoot: repositoryRoot,
		threeRoot: fixture.root,
		threeSourceVerifier: verifier,
	} );
	assert.deepEqual( recorder.record( fixture.source ), fixture.official );
	const record = recorder.snapshot( 'three' ).files[ 0 ];
	assert.equal( record.gitCommit, fixture.commit );
	assert.match( record.gitBlob, /^[a-f0-9]{40}$/ );
	assert.equal( record.gitTree, git( fixture.root, 'rev-parse', `${ fixture.commit }^{tree}` ) );
	assert.equal( record.gitMode, '100644' );
	assert.equal( record.gitObjectFormat, 'sha1' );
	const sourceVerification = verifier.snapshot();
	assert.equal( sourceVerification.files.length, 1 );
	assert.deepEqual( sourceVerification.files[ 0 ], {
		path: record.path,
		bytes: record.bytes,
		gitBlob: record.gitBlob,
		gitMode: record.gitMode,
		sha256: record.sha256,
		gitCommit: record.gitCommit,
		gitTree: record.gitTree,
		gitObjectFormat: record.gitObjectFormat,
	} );
	assert.equal(
		sourceVerification.verifiedSourcesSha256,
		fingerprintThreeSourceVerificationRecords( sourceVerification.files ),
	);

	const untracked = join( fixture.root, 'injected.js' );
	writeFileSync( untracked, 'export const injected = true;\n' );
	assert.throws(
		() => recorder.record( untracked ),
		/not a tracked blob/,
	);
	assert.throws( () => verifier.assertValid(), /not a tracked blob/ );

} );

test( 'canonical stock and visual runners verify served bytes and recheck the checkout after serving', () => {

	const stockSource = readFileSync( new URL( '../run.mjs', import.meta.url ), 'utf8' );
	const visualSource = readFileSync( new URL( '../run-e2e.mjs', import.meta.url ), 'utf8' );
	const campaignSource = readFileSync( new URL( '../run-evidence-campaign.mjs', import.meta.url ), 'utf8' );
	assert.match( stockSource, /officialThreeSourceVerifier\?\.verify\( filePath, buf \)/ );
	assert.match( stockSource, /assertOfficialThreeR185Checkout\( threeRepo, 'batch post-run canonical evidence' \)/ );
	assert.match( stockSource, /installBrowserFailureCollector\( page, \{ pageUrl \} \)/ );
	assert.doesNotMatch( stockSource, /Failed to load resource\/i\.test/ );
	assert.match( stockSource, /failureCollector\?\.dispose\(\);[\s\S]*await context\.close\(\)\.catch/ );
	assert.match( stockSource, /await browser\?\.close\(\)\.catch[\s\S]*if \( server\.listening \)/ );
	assert.match( stockSource, /res\.end\( 'internal server error' \)/ );
	assert.match( visualSource, /sourceRecorder\.setThreeSourceVerifier\(\s*officialThreeSourceVerifier\s*\)/ );
	assert.match( visualSource, /assertOfficialThreeR185Checkout\( threeRepo, 'batch-e2e post-run canonical evidence' \)/ );
	assert.match( visualSource, /trackedReadFileSync\( join\( threeRepo, 'build\/three\.webgpu\.js' \), 'utf8' \)/ );
	assert.doesNotMatch( visualSource, /pathToFileURL\( join\( threeRepo/ );
	assert.match( campaignSource, /'--require-official-three-sources'/ );

} );
