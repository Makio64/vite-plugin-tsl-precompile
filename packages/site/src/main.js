/* Landing page — copy buttons and the generated evidence counters.
   No Three.js here: the overview must stay a plain, fast HTML page. */

/* ---------- copy to clipboard ----------
   `data-copy` alone copies the sibling <pre>; `data-copy="#id"` copies the
   <pre> inside that element, so the hero button can reach the agent prompt. */
document.querySelectorAll( '[data-copy]' ).forEach( ( btn ) => {

	const label = btn.textContent;
	const selector = btn.dataset.copy;

	btn.addEventListener( 'click', async () => {
		const scope = selector ? document.querySelector( selector ) : btn.parentElement;
		const pre = scope?.matches( 'pre' ) ? scope : scope?.querySelector( 'pre' );
		if ( ! pre ) return;
		let done = 'copied';
		try {
			// textContent, not innerText: the prompt lives in a hidden element,
			// and innerText returns '' for unrendered elements.
			await navigator.clipboard.writeText( pre.textContent.trim() );
			btn.classList.add( 'copied' );
		} catch {
			done = 'copy failed';
		}
		btn.textContent = done;
		setTimeout( () => {
			btn.textContent = label;
			btn.classList.remove( 'copied' );
		}, 1400 );
	} );

} );

/* ---------- start-path helpers ---------- */
const packageCommands = {
	pnpm: {
		install: `pnpm add -D vite-plugin-tsl-precompile@alpha
pnpm add @tsl-precompile/runtime@alpha three@0.185.1 --save-exact
# TypeScript only:
pnpm add -D @types/three@0.185.1 --save-exact`,
		capture: 'pnpm dev',
		verify: `pnpm exec tsl-precompile-doctor --source src
pnpm exec tsl-precompile-verify --source src --source-root . artifacts
git add artifacts/
pnpm build`,
		preview: 'pnpm preview',
	},
	npm: {
		install: `npm install --save-dev vite-plugin-tsl-precompile@alpha
npm install --save-exact @tsl-precompile/runtime@alpha three@0.185.1
# TypeScript only:
npm install --save-dev --save-exact @types/three@0.185.1`,
		capture: 'npm run dev',
		verify: `npx --no-install tsl-precompile-doctor --source src
npx --no-install tsl-precompile-verify --source src --source-root . artifacts
git add artifacts/
npm run build`,
		preview: 'npm run preview',
	},
	yarn: {
		install: `yarn add --dev vite-plugin-tsl-precompile@alpha
yarn add --exact @tsl-precompile/runtime@alpha three@0.185.1
# TypeScript only:
yarn add --dev --exact @types/three@0.185.1`,
		capture: 'yarn run dev',
		verify: `yarn exec tsl-precompile-doctor --source src
yarn exec tsl-precompile-verify --source src --source-root . artifacts
git add artifacts/
yarn run build`,
		preview: 'yarn run preview',
	},
	bun: {
		install: `bun add --dev vite-plugin-tsl-precompile@alpha
bun add --exact @tsl-precompile/runtime@alpha three@0.185.1
# TypeScript only:
bun add --dev --exact @types/three@0.185.1`,
		capture: 'bun run dev',
		verify: `bunx --bun tsl-precompile-doctor --source src
bunx --bun tsl-precompile-verify --source src --source-root . artifacts
git add artifacts/
bun run build`,
		preview: 'bun run preview',
	},
};

document.querySelector( '[data-package-manager]' )?.addEventListener( 'change', ( event ) => {

	const commands = packageCommands[ event.currentTarget.value ];
	if ( ! commands ) return;
	document.querySelectorAll( '[data-package-command]' ).forEach( ( target ) => {

		const command = commands[ target.dataset.packageCommand ];
		if ( command ) target.textContent = command;

	} );

} );

function openTargetDetails() {

	if ( ! location.hash ) return;
	let id;
	try {

		id = decodeURIComponent( location.hash.slice( 1 ) );

	} catch {

		return;

	}
	const target = document.getElementById( id );
	const details = target?.matches( 'details' ) ? target : target?.closest( 'details' );
	if ( details ) details.open = true;

}

document.querySelectorAll( '[data-open]' ).forEach( ( link ) => {

	link.addEventListener( 'click', () => {

		const details = document.querySelector( link.dataset.open );
		if ( details?.matches( 'details' ) ) details.open = true;

	} );

} );
window.addEventListener( 'hashchange', openTargetDetails );
openTargetDetails();

/* ---------- before/after seam ---------- */
const seam = document.querySelector( '.seam' );
const seamRange = seam?.querySelector( '.seam-range' );
seamRange?.addEventListener( 'input', () => seam.style.setProperty( '--pos', `${ seamRange.value }%` ) );

/* ---------- faq accordion ----------
   `name="faq"` already gives one-at-a-time in modern browsers, but it closes
   instantly. Driving the height here animates both directions everywhere. */
const faqItems = [ ...document.querySelectorAll( '.faq details' ) ];
const instant = matchMedia( '(prefers-reduced-motion: reduce)' ).matches;

function setHeight( item, from, to, after ) {

	const body = item.querySelector( '.faq-body' );
	if ( ! body ) return after?.();
	if ( instant ) {
		body.style.height = '';
		return after?.();
	}
	body.style.height = `${ from }px`;
	body.getBoundingClientRect();               // flush the start value
	body.style.height = `${ to }px`;
	body.addEventListener( 'transitionend', () => {
		body.style.height = to === 0 ? '' : 'auto';
		after?.();
	}, { once: true } );

}

function closeItem( item ) {

	if ( ! item.open ) return;
	setHeight( item, item.querySelector( '.faq-body' ).scrollHeight, 0, () => ( item.open = false ) );

}

faqItems.forEach( ( item ) => {
	item.querySelector( 'summary' )?.addEventListener( 'click', ( event ) => {

		event.preventDefault();
		if ( item.open ) return closeItem( item );
		faqItems.forEach( ( other ) => other !== item && closeItem( other ) );
		item.open = true;
		setHeight( item, 0, item.querySelector( '.faq-body' ).scrollHeight );

	} );
} );

/* ---------- generated compatibility evidence ----------
   The checked-in fallback values stay visible when the data file is
   unavailable (for example when the HTML is opened straight from disk). */
async function hydrateEvidence() {

	const targets = document.querySelectorAll( '[data-stat]' );
	const verdictTargets = document.querySelectorAll( '[data-evidence-verdict]' );
	if ( targets.length === 0 && verdictTargets.length === 0 ) return;
	// The development HTML transform deliberately blanks publication claims.
	// Do not let the legacy checked catalogue repopulate a partial set of
	// counters after the honest local-snapshot/unavailable state is rendered.
	if ( document.querySelector( '.seam.is-local-snapshot, .seam.is-evidence-unavailable' ) ) return;

	try {

		const response = await fetch( new URL( 'examples.json', document.baseURI ) );
		if ( ! response.ok ) return;
		const evidence = await response.json();
		const totals = evidence?.totals;
		if ( ! totals || typeof totals !== 'object' ) return;

		targets.forEach( ( target ) => {

			const value = totals[ target.dataset.stat ];
			if ( typeof value !== 'number' || ! Number.isFinite( value ) ) return;
			target.textContent = value.toLocaleString( 'en-US' );

		} );
		verdictTargets.forEach( ( target ) => {

			const value = evidence.coverageVerdicts?.[ target.dataset.evidenceVerdict ];
			if ( Number.isSafeInteger( value ) && value >= 0 ) target.textContent = value.toLocaleString( 'en-US' );

		} );

	} catch ( _ ) { /* keep the fallback values */ }

}

hydrateEvidence();
