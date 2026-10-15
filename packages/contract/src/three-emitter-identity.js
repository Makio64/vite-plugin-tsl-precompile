import { resolveSlimThreeRelease } from './slim-three-releases.js';

/** Legacy hash calls omit axes; configured emitters must pass their verified pair. */
export function createThreeEmitterHashFields( options = {} ) {

	const { threeVersion, threeRevision, threeCommit } = options;
	if ( threeRevision === undefined && threeCommit === undefined ) return {};
	const release = resolveSlimThreeRelease( { packageVersion: threeVersion, revision: threeRevision, sourceCommit: threeCommit } );
	if ( ! release || ! threeRevision || ! threeCommit ) throw new Error( 'Unknown or incomplete Three emitter revision/commit. Use a verified release and recapture artifacts.' );
	return release.channel === 'development' ? { threeRevision, threeCommit } : {};

}

export function createThreeEmitterSourceFields( options ) {

	const identity = createThreeEmitterHashFields( options );
	return identity.threeRevision ? { sourceThreeRevision: identity.threeRevision, sourceThreeCommit: identity.threeCommit } : {};

}

export function assertArtifactThreeEmitterIdentity( artifact, expectedOptions, label = 'Artifact' ) {

	const expected = createThreeEmitterSourceFields( expectedOptions );
	for ( const [ field, value ] of Object.entries( expected ) ) {

		if ( artifact?.[ field ] !== value ) throw new Error( `${ label } is missing or mismatches ${ field } for the verified development emitter. Recapture it with pinned r187dev before building.` );

	}
	createThreeEmitterHashFields( { threeVersion: artifact?.sourceThreeVersion, threeRevision: artifact?.sourceThreeRevision, threeCommit: artifact?.sourceThreeCommit } );

}

export function threeEmitterIdentityHashLines( options ) {

	return Object.entries( createThreeEmitterHashFields( options ) ).map( ( [ field, value ] ) => `${ field }=${ JSON.stringify( value ) }` );

}
