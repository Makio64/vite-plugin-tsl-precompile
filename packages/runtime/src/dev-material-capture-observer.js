/** Lazy real-render observer readiness for development material capture. */

export function prepareRenderObjectHarvester( installation ) {

	if ( ! installation ) return Promise.resolve( null );
	if ( typeof installation.beginRenderObjectHarvest === 'function' ) {

		return Promise.resolve( installation.beginRenderObjectHarvest );

	}
	if ( installation.renderObjectHarvesterPromise ) return installation.renderObjectHarvesterPromise;

	// Keep the only private Three seam in the plugin's vendored adapter. The
	// runtime owns the public renderer.render() epoch, but it must not grow a
	// second NodeManager/RenderObjects wrapper that can drift from compileTSL.
	installation.renderObjectHarvesterPending = true;
	installation.renderObjectHarvesterPromise = import( /* @vite-ignore */ 'vite-plugin-tsl-precompile/src/vendor/compileTSL.js' ).then(
		( module ) => {

			const begin = module && module.beginRenderObjectHarvest;
			if ( typeof begin === 'function' ) installation.beginRenderObjectHarvest = begin;
			return typeof begin === 'function' ? begin : null;

		},
		() => null,
	).finally( () => { installation.renderObjectHarvesterPending = false; } );
	return installation.renderObjectHarvesterPromise;

}

export function materialCaptureWaitsForObserver( entry ) {

	// Custom extractors own their observation policy. Ordinary capture must
	// not accept a cloned shader before its lazy real-render observer is ready.
	return entry.installation.renderObjectHarvesterPending === true && ! entry.installation.extractor;

}
