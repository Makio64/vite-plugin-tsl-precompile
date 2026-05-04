// Examples gallery controller. Reads /examples.json, renders cards, handles
// filter / sort / search / modal. Vanilla DOM, no framework — matches the rest
// of the site.

const FEATURED_CHIPS = [
	{ id: 'pixel-match', label: 'Pixel-match' },
];

const TIER_LABEL = {
	'pixel-match': 'Pixel-match',
	'visual-match': 'Visual-match',
	'renders': 'Renders',
	'capture-only': 'Capture only',
};

const TIER_RANK = { 'pixel-match': 0, 'visual-match': 1, 'renders': 2, 'capture-only': 3 };

const state = {
	data: null,
	filter: 'all',
	sort: 'featured',
	query: '',
	showHidden: false,
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

function fmtCount( n, label ) {
	if ( n == null || n === 0 ) return null;
	return `${n} ${label}`;
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
	const all = [
		{ id: 'all', label: 'All', count: totals.examplesProcessed },
		...FEATURED_CHIPS.map( c => ( {
			id: c.id, label: c.label,
			count: c.id === 'pixel-match' ? totals.pixelMatchCount : 0,
		} ) ),
		...categories,
	];
	chipsEl.innerHTML = all.map( c => {
		const sel = state.filter === c.id ? 'true' : 'false';
		return `<button type="button" role="tab" aria-selected="${sel}" class="ex-chip" data-filter="${escapeHtml( c.id )}">
			<span>${escapeHtml( c.label )}</span>
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
		renderGrid();
	} );
}

function applyFilters( examples ) {
	let xs = examples;
	if ( ! state.showHidden ) xs = xs.filter( r => r.thumbHealth === 'ok' );
	if ( state.filter === 'pixel-match' ) {
		xs = xs.filter( r => r.badge === 'pixel-match' );
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

function applySort( xs ) {
	const sorted = xs.slice();
	switch ( state.sort ) {
		case 'name':
			sorted.sort( ( a, b ) => a.basename.localeCompare( b.basename ) );
			break;
		case 'psnr':
			sorted.sort( ( a, b ) => effectivePsnr( b.pixel ) - effectivePsnr( a.pixel ) );
			break;
		case 'psnr-asc':
			sorted.sort( ( a, b ) => {
				const av = a.pixel.identical ? 1e6 : ( a.pixel.psnr ?? 9e9 );
				const bv = b.pixel.identical ? 1e6 : ( b.pixel.psnr ?? 9e9 );
				return av - bv;
			} );
			break;
		case 'materials':
			sorted.sort( ( a, b ) => ( b.materialCount ?? 0 ) - ( a.materialCount ?? 0 ) );
			break;
		default:
			// 'featured' — already in JSON in most-impressive order; preserve.
			sorted.sort( ( a, b ) => {
				const ta = TIER_RANK[ a.badge ] ?? 9;
				const tb = TIER_RANK[ b.badge ] ?? 9;
				if ( ta !== tb ) return ta - tb;
				return effectivePsnr( b.pixel ) - effectivePsnr( a.pixel );
			} );
	}
	return sorted;
}

function cardHtml( r ) {
	const tier = TIER_LABEL[ r.badge ] ?? r.badge;
	const psnr = fmtPsnr( r.pixel );
	const stats = [
		fmtCount( r.materialCount, 'mat' ),
		r.totalWgslBytes ? `${fmtBytes( r.totalWgslBytes )} WGSL` : null,
		r.hasCompute ? 'compute' : null,
	].filter( Boolean ).join( ' · ' );
	const thumb = r.thumbReplay
		? `<img class="ex-card-thumb" src="${escapeHtml( r.thumbReplay )}" alt="${escapeHtml( r.displayName )} replay" loading="lazy" decoding="async" width="320" height="240">`
		: `<div class="ex-card-thumb ex-card-thumb-empty">no replay frame</div>`;
	return `
		<article class="ex-card" data-basename="${escapeHtml( r.basename )}" tabindex="0">
			<a class="ex-card-link" href="${escapeHtml( r.threejsUrl )}" rel="noopener" aria-label="View original on threejs.org" title="View original on threejs.org">↗</a>
			${thumb}
			<div class="ex-card-meta">
				<span class="ex-card-cat">${escapeHtml( r.categoryLabel )}</span>
				<span class="ex-card-title">
					<span class="ex-card-title-text">${escapeHtml( r.displayName )}</span>
					<span class="ex-dot ex-dot-${escapeHtml( r.badge )}" title="${escapeHtml( tier )} · ${escapeHtml( psnr )}"></span>
				</span>
				${stats ? `<span class="ex-card-stats"><span class="ex-card-stat">${escapeHtml( stats )}</span></span>` : ''}
			</div>
		</article>
	`;
}

function renderGrid() {
	const grid = $( '#ex-grid' );
	const filtered = applyFilters( state.data.examples );
	const sorted = applySort( filtered );

	grid.innerHTML = sorted.map( cardHtml ).join( '' );
	$( '#ex-empty' ).hidden = sorted.length > 0;

	// Hidden-blanks toggle.
	const hidden = state.data.examples.filter( r => r.thumbHealth !== 'ok' );
	const toggle = $( '#ex-hidden-toggle' );
	if ( hidden.length && state.filter === 'all' && ! state.query ) {
		toggle.hidden = false;
		const btn = toggle.querySelector( 'button' );
		const span = btn.querySelector( '[data-hidden-count]' );
		span.textContent = hidden.length;
		btn.textContent = state.showHidden
			? `− Hide ${hidden.length} captures with no replay`
			: `+ Show ${hidden.length} captures with no replay`;
	} else {
		toggle.hidden = true;
	}
}

// ---------- modal ----------

function modalBodyHtml( r ) {
	const tier = TIER_LABEL[ r.badge ] ?? r.badge;
	const psnr = fmtPsnr( r.pixel );
	const captureSrc = r.thumbCaptureModal ?? r.thumbCapture;
	const replaySrc = r.thumbReplayModal ?? r.thumbReplay;
	const stats = [
		[ 'materials', r.materialCount ?? '—' ],
		[ 'WGSL', r.totalWgslBytes ? fmtBytes( r.totalWgslBytes ) : '—' ],
		[ 'shaders', r.materialShapes && r.materialShapes.length ? r.materialShapes.join( ', ' ) : '—' ],
		[ 'PSNR vs three.js', psnr ],
	];

	const compareHtml = `
		<div class="ex-modal-compare">
			<figure class="ex-modal-pane">
				${captureSrc ? `<img src="${escapeHtml( captureSrc )}" alt="${escapeHtml( r.displayName )} live three.js capture" loading="eager">` : '<div style="aspect-ratio:4/3"></div>'}
				<figcaption class="ex-modal-pane-label"><strong>Live three.js</strong> &middot; full TSL node builder</figcaption>
			</figure>
			<figure class="ex-modal-pane">
				${replaySrc ? `<img src="${escapeHtml( replaySrc )}" alt="${escapeHtml( r.displayName )} slim runtime replay" loading="eager">` : '<div style="aspect-ratio:4/3;display:flex;align-items:center;justify-content:center;color:var(--muted);font-family:var(--font-mono);font-size:.85rem">no replay frame</div>'}
				<figcaption class="ex-modal-pane-label"><strong>vite-plugin-tsl-precompile</strong> &middot; slim runtime replay</figcaption>
			</figure>
		</div>
	`;

	const statsHtml = `
		<div class="ex-modal-stats">
			${stats.map( ( [ lab, val ] ) => `<div><div class="ex-modal-stat-num">${escapeHtml( String( val ) )}</div><div class="ex-modal-stat-lab">${escapeHtml( lab )}</div></div>` ).join( '' )}
		</div>
	`;

	const noteHtml = r.notes
		? `<p class="ex-modal-notes">${escapeHtml( r.notes )}</p>`
		: '';

	const explainerHtml = r.badge === 'pixel-match'
		? ''
		: `<div class="ex-modal-note-block">
			<strong>Why doesn&rsquo;t this match pixel-perfect?</strong>
			The slim runtime is still wiring through PMREM environment maps, asynchronous texture-load timing,
			and post-process render-target chains. The shader compiles and runs &mdash; visual output diverges
			from live three.js until those clusters land.
			Track progress in <a href="https://github.com/Makio64/vite-plugin-tsl-precompile/blob/main/ROADMAP.md" rel="noopener">ROADMAP.md</a>.
		</div>`;

	return `
		<div class="ex-modal-cat">${escapeHtml( r.categoryLabel )}</div>
		<div class="ex-modal-title">
			<h2>${escapeHtml( r.displayName )}</h2>
			<span class="ex-modal-badge"><span class="ex-dot ex-dot-${escapeHtml( r.badge )}"></span>${escapeHtml( tier )} &middot; ${escapeHtml( psnr )}</span>
		</div>
		${compareHtml}
		${statsHtml}
		<a class="ex-modal-cta" href="${escapeHtml( r.threejsUrl )}" rel="noopener">View original on threejs.org &rarr;</a>
		${noteHtml}
		${explainerHtml}
	`;
}

function openModal( basename ) {
	const r = state.data.examples.find( x => x.basename === basename );
	if ( ! r ) return;
	$( '#ex-modal-body' ).innerHTML = modalBodyHtml( r );
	const modal = $( '#ex-modal' );
	if ( typeof modal.showModal === 'function' ) modal.showModal();
	else modal.setAttribute( 'open', '' );
}

function bindModal() {
	const modal = $( '#ex-modal' );
	modal.addEventListener( 'click', e => {
		// click on backdrop (the dialog itself, not the body) closes
		if ( e.target === modal ) modal.close();
	} );
}

function bindGridInteractions() {
	const grid = $( '#ex-grid' );
	grid.addEventListener( 'click', e => {
		// Don't trigger modal when the ↗ link is clicked.
		if ( e.target.closest( '.ex-card-link' ) ) return;
		const card = e.target.closest( '.ex-card' );
		if ( ! card ) return;
		openModal( card.dataset.basename );
	} );
	grid.addEventListener( 'keydown', e => {
		if ( e.key !== 'Enter' && e.key !== ' ' ) return;
		const card = e.target.closest( '.ex-card' );
		if ( ! card ) return;
		e.preventDefault();
		openModal( card.dataset.basename );
	} );
}

function bindControls() {
	const search = $( '#ex-search' );
	search.addEventListener( 'input', () => {
		state.query = search.value.trim();
		renderGrid();
	} );

	const sort = $( '#ex-sort' );
	sort.addEventListener( 'change', () => {
		state.sort = sort.value;
		renderGrid();
	} );

	const toggleBtn = $( '#ex-show-hidden' );
	toggleBtn.addEventListener( 'click', () => {
		state.showHidden = ! state.showHidden;
		renderGrid();
	} );
}

async function init() {
	const grid = $( '#ex-grid' );
	grid.textContent = 'Loading…';
	let data;
	try {
		const res = await fetch( new URL( 'examples.json', document.baseURI ) );
		if ( ! res.ok ) throw new Error( `HTTP ${res.status}` );
		data = await res.json();
	} catch ( err ) {
		grid.textContent = `Failed to load examples.json (${err.message}).`;
		return;
	}
	state.data = data;

	renderMetrics( data.totals );
	renderChips( data.categories, data.totals );
	bindGridInteractions();
	bindControls();
	bindModal();
	renderGrid();
}

init();
