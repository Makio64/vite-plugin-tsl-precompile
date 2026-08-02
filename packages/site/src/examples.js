// Compatibility lab — reads /examples.json, renders a gallery and comparison stage.
// Comparison modes: slider (default, draggable seam), split (side-by-side), solo (single image with toggle).
// Vanilla DOM, no framework — matches the rest of the site.

import {
	createCatalogueRenderPlan,
	DEFAULT_GALLERY_BATCH_SIZE,
	nextGalleryLimit,
} from './catalogue-window.js';
import {
	clampComparisonPosition,
	COMPARISON_SIDE,
	comparisonImageAlt,
	comparisonValueText,
	resolveSoloFrame,
} from './comparison-contract.js';

const TIER_LABEL = {
	'pixel-match': 'Pixel-match',
	'visual-match': 'Visual-match',
	diagnostic: 'Diagnostic',
	'renders': 'Renders',
	'capture-only': 'Capture only',
	fail: 'Failure',
};

const QUALITY_LABEL = {
	'pixel-match': 'Pixel-match',
	'visual-match': 'Visual-match',
	'renders': 'Renders',
	'capture-only': 'Capture only',
};

const TIER_RANK = {
	'pixel-match': 0,
	'visual-match': 1,
	diagnostic: 2,
	renders: 3,
	'capture-only': 4,
	fail: 5,
};
const LIVE_FILTER = 'live-compiled';

const TIER_CHIPS = [
	{ id: 'pixel-match', totalsKey: 'pixelMatchCount' },
	{ id: 'visual-match', totalsKey: 'visualMatchCount' },
	{ id: 'diagnostic' },
	{ id: 'renders', totalsKey: 'rendersCount' },
	{ id: 'capture-only', totalsKey: 'captureOnlyCount' },
];

const VALID_MODES = new Set( [ 'slider', 'split', 'solo' ] );
const VALID_VIEWS = new Set( [ 'gallery', 'compare' ] );

const state = {
	data: null,
	liveManifest: null,
	filter: 'all',
	query: '',
	view: [],                 // currently filtered+sorted array (the prev/next walk path)
	currentBasename: null,
	viewMode: 'gallery',       // 'gallery' | 'compare'
	galleryLimit: DEFAULT_GALLERY_BATCH_SIZE,
	mode: 'slider',           // 'slider' | 'split' | 'solo'
	soloSide: 'replay',       // 'replay' | 'capture' — used in solo mode
	sliderPos: 50,            // % — used in slider mode
};

const $ = sel => document.querySelector( sel );

function fmtPsnr( pixel ) {
	if ( ! pixel ) return '—';
	if ( pixel.identical ) return '∞ dB';
	const v = pixel.psnr;
	if ( v == null ) return '—';
	return `${v.toFixed( 1 )} dB`;
}

function effectivePsnr( pixel ) {
	if ( ! pixel ) return - 1;
	if ( pixel.identical ) return 1e6;
	return pixel.psnr ?? - 1;
}

function fmtBytes( n ) {
	if ( n == null || n === 0 ) return '—';
	if ( n < 1024 ) return `${n} B`;
	if ( n < 1024 * 1024 ) return `${( n / 1024 ).toFixed( 1 )} KB`;
	return `${( n / ( 1024 * 1024 ) ).toFixed( 2 )} MB`;
}

function escapeHtml( s ) {
	return String( s ).replace( /[&<>"']/g, c => ( {
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
	}[ c ] ) );
}

function renderMetrics( totals, verdicts ) {
	const map = {
		examplesProcessed: totals.examplesProcessed,
		materialsBaked: totals.materialsBaked,
		wgslKb: `${Math.round( totals.wgslBytes / 1024 )} KB`,
		stockSmokeFraction: `${totals.smokePass}/${totals.smokeTotal}`,
		pixelMatchCount: totals.pixelMatchCount,
		visualMatchCount: totals.visualMatchCount,
		rendersCount: totals.rendersCount,
		captureOnlyCount: totals.captureOnlyCount,
		coveragePass: verdicts.pass,
		coverageDiagnostic: verdicts.diagnostic,
		coverageFail: verdicts.fail,
	};
	for ( const el of document.querySelectorAll( '[data-key]' ) ) {
		const k = el.getAttribute( 'data-key' );
		if ( map[ k ] != null ) el.textContent = map[ k ];
	}
	for ( const el of document.querySelectorAll( '[data-evidence-verdict]' ) ) {
		const key = el.dataset.evidenceVerdict;
		if ( verdicts[ key ] != null ) el.textContent = verdicts[ key ];
	}
}

function verifiedLiveEntries() {

	return ( state.liveManifest?.examples || [] ).filter( entry => verifiedLiveEntry( entry ) );

}

function freeLiveEntries() {

	return verifiedLiveEntries().filter( entry => entry.role === 'free-example' && entry.collection === 'free-tsl' );

}

function renderFreeExamples() {

	const grid = $( '#ex-free-grid' );
	if ( ! grid ) return;
	const entries = freeLiveEntries();
	if ( entries.length === 0 ) {

		grid.innerHTML = '<p class="ex-free-loading">The production examples are unavailable in this build.</p>';
		return;

	}
	grid.innerHTML = entries.map( ( entry, index ) => `
		<article class="ex-free-card" style="--free-accent:${ escapeHtml( entry.accent || '#22d3ee' ) }">
			<div class="ex-free-media">
				${ entry.previewUrl
					? `<img src="${ escapeHtml( entry.previewUrl ) }" alt="${ escapeHtml( entry.title ) } compiler-free TSL website" loading="lazy" decoding="async">`
					: '<span class="ex-free-placeholder">WebGPU preview</span>' }
				<span class="ex-free-index">${ String( index + 1 ).padStart( 2, '0' ) }</span>
				<span class="ex-free-runtime"><i aria-hidden="true"></i> Pure slim</span>
			</div>
			<div class="ex-free-body">
				<p>${ escapeHtml( entry.brand || 'TSL / WORLD' ) }</p>
				<h3>${ escapeHtml( entry.title ) }</h3>
				<span>${ escapeHtml( entry.description || 'A compiler-free Three.js WebGPU experience.' ) }</span>
				<div>
					<button type="button" data-free-live-id="${ escapeHtml( entry.id ) }">Run live</button>
					<a href="${ escapeHtml( entry.playUrl ) }" target="_blank" rel="noopener">Open full page ↗</a>
				</div>
			</div>
		</article>
	` ).join( '' );

}

function renderLiveMetrics( examples ) {

	const liveEntries = verifiedLiveEntries();
	const linked = examples.filter( record => liveEntryForCatalogue( record.basename ) ).length;
	const map = {
		liveRouteCount: liveEntries.length,
		liveGalleryCount: linked,
		freeRouteCount: freeLiveEntries().length,
	};
	for ( const el of document.querySelectorAll( '[data-key]' ) ) {

		const value = map[ el.getAttribute( 'data-key' ) ];
		if ( value != null ) el.textContent = value;

	}

}

function renderTierBar( verdicts ) {
	const total = ( verdicts.pass ?? 0 )
		+ ( verdicts.diagnostic ?? 0 )
		+ ( verdicts.fail ?? 0 );
	if ( ! total ) return;
	const pct = key => ( ( verdicts[ key ] ?? 0 ) / total ) * 100;
	for ( const key of [ 'pass', 'diagnostic', 'fail' ] ) {
		document.querySelector( `.ex-tier-segment[data-verdict="${key}"]` ).style.setProperty( '--pct', pct( key ) );
	}
}

function renderChips( categories, totals, examples ) {
	const chipsEl = $( '#ex-chips' );
	const liveCount = examples.filter( record => liveEntryForCatalogue( record.basename ) ).length;
	const tierChips = TIER_CHIPS.map( c => ( {
		id: c.id,
		label: TIER_LABEL[ c.id ],
		count: c.totalsKey
			? ( totals[ c.totalsKey ] ?? 0 )
			: examples.filter( record => record.badge === c.id ).length,
		tier: true,
	} ) );
	const all = [
		{ id: 'all', label: 'All', count: examples.length },
		{ id: LIVE_FILTER, label: 'Live compiled', count: liveCount, live: true },
		...tierChips,
		...categories,
	];
	chipsEl.innerHTML = all.map( c => {
		const pressed = state.filter === c.id ? 'true' : 'false';
		const dot = c.tier ? `<span class="ex-dot ex-dot-${escapeHtml( c.id )}" aria-hidden="true"></span>` : '';
		const liveDot = c.live ? '<span class="ex-chip-live-dot" aria-hidden="true"></span>' : '';
		return `<button type="button" aria-pressed="${pressed}" class="ex-chip${c.tier ? ' ex-chip-tier' : ''}${c.live ? ' ex-chip-live' : ''}" data-filter="${escapeHtml( c.id )}">
			${dot}${liveDot}<span>${escapeHtml( c.label )}</span>
			<span class="ex-chip-count">${c.count}</span>
		</button>`;
	} ).join( '' );

	chipsEl.addEventListener( 'click', e => {
		const btn = e.target.closest( '.ex-chip' );
		if ( ! btn ) return;
		state.filter = btn.dataset.filter;
		for ( const c of chipsEl.querySelectorAll( '.ex-chip' ) ) {
			c.setAttribute( 'aria-pressed', c === btn ? 'true' : 'false' );
		}
		rebuildView( { keepSelection: true } );
	} );
}

function applyFilters( examples ) {
	let xs = examples;
	const isTierFilter = state.filter in TIER_LABEL;
	if ( state.filter === LIVE_FILTER ) {
		xs = xs.filter( r => liveEntryForCatalogue( r.basename ) );
	} else if ( isTierFilter ) {
		xs = xs.filter( r => r.badge === state.filter );
	} else if ( state.filter !== 'all' ) {
		xs = xs.filter( r => r.category === state.filter );
	}
	if ( state.query ) {
		const q = state.query.toLowerCase();
		xs = xs.filter( r =>
			r.basename.toLowerCase().includes( q )
			|| r.displayName.toLowerCase().includes( q )
			|| ( r.notes && r.notes.toLowerCase().includes( q ) )
		);
	}
	return xs;
}

function defaultSort( xs ) {
	const sorted = xs.slice();
	sorted.sort( ( a, b ) => {
		const ta = TIER_RANK[ a.badge ] ?? 9;
		const tb = TIER_RANK[ b.badge ] ?? 9;
		if ( ta !== tb ) return ta - tb;
		return effectivePsnr( b.pixel ) - effectivePsnr( a.pixel );
	} );
	return sorted;
}

function groupByCategory( xs ) {
	const buckets = new Map();
	for ( const r of xs ) {
		if ( ! buckets.has( r.category ) ) buckets.set( r.category, { label: r.categoryLabel, items: [] } );
		buckets.get( r.category ).items.push( r );
	}
	return [ ...buckets.entries() ].map( ( [ id, b ] ) => ( { id, label: b.label, items: b.items } ) );
}

function renderSidebar() {
	const listEl = $( '#ex-sidebar-list' );
	const empty = $( '#ex-empty' );
	if ( ! state.view.length ) {
		listEl.innerHTML = '';
		empty.hidden = false;
		return;
	}
	empty.hidden = true;

	const flat = state.query || state.filter in TIER_LABEL || state.filter === LIVE_FILTER;
	const groups = flat
		? [ { id: '__flat__', label: null, items: state.view } ]
		: groupByCategory( state.view );

	listEl.innerHTML = groups.map( g => {
		if ( g.label === null ) return `<div class="ex-side-flat">${sidebarItemsMarkup( g.items )}</div>`;
		const open = g.items.some( item => item.basename === state.currentBasename );
		return `<details class="ex-side-group"
			data-sidebar-group="${escapeHtml( g.id )}"
			data-hydrated="${open ? 'true' : 'false'}"${open ? ' open' : ''}>
			<summary class="ex-side-group-summary">
				<span>${escapeHtml( g.label )}</span>
				<span class="ex-side-group-count">${g.items.length}</span>
			</summary>
			<div class="ex-side-group-items">${open ? sidebarItemsMarkup( g.items ) : ''}</div>
		</details>`;
	} ).join( '' );

	const current = listEl.querySelector( '.is-current' );
	if ( current ) current.scrollIntoView( { block: 'nearest', behavior: 'auto' } );
}

function sidebarItemsMarkup( items ) {

	return items.map( r => {

		const isCurrent = r.basename === state.currentBasename;
		const hasLiveRoute = !! liveEntryForCatalogue( r.basename );
		return `<a class="ex-side-item${isCurrent ? ' is-current' : ''}"
			href="#${escapeHtml( r.basename )}"
			data-basename="${escapeHtml( r.basename )}"
			${isCurrent ? 'aria-current="true"' : ''}>
			<span class="ex-dot ex-dot-${escapeHtml( r.badge )}" aria-hidden="true"></span>
			<span class="ex-side-name">${escapeHtml( r.displayName )}</span>
			${hasLiveRoute ? '<span class="ex-side-live">Live</span>' : ''}
		</a>`;

	} ).join( '' );

}

function hydrateSidebarGroup( details ) {

	if ( ! details || details.dataset.hydrated === 'true' ) return;
	const group = groupByCategory( state.view ).find( candidate => candidate.id === details.dataset.sidebarGroup );
	if ( ! group ) return;
	details.querySelector( '.ex-side-group-items' ).innerHTML = sidebarItemsMarkup( group.items );
	details.dataset.hydrated = 'true';

}

function syncSidebarSelection( basename ) {

	if ( state.viewMode !== 'compare' ) return;
	const record = state.view.find( item => item.basename === basename );
	if ( record ) {

		const details = [ ...document.querySelectorAll( '#ex-sidebar-list .ex-side-group' ) ]
			.find( group => group.dataset.sidebarGroup === record.category );
		if ( details ) {

			hydrateSidebarGroup( details );
			details.open = true;

		}

	}
	for ( const link of document.querySelectorAll( '.ex-side-item' ) ) {

		const isCurrent = link.dataset.basename === basename;
		link.classList.toggle( 'is-current', isCurrent );
		if ( isCurrent ) link.setAttribute( 'aria-current', 'true' );
		else link.removeAttribute( 'aria-current' );

	}
	const current = document.querySelector( '.ex-side-item.is-current' );
	if ( current ) current.scrollIntoView( { block: 'nearest', behavior: 'auto' } );

}

function renderGallery( count ) {

	const gallery = $( '#ex-gallery' );
	const empty = $( '#ex-gallery-empty' );
	if ( ! state.view.length ) {

		gallery.innerHTML = '';
		empty.hidden = false;
		return;

	}
	empty.hidden = true;
	gallery.innerHTML = state.view.slice( 0, count ).map( r => {

		const image = r.thumbReplay || r.thumbCapture;
		const hasLiveRoute = !! liveEntryForCatalogue( r.basename );
		const source = r.source?.kind === 'three' ? 'Three.js upstream' : 'Compiled fixture';
		const tier = TIER_LABEL[ r.badge ] ?? r.badge;
		const psnr = fmtPsnr( r.pixel );
		const materials = r.materialCount == null ? null : `${ r.materialCount } material${ r.materialCount === 1 ? '' : 's' }`;
		return `<a class="ex-gallery-card${hasLiveRoute ? ' is-live' : ''}" href="#${escapeHtml( r.basename )}" data-basename="${escapeHtml( r.basename )}">
			<span class="ex-gallery-media">
				${image && r.thumbHealth === 'ok'
					? `<img src="${escapeHtml( image )}" alt="${escapeHtml( r.displayName )} slim-runtime replay" loading="lazy" decoding="async">`
					: '<span class="ex-gallery-placeholder">Uniform evidence frame</span>'}
				<span class="ex-gallery-badges">
					<span class="ex-gallery-tier" data-tier="${escapeHtml( r.badge )}">${escapeHtml( tier )}</span>
					${hasLiveRoute ? '<span class="ex-gallery-live"><i aria-hidden="true"></i> Live compiled</span>' : ''}
				</span>
			</span>
			<span class="ex-gallery-body">
				<span class="ex-gallery-source">${escapeHtml( source )}</span>
				<strong>${escapeHtml( r.displayName )}</strong>
				<span class="ex-gallery-meta"><span>${escapeHtml( psnr )}</span>${materials ? `<span>${escapeHtml( materials )}</span>` : ''}</span>
			</span>
		</a>`;

	} ).join( '' );

}

function renderActiveCatalogue() {

	const plan = createCatalogueRenderPlan( {
		viewMode: state.viewMode,
		total: state.view.length,
		galleryLimit: state.galleryLimit,
	} );
	const sidebar = $( '#ex-sidebar-list' );
	const gallery = $( '#ex-gallery' );

	if ( plan.renderSidebar ) {

		renderSidebar();

	} else {

		sidebar.replaceChildren();
		$( '#ex-empty' ).hidden = true;

	}

	if ( plan.renderGallery ) {

		renderGallery( plan.galleryCount );

	} else {

		gallery.replaceChildren();
		$( '#ex-gallery-empty' ).hidden = true;

	}

	const progress = $( '#ex-gallery-progress' );
	const more = $( '#ex-gallery-more' );
	const footer = $( '#ex-gallery-footer' );
	const nextCount = Math.min( DEFAULT_GALLERY_BATCH_SIZE, plan.remainingGalleryCount );
	footer.hidden = ! plan.renderGallery || plan.remainingGalleryCount === 0;
	more.hidden = plan.remainingGalleryCount === 0;
	more.textContent = `Load ${ nextCount } more`;
	progress.textContent = `${ plan.galleryCount } of ${ plan.total } loaded`;
	$( '#ex-drawer-count' ).textContent = plan.total;
	$( '#ex-result-count' ).textContent = plan.renderGallery && plan.remainingGalleryCount > 0
		? `${ plan.total } results · ${ plan.galleryCount } loaded`
		: `${ plan.total } result${ plan.total === 1 ? '' : 's' }`;

}

function setSliderPos( pct ) {
	const v = clampComparisonPosition( pct, state.sliderPos );
	state.sliderPos = v;
	const slider = document.querySelector( '.cmp-slider' );
	if ( slider ) slider.style.setProperty( '--slider-pos', `${v}%` );
	const handle = $( '#cmp-handle' );
	if ( handle ) {
		const live = Math.round( v );
		handle.setAttribute( 'aria-valuenow', live );
		handle.setAttribute( 'aria-valuetext', comparisonValueText( live ) );
	}
}

function setMode( mode ) {
	if ( ! VALID_MODES.has( mode ) ) return;
	state.mode = mode;
	$( '#cmp-viewport' ).dataset.mode = mode;
	for ( const btn of document.querySelectorAll( '.ex-mode-tabs [data-mode]' ) ) {
		btn.setAttribute( 'aria-pressed', btn.dataset.mode === mode ? 'true' : 'false' );
	}
	renderStage();
}

function setSoloSide( side ) {
	if ( side !== 'replay' && side !== 'capture' ) return;
	state.soloSide = side;
	for ( const btn of document.querySelectorAll( '.cmp-solo-toggle [data-solo]' ) ) {
		btn.setAttribute( 'aria-pressed', btn.dataset.solo === side ? 'true' : 'false' );
	}
	renderStage();
}

function setViewMode( view, opts = {} ) {

	if ( ! VALID_VIEWS.has( view ) ) return;
	state.viewMode = view;
	$( '#ex-browser' ).dataset.view = view;
	for ( const button of document.querySelectorAll( '.ex-view-switch [data-view]' ) ) {

		button.setAttribute( 'aria-pressed', button.dataset.view === view ? 'true' : 'false' );

	}
	if ( view === 'gallery' ) closeDrawer();
	renderActiveCatalogue();
	if ( view === 'compare' ) {

		renderStage();
		if ( opts.focus === true ) $( '#ex-stage' ).focus( { preventScroll: true } );

	}

}

function renderStage() {
	const r = state.data.examples.find( x => x.basename === state.currentBasename );
	const stage = $( '#ex-stage' );
	const psnrChip = $( '#cmp-psnr-chip' );
	const empty = $( '#cmp-empty' );

	if ( ! r ) {
		stage.dataset.empty = 'true';
		$( '#ex-stage-title' ).textContent = 'No example selected';
		$( '#ex-stage-cat' ).textContent = '—';
		$( '#ex-stage-badge' ).innerHTML = '';
		$( '#ex-stage-stats' ).innerHTML = '';
		$( '#ex-stage-cta' ).hidden = true;
		$( '#ex-stage-live' ).hidden = true;
		$( '#ex-stage-share' ).hidden = true;
		psnrChip.hidden = true;
		empty.hidden = false;
		// Clear images and stale alternatives from the prior selection.
		for ( const img of document.querySelectorAll( '.cmp-img' ) ) {
			img.removeAttribute( 'src' );
			img.alt = '';
		}
		return;
	}
	stage.dataset.empty = 'false';
	updateLiveAction( r );

	$( '#ex-stage-title' ).textContent = r.displayName;
	$( '#ex-stage-cat' ).textContent = r.categoryLabel;

	const tier = TIER_LABEL[ r.badge ] ?? r.badge;
	const quality = QUALITY_LABEL[ r.quality ] ?? r.quality;
	const psnr = fmtPsnr( r.pixel );
	$( '#ex-stage-badge' ).innerHTML = `
		<span class="ex-stage-verdict" data-verdict="${escapeHtml( r.pixel.verdict )}">
			<span class="ex-dot ex-dot-${escapeHtml( r.badge )}" aria-hidden="true"></span>${escapeHtml( r.pixel.verdict === 'pass' ? 'Gated pass' : tier )}
		</span>
		<span class="ex-stage-quality">${escapeHtml( quality )} &middot; ${escapeHtml( psnr )}</span>
	`;

	const replaySrc = r.thumbReplayModal ?? r.thumbReplay;
	const captureSrc = r.thumbCaptureModal ?? r.thumbCapture;

	// PSNR chip
	if ( replaySrc && captureSrc ) {
		psnrChip.hidden = false;
		psnrChip.dataset.tier = r.quality;
		$( '#cmp-psnr-num' ).textContent = psnr;
	} else {
		psnrChip.hidden = true;
	}

	// Mode-tab availability: slider/split need both sources; solo needs at least one.
	const hasBoth = !! replaySrc && !! captureSrc;
	const hasAny = !! replaySrc || !! captureSrc;
	for ( const btn of document.querySelectorAll( '.ex-mode-tabs [data-mode]' ) ) {
		const m = btn.dataset.mode;
		btn.disabled = ( m === 'slider' || m === 'split' ) ? ! hasBoth : ! hasAny;
	}
	// Auto-fallback if current mode is unsupported for this example.
	let effectiveMode = state.mode;
	if ( ( effectiveMode === 'slider' || effectiveMode === 'split' ) && ! hasBoth ) {
		effectiveMode = hasAny ? 'solo' : effectiveMode;
	}
	$( '#cmp-viewport' ).dataset.mode = effectiveMode;
	for ( const btn of document.querySelectorAll( '.ex-mode-tabs [data-mode]' ) ) {
		btn.setAttribute( 'aria-pressed', btn.dataset.mode === effectiveMode ? 'true' : 'false' );
	}

	if ( ! hasAny ) {
		empty.hidden = false;
		for ( const img of document.querySelectorAll( '.cmp-img' ) ) {
			img.removeAttribute( 'src' );
			img.alt = '';
		}
		$( '#ex-stage-cta' ).hidden = ! r.threejsUrl;
		if ( r.threejsUrl ) $( '#ex-stage-cta' ).href = r.threejsUrl;
		updateNotes( r );
		updateStats( r );
		updateNav();
		return;
	}
	empty.hidden = true;

	// Wire all image elements (slider top/bottom, split left/right, solo).
	// In slider: bottom = replay (revealed by default at 50%), top (clipped from left) = capture.
	const sliderTop = $( '#cmp-slider-top' );        // capture (clipped)
	const sliderBottom = $( '#cmp-slider-bottom' );  // replay (full)
	const splitLeft = $( '#cmp-split-left' );        // capture
	const splitRight = $( '#cmp-split-right' );      // replay
	const soloImg = $( '#cmp-solo-img' );
	const captureAlt = comparisonImageAlt( r.displayName, COMPARISON_SIDE.CAPTURE );
	const replayAlt = comparisonImageAlt( r.displayName, COMPARISON_SIDE.REPLAY );

	sliderTop.alt = captureSrc ? captureAlt : '';
	sliderBottom.alt = replaySrc ? replayAlt : '';
	splitLeft.alt = captureSrc ? captureAlt : '';
	splitRight.alt = replaySrc ? replayAlt : '';
	$( '#cmp-handle' ).setAttribute( 'aria-label', `Live three.js reveal for ${ r.displayName }` );
	if ( captureSrc ) sliderTop.src = captureSrc; else sliderTop.removeAttribute( 'src' );
	if ( replaySrc ) sliderBottom.src = replaySrc; else sliderBottom.removeAttribute( 'src' );
	if ( captureSrc ) splitLeft.src = captureSrc; else splitLeft.removeAttribute( 'src' );
	if ( replaySrc ) splitRight.src = replaySrc; else splitRight.removeAttribute( 'src' );

	// Solo: pick the requested side, fall back to whichever exists.
	const soloFrame = resolveSoloFrame( state.soloSide, { captureSrc, replaySrc } );
	if ( soloFrame.src ) {
		state.soloSide = soloFrame.side;
		soloImg.src = soloFrame.src;
		soloImg.alt = comparisonImageAlt( r.displayName, soloFrame.side );
	} else {
		soloImg.removeAttribute( 'src' );
		soloImg.alt = '';
	}
	for ( const btn of document.querySelectorAll( '.cmp-solo-toggle [data-solo]' ) ) {
		const which = btn.dataset.solo;
		const has = which === 'replay' ? !! replaySrc : !! captureSrc;
		btn.disabled = ! has;
		btn.setAttribute( 'aria-pressed', state.soloSide === which ? 'true' : 'false' );
	}

	updateStats( r );
	updateNotes( r );

	const cta = $( '#ex-stage-cta' );
	if ( r.threejsUrl ) {
		cta.hidden = false;
		cta.href = r.threejsUrl;
	} else {
		cta.hidden = true;
	}
	$( '#ex-stage-share' ).hidden = false;

	updateNav();
}

function updateStats( r ) {
	const psnr = fmtPsnr( r.pixel );
	const stats = [
		[ 'PSNR vs three.js', psnr ],
		[ 'materials', r.materialCount ?? '—' ],
		[ 'WGSL', r.totalWgslBytes ? fmtBytes( r.totalWgslBytes ) : '—' ],
		[ 'shapes', r.materialShapes && r.materialShapes.length ? r.materialShapes.join( ', ' ) : '—' ],
	];
	$( '#ex-stage-stats' ).innerHTML = stats.map( ( [ lab, val ] ) =>
		`<div class="ex-stage-stat"><div class="ex-stage-stat-num">${escapeHtml( String( val ) )}</div><div class="ex-stage-stat-lab">${escapeHtml( lab )}</div></div>`
	).join( '' );
}

function verifiedLiveEntry( entry ) {

	if ( ! entry || entry.runtimeMode !== 'pure-slim' || entry.buildVerified !== true ) return null;
	const residue = Object.values( entry.forbiddenModuleCounts || {} ).reduce( ( total, count ) => total + Number( count || 0 ), 0 );
	return residue === 0 ? entry : null;

}

function liveEntryForCatalogue( catalogueId ) {

	return verifiedLiveEntry( state.liveManifest?.examples?.find( entry => entry.catalogueId === catalogueId ) );

}

function updateLiveAction( record ) {

	const button = $( '#ex-stage-live' );
	const entry = liveEntryForCatalogue( record.basename );
	button.hidden = ! entry;
	button.disabled = ! entry;
	button.dataset.liveId = entry?.id || '';
	if ( entry ) button.title = `Run ${ entry.title } from its compiler-free production bundle`;

}

function updateNotes( r ) {
	const notesEl = $( '#ex-stage-notes' );
	const parts = [];
	if ( r.notes ) parts.push( `<p class="ex-stage-note">${escapeHtml( r.notes )}</p>` );
	if ( r.pixel?.verdict === 'diagnostic' ) {
		parts.push( `<div class="ex-stage-note-block">
			<strong>Diagnostic, not a gated pass.</strong>
			This route publishes its capture, replay, and PSNR for inspection, while its configured pixel gate remains disabled.
		</div>` );
	} else if ( r.quality !== 'pixel-match' && r.quality !== 'visual-match' ) {
		parts.push( `<div class="ex-stage-note-block">
			<strong>Why doesn&rsquo;t this match pixel-perfect?</strong>
			The slim runtime is still hardening shadow/depth rebinding, transmission and viewport textures,
			asynchronous texture-load timing, and broad post-process render-target chains. The captured program
			runs, but visual output can diverge from live Three.js until those clusters land.
		</div>` );
	}
	if ( parts.length ) {
		notesEl.innerHTML = parts.join( '' );
		notesEl.hidden = false;
	} else {
		notesEl.hidden = true;
	}
}

function updateNav() {
	const idx = state.view.findIndex( x => x.basename === state.currentBasename );
	$( '#ex-prev' ).disabled = idx <= 0;
	$( '#ex-next' ).disabled = idx === - 1 || idx >= state.view.length - 1;
}

function selectExample( basename, opts = {} ) {
	const exists = state.data.examples.some( x => x.basename === basename );
	if ( ! exists ) return;
	state.currentBasename = basename;
	if ( opts.updateHash !== false ) {
		const hash = `#${basename}`;
		if ( location.hash !== hash ) {
			history.replaceState( null, '', hash );
		}
	}
	syncSidebarSelection( basename );
	renderStage();
	closeDrawer();
}

function rebuildView( opts = {} ) {
	const filtered = applyFilters( state.data.examples );
	state.view = defaultSort( filtered );
	state.galleryLimit = DEFAULT_GALLERY_BATCH_SIZE;
	renderActiveCatalogue();

	const stillIn = state.view.some( x => x.basename === state.currentBasename );
	if ( opts.keepSelection && stillIn ) {
		renderStage();
	} else if ( state.view.length ) {
		selectExample( state.view[ 0 ].basename, { updateHash: state.viewMode === 'compare' } );
	} else {
		state.currentBasename = null;
		renderStage();
	}
}

function bindSidebar() {
	const listEl = $( '#ex-sidebar-list' );
	listEl.addEventListener( 'toggle', event => {

		const details = event.target.closest?.( '.ex-side-group' );
		if ( details?.open ) hydrateSidebarGroup( details );

	}, true );
	listEl.addEventListener( 'click', e => {
		const a = e.target.closest( '.ex-side-item' );
		if ( ! a ) return;
		e.preventDefault();
		selectExample( a.dataset.basename );
	} );
}

function bindGallery() {

	$( '#ex-gallery' ).addEventListener( 'click', event => {

		const card = event.target.closest( '.ex-gallery-card' );
		if ( ! card || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ) return;
		event.preventDefault();
		selectExample( card.dataset.basename );
		setViewMode( 'compare', { focus: true } );

	} );

	$( '#ex-gallery-more' ).addEventListener( 'click', () => {

		state.galleryLimit = nextGalleryLimit( state.galleryLimit, state.view.length );
		renderActiveCatalogue();

	} );

}

function bindViewSwitch() {

	document.querySelector( '.ex-view-switch' ).addEventListener( 'click', event => {

		const button = event.target.closest( '[data-view]' );
		if ( ! button ) return;
		setViewMode( button.dataset.view, { focus: button.dataset.view === 'compare' } );

	} );

}

function bindStage() {
	$( '#ex-prev' ).addEventListener( 'click', () => {
		const idx = state.view.findIndex( x => x.basename === state.currentBasename );
		if ( idx > 0 ) selectExample( state.view[ idx - 1 ].basename );
	} );
	$( '#ex-next' ).addEventListener( 'click', () => {
		const idx = state.view.findIndex( x => x.basename === state.currentBasename );
		if ( idx >= 0 && idx < state.view.length - 1 ) selectExample( state.view[ idx + 1 ].basename );
	} );

	// Mode tabs
	document.querySelector( '.ex-mode-tabs' ).addEventListener( 'click', e => {
		const btn = e.target.closest( '[data-mode]' );
		if ( ! btn || btn.disabled ) return;
		setMode( btn.dataset.mode );
	} );

	// Solo side toggle
	document.querySelector( '.cmp-solo-toggle' ).addEventListener( 'click', e => {
		const btn = e.target.closest( '[data-solo]' );
		if ( ! btn || btn.disabled ) return;
		setSoloSide( btn.dataset.solo );
	} );

	// Copy link
	$( '#ex-stage-share' ).addEventListener( 'click', async () => {
		try {
			await navigator.clipboard.writeText( location.href );
			const btn = $( '#ex-stage-share' );
			btn.classList.add( 'is-copied' );
			const orig = btn.innerHTML;
			btn.innerHTML = '<span aria-hidden="true">✓</span> Copied';
			setTimeout( () => {
				btn.classList.remove( 'is-copied' );
				btn.innerHTML = orig;
			}, 1500 );
		} catch ( err ) {
			// Clipboard blocked; ignore silently.
		}
	} );
}

function bindSlider() {
	const slider = document.querySelector( '.cmp-slider' );
	const handle = $( '#cmp-handle' );
	if ( ! slider || ! handle ) return;

	let dragging = false;

	function updateFromClientX( clientX ) {
		const rect = slider.getBoundingClientRect();
		if ( rect.width <= 0 ) return;
		const pct = ( ( clientX - rect.left ) / rect.width ) * 100;
		setSliderPos( pct );
	}

	function onPointerDown( e ) {
		// Only react in slider mode.
		if ( state.mode !== 'slider' ) return;
		dragging = true;
		handle.setPointerCapture?.( e.pointerId );
		updateFromClientX( e.clientX );
		e.preventDefault();
	}
	function onPointerMove( e ) {
		if ( ! dragging ) return;
		updateFromClientX( e.clientX );
	}
	function onPointerUp() {
		dragging = false;
	}

	// Click anywhere on the slider (not just the handle) jumps the seam.
	slider.addEventListener( 'pointerdown', e => {
		if ( state.mode !== 'slider' ) return;
		// Skip if the press began on the handle — that's a drag, handled below.
		if ( e.target.closest( '.cmp-handle' ) ) return;
		updateFromClientX( e.clientX );
	} );

	handle.addEventListener( 'pointerdown', onPointerDown );
	window.addEventListener( 'pointermove', onPointerMove );
	window.addEventListener( 'pointerup', onPointerUp );
	window.addEventListener( 'pointercancel', onPointerUp );

	// All standard slider arrows work; Shift and PageUp/PageDown make larger jumps.
	handle.addEventListener( 'keydown', e => {
		let delta = 0;
		const step = e.shiftKey ? 10 : 2;
		if ( e.key === 'ArrowLeft' || e.key === 'ArrowDown' ) delta = - step;
		else if ( e.key === 'ArrowRight' || e.key === 'ArrowUp' ) delta = step;
		else if ( e.key === 'PageDown' ) delta = - 10;
		else if ( e.key === 'PageUp' ) delta = 10;
		else if ( e.key === 'Home' ) { setSliderPos( 0 ); e.preventDefault(); return; }
		else if ( e.key === 'End' ) { setSliderPos( 100 ); e.preventDefault(); return; }
		if ( delta ) {
			setSliderPos( state.sliderPos + delta );
			e.preventDefault();
			e.stopPropagation();
		}
	} );

	// Double-click resets to 50%.
	handle.addEventListener( 'dblclick', () => setSliderPos( 50 ) );
}

function bindKeyboard() {
	window.addEventListener( 'keydown', e => {
		if ( e.target.matches( 'input, textarea, [contenteditable="true"]' ) ) return;
		if ( state.viewMode !== 'compare' ) return;
		// Don't fight with slider-handle arrows.
		if ( e.target.closest?.( '.cmp-handle' ) ) return;
		if ( e.key === 'ArrowLeft' ) {
			$( '#ex-prev' ).click();
		} else if ( e.key === 'ArrowRight' ) {
			$( '#ex-next' ).click();
		} else if ( e.key === '1' ) {
			setMode( 'slider' );
		} else if ( e.key === '2' ) {
			setMode( 'split' );
		} else if ( e.key === '3' ) {
			setMode( 'solo' );
		}
	} );
}

function bindSearch() {
	const search = $( '#ex-search' );
	search.addEventListener( 'input', () => {
		state.query = search.value.trim();
		rebuildView( { keepSelection: true } );
	} );
}

function bindHash() {
	window.addEventListener( 'hashchange', () => {
		const basename = decodeURIComponent( location.hash.replace( /^#/, '' ) );
		if ( basename ) {
			setViewMode( 'compare' );
			if ( basename !== state.currentBasename ) selectExample( basename, { updateHash: false } );
		}
	} );
}

function openDrawer() {
	$( '#ex-sidebar' ).classList.add( 'is-open' );
	$( '#ex-drawer-toggle' ).setAttribute( 'aria-expanded', 'true' );
}

function closeDrawer() {
	$( '#ex-sidebar' ).classList.remove( 'is-open' );
	$( '#ex-drawer-toggle' ).setAttribute( 'aria-expanded', 'false' );
}

function bindDrawer() {
	$( '#ex-drawer-toggle' ).addEventListener( 'click', () => {
		const open = $( '#ex-sidebar' ).classList.toggle( 'is-open' );
		$( '#ex-drawer-toggle' ).setAttribute( 'aria-expanded', open ? 'true' : 'false' );
	} );
}

function bindLivePlayer( manifest ) {
	const container = $( '#ex-live-canary' );
	const openButton = $( '#ex-live-open' );
	const stageButton = $( '#ex-stage-live' );
	const dialog = $( '#ex-live-dialog' );
	const frame = $( '#ex-live-frame' );
	const status = $( '#ex-live-status' );
	const direct = $( '#ex-live-direct' );
	const canary = verifiedLiveEntry( manifest?.examples?.find( entry => entry.role === 'canary' ) );

	if ( ! canary ) {
		container.dataset.unavailable = 'true';
		openButton.textContent = 'Compiled route unavailable';
	} else {
		openButton.disabled = false;
		openButton.textContent = 'Run production canary';
	}

	function openEntry( entry ) {

		const verified = verifiedLiveEntry( entry );
		if ( ! verified ) return;
		const route = new URL( verified.playUrl, document.baseURI );
		const residue = Object.values( verified.forbiddenModuleCounts || {} ).reduce( ( total, count ) => total + Number( count || 0 ), 0 );
		direct.href = route.href;
		$( '#ex-live-title' ).textContent = verified.title;
		$( '#ex-live-meta' ).innerHTML = [
			[ 'mode', verified.runtimeMode ],
			[ 'bundle', fmtBytes( verified.bundleBytes ) ],
			[ 'Three.js', verified.threeVersion ],
			[ 'compiler modules', residue ],
		].map( ( [ label, value ] ) => `<div><strong>${escapeHtml( String( value ) )}</strong><span>${escapeHtml( label )}</span></div>` ).join( '' );
		status.className = 'ex-live-status';
		status.textContent = 'Starting WebGPU and hydrating the compiled artifact…';
		frame.src = route.href;
		dialog.showModal();

	}

	if ( canary ) openButton.addEventListener( 'click', () => openEntry( canary ) );
	stageButton.addEventListener( 'click', () => {

		const entry = manifest?.examples?.find( item => item.id === stageButton.dataset.liveId );
		openEntry( entry );

	} );
	$( '#ex-free-grid' )?.addEventListener( 'click', event => {

		const button = event.target.closest( '[data-free-live-id]' );
		if ( ! button ) return;
		const entry = manifest?.examples?.find( item => item.id === button.dataset.freeLiveId );
		openEntry( entry );

	} );

	window.addEventListener( 'message', event => {
		if ( event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.type !== 'tslp-example-status' ) return;
		const result = event.data.result || {};
		if ( result.errors?.length ) {
			status.className = 'ex-live-status is-error';
			status.textContent = `Runtime error: ${result.errors[ 0 ]}`;
		} else if ( result.ready && result.compilerFree ) {
			status.className = 'ex-live-status is-ready';
			status.textContent = `Running compiled TSL · ${result.canvasCount} canvas · ${result.animationFrames} animation frames`;
		}
	} );

	dialog.addEventListener( 'close', () => {
		frame.src = 'about:blank';
		status.className = 'ex-live-status';
		status.textContent = 'Stopped — the WebGPU context was released.';
	} );
}

async function init() {
	const stageTitle = $( '#ex-stage-title' );
	stageTitle.textContent = 'Loading…';

	let data;
	let liveManifest = null;
	try {

		const res = await fetch( new URL( 'examples.json', document.baseURI ) );
		if ( ! res.ok ) throw new Error( `HTTP ${res.status}` );
		data = await res.json();

	} catch ( err ) {

		stageTitle.textContent = `Failed to load examples.json (${err.message}).`;
		return;

	}
	try {

		const liveRes = await fetch( new URL( 'live-examples.json', document.baseURI ) );
		const contentType = liveRes.headers.get( 'content-type' ) || '';
		if ( liveRes.ok && contentType.includes( 'application/json' ) ) liveManifest = await liveRes.json();

	} catch ( _ ) {

		// The generated live routes are optional. Static capture/replay evidence
		// remains usable when that separate production build is unavailable.

	}
	state.data = data;
	state.liveManifest = liveManifest;
	const coverageVerdicts = data.coverageVerdicts ?? {};

	renderMetrics( data.totals, coverageVerdicts );
	renderLiveMetrics( data.examples );
	renderFreeExamples();
	renderTierBar( coverageVerdicts );
	renderChips( data.categories, data.totals, data.examples );
	bindSidebar();
	bindGallery();
	bindViewSwitch();
	bindStage();
	bindSlider();
	bindSearch();
	bindKeyboard();
	bindHash();
	bindDrawer();
	bindLivePlayer( liveManifest );

	// Initial seam position
	setSliderPos( 50 );

	const filtered = applyFilters( data.examples );
	state.view = defaultSort( filtered );
	renderActiveCatalogue();

	const hashBasename = decodeURIComponent( location.hash.replace( /^#/, '' ) );
	const hashHit = hashBasename && data.examples.some( x => x.basename === hashBasename );
	const initial = hashHit ? hashBasename : ( state.view[ 0 ]?.basename ?? null );
	if ( hashHit ) setViewMode( 'compare' );
	if ( initial ) selectExample( initial, { updateHash: false } );
	else renderStage();
}

init();
