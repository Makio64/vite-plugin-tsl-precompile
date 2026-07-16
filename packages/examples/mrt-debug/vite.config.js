import { defineConfig } from 'vite';
import tslPrecompile from 'vite-plugin-tsl-precompile';

export default defineConfig( {
	plugins: [
		tslPrecompile( {
			artifactsDir: './artifacts',
			slim: 'source',
		} ),
	],
	server: {
		port: 5187,
		open: '/',
	},
	build: {
		rollupOptions: {
			input: {
				index: 'index.html',
				pass: 'pass.html',
				mask: 'mask.html',
				manual: 'manual.html',
			},
		},
	},
	optimizeDeps: {
		include: [ 'three', 'three/webgpu', 'three/tsl' ],
	},
} );
