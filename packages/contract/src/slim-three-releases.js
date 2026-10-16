/** Inert verified release identities shared with browser artifact hashing. */
export const THREE_RELEASE_PROFILES = Object.freeze( {
	stable: Object.freeze( {
		id: 'r186', channel: 'stable', packageVersion: '0.186.1', revision: '186',
		gitCommit: '9b4a2ac29c63ccb43fd51c5661f2f873ac2c39b8',
		gitTree: '7cab867503666feb234d7f3427b0856957afad8b', objectFormat: 'sha1', ref: 'r186',
		sourceFingerprint: 'de21c6b6657d68e7c3a49ef2c354afe58ed918e15aad1c8337069991d998febd',
	} ),
	// Three dev ec2b7458ea ("InspectorBase: fix renderer types in JSDoc", 2026-10-15), installed as
	// the vendored tarball three-0.187.0-dev.ec2b745.tgz. Its src/ matches the Git tree byte for byte;
	// build/ was rebuilt from that source (`npm run build`), since the commit's checked-in build/ is
	// stale. package.json carries the distinguishing prerelease version (upstream says 0.186.0).
	development: Object.freeze( {
		id: 'r187dev', channel: 'development', packageVersion: '0.187.0-dev.ec2b745', revision: '187dev',
		gitCommit: 'ec2b7458eae7bf3718b10a4d7b867fb746a2b70a',
		gitTree: '25693678f256a49dc3e1fdebf4a139845680ff3f', objectFormat: 'sha1', ref: 'dev',
		sourceFingerprint: '190ce7b953264fcbaf83099d5b081de21092d4a766adbbbc0046bb5025870a00',
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

