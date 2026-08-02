import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';
import tslPrecompile from 'vite-plugin-tsl-precompile';

import { createShowcaseRouteRecord } from './src/route-manifest.js';

const ROOT = fileURLToPath( new URL( '.', import.meta.url ) );
const routeInputs = createShowcaseRouteRecord(
	name => resolve( ROOT, `${ name }.html` ),
	'Vite showcase build route inputs',
);

export default defineConfig( {
	base: './',
	plugins: [
		tslPrecompile( {
			artifactsDir: './artifacts',
			// Route-specific semantic markers live in src/markers.js.
			autoMark: false,
			slim: 'source',
		} ),
	],
	server: {
		host: '127.0.0.1',
		port: 5192,
		open: '/race.html',
	},
	build: {
		target: 'esnext',
		rollupOptions: {
			input: {
				index: resolve( ROOT, 'index.html' ),
				...routeInputs,
			},
		},
	},
	optimizeDeps: {
		include: [ 'three', 'three/webgpu', 'three/tsl' ],
	},
} );
