/**
 * Structural fingerprints for extractor/codegen/runtime convergence checks.
 *
 * These deliberately ignore WGSL text and numeric snapshots so a Node
 * re-extract can be compared to a browser-captured artifact for *shape*
 * drift (binding names, source.kinds, group layout) without requiring
 * byte-identical shaders.
 *
 * @module Contract.ArtifactShape
 */

function artifactRoot( input ) {

	return input && input.artifact && typeof input.artifact === 'object' ? input.artifact : input;

}

function pushEntry( out, groupName, section, name, kind ) {

	const safeGroup = typeof groupName === 'string' && groupName.length > 0 ? groupName : '<group>';
	const safeName = typeof name === 'string' && name.length > 0 ? name : '<anon>';
	const safeKind = typeof kind === 'string' && kind.length > 0 ? kind : '<missing-kind>';
	out.push( `${ safeGroup }\t${ section }\t${ safeName }\t${ safeKind }` );

}

/**
 * Collect a sorted, stable list of `group\\tsection\\tname\\tkind` rows that
 * describe an artifact's uniform-plan shape. Collections are flattened with
 * an entry-key prefix on the group name.
 *
 * @param {object|object[]|Map} input artifact, artifact module, or collection
 * @return {readonly string[]}
 */
export function fingerprintArtifactShape( input ) {

	if ( Array.isArray( input ) ) {

		const rows = [];
		for ( let i = 0; i < input.length; i ++ ) {

			for ( const row of fingerprintArtifactShape( input[ i ] ) ) {

				rows.push( `[${ i }]${ row }` );

			}

		}
		return Object.freeze( rows.sort() );

	}

	if ( input && typeof input === 'object' && ! input.artifact && ! Array.isArray( input.uniformPlan ) ) {

		const values = Object.entries( input );
		if ( values.length > 0 && values.every( ( [ , value ] ) => value && typeof value === 'object' && value.artifact ) ) {

			const rows = [];
			for ( const [ key, value ] of values ) {

				for ( const row of fingerprintArtifactShape( value ) ) {

					rows.push( `[${ key }]${ row }` );

				}

			}
			return Object.freeze( rows.sort() );

		}

	}

	const artifact = artifactRoot( input );
	const plan = artifact && Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [];
	const rows = [];

	for ( const group of plan ) {

		const groupName = group && group.name;
		for ( const slot of group && Array.isArray( group.slots ) ? group.slots : [] ) {

			pushEntry( rows, groupName, 'slot', slot && slot.name, slot && slot.source && slot.source.kind );

		}
		for ( const texture of group && Array.isArray( group.textures ) ? group.textures : [] ) {

			pushEntry( rows, groupName, 'texture', texture && texture.name, texture && texture.source && texture.source.kind );

		}

	}

	return Object.freeze( rows.sort() );

}

/**
 * Diff two shape fingerprints. Returns missing/extra rows plus a boolean ok.
 *
 * @param {Iterable<string>} expected
 * @param {Iterable<string>} actual
 * @return {{ ok: boolean, missing: string[], extra: string[] }}
 */
export function diffArtifactShapes( expected, actual ) {

	const expectedSet = new Set( expected || [] );
	const actualSet = new Set( actual || [] );
	const missing = [ ...expectedSet ].filter( ( row ) => ! actualSet.has( row ) ).sort();
	const extra = [ ...actualSet ].filter( ( row ) => ! expectedSet.has( row ) ).sort();
	return {
		ok: missing.length === 0 && extra.length === 0,
		missing,
		extra,
	};

}
