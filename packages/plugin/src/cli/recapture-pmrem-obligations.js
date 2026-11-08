import { collectArtifactVariantCandidates } from '@tsl-precompile/contract/artifact-variants';
import { internalPassShape } from '@tsl-precompile/contract/internal-pass';
import { pmremRequiredStages, validatePMREMSupportConfig } from '@tsl-precompile/contract/pmrem-config';
import { stableJsonStringify } from '@tsl-precompile/contract/stable-json';

/** Keep each captured layout/source profile independent when proving support. */
export function collectRecapturePMREMFamilies( envelopes ) {

	const families = new Map();
	for ( const envelope of envelopes ) {

		const root = envelope.artifact;
		for ( const artifact of new Set( [ root, ...collectArtifactVariantCandidates( root ) ] ) ) {

			const descriptor = artifact?.internalPass;
			if ( descriptor?.family !== 'pmrem' ) throw new TypeError( 'Recapture PMREM artifact is missing its internal-pass family descriptor.' );
			const config = descriptor.config;
			const issues = validatePMREMSupportConfig( config );
			if ( issues.length > 0 ) throw new TypeError( `Invalid recapture PMREM config: ${ issues[ 0 ].message }` );
			if ( internalPassShape( 'pmrem', descriptor.stage ) !== descriptor.shape || descriptor.shape !== artifact.materialShape ) {

				throw new TypeError( 'Recapture PMREM artifact does not match its declared stage shape.' );

			}
			const key = stableJsonStringify( config );
			if ( ! families.has( key ) ) families.set( key, { config, stages: new Set() } );
			families.get( key ).stages.add( descriptor.stage );

		}

	}
	return Object.freeze( [ ...families.values() ].map( ( { config, stages } ) => Object.freeze( {
		config,
		stages: Object.freeze( [ ...stages ].sort() ),
	} ) ) );

}

export function recapturePMREMFamilyMissingShapes( families = [] ) {

	return families.flatMap( ( { config, stages } ) => {

		const present = new Set( stages );
		return pmremRequiredStages( config.profile, config )
			.filter( stage => ! present.has( stage ) )
			.map( stage => `${ internalPassShape( 'pmrem', stage ) } (${ config.profile }, ${ config.layout.schema })` );

	} );

}
