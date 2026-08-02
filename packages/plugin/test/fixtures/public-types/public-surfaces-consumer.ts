import {
	__TSLP_SLIM__ as PREBUILT_SLIM,
	Scene as PrebuiltSlimScene,
	findAux as findPrebuiltAux,
	listAux as listPrebuiltAux,
} from '@tsl-precompile/runtime/slim';
import {
	__TSLP_SLIM__ as SOURCE_SLIM,
	Scene as SourceSlimScene,
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
const compileOptions: CompileTSLOptions = { noGlobalMRT: true };
const updater = emitUpdaterSource( { uniformPlan: [] } );
const shape: string = classifyMaterialShape( null );
declare const artifact: PrecompiledArtifact;

void tslPrecompile( { slim: 'source' } );
void [
	prebuiltFlag,
	sourceFlag,
	sourceScene,
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
