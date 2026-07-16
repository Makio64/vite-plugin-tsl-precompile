import assert from 'node:assert/strict';
import test from 'node:test';

import { isTransparentRenderMaterial, passRendersMaterial } from '../pass-material-visibility.mjs';

test( 'matches Three r184 RenderList transparent classification', () => {

	assert.equal( isTransparentRenderMaterial( { transparent: false, transmission: 0 } ), false );
	assert.equal( isTransparentRenderMaterial( { transparent: true } ), true );
	assert.equal( isTransparentRenderMaterial( { transmission: 0.5 } ), true );
	assert.equal( isTransparentRenderMaterial( { transmissionNode: { isNode: true } } ), true );
	assert.equal( isTransparentRenderMaterial( { backdropNode: { isNode: true } } ), true );

} );

test( 'excludes materials disabled by a pass before MRT retargeting', () => {

	const opaque = { transparent: false };
	const transparent = { transparent: true };

	assert.equal( passRendersMaterial( { opaque: true, transparent: false }, opaque ), true );
	assert.equal( passRendersMaterial( { opaque: true, transparent: false }, transparent ), false );
	assert.equal( passRendersMaterial( { opaque: false, transparent: true }, opaque ), false );
	assert.equal( passRendersMaterial( { opaque: false, transparent: true }, transparent ), true );
	assert.equal( passRendersMaterial( null, transparent ), true );

} );
