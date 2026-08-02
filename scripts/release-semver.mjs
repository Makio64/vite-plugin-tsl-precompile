const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseReleaseSemver( version ) {

	if ( typeof version !== 'string' ) throw new Error( `invalid SemVer ${ JSON.stringify( version ) }` );
	const match = SEMVER_PATTERN.exec( version );
	if ( ! match ) throw new Error( `invalid SemVer ${ JSON.stringify( version ) }` );
	const prerelease = match[ 4 ] ? match[ 4 ].split( '.' ) : null;
	if (
		prerelease?.some(
			( identifier ) => /^\d+$/.test( identifier ) &&
				identifier.length > 1 &&
				identifier.startsWith( '0' )
		)
	) {

		throw new Error( `invalid SemVer ${ JSON.stringify( version ) }` );

	}
	return {
		version,
		core: match.slice( 1, 4 ),
		prerelease,
		build: match[ 5 ] ? match[ 5 ].split( '.' ) : null,
	};

}

function compareNumericIdentifier( left, right ) {

	if ( left.length !== right.length ) return left.length < right.length ? - 1 : 1;
	if ( left === right ) return 0;
	return left < right ? - 1 : 1;

}

export function compareReleaseSemver( leftVersion, rightVersion ) {

	const left = parseReleaseSemver( leftVersion );
	const right = parseReleaseSemver( rightVersion );
	for ( let index = 0; index < left.core.length; index ++ ) {

		if ( left.core[ index ] !== right.core[ index ] ) {

			return compareNumericIdentifier( left.core[ index ], right.core[ index ] );

		}

	}
	if ( left.prerelease === null || right.prerelease === null ) {

		if ( left.prerelease === right.prerelease ) return 0;
		return left.prerelease === null ? 1 : - 1;

	}
	const count = Math.max( left.prerelease.length, right.prerelease.length );
	for ( let index = 0; index < count; index ++ ) {

		const leftIdentifier = left.prerelease[ index ];
		const rightIdentifier = right.prerelease[ index ];
		if ( leftIdentifier === undefined || rightIdentifier === undefined ) {

			if ( leftIdentifier === rightIdentifier ) return 0;
			return leftIdentifier === undefined ? - 1 : 1;

		}
		if ( leftIdentifier === rightIdentifier ) continue;
		const leftNumeric = /^(0|[1-9]\d*)$/.test( leftIdentifier );
		const rightNumeric = /^(0|[1-9]\d*)$/.test( rightIdentifier );
		if ( leftNumeric && rightNumeric ) return compareNumericIdentifier( leftIdentifier, rightIdentifier );
		if ( leftNumeric !== rightNumeric ) return leftNumeric ? - 1 : 1;
		return leftIdentifier < rightIdentifier ? - 1 : 1;

	}
	return 0;

}
