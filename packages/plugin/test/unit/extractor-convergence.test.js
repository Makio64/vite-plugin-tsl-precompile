/**
 * Extractor convergence guards for ROADMAP.md §P2.10.
 *
 * Proves both that the Node harness is stable and that its structural output
 * converges with a genuine browser-captured first-party artifact. Shape
 * comparison deliberately ignores WGSL text, UUIDs, hashes, and live numeric
 * snapshots; binding topology, offsets, kinds, and shader-stage presence must
 * still match exactly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	diffArtifactShapes,
	fingerprintArtifactShape,
} from '@tsl-precompile/contract/artifact-shape';
import { collectArtifactVariantCandidates } from '@tsl-precompile/contract/artifact-variants';
import { extractMaterial } from '../../src/node-harness.js';

const GETTING_STARTED_ARTIFACTS = fileURLToPath(
	new URL( '../../../examples/getting-started/artifacts/', import.meta.url ),
);

function gettingStartedFactory( { webgpu, core, tsl } ) {

	const { MeshStandardNodeMaterial } = webgpu;
	const { color, mix, uv } = tsl;
	const material = new MeshStandardNodeMaterial();
	material.roughness = 0.35;
	material.metalness = 0.1;
	material.colorNode = mix( color( 0x224488 ), color( 0x88ccff ), uv().y );

	const camera = new core.PerspectiveCamera( 50, 1, 0.1, 100 );
	camera.position.set( 0, 0, 4 );
	camera.lookAt( 0, 0, 0 );

	const mesh = new core.Mesh(
		new core.TorusKnotGeometry( 1, 0.3, 128, 32 ),
		material,
	);
	const hemisphere = new core.HemisphereLight( 0xbbddff, 0x223344, 1 );
	const sun = new core.DirectionalLight( 0xffffff, 2 );
	sun.position.set( 3, 4, 2 );

	return {
		material,
		name: 'getting-started',
		objects: [ mesh, hemisphere, sun ],
		camera,
	};

}

test( 'node harness extract is shape-stable across two runs of the same factory', async () => {

	const factory = ( { webgpu, tsl } ) => {

		const { MeshStandardNodeMaterial } = webgpu;
		const { color, mix, uv } = tsl;
		const material = new MeshStandardNodeMaterial();
		material.colorNode = mix( color( 'red' ), color( 'blue' ), uv().x );
		return { material, name: 'convergence-guard' };

	};

	const first = await extractMaterial( factory );
	const second = await extractMaterial( factory );
	const left = fingerprintArtifactShape( first.artifact );
	const right = fingerprintArtifactShape( second.artifact );
	const diff = diffArtifactShapes( left, right );

	assert.equal(
		diff.ok,
		true,
		`node extract shape drifted:\n  missing=${ JSON.stringify( diff.missing ) }\n  extra=${ JSON.stringify( diff.extra ) }`,
	);
	assert.ok( left.length > 0, 'expected a non-empty uniform-plan fingerprint' );

} );

test( 'browser capture and Node re-extract converge for the getting-started scene', async () => {

	const manifest = JSON.parse(
		await readFile( join( GETTING_STARTED_ARTIFACTS, 'manifest.json' ), 'utf8' ),
	);
	const entry = manifest[ 'getting-started' ];
	assert.equal( typeof entry?.file, 'string', 'fixture manifest must own the getting-started artifact' );

	const browserCapture = JSON.parse(
		await readFile( join( GETTING_STARTED_ARTIFACTS, entry.file ), 'utf8' ),
	);
	assert.ok(
		Array.isArray( browserCapture.__sourceOwners ) && browserCapture.__sourceOwners.length > 0,
		'fixture must retain browser capture source ownership rather than a fabricated artifact',
	);
	const capturedVariants = collectArtifactVariantCandidates( browserCapture.artifact );
	assert.deepEqual(
		capturedVariants.map( ( artifact ) => artifact.shaderLanguage ).sort(),
		[ 'glsl', 'wgsl' ],
		'fixture must retain both WebGL and WebGPU shader variants',
	);
	for ( const artifact of capturedVariants ) {

		const slots = artifact.uniformPlan.flatMap( ( group ) => group.slots || [] );
		assert.equal(
			slots.filter( ( slot ) => slot.source?.kind === 'light.colorScaled' && slot.source?.property === 'groundColor' ).length,
			1,
			`${ artifact.shaderLanguage } must retain the live HemisphereLight ground color`,
		);
		assert.equal(
			slots.filter( ( slot ) => slot.dtype === 'color' && slot.source?.kind === 'uniform.live' && ! slot.source?.property ).length,
			0,
			`${ artifact.shaderLanguage } must not freeze an unaddressed light color`,
		);

	}
	const browserWebGPUCapture = capturedVariants.find( ( artifact ) => artifact.shaderLanguage === 'wgsl' );

	const nodeExtract = await extractMaterial( gettingStartedFactory );
	const capturedShape = fingerprintArtifactShape( browserWebGPUCapture );
	const extractedShape = fingerprintArtifactShape( nodeExtract.artifact );
	const diff = diffArtifactShapes( capturedShape, extractedShape );

	assert.ok( capturedShape.length > 0, 'expected a non-empty browser-capture fingerprint' );
	assert.equal(
		diff.ok,
		true,
		`browser/Node artifact shape drifted:\n  missing=${ JSON.stringify( diff.missing ) }\n  extra=${ JSON.stringify( diff.extra ) }`,
	);

} );
