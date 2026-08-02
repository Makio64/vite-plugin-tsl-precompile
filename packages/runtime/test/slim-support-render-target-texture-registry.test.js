import test from 'node:test';
import assert from 'node:assert/strict';

import {
	RENDERER_RENDER_TARGET_TEXTURE_SELECTOR_SCHEMA,
	RENDER_TARGET_TEXTURE_RESOLUTION_STATUS,
	createRendererRenderTargetTextureRegistry,
	createRendererRenderTargetTextureSelector,
	getRendererRenderTargetTextureRegistry,
	resolveRendererRenderTargetTexture,
} from '../src/slim-support/render-target-texture-registry.js';

function makeTexture( options = {} ) {

	const {
		name = '',
		format = 1023,
		type = 1009,
		colorSpace = 'srgb-linear',
		width = 100,
		height = 100,
		depth = 1,
		dimension = '2d',
		isDepthTexture = false,
	} = options;
	return {
		isTexture: true,
		isRenderTargetTexture: true,
		isDepthTexture,
		isCubeTexture: dimension === 'cube',
		isDataArrayTexture: dimension === '2d-array',
		isData3DTexture: dimension === '3d',
		name,
		format,
		type,
		colorSpace,
		image: { width, height, depth },
	};

}

function makeTarget( options = {} ) {

	const {
		width = 100,
		height = 100,
		depth = 1,
		colors = [ makeTexture( { width, height, depth } ) ],
		depthTexture = null,
		dimension = '2d',
	} = options;
	const target = {
		isRenderTarget: true,
		width,
		height,
		depth,
		depthTexture,
		isWebGLCubeRenderTarget: dimension === 'cube',
		isWebGLArrayRenderTarget: dimension === '2d-array',
		isWebGL3DRenderTarget: dimension === '3d',
	};
	if ( colors.length > 1 ) {

		target.textures = colors;
		target.texture = colors[ 0 ];

	} else {

		target.texture = colors[ 0 ] || null;

	}
	return target;

}

function makeRenderer() {

	return {
		_target: null,
		calls: [],
		getRenderTarget() {

			return this._target;

		},
		setRenderTarget( target, activeLayer = 0, activeMipmapLevel = 0 ) {

			this.calls.push( { target, activeLayer, activeMipmapLevel } );
			this._target = target;
			return `bound:${ activeLayer }:${ activeMipmapLevel }`;

		},
	};

}

function makeRendererWithBackend() {

	const renderer = makeRenderer();
	const backendEntries = new WeakMap();
	const textureEntries = new WeakMap();
	renderer.backend = {
		has( texture ) {

			return backendEntries.has( texture );

		},
		get( texture ) {

			return backendEntries.get( texture );

		},
	};
	renderer._textures = {
		has( texture ) {

			return textureEntries.has( texture );

		},
		get( texture ) {

			return textureEntries.get( texture );

		},
	};
	renderer.proveTextureOwnership = ( texture, options = {} ) => {

		backendEntries.set( texture, { texture: {} } );
		textureEntries.set( texture, { isDefaultTexture: options.isDefaultTexture === true } );

	};
	return renderer;

}

function observeAndUnbind( renderer, ...targets ) {

	for ( const target of targets ) renderer.setRenderTarget( target );
	renderer.setRenderTarget( null );

}

test( 'render-target texture selector captures attachment, target topology, texture shape, and hints', () => {

	const first = makeTexture( { name: 'normal', format: 1015, type: 1016, colorSpace: '' } );
	const second = makeTexture( {
		name: 'beauty',
		format: 1023,
		type: 1016,
		colorSpace: 'display-p3',
		dimension: '2d-array',
		depth: 4,
	} );
	const target = makeTarget( {
		width: 320,
		height: 180,
		depth: 4,
		colors: [ first, second ],
		dimension: '2d-array',
	} );

	assert.deepEqual( createRendererRenderTargetTextureSelector( target, { texture: second } ), {
		schema: RENDERER_RENDER_TARGET_TEXTURE_SELECTOR_SCHEMA,
		attachment: { role: 'color', index: 1 },
		target: {
			topology: 'mrt',
			dimension: '2d-array',
			mrtCount: 2,
		},
		texture: {
			dimension: '2d-array',
			format: 1023,
			type: 1016,
			colorSpace: 'display-p3',
		},
		hints: {
			name: 'beauty',
			extent: { width: 320, height: 180, depth: 4 },
		},
	} );

} );

test( 'renderer registries are isolated even when targets have identical anonymous topology', () => {

	const rendererA = makeRenderer();
	const rendererB = makeRenderer();
	const registryA = createRendererRenderTargetTextureRegistry( rendererA );
	const registryB = createRendererRenderTargetTextureRegistry( rendererB );
	const targetA = makeTarget();
	const targetB = makeTarget();
	const selector = createRendererRenderTargetTextureSelector( targetA );
	observeAndUnbind( rendererA, targetA );
	observeAndUnbind( rendererB, targetB );

	const resultA = registryA.resolve( selector );
	const resultB = registryB.resolve( selector );
	assert.equal( resultA.status, RENDER_TARGET_TEXTURE_RESOLUTION_STATUS.RESOLVED );
	assert.equal( resultA.texture, targetA.texture );
	assert.equal( resultB.status, RENDER_TARGET_TEXTURE_RESOLUTION_STATUS.RESOLVED );
	assert.equal( resultB.texture, targetB.texture );
	assert.notEqual( resultA.texture, resultB.texture );

} );

test( 'same-renderer anonymous targets with identical topology are ambiguous', () => {

	const renderer = makeRenderer();
	const registry = createRendererRenderTargetTextureRegistry( renderer );
	const first = makeTarget();
	const second = makeTarget();
	const selector = createRendererRenderTargetTextureSelector( first );
	observeAndUnbind( renderer, first, second );

	const result = registry.resolve( selector );
	assert.deepEqual( result, {
		status: 'ambiguous',
		reason: 'multiple-exact-matches',
		texture: null,
		target: null,
		attachment: null,
		observedTargetCount: 2,
		candidateCount: 2,
		matchCount: 2,
	} );

} );

test( 'a renderer-observed preferred target disambiguates identical live targets', () => {

	const renderer = makeRenderer();
	const registry = createRendererRenderTargetTextureRegistry( renderer );
	const first = makeTarget();
	const second = makeTarget();
	const selector = createRendererRenderTargetTextureSelector( first );
	observeAndUnbind( renderer, first, second );

	assert.equal( registry.resolve( selector ).status, 'ambiguous' );
	const preferred = registry.resolve( selector, {
		preferredTarget: second,
		preferredTexture: second.texture,
	} );
	assert.equal( preferred.status, 'resolved' );
	assert.equal( preferred.texture, second.texture );
	assert.equal( preferred.target, second );
	assert.equal( preferred.preferredTargetObserved, true );
	assert.equal( preferred.preferredTextureRendererOwned, false );

} );

test( 'an exact preferred attachment may be renamed but global and stale searches stay exact', () => {

	const renderer = makeRenderer();
	const registry = createRendererRenderTargetTextureRegistry( renderer );
	const capturedTexture = makeTexture( {
		name: 'UnrealBloomPass.bright',
		width: 256,
		height: 128,
	} );
	const capturedTarget = makeTarget( {
		width: 256,
		height: 128,
		colors: [ capturedTexture ],
	} );
	const selector = createRendererRenderTargetTextureSelector( capturedTarget );
	const liveTexture = makeTexture( {
		name: 'UnrealBloomPass.h0',
		width: 128,
		height: 64,
	} );
	const liveTarget = makeTarget( {
		width: 128,
		height: 64,
		colors: [ liveTexture ],
	} );
	observeAndUnbind( renderer, liveTarget );

	const global = registry.resolve( selector );
	assert.equal( global.status, 'missing' );
	assert.equal( global.reason, 'no-exact-match' );

	const stale = registry.resolve( selector, {
		preferredTarget: liveTarget,
		preferredTexture: capturedTexture,
	} );
	assert.equal( stale.status, 'missing' );
	assert.equal( stale.reason, 'preferred-target-no-exact-match' );

	const preferred = registry.resolve( selector, {
		preferredTarget: liveTarget,
		preferredTexture: liveTexture,
	} );
	assert.equal( preferred.status, 'resolved' );
	assert.equal( preferred.texture, liveTexture );
	assert.equal( preferred.target, liveTarget );

	liveTexture.type = 1016;
	const incompatible = registry.resolve( selector, {
		preferredTarget: liveTarget,
		preferredTexture: liveTexture,
	} );
	assert.equal( incompatible.status, 'missing' );
	assert.equal( incompatible.reason, 'preferred-target-no-exact-match' );

} );

test( 'preferred-target resolution ignores unrelated hazards but rejects its own active write attachment', () => {

	const renderer = makeRenderer();
	const registry = createRendererRenderTargetTextureRegistry( renderer );
	const preferredTarget = makeTarget();
	const unrelatedActiveTarget = makeTarget();
	const selector = createRendererRenderTargetTextureSelector( preferredTarget );
	observeAndUnbind( renderer, preferredTarget );
	renderer.setRenderTarget( unrelatedActiveTarget );

	const safe = registry.resolve( selector, {
		preferredTarget,
		preferredTexture: preferredTarget.texture,
	} );
	assert.equal( safe.status, 'resolved' );
	assert.equal( safe.texture, preferredTarget.texture );

	renderer.setRenderTarget( preferredTarget );
	const hazard = registry.resolve( selector, {
		preferredTarget,
		preferredTexture: preferredTarget.texture,
	} );
	assert.equal( hazard.status, 'hazard' );
	assert.equal( hazard.reason, 'active-write-attachment' );

} );

test( 'a foreign renderer target is not retained or accepted as local ownership proof', () => {

	const rendererA = makeRenderer();
	const rendererB = makeRenderer();
	const registryA = createRendererRenderTargetTextureRegistry( rendererA );
	createRendererRenderTargetTextureRegistry( rendererB );
	const foreignTarget = makeTarget();
	const selector = createRendererRenderTargetTextureSelector( foreignTarget );
	observeAndUnbind( rendererB, foreignTarget );

	const result = registryA.resolve( selector, {
		preferredTarget: foreignTarget,
		preferredTexture: foreignTarget.texture,
	} );
	assert.equal( registryA.observedTargetCount, 0 );
	assert.equal( result.status, 'pending' );
	assert.equal( result.reason, 'preferred-target-not-renderer-owned' );
	assert.equal( result.preferredTargetObserved, false );
	assert.equal( result.preferredTextureRendererOwned, false );

} );

test( 'an exact backend resource proves an unobserved preferred target belongs to this renderer', () => {

	const renderer = makeRendererWithBackend();
	const registry = createRendererRenderTargetTextureRegistry( renderer );
	const target = makeTarget();
	const selector = createRendererRenderTargetTextureSelector( target );
	renderer.proveTextureOwnership( target.texture );

	const result = registry.resolve( selector, {
		preferredTarget: target,
		preferredTexture: target.texture,
	} );
	assert.equal( registry.observedTargetCount, 0, 'backend proof must not mutate renderer observations' );
	assert.equal( result.status, 'resolved' );
	assert.equal( result.texture, target.texture );
	assert.equal( result.preferredTargetObserved, false );
	assert.equal( result.preferredTextureRendererOwned, true );

} );

test( 'a renderer default texture is not accepted as preferred-target ownership proof', () => {

	const renderer = makeRendererWithBackend();
	const registry = createRendererRenderTargetTextureRegistry( renderer );
	const target = makeTarget();
	const selector = createRendererRenderTargetTextureSelector( target );
	renderer.proveTextureOwnership( target.texture, { isDefaultTexture: true } );

	const result = registry.resolve( selector, {
		preferredTarget: target,
		preferredTexture: target.texture,
	} );
	assert.equal( result.status, 'pending' );
	assert.equal( result.reason, 'preferred-target-not-renderer-owned' );

} );

test( 'MRT color indices and depth attachments resolve independently', () => {

	const renderer = makeRenderer();
	const registry = createRendererRenderTargetTextureRegistry( renderer );
	const color0 = makeTexture( { name: 'mrt-albedo', format: 1023 } );
	const color1 = makeTexture( { name: 'mrt-velocity', format: 1028, type: 1016 } );
	const depth = makeTexture( {
		name: 'mrt-depth',
		format: 1026,
		type: 1014,
		colorSpace: '',
		isDepthTexture: true,
	} );
	const target = makeTarget( { colors: [ color0, color1 ], depthTexture: depth } );
	const colorSelector = createRendererRenderTargetTextureSelector( target, { role: 'color', index: 1 } );
	const depthSelector = createRendererRenderTargetTextureSelector( target, { texture: depth } );
	observeAndUnbind( renderer, target );

	const colorResult = registry.resolve( colorSelector );
	const depthResult = registry.resolve( depthSelector );
	assert.equal( colorResult.status, 'resolved' );
	assert.equal( colorResult.texture, color1 );
	assert.deepEqual( colorResult.attachment, { role: 'color', index: 1 } );
	assert.equal( depthResult.status, 'resolved' );
	assert.equal( depthResult.texture, depth );
	assert.deepEqual( depthResult.attachment, { role: 'depth', index: null } );

} );

test( 'sparse MRT attachment positions are never collapsed or relabeled', () => {

	const renderer = makeRenderer();
	const registry = createRendererRenderTargetTextureRegistry( renderer );
	const color1 = makeTexture( { name: 'attachment-one' } );
	const target = makeTarget( { colors: [ null, color1 ] } );
	const selector = createRendererRenderTargetTextureSelector( target, { texture: color1 } );
	observeAndUnbind( renderer, target );

	assert.deepEqual( selector.attachment, { role: 'color', index: 1 } );
	assert.equal( selector.target.mrtCount, 2 );
	const result = registry.resolve( selector );
	assert.equal( result.status, 'resolved' );
	assert.equal( result.texture, color1 );
	assert.deepEqual( result.attachment, { role: 'color', index: 1 } );

} );

test( 'attachment replacement and named resize are read dynamically at resolution time', () => {

	const renderer = makeRenderer();
	const registry = createRendererRenderTargetTextureRegistry( renderer );
	const original = makeTexture( { name: 'taa-history', width: 100, height: 100 } );
	const target = makeTarget( { width: 100, height: 100, colors: [ original ] } );
	const selector = createRendererRenderTargetTextureSelector( target, { texture: original } );
	observeAndUnbind( renderer, target );

	const replacement = makeTexture( { name: 'taa-history', width: 640, height: 360 } );
	target.texture = replacement;
	target.width = 640;
	target.height = 360;

	const result = registry.resolve( selector );
	assert.equal( result.status, 'resolved' );
	assert.equal( result.texture, replacement );
	assert.notEqual( result.texture, original );

	const preferred = registry.resolve( selector, {
		preferredTarget: target,
		preferredTexture: original,
	} );
	assert.equal( preferred.status, 'resolved' );
	assert.equal( preferred.texture, replacement, 'the target hint must follow its current attachment' );

} );

test( 'a recreated same-shaped target converges through the new preferred owner', () => {

	const renderer = makeRenderer();
	const registry = createRendererRenderTargetTextureRegistry( renderer );
	const original = makeTarget();
	const replacement = makeTarget();
	const selector = createRendererRenderTargetTextureSelector( original );
	observeAndUnbind( renderer, original, replacement );

	assert.equal( registry.resolve( selector ).status, 'ambiguous' );
	const result = registry.resolve( selector, {
		preferredTarget: replacement,
		preferredTexture: replacement.texture,
	} );
	assert.equal( result.status, 'resolved' );
	assert.equal( result.target, replacement );
	assert.equal( result.texture, replacement.texture );

} );

test( 'anonymous selectors require their captured extent after resize', () => {

	const renderer = makeRenderer();
	const registry = createRendererRenderTargetTextureRegistry( renderer );
	const original = makeTexture();
	const target = makeTarget( { colors: [ original ] } );
	const selector = createRendererRenderTargetTextureSelector( target );
	observeAndUnbind( renderer, target );

	target.texture = makeTexture( { width: 200, height: 120 } );
	target.width = 200;
	target.height = 120;

	const result = registry.resolve( selector );
	assert.equal( result.status, 'missing' );
	assert.equal( result.reason, 'no-exact-match' );
	assert.equal( result.texture, null );

} );

test( 'MRT topology changes invalidate an otherwise matching attachment', () => {

	const renderer = makeRenderer();
	const registry = createRendererRenderTargetTextureRegistry( renderer );
	const first = makeTexture( { name: 'stable-first' } );
	const second = makeTexture( { name: 'second' } );
	const target = makeTarget( { colors: [ first, second ] } );
	const selector = createRendererRenderTargetTextureSelector( target, { texture: first } );
	observeAndUnbind( renderer, target );

	target.textures = [ first ];
	target.texture = first;

	const result = registry.resolve( selector );
	assert.equal( result.status, 'missing' );
	assert.equal( result.texture, null );

} );

test( 'the current write target is a hazard and never becomes a sampled result', () => {

	const renderer = makeRenderer();
	const registry = createRendererRenderTargetTextureRegistry( renderer );
	const target = makeTarget( { colors: [ makeTexture( { name: 'feedback-source' } ) ] } );
	const selector = createRendererRenderTargetTextureSelector( target );
	renderer.setRenderTarget( target );

	const hazard = registry.resolve( selector );
	assert.deepEqual( hazard, {
		status: 'hazard',
		reason: 'active-write-attachment',
		texture: null,
		target: null,
		attachment: null,
		observedTargetCount: 1,
		candidateCount: 1,
		hazardCount: 1,
		safeMatchCount: 0,
	} );

	renderer.setRenderTarget( null );
	assert.equal( registry.resolve( selector ).texture, target.texture );

} );

test( 'an active matching target keeps resolution hazardous even when one safe match exists', () => {

	const renderer = makeRenderer();
	const registry = createRendererRenderTargetTextureRegistry( renderer );
	const safe = makeTarget( { colors: [ makeTexture( { name: 'shared-name' } ) ] } );
	const active = makeTarget( { colors: [ makeTexture( { name: 'shared-name' } ) ] } );
	const selector = createRendererRenderTargetTextureSelector( safe );
	renderer.setRenderTarget( safe );
	renderer.setRenderTarget( active );

	const result = registry.resolve( selector );
	assert.equal( result.status, 'hazard' );
	assert.equal( result.hazardCount, 1 );
	assert.equal( result.safeMatchCount, 1 );
	assert.equal( result.texture, null );

} );

test( 'a sole shape-like target is not used as a fallback after an exact miss', () => {

	const renderer = makeRenderer();
	const registry = createRendererRenderTargetTextureRegistry( renderer );
	const target = makeTarget( { colors: [ makeTexture( { format: 1023 } ) ] } );
	const selector = createRendererRenderTargetTextureSelector( target );
	selector.texture.format = 999999;
	observeAndUnbind( renderer, target );

	const result = registry.resolve( selector );
	assert.deepEqual( result, {
		status: 'missing',
		reason: 'no-exact-match',
		texture: null,
		target: null,
		attachment: null,
		observedTargetCount: 1,
		candidateCount: 1,
	} );

} );

test( 'an unrelated malformed target cannot abort resolution for valid observed targets', () => {

	const renderer = makeRenderer();
	const registry = createRendererRenderTargetTextureRegistry( renderer );
	const expected = makeTarget( { colors: [ makeTexture( { name: 'expected-output' } ) ] } );
	const malformed = makeTarget( {
		colors: [
			makeTexture( { name: 'mixed-color', dimension: '2d' } ),
			makeTexture( { name: 'mixed-array', dimension: '2d-array' } ),
		],
	} );
	const selector = createRendererRenderTargetTextureSelector( expected );
	observeAndUnbind( renderer, malformed, expected );

	const result = registry.resolve( selector );
	assert.equal( result.status, 'resolved' );
	assert.equal( result.texture, expected.texture );

} );

test( 'resolution is pending before a target or its attachments are observed', () => {

	const selector = createRendererRenderTargetTextureSelector( makeTarget() );
	const renderer = makeRenderer();
	const registry = createRendererRenderTargetTextureRegistry( renderer );
	assert.deepEqual( registry.resolve( selector ), {
		status: 'pending',
		reason: 'no-render-target-observed',
		texture: null,
		target: null,
		attachment: null,
		observedTargetCount: 0,
		candidateCount: 0,
	} );

	const emptyTarget = makeTarget( { colors: [] } );
	observeAndUnbind( renderer, emptyTarget );
	const pending = registry.resolve( selector );
	assert.equal( pending.status, 'pending' );
	assert.equal( pending.reason, 'render-target-attachments-not-ready' );
	assert.equal( pending.texture, null );

} );

test( 'direct resolution reports pending when discovery was not installed early', () => {

	const renderer = makeRenderer();
	const selector = createRendererRenderTargetTextureSelector( makeTarget() );
	assert.equal( getRendererRenderTargetTextureRegistry( renderer ), null );
	assert.deepEqual( resolveRendererRenderTargetTexture( renderer, selector ), {
		status: 'pending',
		reason: 'registry-not-installed',
		texture: null,
		target: null,
		attachment: null,
		observedTargetCount: 0,
		candidateCount: 0,
	} );
	assert.equal( getRendererRenderTargetTextureRegistry( renderer ), null, 'resolution must not install late' );

} );

test( 'installation is idempotent, forwards all setRenderTarget arguments, and retains every target', () => {

	const renderer = makeRenderer();
	const firstRegistry = createRendererRenderTargetTextureRegistry( renderer );
	const wrapped = renderer.setRenderTarget;
	const secondRegistry = createRendererRenderTargetTextureRegistry( renderer );
	const first = makeTarget( { colors: [ makeTexture( { name: 'first' } ) ] } );
	const second = makeTarget( { colors: [ makeTexture( { name: 'second' } ) ] } );

	assert.equal( secondRegistry, firstRegistry );
	assert.equal( renderer.setRenderTarget, wrapped, 'idempotent installation must not stack wrappers' );
	assert.equal( renderer.setRenderTarget( first, 3, 2 ), 'bound:3:2' );
	renderer.setRenderTarget( second );
	renderer.setRenderTarget( first );
	renderer.setRenderTarget( null );
	assert.equal( firstRegistry.observedTargetCount, 2 );
	assert.deepEqual( renderer.calls[ 0 ], { target: first, activeLayer: 3, activeMipmapLevel: 2 } );

} );

test( 'duplicate ESM instances share one renderer registry and one wrapper', async () => {

	const renderer = makeRenderer();
	const registry = createRendererRenderTargetTextureRegistry( renderer );
	const wrapped = renderer.setRenderTarget;
	const duplicate = await import( '../src/slim-support/render-target-texture-registry.js?duplicate-instance' );
	const duplicateRegistry = duplicate.createRendererRenderTargetTextureRegistry( renderer );
	const target = makeTarget();
	const selector = createRendererRenderTargetTextureSelector( target );

	assert.equal( duplicateRegistry, registry );
	assert.equal( renderer.setRenderTarget, wrapped );
	observeAndUnbind( renderer, target );
	assert.equal( duplicate.resolveRendererRenderTargetTexture( renderer, selector ).texture, target.texture );

} );

test( 'a currently bound target is seeded when discovery installs', () => {

	const renderer = makeRenderer();
	const target = makeTarget();
	renderer.setRenderTarget( target );
	const selector = createRendererRenderTargetTextureSelector( target );

	const registry = createRendererRenderTargetTextureRegistry( renderer );
	assert.equal( registry.observedTargetCount, 1 );
	assert.equal( registry.resolve( selector ).status, 'hazard' );

	renderer.setRenderTarget( null );
	assert.equal( registry.resolve( selector ).texture, target.texture );

} );

test( 'invalid selectors fail closed without returning any candidate', () => {

	const renderer = makeRenderer();
	const registry = createRendererRenderTargetTextureRegistry( renderer );
	const target = makeTarget();
	observeAndUnbind( renderer, target );

	const result = registry.resolve( {
		schema: RENDERER_RENDER_TARGET_TEXTURE_SELECTOR_SCHEMA,
		attachment: { role: 'color', index: 0 },
		target: { topology: 'single', dimension: '2d', mrtCount: 1 },
		texture: { dimension: '2d', format: 1023, type: 1009, colorSpace: 'srgb-linear' },
		hints: { name: null, extent: { width: null, height: null, depth: null } },
	} );
	assert.equal( result.status, 'missing' );
	assert.equal( result.reason, 'anonymous-selector-missing-extent' );
	assert.equal( result.texture, null );
	assert.equal( result.target, null );

	const invalidPreference = registry.resolve(
		createRendererRenderTargetTextureSelector( target ),
		{ preferredTarget: 'not-a-render-target' },
	);
	assert.equal( invalidPreference.status, 'missing' );
	assert.equal( invalidPreference.reason, 'invalid-preferred-target' );
	assert.equal( invalidPreference.texture, null );
	assert.equal( invalidPreference.target, null );

} );

test( 'selector creation rejects non-attachments instead of fabricating identity', () => {

	const target = makeTarget();
	assert.throws(
		() => createRendererRenderTargetTextureSelector( target, { texture: makeTexture() } ),
		/Requested texture is not a current attachment/,
	);
	assert.throws(
		() => createRendererRenderTargetTextureSelector( target, { role: 'depth' } ),
		/no depth texture attachment/,
	);

} );
