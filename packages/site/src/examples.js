// Examples browser. Reads /examples.json, renders sidebar list + main stage,
// handles filter / search / hash routing / prev-next / keyboard nav.
// Vanilla DOM, no framework — matches the rest of the site.

const TIER_LABEL = {
	'pixel-match': 'Pixel-match',
	'visual-match': 'Visual-match',
	'renders': 'Renders',
	'capture-only': 'Capture only',
};

const TIER_RANK = { 'pixel-match': 0, 'visual-match': 1, 'renders': 2, 'capture-only': 3 };

const TIER_CHIPS = [
	{ id: 'pixel-match', totalsKey: 'pixelMatchCount' },
	{ id: 'visual-match', totalsKey: 'visualMatchCount' },
	{ id: 'renders', totalsKey: 'rendersCount' },
	{ id: 'capture-only', totalsKey: 'captureOnlyCount' },
];

const state = {
	data: null,
	filter: 'all',
	query: '',
	view: [],            // currently filtered+sorted array (the prev/next walk path)
	currentBasename: null,
	stageView: 'replay', // 'replay' | 'capture'
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

function renderMetrics( totals ) {
	const map = {
		examplesProcessed: totals.examplesProcessed,
		materialsBaked: totals.materialsBaked,
		wgslKb: `${Math.round( totals.wgslBytes / 1024 )} KB`,
		smokePassRate: `${totals.smokePassRate}%`,
		pixelMatchCount: totals.pixelMatchCount,
	};
	for ( const el of document.querySelectorAll( '[data-key]' ) ) {
		const k = el.getAttribute( 'data-key' );
		if ( map[ k ] != null ) el.textContent = map[ k ];
	}
}

function renderChips( categories, totals ) {
	const chipsEl = $( '#ex-chips' );
	const tierChips = TIER_CHIPS.map( c => ( {
		id: c.id,
		label: TIER_LABEL[ c.id ],
		count: totals[ c.totalsKey ] ?? 0,
		tier: true,
	} ) );
	const all = [
		{ id: 'all', label: 'All', count: totals.examplesProcessed },
		...tierChips,
		...categories,
	];
	chipsEl.innerHTML = all.map( c => {
		const sel = state.filter === c.id ? 'true' : 'false';
		const dot = c.tier ? `<span class="ex-dot ex-dot-${escapeHtml( c.id )}" aria-hidden="true"></span>` : '';
		return `<button type="button" role="tab" aria-selected="${sel}" class="ex-chip${c.tier ? ' ex-chip-tier' : ''}" data-filter="${escapeHtml( c.id )}">
			${dot}<span>${escapeHtml( c.label )}</span>
			<span class="ex-chip-count">${c.count}</span>
		</button>`;
	} ).join( '' );

	chipsEl.addEventListener( 'click', e => {
		const btn = e.target.closest( '.ex-chip' );
		if ( ! btn ) return;
		state.filter = btn.dataset.filter;
		for ( const c of chipsEl.querySelectorAll( '.ex-chip' ) ) {
			c.setAttribute( 'aria-selected', c === btn ? 'true' : 'false' );
		}
		rebuildView( { keepSelection: true } );
	} );
}

function applyFilters( examples ) {
	let xs = examples;
	const isTierFilter = state.filter in TIER_LABEL;
	// Capture-only entries have thumbHealth !== 'ok'; surface them when that tier is selected.
	if ( state.filter !== 'capture-only' ) xs = xs.filter( r => r.thumbHealth === 'ok' );
	if ( isTierFilter ) {
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
	// "Featured-style": tier rank first, then PSNR descending. Same as the
	// previous gallery default — gives a stable, useful ordering for the sidebar.
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
	// Preserve sort order within each category bucket, but emit categories in
	// the order they first appear in `xs` so the sidebar reads top-down in the
	// same order the sorted list ranks them.
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

	// Don't group when the user is searching or filtering by tier — the result
	// set is small and a flat list reads better.
	const flat = state.query || state.filter in TIER_LABEL;
	const groups = flat
		? [ { id: '__flat__', label: null, items: state.view } ]
		: groupByCategory( state.view );

	listEl.innerHTML = groups.map( g => {
		const items = g.items.map( r => {
			const isCurrent = r.basename === state.currentBasename;
			return `<a class="ex-side-item${isCurrent ? ' is-current' : ''}"
				href="#${escapeHtml( r.basename )}"
				data-basename="${escapeHtml( r.basename )}"
				aria-current="${isCurrent ? 'true' : 'false'}">
				<span class="ex-dot ex-dot-${escapeHtml( r.badge )}" aria-hidden="true"></span>
				<span class="ex-side-name">${escapeHtml( r.displayName )}</span>
			</a>`;
		} ).join( '' );

		if ( g.label === null ) return `<div class="ex-side-flat">${items}</div>`;
		return `<details class="ex-side-group" open>
			<summary class="ex-side-group-summary">
				<span>${escapeHtml( g.label )}</span>
				<span class="ex-side-group-count">${g.items.length}</span>
			</summary>
			<div class="ex-side-group-items">${items}</div>
		</details>`;
	} ).join( '' );

	// Scroll the current item into view inside the sidebar.
	const current = listEl.querySelector( '.is-current' );
	if ( current ) current.scrollIntoView( { block: 'nearest', behavior: 'auto' } );
}

function renderStage() {
	const r = state.data.examples.find( x => x.basename === state.currentBasename );
	const stage = $( '#ex-stage' );
	if ( ! r ) {
		stage.dataset.empty = 'true';
		$( '#ex-stage-title' ).textContent = 'No example selected';
		$( '#ex-stage-cat' ).textContent = '—';
		$( '#ex-stage-badge' ).innerHTML = '';
		$( '#ex-stage-stats' ).innerHTML = '';
		$( '#ex-stage-cta' ).hidden = true;
		$( '#ex-stage-empty' ).hidden = false;
		$( '#ex-stage-view' ).removeAttribute( 'src' );
		return;
	}
	stage.dataset.empty = 'false';

	$( '#ex-stage-title' ).textContent = r.displayName;
	$( '#ex-stage-cat' ).textContent = r.categoryLabel;

	const tier = TIER_LABEL[ r.badge ] ?? r.badge;
	const psnr = fmtPsnr( r.pixel );
	$( '#ex-stage-badge' ).innerHTML = `<span class="ex-dot ex-dot-${escapeHtml( r.badge )}"></span>${escapeHtml( tier )} &middot; ${escapeHtml( psnr )}`;

	// Image source — pick replay vs capture per current toggle, fall back to whichever exists.
	const replaySrc = r.thumbReplayModal ?? r.thumbReplay;
	const captureSrc = r.thumbCaptureModal ?? r.thumbCapture;
	const wantReplay = state.stageView === 'replay';
	const src = ( wantReplay ? replaySrc : captureSrc ) ?? replaySrc ?? captureSrc;
	const view = $( '#ex-stage-view' );
	const empty = $( '#ex-stage-empty' );
	if ( src ) {
		view.src = src;
		view.alt = `${r.displayName} — ${wantReplay ? 'slim runtime replay' : 'live three.js capture'}`;
		view.hidden = false;
		empty.hidden = true;
	} else {
		view.removeAttribute( 'src' );
		view.hidden = true;
		empty.hidden = false;
	}

	// Per-toggle availability indicator.
	for ( const btn of document.querySelectorAll( '.ex-stage-toggle [data-view]' ) ) {
		const which = btn.dataset.view;
		const has = which === 'replay' ? !! replaySrc : !! captureSrc;
		btn.disabled = ! has;
		btn.setAttribute( 'aria-selected', state.stageView === which ? 'true' : 'false' );
	}

	// Stats row.
	const stats = [
		[ 'PSNR vs three.js', psnr ],
		[ 'materials', r.materialCount ?? '—' ],
		[ 'WGSL', r.totalWgslBytes ? fmtBytes( r.totalWgslBytes ) : '—' ],
		[ 'shapes', r.materialShapes && r.materialShapes.length ? r.materialShapes.join( ', ' ) : '—' ],
	];
	$( '#ex-stage-stats' ).innerHTML = stats.map( ( [ lab, val ] ) =>
		`<div class="ex-stage-stat"><div class="ex-stage-stat-num">${escapeHtml( String( val ) )}</div><div class="ex-stage-stat-lab">${escapeHtml( lab )}</div></div>`
	).join( '' );

	const cta = $( '#ex-stage-cta' );
	if ( r.threejsUrl ) {
		cta.hidden = false;
		cta.href = r.threejsUrl;
	} else {
		cta.hidden = true;
	}

	// Notes / explainer block.
	const notesEl = $( '#ex-stage-notes' );
	const parts = [];
	if ( r.notes ) parts.push( `<p class="ex-stage-note">${escapeHtml( r.notes )}</p>` );
	if ( r.badge !== 'pixel-match' ) {
		parts.push( `<div class="ex-stage-note-block">
			<strong>Why doesn&rsquo;t this match pixel-perfect?</strong>
			The slim runtime is still wiring through PMREM environment maps, asynchronous texture-load timing,
			and post-process render-target chains. The shader compiles and runs &mdash; visual output diverges
			from live three.js until those clusters land.
			Track progress in <a href="https://github.com/Makio64/vite-plugin-tsl-precompile/blob/main/ROADMAP.md" rel="noopener">ROADMAP.md</a>.
		</div>` );
	}
	if ( parts.length ) {
		notesEl.innerHTML = parts.join( '' );
		notesEl.hidden = false;
	} else {
		notesEl.hidden = true;
	}

	// Prev/Next state.
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
	// Mark sidebar selection without re-rendering the whole list.
	for ( const a of document.querySelectorAll( '.ex-side-item' ) ) {
		const isCurrent = a.dataset.basename === basename;
		a.classList.toggle( 'is-current', isCurrent );
		a.setAttribute( 'aria-current', isCurrent ? 'true' : 'false' );
	}
	const current = document.querySelector( '.ex-side-item.is-current' );
	if ( current ) current.scrollIntoView( { block: 'nearest', behavior: 'auto' } );
	renderStage();
	closeDrawer();
}

function rebuildView( opts = {} ) {
	const filtered = applyFilters( state.data.examples );
	state.view = defaultSort( filtered );
	renderSidebar();

	// Pick a selection: keep the current one if still in view, else fall back to first.
	const stillIn = state.view.some( x => x.basename === state.currentBasename );
	if ( opts.keepSelection && stillIn ) {
		renderStage();
	} else if ( state.view.length ) {
		selectExample( state.view[ 0 ].basename );
	} else {
		state.currentBasename = null;
		renderStage();
	}
}

function bindSidebar() {
	const listEl = $( '#ex-sidebar-list' );
	listEl.addEventListener( 'click', e => {
		const a = e.target.closest( '.ex-side-item' );
		if ( ! a ) return;
		e.preventDefault();
		selectExample( a.dataset.basename );
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

	const toggle = document.querySelector( '.ex-stage-toggle' );
	toggle.addEventListener( 'click', e => {
		const btn = e.target.closest( '[data-view]' );
		if ( ! btn || btn.disabled ) return;
		state.stageView = btn.dataset.view;
		renderStage();
	} );
}

function bindKeyboard() {
	window.addEventListener( 'keydown', e => {
		if ( e.target.matches( 'input, textarea, [contenteditable="true"]' ) ) return;
		if ( e.key === 'ArrowLeft' ) {
			$( '#ex-prev' ).click();
		} else if ( e.key === 'ArrowRight' ) {
			$( '#ex-next' ).click();
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
		if ( basename && basename !== state.currentBasename ) {
			selectExample( basename, { updateHash: false } );
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

async function init() {
	const stageTitle = $( '#ex-stage-title' );
	stageTitle.textContent = 'Loading…';

	let data;
	try {
		const res = await fetch( new URL( 'examples.json', document.baseURI ) );
		if ( ! res.ok ) throw new Error( `HTTP ${res.status}` );
		data = await res.json();
	} catch ( err ) {
		stageTitle.textContent = `Failed to load examples.json (${err.message}).`;
		return;
	}
	state.data = data;

	$( '#ex-drawer-count' ).textContent = data.totals.examplesProcessed;

	renderMetrics( data.totals );
	renderChips( data.categories, data.totals );
	bindSidebar();
	bindStage();
	bindSearch();
	bindKeyboard();
	bindHash();
	bindDrawer();

	// Build view, then honor URL hash if present and valid.
	const filtered = applyFilters( data.examples );
	state.view = defaultSort( filtered );
	renderSidebar();

	const hashBasename = decodeURIComponent( location.hash.replace( /^#/, '' ) );
	const hashHit = hashBasename && data.examples.some( x => x.basename === hashBasename );
	const initial = hashHit ? hashBasename : ( state.view[ 0 ]?.basename ?? null );
	if ( initial ) selectExample( initial, { updateHash: ! hashHit } );
	else renderStage();
}

init();
