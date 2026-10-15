import UniformBuffer from 'three/src/renderers/common/UniformBuffer.js';

const writeStates = new WeakMap();
const uploadStates = new WeakMap();

export class ReplayUniformBuffer extends UniformBuffer {

	needsWrite( frame ) {

		const group = this.groupNode;
		if ( ! group?.shared || ( group.updateType !== 'render' && group.updateType !== 'frame' ) || frame.frameId === undefined ) return true;
		const previous = writeStates.get( this );
		return ! previous || previous.frameId !== frame.frameId ||
			( group.updateType === 'render' && ( frame.renderId === undefined || previous.renderId !== frame.renderId ) ) ||
			previous.renderer !== frame.renderer || previous.scene !== frame.scene ||
			previous.camera !== frame.camera || previous.lightsNode !== frame.lightsNode || previous.buffer !== this.buffer;

	}

	didWrite( frame ) {

		this.groupNode.version ++;
		if ( this.groupNode.shared ) writeStates.set( this, {
			frameId: frame.frameId, renderId: frame.renderId, renderer: frame.renderer,
			scene: frame.scene, camera: frame.camera, lightsNode: frame.lightsNode, buffer: this.buffer,
		} );

	}

	update() {

		const buffer = this.buffer;
		if ( ! buffer ) return false;
		let state = uploadStates.get( this );
		if ( ! state || state.buffer !== buffer ) {

			const words = new Uint32Array( buffer.buffer, buffer.byteOffset, buffer.byteLength / 4 );
			state = { buffer, words, uploaded: new Uint32Array( words ) };
			uploadStates.set( this, state );
			return true;

		}
		// Compare bytes rather than floats: integer slots, NaN payloads and
		// signed zero must preserve their exact shader-visible representation.
		// Four-word chunks reduce loop branches; XOR/OR cannot hide a changed bit.
		const { words, uploaded } = state;
		const length = words.length;
		let i = 0;
		for ( ; i + 3 < length; i += 4 ) {

			if ( ( ( words[ i ] ^ uploaded[ i ] ) | ( words[ i + 1 ] ^ uploaded[ i + 1 ] ) |
				( words[ i + 2 ] ^ uploaded[ i + 2 ] ) | ( words[ i + 3 ] ^ uploaded[ i + 3 ] ) ) === 0 ) continue;
			uploaded.set( words );
			return true;

		}
		for ( ; i < length; i ++ ) {

			if ( words[ i ] === uploaded[ i ] ) continue;
			uploaded.set( words );
			return true;

		}
		return false;

	}

}

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

	const uniformBuffer = new ReplayUniformBuffer( name, buffer );
	uniformBuffer.visibility = descriptor.visibility | 0;
	uniformBuffer.groupNode = groupNode;
	const liveArrayResolver = createLiveUniformArrayResolver( name, buffer.byteLength, material, artifact, group && group.name || groupName );
	if ( liveArrayResolver ) attachLiveUniformBufferUpdater( uniformBuffer, liveArrayResolver );
	return uniformBuffer;

}
