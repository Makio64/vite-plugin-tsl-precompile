import assert from 'node:assert/strict';
import test from 'node:test';

import { rewriteR185AddonCompatibility } from '../r185-addon-compat.mjs';

const OPTIONS = {
	relativePath: 'tsl/display/RecurrentDenoiseNode.js',
	threeVersion: '0.185.1',
};

test( 'r185 addon compatibility moves inline shared context to NodeMaterial', () => {

	const source = [
		"import { Fn, uv } from 'three/tsl';",
		'this._material.fragmentNode = denoiseFn( uv() ).context( builder.getSharedContext() );',
	].join( '\n' );
	const rewritten = rewriteR185AddonCompatibility( source, OPTIONS );

	assert.match( rewritten, /import \{ Fn, uv, context \} from 'three\/tsl';/ );
	assert.match( rewritten, /this\._material\.contextNode = context\( builder\.getSharedContext\(\) \);/ );
	assert.match( rewritten, /this\._material\.fragmentNode = denoiseFn\( uv\(\) \);/ );
	assert.doesNotMatch( rewritten, /denoiseFn.*\.context/ );
	assert.equal( rewriteR185AddonCompatibility( rewritten, OPTIONS ), rewritten, 'rewrite is idempotent' );

} );

test( 'r185 addon compatibility inlines RecurrentDenoise neighborhood stats', () => {

	const source = [
		"import { Fn, uv } from 'three/tsl';",
		'const keepNamed = Fn( ( [ value ] ) => value ).setLayout( {',
		"\tname: 'keepNamed',",
		"\ttype: 'float',",
		"\tinputs: [ { name: 'value', type: 'float' } ]",
		'} );',
		'const getNeighborhoodStats = Fn( ( [ uvCoord, centerSample ] ) => {',
		'\treturn centerSample;',
		'} ).setLayout( {',
		"\tname: 'getNeighborhoodStats',",
		"\ttype: 'vec4',",
		'\tinputs: [',
		"\t\t{ name: 'uvCoord', type: 'vec2' },",
		"\t\t{ name: 'centerSample', type: 'vec4' }",
		'\t]',
		'} );',
		'this._material.fragmentNode = denoiseFn( uv() ).context( builder.getSharedContext() );',
	].join( '\n' );
	const rewritten = rewriteR185AddonCompatibility( source, OPTIONS );
	const neighborhood = rewritten.slice(
		rewritten.indexOf( 'const getNeighborhoodStats' ),
		rewritten.indexOf( 'this._material.contextNode' ),
	);

	assert.match( neighborhood, /const getNeighborhoodStats = Fn\([\s\S]*?\}\s*\);/ );
	assert.doesNotMatch( neighborhood, /\.setLayout\(/ );
	assert.doesNotMatch( rewritten, /name: 'getNeighborhoodStats'/ );
	assert.match( rewritten, /keepNamed[\s\S]*?\.setLayout\(\s*\{\s*name: 'keepNamed'/ );
	assert.match( rewritten, /this\._material\.contextNode = context\( builder\.getSharedContext\(\) \);/ );
	assert.equal( rewriteR185AddonCompatibility( rewritten, OPTIONS ), rewritten, 'rewrite is idempotent' );
	const otherAddon = rewriteR185AddonCompatibility( source, {
		...OPTIONS,
		relativePath: 'tsl/display/OtherNode.js',
	} );
	assert.match( otherAddon, /name: 'getNeighborhoodStats'/, 'layout removal is RecurrentDenoise-specific' );
	assert.equal( rewriteR185AddonCompatibility( source, {
		...OPTIONS,
		threeVersion: '0.186.0',
	} ), source, 'rewrite is r185.1-specific' );

} );

test( 'r185 addon compatibility renames a colliding local context binding', () => {

	const source = [
		"import { Fn } from 'three/tsl';",
		'const context = builder.getSharedContext();',
		'material.fragmentNode = rcas().context( context );',
	].join( '\n' );
	const rewritten = rewriteR185AddonCompatibility( source, {
		...OPTIONS,
		relativePath: 'tsl/display/SharpenNode.js',
	} );

	assert.match( rewritten, /const sharedContext = builder\.getSharedContext\(\);/ );
	assert.match( rewritten, /material\.contextNode = context\( sharedContext \);/ );
	assert.match( rewritten, /material\.fragmentNode = rcas\(\);/ );

} );

test( 'r185 addon compatibility covers temporal resolve and TRAA material context', () => {

	const temporal = rewriteR185AddonCompatibility( [
		"import { Fn } from 'three/tsl';",
		'return resolve().context( builder.getSharedContext() );',
	].join( '\n' ), {
		...OPTIONS,
		relativePath: 'tsl/display/TemporalReprojectNode.js',
	} );
	assert.match( temporal, /this\._resolveMaterial\.contextNode = context\( builder\.getSharedContext\(\) \);/ );
	assert.match( temporal, /return resolve\(\);/ );

	const traa = rewriteR185AddonCompatibility( [
		"import { Fn } from 'three/tsl';",
		'\t\tthis._resolveMaterial.colorNode = resolve();',
	].join( '\n' ), {
		...OPTIONS,
		relativePath: 'tsl/display/TRAANode.js',
	} );
	assert.match( traa, /this\._resolveMaterial\.contextNode = context\( builder\.getSharedContext\(\) \);/ );
	assert.match( traa, /this\._resolveMaterial\.colorNode = resolve\(\);/ );

} );

test( 'r185 addon compatibility gives SSR five legal constructor mip levels', () => {

	const source = [
		"import { Fn } from 'three/tsl';",
		'this._blurRenderTarget = new RenderTarget( 1, 1, { depthBuffer: false, type: HalfFloatType } );',
		'width = Math.round( this.resolutionScale * width );',
		'height = Math.round( this.resolutionScale * height );',
	].join( '\n' );
	const rewritten = rewriteR185AddonCompatibility( source, {
		...OPTIONS,
		relativePath: 'tsl/display/SSRNode.js',
	} );

	assert.match( rewritten, /new RenderTarget\( 16, 16, \{ depthBuffer: false/ );
	assert.match( rewritten, /width = Math\.max\( 16, Math\.round\( this\.resolutionScale \* width \) \);/ );
	assert.match( rewritten, /height = Math\.max\( 16, Math\.round\( this\.resolutionScale \* height \) \);/ );
	assert.equal( rewriteR185AddonCompatibility( rewritten, {
		...OPTIONS,
		relativePath: 'tsl/display/SSRNode.js',
	} ), rewritten );

} );

test( 'r185 Gaussian compatibility keeps NodeMaterial and RenderTarget in full Three', () => {

	const source = [
		"import { RenderTarget, Vector2, NodeMaterial, RendererUtils, QuadMesh, TempNode, NodeUpdateType } from 'three/webgpu';",
		"import { Fn, uniform } from 'three/tsl';",
	].join( '\n' );
	const options = {
		...OPTIONS,
		relativePath: 'tsl/display/GaussianBlurNode.js',
	};
	const rewritten = rewriteR185AddonCompatibility( source, options );

	assert.match(
		rewritten,
		/^import \{ RenderTarget, NodeMaterial \} from '\/build\/three\.webgpu\.js';/m,
	);
	assert.match(
		rewritten,
		/import \{ Vector2, RendererUtils, QuadMesh, TempNode, NodeUpdateType \} from 'three\/webgpu';/,
	);
	assert.doesNotMatch( rewritten, /import \{[^}]*\b(?:NodeMaterial|RenderTarget)\b[^}]*\} from 'three\/webgpu';/ );
	assert.doesNotMatch( rewritten, /\bcontext\b/, 'import routing alone does not add an unused context import' );
	assert.equal( rewriteR185AddonCompatibility( rewritten, options ), rewritten, 'rewrite is idempotent' );

} );

test( 'r185 TAAU compatibility keeps renderer-owned resources in full Three', () => {

	const source = [
		"import { HalfFloatType, Vector2, RenderTarget, RendererUtils, QuadMesh, NodeMaterial, TempNode, NodeUpdateType, Matrix4, DepthTexture } from 'three/webgpu';",
		"import { Fn } from 'three/tsl';",
		'\t\tthis._resolveMaterial.colorNode = resolve();',
		'\t\tthis._seedMaterial.outputNode = outputNode;',
	].join( '\n' );
	const options = {
		...OPTIONS,
		relativePath: 'tsl/display/TAAUNode.js',
	};
	const rewritten = rewriteR185AddonCompatibility( source, options );

	assert.match(
		rewritten,
		/^import \{ RenderTarget, NodeMaterial, DepthTexture \} from '\/build\/three\.webgpu\.js';/m,
	);
	assert.match(
		rewritten,
		/import \{ HalfFloatType, Vector2, RendererUtils, QuadMesh, TempNode, NodeUpdateType, Matrix4 \} from 'three\/webgpu';/,
	);
	assert.doesNotMatch(
		rewritten,
		/import \{[^}]*\b(?:DepthTexture|NodeMaterial|RenderTarget)\b[^}]*\} from 'three\/webgpu';/,
	);
	assert.match( rewritten, /this\._resolveMaterial\.contextNode = sharedContext;/ );
	assert.match( rewritten, /this\._seedMaterial\.contextNode = sharedContext;/ );
	assert.equal( rewriteR185AddonCompatibility( rewritten, options ), rewritten, 'rewrite is idempotent' );

} );

test( 'r185 temporal denoise compatibility keeps internal render resources in full Three', () => {

	const temporalSource = [
		"import { DepthTexture, HalfFloatType, NodeMaterial, RenderTarget, Vector2 } from 'three/webgpu';",
		"import { Fn } from 'three/tsl';",
		'return resolve().context( builder.getSharedContext() );',
	].join( '\n' );
	const temporalOptions = {
		...OPTIONS,
		relativePath: 'tsl/display/TemporalReprojectNode.js',
	};
	const temporal = rewriteR185AddonCompatibility( temporalSource, temporalOptions );
	assert.match(
		temporal,
		/^import \{ DepthTexture, NodeMaterial, RenderTarget \} from '\/build\/three\.webgpu\.js';/m,
	);
	assert.match( temporal, /import \{ HalfFloatType, Vector2 \} from 'three\/webgpu';/ );
	assert.doesNotMatch(
		temporal,
		/import \{[^}]*\b(?:DepthTexture|NodeMaterial|RenderTarget)\b[^}]*\} from 'three\/webgpu';/,
	);
	assert.equal( rewriteR185AddonCompatibility( temporal, temporalOptions ), temporal );

	const recurrentSource = [
		"import { HalfFloatType, NodeMaterial, RenderTarget, Vector2 } from 'three/webgpu';",
		"import { Fn } from 'three/tsl';",
	].join( '\n' );
	const recurrentOptions = {
		...OPTIONS,
		relativePath: 'tsl/display/RecurrentDenoiseNode.js',
	};
	const recurrent = rewriteR185AddonCompatibility( recurrentSource, recurrentOptions );
	assert.match(
		recurrent,
		/^import \{ NodeMaterial, RenderTarget \} from '\/build\/three\.webgpu\.js';/m,
	);
	assert.match( recurrent, /import \{ HalfFloatType, Vector2 \} from 'three\/webgpu';/ );
	assert.equal( rewriteR185AddonCompatibility( recurrent, recurrentOptions ), recurrent );

} );

test( 'r185 Sharpen compatibility keeps NodeMaterial and RenderTarget in full Three', () => {

	const source = [
		"import { HalfFloatType, RenderTarget, Vector2, NodeMaterial, RendererUtils, QuadMesh, TempNode, NodeUpdateType } from 'three/webgpu';",
		"import { Fn } from 'three/tsl';",
		'const context = builder.getSharedContext();',
		'material.fragmentNode = rcas().context( context );',
	].join( '\n' );
	const options = {
		...OPTIONS,
		relativePath: 'tsl/display/SharpenNode.js',
	};
	const rewritten = rewriteR185AddonCompatibility( source, options );

	assert.match(
		rewritten,
		/^import \{ RenderTarget, NodeMaterial \} from '\/build\/three\.webgpu\.js';/m,
	);
	assert.match(
		rewritten,
		/import \{ HalfFloatType, Vector2, RendererUtils, QuadMesh, TempNode, NodeUpdateType \} from 'three\/webgpu';/,
	);
	assert.doesNotMatch( rewritten, /import \{[^}]*\b(?:NodeMaterial|RenderTarget)\b[^}]*\} from 'three\/webgpu';/ );
	assert.match( rewritten, /material\.contextNode = context\( sharedContext \);/ );
	assert.equal( rewriteR185AddonCompatibility( rewritten, options ), rewritten, 'rewrite is idempotent' );

} );

test( 'r185 Gaussian compatibility routes a RenderTarget-only import', () => {

	const source = "import { RenderTarget, Vector2 } from 'three/webgpu';";
	const rewritten = rewriteR185AddonCompatibility( source, {
		...OPTIONS,
		relativePath: 'tsl/display/GaussianBlurNode.js',
	} );

	assert.equal( rewritten, [
		"import { RenderTarget } from '/build/three.webgpu.js';",
		"import { Vector2 } from 'three/webgpu';",
	].join( '\n' ) );

} );

test( 'r185 Gaussian compatibility merges with an existing direct full import', () => {

	const source = [
		"import { NodeMaterial } from '/build/three.webgpu.js';",
		"import { RenderTarget, NodeMaterial, Vector2 } from 'three/webgpu';",
	].join( '\n' );
	const rewritten = rewriteR185AddonCompatibility( source, {
		...OPTIONS,
		relativePath: 'tsl/display/GaussianBlurNode.js',
	} );

	assert.equal( rewritten, [
		"import { NodeMaterial, RenderTarget } from '/build/three.webgpu.js';",
		"import { Vector2 } from 'three/webgpu';",
	].join( '\n' ) );
	assert.equal( ( rewritten.match( /\bNodeMaterial\b/g ) || [] ).length, 1 );
	assert.equal( ( rewritten.match( /\bRenderTarget\b/g ) || [] ).length, 1 );

	const alreadyDirect = [
		"import { NodeMaterial, RenderTarget } from '/build/three.webgpu.js';",
		"import { RenderTarget, NodeMaterial, Vector2 } from 'three/webgpu';",
	].join( '\n' );
	assert.equal( rewriteR185AddonCompatibility( alreadyDirect, {
		...OPTIONS,
		relativePath: 'tsl/display/GaussianBlurNode.js',
	} ), [
		"import { NodeMaterial, RenderTarget } from '/build/three.webgpu.js';",
		"import { Vector2 } from 'three/webgpu';",
	].join( '\n' ), 'already-direct bindings are not duplicated' );

	const directOnly = "import { NodeMaterial, RenderTarget } from '/build/three.webgpu.js';";
	assert.equal( rewriteR185AddonCompatibility( directOnly, {
		...OPTIONS,
		relativePath: 'tsl/display/GaussianBlurNode.js',
	} ), directOnly, 'a completed direct import is unchanged' );

} );

test( 'r185 Gaussian compatibility preserves aliased bindings', () => {

	const source = "import { RenderTarget as EffectTarget, NodeMaterial as EffectMaterial, Vector2 } from 'three/webgpu';";
	const rewritten = rewriteR185AddonCompatibility( source, {
		...OPTIONS,
		relativePath: 'tsl/display/GaussianBlurNode.js',
	} );

	assert.equal( rewritten, [
		"import { RenderTarget as EffectTarget, NodeMaterial as EffectMaterial } from '/build/three.webgpu.js';",
		"import { Vector2 } from 'three/webgpu';",
	].join( '\n' ) );

} );

test( 'r185 Gaussian import routing leaves unrelated addons and versions unchanged', () => {

	const source = "import { RenderTarget, NodeMaterial, Vector2 } from 'three/webgpu';";
	assert.equal( rewriteR185AddonCompatibility( source, {
		...OPTIONS,
		relativePath: 'tsl/display/OtherNode.js',
	} ), source );
	assert.equal( rewriteR185AddonCompatibility( source, {
		relativePath: 'tsl/display/GaussianBlurNode.js',
		threeVersion: '0.186.0',
	} ), source );
	assert.equal( rewriteR185AddonCompatibility( source, {
		relativePath: 'loaders/GaussianBlurNode.js',
		threeVersion: '0.185.1',
	} ), source );

} );

test( 'r185 addon compatibility is version and path gated', () => {

	const source = "material.fragmentNode = fn().context( builder.getSharedContext() );";
	assert.equal( rewriteR185AddonCompatibility( source, {
		relativePath: 'tsl/display/TestNode.js',
		threeVersion: '0.186.0',
	} ), source );
	assert.equal( rewriteR185AddonCompatibility( source, {
		relativePath: 'loaders/TestLoader.js',
		threeVersion: '0.185.1',
	} ), source );

} );
