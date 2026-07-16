import { runPostProcessingDebugExample } from './shared.js';
import { markStandardMaterials } from './standard-materials.js';

runPostProcessingDebugExample( {
	effect: 'passthrough',
	title: 'Passthrough — pass(scene, camera) → screen',
	markMaterials: markStandardMaterials,
} );
