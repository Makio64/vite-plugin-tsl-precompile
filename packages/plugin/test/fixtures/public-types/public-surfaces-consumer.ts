import {
	__TSLP_SLIM__ as PREBUILT_SLIM,
	Scene as PrebuiltSlimScene,
	TextureSource as PrebuiltTextureSource,
	findAux as findPrebuiltAux,
	listAux as listPrebuiltAux,
} from '@tsl-precompile/runtime/slim';
import {
	__TSLP_SLIM__ as SOURCE_SLIM,
	Scene as SourceSlimScene,
	TextureSource as SourceTextureSource,
	findAux as findSourceAux,
	listAux as listSourceAux,
} from '@tsl-precompile/runtime/slim/source';
import {
	TSL,
	atan2,
	viewportTopLeft,
} from '@tsl-precompile/runtime/slim-stubs';
import {
	findAux as findSlimAux,
	listAux as listSlimAux,
} from '@tsl-precompile/runtime/slim-support';
import tslPrecompile from 'vite-plugin-tsl-precompile';
import { DEV_CAPTURE_MAX_BODY_BYTES, readCaptureBody } from 'vite-plugin-tsl-precompile/build/capture-request';
const captureBodyReader: ( request: import( 'node:http' ).IncomingMessage, maxBytes?: number ) => Promise<string> = readCaptureBody;
void [ DEV_CAPTURE_MAX_BODY_BYTES, captureBodyReader ];
// @ts-expect-error diagnostics formatting is intentionally internal, not package API.
import { formatBlockedKindWarnings } from 'vite-plugin-tsl-precompile';
import {
	DOCUMENTED_BLOCKED_KINDS,
	emitUpdaterSource,
} from 'vite-plugin-tsl-precompile/src/emit-updater.js';
import {
	classifyMaterialShape,
	type CompileTSLOptions,
	type PrecompiledArtifact,
} from 'vite-plugin-tsl-precompile/src/vendor/compileTSL.js';

const prebuiltFlag: true = PREBUILT_SLIM;
const sourceFlag: true = SOURCE_SLIM;
const sourceScene: typeof PrebuiltSlimScene = SourceSlimScene;
const sourceTexture: typeof PrebuiltTextureSource = SourceTextureSource;
const compileOptions: CompileTSLOptions = { noGlobalMRT: true };
const updater = emitUpdaterSource( { uniformPlan: [] } );
const shape: string = classifyMaterialShape( null );
declare const artifact: PrecompiledArtifact;

void tslPrecompile( { slim: 'source' } );
void [
	prebuiltFlag,
	sourceFlag,
	sourceScene,
	sourceTexture,
	compileOptions,
	updater,
	formatBlockedKindWarnings,
	shape,
	artifact,
	TSL,
	atan2,
	viewportTopLeft,
	DOCUMENTED_BLOCKED_KINDS,
	findSlimAux,
	listSlimAux,
	findPrebuiltAux,
	listPrebuiltAux,
	findSourceAux,
	listSourceAux,
];

// Narrow support entries expose owned cloning and synchronous swap transactions.
import * as Three from 'three';
import { cloneSceneForPMREM } from '@tsl-precompile/runtime/slim-support/pmrem';
import { withMappedSceneMaterials } from '@tsl-precompile/runtime/slim-support/pass-render-fallback';
const pmremScene = cloneSceneForPMREM( new Three.Scene(), Three );
pmremScene?.dispose();
const renderValue: number = withMappedSceneMaterials( pmremScene, () => 42, ( material, context ) => {
	const isOverride: boolean = context.override;
	void isOverride;
	return material;
} );
void renderValue;
