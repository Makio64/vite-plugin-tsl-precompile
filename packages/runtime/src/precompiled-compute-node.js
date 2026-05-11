/**
 * Runtime wrapper for a precompiled compute artifact.
 *
 * The slim NodeManager rewrite detects `isPrecompiledCompute` and hydrates
 * `precompiledArtifact` directly, so compute dispatch does not need the TSL
 * ComputeNode / NodeBuilder graph at runtime.
 */
import { EventDispatcher } from 'three';

export class PrecompiledComputeNode extends EventDispatcher {

	constructor( artifact ) {

		super();

		if ( ! artifact || typeof artifact !== 'object' ) {

			throw new Error( '[tsl-precompile] PrecompiledComputeNode requires a compute artifact.' );

		}

		if ( artifact.kind && artifact.kind !== 'compute' ) {

			throw new Error( `[tsl-precompile] PrecompiledComputeNode expected kind "compute", got ${ JSON.stringify( artifact.kind ) }.` );

		}

		this.isNode = true;
		this.isComputeNode = true;
		this.isPrecompiledCompute = true;
		this.precompiledArtifact = artifact;
		this.name = artifact.name || artifact.__name || '';
		this.count = Array.isArray( artifact.dispatchSize ) ? null : ( artifact.dispatchSize ?? null );
		this.dispatchSize = Array.isArray( artifact.dispatchSize ) ? artifact.dispatchSize.slice() : null;
		this.updateType = 'compute';
		this.onInitFunction = null;
		this.workgroupSize = normalizeWorkgroupSize( artifact.workgroupSize );
		this.version = 1;

	}

	setName( name ) {

		this.name = name;
		return this;

	}

	label( name ) {

		return this.setName( name );

	}

	onInit( callback ) {

		this.onInitFunction = typeof callback === 'function' ? callback : null;
		return this;

	}

	getUpdateType() {

		return 'none';

	}

	updateBefore() {}
	update() {}
	updateAfter() {}

	dispose() {

		this.dispatchEvent( { type: 'dispose' } );

	}

}

function normalizeWorkgroupSize( value ) {

	if ( ! Array.isArray( value ) || value.length === 0 ) return [ 64, 1, 1 ];
	const out = value.slice( 0, 3 ).map( ( item ) => Number.isFinite( item ) && item > 0 ? Math.floor( item ) : 1 );
	while ( out.length < 3 ) out.push( 1 );
	return out;

}

export default PrecompiledComputeNode;
