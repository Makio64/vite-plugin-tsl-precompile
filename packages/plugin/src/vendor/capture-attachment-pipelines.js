/**
 * Three r185's WebGPU pipeline cache key contains only the first color format.
 * Synthetic capture targets can share that format and shader with a live MRT
 * while using different secondary attachment formats. Keep their pipelines
 * distinct during the renderer-serialized capture transaction.
 */
export function isolateCaptureAttachmentPipelines( renderer ) {

	const backend = renderer?.backend;
	if ( backend?.isWebGPUBackend !== true || typeof backend.getRenderCacheKey !== 'function' ||
		typeof backend.utils?.getCurrentColorFormats !== 'function' ) return () => {};
	const original = backend.getRenderCacheKey;
	const descriptor = Object.getOwnPropertyDescriptor( backend, 'getRenderCacheKey' );
	const wrapper = function getCaptureRenderCacheKey( renderObject ) {

		const key = original.call( this, renderObject );
		const formats = this.utils.getCurrentColorFormats( renderObject.context );
		return formats.length > 1 ? `${ key }:tslp-attachments:${ JSON.stringify( formats ) }` : key;

	};
	backend.getRenderCacheKey = wrapper;
	return () => {

		if ( backend.getRenderCacheKey !== wrapper ) return;
		if ( descriptor ) Object.defineProperty( backend, 'getRenderCacheKey', descriptor );
		else delete backend.getRenderCacheKey;

	};

}
