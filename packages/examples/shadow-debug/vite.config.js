import { defineConfig } from 'vite';
import tslPrecompile from 'vite-plugin-tsl-precompile';

export default defineConfig( {
	plugins: [
		tslPrecompile( {
			artifactsDir: './artifacts',
			// This fixture owns explicit light/topology-specific marker families.
			autoMark: false,
			slim: 'source',
		} ),
	],
	server: {
		port: 5183,
		open: '/',
	},
	build: {
		rollupOptions: {
			input: {
				index: 'index.html',
				directional: 'directional.html',
				spot: 'spot.html',
				point: 'point.html',
				vsm: 'vsm.html',
			},
		},
	},
	optimizeDeps: {
		include: [ 'three', 'three/webgpu', 'three/tsl' ],
	},
} );
