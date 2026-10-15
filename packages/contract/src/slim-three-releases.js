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
		gitCommit: '3995acf2a9e79ebd2b02c0e9e7f820fa2a4838fb',
		gitTree: 'f6a8206015c51a009c513347b58bf33bda1162b8', objectFormat: 'sha1', ref: 'dev',
		sourceFingerprint: '7758cd592878ed109af20edddd2fcf3bac45e36756a8ba041e77180a9a9fd3c5',
	} ),
} );

export function resolveSlimThreeRelease( { packageVersion, revision, sourceCommit } = {} ) {

	const stable = THREE_RELEASE_PROFILES.stable;
	if ( packageVersion === stable.packageVersion && ( revision === undefined || revision === stable.revision ) &&
		( sourceCommit === undefined || sourceCommit === stable.gitCommit ) ) return stable;
	const development = THREE_RELEASE_PROFILES.development;
	if ( packageVersion === development.packageVersion && revision === development.revision &&
		sourceCommit === development.gitCommit ) return development;
	return null;

}

