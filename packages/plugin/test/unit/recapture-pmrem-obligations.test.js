import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
	createPMREMCubeLayoutConfig,
	createPMREMLayoutConfig,
	createPMREMSupportConfig,
} from '@tsl-precompile/contract/pmrem-config';
import {
	assertRecaptureAuxiliaryObligations,
	readRecaptureArtifactInventories,
} from '../../src/cli/recapture-all-support.js';

function writePMREMInventory( repo, families ) {

	const artifacts = join( repo, 'packages/examples/pmrem-debug/artifacts' );
	mkdirSync( artifacts, { recursive: true } );
	const manifest = { __aux: {} };
	for ( const [ familyIndex, { config, stages } ] of families.entries() ) {

		for ( const stage of stages ) {

			const shape = `pmrem-${ stage }`;
			const file = `${ familyIndex }-${ stage }.json`;
			manifest.__aux[ `${ shape }:${ familyIndex }` ] = { shape, file };
			writeFileSync( join( artifacts, file ), JSON.stringify( {
				artifact: {
					materialShape: shape,
					internalPass: { family: 'pmrem', stage, shape, config },
				},
			} ) );

		}

	}
	writeFileSync( join( artifacts, 'manifest.json' ), JSON.stringify( manifest ) );

}

test( 'recapture validates the captured layout and requires every cube-family stage', () => {

	const repo = mkdtempSync( join( tmpdir(), 'tslp-recapture-pmrem-' ) );
	const examples = [ { name: 'pmrem-debug', requiredAuxiliaryShapes: [ 'pmrem-blur', 'pmrem-ggx' ] } ];
	const atlas = createPMREMSupportConfig( createPMREMLayoutConfig( 256 ), 'scene' );
	const cube = createPMREMSupportConfig( createPMREMCubeLayoutConfig( 256 ), 'scene' );
	try {

		writePMREMInventory( repo, [ { config: atlas, stages: [ 'blur', 'ggx' ] } ] );
		assert.doesNotThrow( () => assertRecaptureAuxiliaryObligations( readRecaptureArtifactInventories( repo, examples ), examples ) );

		writePMREMInventory( repo, [ { config: cube, stages: [ 'blur', 'ggx' ] } ] );
		assert.throws(
			() => assertRecaptureAuxiliaryObligations( readRecaptureArtifactInventories( repo, examples ), examples ),
			/pmrem-integration \(scene, pmrem-cube-layout@1\)/,
		);

		writePMREMInventory( repo, [ { config: cube, stages: [ 'blur', 'ggx', 'integration' ] } ] );
		assert.doesNotThrow( () => assertRecaptureAuxiliaryObligations( readRecaptureArtifactInventories( repo, examples ), examples ) );

		// A same-shape pass belonging to another layout cannot complete this cube family.
		writePMREMInventory( repo, [
			{ config: atlas, stages: [ 'blur', 'ggx' ] },
			{ config: cube, stages: [ 'ggx', 'integration' ] },
		] );
		assert.throws(
			() => assertRecaptureAuxiliaryObligations( readRecaptureArtifactInventories( repo, examples ), examples ),
			/pmrem-blur \(scene, pmrem-cube-layout@1\)/,
		);

		writePMREMInventory( repo, [ { config: { ...cube, layout: { ...cube.layout, lodMax: 99 } }, stages: [ 'blur', 'ggx', 'integration' ] } ] );
		assert.throws( () => readRecaptureArtifactInventories( repo, examples ), /Invalid recapture PMREM config/ );

	} finally {

		rmSync( repo, { recursive: true, force: true } );

	}

} );
