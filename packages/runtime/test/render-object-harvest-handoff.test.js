import test from 'node:test';
import assert from 'node:assert/strict';

import {
	__resetRenderObjectHarvestHandoffForTests,
	publishRenderObjectHarvest,
	takeRenderObjectHarvest,
} from '../src/auxiliary/render-object-harvest-handoff.js';

test( 'real-render harvest handoff is exact and consume-once per renderer and scene', () => {

	__resetRenderObjectHarvestHandoffForTests();
	const renderer = {};
	const otherRenderer = {};
	const scene = {};
	const otherScene = {};
	const harvest = Promise.resolve( { epoch: 7 } );

	assert.equal( publishRenderObjectHarvest( renderer, scene, harvest ), true );
	assert.equal( takeRenderObjectHarvest( renderer, otherScene ), null );
	assert.equal( takeRenderObjectHarvest( otherRenderer, scene ), null );
	assert.equal( takeRenderObjectHarvest( renderer, scene ), harvest );
	assert.equal( takeRenderObjectHarvest( renderer, scene ), null );

} );
