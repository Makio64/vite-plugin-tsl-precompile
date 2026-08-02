import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ARTIFACT_CONTENT_HASH_VERSION } from '@tsl-precompile/contract/artifact-content';
import { collectArtifactVariantCandidates } from '@tsl-precompile/contract/artifact-variants';
import { stableJsonStringify } from '@tsl-precompile/contract/stable-json';
import { writeAuxiliaryFamilyCapture } from '../../src/dev-capture-server.js';
import { computeArtifactContentHash } from '../../src/hash.js';

const CONFIG_HASH = '9'.repeat( 64 );
const SHAPES = [ 'shadow-vsm-vertical', 'shadow-vsm-horizontal' ];
const HASH_CHARACTERS = {
	1: [ 'a', 'b' ],
	2: [ 'c', 'd' ],
	3: [ 'e', 'f' ],
};

function familyPayload( generation ) {

	return {
		auxiliaryFamily: 'shadow-vsm',
		members: SHAPES.map( ( materialShape, index ) => ( {
			materialShape,
			configHash: CONFIG_HASH,
			hash: HASH_CHARACTERS[ generation ][ index ].repeat( 64 ),
			name: `aux-${ materialShape }`,
			threeVersion: '0.185.1',
			pluginVersion: '0.1.0',
			artifact: {
				version: 3,
				materialShape,
				generation,
				vertexShader: `vertex-${ generation }-${ index }`,
				fragmentShader: `fragment-${ generation }-${ index }`,
			},
		} ) ),
	};

}

function backendFamilyPayload( shaderLanguage ) {

	const backend = shaderLanguage === 'wgsl' ? 'webgpu' : 'webgl';
	return {
		auxiliaryFamily: 'shadow-vsm',
		members: SHAPES.map( ( materialShape, index ) => {

			const cacheKey = `renderer-owned-${ index }`;
			const selector = stableJsonStringify( {
				version: 'render-object-selector@1',
				renderer: { backend: { kind: backend } },
				target: { surface: 'offscreen-2d' },
			} );
			const shaders = shaderLanguage === 'wgsl' ? {
				vertexShader: `@vertex fn stage_${ index }() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }`,
				fragmentShader: `@fragment fn stage_${ index }() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }`,
			} : {
				vertexShader: `#version 300 es\nvoid main() { gl_Position = vec4(${ index }.0); }`,
				fragmentShader: '#version 300 es\nprecision highp float;\nout vec4 color;\nvoid main() { color = vec4(1.0); }',
			};
			const artifact = {
				version: 3,
				cacheKey,
				variantKey: `${ backend }:${ cacheKey }`,
				shaderLanguage,
				materialShape,
				renderContextSelectors: [ selector ],
				...shaders,
				bindings: [],
				uniformPlan: [],
				artifactContentHashVersion: ARTIFACT_CONTENT_HASH_VERSION,
				sourceGraphHash: String( index + 1 ).repeat( 64 ),
				sourceHashVersion: '0.1.0',
				sourceThreeVersion: '0.185.1',
				sourceValidationMode: 'runtime-graph',
				renderContextSignature: selector,
			};
			return {
				materialShape,
				configHash: CONFIG_HASH,
				hash: computeArtifactContentHash( artifact, {
					shape: materialShape,
					threeVersion: '0.185.1',
					pluginVersion: '0.1.0',
				} ),
				name: `aux-${ materialShape }`,
				threeVersion: '0.185.1',
				pluginVersion: '0.1.0',
				artifact,
			};

		} ),
	};

}

function readJson( filepath ) {

	return JSON.parse( readFileSync( filepath, 'utf8' ) );

}

function durableSnapshot( filepaths ) {

	return filepaths.map( ( filepath ) => {

		const stat = statSync( filepath, { bigint: true } );
		return {
			filepath,
			bytes: readFileSync( filepath, 'utf8' ),
			ino: stat.ino,
			mtimeNs: stat.mtimeNs,
			size: stat.size,
		};

	} );

}

test( 'auxiliary family capture publishes, no-ops, replaces, prunes, and rolls back atomically', async () => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-aux-family-atomic-' ) );
	const artifactsDir = join( root, 'artifacts' );
	const manifestPath = join( artifactsDir, 'manifest.json' );

	try {

		const firstPayload = familyPayload( 1 );
		const first = await writeAuxiliaryFamilyCapture( artifactsDir, manifestPath, firstPayload );
		assert.equal( first.auxiliaryFamily, 'shadow-vsm' );
		assert.equal( first.changed, true );
		assert.deepEqual(
			first.members.map( ( member ) => member.materialShape ),
			SHAPES,
		);
		for ( const [ index, result ] of first.members.entries() ) {

			assert.equal(
				result.file,
				`aux-${ SHAPES[ index ] }-${ CONFIG_HASH }-${ HASH_CHARACTERS[ 1 ][ index ].repeat( 64 ) }.json`,
				'family filenames retain the full config and content digests',
			);

		}

		const firstManifest = readJson( manifestPath );
		const firstKeys = SHAPES.map( ( shape ) => `${ shape }:${ CONFIG_HASH }` );
		assert.deepEqual( Object.keys( firstManifest.__aux ).sort(), [ ...firstKeys ].sort() );
		const firstCapturedAt = firstKeys.map( ( key ) => firstManifest.__aux[ key ].capturedAt );
		assert.equal( firstCapturedAt[ 0 ], firstCapturedAt[ 1 ], 'one family commit shares one timestamp' );
		for ( const [ index, result ] of first.members.entries() ) {

			const member = firstPayload.members[ index ];
			const entry = firstManifest.__aux[ `${ member.materialShape }:${ CONFIG_HASH }` ];
			assert.equal( entry.file, result.file );
			assert.equal( entry.hash, member.hash );
			assert.equal( entry.shape, member.materialShape );
			assert.equal( entry.configHash, CONFIG_HASH );
			assert.deepEqual( readJson( join( artifactsDir, result.file ) ), {
				__materialShape: member.materialShape,
				__configHash: CONFIG_HASH,
				__hash: member.hash,
				__name: member.name,
				threeVersion: member.threeVersion,
				pluginVersion: member.pluginVersion,
				artifact: member.artifact,
			} );

		}
		assert.equal(
			readdirSync( artifactsDir ).some( ( filename ) => filename.includes( '.tmp-' ) ),
			false,
		);

		const firstPaths = [
			manifestPath,
			...first.members.map( ( member ) => join( artifactsDir, member.file ) ),
		];
		const beforeNoop = durableSnapshot( firstPaths );
		const noop = await writeAuxiliaryFamilyCapture( artifactsDir, manifestPath, firstPayload );
		assert.equal( noop.changed, false );
		assert.deepEqual( noop.members, first.members );
		assert.deepEqual(
			durableSnapshot( firstPaths ),
			beforeNoop,
			'exact recapture must preserve manifest and artifact bytes, inodes, and mtimes',
		);

		const replacementPayload = familyPayload( 2 );
		const replacement = await writeAuxiliaryFamilyCapture(
			artifactsDir,
			manifestPath,
			replacementPayload,
		);
		assert.equal( replacement.changed, true );
		const replacementManifest = readJson( manifestPath );
		for ( const [ index, result ] of replacement.members.entries() ) {

			const member = replacementPayload.members[ index ];
			const key = `${ member.materialShape }:${ CONFIG_HASH }`;
			assert.equal( replacementManifest.__aux[ key ].file, result.file );
			assert.equal( replacementManifest.__aux[ key ].hash, member.hash );
			assert.equal( readJson( join( artifactsDir, result.file ) ).artifact.generation, 2 );
			assert.equal( existsSync( join( artifactsDir, first.members[ index ].file ) ), false );

		}
		assert.deepEqual(
			readdirSync( artifactsDir ).sort(),
			[ 'manifest.json', ...replacement.members.map( ( member ) => member.file ) ].sort(),
			'only the authoritative content-addressed generation remains',
		);

		const rollbackArtifactsDir = join( root, 'rollback-artifacts' );
		const manifestParentBlocker = join( root, 'manifest-parent-blocker' );
		const blockerBytes = 'manifest parent is deliberately a regular file';
		writeFileSync( manifestParentBlocker, blockerBytes );
		const impossibleManifestPath = join( manifestParentBlocker, 'manifest.json' );
		await assert.rejects(
			writeAuxiliaryFamilyCapture(
				rollbackArtifactsDir,
				impossibleManifestPath,
				familyPayload( 3 ),
			),
			( error ) => error?.code === 'EEXIST' || error?.code === 'ENOTDIR',
		);
		assert.equal( readFileSync( manifestParentBlocker, 'utf8' ), blockerBytes );
		assert.deepEqual(
			readdirSync( rollbackArtifactsDir ),
			[],
			'failed manifest publication removes every newly created member and temp file',
		);

		const sharedPrefixPayload = familyPayload( 1 );
		sharedPrefixPayload.members[ 0 ].hash = `${ '1'.repeat( 12 ) }${ 'a'.repeat( 52 ) }`;
		sharedPrefixPayload.members[ 1 ].hash = `${ '1'.repeat( 12 ) }${ 'b'.repeat( 52 ) }`;
		const sharedPrefix = await writeAuxiliaryFamilyCapture(
			join( root, 'shared-prefix-artifacts' ),
			join( root, 'shared-prefix-artifacts', 'manifest.json' ),
			sharedPrefixPayload,
		);
		assert.notEqual(
			sharedPrefix.members[ 0 ].file,
			sharedPrefix.members[ 1 ].file,
			'full family digests cannot alias when their first 12 characters collide',
		);

	} finally {

		rmSync( root, { recursive: true, force: true } );

	}

} );

test( 'auxiliary family capture removes stale same-config stages in the manifest transaction', async () => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-aux-family-stages-' ) );
	const artifactsDir = join( root, 'artifacts' );
	const manifestPath = join( artifactsDir, 'manifest.json' );
	const member = ( materialShape, hashCharacter ) => ( {
		materialShape,
		configHash: CONFIG_HASH,
		hash: hashCharacter.repeat( 64 ),
		name: `aux-${ materialShape }`,
		threeVersion: '0.185.1',
		pluginVersion: '0.1.0',
		artifact: {
			version: 3,
			materialShape,
			vertexShader: `vertex-${ materialShape }`,
			fragmentShader: `fragment-${ materialShape }`,
		},
	} );

	try {

		const initial = await writeAuxiliaryFamilyCapture( artifactsDir, manifestPath, {
			auxiliaryFamily: 'pmrem',
			members: [
				member( 'pmrem-equirect', 'a' ),
				member( 'pmrem-blur', 'b' ),
				member( 'pmrem-ggx', 'c' ),
			],
		} );
		const staleBlurFile = initial.members.find( ( entry ) => entry.materialShape === 'pmrem-blur' ).file;

		const exact = await writeAuxiliaryFamilyCapture( artifactsDir, manifestPath, {
			auxiliaryFamily: 'pmrem',
			members: [
				member( 'pmrem-equirect', 'a' ),
				member( 'pmrem-ggx', 'c' ),
			],
		} );
		assert.equal( exact.changed, true );
		assert.deepEqual(
			Object.values( readJson( manifestPath ).__aux )
				.map( ( entry ) => entry.shape )
				.sort(),
			[ 'pmrem-equirect', 'pmrem-ggx' ],
		);
		assert.equal( existsSync( join( artifactsDir, staleBlurFile ) ), false );

	} finally {

		rmSync( root, { recursive: true, force: true } );

	}

} );

test( 'auxiliary family capture atomically retains WGSL and GLSL variants and no-ops on either subset', async () => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-aux-family-backends-' ) );
	const artifactsDir = join( root, 'artifacts' );
	const manifestPath = join( artifactsDir, 'manifest.json' );
	const payloads = [ backendFamilyPayload( 'wgsl' ), backendFamilyPayload( 'glsl' ) ];

	try {

		const first = await writeAuxiliaryFamilyCapture( artifactsDir, manifestPath, payloads[ 0 ] );
		assert.equal( first.changed, true );
		const merged = await writeAuxiliaryFamilyCapture( artifactsDir, manifestPath, payloads[ 1 ] );
		assert.equal( merged.changed, true );

		const manifest = readJson( manifestPath );
		for ( const member of merged.members ) {

			const entry = manifest.__aux[ `${ member.materialShape }:${ CONFIG_HASH }` ];
			const stored = readJson( join( artifactsDir, entry.file ) );
			const candidates = collectArtifactVariantCandidates( stored.artifact );
			assert.deepEqual( candidates.map( ( candidate ) => candidate.shaderLanguage ).sort(), [ 'glsl', 'wgsl' ] );
			assert.equal( stored.__hash, entry.hash );
			assert.equal( entry.hash, computeArtifactContentHash( stored.artifact, {
				shape: member.materialShape,
				threeVersion: '0.185.1',
				pluginVersion: '0.1.0',
			} ) );

		}
		assert.equal(
			first.members.some( ( member ) => existsSync( join( artifactsDir, member.file ) ) ),
			false,
			'the manifest commit makes the merged generation authoritative before pruning backend subsets',
		);

		const durablePaths = [
			manifestPath,
			...merged.members.map( ( member ) => join( artifactsDir, member.file ) ),
		];
		const beforeSubsetReplays = durableSnapshot( durablePaths );
		for ( const payload of payloads ) {

			const repeated = await writeAuxiliaryFamilyCapture( artifactsDir, manifestPath, payload );
			assert.equal( repeated.changed, false );
			assert.deepEqual( repeated.members, merged.members );

		}
		assert.deepEqual(
			durableSnapshot( durablePaths ),
			beforeSubsetReplays,
			'backend subset replays preserve the atomic family bytes, inodes, and mtimes',
		);

	} finally {

		rmSync( root, { recursive: true, force: true } );

	}

} );
