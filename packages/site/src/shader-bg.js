// Hero background — a fullscreen TSL NodeMaterial running on WebGPU.
// Uses three.js TSL directly (no plugin integration): the point is a nice
// animated backdrop, not to demonstrate the precompile path. If WebGPU is
// unavailable or anything fails, main.js falls back to the pure-CSS gradient
// already painted behind the canvas.

export async function startHeroShader() {

	if ( ! ( 'gpu' in navigator ) ) throw new Error( 'WebGPU unavailable' );

	const canvas = document.getElementById( 'hero-bg' );
	if ( ! canvas ) throw new Error( 'hero canvas missing' );

	const [ threeCore, threeWebGPU, threeTSL ] = await Promise.all( [
		import( 'three' ),
		import( 'three/webgpu' ),
		import( 'three/tsl' ),
	] );

	const { Scene, OrthographicCamera, Mesh, PlaneGeometry } = threeCore;
	const { WebGPURenderer, MeshBasicNodeMaterial } = threeWebGPU;
	const { uv, vec3, vec2, mix, sin, cos, time, color, length, float } = threeTSL;

	const renderer = new WebGPURenderer( { canvas, antialias: false, alpha: true } );
	renderer.setPixelRatio( Math.min( 1.5, devicePixelRatio || 1 ) );
	renderer.setSize( canvas.clientWidth || innerWidth, canvas.clientHeight || innerHeight, false );
	renderer.setClearColor( 0x000000, 0 );
	await renderer.init();

	const scene = new Scene();
	const camera = new OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );

	const material = new MeshBasicNodeMaterial();
	material.transparent = true;

	const p = uv().sub( vec2( 0.5, 0.5 ) );
	const t = time.mul( 0.15 );
	const wave = sin( p.x.mul( 4 ).add( t ) ).add( cos( p.y.mul( 3 ).sub( t.mul( 0.8 ) ) ) ).mul( 0.5 ).add( 0.5 );
	const falloff = float( 1 ).sub( length( p ).mul( 1.2 ) ).max( 0 );

	const cyan = color( '#22d3ee' );
	const magenta = color( '#d946ef' );
	const indigo = color( '#0f1020' );

	const tint = mix( cyan, magenta, wave );
	const shaded = mix( indigo, tint, falloff.mul( 0.85 ) );
	material.colorNode = vec3( shaded.r, shaded.g, shaded.b );
	material.opacityNode = falloff.mul( 0.9 ).add( 0.1 );

	const quad = new Mesh( new PlaneGeometry( 2, 2 ), material );
	scene.add( quad );

	requestAnimationFrame( () => canvas.classList.add( 'ready' ) );

	const resize = () => {
		const w = canvas.clientWidth || innerWidth;
		const h = canvas.clientHeight || innerHeight;
		renderer.setSize( w, h, false );
	};
	resize();
	addEventListener( 'resize', resize, { passive: true } );

	let running = true;
	document.addEventListener( 'visibilitychange', () => {
		running = document.visibilityState === 'visible';
	} );

	const loop = () => {
		requestAnimationFrame( loop );
		if ( ! running ) return;
		renderer.render( scene, camera );
	};
	loop();

}
