/**
 * Opt-in diagnostics for the primary object uniform buffer of precompiled
 * MeshStandard materials.
 *
 * The `update` sample is taken after the hydrator has written the staging
 * Float32Array. The `upload` sample is taken from that same binding after
 * `UniformBuffer.update()` returns true and immediately before three.js calls
 * `backend.updateBinding()`. This makes the latter the exact CPU payload
 * offered to WebGPU's queue.writeBuffer path.
 */

const OBJECT_UBO_DIAGNOSTIC_KEY = Symbol.for( '@tsl-precompile/runtime/object-ubo-diagnostic@1' );
const MAX_OBJECT_UBO_SAMPLES = 64;

export function objectUboDiagnosticsEnabled( root = typeof globalThis !== 'undefined' ? globalThis : null ) {

	if ( ! root ) return false;
	const globalFlag = root.__TSLP_DEBUG_OBJECT_UBO;
	if ( globalFlag === true || globalFlag === 1 || globalFlag === '1' ) return true;
	const env = root.process && root.process.env;
	return !! ( env && env.TSLP_DEBUG_OBJECT_UBO === '1' );

}

export function attachObjectUboUploadDiagnostic( artifact, planGroup, bindGroup ) {

	if ( ! objectUboDiagnosticsEnabled() || ! isMeshStandardObjectGroup( artifact, planGroup ) || ! bindGroup ) return;
	const binding = primaryObjectUniformBuffer( bindGroup, planGroup );
	if ( ! binding || binding[ OBJECT_UBO_DIAGNOSTIC_KEY ] ) return;
	const originalUpdate = typeof binding.update === 'function' ? binding.update : null;
	const metadata = {
		artifact,
		planGroup,
		bindGroupId: Number.isInteger( bindGroup.id ) ? bindGroup.id : null,
		bindGroupName: bindGroup.name || planGroup.name || '',
		lastFrame: null,
	};
	Object.defineProperty( binding, OBJECT_UBO_DIAGNOSTIC_KEY, {
		value: metadata,
		configurable: true,
	} );
	Object.defineProperty( binding, 'update', {
		value: function updateObjectUniformBufferWithDiagnostic( ...args ) {

			const updated = originalUpdate ? originalUpdate.apply( this, args ) : true;
			if ( updated !== false ) recordObjectUboPhase( 'upload', this, null );
			return updated;

		},
		configurable: true,
		writable: true,
	} );

}

export function inheritObjectUboUploadDiagnostic( sourceBindGroup, targetBindGroup ) {

	if ( ! sourceBindGroup || ! targetBindGroup ) return;
	const sourceBinding = ( sourceBindGroup.bindings || [] ).find( binding => binding && binding[ OBJECT_UBO_DIAGNOSTIC_KEY ] );
	const sourceMetadata = sourceBinding && sourceBinding[ OBJECT_UBO_DIAGNOSTIC_KEY ];
	if ( ! sourceMetadata ) return;
	attachObjectUboUploadDiagnostic( sourceMetadata.artifact, sourceMetadata.planGroup, targetBindGroup );
	const targetBinding = primaryObjectUniformBuffer( targetBindGroup, sourceMetadata.planGroup );
	const targetMetadata = targetBinding && targetBinding[ OBJECT_UBO_DIAGNOSTIC_KEY ];
	if ( targetMetadata ) targetMetadata.lastFrame = sourceMetadata.lastFrame;

}

export function recordObjectUboUpdateDiagnostic( binding, frame ) {

	recordObjectUboPhase( 'update', binding, frame );

}

export function classifyPmremObjectUniformSlots( artifact, planGroup ) {

	const roles = {};
	if ( ! isMeshStandardObjectGroup( artifact, planGroup ) ) return roles;
	const shader = String( artifact.fragmentShader || '' );
	for ( const slot of planGroup.slots || [] ) {

		if ( ! slot || typeof slot.name !== 'string' || slot.name.length === 0 ) continue;
		const ref = `object\\s*\\.\\s*${ escapeRegExp( slot.name ) }`;
		if ( slot.dtype === 'mat4' && new RegExp( `${ ref }\\s*\\*\\s*vec4\\s*<\\s*f32\\s*>` ).test( shader ) ) {

			if ( ! roles.transform ) roles.transform = slot.name;
			continue;

		}
		if ( ! isFloatSlot( slot ) ) continue;
		if ( ! roles.maxMip && new RegExp( `exp2\\s*\\(\\s*${ ref }\\s*\\)` ).test( shader ) ) roles.maxMip = slot.name;
		if ( ! roles.reciprocalWidth && new RegExp( `\\.x\\s*=\\s*\\([^;\\n]*\\*\\s*${ ref }\\s*\\)` ).test( shader ) ) roles.reciprocalWidth = slot.name;
		if ( ! roles.reciprocalHeight && new RegExp( `\\.y\\s*=\\s*\\([^;\\n]*\\*\\s*${ ref }\\s*\\)` ).test( shader ) ) roles.reciprocalHeight = slot.name;
		if ( ! roles.intensity && new RegExp( `vec3\\s*<\\s*f32\\s*>\\s*\\(\\s*${ ref }\\s*\\)` ).test( shader ) ) roles.intensity = slot.name;

	}
	return roles;

}

function recordObjectUboPhase( phase, binding, frame ) {

	if ( ! objectUboDiagnosticsEnabled() || ! binding || ! binding.buffer ) return;
	const metadata = binding[ OBJECT_UBO_DIAGNOSTIC_KEY ];
	if ( ! metadata || ! isMeshStandardObjectGroup( metadata.artifact, metadata.planGroup ) ) return;
	const root = typeof globalThis !== 'undefined' ? globalThis : null;
	if ( ! root ) return;
	const diagnostics = root.__tslpHarnessDiagnostics || ( root.__tslpHarnessDiagnostics = {
		colorTransferFallbacks: Object.create( null ),
		healedNullTextureImages: 0,
	} );
	const samples = diagnostics.objectUboSamples || ( diagnostics.objectUboSamples = [] );
	if ( samples.length >= MAX_OBJECT_UBO_SAMPLES ) return;

	if ( frame ) metadata.lastFrame = describeFrame( frame );
	const view = new DataView( binding.buffer.buffer, binding.buffer.byteOffset, binding.buffer.byteLength );
	const slotSamples = ( metadata.planGroup.slots || [] ).map( slot => describeSlot( slot, view ) );
	const slotsByName = new Map( slotSamples.map( slot => [ slot.name, slot ] ) );
	const roleNames = classifyPmremObjectUniformSlots( metadata.artifact, metadata.planGroup );
	const pmrem = {};
	for ( const [ role, name ] of Object.entries( roleNames ) ) {

		const slot = slotsByName.get( name );
		if ( slot ) pmrem[ role ] = slot;

	}
	const bindGroupIdentity = {
		id: metadata.bindGroupId,
		name: metadata.bindGroupName,
	};
	const sequence = Number.isInteger( diagnostics.objectUboSequence )
		? diagnostics.objectUboSequence
		: 0;
	diagnostics.objectUboSequence = sequence + 1;
	samples.push( {
		sequence,
		phase,
		artifact: metadata.artifact.name
			|| metadata.artifact.__name
			|| metadata.artifact.sourceMaterial && metadata.artifact.sourceMaterial.name
			|| metadata.artifact.materialShape
			|| '',
		materialShape: metadata.artifact.materialShape || '',
		bindGroupIdentity,
		group: {
			name: metadata.planGroup.name || '',
			byteLength: metadata.planGroup.byteLength || view.byteLength,
			shared: binding.groupNode && binding.groupNode.shared === true,
			version: binding.groupNode && Number.isFinite( binding.groupNode.version )
				? binding.groupNode.version
				: null,
		},
		binding: {
			name: binding.name || '',
			byteLength: binding.buffer.byteLength,
			visibility: binding.visibility | 0,
		},
		frame: metadata.lastFrame,
		slots: slotSamples,
		pmrem,
		bufferFloats: Array.from( new Float32Array( binding.buffer.buffer, binding.buffer.byteOffset, Math.floor( binding.buffer.byteLength / 4 ) ) ),
	} );

}

function describeSlot( slot, view ) {

	const offset = slot && ( slot.offset ?? slot.byteOffset ) || 0;
	const source = slot && slot.source || {};
	return {
		name: slot && slot.name || '',
		offset,
		size: slot && ( slot.size || slot.byteLength ) || slotFloatCount( slot ) * 4,
		dtype: slot && slot.dtype || '',
		sourceKind: source.kind || '',
		liveNodeId: Number.isInteger( source.liveNodeId ) ? source.liveNodeId : null,
		liveNodeIdentity: typeof source.liveNodeIdentity === 'string' ? source.liveNodeIdentity : null,
		liveSidecarAttached: !! ( slot && slot._liveNode ),
		liveSidecarOverlay: !! ( slot && slot.__tslpLiveSidecarOverlay === true ),
		floats: readFloats( view, offset, slotFloatCount( slot ) ),
	};

}

function describeFrame( frame ) {

	const object = frame && frame.object || null;
	const renderObject = frame && frame.renderObject || null;
	return {
		frameId: Number.isFinite( frame && frame.frameId ) ? frame.frameId : null,
		objectId: Number.isFinite( object && object.id ) ? object.id : null,
		objectUuid: object && object.uuid || null,
		objectName: object && object.name || '',
		objectType: object && object.type || '',
		renderObjectId: Number.isFinite( renderObject && renderObject.id ) ? renderObject.id : null,
	};

}

function primaryObjectUniformBuffer( bindGroup, planGroup ) {

	const bindings = bindGroup && Array.isArray( bindGroup.bindings ) ? bindGroup.bindings : [];
	return bindings.find( binding => binding && binding.isUniformBuffer === true && binding.name === planGroup.name )
		|| bindings.find( binding => binding && binding.isUniformBuffer === true )
		|| null;

}

function isMeshStandardObjectGroup( artifact, planGroup ) {

	return !! (
		artifact
		&& artifact.materialShape === 'mesh-standard'
		&& planGroup
		&& planGroup.name === 'object'
		&& Array.isArray( planGroup.slots )
	);

}

function isFloatSlot( slot ) {

	return slot.dtype === 'number' || slot.dtype === 'float' || slot.dtype === 'f32';

}

function slotFloatCount( slot ) {

	switch ( slot && slot.dtype ) {

		case 'number':
		case 'float':
		case 'f32':
		case 'int':
		case 'i32':
		case 'uint':
		case 'u32':
			return 1;
		case 'vec2':
			return 2;
		case 'vec3':
		case 'color':
			return 3;
		case 'vec4':
			return 4;
		case 'mat3':
			return 12;
		case 'mat4':
			return 16;
		default: {

			const size = slot && ( slot.size || slot.byteLength ) || 0;
			return Math.max( 0, Math.floor( size / 4 ) );

		}

	}

}

function readFloats( view, offset, count ) {

	const values = [];
	const available = Math.max( 0, Math.floor( ( view.byteLength - offset ) / 4 ) );
	for ( let index = 0; index < Math.min( count, available ); index ++ ) {

		values.push( view.getFloat32( offset + index * 4, true ) );

	}
	return values;

}

function escapeRegExp( value ) {

	return value.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );

}
