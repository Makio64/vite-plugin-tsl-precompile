/**
 * Runtime wrapper for a precompiled compute artifact.
 *
 * The slim NodeManager rewrite detects `isPrecompiledCompute` and hydrates
 * `precompiledArtifact` directly, so compute dispatch does not need the TSL
 * ComputeNode / NodeBuilder graph at runtime.
 */
export class PrecompiledComputeNode {

	constructor( artifact ) {

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
		this.count = artifact.dispatchSize;
		this.updateType = 'compute';
		this.onInitFunction = null;
		this.dispatchCount = null;
		this.workgroupSize = artifact.workgroupSize || [ 64, 1, 1 ];

	}

	getUpdateType() {

		return 'none';

	}

	updateBefore() {}
	update() {}
	updateAfter() {}

}

export default PrecompiledComputeNode;
