/**
 * PMREMGenerator compatibility shell for the precompiled slim bundle.
 *
 * Three's implementation creates several NodeMaterials at runtime. Those
 * materials require the compiler that slim deliberately removes, so shipping
 * the implementation only adds dead compiler/runtime graph and fails later.
 * Keep construction available for wrappers and full-renderer adapters, but
 * fail at the first operation with the supported migration path.
 */

const MESSAGE = '[tsl-precompile/slim] PMREMGenerator is excluded because it creates NodeMaterials at runtime. Generate PMREM with the full three/webgpu fallback and wire it through createSlimSceneSupport({ pmremGenerator }), or use the full renderer build.';

function unsupported() {

	const error = new Error( MESSAGE );
	error.tslPrecompileSlimOnly = true;
	throw error;

}

export default class PMREMGenerator {

	constructor( renderer ) {

		this._renderer = renderer;

	}

	fromScene() { return unsupported(); }
	fromEquirectangular() { return unsupported(); }
	fromCubemap() { return unsupported(); }
	fromTexture() { return unsupported(); }

	async fromSceneAsync() { return unsupported(); }
	async fromEquirectangularAsync() { return unsupported(); }
	async fromCubemapAsync() { return unsupported(); }

	async compileCubemapShader() { return unsupported(); }
	async compileEquirectangularShader() { return unsupported(); }

	dispose() {}

}
