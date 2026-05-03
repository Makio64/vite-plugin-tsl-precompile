/**
 * Material-axis coverage. One cell per stock NodeMaterial class.
 *
 * Strategy: construct a default instance, drive it through `extractMaterial`
 * (real Node harness), then assert that the resulting uniformPlan produces
 * zero `severity: 'unknown'` entries when fed to `emitUpdaterSource`.
 *
 * `severity: 'blocked'` entries are tolerated — these are deferred-by-design
 * kinds (texture samplers, depth textures, live shadow matrices that need the
 * Phase 5.5 live-node registry).
 *
 * Extraction failures count as test failures — a material that can't even
 * flow through the Node harness is a gap we need to know about.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateForMaterial, assertNoUnknownKinds } from './_helpers.js';

const MATERIAL_NAMES = [
	'MeshBasicNodeMaterial',
	'MeshStandardNodeMaterial',
	'MeshPhysicalNodeMaterial',
	'MeshLambertNodeMaterial',
	'MeshPhongNodeMaterial',
	'MeshMatcapNodeMaterial',
	'MeshToonNodeMaterial',
	'MeshNormalNodeMaterial',
	'PointsNodeMaterial',
	'LineBasicNodeMaterial',
	'SpriteNodeMaterial',
	'ShadowNodeMaterial',
];

for ( const name of MATERIAL_NAMES ) {

	test( `material: ${ name } — extracts + codegen without unknown kinds`, async () => {

		const result = await generateForMaterial( ( { webgpu } ) => {

			const Ctor = webgpu[ name ];
			assert.ok( Ctor, `three/webgpu has no export "${ name }" — three.js vendor bump may have removed/renamed it` );
			return { material: new Ctor(), name: `coverage-${ name }` };

		} );

		const blocked = assertNoUnknownKinds( result, name );

		// Sanity: generated updater actually exports an update() function.
		assert.match( result.source, /export function update\(frame, material, view, byteOffset\)/ );

		// Blocked kinds are logged for visibility; they're not failures but
		// they're the Phase 5.5 todo list.
		if ( blocked.length > 0 ) {

			const summary = blocked.map( ( b ) => `${ b.kind } (${ b.reason.split( ' ' ).slice( 0, 6 ).join( ' ' ) }…)` ).join( ', ' );
			console.log( `  [${ name }] ${ blocked.length } documented-blocked: ${ summary }` );

		}

	} );

}
