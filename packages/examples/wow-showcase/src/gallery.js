import { SITES } from './sites.js';

const grid = document.querySelector( '[data-gallery-grid]' );
if ( ! grid ) throw new Error( '[wow-showcase] Missing gallery grid.' );

grid.innerHTML = SITES.map( ( site, index ) => `
	<a class="world-card" href="./${ site.id }.html"
		style="--card-bg:${ site.palette.background };--card-accent:${ site.palette.accent };--card-accent-2:${ site.palette.accent2 || site.palette.secondary }">
		<span class="world-card-index">${ String( index + 1 ).padStart( 2, '0' ) }</span>
		<span class="world-card-orbit" aria-hidden="true"><i></i><i></i><i></i></span>
		<span class="world-card-copy">
			<small>${ site.eyebrow }</small>
			<strong>${ site.title }</strong>
			<em>${ site.description }</em>
		</span>
		<span class="world-card-arrow">↗</span>
	</a>
` ).join( '' );

for ( const card of grid.querySelectorAll( '.world-card' ) ) {

	card.addEventListener( 'pointermove', event => {

		const bounds = card.getBoundingClientRect();
		card.style.setProperty( '--mx', `${ event.clientX - bounds.left }px` );
		card.style.setProperty( '--my', `${ event.clientY - bounds.top }px` );

	} );

}

requestAnimationFrame( () => document.documentElement.classList.add( 'is-ready' ) );
