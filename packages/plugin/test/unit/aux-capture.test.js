/**
 * POC: auxiliary-pass capture for three.js's internal node materials.
 *
 * The capture produces an artifact stamped with a `configHash` keyed on
 * a structural walk of the INPUT graph (not the output artifact). The
 * SAME algorithm runs in the browser-side runtime at render time, so the
 * manifest lookup key matches without re-running the extractor.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
	extractBackgroundArtifact,
	extractPostProcessingArtifact,
	extractCubeRenderTargetArtifact,
	extractPMREMArtifact,
	extractLightingArtifact,
} from '../../src/aux-capture.js';
import { emitUpdaterSource } from '../../src/emit-updater.js';
import { computeNodeGraphHash, computePlainConfigHash } from '../../src/hash.js';
import { installMockWebGPU, createMockGPUCanvasContext } from '../../src/mock-webgpu.js';
import { beginRenderObjectHarvest } from '../../src/vendor/render-object-observer.js';
import { hashNodeGraphSync, hashPlainConfigSync } from '../../../runtime/src/graph-hash.js';
import { createCubeRenderTargetAuxConfig } from '@tsl-precompile/contract/cube-render-target';
import { assertInternalPassArtifact } from '@tsl-precompile/contract/internal-pass';

// -------- Background --------

test( 'aux/background: color(0x8080ff) → extracts + hashes', async () => {

	const r = await extractBackgroundArtifact( ( { tsl } ) => ( { backgroundNode: tsl.color( 0x8080ff ), name: 'bg-solid' } ) );
	assert.equal( r.materialShape, 'background' );
	assert.ok( /^[0-9a-f]{64}$/.test( r.configHash ), `expected 64-char hex configHash, got ${ r.configHash }` );
	const { unsupportedKinds } = emitUpdaterSource( r.artifact );
	assert.deepEqual( unsupportedKinds.filter( ( u ) => u.severity === 'unknown' ), [] );

} );

test( 'aux/background: red vs green produce different configHashes', async () => {

	const a = await extractBackgroundArtifact( ( { tsl } ) => ( { backgroundNode: tsl.color( 0xff0000 ) } ) );
	const b = await extractBackgroundArtifact( ( { tsl } ) => ( { backgroundNode: tsl.color( 0x00ff00 ) } ) );
	assert.notEqual( a.configHash, b.configHash );

} );

test( 'aux/background: same input → same configHash (stable across process runs)', async () => {

	const a = await extractBackgroundArtifact( ( { tsl } ) => ( { backgroundNode: tsl.color( 0x8080ff ) } ) );
	const b = await extractBackgroundArtifact( ( { tsl } ) => ( { backgroundNode: tsl.color( 0x8080ff ) } ) );
	assert.equal( a.configHash, b.configHash );

} );

// -------- PostProcessing --------

test( 'aux/post-process: outputNode = vec4(uv,0,1) extracts', async () => {

	const r = await extractPostProcessingArtifact( ( { tsl } ) => ( {
		outputNode: tsl.vec4( tsl.uv(), 0, 1 ),
		name: 'pp-uv',
	} ) );
	assert.equal( r.materialShape, 'post-process' );
	assert.ok( /^[0-9a-f]{64}$/.test( r.configHash ) );

} );

test( 'aux/post-process: two different outputNodes produce distinct configHashes', async () => {

	const a = await extractPostProcessingArtifact( ( { tsl } ) => ( { outputNode: tsl.vec4( 1, 0, 0, 1 ) } ) );
	const b = await extractPostProcessingArtifact( ( { tsl } ) => ( { outputNode: tsl.vec4( 0, 1, 0, 1 ) } ) );
	assert.notEqual( a.configHash, b.configHash );

} );

test( 'aux/post-process: captures Three output transform instead of the raw color graph', async () => {

	const transformed = await extractPostProcessingArtifact( ( { tsl, core } ) => ( {
		outputNode: tsl.vec4( 0.25, 0.5, 1, 1 ),
		outputColorTransform: true,
		toneMapping: core.NeutralToneMapping,
	} ) );
	const raw = await extractPostProcessingArtifact( ( { tsl, core } ) => ( {
		outputNode: tsl.vec4( 0.25, 0.5, 1, 1 ),
		outputColorTransform: false,
		toneMapping: core.NeutralToneMapping,
	} ) );

	assert.notEqual( transformed.configHash, raw.configHash );
	assert.equal( transformed.artifact.replayConfig.outputColorTransform, true );
	assert.equal( raw.artifact.replayConfig.outputColorTransform, false );
	assert.equal( Object.hasOwn( transformed.artifact.replayConfig, 'logarithmicDepthBuffer' ), false );
	assert.equal( Object.hasOwn( transformed.artifact.replayConfig, 'reversedDepthBuffer' ), false );
	assert.match( transformed.artifact.fragmentShader, /neutralToneMapping|sRGBTransferOETF/ );
	assert.doesNotMatch( raw.artifact.fragmentShader, /neutralToneMapping|sRGBTransferOETF/ );
	assert.equal(
		transformed.artifact.uniformPlan.some( ( group ) => ( group.slots || [] ).some( ( slot ) => slot.source && slot.source.kind === 'renderer.toneMappingExposure' ) ),
		true,
		'exposure remains a live renderer uniform rather than a captured variant key',
	);

} );

test( 'aux/post-process: standalone capture partitions logarithmic and reversed depth metadata', async () => {

	const factory = ( { tsl } ) => ( {
		outputNode: tsl.vec4( 0.25, 0.5, 1, 1 ),
		outputColorTransform: true,
	} );
	const normal = await extractPostProcessingArtifact( factory );
	const logarithmic = await extractPostProcessingArtifact( factory, {
		rendererOptions: { logarithmicDepthBuffer: true },
	} );
	const reversed = await extractPostProcessingArtifact( factory, {
		rendererOptions: { reversedDepthBuffer: true },
	} );

	assert.equal( new Set( [ normal.configHash, logarithmic.configHash, reversed.configHash ] ).size, 3 );
	assert.equal( Object.hasOwn( normal.artifact.replayConfig, 'logarithmicDepthBuffer' ), false );
	assert.equal( Object.hasOwn( normal.artifact.replayConfig, 'reversedDepthBuffer' ), false );
	assert.equal( logarithmic.artifact.replayConfig.logarithmicDepthBuffer, true );
	assert.equal( Object.hasOwn( logarithmic.artifact.replayConfig, 'reversedDepthBuffer' ), false );
	assert.equal( reversed.artifact.replayConfig.reversedDepthBuffer, true );
	assert.equal( Object.hasOwn( reversed.artifact.replayConfig, 'logarithmicDepthBuffer' ), false );

} );

// -------- CubeRenderTarget --------

test( 'aux/cube-render-target: captures the exact r185 equirectangular conversion graph', async () => {

	let sourceTexture;
	const r = await extractCubeRenderTargetArtifact( ( { core } ) => {

		sourceTexture = new core.DataTexture( new Uint8Array( 8 ), 2, 1 );
		sourceTexture.mapping = core.EquirectangularReflectionMapping;
		sourceTexture.colorSpace = core.LinearSRGBColorSpace;
		sourceTexture.minFilter = core.LinearMipmapLinearFilter;
		sourceTexture.magFilter = core.LinearFilter;
		sourceTexture.generateMipmaps = false;
		sourceTexture.needsUpdate = true;
		return { sourceTexture, name: 'cube-equirect' };

	} );

	assert.equal( r.materialShape, 'cube-render-target' );
	assert.equal( r.artifact.materialShape, 'cube-render-target' );
	assert.equal( r.artifact.__configHash, r.configHash );
	assert.deepEqual( r.artifact.replayConfig, createCubeRenderTargetAuxConfig( sourceTexture ) );
	assert.equal( r.artifact.replayConfig.sampler.generateMipmaps, true );
	assert.equal( r.artifact.replayConfig.sampler.minFilter, 1006 );
	assert.equal( sourceTexture.generateMipmaps, false, 'factory-owned source state is restored after capture' );
	assert.equal( sourceTexture.minFilter, 1008, 'temporary pole filter is restored after capture' );
	assert.equal( r.artifact._textureRefs.get( sourceTexture.uuid ), sourceTexture, 'artifact keeps the exact source texture sidecar' );
	assert.equal(
		r.artifact.uniformPlan.some( ( group ) => ( group.textures || [] ).some( ( binding ) =>
			binding.source && binding.source.kind === 'artifact.texture' && binding.source.textureUuid === sourceTexture.uuid
		) ),
		true,
		'uniform plan retains serializable evidence for the same source texture',
	);
	assert.match( r.artifact.fragmentShader, /textureSampleLevel/ );
	assert.equal( r.artifact.renderState.side, 1 );
	assert.equal( r.artifact.renderState.blending, 0 );

	const candidates = [ r.artifact, ...Object.values( r.artifact.variants || {} ) ];
	const selectors = candidates.flatMap( ( artifact ) => artifact.renderContextSelectors || [] );
	assert.equal(
		selectors.some( ( selector ) => JSON.parse( selector ).target.surface === 'offscreen-cube' ),
		true,
		'conversion graph is compiled against a real CubeRenderTarget override',
	);

	sourceTexture.dispose();

} );

test( 'aux/cube-render-target: captures custom destination pipeline topology', async () => {

	let sourceTexture;
	const r = await extractCubeRenderTargetArtifact( ( { core } ) => {

		sourceTexture = new core.DataTexture( new Uint8Array( 8 ), 2, 1 );
		sourceTexture.needsUpdate = true;
		return {
			sourceTexture,
			targetOptions: {
				format: core.RGFormat,
				internalFormat: 'rg16float',
				samples: 4,
			},
			name: 'cube-custom-target',
		};

	} );

	assert.equal( r.artifact.replayConfig.target.format, 1030 );
	assert.equal( r.artifact.replayConfig.target.internalFormat, 'rg16float' );
	assert.equal( r.artifact.replayConfig.target.sampleCount, 4 );
	assert.equal( r.artifact.replayConfig.target.depth, true );
	assert.equal( r.artifact.replayConfig.target.stencil, false );
	assert.match( r.artifact.fragmentShader, /texture(?:SampleLevel|Load)/ );
	sourceTexture.dispose();

} );

// -------- PMREM --------

function makePMREMSourceTexture( core, kind, cubeSize = 32, options = {} ) {

	if ( kind === 'cube' ) {

		const texture = new core.CubeTexture(
			Array.from( { length: 6 }, () => ( { width: cubeSize, height: cubeSize } ) ),
		);
		texture.mapping = core.CubeReflectionMapping;
		Object.assign( texture, options );
		texture.needsUpdate = true;
		return texture;

	}

	const texture = new core.Texture( { width: 128, height: 64 } );
	texture.mapping = core.EquirectangularReflectionMapping;
	Object.assign( texture, options );
	texture.needsUpdate = true;
	return texture;

}

function makePMREMTestCanvas( width = 256, height = 256 ) {

	let gpuContext = null;
	return {
		width, height, clientWidth: width, clientHeight: height,
		style: {},
		getContext( kind ) {

			if ( kind !== 'webgpu' ) return null;
			if ( ! gpuContext ) gpuContext = createMockGPUCanvasContext();
			return gpuContext;

		},
		addEventListener() {},
		removeEventListener() {},
		getBoundingClientRect: () => ( { left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0 } ),
	};

}

function shaderHash( source ) {

	// NodeBuffer names include Three's process-global Node id. That id changes
	// between otherwise identical PMREMGenerator instances, while every
	// declaration and use remains structurally identical.
	const canonical = source.replace( /NodeBuffer_\d+/g, 'NodeBuffer_ID' );
	return createHash( 'sha256' ).update( canonical ).digest( 'hex' );

}

function shaderHashPairsFromStates( states ) {

	return [ ...new Set( states.map( ( state ) =>
		`${ shaderHash( state.vertexShader || '' ) }:${ shaderHash( state.fragmentShader || '' ) }`
	) ) ].sort();

}

function artifactCandidates( artifact ) {

	return [ artifact, ...Object.values( artifact.variants || {} ) ]
		.filter( ( candidate ) => candidate && typeof candidate.vertexShader === 'string' && typeof candidate.fragmentShader === 'string' );

}

function shaderHashPairsFromArtifact( artifact ) {

	return shaderHashPairsFromStates( artifactCandidates( artifact ) );

}

function parsedArtifactSelectors( artifact ) {

	return artifactCandidates( artifact )
		.flatMap( ( candidate ) => candidate.renderContextSelectors || [] )
		.map( ( selector ) => JSON.parse( selector ) );

}

function selectorDepthKinds( artifact ) {

	return [ ...new Set( parsedArtifactSelectors( artifact ).map( ( selector ) =>
		Object.hasOwn( selector.target, 'depth' ) ? String( selector.target.depth ) : 'omitted'
	) ) ].sort();

}

async function captureDirectPMREMShaders( kind, textureOptions = {} ) {

	installMockWebGPU();
	const [ webgpu, core ] = await Promise.all( [ import( 'three/webgpu' ), import( 'three' ) ] );
	const renderer = new webgpu.WebGPURenderer( {
		canvas: makePMREMTestCanvas(),
		antialias: false,
	} );
	await renderer.init();
	const sourceTexture = makePMREMSourceTexture( core, kind, 32, textureOptions );
	const pmrem = new webgpu.PMREMGenerator( renderer );
	let target = null;
	let harvestSession = null;

	try {

		harvestSession = beginRenderObjectHarvest( renderer );
		target = kind === 'cube'
			? pmrem.fromCubemap( sourceTexture )
			: pmrem.fromEquirectangular( sourceTexture );
		const harvest = await harvestSession.finish();
		const stages = {};

		for ( const [ material, family ] of harvest.familiesByMaterial ) {

			const match = /^PMREM_(cubemap|equirect|blur|ggx)$/.exec( material && material.name || '' );
			if ( ! match ) continue;
			stages[ match[ 1 ] ] = {
				states: family.variants.map( ( variant ) => variant.nodeBuilderState ),
				indexed: family.variants.flatMap( ( variant ) => variant.requests )
					.map( ( request ) => !! ( request.object && request.object.geometry && request.object.geometry.index ) ),
			};

		}

		return stages;

	} finally {

		if ( harvestSession && harvestSession.active ) await harvestSession.finish();
		renderer.setRenderTarget( null );
		if ( target ) target.dispose();
		pmrem.dispose();
		sourceTexture.dispose();
		renderer.dispose();

	}

}

test( 'aux/pmrem: equirect input produces a stamped artifact', async () => {

	let sourceTexture;
	const r = await extractPMREMArtifact( ( { core } ) => {

		sourceTexture = makePMREMSourceTexture( core, 'equirect' );
		return { sourceTexture, kind: 'equirect', name: 'pmrem-equirect' };

	} );
	assert.equal( r.materialShape, 'pmrem' );
	assert.equal( r.artifact.pmremKind, 'equirect' );
	assert.deepEqual( Object.keys( r.artifacts ).sort(), [ 'equirect', 'ggx' ] );
	sourceTexture.dispose();

} );

test( 'aux/pmrem: captures the exercised stages with real faceIndex and target topology', async () => {

	let sourceTexture;
	let halfFloatType;
	let rgbaFormat;
	const r = await extractPMREMArtifact( ( { core } ) => {

		halfFloatType = core.HalfFloatType;
		rgbaFormat = core.RGBAFormat;
		sourceTexture = makePMREMSourceTexture( core, 'equirect' );
		return { sourceTexture, kind: 'equirect', name: 'pmrem-internals' };

	} );
	assert.ok( r.artifacts && typeof r.artifacts === 'object', 'r.artifacts dict expected' );
	assert.deepEqual( Object.keys( r.artifacts ).sort(), [ 'equirect', 'ggx' ] );
	for ( const subKind of [ 'equirect', 'ggx' ] ) {

		const a = r.artifacts[ subKind ];
		assert.ok( a, `missing artifact for sub-shape ${ subKind }` );
		assert.equal( a.materialShape, `pmrem-${ subKind }` );
		assert.equal( a.pmremKind, subKind );
		assert.ok( typeof a.fragmentShader === 'string' && a.fragmentShader.length > 0, `${ subKind }: empty fragmentShader` );
		assert.equal( a.__configHash, r.configHash, `${ subKind }: configHash mismatch with primary` );
		assert.equal( a.internalPass.schema, 'internal-pass@1' );
		assert.equal( a.internalPass.family, 'pmrem' );
		assert.equal( a.internalPass.stage, subKind );
		assert.equal( a.internalPass.shape, `pmrem-${ subKind }` );
		assert.equal( a.internalPass.config.schema, 'pmrem-support@1' );
		assert.equal( a.internalPass.config.profile, 'texture-equirect' );
		assert.deepEqual( a.internalPass.config.layout, a.replayConfig );
		assert.equal( a.internalPass.config.source.kind, 'equirect' );
		assert.equal( a.internalPass.config.source.dimension, '2d' );
		assert.equal( assertInternalPassArtifact( a ), a.internalPass );
		assert.deepEqual(
			a.internalPass.uniforms.map( ( uniform ) => uniform.role ),
			subKind === 'ggx' ? [ 'mip-int', 'roughness' ] : [],
		);
		assert.deepEqual(
			a.internalPass.inputs.map( ( input ) => input.role ),
			[ subKind === 'ggx' ? 'env-map' : 'source' ],
		);
		assert.deepEqual( a.internalPass.output.topology, {
			dimension: '2d',
			depth: false,
			format: rgbaFormat,
			internalFormat: null,
			type: halfFloatType,
			colorSpace: 'srgb-linear',
		} );
		assert.equal( JSON.stringify( a.internalPass ).includes( sourceTexture.uuid ), false, `${ subKind }: durable pass descriptor must omit UUIDs` );
		assert.match( a.vertexShader, /faceIndex/, `${ subKind }: vertex shader must consume PMREM's faceIndex attribute` );
		assert.match(
			a.fragmentShader,
			/getDirection\(\s*nodeVarying\d+,\s*nodeVarying\d+\s*\)/,
			`${ subKind }: fragment shader must use the varying face index`,
		);
		assert.doesNotMatch(
			a.fragmentShader,
			/getDirection\(\s*nodeVarying\d+,\s*0\.0\s*\)/,
			`${ subKind }: fragment shader must not hard-code cube face zero`,
		);

		const selectors = parsedArtifactSelectors( a );
		assert.ok( selectors.length > 0, `${ subKind }: render selectors expected` );
		for ( const selector of selectors ) {

			assert.equal( selector.target.surface, 'offscreen-2d', `${ subKind }: PMREM renders to a 2D atlas target` );
			assert.equal( selector.target.colors.length, 1, `${ subKind }: one atlas color attachment expected` );
			assert.equal( selector.target.colors[ 0 ].dataType, halfFloatType, `${ subKind }: atlas must be HalfFloat` );
			const attributes = selector.object.geometry.attributes.map( ( entry ) => entry[ 0 ] );
			assert.deepEqual( attributes, [ 'faceIndex', 'position', 'uv' ], `${ subKind }: exact PMREM vertex layout expected` );

		}

	}
	assert.deepEqual( selectorDepthKinds( r.artifacts.equirect ), [ 'false' ] );
	assert.deepEqual(
		selectorDepthKinds( r.artifacts.ggx ),
		[ 'false', 'omitted' ],
		'GGX retains the depthless source and ping-pong texture selectors',
	);
	assert.equal( r.artifacts.equirect.internalPass.inputs[ 0 ].binding, 'nodeUniform0' );
	assert.equal( r.artifacts.ggx.internalPass.inputs[ 0 ].binding, 'nodeUniform2' );
	assert.deepEqual(
		r.artifacts.ggx.internalPass.uniforms.map( ( uniform ) => [ uniform.role, uniform.group, uniform.binding, uniform.valueType ] ),
		[
			[ 'mip-int', 'object', 'nodeUniform1', 'float' ],
			[ 'roughness', 'object', 'nodeUniform0', 'float' ],
		],
	);
	sourceTexture.dispose();

} );

test( 'aux/pmrem: generated WGSL hashes match the direct Three.js render harvest', async () => {

	const direct = await captureDirectPMREMShaders( 'equirect' );
	let sourceTexture;
	const captured = await extractPMREMArtifact( ( { core } ) => {

		sourceTexture = makePMREMSourceTexture( core, 'equirect' );
		return { sourceTexture, kind: 'equirect', name: 'pmrem-hash-parity' };

	} );

	for ( const subKind of [ 'equirect', 'ggx' ] ) {

		assert.ok( direct[ subKind ], `direct render did not exercise ${ subKind }` );
		assert.deepEqual(
			shaderHashPairsFromArtifact( captured.artifacts[ subKind ] ),
			shaderHashPairsFromStates( direct[ subKind ].states ),
			`${ subKind }: extracted shaders diverge from the real Three.js WGSL`,
		);
		assert.equal(
			direct[ subKind ].indexed.every( ( indexed ) => indexed === false ),
			true,
			`${ subKind }: Three's private PMREM geometry is unindexed`,
		);

	}
	sourceTexture.dispose();

} );

test( 'aux/pmrem: cubemap WGSL hashes match the direct Three.js render harvest', async () => {

	const direct = await captureDirectPMREMShaders( 'cube' );
	let sourceTexture;
	const captured = await extractPMREMArtifact( ( { core } ) => {

		sourceTexture = makePMREMSourceTexture( core, 'cube' );
		return { sourceTexture, kind: 'cube', name: 'pmrem-cubemap-hash-parity' };

	} );

	for ( const subKind of [ 'cubemap', 'ggx' ] ) {

		assert.ok( direct[ subKind ], `direct render did not exercise ${ subKind }` );
		assert.deepEqual(
			shaderHashPairsFromArtifact( captured.artifacts[ subKind ] ),
			shaderHashPairsFromStates( direct[ subKind ].states ),
			`${ subKind }: extracted shaders diverge from the real Three.js WGSL`,
		);
		assert.equal(
			direct[ subKind ].indexed.every( ( indexed ) => indexed === false ),
			true,
			`${ subKind }: Three's private PMREM geometry is unindexed`,
		);

	}
	sourceTexture.dispose();

} );

test( 'aux/pmrem: integer source topology follows Three r185 live WGSL declarations and sampling branch', async () => {

	const textureOptions = {
		type: 1014, // UnsignedIntType
		minFilter: 1003, // NearestFilter
		magFilter: 1003,
	};
	const direct = await captureDirectPMREMShaders( 'equirect', textureOptions );
	let sourceTexture;
	const captured = await extractPMREMArtifact( ( { core } ) => {

		sourceTexture = makePMREMSourceTexture( core, 'equirect', 32, {
			type: core.UnsignedIntType,
			minFilter: core.NearestFilter,
			magFilter: core.NearestFilter,
		} );
		return { sourceTexture, kind: 'equirect', name: 'pmrem-uint-hash-parity' };

	} );
	const source = captured.artifacts.equirect;

	assert.equal( source.internalPass.config.source.componentType, 'u32' );
	assert.equal( source.internalPass.config.source.sampleType, 'uint' );
	assert.equal( source.internalPass.config.source.samplingMode, 'load' );
	assert.equal( source.internalPass.config.source.samplerType, 'none' );
	assert.deepEqual(
		shaderHashPairsFromArtifact( source ),
		shaderHashPairsFromStates( direct.equirect.states ),
		'integer-source extraction must retain Three r185 live WGSL',
	);
	for ( const candidate of artifactCandidates( source ) ) {

		assert.match( candidate.fragmentShader, /texture_2d<u32>/ );
		assert.match( candidate.fragmentShader, /textureLoad/ );
		assert.doesNotMatch( candidate.fragmentShader, /textureSample(?:Level)?\s*\(/ );

	}
	sourceTexture.dispose();

} );

test( 'aux/pmrem: cube input captures cubemap topology and hashes the compiled atlas layout', async () => {

	let source32;
	const size32 = await extractPMREMArtifact( ( { core } ) => {

		source32 = makePMREMSourceTexture( core, 'cube', 32 );
		return { sourceTexture: source32, kind: 'cube', name: 'pmrem-cube-32' };

	} );
	let source64;
	const size64 = await extractPMREMArtifact( ( { core } ) => {

		source64 = makePMREMSourceTexture( core, 'cube', 64 );
		return { sourceTexture: source64, kind: 'cube', name: 'pmrem-cube-64' };

	} );
	let source48;
	const size48 = await extractPMREMArtifact( ( { core } ) => {

		source48 = makePMREMSourceTexture( core, 'cube', 48 );
		return { sourceTexture: source48, kind: 'cube', name: 'pmrem-cube-48' };

	} );
	let equirect32Source;
	const equirect32 = await extractPMREMArtifact( ( { core } ) => {

		equirect32Source = makePMREMSourceTexture( core, 'equirect' );
		return { sourceTexture: equirect32Source, kind: 'equirect', name: 'pmrem-equirect-32' };

	} );

	assert.deepEqual( Object.keys( size32.artifacts ).sort(), [ 'cubemap', 'ggx' ] );
	assert.equal( size32.artifact.pmremKind, 'cubemap' );
	assert.equal( size32.artifact.internalPass.stage, 'cubemap' );
	assert.equal( size32.artifact.internalPass.inputs[ 0 ].role, 'source' );
	assert.equal( size32.artifact.internalPass.inputs[ 0 ].topology.dimension, 'cube' );
	assert.match( size32.artifact.vertexShader, /faceIndex/ );
	assert.deepEqual( size32.artifact.replayConfig, {
		schema: 'pmrem-layout@1',
		cubeSize: 32,
		lodMax: 5,
		target: { width: 336, height: 128 },
	} );
	assert.notEqual( size32.configHash, equirect32.configHash, 'source profiles remain distinct when their compiled atlas layout matches' );
	assert.equal( size32.configHash, size48.configHash, 'unrounded source dimensions share the hash of the same compiled layout' );
	assert.notEqual( size32.configHash, size64.configHash, 'different compiled atlas layouts must not share a config hash' );

	source32.dispose();
	source64.dispose();
	source48.dispose();
	equirect32Source.dispose();

} );

// -------- Lighting --------

test( 'aux/lights: scene with a DirectionalLight and a PointLight hashes stably', async () => {

	const factory = ( { core } ) => ( {
		lights: [
			new core.DirectionalLight( 0xffffff, 1 ),
			new core.PointLight( 0xffcc88, 0.8, 10 ),
		],
		name: 'lights-dir-point',
	} );
	const a = await extractLightingArtifact( factory );
	const b = await extractLightingArtifact( factory );
	assert.equal( a.configHash, b.configHash );

	const single = await extractLightingArtifact( ( { core } ) => ( { lights: [ new core.DirectionalLight( 0xffffff, 1 ) ] } ) );
	assert.notEqual( a.configHash, single.configHash );

} );

// -------- Build ↔ runtime hash agreement --------

test( 'hash-agreement: plugin-side and runtime-side hashers produce identical output', () => {

	const opts = { shape: 'background', threeVersion: '175', pluginVersion: '0.0.0' };
	// A plain POJO stands in for a TSL node — the walker only cares about
	// the structure + constructor.type fallbacks, so this is enough to
	// prove algorithmic equivalence.
	const input = { isUniformNode: true, value: { isColor: true, r: 1, g: 0.5, b: 0.25 } };
	const pluginHash = computeNodeGraphHash( input, opts );
	const runtimeHash = hashNodeGraphSync( input, opts );
	assert.equal( pluginHash, runtimeHash, 'plugin and runtime hashers must agree byte-for-byte' );

} );

test( 'hash-agreement: nested structural graphs hash identically on both sides', () => {

	const opts = { shape: 'post-process', threeVersion: '175', pluginVersion: '0.0.0' };
	const input = {
		constructor: { type: 'Vec4Node' },
		a: { constructor: { type: 'UVNode' }, isAttributeNode: true, attributeName: 'uv', nodeType: 'vec2' },
		b: { isConstNode: true, value: 0 },
		c: { isConstNode: true, value: 1 },
	};
	assert.equal( computeNodeGraphHash( input, opts ), hashNodeGraphSync( input, opts ) );

} );

test( 'hash-agreement: plain-config hashers (PMREM-like, Lighting-like) agree', () => {

	const opts = { shape: 'pmrem', threeVersion: '175', pluginVersion: '0.0.0' };
	const cfg = { kind: 'equirect', width: 2048, height: 1024, format: 1023, type: 1009 };
	assert.equal( computePlainConfigHash( cfg, opts ), hashPlainConfigSync( cfg, opts ) );

	const lightsCfg = { signature: [ 'DirectionalLight:', 'PointLight:shadow' ] };
	const lOpts = { shape: 'lights', threeVersion: '175', pluginVersion: '0.0.0' };
	assert.equal( computePlainConfigHash( lightsCfg, lOpts ), hashPlainConfigSync( lightsCfg, lOpts ) );

} );
