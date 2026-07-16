import test from 'node:test';
import assert from 'node:assert/strict';

import { range } from 'three/tsl';
import {
	INSTANCE_MATRIX_ATTRIBUTE_KIND,
	generateRangeAttributeArray,
} from '@tsl-precompile/contract/attribute-generators';
import { installMockWebGPU, createMockGPUCanvasContext } from '../../src/mock-webgpu.js';
import { extractArtifact } from '../../src/vendor/compileTSL.js';
import { beginRenderObjectHarvest } from '../../src/vendor/render-object-observer.js';
import { installRangeAttributeCapture } from '../../../runtime/src/range-attribute-capture.js';
import { hydrateNodeBuilderState } from '../../../runtime/src/hydrator.js';

installMockWebGPU();

test( 'real r184 RangeNode and instanceMatrix capture as recipes/provenance', async () => {

	const THREE = await import( 'three/webgpu' );
	installRangeAttributeCapture( THREE );
	const renderer = new THREE.WebGPURenderer( { canvas: fakeCanvas(), antialias: false } );
	await renderer.init();

	const material = new THREE.SpriteNodeMaterial();
	material.scaleNode = range( 0, 1 );
	const mesh = new THREE.InstancedMesh( new THREE.PlaneGeometry( 1, 1 ), material, 5000 );
	const scene = new THREE.Scene();
	scene.add( mesh );
	const camera = new THREE.PerspectiveCamera( 45, 1, 0.1, 10 );
	camera.position.z = 3;

	const session = beginRenderObjectHarvest( renderer );
	renderer.render( scene, camera );
	const harvest = await session.finish();
	const family = harvest.familiesByMaterial.get( material );
	const variant = family && family.variants.find( ( candidate ) => candidate.objects.includes( mesh ) );
	assert.ok( variant );
	const artifact = extractArtifact( variant.cacheKey, variant.nodeBuilderState, material, mesh );
	const nodeAttributes = artifact.attributes.filter( ( entry ) => entry.source === 'node' );
	const generated = nodeAttributes.filter( ( entry ) => entry.arrayGenerator );
	const matrixColumns = nodeAttributes.filter( ( entry ) => entry.objectAttribute && entry.objectAttribute.kind === INSTANCE_MATRIX_ATTRIBUTE_KIND );

	assert.equal( generated.length, 1 );
	assert.equal( generated[ 0 ].arrayGenerator.kind, 'range@1' );
	assert.equal( generated[ 0 ].arraySnapshot, undefined );
	assert.deepEqual( matrixColumns.map( ( entry ) => entry.objectAttribute.column ).sort(), [ 0, 1, 2, 3 ] );
	assert.ok( matrixColumns.every( ( entry ) => entry.arraySnapshot === undefined ) );

	const roundTripped = JSON.parse( JSON.stringify( artifact ) );
	const replayState = hydrateNodeBuilderState( roundTripped, material, mesh );
	const generatedIndex = artifact.attributes.indexOf( generated[ 0 ] );
	assert.deepEqual(
		replayState.nodeAttributes[ generatedIndex ].node.attribute.array,
		generateRangeAttributeArray( generated[ 0 ].arrayGenerator, generated[ 0 ].count ),
	);

	renderer.dispose();

} );

function fakeCanvas( width = 64, height = 64 ) {

	let context = null;
	return {
		width,
		height,
		clientWidth: width,
		clientHeight: height,
		style: {},
		getContext( kind ) {

			if ( kind !== 'webgpu' ) return null;
			context ||= createMockGPUCanvasContext();
			return context;

		},
		addEventListener() {},
		removeEventListener() {},
		getBoundingClientRect: () => ( { left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0 } ),
	};

}
