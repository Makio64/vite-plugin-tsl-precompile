import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { getInternalPassStageDefinition } from '@tsl-precompile/contract/internal-pass';
import {
	createPMREMLayoutConfig,
	createPMREMSupportConfig,
	pmremSourceInputTopology,
} from '@tsl-precompile/contract/pmrem-config';
import {
	createVSMSupportConfig,
	vsmMomentsTopology,
	vsmSourceInputTopology,
} from '@tsl-precompile/contract/vsm-config';
import { loadArtifactDirectory } from '../../src/artifact-directory-loader.js';

async function withArtifactDirectory( run ) {

	const root = await mkdtemp( join( tmpdir(), 'tslp-artifact-loader-' ) );
	const artifactsDir = join( root, 'artifacts' );
	await mkdir( artifactsDir );
	try {

		await run( artifactsDir );

	} finally {

		await rm( root, { recursive: true, force: true } );

	}

}

async function writeJson( directory, filename, value ) {

	await writeFile( join( directory, filename ), JSON.stringify( value ) );

}

function pmremSourceTexture( profile ) {

	const cubemap = profile === 'texture-cubemap';
	return {
		isTexture: true,
		isCubeTexture: cubemap,
		mapping: cubemap ? 301 : 303,
		format: 1023,
		internalFormat: null,
		type: 1016,
		colorSpace: 'srgb-linear',
		compareFunction: null,
		channel: 0,
		isRenderTargetTexture: false,
		isFramebufferTexture: false,
		isDepthTexture: false,
	};

}

function internalPassArtifact( family, stage, opts = {} ) {

	const definition = getInternalPassStageDefinition( family, stage );
	const replayConfig = family === 'pmrem' ? createPMREMLayoutConfig( 32 ) : null;
	const profile = opts.profile || ( stage === 'cubemap'
		? 'texture-cubemap'
		: stage === 'equirect'
			? 'texture-equirect'
			: 'scene' );
	const config = family === 'pmrem'
		? createPMREMSupportConfig(
			replayConfig,
			profile,
			profile === 'scene' ? null : pmremSourceTexture( profile ),
		)
		: createVSMSupportConfig();
	const uniforms = ( definition.requiredUniforms || [] ).map( ( role, index ) => ( {
		role,
		group: 'object',
		binding: `uniform${ index }`,
		valueType: role === 'pole-axis' ? 'vec3' : role === 'map-size' ? 'vec2' : 'float',
	} ) );
	const inputs = Object.entries( definition.requiredInputs || {} ).map( ( [ role, kind ], index ) => ( {
		role,
		kind,
		group: 'object',
		binding: `${ kind }${ index }`,
		topology: kind === 'texture'
			? role === 'source'
				? pmremSourceInputTopology( config.source )
				: family === 'pmrem'
					? { dimension: '2d', format: 1023, type: 1016 }
					: role === 'vsm-vertical'
						? vsmMomentsTopology( config )
						: vsmSourceInputTopology( config )
			: { arrayType: 'Float32Array', byteLength: 16 },
	} ) );
	return {
		materialShape: definition.shape,
		vertexShader: `${ stage } vertex`,
		fragmentShader: `${ stage } fragment`,
		...( replayConfig ? { replayConfig } : {} ),
		internalPass: {
			schema: 'internal-pass@1',
			family,
			stage,
			shape: definition.shape,
			config,
			uniforms,
			inputs,
			output: {
				topology: family === 'shadow-vsm'
					? vsmMomentsTopology( config )
					: { dimension: '2d', format: 1023, type: 1016, depth: false },
			},
		},
		uniformPlan: [ {
			name: 'object',
			slots: uniforms.map( ( uniform ) => ( {
				name: uniform.binding,
				source: {
					kind: definition.uniformSourceKinds?.[ uniform.role ] || 'uniform.live',
				},
			} ) ),
			textures: inputs
				.filter( ( input ) => input.kind === 'texture' )
				.map( ( input ) => ( {
					name: input.binding,
					source: {
						kind: 'artifact.texture',
						textureUuid: `captured-${ stage }-${ input.role }`,
					},
				} ) ),
			orderedBindings: inputs
				.filter( ( input ) => input.kind === 'buffer' )
				.map( ( input ) => ( {
					type: 'buffer-uniform',
					ref: {
						name: input.binding,
						byteLength: input.topology.byteLength,
					},
				} ) ),
		} ],
	};

}

async function writeInternalPassFamily( artifactsDir, stages, opts = {} ) {

	const family = opts.family || 'pmrem';
	const profile = opts.profile || ( stages.includes( 'cubemap' )
		? 'texture-cubemap'
		: stages.includes( 'equirect' )
			? 'texture-equirect'
			: 'scene' );
	const configHash = opts.configHash || `${ family }-support-hash`;
	const aux = {};
	for ( const stage of stages ) {

		const artifact = internalPassArtifact( family, stage, { profile } );
		const shape = artifact.materialShape;
		const filename = `${ shape }.json`;
		await writeJson( artifactsDir, filename, {
			__name: `aux-${ shape }`,
			__materialShape: shape,
			__configHash: configHash,
			__hash: `${ shape }-hash`,
			artifact,
		} );
		aux[ `${ shape }:${ configHash }` ] = {
			file: filename,
			shape,
			configHash,
			hash: `${ shape }-hash`,
		};

	}
	for ( const shape of opts.extraAuxiliaryShapes || [] ) {

		const filename = `${ shape }.json`;
		await writeJson( artifactsDir, filename, {
			__name: `aux-${ shape }`,
			__materialShape: shape,
			__configHash: configHash,
			__hash: `${ shape }-hash`,
			artifact: {},
		} );
		aux[ `${ shape }:${ configHash }` ] = {
			file: filename,
			shape,
			configHash,
			hash: `${ shape }-hash`,
		};

	}
	await writeJson( artifactsDir, 'manifest.json', { __aux: aux } );

}

test( 'artifact directory loader treats manifest.json as authoritative', async () => {

	await withArtifactDirectory( async ( artifactsDir ) => {

		await writeJson( artifactsDir, 'kept.json', {
			__name: 'kept',
			__hash: 'kept-hash',
			artifact: {},
		} );
		await writeJson( artifactsDir, 'unreferenced-newer.json', {
			__name: 'unreferenced',
			__hash: 'unreferenced-hash',
			artifact: {},
		} );
		await writeJson( artifactsDir, 'aux-background.json', {
			__name: 'aux-background',
			__materialShape: 'background',
			__configHash: 'config-hash',
			__hash: 'config-hash',
			artifact: {},
		} );
		await writeJson( artifactsDir, 'manifest.json', {
			kept: { file: 'kept.json', hash: 'kept-hash' },
			__aux: {
				'background:config-hash': {
					file: 'aux-background.json',
					shape: 'background',
					configHash: 'config-hash',
					hash: null,
				},
			},
		} );

		const loaded = await loadArtifactDirectory( artifactsDir );
		assert.equal( loaded.authoritative, true );
		assert.deepEqual( Object.keys( loaded.manifest ), [ 'kept' ] );
		assert.equal( loaded.manifest.kept.file, 'kept.json' );
		assert.deepEqual( Object.keys( loaded.auxManifest ), [ 'background:config-hash' ] );
		assert.equal( loaded.auxManifest[ 'background:config-hash' ].file, 'aux-background.json' );

	} );

} );

test( 'artifact directory loader keeps the old manifest authoritative while a replacement file appears', async () => {

	await withArtifactDirectory( async ( artifactsDir ) => {

		for ( const file of [ 'current.json', 'stale.json' ] ) {

			await writeJson( artifactsDir, file, {
				__name: 'same-name',
				__hash: file === 'current.json' ? 'current-hash' : 'stale-hash',
				artifact: {},
			} );

		}
		await writeJson( artifactsDir, 'manifest.json', {
			'same-name': { file: 'current.json', hash: 'current-hash' },
		} );

		const loaded = await loadArtifactDirectory( artifactsDir );
		assert.equal( loaded.authoritative, true );
		assert.equal( loaded.manifest[ 'same-name' ].file, 'current.json' );
		assert.equal( loaded.manifest[ 'same-name' ].hash, 'current-hash' );
		await assert.rejects(
			loadArtifactDirectory( artifactsDir, { rejectUnreferencedDuplicates: true } ),
			/duplicate artifact identity "same-name".*"current\.json".*"stale\.json"/,
		);

	} );

} );

test( 'artifact directory loader can reject every orphan after a capture transaction settles', async () => {

	await withArtifactDirectory( async ( artifactsDir ) => {

		await writeJson( artifactsDir, 'kept.json', {
			__name: 'kept',
			__hash: 'kept-hash',
			artifact: {},
		} );
		await writeJson( artifactsDir, 'orphan.json', {
			__name: 'different-name',
			__hash: 'orphan-hash',
			artifact: {},
		} );
		await writeJson( artifactsDir, 'manifest.json', {
			kept: { file: 'kept.json', hash: 'kept-hash' },
		} );

		await assert.rejects(
			loadArtifactDirectory( artifactsDir, { rejectUnreferencedArtifacts: true } ),
			/unreferenced artifact file "orphan\.json" is not part of the authoritative manifest/,
		);

	} );

} );

test( 'artifact directory loader rejects duplicate identities in legacy scan mode', async () => {

	await withArtifactDirectory( async ( artifactsDir ) => {

		await writeJson( artifactsDir, 'first.json', {
			__name: 'duplicate',
			__hash: 'first',
			artifact: {},
		} );
		await writeJson( artifactsDir, 'second.json', {
			__name: 'duplicate',
			__hash: 'second',
			artifact: {},
		} );

		await assert.rejects(
			loadArtifactDirectory( artifactsDir ),
			/duplicate artifact identity "duplicate".*"first\.json".*"second\.json"/,
		);

	} );

} );

test( 'artifact directory loader validates profile-specific PMREM families atomically', async () => {

	await withArtifactDirectory( async ( artifactsDir ) => {

		await writeInternalPassFamily( artifactsDir, [ 'equirect' ], {
			profile: 'texture-equirect',
			configHash: 'pmrem-equirect-support-hash',
		} );
		await assert.rejects(
			loadArtifactDirectory( artifactsDir ),
			/internal-pass family "pmrem:pmrem-equirect-support-hash".*missing expected stage "ggx"/,
		);
		const devSnapshot = await loadArtifactDirectory( artifactsDir, {
			allowIncompleteInternalPassFamilies: true,
		} );
		assert.deepEqual(
			Object.values( devSnapshot.auxManifest ).map( ( entry ) => entry.shape ).sort(),
			[ 'pmrem-equirect' ],
		);

		await writeInternalPassFamily( artifactsDir, [ 'equirect', 'ggx' ], {
			profile: 'texture-equirect',
			configHash: 'pmrem-equirect-support-hash',
		} );
		const equirectSnapshot = await loadArtifactDirectory( artifactsDir );
		assert.deepEqual(
			Object.values( equirectSnapshot.auxManifest ).map( ( entry ) => entry.shape ).sort(),
			[ 'pmrem-equirect', 'pmrem-ggx' ],
		);

		await writeInternalPassFamily( artifactsDir, [ 'cubemap', 'ggx' ], {
			profile: 'texture-cubemap',
			configHash: 'pmrem-cubemap-support-hash',
		} );
		const cubemapSnapshot = await loadArtifactDirectory( artifactsDir );
		assert.deepEqual(
			Object.values( cubemapSnapshot.auxManifest ).map( ( entry ) => entry.shape ).sort(),
			[ 'pmrem-cubemap', 'pmrem-ggx' ],
		);

		await writeInternalPassFamily( artifactsDir, [ 'blur', 'ggx' ], {
			profile: 'scene',
			configHash: 'pmrem-scene-support-hash',
		} );
		const sceneSnapshot = await loadArtifactDirectory( artifactsDir );
		assert.deepEqual(
			Object.values( sceneSnapshot.auxManifest ).map( ( entry ) => entry.shape ).sort(),
			[ 'pmrem-blur', 'pmrem-ggx' ],
		);

		await writeInternalPassFamily( artifactsDir, [ 'equirect', 'blur', 'ggx' ], {
			profile: 'texture-equirect',
			configHash: 'pmrem-mixed-support-hash',
		} );
		await assert.rejects(
			loadArtifactDirectory( artifactsDir ),
			/PMREM stage "blur" is not valid for profile "texture-equirect"/,
		);

	} );

} );

test( 'artifact directory loader requires descriptors and external depth support for internal passes', async () => {

	await withArtifactDirectory( async ( artifactsDir ) => {

		await writeInternalPassFamily( artifactsDir, [], {
			extraAuxiliaryShapes: [ 'pmrem-ggx' ],
		} );
		await assert.rejects(
			loadArtifactDirectory( artifactsDir ),
			/auxiliary shape "pmrem-ggx" must carry an internalPass descriptor/,
		);

		await writeInternalPassFamily( artifactsDir, [ 'vertical', 'horizontal' ], {
			family: 'shadow-vsm',
		} );
		await assert.rejects(
			loadArtifactDirectory( artifactsDir ),
			/missing required auxiliary support: shadow-depth/,
		);

		await writeInternalPassFamily( artifactsDir, [ 'vertical', 'horizontal' ], {
			family: 'shadow-vsm',
			extraAuxiliaryShapes: [ 'shadow-depth' ],
		} );
		const complete = await loadArtifactDirectory( artifactsDir );
		assert.deepEqual(
			Object.values( complete.auxManifest ).map( ( entry ) => entry.shape ).sort(),
			[ 'shadow-depth', 'shadow-vsm-horizontal', 'shadow-vsm-vertical' ],
		);

	} );

} );

test( 'artifact directory loader validates manifest filename, envelope identity, and hash', async () => {

	await withArtifactDirectory( async ( artifactsDir ) => {

		await writeJson( artifactsDir, 'capture.json', {
			__name: 'actual-name',
			__hash: 'actual-hash',
			artifact: {},
		} );

		await writeJson( artifactsDir, 'manifest.json', {
			expected: { file: '../capture.json', hash: 'actual-hash' },
		} );
		await assert.rejects(
			loadArtifactDirectory( artifactsDir, {
				manifestConsistencyRetries: 3,
				manifestConsistencyRetryDelayMs: 0,
			} ),
			( error ) => {

				assert.match( error.message, /unsafe artifact filename/ );
				assert.equal( error.code, undefined, 'permanent validation failures must not be retried' );
				return true;

			},
		);

		await writeJson( artifactsDir, 'manifest.json', {
			expected: { file: 'capture.json', hash: 'actual-hash' },
		} );
		await assert.rejects( loadArtifactDirectory( artifactsDir ), /whose __name is "actual-name"/ );

		await writeJson( artifactsDir, 'manifest.json', {
			'actual-name': { file: 'capture.json', hash: 'wrong-hash' },
		} );
		await assert.rejects( loadArtifactDirectory( artifactsDir ), /does not match envelope __hash/ );

	} );

} );

test( 'artifact directory loader rejects artifact symlinks that resolve outside the directory', async () => {

	await withArtifactDirectory( async ( artifactsDir ) => {

		const outside = join( dirname( artifactsDir ), 'outside.json' );
		await writeJson( dirname( artifactsDir ), 'outside.json', {
			__name: 'outside',
			__hash: 'outside-hash',
			artifact: {},
		} );
		await symlink( outside, join( artifactsDir, 'linked.json' ) );
		await writeJson( artifactsDir, 'manifest.json', {
			outside: { file: 'linked.json', hash: 'outside-hash' },
		} );
		await assert.rejects( loadArtifactDirectory( artifactsDir ), /resolves outside the artifact directory/ );

		await rm( join( artifactsDir, 'manifest.json' ) );
		await assert.rejects( loadArtifactDirectory( artifactsDir ), /resolves outside the artifact directory/ );

	} );

} );

test( 'artifact directory loader retries transient dev manifest/envelope hash skew', async () => {

	await withArtifactDirectory( async ( artifactsDir ) => {

		const key = 'background:config-hash';
		await writeJson( artifactsDir, 'aux-background.json', {
			__name: 'aux-background',
			__materialShape: 'background',
			__configHash: 'config-hash',
			__hash: 'new-hash',
			artifact: {},
		} );
		const staleManifest = {
			__aux: {
				[ key ]: {
					file: 'aux-background.json',
					shape: 'background',
					configHash: 'config-hash',
					hash: 'old-hash',
				},
			},
		};
		await writeJson( artifactsDir, 'manifest.json', staleManifest );

		await assert.rejects(
			loadArtifactDirectory( artifactsDir ),
			( error ) => {

				assert.match( error.message, /hash "old-hash" does not match envelope __hash "new-hash"/ );
				assert.equal( error.code, 'TSLP_ARTIFACT_MANIFEST_INCONSISTENT' );
				return true;

			},
			'default production/verification load must remain fail-closed',
		);

		const publishManifest = new Promise( ( resolvePublish, rejectPublish ) => {

			setTimeout( () => {

				writeJson( artifactsDir, 'manifest.json', {
					__aux: {
						[ key ]: {
							...staleManifest.__aux[ key ],
							hash: 'new-hash',
						},
					},
				} ).then( resolvePublish, rejectPublish );

			}, 5 );

		} );
		const loaded = await loadArtifactDirectory( artifactsDir, {
			manifestConsistencyRetries: 3,
			manifestConsistencyRetryDelayMs: 10,
		} );
		await publishManifest;
		assert.equal( loaded.auxManifest[ key ].hash, 'new-hash' );

	} );

} );

test( 'artifact directory loader retries a stale manifest whose old user file was pruned', async () => {

	await withArtifactDirectory( async ( artifactsDir ) => {

		await writeJson( artifactsDir, 'replacement.json', {
			__name: 'material',
			__hash: 'replacement-hash',
			artifact: {},
		} );
		await writeJson( artifactsDir, 'manifest.json', {
			material: { file: 'pruned.json', hash: 'pruned-hash' },
		} );

		await assert.rejects(
			loadArtifactDirectory( artifactsDir ),
			/references unreadable file "pruned\.json"/,
		);

		const publishManifest = new Promise( ( resolvePublish, rejectPublish ) => {

			setTimeout( () => {

				writeJson( artifactsDir, 'manifest.json', {
					material: { file: 'replacement.json', hash: 'replacement-hash' },
				} ).then( resolvePublish, rejectPublish );

			}, 5 );

		} );
		const loaded = await loadArtifactDirectory( artifactsDir, {
			manifestConsistencyRetries: 3,
			manifestConsistencyRetryDelayMs: 10,
		} );
		await publishManifest;
		assert.equal( loaded.manifest.material.file, 'replacement.json' );
		assert.equal( loaded.manifest.material.hash, 'replacement-hash' );

	} );

} );

test( 'artifact directory loader rejects auxiliary manifest/envelope provenance drift', async () => {

	await withArtifactDirectory( async ( artifactsDir ) => {

		await writeJson( artifactsDir, 'aux-background.json', {
			__name: 'aux-background',
			__materialShape: 'background',
			__configHash: 'config-hash',
			__hash: 'config-hash',
			threeVersion: '0.185.1',
			pluginVersion: '0.1.0',
			artifact: {},
		} );
		await writeJson( artifactsDir, 'manifest.json', {
			__aux: {
				'background:config-hash': {
					file: 'aux-background.json',
					shape: 'background',
					configHash: 'config-hash',
					hash: null,
					threeVersion: '0.184.0',
					pluginVersion: '0.1.0',
				},
			},
		} );

		await assert.rejects(
			loadArtifactDirectory( artifactsDir ),
			/threeVersion "0\.184\.0" does not match envelope threeVersion "0\.185\.1"/,
		);

	} );

} );

test( 'artifact directory loader returns empty maps for a missing directory', async () => {

	const root = await mkdtemp( join( tmpdir(), 'tslp-artifact-loader-missing-' ) );
	try {

		const loaded = await loadArtifactDirectory( join( root, 'missing' ) );
		assert.equal( loaded.authoritative, false );
		assert.deepEqual( Object.keys( loaded.manifest ), [] );
		assert.deepEqual( Object.keys( loaded.auxManifest ), [] );

	} finally {

		await rm( root, { recursive: true, force: true } );

	}

} );
