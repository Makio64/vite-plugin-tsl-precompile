import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import * as runtime from '../src/index.js';

test( 'public declarations track the runtime signatures that previously drifted', async () => {

	const [ declaration, runtimeIndex, sceneSupportDeclaration ] = await Promise.all( [
		readFile( new URL( '../types/index.d.ts', import.meta.url ), 'utf8' ),
		readFile( new URL( '../src/index.js', import.meta.url ), 'utf8' ),
		readFile( new URL( '../types/slim-support/scene-support.d.ts', import.meta.url ), 'utf8' ),
	] );
	const source = declaration.replace( /\s+/g, ' ' );
	const sceneSupportSource = sceneSupportDeclaration.replace( /\s+/g, ' ' );
	const declaredValues = new Set(
		[ ...declaration.matchAll( /export\s+(?:declare\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+(\w+)/g ) ]
			.map( ( match ) => match[ 1 ] )
	);
	const explicitlyExportedValues = new Set();
	for ( const match of runtimeIndex.matchAll( /export\s*\{([^}]+)\}/gs ) ) {

		for ( const rawEntry of match[ 1 ].split( ',' ) ) {

			const entry = rawEntry.trim();
			if ( ! entry ) continue;
			const parsed = entry.match( /(?:default\s+as\s+)?(\w+)(?:\s+as\s+(\w+))?/ );
			if ( parsed ) explicitlyExportedValues.add( parsed[ 2 ] || parsed[ 1 ] );

		}

	}
	assert.deepEqual(
		[ ...explicitlyExportedValues ].filter( ( name ) => ! declaredValues.has( name ) ).sort(),
		[],
		'every explicitly re-exported runtime value needs a root declaration',
	);
	const expectedRuntimeExports = [
		'listUserArtifacts',
		'registerPrecompiledArtifact',
		'registerPrecompiledArtifacts',
		'hashNodeGraph',
		'hashNodeGraphSync',
		'hashPlainConfigSync',
		'hashMaterialSync',
		'hashArtifactContentSync',
		'registerAuxArtifact',
		'findAux',
		'bindAuxConfig',
		'bindAuxByName',
		'hydrateNodeBuilderState',
		'pingPongInvalidate',
		'shareInstancedAttributeBufferIntoSlim',
		'loadInspectorOptional',
		'createMaterialVariants',
		'applyMaterialVariant',
	];
	for ( const name of expectedRuntimeExports ) assert.equal( typeof runtime[ name ], 'function', `${ name } must remain a runtime export` );

	assert.match( source, /precompile\( name: string, context\?: PrecompileCaptureContext \): this;/ );
	assert.match( source, /listUserArtifacts<TArtifactModule = unknown>\(\): UserArtifactEntry<TArtifactModule>\[\];/ );
	assert.match( source, /registerPrecompiledArtifact\( artifact: unknown, opts\?: PrecompiledArtifactRegistrationOptions \): void;/ );
	assert.match( source, /registerPrecompiledArtifacts\( artifacts: unknown\[\] \): void;/ );

	assert.match( source, /hashNodeGraph\( graph: unknown, opts: HashVersionOptions \): Promise<string>;/ );
	assert.match( source, /hashNodeGraphSync\( graph: unknown, opts: HashVersionOptions \): string;/ );
	assert.match( source, /hashPlainConfigSync\( config: unknown, opts: HashVersionOptions \): string;/ );
	assert.match( source, /hashMaterialSync\( material: unknown, opts: MaterialHashOptions \): string;/ );
	assert.match( source, /hashArtifactContentSync\( artifact: unknown, opts: HashVersionOptions \): string;/ );
	assert.match( source, /cubeRenderTargetOptions\?: Record<string, unknown>;/ );

	assert.match( source, /registerAuxArtifact<TArtifact = unknown>\( shape: string, configHash: string, artifact: TArtifact, opts\?: \{ name\?: string; threeVersion\?: string; pluginVersion\?: string \} \): void;/ );
	assert.match( source, /findAux<TArtifact = unknown>\( shape: string, nameOrConfigHash: string \): AuxArtifactEntry<TArtifact> \| null;/ );
	assert.match( source, /bindAuxConfig<TNode = unknown>\( node: TNode, shapeOrEntry:/ );
	assert.match( source, /bindAuxByName<TNode = unknown>\( node: TNode, shape: string, nameOrConfigHash: string \): TNode;/ );

	assert.match( source, /hydrateNodeBuilderState\( artifact: unknown, material\?: unknown, object\?: unknown, variantSelection\?: number \| string \| HydrateVariantSelection \| null, \): unknown;/ );
	assert.match( source, /renderContextSelectorProfile\?: 'background' \| 'shadow-depth' \| 'post-process' \| 'render-output' \| 'cube-render-target' \| 'mesh-basic' \| null;/ );
	assert.match( source, /interface SlimRenderFallbackHandler \{ \( renderObject: unknown \): unknown \| null; release\?\( renderObject: unknown \): void; \}/ );
	assert.match( source, /class MaterialVariantSet<TMaterial = unknown>/ );
	assert.match( source, /createMaterialVariants<TMaterial = unknown>\( variants: MaterialVariantInput<TMaterial>, initialName\?: string \): MaterialVariantSet<TMaterial>;/ );
	assert.match( source, /applyMaterialVariant<TMaterial = unknown>\( target: unknown \| unknown\[\], material: TMaterial \): TMaterial;/ );
	assert.match( source, /createSlimSceneSupport\( opts: import\('\.\/slim-support\/scene-support\.d\.ts'\)\.SlimSceneSupportOptions \):/ );
	assert.match( sceneSupportSource, /export interface SlimSceneSupportOptions \{/ );
	assert.match( sceneSupportSource, /renderer: object;/ );
	assert.match( sceneSupportSource, /fullRendererFallback\?: boolean \| 'auto';/ );
	assert.match( sceneSupportSource, /createSlimSceneSupport\( opts: SlimSceneSupportOptions \):/ );

} );
