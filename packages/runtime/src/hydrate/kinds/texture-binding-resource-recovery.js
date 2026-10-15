/**
 * Keep the CPU texture owner across Three's GPU-resource release.
 *
 * RenderTarget.setSize disposes its attachments without replacing their Texture
 * objects. This can happen in an upstream pass after our update-before rebinders
 * ran. Three's NodeSampler restores textureNode.value in update(); replay has no
 * TextureNode, so retain the released owner until that same binding update.
 * A later explicit rebind wins, and a binding without an owner still fails closed.
 */
export function installTextureBindingResourceRecovery( binding ) {

	const release = binding.release;
	const update = binding.update;
	binding.release = function releaseReplayTextureResource() {

		if ( this.texture ) this.__tslpReleasedTexture = this.texture;
		release.call( this );

	};
	binding.update = function updateReplayTextureResource() {

		if ( this.texture === null && this.__tslpReleasedTexture ) this.texture = this.__tslpReleasedTexture;
		this.__tslpReleasedTexture = null;
		return update.call( this );

	};

}
