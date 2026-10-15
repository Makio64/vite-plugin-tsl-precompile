import { PLUGIN_VERSION } from './_shared/constants.js';
import { assertArtifactContentIntegrity } from './artifact-content-integrity.js';
import { assertArtifactThreeEmitterIdentity, createThreeEmitterHashFields } from '@tsl-precompile/contract/three-emitter-identity';

export function assertCapturedArtifactCompatibility( name, entry, expectedEmitter ) {

	const currentThreeVersion = expectedEmitter.threeVersion;
	const nested = entry && entry.artifact && typeof entry.artifact === 'object' ? entry.artifact : null;
	const metadata = nested && [ 'sourceGraphHash', 'sourceHashVersion', 'sourceThreeVersion', 'renderContextSignature' ]
		.some( ( key ) => nested[ key ] !== undefined ) ? nested : entry;
	const hasSourceMetadata = metadata && [ 'sourceGraphHash', 'sourceHashVersion', 'sourceThreeVersion', 'renderContextSignature' ]
		.some( ( key ) => metadata[ key ] !== undefined );
	if ( ! hasSourceMetadata ) {

		throw new Error( `[tsl-precompile] artifact ${ JSON.stringify( name ) } is unsigned or missing source-hash provenance. Recapture it with the current plugin.` );

	}

	if ( typeof metadata.sourceGraphHash !== 'string' || ! /^[a-f0-9]{64}$/i.test( metadata.sourceGraphHash ) ) {

		throw new Error( `[tsl-precompile] artifact ${ JSON.stringify( name ) } has incomplete source-hash metadata. Recapture it with the current plugin.` );

	}
	if ( metadata.sourceHashVersion !== PLUGIN_VERSION ) {

		throw new Error( `[tsl-precompile] artifact ${ JSON.stringify( name ) } uses source-hash/toolchain version ${ metadata.sourceHashVersion || '<missing>' }, but this build requires ${ PLUGIN_VERSION }. Recapture it.` );

	}
	if ( typeof metadata.sourceThreeVersion !== 'string' || metadata.sourceThreeVersion.length === 0 ) {

		throw new Error( `[tsl-precompile] artifact ${ JSON.stringify( name ) } is missing sourceThreeVersion. Recapture it with the current plugin.` );

	}
	if ( currentThreeVersion && metadata.sourceThreeVersion !== currentThreeVersion ) {

		throw new Error( `[tsl-precompile] artifact ${ JSON.stringify( name ) } was captured with three ${ metadata.sourceThreeVersion }, but this build resolves three ${ currentThreeVersion }. Recapture it before building.` );

	}
	assertArtifactThreeEmitterIdentity( metadata, expectedEmitter, `Artifact ${ JSON.stringify( name ) }` );
	if ( nested ) assertArtifactContentIntegrity( nested, entry.__hash, {
		label: `[tsl-precompile] artifact ${ JSON.stringify( name ) }`,
		...expectedEmitter,
		shape: `material:${ name }`,
		threeVersion: metadata.sourceThreeVersion,
		pluginVersion: metadata.sourceHashVersion,
		required: true,
	} );

}

export function assertCapturedAuxiliaryCompatibility( key, entry, expectedEmitter ) {

	const currentThreeVersion = expectedEmitter.threeVersion;
	const artifact = entry && entry.artifact && typeof entry.artifact === 'object' ? entry.artifact : null;
	if ( typeof entry.threeVersion !== 'string' || entry.threeVersion.length === 0 ||
		typeof entry.pluginVersion !== 'string' || entry.pluginVersion.length === 0 ) {

		throw new Error( `[tsl-precompile] auxiliary artifact ${ JSON.stringify( key ) } is missing exact Three/toolchain provenance. Run dev mode to recapture it before building.` );

	}
	if ( entry.pluginVersion !== PLUGIN_VERSION ) {

		throw new Error( `[tsl-precompile] auxiliary artifact ${ JSON.stringify( key ) } uses toolchain ${ entry.pluginVersion }, but this build requires ${ PLUGIN_VERSION }. Recapture it.` );

	}
	if ( currentThreeVersion && entry.threeVersion !== currentThreeVersion ) {

		throw new Error( `[tsl-precompile] auxiliary artifact ${ JSON.stringify( key ) } was captured with three ${ entry.threeVersion }, but this build resolves three ${ currentThreeVersion }. Recapture it before building.` );

	}
	if ( ! artifact || artifact.sourceThreeVersion !== entry.threeVersion ) {

		throw new Error( `[tsl-precompile] auxiliary artifact ${ JSON.stringify( key ) } has conflicting envelope and artifact Three provenance. Recapture it.` );

	}
	if ( ! artifact || artifact.sourceHashVersion !== entry.pluginVersion ) {

		throw new Error( `[tsl-precompile] auxiliary artifact ${ JSON.stringify( key ) } has conflicting envelope and artifact toolchain provenance. Recapture it.` );

	}
	assertArtifactThreeEmitterIdentity( artifact, expectedEmitter, `Auxiliary artifact ${ JSON.stringify( key ) }` );
	for ( const [ field, value ] of Object.entries( createThreeEmitterHashFields( expectedEmitter ) ) ) {

		if ( entry[ field ] !== value ) throw new Error( `Auxiliary artifact ${ JSON.stringify( key ) } has missing or conflicting ${ field }. Recapture it.` );

	}
	assertArtifactContentIntegrity( artifact, entry.__hash, {
		...expectedEmitter,
		label: `[tsl-precompile] auxiliary artifact ${ JSON.stringify( key ) }`,
		shape: entry.__materialShape,
		threeVersion: entry.threeVersion,
		pluginVersion: entry.pluginVersion,
		required: true,
	} );

}

