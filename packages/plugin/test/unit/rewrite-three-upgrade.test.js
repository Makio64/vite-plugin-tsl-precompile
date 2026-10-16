import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';
import _generate from '@babel/generator';
import {
	THREE_RELEASE_PROFILES,
	resolveSlimThreeRelease,
} from '@tsl-precompile/contract/slim-three-policy';
import { readSlimThreeReleaseProfile } from '@tsl-precompile/contract/slim-bundle-provenance-node';
import { assertPMREMAtlasCaptureSupport, createPMREMLayoutConfig } from '@tsl-precompile/contract/pmrem-config';
import { mergeArtifactVariantFamily } from '@tsl-precompile/contract/artifact-variants';
import { rewriteThreeSource } from '../../src/three-rewrite.js';
import { createMockGPUCanvasContext, installMockWebGPU } from '../../src/mock-webgpu.js';
import { compileTSL } from '../../src/vendor/compileTSL.js';
import { resolveScreenUniformSource } from '../../src/vendor/capture-screen-uniform.js';
import { extractUniformPlan } from '../../src/vendor/extractUniformPlan.js';
import ReplayNodeManager from '../../../runtime/src/slim-replay-node-manager.js';
import { createReplayPipelineBatch } from '../../../runtime/src/slim-pipeline-preparation.js';
import { THREE_SRC } from '../_three-src.js';
import { compileReplayLoop, isParallelCompileLoop } from '../_compile-loop.js';

const generate = _generate.default || _generate;
const externalRoot = process.env.TSLP_THREE_SOURCE_ROOT;
const sourceRoot = externalRoot ? resolve( externalRoot, 'src' ) : THREE_SRC;
const packageVersion = JSON.parse( readFileSync( resolve( sourceRoot, '../package.json' ), 'utf8' ) ).version;
const revision = /export const REVISION\s*=\s*['"]([^'"]+)['"]/.exec( readFileSync( resolve( sourceRoot, 'constants.js' ), 'utf8' ) )[ 1 ];
const sourceCommit = externalRoot ? execFileSync( 'git', [ '-C', externalRoot, 'rev-parse', 'HEAD' ], { encoding: 'utf8' } ).trim() : undefined;
// Development sources verify by their src/ + build/ fingerprint: the vendored tarball by its exact
// package version, a Git checkout of the pinned commit (upstream's nominal 0.186.0) by that commit.
const release = revision === THREE_RELEASE_PROFILES.development.revision
	? await readSlimThreeReleaseProfile( resolve( sourceRoot, '..' ), { sourceCommit } )
	: resolveSlimThreeRelease( { packageVersion, revision, sourceCommit } );
assert.ok( release, `Upgrade fixtures must use a verified release: ${ packageVersion } / ${ revision }` );
const options = { threeVersion: release.packageVersion, threeRevision: release.revision, threeCommit: release.gitCommit };

function rewrite( name, mutate = source => source ) {

	const source = readFileSync( resolve( sourceRoot, name ), 'utf8' );
	return rewriteThreeSource( mutate( source ), `three/src/${ name }`, options );

}

function rendererMethod( result, name ) {

	assert.equal( result.warning, null );
	const ast = parse( result.code, { sourceType: 'module' } );
	const renderer = ast.program.body.find( node => node.type === 'ClassDeclaration' && node.id.name === 'Renderer' );
	return renderer.body.body.find( node => node.key?.name === name );

}

function replayLoop() {

	const run = compileReplayLoop( rewrite( 'renderers/common/Renderer.js' ).code );
	return function ( ...args ) { return run.call( this, ...args, createReplayPipelineBatch ); };

}

// Three dev ec2b745 compiles pipelines in a bounded parallel window with its own time-budgeted
// scheduler; replay keeps that native tail instead of the older per-object barriers.
const parallelCompileLoop = isParallelCompileLoop( rewrite( 'renderers/common/Renderer.js' ).code );

test( `rewrite/${ release.id }: all changed native source seams remain parseable and compiler guarded`, () => {

	for ( const name of [ 'nodes/core/NodeUtils.js', 'nodes/core/constants.js', 'renderers/common/Renderer.js', 'renderers/common/Bindings.js', 'renderers/common/RenderPipeline.js', 'renderers/common/QuadMesh.js', 'nodes/lighting/ShadowFilterNode.js', 'renderers/webgpu/WebGPUBackend.js' ] ) {

		const result = rewrite( name );
		assert.equal( result.warning, null, name );
		assert.doesNotThrow( () => parse( result.code, { sourceType: 'module' } ), name );
		assert.doesNotMatch( result.code, /new (?:NodeMaterial|WGSLNodeBuilder)\s*\(/, name );

	}
	assert.equal( rewrite( 'nodes/lighting/ShadowFilterNode.js' ).noop, true, 'filter-only native module has no shadow-material seam' );

} );

function rewrittenBindingsDeletion() {

	const result = rewrite( 'renderers/common/Bindings.js' );
	assert.equal( result.warning, null );
	const ast = parse( result.code, { sourceType: 'module' } );
	const owner = ast.program.body.find( node => node.type === 'ClassDeclaration' && node.id.name === 'Bindings' );
	const method = owner.body.body.find( node => node.key?.name === 'deleteForRender' );
	return new Function( 'renderObject', result.code.slice( method.body.start + 1, method.body.end - 1 ) );

}

test( `rewrite/${ release.id }: rejected cold compilation disposes native objects without building bindings`, async t => {

	installMockWebGPU();
	const three = await import( pathToFileURL( resolve( sourceRoot, 'Three.WebGPU.js' ) ).href );
	const context = createMockGPUCanvasContext();
	const renderer = new three.WebGPURenderer( { canvas: {
		width: 32, height: 32, style: {}, getContext: () => context,
		addEventListener() {}, removeEventListener() {},
	} } );
	t.after( () => renderer.dispose() );
	await renderer.init();
	renderer.outputColorSpace = three.LinearSRGBColorSpace;
	renderer._bindings.deleteForRender = rewrittenBindingsDeletion();
	const replay = new ReplayNodeManager( renderer, renderer.backend );
	let builds = 0;
	renderer._nodes.getForRender = renderObject => {

		builds ++;
		return replay.getForRender( renderObject );

	};
	const material = new three.MeshBasicNodeMaterial();
	const geometry = new three.BoxGeometry();
	const mesh = new three.Mesh( geometry, material );
	const scene = new three.Scene();
	scene.add( mesh );
	const camera = new three.PerspectiveCamera();
	await assert.rejects( renderer.compileAsync( scene, camera ), { tslPrecompileSlimOnly: true } );
	const objects = renderer._objects;
	const [ cold ] = objects._renderObjects;
	assert.ok( cold );
	assert.equal( cold._bindings, null, 'native cold objects own no allocated bindings' );
	assert.equal( material._listeners.dispose.length, 1 );
	const rejectedBuilds = builds;
	await renderer.dispose();
	assert.equal( builds, rejectedBuilds, 'disposal never retries rejected graph construction' );
	assert.equal( objects._renderObjects.size, 0 );
	for ( const resource of [ material, geometry, mesh ] ) assert.equal( resource._listeners?.dispose?.length || 0, 0 );
	material.dispose();
	geometry.dispose();

} );

test( `rewrite/${ release.id }: allocated bindings retain native destruction and unknown deletion shapes reject`, async () => {

	const { default: Bindings } = await import( pathToFileURL( resolve( sourceRoot, 'renderers/common/Bindings.js' ) ).href );
	const events = [];
	const backend = {
		destroyUniformBuffer: binding => events.push( [ 'buffer', binding ] ),
		deleteBindGroupData: group => events.push( [ 'group', group ] ),
	};
	const bindings = new Bindings( backend, {}, {}, {}, {}, { destroyUniformBuffer() { events.push( [ 'info' ] ); } } );
	bindings.deleteForRender = rewrittenBindingsDeletion();
	const uniform = { isUniformBuffer: true, release() { events.push( [ 'array' ] ); } };
	const group = { bindings: [ uniform ] };
	const object = { _bindings: [ group ], getBindings() { return this._bindings; } };
	bindings.get( group ).usedTimes = 1;
	bindings.get( object ).owned = true;
	bindings.deleteForRender( object );
	assert.deepEqual( events, [ [ 'buffer', uniform ], [ 'info' ], [ 'array' ], [ 'group', group ] ] );
	assert.equal( bindings.has( group ), false );
	assert.equal( bindings.has( object ), false );
	assert.throws( () => bindings.deleteForRender( { getBindings() { throw new Error( 'unknown binding state' ); } } ),
		/unknown binding state/, 'only the native null sentinel skips binding creation' );
	const changed = rewrite( 'renderers/common/Bindings.js', source => source.replace( 'this._destroyBindings( bindings );\n\n\t\tthis.delete( renderObject );', 'this._destroyBindings( bindings );\n\n\t\tthis.delete( renderObject.material );' ) );
	assert.equal( changed.code, null );
	assert.match( changed.warning, /deleteForRender ownership shape changed/ );

} );

test( `extractor/${ release.id }: actual PointsNodeMaterial keeps DPR, viewport and logical half-height live`, async () => {

	installMockWebGPU();
	const three = await import( pathToFileURL( resolve( sourceRoot, 'Three.WebGPU.js' ) ).href );
	const context = createMockGPUCanvasContext();
	const renderer = new three.WebGPURenderer( { canvas: {
		width: 256, height: 256, clientWidth: 256, clientHeight: 256, style: {},
		getContext: () => context, addEventListener() {}, removeEventListener() {},
	} } );
	await renderer.init();
	const material = new three.PointsNodeMaterial();
	const geometry = new three.BoxGeometry();
	const scene = new three.Scene();
	scene.userData.__tslpSyntheticCaptureScene = true;
	scene.add( new three.Mesh( geometry, material ) );
	const camera = new three.PerspectiveCamera();
	camera.position.z = 3;
	try {

		const artifacts = await compileTSL( renderer, scene, camera, { materials: [ material ] } );
		const kinds = artifacts.byMaterialUuid.get( material.uuid ).uniformPlan.flatMap( group => group.slots || [] ).map( slot => slot.source?.kind );
		for ( const kind of [ 'renderer.dpr', 'renderer.viewport', 'renderer.halfHeight' ] ) assert.ok( kinds.includes( kind ), kind );
		assert.equal( kinds.includes( 'uniform.live' ), false );

	} finally {

		material.dispose(); geometry.dispose(); await renderer.dispose();

	}

} );

test( `extractor/${ release.id }: native ScreenNode vector probes preserve values and recover exact shadow uniform ownership`, async () => {

	const three = await import( pathToFileURL( resolve( sourceRoot, 'Three.WebGPU.js' ) ).href );
	for ( const [ scope, kind, values ] of [
		[ 'size', 'renderer.size', [ 123, 456 ] ],
		[ 'viewport', 'renderer.viewport', [ 5, 6, 123, 456 ] ],
	] ) {

		const screen = new three.ScreenNode( scope );
		const output = screen.setup();
		assert.equal( screen._output, undefined, 'native new source exposes no private output node' );
		output.value.fromArray( values );
		const entry = resolveScreenUniformSource( screen );
		assert.equal( entry.uniformValue, output.value );
		assert.deepEqual( entry.source, { kind } );
		assert.deepEqual( output.value.toArray(), values, 'identity probes leave the renderer-owned vector unchanged' );
		const equalValue = output.value.clone();
		const authored = new three.UniformNode( equalValue );
		const slot = node => ( {
			name: 'screen', offset: 0, itemSize: values.length,
			nodeUniform: { node }, getType: () => `vec${ values.length }`, getValue: () => node.value,
		} );
		const plan = extractUniformPlan( {
			updateNodes: [ screen ], bindings: [ { name: 'object', bindings: [ {
				isUniformsGroup: true, byteLength: 32, visibility: 3, groupNode: { shared: false },
				uniforms: [ slot( output ), slot( authored ) ],
			} ] } ],
		} );
		assert.equal( plan[ 0 ].slots[ 0 ].source.kind, kind, 'shadow-array uniforms resolve through exact shared vector identity' );
		assert.equal( plan[ 0 ].slots[ 1 ].source.kind, 'uniform.live', 'equal snapshots do not classify unrelated authored values' );
		assert.deepEqual( output.value.toArray(), values );

	}

} );

test( `extractor/${ release.id }: renderer-output captures merge after a real viewport resize`, async () => {

	installMockWebGPU();
	const three = await import( pathToFileURL( resolve( sourceRoot, 'Three.WebGPU.js' ) ).href );
	const context = createMockGPUCanvasContext();
	const renderer = new three.WebGPURenderer( { canvas: {
		width: 256, height: 256, clientWidth: 256, clientHeight: 256, style: {},
		getContext: () => context, addEventListener() {}, removeEventListener() {},
	} } );
	await renderer.init();
	renderer.toneMapping = three.NeutralToneMapping;
	const scene = new three.Scene();
	const material = new three.MeshBasicNodeMaterial();
	const geometry = new three.BoxGeometry();
	scene.userData.__tslpSyntheticCaptureScene = true;
	scene.add( new three.Mesh( geometry, material ) );
	const camera = new three.PerspectiveCamera();
	camera.position.z = 3;
	try {

		const first = ( await compileTSL( renderer, scene, camera, { captureRendererOutput: true } ) ).renderOutputCapture.artifact;
		renderer.setSize( 320, 180 );
		const second = ( await compileTSL( renderer, scene, camera, { captureRendererOutput: true } ) ).renderOutputCapture.artifact;
		const sources = artifact => artifact.uniformPlan.flatMap( group => group.slots || [] ).map( slot => slot.source );
		const before = sources( first ).find( source => source.kind === 'renderer.size' );
		const after = sources( second ).find( source => source.kind === 'renderer.size' );
		assert.ok( before && after, 'output frame dimensions have renderer ownership' );
		assert.notDeepEqual( before.valueSnapshot, after.valueSnapshot );
		assert.doesNotThrow( () => mergeArtifactVariantFamily( [ first, second ] ), 'live size changes do not split identical shader/binding families' );

	} finally {

		material.dispose(); geometry.dispose(); await renderer.dispose();

	}

} );

test( `rewrite/${ release.id }: QuadMesh replays its captured vertex shader without constructing a live graph`, () => {

	const result = rewrite( 'renderers/common/QuadMesh.js' );
	assert.equal( result.warning, null );
	assert.doesNotMatch( result.code, /_vertexNode|nodes\/|vertexIndex|\barray\(/ );
	const ast = parse( result.code, { sourceType: 'module' } );
	const owner = ast.program.body.find( node => node.type === 'ClassDeclaration' && node.id.name === 'QuadMesh' );
	const method = owner.body.body.find( node => node.key?.name === 'render' );
	const render = new Function( 'renderer', '_camera', result.code.slice( method.body.start + 1, method.body.end - 1 ) );
	const material = { vertexNode: { captured: true } };
	const mesh = { material };
	const camera = {};
	let calls = 0;
	render.call( mesh, { render( object, view ) {

		assert.equal( object, mesh );
		assert.equal( view, camera );
		assert.equal( object.material, material );
		calls ++;

	} }, camera );
	assert.equal( calls, 1 );
	assert.deepEqual( material.vertexNode, { captured: true } );
	const changed = rewrite( 'renderers/common/QuadMesh.js', source => source.replace( 'array( [ - 1.0, - 1.0, 3.0 ] )', 'array( [ - 1.0, - 1.0, 2.0 ] )' ) );
	assert.equal( changed.code, null );
	assert.match( changed.warning, /module AST changed/ );

} );

test( `rewrite/${ release.id }: discarded RenderPipeline context graphs are removed before material replacement`, () => {

	const result = rewrite( 'renderers/common/RenderPipeline.js' );
	assert.equal( result.warning, null );
	assert.doesNotMatch( result.code, /nodes\/TSL\.js|context\(contextData\)/ );
	const ast = parse( result.code, { sourceType: 'module' } );
	const owner = ast.program.body.find( node => node.type === 'ClassDeclaration' && node.id.name === 'RenderPipeline' );
	const method = owner.body.body.find( node => node.key?.name === '_updateContext' );
	const updateContext = new Function( 'createReplayRenderPipelineMaterial', result.code.slice( method.body.start + 1, method.body.end - 1 ) );
	const previous = {}, replacement = {};
	const pipeline = {
		_toneMapping: 4, _outputColorSpace: 'srgb', outputNode: {}, outputColorTransform: false,
		_quadMesh: { material: previous },
	};
	updateContext.call( pipeline, ( received, material ) => {

		assert.equal( received, pipeline );
		assert.equal( material, previous );
		assert.equal( received._contextData.renderPipeline, pipeline );
		return replacement;

	} );
	assert.equal( pipeline._quadMesh.material, replacement );
	assert.equal( replacement.needsUpdate, true );
	assert.deepEqual( pipeline._contextData.onBeforePipelineCallbacks, [] );
	assert.deepEqual( pipeline._contextData.onAfterPipelineCallbacks, [] );
	assert.equal( pipeline._contextData.toneMapping, 4 );
	assert.equal( pipeline._contextData.outputColorSpace, 'srgb' );
	const changed = rewrite( 'renderers/common/RenderPipeline.js', source => source.replace( 'context( contextData )', 'context( { ...contextData } )' ) );
	assert.equal( changed.code, null );
	assert.match( changed.warning, /discarded material context ownership shape changed/ );

} );

test( `rewrite/${ release.id }: discarded NodeUtils compiler helper exports remain linkable and reject calls`, () => {

	const result = rewrite( 'nodes/core/NodeUtils.js' );
	const ast = parse( result.code, { sourceType: 'module' } );
	const helpers = ast.program.body.filter( node => node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'FunctionDeclaration' );
	assert.ok( helpers.some( node => node.declaration.id.name === 'getTextureType' ) );
	assert.ok( helpers.some( node => node.declaration.id.name === 'getValueType' ) );
	for ( const helper of helpers ) {

		const call = new Function( `${ generate( helper.declaration ).code }; return ${ helper.declaration.id.name }();` );
		assert.throws( call, error => error.tslPrecompileSlimOnly === true && /compiler helper/.test( error.message ) );

	}
	assert.doesNotMatch( result.code, /from ['"](?:three|\.\.\/)/ );

} );

test( `capture/${ release.id }: actual native PMREM atlas support is checked before drawing and output validation`, async () => {

	installMockWebGPU();
	const three = await import( pathToFileURL( resolve( sourceRoot, 'Three.WebGPU.js' ) ).href );
	const context = createMockGPUCanvasContext();
	const renderer = new three.WebGPURenderer( { canvas: {
		width: 256, height: 256, clientWidth: 256, clientHeight: 256, style: {},
		getContext: () => context, addEventListener() {}, removeEventListener() {},
	} } );
	await renderer.init();
	const generator = new three.PMREMGenerator( renderer );
	const source = new three.DataTexture( new Float32Array( 64 * 32 * 4 ), 64, 32, three.RGBAFormat, three.FloatType );
	source.mapping = three.EquirectangularReflectionMapping;
	source.needsUpdate = true;
	let output;
	const unsupported = error => error.code === 'TSLP_UNSUPPORTED_PMREM_CUBE_REPLAY' && /compatibility mode/.test( error.message );
	try {

		if ( release.channel === 'development' ) assert.throws( () => assertPMREMAtlasCaptureSupport( generator ), unsupported );
		else assert.doesNotThrow( () => assertPMREMAtlasCaptureSupport( generator ) );

		// Native rendering remains available in compatibility mode. Its real
		// allocation supplies stronger evidence than a revision-name check.
		output = generator.fromEquirectangular( source );
		if ( release.channel === 'development' ) {

			assert.equal( output.isCubeRenderTarget, true );
			assert.equal( output.texture.isPMREMTexture, true );
			assert.equal( output.texture.mipmaps.length, 6 );
			assert.throws( () => assertPMREMAtlasCaptureSupport( generator, output ), unsupported );
			assert.throws( () => assertPMREMAtlasCaptureSupport( null, output ), unsupported );
			output.texture.name = 'caller-renamed-environment';
			const scene = new three.Scene();
			scene.userData.__tslpSyntheticCaptureScene = true;
			scene.environment = output.texture;
			const material = new three.MeshStandardNodeMaterial();
			const geometry = new three.BoxGeometry();
			scene.add( new three.Mesh( geometry, material ) );
			const camera = new three.PerspectiveCamera();
			camera.position.z = 3;
			try {

				const artifacts = await compileTSL( renderer, scene, camera, { materials: [ material ] } );
				const bindings = artifacts.byMaterialUuid.get( material.uuid ).uniformPlan.flatMap( group => group.textures || [] );
				const cubePMREM = bindings.find( binding => binding.textureType === 'cube' && binding.source?.textureUuid === output.texture.uuid );
				assert.equal( cubePMREM.source.kind, 'artifact.texture' );
				assert.equal( cubePMREM.source.textureName, 'caller-renamed-environment' );
				assert.equal( cubePMREM.source.isPMREMTexture, true, 'native PMREM ownership survives caller renaming for replay guards' );
				assert.equal( cubePMREM.source.renderTargetSelector, undefined );

			} finally {

				material.dispose(); geometry.dispose();

			}

		} else {

			assert.equal( output.texture.mapping, three.CubeUVReflectionMapping );
			const layout = createPMREMLayoutConfig( generator._cubeSize );
			assert.deepEqual( { width: output.width, height: output.height }, layout.target );
			assert.doesNotThrow( () => assertPMREMAtlasCaptureSupport( generator, output ) );

		}
		const ordinaryCubeSource = new three.CubeTexture();
		assert.doesNotThrow( () => assertPMREMAtlasCaptureSupport( null, { texture: ordinaryCubeSource } ), 'ordinary cubemap inputs remain supported' );
		ordinaryCubeSource.dispose();

	} finally {

		output?.dispose(); source.dispose(); generator.dispose(); await renderer.dispose();

	}

} );

test( `rewrite/${ release.id }: compilation keeps progress, precompile state and batched yields`, async () => {

	const compile = replayLoop();
	let now = 0;
	const yielded = [], progress = [], events = [];
	const items = Array.from( { length: 10 }, ( _, id ) => ( { object: { id, geometry: {} } } ) );
	const owner = {
		_isPreCompiling: false, _precompilationState: null,
		_beginPreCompile( state ) { this._precompilationState = state; },
		_finishPreCompile() { this._precompilationState = null; },
		_objects: { get: object => ( { object } ) },
		_nodes: {
			getForRender( ro ) { events.push( [ ro.object.id, 'hydrate' ] ); },
			updateBefore( ro ) { events.push( [ ro.object.id, 'before' ] ); },
			updateForRender( ro ) { events.push( [ ro.object.id, 'uniforms' ] ); },
			updateAfter( ro ) { events.push( [ ro.object.id, 'after' ] ); },
		},
		_geometries: { updateForRender() { now ++; } }, _bindings: { updateForRender() {} },
		_pipelines: { getForRender( ro ) { events.push( [ ro.object.id, 'pipeline' ] ); } },
	};
	class ProgressEvent {

		constructor( type, detail ) { this.type = type; Object.assign( this, detail ); }

	}
	await compile.call( owner, items, async () => { yielded.push( now ); }, { now: () => now }, event => progress.push( event ), ProgressEvent, {} );
	// four millisecond replay budget, or ec2b745's native eight millisecond CompileScheduler budget
	assert.deepEqual( yielded, parallelCompileLoop ? [ 8 ] : [ 4, 8 ] );
	assert.deepEqual( progress.map( event => event.loaded ), [ 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 ] );
	assert.ok( progress.every( event => event.total === 10 && event.lengthComputable ) );
	assert.equal( owner._isPreCompiling, false );
	assert.equal( owner._precompilationState, null );
	assert.deepEqual( events, items.flatMap( ( { object } ) => [ 'hydrate', 'before', 'uniforms', 'pipeline', 'after' ].map( stage => [ object.id, stage ] ) ) );

} );

test( `rewrite/${ release.id }: native pipeline waits retain each release's callback barrier`, async () => {

	const compile = replayLoop();
	const first = Promise.withResolvers(), second = Promise.withResolvers(), startedSecond = Promise.withResolvers();
	const events = [];
	const owner = {
		_beginPreCompile() {}, _finishPreCompile() {},
		_objects: { get: object => ( { object } ) },
		_nodes: {
			getForRender( ro ) { events.push( `hydrate${ ro.object.id }` ); },
			updateBefore() {}, updateForRender() {},
			updateAfter( ro ) { events.push( `after${ ro.object.id }` ); },
		},
		_geometries: { updateForRender() {} }, _bindings: { updateForRender() {} },
		_pipelines: { getForRender( ro, promises ) {

			promises.push( ro.object.id === 0 ? first.promise : second.promise );
			if ( ro.object.id === 1 ) startedSecond.resolve();

		} },
	};
	const items = [ 0, 1 ].map( id => ( { object: { id, geometry: {} } } ) );
	const pending = compile.call( owner, items, async () => {}, { now: () => 0 }, null, null, {} );
	// r186.1 waits before updateAfter; 21a3bb7 after it; ec2b745 only bounds the parallel window
	// and awaits every pipeline before compileAsync settles.
	const expectedBeforeFirst = parallelCompileLoop ? [ 'hydrate0', 'after0', 'hydrate1', 'after1' ] : release.channel === 'development' ? [ 'hydrate0', 'after0' ] : [ 'hydrate0' ];
	assert.deepEqual( events, expectedBeforeFirst );
	first.resolve();
	await startedSecond.promise;
	const failure = new Error( 'native pipeline failed' );
	second.reject( failure );
	await assert.rejects( pending, error => error === failure );
	assert.deepEqual( events, release.channel === 'development' ? [ 'hydrate0', 'after0', 'hydrate1', 'after1' ] : [ 'hydrate0', 'after0', 'hydrate1' ] );

} );

test( `rewrite/${ release.id }: unknown compilation, filter and GPU-cache shape changes fail closed`, () => {

	for ( const [ name, mutate ] of [
		[ 'renderers/common/Renderer.js', source => source.replace( 'await this._nodes.getForRenderAsync( renderObject', 'await this._nodes.getForRenderDeferred( renderObject' ) ],
		[ 'nodes/lighting/ShadowFilterNode.js', source => `${ source }\nexport const unverifiedFilter = 1;` ],
		[ 'renderers/webgpu/WebGPUBackend.js', source => source.replace( 'currentBindingGroups[ i ] = bindGroupGPU;', 'currentBindingGroups[ i ] = bindGroup.id;' ) ],
	] ) {

		const result = rewrite( name, mutate );
		assert.equal( result.code, null, name );
		assert.match( result.warning, /shape changed|module AST changed/, name );

	}

} );

test( `rewrite/${ release.id }: replay targets are released before node state and asynchronous backend disposal`, async () => {

	const result = rewrite( 'renderers/common/Renderer.js' );
	const method = rendererMethod( result, 'dispose' );
	const dispose = new ( Object.getPrototypeOf( async function () {} ).constructor )( result.code.slice( method.body.start + 1, method.body.end - 1 ) );
	const events = [];
	const owner = {
		_initialized: true, _initPromise: null, _frameBufferTargets: new Map(),
		_nodes: { disposeRendererResources() { events.push( 'resources' ); }, dispose() { events.push( 'nodes' ); } },
		backend: { async dispose() { events.push( 'backend' ); } },
		setRenderTarget() {}, setAnimationLoop() {}, _destroyCanvasTarget() {},
	};
	for ( const key of [ 'info', '_inspector', '_animation', '_objects', '_geometries', '_attributes', '_pipelines', '_bindings', '_renderLists', '_renderContexts', '_textures' ] ) owner[ key ] = { dispose() {} };
	await dispose.call( owner );
	assert.deepEqual( events, [ 'resources', 'nodes', 'backend' ] );

} );

test( `rewrite/${ release.id }: native GPU group identities rebind replacements and preserve the active camera slot`, () => {

	const result = rewrite( 'renderers/webgpu/WebGPUBackend.js' );
	assert.equal( result.warning, null );
	const ast = parse( result.code, { sourceType: 'module' } );
	const backend = ast.program.body.find( node => node.type === 'ClassDeclaration' && node.id.name === 'WebGPUBackend' );
	const draw = backend.body.body.find( node => node.key?.name === '_draw' );
	const cache = draw.body.body.find( node => node.type === 'VariableDeclaration' && node.declarations[ 0 ].id.name === 'currentBindingGroups' );
	const loop = draw.body.body.find( node => node.type === 'ForStatement' && generate( node.init ).code.includes( 'bindings.length' ) );
	const run = new Function( 'bindings', 'currentSets', 'cameraIndexSlot', 'passEncoderGPU', result.code.slice( cache.start, loop.end ) );
	const data = new WeakMap();
	let creates = 0;
	const owner = {
		get( resource ) { if ( ! data.has( resource ) ) data.set( resource, {} ); return data.get( resource ); },
		createUniformBuffer( binding ) { this.get( binding ).buffer = {}; },
		createBindings( group ) { this.get( group ).group = { version: ++ creates }; },
	};
	const groups = [ 1, 2 ].map( id => ( { id, bindings: [ { isUniformBuffer: true } ] } ) );
	const sets = { bindingGroups: [] };
	const commands = [];
	const pass = { setBindGroup: ( slot, group ) => commands.push( [ slot, group ] ) };
	run.call( owner, groups, sets, - 1, pass );
	assert.equal( creates, 2 );
	assert.equal( commands.length, 2 );
	run.call( owner, groups, sets, - 1, pass );
	assert.equal( commands.length, 2, 'unchanged native GPU groups do not rebind' );
	const replacement = {};
	owner.get( groups[ 0 ] ).group = replacement;
	run.call( owner, groups, sets, - 1, pass );
	assert.deepEqual( commands.at( - 1 ), [ 0, replacement ] );
	const cameraGroup = {};
	sets.bindingGroups[ 0 ] = cameraGroup;
	run.call( owner, groups, sets, 0, pass );
	assert.equal( sets.bindingGroups[ 0 ], cameraGroup, 'native camera slot is excluded from the ordinary group loop' );
	assert.equal( commands.length, 3 );
	run.call( owner, groups, sets, - 1, pass );
	assert.deepEqual( commands.at( - 1 ), [ 0, replacement ] );
	delete owner.get( groups[ 1 ] ).group;
	run.call( owner, groups, sets, - 1, pass );
	assert.equal( creates, 3, 'released GPU group is initialized again' );
	assert.equal( commands.length, 5 );

} );

test( `extractor/${ release.id }: current source produces PBR artifacts with mock GPU and bounded material listeners`, async () => {

	installMockWebGPU();
	const three = await import( pathToFileURL( resolve( sourceRoot, 'Three.WebGPU.js' ) ).href );
	const context = createMockGPUCanvasContext();
	const renderer = new three.WebGPURenderer( { canvas: {
		width: 256, height: 256, clientWidth: 256, clientHeight: 256, style: {},
		getContext: () => context, addEventListener() {}, removeEventListener() {},
	} } );
	await renderer.init();
	const material = new three.MeshStandardNodeMaterial();
	const geometry = new three.BoxGeometry();
	const scene = new three.Scene();
	scene.userData.__tslpSyntheticCaptureScene = true;
	scene.add( new three.Mesh( geometry, material ), new three.HemisphereLight(), new three.DirectionalLight() );
	const camera = new three.PerspectiveCamera();
	camera.position.z = 3;
	try {

		const artifacts = await compileTSL( renderer, scene, camera, { materials: [ material ] } );
		const artifact = artifacts.byMaterialUuid.get( material.uuid );
		assert.match( artifact.vertexShader, /@vertex/ );
		assert.match( artifact.fragmentShader, /@fragment/ );
		assert.ok( artifact.uniformPlan.flatMap( group => group.slots || [] ).some( slot => slot.source?.kind === 'light.colorScaled' ) );
		assert.equal( material._listeners?.dispose?.length || 0, 0 );

	} finally {

		material.dispose(); geometry.dispose(); await renderer.dispose();

	}

} );
