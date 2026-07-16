import {
	collectArtifactVariantCandidates,
	createArtifactVariantPayloadFingerprint,
	mergeArtifactVariantFamily,
} from '@tsl-precompile/contract/artifact-variants';

/**
 * Coalesce contexts captured under different harness names back into the one
 * authored material family they came from. The capture marker intentionally
 * names each deferred context independently, while compiler-free replay needs
 * every signed topology on the material root selected for the live object.
 *
 * Mutates `userArtifacts` in place so a selected root owns every compatible,
 * disjoint topology captured for that authored material. Overlapping signed
 * roots remain independent because merging them would make selection ambiguous.
 */
export function coalesceUserArtifactVariantFamilies( userArtifacts = {} ) {

	const groups = new Map();
	for ( const [ name, entry ] of Object.entries( userArtifacts ) ) {

		const artifact = entry && entry.artifact;
		const identity = artifact && ( artifact.userMaterialUuid || artifact.materialUuid );
		if ( typeof identity !== 'string' || identity.length === 0 ) continue;
		let group = groups.get( identity );
		if ( ! group ) groups.set( identity, group = [] );
		group.push( { name, entry, artifact } );

	}

	let mergedFamilies = 0;
	let removedEntries = 0;
	for ( const group of groups.values() ) {

		if ( group.length < 2 ) continue;
		const root = selectFamilyRoot( group );
		const familySelectors = selectorsForArtifact( root.artifact );
		let mergedThisFamily = false;
		for ( const item of group ) {

			if ( item === root ) continue;
			const itemSelectors = selectorsForArtifact( item.artifact );
			// Dynamic cube capture deliberately uses a temporary sibling name so
			// its real face burst cannot consume the ordinary output capture. The
			// observer can still include the following main draw in that sibling,
			// which overlaps the authoritative ordinary root. Merge only the
			// sibling's disjoint cube candidates, then discard the internal entry.
			if ( item.name.endsWith( ':cube-prearm' ) ) {

				const disjointCandidates = collectArtifactVariantCandidates( item.artifact ).filter( ( candidate ) => {

					const selectors = selectorsForCandidate( candidate );
					return selectors.size > 0 && ! setsOverlap( familySelectors, selectors );

				} );
				if ( disjointCandidates.length > 0 ) {

					mergeArtifactVariantFamily( root.artifact, [ root.artifact, ...disjointCandidates ] );
					for ( const candidate of disjointCandidates ) {

						for ( const selector of selectorsForCandidate( candidate ) ) familySelectors.add( selector );

					}
					mergedThisFamily = true;

				}
				delete userArtifacts[ item.name ];
				removedEntries ++;
				continue;

			}
			// Deferred capture can emit a later partial root after the selected root
			// already owns the same signed payloads. Leaving that duplicate available
			// lets counter-based replay choose the incomplete family and then fail on
			// a sibling topology that the complete root does contain.
			if ( itemSelectors.size > 0 && artifactFamilyIsRepresented( root.artifact, item.artifact ) ) {

				delete userArtifacts[ item.name ];
				removedEntries ++;
				continue;

			}
			// Two payloads for one signed topology are not a selectable variant
			// family. Keep those roots independent so the existing object/source
			// matching can choose between them without creating runtime ambiguity.
			if ( itemSelectors.size === 0 || setsOverlap( familySelectors, itemSelectors ) ) continue;
			mergeArtifactVariantFamily( root.artifact, [ root.artifact, item.artifact ] );
			for ( const selector of itemSelectors ) familySelectors.add( selector );
			delete userArtifacts[ item.name ];
			removedEntries ++;
			mergedThisFamily = true;

		}
		if ( mergedThisFamily ) {

			// The transport hash described the partial root before its sibling
			// contexts were merged. Leaving it attached would advertise stale content.
			delete root.entry.__hash;
			mergedFamilies ++;

		}

	}

	return { mergedFamilies, removedEntries };

}

function selectorsForArtifact( artifact ) {

	const selectors = new Set();
	for ( const candidate of collectArtifactVariantCandidates( artifact ) ) {

		for ( const selector of ( candidate && candidate.renderContextSelectors || [] ) ) {

			if ( typeof selector === 'string' && selector.length > 0 ) selectors.add( selector );

		}

	}
	return selectors;

}

function artifactFamilyIsRepresented( rootArtifact, itemArtifact ) {

	try {

		const roots = collectArtifactVariantCandidates( rootArtifact ).map( ( candidate ) => ( {
			fingerprint: createArtifactVariantPayloadFingerprint( candidate ),
			selectors: selectorsForCandidate( candidate ),
		} ) );
		return collectArtifactVariantCandidates( itemArtifact ).every( ( candidate ) => {

			const selectors = selectorsForCandidate( candidate );
			if ( selectors.size === 0 ) return false;
			const fingerprint = createArtifactVariantPayloadFingerprint( candidate );
			return roots.some( ( root ) => root.fingerprint === fingerprint && setIsSubset( selectors, root.selectors ) );

		} );

	} catch ( _ ) {

		return false;

	}

}

function selectorsForCandidate( candidate ) {

	return new Set( ( candidate && candidate.renderContextSelectors || [] )
		.filter( ( selector ) => typeof selector === 'string' && selector.length > 0 ) );

}

function setIsSubset( subset, superset ) {

	for ( const value of subset ) if ( ! superset.has( value ) ) return false;
	return true;

}

function setsOverlap( left, right ) {

	for ( const value of right ) if ( left.has( value ) ) return true;
	return false;

}

function selectFamilyRoot( group ) {

	return group.find( ( item ) => item.artifact && item.artifact.sourceMaterial && item.artifact.sourceMaterial.name === item.name )
		|| [ ...group ].sort( ( left, right ) => compareArtifactNames( left.name, right.name ) )[ 0 ];

}

function compareArtifactNames( left, right ) {

	const leftMatch = /^(.*:)(\d+)$/.exec( left );
	const rightMatch = /^(.*:)(\d+)$/.exec( right );
	if ( leftMatch && rightMatch && leftMatch[ 1 ] === rightMatch[ 1 ] ) {

		return Number( leftMatch[ 2 ] ) - Number( rightMatch[ 2 ] );

	}
	return left < right ? - 1 : left > right ? 1 : 0;

}
