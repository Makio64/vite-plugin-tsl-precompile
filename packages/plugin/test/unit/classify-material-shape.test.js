import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyMaterialShape } from '../../src/vendor/compileTSL.js';

test( 'classifyMaterialShape prefers physical materials over inherited standard flags', () => {

	assert.equal(
		classifyMaterialShape( { isMeshStandardMaterial: true, isMeshPhysicalMaterial: true } ),
		'mesh-physical'
	);
	assert.equal(
		classifyMaterialShape( { isMeshStandardNodeMaterial: true, isMeshPhysicalNodeMaterial: true } ),
		'mesh-physical'
	);

} );
