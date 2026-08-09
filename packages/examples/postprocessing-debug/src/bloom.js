import { runPostProcessingDebugExample } from './shared.js';
import { runLiveRouteSetup } from './site-status.js';
import { markStandardMaterials } from './standard-materials.js';

runLiveRouteSetup( () => runPostProcessingDebugExample( {
	effect: 'bloom',
	title: 'Bloom — scenePassColor.add( bloom(...) )',
	markMaterials: markStandardMaterials,
} ) );
