/**
 * Coverage: animated `LightShadow` properties propagate live.
 *
 * Captures a `MeshStandardNodeMaterial` rendered under a `DirectionalLight`
 * whose `castShadow=true` and asserts:
 *
 *   1. The extractor maps `light.shadow.matrix` / `bias` / `normalBias` /
 *      `radius` / `intensity` / `blurSamples` / `mapSize`, plus PointLight
 *      `shadow.camera.near/far`, to `light.shadow*` source kinds with a
 *      non-null `lightIndex`. (Anything else means the `ShadowNode` closures
 *      fell back to `uniform.live` and would freeze on replay.)
 *
 *   2. The emitted updater delegates each complete source descriptor to the
 *      canonical runtime light writer — no inlined snapshot-only behavior.
 *
 *   3. `LightNode.intensity` propagates via the existing `light.colorScaled`
 *      path: changing `light.intensity` between extraction and replay
 *      changes the bytes the updater writes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { generateForMaterial, assertNoUnknownKinds, patchGeneratedUpdaterImports } from './_helpers.js';

const HERE = dirname( fileURLToPath( import.meta.url ) );

// Scratch directory inside the plugin package so module resolution can
// find both `three` (in the workspace's node_modules) and the relative
// writers.js URL we patch in below. Stays under .gitignore-friendly path.
const SCRATCH_ROOT = join( HERE, '..', '.scratch-shadow-live' );
mkdirSync( SCRATCH_ROOT, { recursive: true } );

/**
 * Compile an emit-updater source string into a callable ESM module.
 *
 * Writing to a file (rather than data: URL) is necessary because the
 * generated source imports from `@tsl-precompile/runtime/writers` — a
 * package specifier that the data: scheme can't resolve. We also have to
 * write under the plugin package so `import 'three'` resolves through the
 * workspace's node_modules.
 */
async function loadEmittedModule( source ) {

	const patched = patchGeneratedUpdaterImports( source );
	const dir = mkdtempSync( join( SCRATCH_ROOT, 'updater-' ) );
	const file = join( dir, 'updater.mjs' );
	writeFileSync( file, patched, 'utf8' );
	const mod = await import( pathToFileURL( file ).href );
	// Best-effort cleanup so the scratch tree doesn't grow over time.
	try { rmSync( dir, { recursive: true, force: true } ); } catch ( _ ) { /* harmless */ }
	return mod;

}

async function captureWithDirectionalLight() {

	return generateForMaterial( ( { webgpu, core } ) => {

		const light = new core.DirectionalLight( 0xffffff, 1.5 );
		light.name = 'coverage-key-light';
		light.userData.tslPrecompileId = 'coverage:key';
		light.castShadow = true;
		light.shadow.bias = - 0.0042;
		light.shadow.normalBias = 0.123;
		light.shadow.radius = 3.5;
		light.shadow.intensity = 0.75;
		light.shadow.blurSamples = 16;
		light.shadow.mapSize.set( 256, 512 );
		light.position.set( 5, 10, 7 );

		const ambient = new core.AmbientLight( 0x202020, 0.25 );

		const material = new webgpu.MeshStandardNodeMaterial();
		material.color = new core.Color( 0x808080 );

		const ground = new core.Mesh(
			new core.PlaneGeometry( 10, 10 ),
			material,
		);
		ground.receiveShadow = true;

		const cube = new core.Mesh(
			new core.BoxGeometry( 1, 1, 1 ),
			material,
		);
		cube.castShadow = true;
		cube.position.set( 0, 1.5, 0 );

		return {
			material,
			name: 'coverage-shadow-live',
			objects: [ light, ambient, ground, cube ],
			configureRenderer( renderer ) {

				// Without this, ShadowNode.setupShadow() bails out and the
				// `reference('bias', 'float', shadow)` calls never end up in
				// state.updateNodes — defeating the whole point of the test.
				renderer.shadowMap.enabled = true;

			},
		};

	} );

}

async function captureWithPointLight() {

	return generateForMaterial( ( { webgpu, core } ) => {

		const light = new core.PointLight( 0xffffff, 65, 8, 1.5 );
		light.castShadow = true;
		light.shadow.camera.near = 0.25;
		light.shadow.camera.far = 8;
		light.shadow.bias = - 0.0042;
		light.shadow.normalBias = 0.123;
		light.shadow.radius = 3.5;
		light.shadow.intensity = 0.75;
		light.position.set( 0, 3, 0 );

		const ambient = new core.AmbientLight( 0x202020, 0.25 );

		const material = new webgpu.MeshStandardNodeMaterial();
		material.color = new core.Color( 0x808080 );

		const ground = new core.Mesh(
			new core.PlaneGeometry( 10, 10 ),
			material,
		);
		ground.receiveShadow = true;

		const cube = new core.Mesh(
			new core.BoxGeometry( 1, 1, 1 ),
			material,
		);
		cube.castShadow = true;
		cube.position.set( 0, 1.5, 0 );

		return {
			material,
			name: 'coverage-point-shadow-live',
			objects: [ light, ambient, ground, cube ],
			configureRenderer( renderer ) {

				renderer.shadowMap.enabled = true;

			},
		};

	} );

}

/**
 * Stand-in `frame` for executing emit-updater modules in tests. Fields
 * are the union of what the various `light.*` / camera writers read —
 * we don't care about the actual values, only that the writes complete.
 */
function makeMockFrame( scene ) {

	const eye = { elements: new Array( 16 ).fill( 0 ).map( ( _, i ) => i % 5 === 0 ? 1 : 0 ) };
	return {
		scene,
		object: { matrixWorld: eye, normalMatrix: { elements: new Array( 9 ).fill( 0 ).map( ( _, i ) => i % 4 === 0 ? 1 : 0 ) } },
		material: null,
		camera: {
			projectionMatrix: eye,
			projectionMatrixInverse: eye,
			matrixWorld: eye,
			matrixWorldInverse: eye,
			position: { x: 0, y: 0, z: 0 },
			near: 0.1,
			far: 100,
		},
		time: 0,
		deltaTime: 0,
		frameId: 0,
	};

}

function findSlotsByKind( artifact, kindPredicate ) {

	const out = [];
	for ( const group of artifact.uniformPlan ) {

		for ( const slot of group.slots ) {

			if ( slot.source && kindPredicate( slot.source.kind ) ) out.push( slot );

		}

	}
	return out;

}

test( 'shadow live: ShadowNode.bias / normalBias / radius / intensity / mapSize → light.shadow* with lightIndex', async () => {

	const result = await captureWithDirectionalLight();
	assertNoUnknownKinds( result, 'shadow-live' );

	// blurSamples is only referenced under VSMShadowMap (a setupRenderTarget
	// branch); a plain DirectionalLight + PCF shadow won't pull it in. The
	// extractor still has a slot mapping for it (see `light.shadowBlurSamples`
	// emit-updater case), but the live extraction of a non-VSM directional
	// light won't reach it. The synthetic-plan test in uniform-kinds.test.js
	// covers the codegen.
	const expectedKinds = [
		'light.shadowMatrix',
		'light.shadowBias',
		'light.shadowNormalBias',
		'light.shadowRadius',
		'light.shadowIntensity',
		'light.shadowMapSize',
	];

	const seen = new Set();
	const slots = findSlotsByKind( result.artifact, ( k ) => k && k.startsWith( 'light.shadow' ) );
	const identity = result.artifact.lightIdentities.find( ( record ) => record.explicitKey === 'coverage:key' );
	assert.ok( identity, 'extractArtifact should aggregate the keyed light into the variant-local identity table' );
	assert.equal( identity.name, 'coverage-key-light' );
	assert.equal( identity.type, 'DirectionalLight' );
	assert.deepEqual( identity.snapshot.position, [ 5, 10, 7 ] );
	assert.equal( identity.snapshot.intensity, 1.5 );
	assert.equal( identity.snapshot.castShadow, true );

	for ( const slot of slots ) {

		seen.add( slot.source.kind );
		assert.equal(
			Number.isInteger( slot.source.lightIndex ),
			true,
			`expected ${ slot.source.kind } slot to carry a numeric lightIndex; got ${ JSON.stringify( slot.source ) }`,
		);
		assert.equal( result.artifact.lightIdentities[ slot.source.lightIdentity ], identity );
		assert.equal(
			typeof slot.source.property,
			'string',
			`expected ${ slot.source.kind } slot to carry a property name`,
		);

	}

	for ( const kind of expectedKinds ) {

		assert.ok(
			seen.has( kind ),
			`expected at least one slot with kind=${ kind }; saw kinds=${ Array.from( seen ).sort().join( ',' ) || '<none>' }`,
		);

	}

} );

test( 'point shadow live: camera near/far → light.shadowCamera* with lightIndex', async () => {

	const result = await captureWithPointLight();
	assertNoUnknownKinds( result, 'point-shadow-live' );

	const expectedKinds = [
		'light.shadowMatrix',
		'light.shadowCameraNear',
		'light.shadowCameraFar',
	];

	const seen = new Set();
	const slots = findSlotsByKind( result.artifact, ( k ) => k && ( k === 'light.shadowMatrix' || k.startsWith( 'light.shadowCamera' ) ) );

	for ( const slot of slots ) {

		seen.add( slot.source.kind );
		assert.equal(
			Number.isInteger( slot.source.lightIndex ),
			true,
			`expected ${ slot.source.kind } slot to carry a numeric lightIndex; got ${ JSON.stringify( slot.source ) }`,
		);

	}

	for ( const kind of expectedKinds ) {

		assert.ok(
			seen.has( kind ),
			`expected at least one slot with kind=${ kind }; saw kinds=${ Array.from( seen ).sort().join( ',' ) || '<none>' }`,
		);

	}

	assert.match( result.source, /"light\.shadowCameraNear"/ );
	assert.match( result.source, /"light\.shadowCameraFar"/ );

} );

test( 'shadow live: emitted updater delegates full shadow sources at render time', async () => {

	const result = await captureWithDirectionalLight();

	// Each scalar shadow read must look up a live light + read shadow
	// property dynamically — no inlined `0.0042` etc. literals. (blurSamples
	// is VSM-only and not exercised by this fixture; covered separately by
	// the synthetic-plan test in uniform-kinds.test.js.)
	assert.match( result.source, /"kind":"light\.shadowBias"/ );
	assert.match( result.source, /"kind":"light\.shadowNormalBias"/ );
	assert.match( result.source, /"kind":"light\.shadowRadius"/ );
	assert.match( result.source, /"kind":"light\.shadowIntensity"/ );
	assert.match( result.source, /"kind":"light\.shadowMapSize"/ );
	assert.match( result.source, /writeGeneratedLightValue as _tslpWriteLightValue/ );

} );

test( 'shadow live: emitted updater writes live shadow.bias against a mock buffer', async () => {

	const result = await captureWithDirectionalLight();

	// Find the light.shadowBias slot offset (and its byteOffset within the slot's group).
	let foundOffset = null;
	let foundGroupIndex = null;
	for ( let g = 0; g < result.artifact.uniformPlan.length; g ++ ) {

		const group = result.artifact.uniformPlan[ g ];
		for ( const slot of group.slots ) {

			if ( slot.source && slot.source.kind === 'light.shadowBias' ) {

				foundOffset = slot.offset;
				foundGroupIndex = g;
				break;

			}

		}
		if ( foundOffset !== null ) break;

	}
	assert.notEqual( foundOffset, null, 'expected to find a light.shadowBias slot in the uniform plan' );

	const mod = await loadEmittedModule( result.source );

	// Build a synthetic frame: a scene with the same DirectionalLight,
	// then mutate light.shadow.bias and watch the bytes change.
	const { Scene, DirectionalLight } = await import( 'three' );
	const scene = new Scene();
	const light = new DirectionalLight( 0xffffff, 1 );
	light.castShadow = true;
	light.shadow.bias = 0.001;
	scene.add( light );

	const groupByteLength = result.artifact.uniformPlan[ foundGroupIndex ].byteLength;
	const buffer = new ArrayBuffer( Math.max( 256, groupByteLength + 64 ) );
	const view = new DataView( buffer );

	const groupName = result.artifact.uniformPlan[ foundGroupIndex ].name || null;

	mod.updateGroup( makeMockFrame( scene ), null, view, 0, groupName );
	const before = view.getFloat32( foundOffset, true );

	// Mutate live shadow.bias — the mark of a successful live binding is that
	// the next updater call reflects the new value, not the captured one.
	light.shadow.bias = - 0.5;
	mod.updateGroup( makeMockFrame( scene ), null, view, 0, groupName );
	const after = view.getFloat32( foundOffset, true );

	// Float32 representation introduces tiny rounding (e.g. 0.001 ≈ 0.0010000000474974513).
	// Compare with a generous epsilon so the test isn't flaky on platforms with different rounding.
	assert.ok( Math.abs( before - 0.001 ) < 1e-5, `expected initial write to use live light.shadow.bias=0.001, got ${ before }` );
	assert.ok( Math.abs( after - ( - 0.5 ) ) < 1e-5, `expected second write to reflect mutated light.shadow.bias=-0.5, got ${ after }` );

} );

test( 'light intensity live: light.colorScaled reflects mutated intensity', async () => {

	const result = await captureWithDirectionalLight();

	let colorOffset = null;
	let groupIndex = null;
	for ( let g = 0; g < result.artifact.uniformPlan.length; g ++ ) {

		const group = result.artifact.uniformPlan[ g ];
		for ( const slot of group.slots ) {

			if ( slot.source && slot.source.kind === 'light.colorScaled' ) {

				colorOffset = slot.offset;
				groupIndex = g;
				break;

			}

		}
		if ( colorOffset !== null ) break;

	}
	assert.notEqual( colorOffset, null, 'expected at least one light.colorScaled slot for the directional light' );

	const mod = await loadEmittedModule( result.source );

	const { Scene, DirectionalLight } = await import( 'three' );
	const scene = new Scene();
	const light = new DirectionalLight( 0xffffff, 1 );
	scene.add( light );

	const groupByteLength = result.artifact.uniformPlan[ groupIndex ].byteLength;
	const buffer = new ArrayBuffer( Math.max( 256, groupByteLength + 64 ) );
	const view = new DataView( buffer );
	const groupName = result.artifact.uniformPlan[ groupIndex ].name || null;

	light.intensity = 1;
	mod.updateGroup( makeMockFrame( scene ), null, view, 0, groupName );
	const r1 = view.getFloat32( colorOffset, true );

	light.intensity = 4;
	mod.updateGroup( makeMockFrame( scene ), null, view, 0, groupName );
	const r4 = view.getFloat32( colorOffset, true );

	assert.equal( r1, 1, `expected colorScaled.r at intensity=1 to be 1.0, got ${ r1 }` );
	assert.equal( r4, 4, `expected colorScaled.r at intensity=4 to scale to 4.0, got ${ r4 }` );

} );
