import test from 'node:test';
import assert from 'node:assert/strict';

import {
	artifactHasTextureSource,
	attachArtifactTextureRefsWhere,
	attachExactMaterialGraphDepthTextureRefs,
	attachTextureRefsWhere,
	countArtifactTextureSources,
	rewritePassDepthTextureSources,
	singleArtifactTextureUuid,
	textureMatchesArtifactSource,
	textureMatchesSource,
} from '../src/slim-support/artifact-texture-wiring.js';
import { createRendererRenderTargetTextureSelector } from '../../contract/src/render-target-texture.js';

function makeArtifact( textureEntries ) {

	return {
		uniformPlan: [ { name: 'render', textures: textureEntries } ],
	};

}

function makeArrayDepthTarget( overrides = {} ) {

	const colorTexture = {
		isTexture: true,
		isDataArrayTexture: true,
		format: 1023,
		type: 1009,
		colorSpace: '',
	};
	const depthTexture = {
		isTexture: true,
		isDepthTexture: true,
		isDataArrayTexture: true,
		name: 'ShadowDepthArrayTexture',
		format: 1026,
		type: 1014,
		colorSpace: '',
		...overrides.depthTexture,
	};
	const target = {
		isArrayRenderTarget: true,
		width: 4096,
		height: 4096,
		depth: 4,
		texture: colorTexture,
		textures: [ colorTexture ],
		depthTexture,
		...overrides.target,
	};
	colorTexture.renderTarget = target;
	depthTexture.renderTarget = target;
	return { target, colorTexture, depthTexture };

}

function materialGraphDepthSource( selector, overrides = {} ) {

	return {
		kind: 'depth.texture',
		textureUuid: 'captured-shadow-array-depth',
		lightIndex: - 1,
		lightUuid: null,
		fromMaterialGraph: true,
		renderTargetSelector: selector,
		...overrides,
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

test( 'textureMatchesSource matches canonical same-origin paths and rejects same-basename path collisions', () => {

	const locationDescriptor = Object.getOwnPropertyDescriptor( globalThis, 'location' );
	Object.defineProperty( globalThis, 'location', {
		value: { href: 'http://localhost:5210/examples/ocean/' },
		configurable: true,
	} );
	try {

		const tex = {
			isTexture: true,
			uuid: 'live-texture',
			name: 'shared.png',
			image: { src: 'http://localhost:5210/textures/first/shared.png' },
		};
		assert.equal( textureMatchesSource( tex, {
			kind: 'artifact.texture',
			textureName: 'shared.png',
			imageSrc: '/textures/first/shared.png',
		} ), true );
		assert.equal( textureMatchesSource( tex, {
			kind: 'artifact.texture',
			textureName: 'shared.png',
			imageSrc: '/textures/second/shared.png',
		} ), false );

	} finally {

		if ( locationDescriptor ) Object.defineProperty( globalThis, 'location', locationDescriptor );
		else delete globalThis.location;

	}

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
	assert.equal(
		attachTextureRefsWhere( artifact, tex, ( source ) => source.textureUuid === 'captured-a' ),
		false,
		'repeating the same live texture is not reported as a rebind',
	);

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

test( 'attachExactMaterialGraphDepthTextureRefs attaches one exact current array-depth attachment', () => {

	const { target, depthTexture } = makeArrayDepthTarget();
	const selector = createRendererRenderTargetTextureSelector( target, { texture: depthTexture } );
	const source = materialGraphDepthSource( selector );
	const artifact = makeArtifact( [
		{ bindingKind: 'sampled-texture', source },
		{ bindingKind: 'sampler', source: { ...source } },
	] );

	assert.equal( attachExactMaterialGraphDepthTextureRefs( artifact, [ depthTexture ] ), 1 );
	assert.equal( artifact._textureRefs.get( source.textureUuid ), depthTexture );
	assert.equal(
		attachExactMaterialGraphDepthTextureRefs( artifact, [ depthTexture ] ),
		0,
		'repeating the exact attachment is idempotent',
	);

} );

test( 'attachExactMaterialGraphDepthTextureRefs stays pending until the exact attachment is discoverable', () => {

	const { target, depthTexture } = makeArrayDepthTarget();
	const selector = createRendererRenderTargetTextureSelector( target, { texture: depthTexture } );
	const artifact = makeArtifact( [ { source: materialGraphDepthSource( selector ) } ] );

	assert.equal( attachExactMaterialGraphDepthTextureRefs( artifact, [] ), 0 );
	assert.equal( artifact._textureRefs, undefined );
	assert.equal( attachExactMaterialGraphDepthTextureRefs( artifact, [ depthTexture ] ), 1 );
	assert.equal( artifact._textureRefs.get( 'captured-shadow-array-depth' ), depthTexture );
	assert.equal( attachExactMaterialGraphDepthTextureRefs( artifact, [] ), 0 );
	assert.equal(
		artifact._textureRefs.has( 'captured-shadow-array-depth' ),
		false,
		'losing the live candidate clears its stale preferred ref',
	);

} );

test( 'attachExactMaterialGraphDepthTextureRefs clears a prior winner when candidates become ambiguous', () => {

	const captured = makeArrayDepthTarget();
	const selector = createRendererRenderTargetTextureSelector( captured.target, { texture: captured.depthTexture } );
	const artifact = makeArtifact( [ { source: materialGraphDepthSource( selector ) } ] );
	const first = makeArrayDepthTarget();
	const second = makeArrayDepthTarget();
	const unrelated = { isTexture: true };
	Object.defineProperty( artifact, '_textureRefs', {
		value: new Map( [ [ 'unrelated', unrelated ] ] ),
		configurable: true,
		writable: true,
	} );

	assert.equal( attachExactMaterialGraphDepthTextureRefs( artifact, [ first.depthTexture ] ), 1 );
	assert.equal( artifact._textureRefs.get( 'captured-shadow-array-depth' ), first.depthTexture );
	assert.equal(
		attachExactMaterialGraphDepthTextureRefs(
			artifact,
			[ first.depthTexture, second.depthTexture ],
		),
		0,
	);
	assert.equal( artifact._textureRefs.has( 'captured-shadow-array-depth' ), false );
	assert.equal( artifact._textureRefs.get( 'unrelated' ), unrelated, 'unrelated texture refs are preserved' );

} );

test( 'attachExactMaterialGraphDepthTextureRefs rejects detached, mismatched, ambiguous, and light-owned depths', () => {

	const captured = makeArrayDepthTarget();
	const selector = createRendererRenderTargetTextureSelector( captured.target, { texture: captured.depthTexture } );
	const makeArtifactFor = ( overrides = {} ) => makeArtifact( [
		{ source: materialGraphDepthSource( selector, overrides ) },
	] );

	const detached = makeArrayDepthTarget();
	detached.target.depthTexture = { isTexture: true, isDepthTexture: true };
	assert.equal( attachExactMaterialGraphDepthTextureRefs( makeArtifactFor(), [ detached.depthTexture ] ), 0 );

	for ( const candidate of [
		makeArrayDepthTarget( { depthTexture: { name: 'DifferentDepthName' } } ),
		makeArrayDepthTarget( { depthTexture: { format: 1027 } } ),
		makeArrayDepthTarget( { depthTexture: { type: 1015 } } ),
		makeArrayDepthTarget( {
			target: { isArrayRenderTarget: false },
			depthTexture: { isDataArrayTexture: false },
		} ),
	] ) {

		assert.equal(
			attachExactMaterialGraphDepthTextureRefs( makeArtifactFor(), [ candidate.depthTexture ] ),
			0,
		);

	}

	const anonymousCaptured = makeArrayDepthTarget( { depthTexture: { name: '' } } );
	const anonymousSelector = createRendererRenderTargetTextureSelector(
		anonymousCaptured.target,
		{ texture: anonymousCaptured.depthTexture },
	);
	const anonymousArtifact = makeArtifact( [
		{ source: materialGraphDepthSource( anonymousSelector ) },
	] );
	const wrongExtent = makeArrayDepthTarget( {
		target: { depth: 8 },
		depthTexture: { name: '' },
	} );
	assert.equal(
		attachExactMaterialGraphDepthTextureRefs( anonymousArtifact, [ wrongExtent.depthTexture ] ),
		0,
		'anonymous attachments must match their captured extent',
	);

	const first = makeArrayDepthTarget();
	const second = makeArrayDepthTarget();
	assert.equal(
		attachExactMaterialGraphDepthTextureRefs(
			makeArtifactFor(),
			[ first.depthTexture, second.depthTexture ],
		),
		0,
		'multiple exact candidates are ambiguous',
	);
	assert.equal(
		attachExactMaterialGraphDepthTextureRefs(
			makeArtifactFor( { lightIndex: 0, lightUuid: 'light-a' } ),
			[ first.depthTexture ],
		),
		0,
		'light-owned shadow sources remain on the dedicated shadow path',
	);

} );

test( 'attachExactMaterialGraphDepthTextureRefs rejects conflicting selectors for one captured UUID', () => {

	const first = makeArrayDepthTarget();
	const second = makeArrayDepthTarget( { target: { depth: 8 } } );
	const firstSelector = createRendererRenderTargetTextureSelector( first.target, { texture: first.depthTexture } );
	const secondSelector = createRendererRenderTargetTextureSelector( second.target, { texture: second.depthTexture } );
	const artifact = makeArtifact( [
		{ source: materialGraphDepthSource( firstSelector ) },
		{ source: materialGraphDepthSource( secondSelector ) },
	] );

	assert.equal(
		attachExactMaterialGraphDepthTextureRefs( artifact, [ first.depthTexture, second.depthTexture ] ),
		0,
	);
	assert.equal( artifact._textureRefs, undefined );

} );

test( 'attachExactMaterialGraphDepthTextureRefs discovers variant-only sources on the root sidecar', () => {

	const { target, depthTexture } = makeArrayDepthTarget();
	const selector = createRendererRenderTargetTextureSelector( target, { texture: depthTexture } );
	const artifact = {
		uniformPlan: [],
		variants: {
			arrayDepth: makeArtifact( [
				{ source: materialGraphDepthSource( selector ) },
			] ),
		},
	};

	assert.equal( attachExactMaterialGraphDepthTextureRefs( artifact, [ depthTexture ] ), 1 );
	assert.equal( artifact._textureRefs.get( 'captured-shadow-array-depth' ), depthTexture );
	assert.equal( artifact.variants.arrayDepth._textureRefs, undefined );

} );

test( 'attachExactMaterialGraphDepthTextureRefs rejects selector conflicts across variants', () => {

	const first = makeArrayDepthTarget();
	const second = makeArrayDepthTarget( { depthTexture: { name: 'OtherDepthArrayTexture' } } );
	const firstSelector = createRendererRenderTargetTextureSelector( first.target, { texture: first.depthTexture } );
	const secondSelector = createRendererRenderTargetTextureSelector( second.target, { texture: second.depthTexture } );
	const artifact = {
		uniformPlan: [],
		variants: {
			first: makeArtifact( [ { source: materialGraphDepthSource( firstSelector ) } ] ),
			second: makeArtifact( [ { source: materialGraphDepthSource( secondSelector ) } ] ),
		},
	};
	Object.defineProperty( artifact, '_textureRefs', {
		value: new Map( [ [ 'captured-shadow-array-depth', first.depthTexture ] ] ),
		configurable: true,
		writable: true,
	} );

	assert.equal(
		attachExactMaterialGraphDepthTextureRefs( artifact, [ first.depthTexture, second.depthTexture ] ),
		0,
	);
	assert.equal(
		artifact._textureRefs.has( 'captured-shadow-array-depth' ),
		false,
		'a cross-variant conflict clears an inherited preferred texture',
	);

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
