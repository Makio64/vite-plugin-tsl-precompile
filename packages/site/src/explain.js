/* Explainer page — scroll-reveal + staggered child reveals.
   Schemas animate via CSS. */

const reduceMotion = matchMedia( '(prefers-reduced-motion: reduce)' ).matches;

/* set --i on each child of .reveal-stagger so the CSS can stagger transitions */
document.querySelectorAll( '.reveal-stagger' ).forEach( ( group ) => {
	Array.from( group.children ).forEach( ( child, i ) => {
		child.style.setProperty( '--i', i );
	} );
} );

const revealEls = document.querySelectorAll( '.reveal, .reveal-stagger' );

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
