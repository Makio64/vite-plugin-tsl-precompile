import { runPostProcessingDebugExample } from './shared.js';
import { runLiveRouteSetup } from './site-status.js';
import { markStandardMaterials } from './standard-materials.js';

runLiveRouteSetup( () => runPostProcessingDebugExample( {
	effect: 'passthrough',
	title: 'Passthrough — pass(scene, camera) → screen',
	markMaterials: markStandardMaterials,
} ) );
