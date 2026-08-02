/**
 * three r185.1's PMREMNode assumes that a source environment texture is ready
 * during its first synchronous build. CubeTextureLoader returns the Texture
 * immediately, so a render that wins the loader race leaves `_pmrem === null`
 * and PMREMNode.setup() dereferences it.
 *
 * Keep the node on its existing placeholder texture until the source becomes
 * ready. The placeholder has the same 2D CubeUV shader topology as the eventual
 * PMREM, so later updateBefore() calls can replace the live texture without
 * rebuilding the shader.
 */

const INSTALL_SYMBOL = Symbol.for( '@tsl-precompile/runtime/r185-pmrem-node-guard' );
const PENDING_TEXTURE_SYMBOL = Symbol.for( '@tsl-precompile/runtime/r185-pmrem-node-pending-texture' );

export function installR185PMREMNodeGuard( three ) {

	if ( ! three || String( three.REVISION || '' ) !== '185' ) return false;

	const prototype = three.PMREMNode && three.PMREMNode.prototype;
	if ( ! prototype || typeof prototype.updateBefore !== 'function' ) return false;
	if ( prototype[ INSTALL_SYMBOL ] === true ) return true;

	const originalUpdateBefore = prototype.updateBefore;
	prototype.updateBefore = function updateBeforeWithPendingTexture( ...args ) {

		const pendingTexture = this[ PENDING_TEXTURE_SYMBOL ];
		if ( pendingTexture && this._pmrem === pendingTexture ) this._pmrem = null;

		const result = originalUpdateBefore.apply( this, args );
		if ( this._pmrem === null || this._pmrem === undefined ) {

			const fallbackTexture = this._texture && this._texture.value;
			if ( fallbackTexture && fallbackTexture.isTexture === true ) {

				this._pmrem = fallbackTexture;
				this[ PENDING_TEXTURE_SYMBOL ] = fallbackTexture;

			}

		} else {

			this[ PENDING_TEXTURE_SYMBOL ] = null;

		}

		return result;

	};

	Object.defineProperty( prototype, INSTALL_SYMBOL, {
		value: true,
		configurable: true,
	} );

	return true;

}
