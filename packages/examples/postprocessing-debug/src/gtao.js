import { runPostProcessingDebugExample } from './shared.js';
import { runLiveRouteSetup } from './site-status.js';
import { markGtaoMaterials } from './gtao-materials.js';

runLiveRouteSetup( () => runPostProcessingDebugExample( {
	effect: 'gtao',
	title: 'GTAO — MRT pass + ao(depth, normal, camera)',
	markMaterials: markGtaoMaterials,
} ) );
