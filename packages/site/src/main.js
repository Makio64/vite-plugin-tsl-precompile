const reduceMotion = matchMedia( '(prefers-reduced-motion: reduce)' ).matches;

/* ---------- scroll reveal ---------- */
const revealEls = document.querySelectorAll( '.reveal' );
if ( reduceMotion || ! ( 'IntersectionObserver' in window ) ) {
	revealEls.forEach( ( el ) => el.classList.add( 'is-visible' ) );
} else {
	const io = new IntersectionObserver( ( entries ) => {
		for ( const entry of entries ) {
			if ( entry.isIntersecting ) {
				entry.target.classList.add( 'is-visible' );
				io.unobserve( entry.target );
			}
		}
	}, { rootMargin: '0px 0px -10% 0px', threshold: 0.05 } );
	revealEls.forEach( ( el ) => io.observe( el ) );
}

/* ---------- copy to clipboard ---------- */
document.querySelectorAll( '[data-copy]' ).forEach( ( btn ) => {
	btn.addEventListener( 'click', async () => {
		const pre = btn.parentElement?.querySelector( 'pre' );
		if ( ! pre ) return;
		const text = pre.innerText.trim();
		try {
			await navigator.clipboard.writeText( text );
			btn.textContent = 'copied';
			btn.classList.add( 'copied' );
			setTimeout( () => {
				btn.textContent = 'copy';
				btn.classList.remove( 'copied' );
			}, 1400 );
		} catch {
			btn.textContent = 'failed';
			setTimeout( () => ( btn.textContent = 'copy' ), 1400 );
		}
	} );
} );

/* ---------- generated compatibility evidence ---------- */
async function hydrateEvidence() {

	const targets = document.querySelectorAll( '[data-stat]' );
	if ( targets.length === 0 ) return;

	try {

		const response = await fetch( new URL( 'examples.json', document.baseURI ) );
		if ( ! response.ok ) return;
		const data = await response.json();
		const totals = data && data.totals;
		if ( ! totals || typeof totals !== 'object' ) return;

		targets.forEach( ( target ) => {

			const key = target.dataset.stat;
			const value = totals[ key ];
			if ( typeof value !== 'number' || ! Number.isFinite( value ) ) return;
			target.textContent = key === 'smokePassRate' ? value.toFixed( 1 ) : value.toLocaleString( 'en-US' );

		} );

	} catch ( _ ) {

		// The checked-in fallback values remain visible when evidence data is
		// unavailable (for example when the HTML is opened directly from disk).

	}

}

hydrateEvidence();
