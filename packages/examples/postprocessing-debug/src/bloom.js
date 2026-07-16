import { runPostProcessingDebugExample } from './shared.js';
import { markStandardMaterials } from './standard-materials.js';

runPostProcessingDebugExample( {
	effect: 'bloom',
	title: 'Bloom — scenePassColor.add( bloom(...) )',
	markMaterials: markStandardMaterials,
} );
