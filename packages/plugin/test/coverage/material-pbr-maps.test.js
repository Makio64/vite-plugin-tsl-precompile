/**
 * PBR-map coverage. Asserts that a `MeshStandardNodeMaterial` configured with
 * `lightMap` + `lightMapIntensity` and `displacementMap` + `displacementScale`
 * + `displacementBias` extracts artifact bindings tagged with the expected
 * `material.<prop>` source kinds.
 *
 * Regression guard for the broken `webgpu_materials_lightmap.html` /
 * `webgpu_materials_displacementmap.html` examples — replays were rendering
 * essentially black because the swap material wasn't carrying live texture
 * + scalar values. This test pins the extractor contract so the runtime side
 * (`__copyMaterialProps` / `__SCALAR_PROPS` / `__TEXTURE_PROPS`) and the
 * hydrator's `material.*` resolver have a stable surface to bind against.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateForMaterial, assertNoUnknownKinds } from './_helpers.js';

test( 'material: MeshStandardNodeMaterial with lightMap + displacementMap exposes expected material.* bindings', async () => {

	const result = await generateForMaterial( ( { webgpu, core } ) => {

		const lightTex = new core.DataTexture(
			new Uint8Array( [ 255, 128, 64, 255, 200, 200, 200, 255 ] ),
			2, 1,
		);
		lightTex.needsUpdate = true;

		const dispTex = new core.DataTexture(
			new Uint8Array( [ 100, 0, 0, 0, 200, 0, 0, 0 ] ),
			2, 1,
		);
		dispTex.needsUpdate = true;

		const material = new webgpu.MeshStandardNodeMaterial();
		material.lightMap = lightTex;
		material.lightMapIntensity = 0.7;
		material.displacementMap = dispTex;
		material.displacementScale = 1.5;
		material.displacementBias = - 0.25;

		return { material, name: 'coverage-pbr-maps' };

	} );

	// Walk every binding (textures + slots) across all uniformPlan groups and
	// collect a flat list of (name, kind) tuples — far easier to assert against.
	const allBindings = [];
	for ( const group of result.artifact.uniformPlan ) {

		for ( const tex of group.textures || [] ) {

			allBindings.push( { name: tex.name, kind: tex.source && tex.source.kind } );

		}

		for ( const slot of group.slots || [] ) {

			allBindings.push( { name: slot.name, kind: slot.source && slot.source.kind } );

		}

	}

	const kinds = allBindings.map( ( b ) => b.kind );

	// Texture bindings — tagged `material.<map>` so the hydrator pulls the
	// live Texture instance off `material.lightMap` / `material.displacementMap`.
	assert.ok( kinds.includes( 'material.lightMap' ), `expected material.lightMap binding; got: ${ kinds.join( ', ' ) }` );
	assert.ok( kinds.includes( 'material.displacementMap' ), `expected material.displacementMap binding; got: ${ kinds.join( ', ' ) }` );

	// Scalar bindings — these must flow through __SCALAR_PROPS at replay time
	// so live GUI tweaks reach the precompiled material.
	assert.ok( kinds.includes( 'material.lightMapIntensity' ), `expected material.lightMapIntensity binding; got: ${ kinds.join( ', ' ) }` );
	assert.ok( kinds.includes( 'material.displacementScale' ), `expected material.displacementScale binding; got: ${ kinds.join( ', ' ) }` );
	assert.ok( kinds.includes( 'material.displacementBias' ), `expected material.displacementBias binding; got: ${ kinds.join( ', ' ) }` );

	assertNoUnknownKinds( result, 'material-pbr-maps' );

	// Sanity: generated updater function is present.
	assert.match( result.source, /export function update\(frame, material, view, byteOffset\)/ );

} );
