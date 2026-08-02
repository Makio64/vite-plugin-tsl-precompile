import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import tslPrecompile from 'vite-plugin-tsl-precompile';

const wrapperRoot = dirname( fileURLToPath( import.meta.url ) );
const implementationRoot = resolve( wrapperRoot, '../compute-debug' );

function canonicalPrecompilePlugin() {

	const plugin = tslPrecompile( {
		artifactsDir: './artifacts',
		slim: 'source',
	} );
	const configResolved = plugin.configResolved;

	return {
		...plugin,
		// The wrapper owns its HTML/build output, while marker identities and
		// artifacts remain owned by the canonical implementation.
		configResolved( config ) {

			return configResolved.call( this, {
				...config,
				root: implementationRoot,
			} );

		},
	};

}

export default defineConfig( {
	base: './',
	plugins: [ canonicalPrecompilePlugin() ],
	server: {
		port: 5177,
		open: '/',
	},
	optimizeDeps: {
		include: [ 'three', 'three/webgpu', 'three/tsl' ],
	},
} );
