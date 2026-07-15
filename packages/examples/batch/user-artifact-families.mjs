import { collectArtifactVariantCandidates, mergeArtifactVariantFamily } from '@tsl-precompile/contract/artifact-variants';

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
