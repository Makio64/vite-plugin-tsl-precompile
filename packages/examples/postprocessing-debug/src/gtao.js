import { runPostProcessingDebugExample } from './shared.js';
import { markGtaoMaterials } from './gtao-materials.js';

runPostProcessingDebugExample( {
	effect: 'gtao',
	title: 'GTAO — MRT pass + ao(depth, normal, camera)',
	markMaterials: markGtaoMaterials,
} );
