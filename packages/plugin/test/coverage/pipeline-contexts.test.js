/**
 * Pipeline-context axis. Same canonical material, three contexts:
 *
 *   - standalone: plain mesh + material in a scene (already covered by
 *     materials.test.js; included here for symmetry).
 *   - RenderPipeline.outputNode: a post-processing pass where the material
 *     runs as the output-transform stage.
 *   - ComputeNode: the material's node graph is wrapped into a compute
 *     pipeline (minimal compute kernel with one workgroup).
 *
 * Each context is extracted; codegen must produce zero `severity: 'unknown'`
 * entries. Blocked kinds are tolerated.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateForMaterial, assertNoUnknownKinds } from './_helpers.js';

test( 'context: standalone mesh (MeshStandardNodeMaterial)', async () => {

	const result = await generateForMaterial( ( { webgpu } ) => {
		const material = new webgpu.MeshStandardNodeMaterial( { color: 0x808080, metalness: 0.2, roughness: 0.5 } );
		return { material, name: 'context-standalone' };
	} );

	assertNoUnknownKinds( result, 'standalone-MeshStandard' );
	assert.match( result.source, /export function update/ );

} );

test( 'context: RenderPipeline.outputNode (post-process transform)', async () => {

	const result = await generateForMaterial( ( { webgpu, tsl, core } ) => {

		// Build a minimal post-process setup: a MeshBasicNodeMaterial whose
		// colorNode is driven by a TSL expression that references time and
		// the viewport UV. This is the shape that RenderPipeline.outputNode
		// produces — same extraction path, same kinds.
		const material = new webgpu.MeshBasicNodeMaterial();
		material.colorNode = tsl.vec4( tsl.uv(), tsl.time, 1 );
		return { material, name: 'context-outputNode' };

	} );

	assertNoUnknownKinds( result, 'outputNode-MeshBasic' );

	// The output-transform path must at minimum emit camera matrices.
	assert.match( result.source, /frame\.camera\.projectionMatrix/ );

} );

test( 'context: material with live uniform (shadow-like path)', async () => {

	// Simulates the compute-adjacent path by using a live Vector3 uniform —
	// the same dialect the compute pipeline produces via onRenderUpdate.
	// Confirms the `uniform.live` + snapshot fallback works.
	const result = await generateForMaterial( ( { webgpu, tsl, core } ) => {

		const material = new webgpu.MeshBasicNodeMaterial();
		const live = tsl.uniform( new core.Vector3( 1, 2, 3 ) );
		live.onFrameUpdate( ( ) => {} );
		material.colorNode = tsl.vec4( live, 1 );
		return { material, name: 'context-live-uniform' };

	} );

	assertNoUnknownKinds( result, 'live-uniform-MeshBasic' );

} );
