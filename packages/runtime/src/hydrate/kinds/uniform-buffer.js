import UniformBuffer from 'three/src/renderers/common/UniformBuffer.js';

export function createUniformBufferBinding( {
	artifact,
	group,
	groupName,
	descriptor,
	name,
	material,
	groupNode = null,
	deps,
} ) {

	const {
		attachLiveUniformBufferUpdater,
		createLiveUniformArrayResolver,
		findUniformGroupByteLength,
		findUniformGroupRequiredByteLength,
		resolvePlanBufferUniform,
		seedUniformBufferSnapshots,
	} = deps;
	const ubPlanEntry = resolvePlanBufferUniform( artifact, groupName, name );
	const planBufferByteLength = ubPlanEntry
		? Math.max(
			ubPlanEntry.byteLength || 0,
			ubPlanEntry.valueSnapshot && ubPlanEntry.valueSnapshot.length ? ubPlanEntry.valueSnapshot.length * 4 : 0
		)
		: 0;
	const standaloneUniformBuffer = /^UniformBuffer_/.test( name ) && name !== groupName;
	const flatUniformBuffer = standaloneUniformBuffer || !! ubPlanEntry;
	const byteLength = flatUniformBuffer
		? Math.max( descriptor.byteLength || 0, planBufferByteLength, 16 )
		: Math.max(
			descriptor.byteLength || 0,
			findUniformGroupByteLength( artifact, groupName, descriptor.name ),
			findUniformGroupRequiredByteLength( artifact, groupName, descriptor.name )
		);
	const buffer = new Float32Array( Math.max( 4, Math.ceil( byteLength / 4 ) ) );
	if ( ! flatUniformBuffer ) seedUniformBufferSnapshots( artifact, groupName, name, buffer );

	// NodeUniformBuffer values are captured as a flat typed-array snapshot,
	// so seed directly instead of relying on per-slot uniform writes.
	if ( ubPlanEntry ) {

		const snap = ubPlanEntry._liveArray || ubPlanEntry.valueSnapshot;
		if ( snap ) {

			for ( let i = 0; i < Math.min( snap.length, buffer.length ); i ++ ) buffer[ i ] = snap[ i ];

		}

	}

	const uniformBuffer = new UniformBuffer( name, buffer );
	uniformBuffer.visibility = descriptor.visibility | 0;
	uniformBuffer.groupNode = groupNode;
	const liveArrayResolver = createLiveUniformArrayResolver( name, buffer.byteLength, material, artifact, group && group.name || groupName );
	if ( liveArrayResolver ) attachLiveUniformBufferUpdater( uniformBuffer, liveArrayResolver );
	return uniformBuffer;

}
