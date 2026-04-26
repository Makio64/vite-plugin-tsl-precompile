import { startHeroShader } from './shader-bg.js';

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

/* ---------- hero shader background ---------- */
if ( ! reduceMotion ) {
	startHeroShader().catch( ( err ) => {
		// Fallback CSS gradient is already painted by .hero-fallback —
		// quietly log and move on. The page must never visibly break on
		// non-WebGPU browsers.
		console.info( '[site] hero shader skipped:', err?.message ?? err );
	} );
}
