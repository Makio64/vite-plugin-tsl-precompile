import test from 'node:test';
import assert from 'node:assert/strict';

import {
	MATERIAL_NODE_TEXTURE_KEYS,
	MATERIAL_TEXTURE_PROPS,
	NODE_GRAPH_TEXTURE_KEYS,
} from '@tsl-precompile/contract/texture-props';
import {
	MATERIAL_TEXTURE_PROPS as INDEX_MATERIAL_TEXTURE_PROPS,
	NODE_GRAPH_TEXTURE_KEYS as INDEX_NODE_GRAPH_TEXTURE_KEYS,
} from '@tsl-precompile/contract';

test( 'contract texture props are single shared references', () => {

	assert.strictEqual( INDEX_MATERIAL_TEXTURE_PROPS, MATERIAL_TEXTURE_PROPS );
	assert.strictEqual( INDEX_NODE_GRAPH_TEXTURE_KEYS, NODE_GRAPH_TEXTURE_KEYS );
	assert.ok( Object.isFrozen( MATERIAL_TEXTURE_PROPS ) );
	assert.ok( Object.isFrozen( NODE_GRAPH_TEXTURE_KEYS ) );

} );

test( 'contract texture props cover PBR material and node texture slots', () => {

	assert.ok( MATERIAL_TEXTURE_PROPS.includes( 'anisotropyMap' ) );
	assert.ok( MATERIAL_TEXTURE_PROPS.includes( 'transmissionMap' ) );
	assert.ok( MATERIAL_TEXTURE_PROPS.includes( 'sheenColorMap' ) );
	assert.ok( NODE_GRAPH_TEXTURE_KEYS.includes( 'transmissionNode' ) );
	assert.ok( NODE_GRAPH_TEXTURE_KEYS.includes( 'mrtNode' ) );
	assert.ok( NODE_GRAPH_TEXTURE_KEYS.includes( 'offsetNode' ) );
	assert.ok( NODE_GRAPH_TEXTURE_KEYS.includes( 'scatteringNode' ) );
	assert.ok( MATERIAL_NODE_TEXTURE_KEYS.includes( 'castShadowNode' ) );

} );
