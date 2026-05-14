import { defineConfig } from 'vite';
import tslPrecompile from 'vite-plugin-tsl-precompile';

export default defineConfig( {
	plugins: [
		tslPrecompile( {
			artifactsDir: './artifacts',
		} ),
	],
	server: {
		port: 5176,
		open: '/',
	},
	build: { target: 'esnext' },
	optimizeDeps: {
		include: [ 'three', 'three/webgpu', 'three/tsl' ],
	},
} );
