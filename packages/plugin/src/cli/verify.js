#!/usr/bin/env node
/**
 * Artifact integrity CLI — `pnpm verify`.
 *
 * This is intentionally narrower than a full re-extract staleness audit:
 * it validates committed artifact files and manifests so CI can catch
 * corrupt JSON, missing manifest references, and unknown unsupported kinds.
 *
 * Shape fingerprints (`fingerprintArtifactShape`) are computed for every
 * checked artifact so CI logs can spot empty/malformed plans early. The
 * browser-capture vs Node re-extract convergence canary lives in
 * `packages/plugin/test/unit/extractor-convergence.test.js`; corpus-wide
 * re-extraction remains deliberately outside this structural CLI.
 */

import { access, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fingerprintArtifactShape } from '@tsl-precompile/contract/artifact-shape';
import { isArtifactCollection, validateArtifact } from '@tsl-precompile/contract/kinds';
import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';
import { ARTIFACT_CONTENT_HASH_VERSION } from '@tsl-precompile/contract/artifact-content';
import { SLIM_THREE_PACKAGE_VERSION } from '@tsl-precompile/contract/slim-three-policy';
import { computeArtifactContentHash } from '../hash.js';
import { loadArtifactDirectory } from '../artifact-directory-loader.js';
import { collectExpectedMarkerCoverage, parseVerifyArgs, VERIFY_HELP } from './verify-support.js';
import { normalizeMarkerSourceProvenance } from '../_shared/source-provenance.js';

verifyMain: {
const rawArgs = process.argv.slice( 2 );
const requestedJson = rawArgs.includes( '--json' );
const verifyCli = fileURLToPath( import.meta.url );
const doctorCli = fileURLToPath( new URL( './doctor.js', import.meta.url ) );
let options;
try {

	options = parseVerifyArgs( rawArgs );

} catch ( error ) {

	const message = `[tsl-precompile] verify: ${ error.message || String( error ) }`;
	if ( requestedJson ) {

		console.log( JSON.stringify( {
			schemaVersion: 1,
			ok: false,
			status: 'failed',
			command: 'tsl-precompile-verify',
			checkedArtifactFiles: 0,
			emptyShapeFingerprints: 0,
			directories: [],
			markerCoverage: disabledMarkerCoverage(),
			issues: [ message ],
			diagnostics: [ createVerifyDiagnostic( message, 'INVALID_ARGUMENTS' ) ],
			nextActions: [ commandAction( {
				code: 'show-help',
				message: 'Run tsl-precompile-verify --help and correct the arguments.',
				argv: [ process.execPath, verifyCli, '--help' ],
			} ) ],
		}, null, 2 ) );

	} else {

		console.error( message );
		console.error( 'Use -h or --help for usage.' );

	}
	process.exitCode = 1;
	break verifyMain;

}
if ( options.help ) {

	if ( options.json ) console.log( JSON.stringify( {
		schemaVersion: 1,
		ok: true,
		status: 'help',
		command: 'tsl-precompile-verify',
		help: VERIFY_HELP.trim(),
		nextActions: [],
	}, null, 2 ) );
	else console.log( VERIFY_HELP );
	break verifyMain;

}

const { dirs } = options;
const issues = [];
let checked = 0;
let emptyShapes = 0;
const capturedMarkers = new Map();
const directoryResults = [];

for ( const dirArg of dirs ) {

	const dir = resolve( process.cwd(), dirArg );
	const directoryResult = {
		input: dirArg,
		checkedArtifactFiles: 0,
		manifestEntries: 0,
	};
	directoryResults.push( directoryResult );
	if ( ! existsSync( dir ) ) {

		issues.push( `${ dirArg }: artifact directory does not exist` );
		continue;

	}

	let files;
	try {

		files = ( await readdir( dir ) ).filter( ( f ) => f.endsWith( '.json' ) ).sort();

	} catch ( error ) {

		issues.push( `${ dirArg }: could not read artifact directory (${ error.message || String( error ) })` );
		continue;

	}
	const manifest = await readManifest( dir );
	if ( manifest ) {

		directoryResult.manifestEntries = Object.keys( manifest ).filter( ( name ) => name !== '__aux' ).length;

	}
	let manifestIsSafe = true;
	try {

		await loadArtifactDirectory( dir, { rejectUnreferencedArtifacts: true } );

	} catch ( error ) {

		manifestIsSafe = false;
		issues.push( error.message || String( error ) );

	}
	if ( manifest && manifestIsSafe ) await validateManifest( dir, manifest );

	let directoryChecked = 0;
	for ( const file of files ) {

		if ( file === 'manifest.json' ) continue;
		directoryChecked ++;
		checked ++;
		await validateArtifactFile( dir, file );

	}
	directoryResult.checkedArtifactFiles = directoryChecked;
	if ( directoryChecked === 0 ) issues.push( `no artifact JSON files were checked in: ${ dirArg }` );

}

let markerCoverage = disabledMarkerCoverage();
if ( options.sources.length > 0 ) {

	markerCoverage = {
		...disabledMarkerCoverage(),
		enabled: true,
		sourceRoot: options.sourceRoot,
	};
	try {

		markerCoverage = await collectExpectedMarkerCoverage( {
			cwd: process.cwd(),
			sourcePaths: options.sources,
			sourceRoot: options.sourceRoot,
			autoMark: options.autoMark,
			autoMarkPrefix: options.autoMarkPrefix,
			capturedMarkers,
		} );
		for ( const issue of markerCoverage.issues ) issues.push( issue );
		for ( const marker of markerCoverage.missing ) {

			issues.push( formatMissingMarkerCoverageIssue( marker ) );

		}

	} catch ( error ) {

		issues.push( error.message || String( error ) );

	}

}

const result = {
	schemaVersion: 1,
	ok: issues.length === 0,
	status: issues.length === 0 ? 'passed' : 'failed',
	command: 'tsl-precompile-verify',
	checkedArtifactFiles: checked,
	emptyShapeFingerprints: emptyShapes,
	directories: directoryResults,
	markerCoverage,
	issues,
	diagnostics: issues.map( ( message ) => createVerifyDiagnostic( message ) ),
	nextActions: doctorActionsForVerifyOptions( options, issues.length === 0 ),
};

if ( options.json ) {

	console.log( JSON.stringify( result, null, 2 ) );
	process.exitCode = result.ok ? 0 : 1;
	break verifyMain;

}

if ( issues.length > 0 ) {

	console.error( `[tsl-precompile] verify failed with ${ issues.length } issue(s):` );
	for ( const issue of issues ) console.error( `  - ${ issue }` );
	process.exitCode = 1;
	break verifyMain;

}

console.log(
	`[tsl-precompile] verify ok (${ checked } artifact file${ checked === 1 ? '' : 's' } checked` +
	`${ emptyShapes > 0 ? `, ${ emptyShapes } empty shape fingerprint(s)` : '' }` +
	`${ markerCoverage.enabled ? `, ${ markerCoverage.covered }/${ markerCoverage.total } expected marker(s) covered` : '' }).`,
);
if ( ! markerCoverage.enabled ) console.log(
	'[tsl-precompile] Marker coverage was not checked; pass --source <path> to prove authored and automatic call-site coverage.',
);

function createVerifyDiagnostic( message, code = classifyVerifyIssue( message ) ) {

	return {
		code,
		severity: 'error',
		message,
	};

}

function commandAction( { code, message, argv } ) {

	return {
		kind: 'command',
		code,
		message,
		reason: message,
		action: message,
		cwd: process.cwd(),
		argv: [ ...argv ],
		commands: [ [ ...argv ] ],
	};

}

function doctorArgvForVerifyOptions( options ) {

	return [
		process.execPath,
		doctorCli,
		'--json',
		'--compact',
		...options.sources.flatMap( ( source ) => [ '--source', source ] ),
		...( options.sources.length > 0 ? [ '--source-root', options.sourceRoot ] : [] ),
		...( options.dirs.length === 1 ? [ '--artifacts', options.dirs[ 0 ] ] : [] ),
		...( options.autoMark ? [] : [ '--no-auto-mark' ] ),
		...( options.autoMarkPrefix === 'auto' ? [] : [ '--auto-mark-prefix', options.autoMarkPrefix ] ),
	];

}

function doctorActionsForVerifyOptions( options, verified ) {

	if ( options.dirs.length === 1 ) return [ commandAction( {
		code: 'run-doctor',
		message: resultNextActionMessage( verified ),
		argv: doctorArgvForVerifyOptions( options ),
	} ) ];
	return [ manualAction( {
		code: 'select-doctor-artifact-directory',
		message: 'Verification checked multiple artifact directories, but the doctor accepts one application artifact directory at a time. Select the Vite application context explicitly; no default artifacts directory was inferred.',
		requiresInput: [ 'artifactDirectory' ],
		context: {
			artifactDirectories: [ ...options.dirs ],
			sourceRoot: options.sourceRoot,
			sources: [ ...options.sources ],
		},
		commandTemplate: [
			process.execPath,
			doctorCli,
			'--json',
			'--compact',
			...options.sources.flatMap( ( source ) => [ '--source', source ] ),
			...( options.sources.length > 0 ? [ '--source-root', options.sourceRoot ] : [] ),
			'--artifacts',
			'<artifact-directory>',
			...( options.autoMark ? [] : [ '--no-auto-mark' ] ),
			...( options.autoMarkPrefix === 'auto' ? [] : [ '--auto-mark-prefix', options.autoMarkPrefix ] ),
		],
	} ) ];

}

function manualAction( {
	code,
	message,
	requiresInput = [],
	context = null,
	commandTemplate = null,
} ) {

	return {
		kind: 'manual',
		code,
		message,
		reason: message,
		action: message,
		cwd: process.cwd(),
		argv: null,
		...( requiresInput.length > 0 ? { requiresInput: [ ...requiresInput ] } : {} ),
		...( context === null ? {} : { context } ),
		...( commandTemplate === null ? {} : { commandTemplate: [ ...commandTemplate ] } ),
	};

}

function resultNextActionMessage( verified ) {

	return verified
		? 'Run the read-only doctor for the remaining production-build, real renderer route/state and topology coverage, and WebGPURenderer production preview gates with the app\'s WebGPU or WebGL2 backend.'
		: 'Run the read-only doctor for an ordered remediation plan; recapture stale or missing artifacts and never hand-edit generated JSON.';

}

function classifyVerifyIssue( message ) {

	if ( /artifact directory does not exist/i.test( message ) ) return 'ARTIFACT_DIRECTORY_MISSING';
	if ( /could not read artifact directory/i.test( message ) ) return 'ARTIFACT_DIRECTORY_UNREADABLE';
	if ( /no artifact JSON files were checked/i.test( message ) ) return 'ARTIFACT_DIRECTORY_EMPTY';
	if ( /invalid JSON/i.test( message ) ) return 'ARTIFACT_JSON_INVALID';
	if ( /manifest|unsafe artifact filename|unreferenced artifact|duplicate artifact identity/i.test( message ) ) return 'MANIFEST_INVALID';
	if ( /expected-marker|missing (?:authored|auto) marker|call-site|source revision/i.test( message ) ) return 'MARKER_COVERAGE_FAILED';
	if ( /(?:three|plugin|toolchain|sourceHash)Version|provenance|unsigned/i.test( message ) ) return 'ARTIFACT_PROVENANCE_INVALID';
	if ( /__hash|content signature|artifactContentHashVersion|runtime content/i.test( message ) ) return 'ARTIFACT_INTEGRITY_MISMATCH';
	return 'ARTIFACT_VALIDATION_FAILED';

}

async function readManifest( dir ) {

	const path = join( dir, 'manifest.json' );
	if ( ! existsSync( path ) ) return null;
	try {

		const parsed = JSON.parse( await readFile( path, 'utf8' ) );
		if ( ! parsed || typeof parsed !== 'object' || Array.isArray( parsed ) ) {

			issues.push( `${ path }: manifest root must be an object` );
			return null;

		}
		return parsed;

	} catch ( err ) {

		issues.push( `${ path }: invalid JSON (${ err.message })` );
		return null;

	}

}

async function validateManifest( dir, manifest ) {

	for ( const [ name, entry ] of Object.entries( manifest ) ) {

		if ( name === '__aux' ) continue;
		if ( ! entry || typeof entry.file !== 'string' ) {

			issues.push( `${ join( dir, 'manifest.json' ) }: manifest entry "${ name }" is missing file` );
			continue;

		}
		await assertExists( join( dir, entry.file ), `manifest entry "${ name }"` );

	}

	const aux = manifest.__aux;
	if ( aux && typeof aux === 'object' ) {

		for ( const [ key, entry ] of Object.entries( aux ) ) {

			if ( ! entry || typeof entry.file !== 'string' ) {

				issues.push( `${ join( dir, 'manifest.json' ) }: aux entry "${ key }" is missing file` );
				continue;

			}
			await assertExists( join( dir, entry.file ), `aux manifest entry "${ key }"` );
			validateExpectedAuxProvenance( entry, `${ join( dir, 'manifest.json' ) }: aux entry "${ key }"` );
			await validateAuxManifestEnvelopeAgreement( dir, key, entry );

		}

	}

}

async function validateArtifactFile( dir, file ) {

	const path = join( dir, file );
	let parsed;
	try {

		parsed = JSON.parse( await readFile( path, 'utf8' ) );

	} catch ( err ) {

		issues.push( `${ path }: invalid JSON (${ err.message })` );
		return;

	}

	const allowEmptyCollection = file.endsWith( '.user.json' ) || file.endsWith( '.aux.json' );
	const isCollection = isArtifactCollection( parsed, { allowEmpty: allowEmptyCollection } );
	if ( isCollection ) {

		const validation = validateArtifact( parsed, { label: path, allowEmptyCollection } );
		for ( const error of validation.errors ) issues.push( `${ path }: ${ error.message }` );
		const shape = fingerprintArtifactShape( parsed );
		if ( shape.length === 0 && ! allowEmptyCollection ) emptyShapes ++;
		return;

	}

	const isUser = typeof parsed.__name === 'string' && parsed.__name.length > 0;
	const isAux = typeof parsed.__materialShape === 'string' && typeof parsed.__configHash === 'string';
	if ( isUser && ! isAux ) recordCapturedMarker( parsed.__name, parsed.__sourceOwners );
	if ( ! isUser && ! isAux ) issues.push( `${ path }: expected __name or __materialShape/__configHash metadata` );
	if ( isAux ) validateExpectedAuxProvenance( parsed, path );
	if ( typeof parsed.__hash !== 'string' || parsed.__hash.length === 0 ) issues.push( `${ path }: missing __hash` );
	if ( ! parsed.artifact || typeof parsed.artifact !== 'object' ) issues.push( `${ path }: missing artifact object` );
	else {

		const validation = validateArtifact( parsed, { label: path } );
		for ( const error of validation.errors ) issues.push( `${ path }: ${ error.message }` );
		if ( ! isAux ) validateSourceHashMetadata( parsed.artifact, path );
		validateArtifactContentHash( parsed, path, { requireSignature: true } );
		const shape = fingerprintArtifactShape( parsed );
		if ( shape.length === 0 ) emptyShapes ++;

	}

	const unsupported = Array.isArray( parsed.__unsupportedKinds ) ? parsed.__unsupportedKinds : [];
	for ( const item of unsupported ) {

		if ( item && item.severity === 'unknown' ) {

			issues.push( `${ path }: unsupported kind "${ item.kind || '<unknown>' }" has severity "unknown"` );

		}

	}

}

function recordCapturedMarker( name, sourceOwners ) {

	if ( typeof name !== 'string' || name.length === 0 ) return;
	const current = capturedMarkers.get( name ) || { name, sourceOwners: [] };
	const byIdentity = new Map( current.sourceOwners.map( ( owner ) => [ owner.identity, owner ] ) );
	for ( const owner of Array.isArray( sourceOwners ) ? sourceOwners : [] ) {

		if ( ! owner || typeof owner.identity !== 'string' || owner.identity.length === 0 ) continue;
		const normalizedOwner = {
			identity: owner.identity,
			revision: typeof owner.revision === 'string' ? owner.revision.toLowerCase() : null,
		};
		if ( owner.provenance !== undefined ) {

			try {

				normalizedOwner.provenance = normalizeMarkerSourceProvenance(
					owner.provenance,
					`${ name } source owner ${ owner.identity } provenance`,
				);

			} catch ( error ) {

				normalizedOwner.provenance = owner.provenance;
				issues.push( error.message || String( error ) );

			}

		}
		byIdentity.set( owner.identity, normalizedOwner );

	}
	current.sourceOwners = [ ...byIdentity.values() ].sort( ( a, b ) => a.identity.localeCompare( b.identity ) );
	capturedMarkers.set( name, current );

}

function formatMissingMarkerCoverageIssue( marker ) {

	const label = `${ marker.autoMarked ? 'auto' : 'authored' } marker ${ JSON.stringify( marker.name ) } at ${ marker.source }:${ marker.line }:${ marker.column }`;
	if ( marker.coverageReason === 'missing-source-owners' ) {

		return `captured artifact for ${ label } lacks exact call-site ownership; recapture it with the current plugin`;

	}
	if ( marker.coverageReason === 'wrong-callsite' ) {

		return `captured artifact for ${ label } was not captured from call site ${ marker.sourceIdentity }`;

	}
	if ( marker.coverageReason === 'stale-source-revision' ) {

		return `captured artifact for ${ label } has a stale source revision; recapture this render path`;

	}
	if ( marker.coverageReason === 'invalid-source-provenance' ) {

		return `captured artifact for ${ label } has invalid or unreadable project-local dependency provenance: ${ marker.sourceProvenanceIssue || 'unknown provenance error' }`;

	}
	return `missing captured artifact for ${ label }`;

}

function validateExpectedAuxProvenance( value, label ) {

	if ( value.threeVersion !== SLIM_THREE_PACKAGE_VERSION ) {

		issues.push( `${ label }: threeVersion must be exact current baseline ${ SLIM_THREE_PACKAGE_VERSION }` );

	}
	if ( value.pluginVersion !== ARTIFACT_TOOLCHAIN_VERSION ) {

		issues.push( `${ label }: pluginVersion must be current toolchain ${ ARTIFACT_TOOLCHAIN_VERSION }` );

	}

}

async function validateAuxManifestEnvelopeAgreement( dir, key, manifestEntry ) {

	const path = join( dir, manifestEntry.file );
	let envelope;
	try {

		envelope = JSON.parse( await readFile( path, 'utf8' ) );

	} catch ( _ ) {

		return; // Missing/invalid JSON is reported by the ordinary manifest/file checks.

	}
	if ( ! envelope || typeof envelope !== 'object' || Array.isArray( envelope ) ) return;
	for ( const field of [ 'threeVersion', 'pluginVersion' ] ) {

		if ( envelope[ field ] !== manifestEntry[ field ] ) {

			issues.push( `${ path}: aux manifest entry "${ key }" ${ field } does not match artifact envelope` );

		}

	}
	if ( manifestEntry.hash !== envelope.__hash ) {

		issues.push( `${ path}: aux manifest entry "${ key }" hash does not match artifact envelope __hash` );

	}
	const artifact = envelope.artifact;
	if ( artifact && typeof artifact === 'object' ) {

		if ( artifact.sourceThreeVersion !== envelope.threeVersion ) {

			issues.push( `${ path}: artifact sourceThreeVersion does not match auxiliary envelope threeVersion` );

		}
		if ( artifact.sourceHashVersion !== envelope.pluginVersion ) {

			issues.push( `${ path}: artifact sourceHashVersion does not match auxiliary envelope pluginVersion` );

		}

	}

}

function validateArtifactContentHash( envelope, path, opts = {} ) {

	const artifact = envelope && envelope.artifact;
	if ( ! artifact ) return;
	if ( artifact.artifactContentHashVersion === undefined ) {

		if ( opts.requireSignature ) issues.push( `${ path }: auxiliary artifact is missing artifactContentHashVersion/content signature` );
		return;

	}
	if ( artifact.artifactContentHashVersion !== ARTIFACT_CONTENT_HASH_VERSION ) {

		issues.push( `${ path }: artifactContentHashVersion must be ${ ARTIFACT_CONTENT_HASH_VERSION }` );
		return;

	}
	const shape = typeof envelope.__materialShape === 'string'
		? envelope.__materialShape
		: typeof envelope.__name === 'string'
			? `material:${ envelope.__name }`
			: null;
	if ( shape === null || typeof envelope.__hash !== 'string' ) return;
	if ( typeof artifact.sourceThreeVersion !== 'string' || typeof artifact.sourceHashVersion !== 'string' ) {

		issues.push( `${ path }: signed artifact is missing exact sourceThreeVersion/sourceHashVersion provenance` );
		return;

	}
	const computed = computeArtifactContentHash( artifact, {
		shape,
		threeVersion: artifact.sourceThreeVersion,
		pluginVersion: artifact.sourceHashVersion,
	} );
	if ( computed !== envelope.__hash ) issues.push( `${ path }: stored __hash does not match artifact runtime content` );

}

function validateSourceHashMetadata( artifact, path ) {

	const fields = [ 'sourceGraphHash', 'sourceHashVersion', 'sourceThreeVersion', 'renderContextSignature' ];
	if ( ! fields.some( ( key ) => artifact[ key ] !== undefined ) ) {

		issues.push( `${ path }: artifact is unsigned or missing source-hash provenance; recapture it` );
		return;

	}
	if ( typeof artifact.sourceGraphHash !== 'string' || ! /^[a-f0-9]{64}$/i.test( artifact.sourceGraphHash ) ) {

		issues.push( `${ path }: sourceGraphHash must be a 64-character SHA-256 hex string` );

	}
	if ( artifact.sourceHashVersion !== ARTIFACT_TOOLCHAIN_VERSION ) {

		issues.push( `${ path }: sourceHashVersion must be ${ ARTIFACT_TOOLCHAIN_VERSION }` );

	}
	if ( typeof artifact.sourceThreeVersion !== 'string' || artifact.sourceThreeVersion.length === 0 ) {

		issues.push( `${ path }: sourceThreeVersion must be a non-empty exact Three package version` );

	}
	if ( artifact.renderContextSignature !== undefined && typeof artifact.renderContextSignature !== 'string' ) {

		issues.push( `${ path }: renderContextSignature must be a canonical string when present` );

	}

}

async function assertExists( path, label ) {

	try {

		await access( path );

	} catch ( _ ) {

		issues.push( `${ label } references missing file ${ path }` );

	}

}

function disabledMarkerCoverage() {

	return {
		enabled: false,
		sourceRoot: null,
		checkedSourceFiles: 0,
		total: 0,
		covered: 0,
		missing: [],
		markers: [],
		issues: [],
	};

}
}
