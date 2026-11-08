/** Nonserialized hash axes used by auxiliary registry lookup. */
export function stampAuxEmitterProvenance( artifact, fields ) {

	if ( ! fields.threeRevision ) return;
	Object.defineProperty( artifact, '__tslpAuxThreeRevision', { value: fields.threeRevision, enumerable: false, configurable: true, writable: true } );
	Object.defineProperty( artifact, '__tslpAuxThreeCommit', { value: fields.threeCommit, enumerable: false, configurable: true, writable: true } );

}
