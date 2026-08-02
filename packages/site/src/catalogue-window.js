export const DEFAULT_GALLERY_BATCH_SIZE = 24;

function boundedCount( value, fallback ) {

	return Number.isSafeInteger( value ) && value >= 0 ? value : fallback;

}

export function createCatalogueRenderPlan( {
	viewMode,
	total,
	galleryLimit = DEFAULT_GALLERY_BATCH_SIZE,
	batchSize = DEFAULT_GALLERY_BATCH_SIZE,
} ) {

	const itemCount = boundedCount( total, 0 );
	const pageSize = Math.max( 1, boundedCount( batchSize, DEFAULT_GALLERY_BATCH_SIZE ) );
	const requested = Math.max( pageSize, boundedCount( galleryLimit, pageSize ) );
	const renderGallery = viewMode === 'gallery';
	const renderSidebar = viewMode === 'compare';
	if ( ! renderGallery && ! renderSidebar ) throw new Error( `Unknown catalogue view: ${ viewMode }` );
	const galleryCount = renderGallery ? Math.min( itemCount, requested ) : 0;

	return {
		renderGallery,
		renderSidebar,
		galleryCount,
		remainingGalleryCount: renderGallery ? itemCount - galleryCount : 0,
		total: itemCount,
	};

}

export function nextGalleryLimit( current, total, batchSize = DEFAULT_GALLERY_BATCH_SIZE ) {

	const itemCount = boundedCount( total, 0 );
	const pageSize = Math.max( 1, boundedCount( batchSize, DEFAULT_GALLERY_BATCH_SIZE ) );
	const visible = boundedCount( current, pageSize );
	return Math.min( itemCount, visible + pageSize );

}
