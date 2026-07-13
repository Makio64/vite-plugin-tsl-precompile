/**
 * Fail-closed startup verification for `slim: true` production builds.
 *
 * The browser runtime never imports this module. It resolves the installed
 * prebuilt bundle and recomputes the same Node-only source fingerprint used by
 * the Rollup producer before Vite is allowed to apply the slim alias.
 */

import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	SLIM_BUNDLE_METADATA_FILE_NAME,
	SLIM_BUNDLE_PROVENANCE_ERROR_CODES,
	SlimBundleProvenanceError,
	computeSlimBundleSourceFingerprint,
	createSlimBundleSourceInputs,
	createSlimBundleVersionIdentity,
	verifySlimBundleProvenance,
} from '@tsl-precompile/contract/slim-bundle-provenance-node';
import {
	SLIM_THREE_POLICY_VERSION,
	SLIM_THREE_RUNTIME_ENTRIES,
} from '@tsl-precompile/contract/slim-three-policy';
import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';

const PLUGIN_PACKAGE_ROOT = dirname( dirname( fileURLToPath( import.meta.url ) ) );

export async function verifySlimPrebuiltBundle( { root, threeInstallation } ) {

	let installation;
	try {

		installation = await resolveSlimPrebuiltInstallation( root );

	} catch ( error ) {

		throw wrapSlimBuildRefusal( error );

	}

	let bundleSource;
	let metadataSource;
	try {

		bundleSource = await readRequiredFile( installation.bundleFile, 'prebuilt slim bundle' );
		metadataSource = await readRequiredFile( installation.metadataFile, 'prebuilt slim provenance sidecar' );

	} catch ( error ) {

		throw wrapSlimBuildRefusal( error, installation );

	}

	try {

		const versions = createSlimBundleVersionIdentity( {
			threeVersion: threeInstallation.version,
			policyVersion: SLIM_THREE_POLICY_VERSION,
			artifactToolchainVersion: ARTIFACT_TOOLCHAIN_VERSION,
		} );
		const inputs = createSlimBundleSourceInputs( {
			threePackageRoot: threeInstallation.packageRoot,
			runtimePackageRoot: installation.runtimePackageRoot,
			contractPackageRoot: installation.contractPackageRoot,
			pluginPackageRoot: PLUGIN_PACKAGE_ROOT,
		} );
		const expectedSource = await computeSlimBundleSourceFingerprint( inputs, versions );
		return verifySlimBundleProvenance( {
			bundleSource,
			metadata: metadataSource,
			expectedSource,
			expectedVersions: versions,
		} );

	} catch ( error ) {

		throw wrapSlimBuildRefusal( error, installation );

	}

}

export async function resolveSlimPrebuiltInstallation( root ) {

	const attempted = [];
	const resolvers = [
		{ consumer: true, requireFrom: createRequire( resolve( root, 'package.json' ) ) },
		{ consumer: false, requireFrom: createRequire( import.meta.url ) },
	];
	for ( const { consumer, requireFrom } of resolvers ) {

		let bundleFile;
		try {

			bundleFile = requireFrom.resolve( SLIM_THREE_RUNTIME_ENTRIES.PREBUILT );

		} catch ( error ) {

			attempted.push( error && error.message ? error.message : String( error ) );
			// Do not silently verify a fallback workspace copy when the consumer
			// has installed @tsl-precompile/runtime but its exported slim file is
			// absent. The alias would still resolve to that broken consumer copy.
			if ( consumer ) {

				const installedRuntimePackage = await findConsumerRuntimePackage( root, requireFrom );
				if ( installedRuntimePackage ) {

					throw new SlimBundleProvenanceError(
						SLIM_BUNDLE_PROVENANCE_ERROR_CODES.INPUT_MISSING,
						`the consumer runtime at ${ dirname( installedRuntimePackage ) } is installed, but its ${ JSON.stringify( SLIM_THREE_RUNTIME_ENTRIES.PREBUILT ) } export could not resolve the prebuilt bundle`,
						{ cause: error },
					);

				}

			}
			continue;

		}

		const runtimePackageFile = await findPackageJson( dirname( bundleFile ), '@tsl-precompile/runtime' );
		if ( ! runtimePackageFile ) {

			attempted.push( `resolved ${ bundleFile }, but could not locate its @tsl-precompile/runtime package.json` );
			continue;

		}

		let contractEntry;
		try {

			contractEntry = createRequire( runtimePackageFile ).resolve( '@tsl-precompile/contract/slim-bundle-provenance-node' );

		} catch ( cause ) {

			throw new SlimBundleProvenanceError(
				SLIM_BUNDLE_PROVENANCE_ERROR_CODES.INPUT_MISSING,
				`the runtime at ${ dirname( runtimePackageFile ) } cannot resolve its matching @tsl-precompile/contract provenance helper`,
				{ cause },
			);

		}

		const contractPackageFile = await findPackageJson( dirname( contractEntry ), '@tsl-precompile/contract' );
		if ( ! contractPackageFile ) {

			throw new SlimBundleProvenanceError(
				SLIM_BUNDLE_PROVENANCE_ERROR_CODES.INPUT_MISSING,
				`the runtime provenance helper at ${ contractEntry } is not inside a resolvable @tsl-precompile/contract package`,
			);

		}

		return {
			bundleFile,
			metadataFile: join( dirname( bundleFile ), SLIM_BUNDLE_METADATA_FILE_NAME ),
			runtimePackageRoot: dirname( runtimePackageFile ),
			contractPackageRoot: dirname( contractPackageFile ),
		};

	}

	throw new SlimBundleProvenanceError(
		SLIM_BUNDLE_PROVENANCE_ERROR_CODES.INPUT_MISSING,
		`could not resolve ${ JSON.stringify( SLIM_THREE_RUNTIME_ENTRIES.PREBUILT ) } from ${ root }. Install a matching @tsl-precompile/runtime release. Resolver details: ${ attempted.join( ' | ' ) }`,
	);

}

async function findConsumerRuntimePackage( root, requireFrom ) {

	const direct = join( root, 'node_modules/@tsl-precompile/runtime/package.json' );
	try {

		const pkg = JSON.parse( await readFile( direct, 'utf8' ) );
		if ( pkg && pkg.name === '@tsl-precompile/runtime' ) return direct;

	} catch ( _ ) {}

	try {

		const entry = requireFrom.resolve( '@tsl-precompile/runtime' );
		return findPackageJson( dirname( entry ), '@tsl-precompile/runtime' );

	} catch ( _ ) {

		return null;

	}

}

async function readRequiredFile( file, label ) {

	try {

		return await readFile( file );

	} catch ( cause ) {

		throw new SlimBundleProvenanceError(
			SLIM_BUNDLE_PROVENANCE_ERROR_CODES.INPUT_MISSING,
			`the ${ label } is missing or unreadable at ${ file }`,
			{ cause },
		);

	}

}

async function findPackageJson( startDir, expectedName ) {

	let current = startDir;
	while ( true ) {

		const file = join( current, 'package.json' );
		try {

			const pkg = JSON.parse( await readFile( file, 'utf8' ) );
			if ( pkg && pkg.name === expectedName ) return file;

		} catch ( _ ) {}
		const parent = dirname( current );
		if ( parent === current ) return null;
		current = parent;

	}

}

function wrapSlimBuildRefusal( error, installation = null ) {

	if ( error && typeof error.message === 'string' && error.message.startsWith( '[tsl-precompile] slim build refused:' ) ) return error;

	const code = error && error.code;
	let reason = 'prebuilt slim provenance could not be verified';
	if ( code === SLIM_BUNDLE_PROVENANCE_ERROR_CODES.INPUT_MISSING || code === SLIM_BUNDLE_PROVENANCE_ERROR_CODES.STAMP_MISSING ) {

		reason = 'required prebuilt slim provenance is missing';

	} else if ( code === SLIM_BUNDLE_PROVENANCE_ERROR_CODES.INTEGRITY_MISMATCH ) {

		reason = 'the prebuilt slim bundle integrity does not match its sidecar';

	} else if ( code === SLIM_BUNDLE_PROVENANCE_ERROR_CODES.SOURCE_STALE ) {

		reason = 'the prebuilt slim bundle is stale for the installed source inputs';

	} else if ( code === SLIM_BUNDLE_PROVENANCE_ERROR_CODES.VERSION_MISMATCH ) {

		reason = 'the prebuilt slim bundle targets a different Three, policy, or toolchain version';

	} else if ( code === SLIM_BUNDLE_PROVENANCE_ERROR_CODES.METADATA_INVALID ) {

		reason = 'the prebuilt slim provenance stamp or sidecar is malformed';

	}

	const location = installation ? ` Bundle: ${ installation.bundleFile }; sidecar: ${ installation.metadataFile }.` : '';
	const detail = error && error.message ? ` ${ error.message }` : '';
	const wrapped = new Error(
		`[tsl-precompile] slim build refused: ${ reason }.${ detail }${ location } Rebuild and publish @tsl-precompile/runtime from the same checked sources before enabling \`slim: true\`.`,
		{ cause: error },
	);
	if ( code ) wrapped.code = code;
	return wrapped;

}
