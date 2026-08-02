import assert from 'node:assert/strict';
import test from 'node:test';

import {
	createCatalogueRenderPlan,
	DEFAULT_GALLERY_BATCH_SIZE,
	nextGalleryLimit,
} from '../src/catalogue-window.js';

test( 'gallery renders one bounded catalogue tree at a time', () => {

	const plan = createCatalogueRenderPlan( {
		viewMode: 'gallery',
		total: 254,
		galleryLimit: DEFAULT_GALLERY_BATCH_SIZE,
	} );
	assert.deepEqual( plan, {
		renderGallery: true,
		renderSidebar: false,
		galleryCount: 24,
		remainingGalleryCount: 230,
		total: 254,
	} );
	assert.equal( nextGalleryLimit( plan.galleryCount, plan.total ), 48 );

} );

test( 'comparison renders only the text navigation tree', () => {

	const plan = createCatalogueRenderPlan( {
		viewMode: 'compare',
		total: 254,
		galleryLimit: 120,
	} );
	assert.equal( plan.renderSidebar, true );
	assert.equal( plan.renderGallery, false );
	assert.equal( plan.galleryCount, 0 );
	assert.equal( plan.remainingGalleryCount, 0 );

} );

test( 'gallery windows cap at the result count and reject unknown views', () => {

	assert.equal( nextGalleryLimit( 240, 254 ), 254 );
	assert.equal( nextGalleryLimit( 254, 254 ), 254 );
	assert.deepEqual(
		createCatalogueRenderPlan( { viewMode: 'gallery', total: 7, galleryLimit: 24 } ),
		{
			renderGallery: true,
			renderSidebar: false,
			galleryCount: 7,
			remainingGalleryCount: 0,
			total: 7,
		},
	);
	assert.throws( () => createCatalogueRenderPlan( { viewMode: 'unknown', total: 1 } ), /Unknown catalogue view/ );

} );
