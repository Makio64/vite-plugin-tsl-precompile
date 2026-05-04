/**
 * Minimal `scene.backgroundNode` + `scene.backgroundBlurriness` test.
 *
 * Scene contents:
 *   - A TSL backgroundNode that produces a vertical gradient (cheap to
 *     hash, easy to recognise on screen).
 *   - A `scene.environment` cube-pattern texture that drives PBR IBL.
 *   - A reflective MeshStandardNodeMaterial sphere marked
 *     `.precompile('test-sphere')` so the build pipeline replaces it
 *     with a precompiled artifact.
 *   - `scene.backgroundBlurriness` ramped 0 → 1 by `Math.sin(time)` so
 *     a regression in the blurriness uniform shows as a static bg.
 *
 * Run:    pnpm --filter examples-background dev
 * Build:  pnpm --filter examples-background build
 */

import {
	Scene, PerspectiveCamera, Mesh, SphereGeometry, CubeTexture,
	DataTexture, RGBAFormat, UnsignedByteType, LinearFilter, LinearMipMapLinearFilter,
	HemisphereLight,
} from 'three';
import { WebGPURenderer, MeshStandardNodeMaterial, PMREMGenerator } from 'three/webgpu';
import { vec4, screenUV, color, mix } from 'three/tsl';
import { installPrecompileMarker, setDevRenderer, precompileAuxiliary } from '@tsl-precompile/runtime';
import * as THREE from 'three';

const status = document.getElementById( 'status' );
const setStatus = ( msg ) => { status.textContent = msg; console.info( '[bg-test]', msg ); };

setStatus( 'creating renderer…' );

const renderer = new WebGPURenderer( { antialias: true } );
renderer.setSize( window.innerWidth, window.innerHeight );
renderer.setPixelRatio( Math.min( 2, window.devicePixelRatio || 1 ) );
document.body.appendChild( renderer.domElement );

await renderer.init();
setStatus( 'renderer ready' );

// Install the dev-time precompile marker so .precompile() captures.
installPrecompileMarker( THREE, { devEndpoint: '/__tsl-precompile/capture' } );
setDevRenderer( renderer );

// ---- Scene -----------------------------------------------------------
const scene = new Scene();
const camera = new PerspectiveCamera( 50, window.innerWidth / window.innerHeight, 0.1, 100 );
camera.position.set( 0, 0, 4 );

// Environment: a 6-face cubemap built from in-memory data so the example
// is self-contained (no asset fetches). Each face is solid-colour so the
// PMREM-prefiltered output has a clear directionality and we can see the
// reflection on the sphere.
function makeCubeFace( r, g, b ) {
	const data = new Uint8Array( [ r, g, b, 255 ] );
	const tex = new DataTexture( data, 1, 1, RGBAFormat, UnsignedByteType );
	tex.needsUpdate = true;
	return tex.image;
}
const cube = new CubeTexture( [
	makeCubeFace( 240, 80, 80 ),   // +X red
	makeCubeFace( 80, 240, 80 ),   // -X green
	makeCubeFace( 80, 120, 240 ),  // +Y sky-blue
	makeCubeFace( 60, 60, 60 ),    // -Y dark
	makeCubeFace( 240, 200, 60 ),  // +Z yellow
	makeCubeFace( 200, 80, 200 ),  // -Z magenta
] );
cube.needsUpdate = true;
cube.minFilter = LinearMipMapLinearFilter;
cube.magFilter = LinearFilter;
cube.generateMipmaps = true;

const pmrem = new PMREMGenerator( renderer );
scene.environment = pmrem.fromCubemap( cube ).texture;
scene.environmentIntensity = 1;

// scene.backgroundNode: TSL gradient. screenUV.y is 0 at top, 1 at bottom.
// Mix from teal to deep navy. This is the path that's currently broken on
// replay (TSL stub proxy can't be hashed).
scene.backgroundNode = mix(
	color( 0x103040 ),
	color( 0x102060 ),
	screenUV.y,
);
scene.backgroundBlurriness = 0;
scene.backgroundIntensity = 1;

// A simple hemisphere light so the sphere isn't pure-IBL.
scene.add( new HemisphereLight( 0xffffff, 0x080820, 0.5 ) );

// ---- Sphere ---------------------------------------------------------
const sphereMat = new MeshStandardNodeMaterial( {
	color: 0xffffff,
	metalness: 1.0,
	roughness: 0.25,
} );
sphereMat.precompile( 'bg-test-sphere' );

const sphere = new Mesh( new SphereGeometry( 1, 64, 32 ), sphereMat );
scene.add( sphere );

// Capture aux passes (background, render-output) so the slim build can
// reattach the captured TSL backgroundNode artifact at runtime.
await precompileAuxiliary( renderer, scene, camera, {
	devEndpoint: '/__tsl-precompile/capture',
	three: THREE,
	threeVersion: String( THREE.REVISION ).match( /^\d+/ )[ 0 ],
	pluginVersion: '0.0.0',
} );
setStatus( 'aux captured' );

// ---- Animate -------------------------------------------------------
function animate( ms ) {
	const t = ( ms || 0 ) / 1000;
	// Ramp 0 → 1 → 0 so the user sees the cubemap reflection sharpen
	// and blur over time. If backgroundBlurriness is broken the bg
	// stays sharp the whole time.
	scene.backgroundBlurriness = 0.5 + 0.5 * Math.sin( t * 0.6 );
	sphere.rotation.y = t * 0.2;
	renderer.render( scene, camera );
}
renderer.setAnimationLoop( animate );
setStatus( 'rendering' );
