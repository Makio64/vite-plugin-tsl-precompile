// Browser evidence page.
//
// This experiment intentionally measures only stock Three.js cold-versus-warm
// wall time. The delta includes TSL→WGSL generation, pipeline creation, driver
// work, resource initialization, and other one-time costs. It is useful as a
// cold-path envelope, but it is not presented as time saved by precompilation.

const WARM_FRAMES = 40;
const MEASURE_FRAMES = 90;

// ---- scene builders: same geometry/lights, different shader complexity -----

function buildPBR( mods, THREE ) {

	const { Scene, PerspectiveCamera, Mesh, TorusKnotGeometry, DirectionalLight, HemisphereLight } = mods.core;
	const { MeshStandardNodeMaterial } = mods.webgpu;
	const { color, mix, uv } = mods.tsl;

	const scene = new Scene();
	const camera = new PerspectiveCamera( 50, 1, 0.1, 100 );
	camera.position.set( 0, 0, 4 );
	scene.add( new HemisphereLight( 0xbbddff, 0x223344, 1.0 ) );
	const sun = new DirectionalLight( 0xffffff, 2.0 );
	sun.position.set( 3, 4, 2 );
	scene.add( sun );

	const material = new MeshStandardNodeMaterial();
	material.roughness = 0.35;
	material.metalness = 0.1;
	material.colorNode = mix( color( 0x224488 ), color( 0x88ccff ), uv().y );

	const mesh = new Mesh( new TorusKnotGeometry( 1, 0.3, 128, 32 ), material );
	scene.add( mesh );
	return { scene, camera, mesh };

}

function buildProcedural( mods, THREE ) {

	const { Scene, PerspectiveCamera, Mesh, TorusKnotGeometry, DirectionalLight, HemisphereLight } = mods.core;
	const { MeshStandardNodeMaterial } = mods.webgpu;
	const { color, mix, uv, sin, cos, vec3, float, positionLocal } = mods.tsl;

	const scene = new Scene();
	const camera = new PerspectiveCamera( 50, 1, 0.1, 100 );
	camera.position.set( 0, 0, 4 );
	scene.add( new HemisphereLight( 0xbbddff, 0x223344, 1.0 ) );
	const sun = new DirectionalLight( 0xffffff, 2.2 );
	sun.position.set( 3, 4, 2 );
	scene.add( sun );

	const material = new MeshStandardNodeMaterial();
	material.metalness = 0.2;

	// A deliberately layered TSL graph — more nodes => more WGSL to compile,
	// so the first-frame cost is larger and the saving more visible.
	const p = positionLocal.mul( 3.0 );
	let n = float( 0 );
	let amp = float( 0.6 );
	let freq = float( 1.0 );
	for ( let i = 0; i < 6; i ++ ) {

		n = n.add( sin( p.x.mul( freq ).add( cos( p.y.mul( freq ).add( p.z.mul( freq ) ) ) ) ).mul( amp ) );
		amp = amp.mul( 0.55 );
		freq = freq.mul( 1.9 );

	}
	const band = n.mul( 0.5 ).add( 0.5 );
	material.colorNode = mix( color( '#0b1f3a' ), color( '#7fe0ff' ), band );
	material.roughnessNode = mix( float( 0.15 ), float( 0.7 ), band );
	material.emissiveNode = vec3( band.mul( band ).mul( 0.25 ), band.mul( 0.1 ), float( 0.0 ) );

	const mesh = new Mesh( new TorusKnotGeometry( 1, 0.32, 200, 48 ), material );
	scene.add( mesh );
	return { scene, camera, mesh };

}

const SCENES = [
	{ id: 'pbr', label: 'Standard PBR', note: 'MeshStandardNodeMaterial + a small colorNode graph — a typical app material.', build: buildPBR },
	{ id: 'procedural', label: 'Procedural TSL', note: 'A layered noise graph (6 octaves) driving colour, roughness and emissive — more WGSL to compile.', build: buildProcedural },
];

// ---- measurement -----------------------------------------------------------

function makeCanvas() {

	const c = document.createElement( 'canvas' );
	c.width = 512;
	c.height = 512;
	return c;

}

async function measureScene( mods, THREE, sceneDef ) {

	const canvas = makeCanvas();
	const renderer = new mods.webgpu.WebGPURenderer( { canvas, antialias: false } );
	renderer.setPixelRatio( 1 );
	renderer.setSize( 512, 512, false );
	await renderer.init();

	const { scene, camera, mesh } = sceneDef.build( mods, THREE );

	// Cold first render includes both the JavaScript TSL path and WebGPU/driver
	// initialization work. Precompilation removes only part of this envelope.
	const t0 = performance.now();
	await renderer.renderAsync( scene, camera );
	const coldMs = performance.now() - t0;

	// Warm-up (discard) so the steady-state number excludes ramp effects.
	for ( let i = 0; i < WARM_FRAMES; i ++ ) {

		mesh.rotation.y += 0.01;
		await renderer.renderAsync( scene, camera );

	}

	// Warm stock frames provide context for the size of the cold envelope. They
	// are not a proxy for a cold precompiled render.
	const samples = [];
	for ( let i = 0; i < MEASURE_FRAMES; i ++ ) {

		mesh.rotation.y += 0.01;
		const s = performance.now();
		await renderer.renderAsync( scene, camera );
		samples.push( performance.now() - s );

	}
	samples.sort( ( a, b ) => a - b );
	// Trim the slowest 10% (GC / scheduler jitter) and take the median band.
	const trimmed = samples.slice( 0, Math.max( 1, Math.floor( samples.length * 0.9 ) ) );
	const warmMs = trimmed.reduce( ( a, b ) => a + b, 0 ) / trimmed.length;

	renderer.dispose();
	canvas.width = canvas.height = 0;

	const coldOverheadMs = Math.max( 0, coldMs - warmMs );
	return { coldMs, warmMs, coldOverheadMs };

}

// ---- DOM -------------------------------------------------------------------

const fmt = ( ms ) => ms >= 100 ? `${ Math.round( ms ) }` : ms.toFixed( 1 );

function rowHtml( label, note, r ) {

	const speedup = r.warmMs > 0 ? ( r.coldMs / r.warmMs ) : 1;
	return `
		<tr>
			<th scope="row"><span class="bench-scene">${ label }</span><span class="bench-scene-note">${ note }</span></th>
			<td class="bench-num bench-num-bad">${ fmt( r.coldMs ) } <span class="bench-unit">ms</span></td>
			<td class="bench-num bench-num-good">${ fmt( r.warmMs ) } <span class="bench-unit">ms</span></td>
			<td class="bench-num bench-saved">+${ fmt( r.coldOverheadMs ) } <span class="bench-unit">ms</span></td>
		</tr>`;

}

async function run( button, tbody, statusEl ) {

	button.disabled = true;
	button.textContent = 'Measuring…';

	let mods;
	try {

		if ( ! ( 'gpu' in navigator ) ) throw new Error( 'no-webgpu' );
		mods = {
			core: await import( 'three' ),
			webgpu: await import( 'three/webgpu' ),
			tsl: await import( 'three/tsl' ),
		};

	} catch ( err ) {

		statusEl.hidden = false;
		statusEl.textContent = 'WebGPU is not available in this browser, so the live measurement can\'t run. Try Chrome/Edge 113+ or Safari 18+. The bundle and pixel-identical numbers above are measured offline.';
		button.hidden = true;
		return;

	}

	tbody.innerHTML = '';
	for ( const def of SCENES ) {

		button.textContent = `Measuring ${ def.label }…`;
		try {

			const r = await measureScene( mods, mods.core, def );
			tbody.insertAdjacentHTML( 'beforeend', rowHtml( def.label, def.note, r ) );

		} catch ( err ) {

			tbody.insertAdjacentHTML( 'beforeend', `<tr><th scope="row">${ def.label }</th><td colspan="3" class="bench-num">— (${ String( err && err.message || err ).slice( 0, 60 ) })</td></tr>` );

		}

	}

	button.textContent = 'Re-run';
	button.disabled = false;

}

export function initBenchmark() {

	const button = document.getElementById( 'bench-run' );
	const tbody = document.getElementById( 'bench-tbody' );
	const statusEl = document.getElementById( 'bench-status' );
	if ( ! button || ! tbody ) return;

	if ( ! ( 'gpu' in navigator ) && statusEl ) {

		statusEl.hidden = false;
		statusEl.textContent = 'WebGPU is not available in this browser. The bundle and pixel-identical numbers are measured offline; the live first-frame measurement needs Chrome/Edge 113+ or Safari 18+.';
		button.disabled = true;

	}

	button.addEventListener( 'click', () => run( button, tbody, statusEl ) );

}

initBenchmark();

async function hydrateGeneratedEvidence() {

	const targets = document.querySelectorAll( '[data-bench-stat]' );
	if ( targets.length === 0 ) return;

	try {

		const response = await fetch( new URL( 'examples.json', document.baseURI ) );
		if ( ! response.ok ) return;
		const data = await response.json();
		for ( const target of targets ) {

			const value = data && data.totals && data.totals[ target.dataset.benchStat ];
			if ( typeof value === 'number' && Number.isFinite( value ) ) target.textContent = value.toLocaleString( 'en-US' );

		}

	} catch ( _ ) {}

}

hydrateGeneratedEvidence();
