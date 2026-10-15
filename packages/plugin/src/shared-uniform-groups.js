import { createHash } from 'node:crypto';
import { dynamicBindingDescriptor, GENERATED_SHARED_UNIFORM_GROUP_KEY } from '@tsl-precompile/contract/dynamic-bindings';
import { KINDS, KIND_STATUS } from '@tsl-precompile/contract/kinds';
import { stableJsonStringify } from '@tsl-precompile/contract/stable-json';

// Sharing is proven at build time. Runtime never hashes a plan or discovers
// whether a material's live values happen to equal another material's values.
export function emitSharedUniformGroupKeys( artifact, expression = 'artifact' ) {

	const lines = [];
	if ( artifact.kind !== 'compute' ) {

		for ( const [ index, group ] of ( artifact.uniformPlan || [] ).entries() ) {

			const descriptor = artifact.bindings?.find( entry => entry.name === group.name );
			if ( ! canShare( group, descriptor ) ) continue;
			const key = createHash( 'sha256' ).update( stableJsonStringify( [
				group, descriptor, artifact.lightIdentities || null, artifact.shaderLanguage || null,
			] ) ).digest( 'hex' );
			lines.push( `Object.defineProperty(${ expression }.uniformPlan[${ index }], Symbol.for(${ JSON.stringify( GENERATED_SHARED_UNIFORM_GROUP_KEY.description ) }), { value: ${ JSON.stringify( key ) } });` );

		}

	}
	for ( const [ key, variant ] of Object.entries( artifact.variants || {} ) ) {

		lines.push( ...emitSharedUniformGroupKeys( variant, `${ expression }.variants[${ JSON.stringify( key ) }]` ) );

	}
	return lines;

}

function canShare( group, descriptor ) {

	if ( group?.shared !== true || ( group.name !== 'render' && group.name !== 'frame' )
		|| descriptor?.bindings?.length !== 1 || descriptor.bindings[ 0 ].kind !== 'uniform-buffer'
		|| descriptor.bindings[ 0 ].name !== group.name || ! group.slots?.length
		|| group.textures?.length || group.storageBuffers?.length ) return false;
	return group.slots.every( slot => {

		// Pass-local callbacks and sidecars can change within a single render.
		if ( Object.getOwnPropertyNames( slot ).some( key => key.startsWith( '_' ) ) ) return false;
		const kind = slot.source?.kind;
		if ( KINDS[ kind ]?.status !== KIND_STATUS.CODEGEN || kind === 'light.shadowModelMatrix' ) return false;
		const owner = dynamicBindingDescriptor( kind )?.owner;
		return owner === 'camera' || owner === 'light';

	} );

}
