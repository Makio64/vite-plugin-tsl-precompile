import { defineConfig } from 'vite';
import tslPrecompile from 'vite-plugin-tsl-precompile';

export default defineConfig( {
	plugins: [
		tslPrecompile( {
			artifactsDir: './artifacts',
		} ),
	],
	server: {
		port: 5173,
		open: '/',
	},
	optimizeDeps: {
		// three's WebGPU entry pulls a lot of node-graph code via dynamic
		// imports — force pre-bundling so first paint isn't blocked.
		include: [ 'three', 'three/webgpu', 'three/tsl' ],
		// Inspector addon uses `new URL('../extensions/extensions.json', import.meta.url)`;
		// pre-bundling rewrites import.meta.url and the fetch falls through to
		// Vite's SPA fallback (HTML), triggering a JSON parse error.
		exclude: [ 'three/addons/inspector/Inspector.js' ],
	},
} );
