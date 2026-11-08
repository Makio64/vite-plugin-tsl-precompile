import { isPMREMCubeLayout } from './pmrem-config.js';
import { collectArtifactVariantCandidates } from './artifact-variants.js';

/** Declared cube pass inputs are owned by the PMREM binder's semantic roles. */
export function stabilizePMREMInternalPassTextureSources( artifact ) {

	const descriptor = artifact?.internalPass;
	if ( descriptor?.family !== 'pmrem' || ! isPMREMCubeLayout( descriptor.config?.layout ) ) return artifact;
	for ( const member of new Set( [ artifact, ...collectArtifactVariantCandidates( artifact ) ] ) ) {

		for ( const input of descriptor.inputs || [] ) {

			if ( input.kind !== 'texture' ) continue;
			const group = member.uniformPlan?.find( value => value.name === input.group );
			const names = new Set( [ input.binding, `${ input.binding }_sampler` ] );
			const bindings = [ ...( group?.textures || [] ), ...( group?.orderedBindings || [] ).map( value => value.ref ) ];
			for ( const binding of bindings ) {

				if ( names.has( binding?.name ) && binding.source?.kind === 'artifact.texture' ) {

					delete binding.source.renderTargetSelector;
					delete binding.source.snapshot;

				}

			}

		}

	}
	return artifact;

}
