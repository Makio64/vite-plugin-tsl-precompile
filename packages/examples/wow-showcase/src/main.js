import * as ThreeRuntime from 'three/webgpu';
import { WebGPURenderer } from 'three/webgpu';
import { setupPrecompile } from '@tsl-precompile/runtime/setup';

import { createShowcaseScene } from './scene.js';
import { getSite, SITES } from './sites.js';

const siteId = document.documentElement.dataset.site || document.body.dataset.site;
const site = getSite( siteId );
if ( ! site ) throw new Error( `[wow-showcase] Unknown site "${ siteId || '' }".` );

const result = window.__TSLP_SITE_RESULT__ = window.__TSLP_SHOWCASE__ = {
	id: site.id,
	ready: false,
	runtimeMode: ThreeRuntime.__TSLP_SLIM__ === true ? 'pure-slim' : 'capture',
	compilerFree: ThreeRuntime.__TSLP_SLIM__ === true,
	animationFrames: 0,
	canvasCount: 0,
	errors: [],
};

function publishResult() {

	if ( window.parent === window ) return;
	window.parent.postMessage( { type: 'tslp-example-status', result: { ...result } }, window.location.origin );

}

window.addEventListener( 'error', event => {

	result.errors.push( event.message || 'window error' );
	publishResult();

} );
window.addEventListener( 'unhandledrejection', event => {

	result.errors.push( String( event.reason?.message || event.reason || 'unhandled rejection' ) );
	publishResult();

} );

applyPalette( site.palette );
renderSiteChrome( site );

const stageElement = document.querySelector( '.visual-stage' );
const statusElement = document.querySelector( '[data-runtime-status]' );
const renderer = new WebGPURenderer( {
	antialias: true,
	alpha: true,
	powerPreference: 'high-performance',
} );
renderer.setPixelRatio( Math.min( window.devicePixelRatio || 1, 1.6 ) );
renderer.setSize( window.innerWidth, window.innerHeight );
renderer.domElement.setAttribute( 'aria-label', `${ site.title } interactive 3D artwork` );
stageElement.appendChild( renderer.domElement );

const setup = setupPrecompile( { renderer } );
await renderer.init();
await setup.ready;

const experience = createShowcaseScene( { renderer, site } );
const pointer = { x: 0, y: 0, targetX: 0, targetY: 0, active: false };
const reducedMotion = window.matchMedia( '(prefers-reduced-motion: reduce)' ).matches;
const startedAt = performance.now();

function onPointerMove( event ) {

	pointer.targetX = ( event.clientX / Math.max( 1, window.innerWidth ) ) * 2 - 1;
	pointer.targetY = ( event.clientY / Math.max( 1, window.innerHeight ) ) * 2 - 1;
	pointer.active = true;
	document.documentElement.style.setProperty( '--pointer-x', `${ event.clientX }px` );
	document.documentElement.style.setProperty( '--pointer-y', `${ event.clientY }px` );

}

function onResize() {

	renderer.setPixelRatio( Math.min( window.devicePixelRatio || 1, 1.6 ) );
	renderer.setSize( window.innerWidth, window.innerHeight );
	experience.resize( window.innerWidth, window.innerHeight );

}

window.addEventListener( 'pointermove', onPointerMove, { passive: true } );
window.addEventListener( 'resize', onResize, { passive: true } );
onResize();

renderer.setAnimationLoop( () => {

	const elapsed = ( performance.now() - startedAt ) / 1000;
	pointer.x += ( pointer.targetX - pointer.x ) * 0.045;
	pointer.y += ( pointer.targetY - pointer.y ) * 0.045;
	experience.tick( reducedMotion ? Math.min( elapsed, 1.25 ) : elapsed, pointer );
	renderer.render( experience.scene, experience.camera );

	result.animationFrames ++;
	result.canvasCount = stageElement.querySelectorAll( 'canvas' ).length;
	if ( ! result.ready && result.animationFrames >= 4 && result.errors.length === 0 ) {

		result.ready = true;
		document.documentElement.classList.add( 'is-ready' );
		statusElement.textContent = result.compilerFree ? 'AOT / COMPILER FREE' : 'CAPTURING LIVE TSL';
		publishResult();

	}

} );

window.addEventListener( 'pagehide', () => {

	renderer.setAnimationLoop( null );
	experience.dispose();
	renderer.dispose();

}, { once: true } );

function applyPalette( palette = {} ) {

	const root = document.documentElement;
	root.style.setProperty( '--bg', palette.background || '#090b11' );
	root.style.setProperty( '--primary', palette.primary || '#eff7ff' );
	root.style.setProperty( '--secondary', palette.secondary || '#8390a6' );
	root.style.setProperty( '--accent', palette.accent || '#75f4ff' );
	root.style.setProperty( '--accent-2', palette.accent2 || palette.secondary || '#ff5e8a' );
	root.style.colorScheme = 'dark';

}

function renderSiteChrome( current ) {

	const app = document.getElementById( 'app' );
	const index = SITES.findIndex( entry => entry.id === current.id );
	const previous = SITES[ ( index - 1 + SITES.length ) % SITES.length ];
	const next = SITES[ ( index + 1 ) % SITES.length ];
	const titleLines = current.titleLines?.length ? current.titleLines : splitTitle( current.title );
	const stats = ( current.stats || [] ).map( stat => `
		<div class="stat">
			<strong>${ escapeHtml( stat.value ) }</strong>
			<span>${ escapeHtml( stat.label ) }</span>
		</div>
	` ).join( '' );
	const ticker = ( current.ticker || [] ).map( item => `<span>${ escapeHtml( item ) }</span>` ).join( '' );
	const people = ( current.people || [] ).map( ( person, personIndex ) => `
		<li>
			<span>${ String( personIndex + 1 ).padStart( 2, '0' ) }</span>
			<strong>${ escapeHtml( person.name ) }</strong>
			<em>${ escapeHtml( person.field || person.role || '' ) }</em>
		</li>
	` ).join( '' );
	const features = people || ( current.features || [] ).map( ( item, featureIndex ) => `
		<li>
			<span>${ String( featureIndex + 1 ).padStart( 2, '0' ) }</span>
			<strong>${ escapeHtml( typeof item === 'string' ? item : item.title ) }</strong>
			<em>${ escapeHtml( typeof item === 'string' ? '' : item.detail || '' ) }</em>
		</li>
	` ).join( '' );

	app.innerHTML = `
		<div class="visual-stage" aria-hidden="true"></div>
		<div class="atmosphere" aria-hidden="true"></div>
		<div class="spotlight" aria-hidden="true"></div>
		<header class="site-header">
			<a class="brand" href="./index.html" aria-label="Open all ten experiences">
				<span class="brand-glyph">10</span>
				<span>TSL / WORLDS</span>
			</a>
			<nav class="route-dots" aria-label="Experience navigation">
				${ SITES.map( ( entry, routeIndex ) => `
					<a href="./${ entry.id }.html" aria-label="${ escapeHtml( entry.title ) }" ${ entry.id === current.id ? 'aria-current="page"' : '' }>
						${ String( routeIndex + 1 ).padStart( 2, '0' ) }
					</a>
				` ).join( '' ) }
			</nav>
			<div class="runtime-pill">
				<i></i>
				<span data-runtime-status>INITIALIZING WEBGPU</span>
			</div>
		</header>
		<section class="hero">
			<div class="hero-copy">
				<p class="eyebrow"><span>${ String( index + 1 ).padStart( 2, '0' ) }</span>${ escapeHtml( current.eyebrow ) }</p>
				<h1>${ titleLines.map( line => `<span>${ escapeHtml( line ) }</span>` ).join( '' ) }</h1>
				<p class="lede">${ escapeHtml( current.description ) }</p>
				<div class="actions">
					<a class="button button-primary" href="#details">${ escapeHtml( current.primaryCta || 'Enter experience' ) }<b>↗</b></a>
					<a class="button button-quiet" href="./${ next.id }.html">${ escapeHtml( current.secondaryCta || 'Next world' ) }<b>→</b></a>
				</div>
			</div>
			<div class="interaction-note" aria-hidden="true">
				<span></span>
				MOVE TO BEND THE WORLD
			</div>
		</section>
		<section class="data-deck" id="details" aria-label="${ escapeHtml( current.title ) } highlights">
			<div class="stats">${ stats }</div>
			${ features ? `<ol class="feature-list">${ features }</ol>` : '' }
		</section>
		<footer class="site-footer">
			<div class="ticker" aria-label="Highlights"><div>${ ticker }${ ticker }</div></div>
			<div class="route-stepper">
				<a href="./${ previous.id }.html" aria-label="Previous: ${ escapeHtml( previous.title ) }">←</a>
				<span>${ String( index + 1 ).padStart( 2, '0' ) } / ${ String( SITES.length ).padStart( 2, '0' ) }</span>
				<a href="./${ next.id }.html" aria-label="Next: ${ escapeHtml( next.title ) }">→</a>
			</div>
		</footer>
	`;

}

function splitTitle( title ) {

	const words = String( title ).split( /\s+/ );
	if ( words.length < 2 ) return [ title ];
	const midpoint = Math.ceil( words.length / 2 );
	return [ words.slice( 0, midpoint ).join( ' ' ), words.slice( midpoint ).join( ' ' ) ];

}

function escapeHtml( value ) {

	return String( value ?? '' )
		.replaceAll( '&', '&amp;' )
		.replaceAll( '<', '&lt;' )
		.replaceAll( '>', '&gt;' )
		.replaceAll( '"', '&quot;' )
		.replaceAll( "'", '&#039;' );

}
