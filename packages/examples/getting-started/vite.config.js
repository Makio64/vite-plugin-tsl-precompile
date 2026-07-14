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
		port: 5174,
		open: '/',
	},
	build: { target: 'esnext' },
	optimizeDeps: {
		// three's WebGPU entry pulls a lot of node-graph code via dynamic
		// imports; pre-bundling keeps first paint snappy and stops the slim
		// alias (if enabled) from racing the optimizer.
		include: [ 'three', 'three/webgpu', 'three/tsl' ],
	},
} );
