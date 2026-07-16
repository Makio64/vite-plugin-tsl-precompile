import test from 'node:test';
import assert from 'node:assert/strict';

import {
	artifactHasTextureSource,
	attachArtifactTextureRefsWhere,
	attachTextureRefsWhere,
	countArtifactTextureSources,
	rewritePassDepthTextureSources,
	singleArtifactTextureUuid,
	textureMatchesArtifactSource,
	textureMatchesSource,
} from '../src/slim-support/artifact-texture-wiring.js';

function makeArtifact( textureEntries ) {

	return {
		uniformPlan: [ { name: 'render', textures: textureEntries } ],
	};

}

test( 'textureMatchesSource matches by uuid first', () => {

	const tex = { isTexture: true, uuid: 'tex-a', name: 'foo' };
	assert.equal( textureMatchesSource( tex, { kind: 'artifact.texture', textureUuid: 'tex-a' } ), true );
	assert.equal( textureMatchesSource( tex, { kind: 'artifact.texture', textureUuid: 'tex-b' } ), false );

} );

test( 'textureMatchesSource falls back to textureName', () => {

	const tex = { isTexture: true, uuid: 'tex-a', name: 'diffuse.png' };
	assert.equal( textureMatchesSource( tex, { kind: 'artifact.texture', textureName: 'diffuse.png' } ), true );
	assert.equal( textureMatchesSource( tex, { kind: 'artifact.texture', textureName: 'normal.png' } ), false );

} );

test( 'textureMatchesSource falls back to basename', () => {

	const tex = { isTexture: true, name: 'a/b/diffuse.png' };
	assert.equal( textureMatchesSource( tex, { kind: 'artifact.texture', textureName: 'q/r/diffuse.png' } ), true );

} );

test( 'textureMatchesArtifactSource only fires on kind=artifact.texture', () => {

	const tex = { isTexture: true, uuid: 'tex-a' };
	assert.equal( textureMatchesArtifactSource( tex, { kind: 'artifact.texture', textureUuid: 'tex-a' } ), true );
	assert.equal( textureMatchesArtifactSource( tex, { kind: 'material.map', textureUuid: 'tex-a' } ), false );

} );

test( 'textureMatchesSource rejects non-textures', () => {

	assert.equal( textureMatchesSource( null, { kind: 'artifact.texture' } ), false );
	assert.equal( textureMatchesSource( { isTexture: false }, { kind: 'artifact.texture' } ), false );
	assert.equal( textureMatchesSource( { isTexture: true }, null ), false );

} );

test( 'artifactHasTextureSource walks the uniform plan', () => {

	const artifact = makeArtifact( [
		{ source: { kind: 'artifact.texture', textureUuid: 'a' } },
		{ source: { kind: 'material.map' } },
	] );
	assert.equal( artifactHasTextureSource( artifact ), true );
	assert.equal( artifactHasTextureSource( artifact, ( s ) => s.kind === 'material.map' ), true );
	assert.equal( artifactHasTextureSource( artifact, ( s ) => s.kind === 'depth.texture' ), false );

} );

test( 'countArtifactTextureSources de-duplicates by uuid', () => {

	const artifact = makeArtifact( [
		{ source: { kind: 'artifact.texture', textureUuid: 'a' } },
		{ source: { kind: 'artifact.texture', textureUuid: 'b' } },
		{ source: { kind: 'artifact.texture', textureUuid: 'a' } },
		{ source: { kind: 'material.map' } },
	] );
	assert.equal( countArtifactTextureSources( artifact ), 2 );

} );

test( 'singleArtifactTextureUuid returns the uuid when exactly one matches, null otherwise', () => {

	const single = makeArtifact( [ { source: { kind: 'artifact.texture', textureUuid: 'a' } } ] );
	const multi = makeArtifact( [
		{ source: { kind: 'artifact.texture', textureUuid: 'a' } },
		{ source: { kind: 'artifact.texture', textureUuid: 'b' } },
	] );
	assert.equal( singleArtifactTextureUuid( single ), 'a' );
	assert.equal( singleArtifactTextureUuid( multi ), null );

} );

test( 'attachTextureRefsWhere stamps `_textureRefs` as a non-enumerable Map', () => {

	const tex = { isTexture: true, uuid: 'live-a' };
	const artifact = makeArtifact( [
		{ source: { kind: 'artifact.texture', textureUuid: 'captured-a' } },
	] );
	const changed = attachTextureRefsWhere( artifact, tex, ( source ) => source.textureUuid === 'captured-a' );
	assert.equal( changed, true );
	assert.ok( artifact._textureRefs instanceof Map );
	assert.equal( artifact._textureRefs.get( 'captured-a' ), tex );
	assert.equal( Object.prototype.propertyIsEnumerable.call( artifact, '_textureRefs' ), false );

} );

test( 'attachTextureRefsWhere preserves prior entries', () => {

	const texA = { isTexture: true, uuid: 'live-a' };
	const texB = { isTexture: true, uuid: 'live-b' };
	const artifact = makeArtifact( [
		{ source: { kind: 'artifact.texture', textureUuid: 'a' } },
		{ source: { kind: 'artifact.texture', textureUuid: 'b' } },
	] );
	attachTextureRefsWhere( artifact, texA, ( source ) => source.textureUuid === 'a' );
	attachTextureRefsWhere( artifact, texB, ( source ) => source.textureUuid === 'b' );
	assert.equal( artifact._textureRefs.get( 'a' ), texA );
	assert.equal( artifact._textureRefs.get( 'b' ), texB );

} );

test( 'attachArtifactTextureRefsWhere only attaches for artifact.texture kind', () => {

	const tex = { isTexture: true };
	const artifact = makeArtifact( [
		{ source: { kind: 'artifact.texture', textureUuid: 'a' } },
		{ source: { kind: 'material.map', textureUuid: 'b' } },
	] );
	attachArtifactTextureRefsWhere( artifact, tex, () => true );
	assert.equal( artifact._textureRefs.get( 'a' ), tex );
	assert.equal( artifact._textureRefs.has( 'b' ), false );

} );

test( 'attachTextureRefsWhere returns false when no match', () => {

	const tex = { isTexture: true };
	const artifact = makeArtifact( [
		{ source: { kind: 'artifact.texture', textureUuid: 'a' } },
	] );
	const changed = attachTextureRefsWhere( artifact, tex, ( source ) => source.textureUuid === 'no-match' );
	assert.equal( changed, false );
	assert.equal( artifact._textureRefs, undefined );

} );

test( 'attachTextureRefsWhere rejects non-texture inputs', () => {

	const artifact = makeArtifact( [
		{ source: { kind: 'artifact.texture', textureUuid: 'a' } },
	] );
	assert.equal( attachTextureRefsWhere( artifact, null, () => true ), false );
	assert.equal( attachTextureRefsWhere( artifact, { isTexture: false }, () => true ), false );
	assert.equal( attachTextureRefsWhere( null, { isTexture: true }, () => true ), false );

} );

test( 'rewritePassDepthTextureSources rewrites root and represented family plans', () => {

	const passDepth = () => ( {
		kind: 'depth.texture',
		textureUuid: 'pass-depth',
		lightIndex: - 1,
		lightUuid: null,
		fromMaterialGraph: true,
	} );
	const shadowDepth = () => ( {
		kind: 'depth.texture',
		textureUuid: 'shadow-depth',
		lightIndex: 0,
		lightUuid: 'light-a',
		fromMaterialGraph: true,
	} );
	const rootSource = passDepth();
	const rootOrderedSource = passDepth();
	const variantSource = passDepth();
	const variantOrderedSource = passDepth();
	const dynamicSource = passDepth();
	const rootShadow = shadowDepth();
	const variantShadow = shadowDepth();
	const artifact = {
		cacheKey: 'root',
		uniformPlan: [ {
			name: 'object',
			textures: [ { source: rootSource }, { source: rootShadow } ],
			orderedBindings: [ { type: 'sampled-texture', ref: { source: rootOrderedSource } } ],
		} ],
		variants: {
			root: {
				cacheKey: 'root',
				uniformPlan: [ {
					name: 'object',
					textures: [ { source: variantSource }, { source: variantShadow } ],
					orderedBindings: [ { type: 'sampled-texture', ref: { source: variantOrderedSource } } ],
				} ],
				dynamicBindings: [ {
					kind: 'depth.texture',
					target: 'sampled-texture',
					source: dynamicSource,
				} ],
			},
		},
	};

	assert.ok( rewritePassDepthTextureSources( artifact, new Set( [ 'pass-depth' ] ) ) > 0 );
	for ( const source of [ rootSource, rootOrderedSource, variantSource, variantOrderedSource, dynamicSource ] ) {

		assert.equal( source.kind, 'artifact.texture' );
		assert.equal( source.textureName, 'depth' );
		assert.equal( source.__tslpPassDepthAttached, true );

	}
	assert.equal( artifact.variants.root.dynamicBindings[ 0 ].kind, 'artifact.texture' );
	assert.equal( rootShadow.kind, 'depth.texture' );
	assert.equal( variantShadow.kind, 'depth.texture' );
	assert.equal( rewritePassDepthTextureSources( artifact, [ 'pass-depth' ] ), 0, 'rewrite is idempotent' );

} );

test( 'rewritePassDepthTextureSources only rewrites attached pass UUIDs', () => {

	const selected = {
		kind: 'depth.texture',
		textureUuid: 'selected',
		lightIndex: - 1,
		fromMaterialGraph: true,
	};
	const other = {
		kind: 'depth.texture',
		textureUuid: 'other',
		lightIndex: - 1,
		fromMaterialGraph: true,
	};
	const artifact = makeArtifact( [ { source: selected }, { source: other } ] );

	assert.equal( rewritePassDepthTextureSources( artifact, [ 'selected' ] ), 1 );
	assert.equal( selected.kind, 'artifact.texture' );
	assert.equal( other.kind, 'depth.texture' );

} );
