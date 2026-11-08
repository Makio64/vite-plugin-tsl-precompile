/** Inert verified release identities shared with browser artifact hashing. */
export const THREE_RELEASE_PROFILES = Object.freeze( {
	stable: Object.freeze( {
		id: 'r186', channel: 'stable', packageVersion: '0.186.1', revision: '186',
		gitCommit: '9b4a2ac29c63ccb43fd51c5661f2f873ac2c39b8',
		gitTree: '7cab867503666feb234d7f3427b0856957afad8b', objectFormat: 'sha1', ref: 'r186',
		sourceFingerprint: 'de21c6b6657d68e7c3a49ef2c354afe58ed918e15aad1c8337069991d998febd',
	} ),
	development: Object.freeze( {
		id: 'r187dev', channel: 'development', packageVersion: '0.186.0', revision: '187dev',
		gitCommit: '797d7a777c28e0e1f5c6b0fa5fa84f8c9df84f9d',
		gitTree: 'b8376bc65513b2d1f97cc61306a082d8f1197ecd', objectFormat: 'sha1', ref: 'dev',
		sourceFingerprint: '1acd7adaf2dd17c7ca0d0716546a2c18c06a201e0b58d32f34bb9c0ecb7d093b',
	} ),
} );

const ADDITIONAL_VERIFIED_RELEASES = Object.freeze( [
	Object.freeze( {
		id: 'r187', channel: 'stable', packageVersion: '0.187.0', revision: '187',
		gitCommit: '456a78fd22f4ce11d929fd62c8579b83be06008a',
		gitTree: '49a187030c379a4721c011670b8f77a5783c452e', objectFormat: 'sha1', ref: 'r187',
		sourceFingerprint: '65f4e10f9824e29c7636363fe1423d7624b84f851c64afe759f61e702b506f62',
	} ),
	Object.freeze( {
		id: 'r187dev', channel: 'development', packageVersion: '0.187.0-dev.ec2b745', revision: '187dev',
		gitCommit: 'ec2b7458eae7bf3718b10a4d7b867fb746a2b70a',
		gitTree: '25693678f256a49dc3e1fdebf4a139845680ff3f', objectFormat: 'sha1', ref: 'dev',
		sourceFingerprint: '190ce7b953264fcbaf83099d5b081de21092d4a766adbbbc0046bb5025870a00',
	} ),
] );

export function resolveSlimThreeRelease( { packageVersion, revision, sourceCommit } = {} ) {

	for ( const profile of [ THREE_RELEASE_PROFILES.stable, THREE_RELEASE_PROFILES.development, ...ADDITIONAL_VERIFIED_RELEASES ] ) {

		if ( profile.channel === 'stable' ) {

			if ( packageVersion === profile.packageVersion && ( revision === undefined || revision === profile.revision ) &&
				( sourceCommit === undefined || sourceCommit === profile.gitCommit ) ) return profile;

		} else if ( ( packageVersion === profile.packageVersion || packageVersion === '0.186.0' ) &&
			revision === profile.revision && sourceCommit === profile.gitCommit ) {

			return packageVersion === profile.packageVersion ? profile : Object.freeze( { ...profile, packageVersion } );

		}

	}
	return null;

}

