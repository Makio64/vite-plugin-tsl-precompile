/**
 * Mock WebGPU device for the Node harness.
 *
 * Goal: implement enough of the WebGPU API surface that three.js's
 * WebGPUBackend can walk a scene through `compileAsync`, generate WGSL,
 * and populate `renderer._nodes.nodeBuilderCache` — without submitting
 * any real GPU work.
 *
 * What we capture:
 *   - device.createShaderModule({ code })  → stores the WGSL string.
 *   - device.createRenderPipeline / createComputePipeline  → stores descriptor.
 *   - device.createBindGroupLayout / createBindGroup        → stores layout.
 *
 * What we no-op:
 *   - queue.submit, writeBuffer, copyBufferToBuffer, map operations.
 *   - encoder.begin{Render,Compute}Pass → returns a pass that records drawIndexed etc. as no-ops.
 *
 * What is NOT supported (phase 5/6 work):
 *   - Feature flags (float32-filterable, depth32float-stencil8, etc.).
 *     Real three.js probes for these on init; the mock returns a static
 *     feature set meant to match "WebGPU on desktop Chrome".
 *   - Readback (mapReadAsync). If a scene does readback, the harness
 *     returns zeros. Flag such scenes for real-browser re-render in CI.
 *
 * Usage:
 *   import { createMockGPU } from './mock-webgpu.js';
 *   globalThis.navigator = { gpu: createMockGPU() };
 *   globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
 *
 * @module MockWebGPU
 */

let nextId = 1;
const nextResourceId = () => '#gpu' + ( nextId ++ );

// --- resource shells ----------------------------------------------------

function makeShaderModule( descriptor ) {

	return {
		__id: nextResourceId(),
		__kind: 'ShaderModule',
		__code: descriptor && typeof descriptor.code === 'string' ? descriptor.code : '',
		label: descriptor && descriptor.label ? descriptor.label : null,
		getCompilationInfo: async () => ( { messages: [] } ),
	};

}

function makeBindGroupLayout( descriptor ) {

	return {
		__id: nextResourceId(),
		__kind: 'BindGroupLayout',
		__entries: Array.isArray( descriptor && descriptor.entries ) ? descriptor.entries.slice() : [],
		label: descriptor && descriptor.label ? descriptor.label : null,
	};

}

function makeBindGroup( descriptor ) {

	return {
		__id: nextResourceId(),
		__kind: 'BindGroup',
		__layout: descriptor && descriptor.layout ? descriptor.layout : null,
		__entries: Array.isArray( descriptor && descriptor.entries ) ? descriptor.entries.slice() : [],
	};

}

function makePipelineLayout( descriptor ) {

	return {
		__id: nextResourceId(),
		__kind: 'PipelineLayout',
		__bindGroupLayouts: Array.isArray( descriptor && descriptor.bindGroupLayouts ) ? descriptor.bindGroupLayouts.slice() : [],
	};

}

function makeBuffer( descriptor ) {

	const size = descriptor && typeof descriptor.size === 'number' ? descriptor.size : 0;
	const usage = descriptor && typeof descriptor.usage === 'number' ? descriptor.usage : 0;
	const mapAtCreation = !! ( descriptor && descriptor.mappedAtCreation );
	const storage = new ArrayBuffer( size );
	let mapped = mapAtCreation;

	return {
		__id: nextResourceId(),
		__kind: 'Buffer',
		size,
		usage,
		label: descriptor && descriptor.label ? descriptor.label : null,
		getMappedRange: () => storage,
		unmap: () => { mapped = false; },
		mapAsync: async () => { mapped = true; },
		destroy: () => {},
		__storage: storage,
		get __mapped() { return mapped; },
	};

}

function makeTexture( descriptor ) {

	return {
		__id: nextResourceId(),
		__kind: 'Texture',
		__descriptor: descriptor || {},
		createView: ( viewDescriptor ) => ( {
			__id: nextResourceId(),
			__kind: 'TextureView',
			__descriptor: viewDescriptor || {},
		} ),
		destroy: () => {},
	};

}

function makeSampler( descriptor ) {

	return {
		__id: nextResourceId(),
		__kind: 'Sampler',
		__descriptor: descriptor || {},
	};

}

// --- pipelines ----------------------------------------------------------

function makeRenderPipeline( descriptor ) {

	return {
		__id: nextResourceId(),
		__kind: 'RenderPipeline',
		__descriptor: descriptor,
		__vertexCode: descriptor && descriptor.vertex && descriptor.vertex.module ? descriptor.vertex.module.__code : '',
		__fragmentCode: descriptor && descriptor.fragment && descriptor.fragment.module ? descriptor.fragment.module.__code : '',
		getBindGroupLayout: ( index ) => ( { __kind: 'BindGroupLayout', __inferred: true, __index: index } ),
	};

}

function makeComputePipeline( descriptor ) {

	return {
		__id: nextResourceId(),
		__kind: 'ComputePipeline',
		__descriptor: descriptor,
		__computeCode: descriptor && descriptor.compute && descriptor.compute.module ? descriptor.compute.module.__code : '',
		getBindGroupLayout: ( index ) => ( { __kind: 'BindGroupLayout', __inferred: true, __index: index } ),
	};

}

// --- command recording (all no-ops) -------------------------------------

function makeRenderPassEncoder() {

	const noop = () => {};
	return {
		setPipeline: noop, setBindGroup: noop, setVertexBuffer: noop, setIndexBuffer: noop,
		draw: noop, drawIndexed: noop, drawIndirect: noop, drawIndexedIndirect: noop,
		setViewport: noop, setScissorRect: noop, setStencilReference: noop, setBlendConstant: noop,
		pushDebugGroup: noop, popDebugGroup: noop, insertDebugMarker: noop,
		executeBundles: noop,
		end: noop,
	};

}

function makeComputePassEncoder() {

	const noop = () => {};
	return {
		setPipeline: noop, setBindGroup: noop,
		dispatchWorkgroups: noop, dispatchWorkgroupsIndirect: noop,
		pushDebugGroup: noop, popDebugGroup: noop, insertDebugMarker: noop,
		end: noop,
	};

}

function makeCommandEncoder() {

	return {
		beginRenderPass: () => makeRenderPassEncoder(),
		beginComputePass: () => makeComputePassEncoder(),
		copyBufferToBuffer: () => {},
		copyBufferToTexture: () => {},
		copyTextureToBuffer: () => {},
		copyTextureToTexture: () => {},
		clearBuffer: () => {},
		resolveQuerySet: () => {},
		pushDebugGroup: () => {}, popDebugGroup: () => {}, insertDebugMarker: () => {},
		finish: () => ( { __kind: 'CommandBuffer' } ),
	};

}

function makeQueue() {

	return {
		submit: () => {},
		writeBuffer: () => {},
		writeTexture: () => {},
		onSubmittedWorkDone: async () => {},
		copyExternalImageToTexture: () => {},
	};

}

// --- device -------------------------------------------------------------

function makeDevice() {

	const queue = makeQueue();

	const device = {
		__kind: 'Device',
		label: 'mock',
		features: new Set( [
			'depth32float-stencil8',
			'texture-compression-bc',
			'timestamp-query',
			'indirect-first-instance',
			'shader-f16',
			'rg11b10ufloat-renderable',
			'bgra8unorm-storage',
			'float32-filterable',
		] ),
		limits: {
			maxTextureDimension1D: 8192,
			maxTextureDimension2D: 8192,
			maxTextureDimension3D: 2048,
			maxTextureArrayLayers: 256,
			maxBindGroups: 4,
			maxBindingsPerBindGroup: 640,
			maxDynamicUniformBuffersPerPipelineLayout: 8,
			maxDynamicStorageBuffersPerPipelineLayout: 4,
			maxSampledTexturesPerShaderStage: 16,
			maxSamplersPerShaderStage: 16,
			maxStorageBuffersPerShaderStage: 8,
			maxStorageTexturesPerShaderStage: 4,
			maxUniformBuffersPerShaderStage: 12,
			maxUniformBufferBindingSize: 65536,
			maxStorageBufferBindingSize: 134217728,
			maxVertexBuffers: 8,
			maxVertexAttributes: 16,
			maxVertexBufferArrayStride: 2048,
			maxInterStageShaderVariables: 16,
			maxComputeWorkgroupStorageSize: 16384,
			maxComputeInvocationsPerWorkgroup: 256,
			maxComputeWorkgroupSizeX: 256,
			maxComputeWorkgroupSizeY: 256,
			maxComputeWorkgroupSizeZ: 64,
			maxComputeWorkgroupsPerDimension: 65535,
		},
		queue,
		createShaderModule: makeShaderModule,
		createBindGroupLayout: makeBindGroupLayout,
		createBindGroup: makeBindGroup,
		createPipelineLayout: makePipelineLayout,
		createBuffer: makeBuffer,
		createTexture: makeTexture,
		createSampler: makeSampler,
		createRenderPipeline: makeRenderPipeline,
		createRenderPipelineAsync: async ( d ) => makeRenderPipeline( d ),
		createComputePipeline: makeComputePipeline,
		createComputePipelineAsync: async ( d ) => makeComputePipeline( d ),
		createCommandEncoder: makeCommandEncoder,
		createQuerySet: () => ( { __kind: 'QuerySet' } ),
		destroy: () => {},
		pushErrorScope: () => {},
		popErrorScope: async () => null,
		importExternalTexture: () => ( { __kind: 'ExternalTexture' } ),
		lost: new Promise( () => {} ),
		onuncapturederror: null,
		addEventListener: () => {},
		removeEventListener: () => {},
	};

	return device;

}

function makeAdapter() {

	return {
		__kind: 'Adapter',
		features: new Set(),
		limits: {},
		info: { vendor: 'mock', architecture: 'mock', device: 'mock-node-harness', description: '' },
		isFallbackAdapter: false,
		requestDevice: async ( _descriptor ) => makeDevice(),
	};

}

/**
 * Produce a mock `navigator.gpu` object. Install it before initialising
 * the three.js WebGPU backend:
 *
 *   globalThis.navigator ??= {};
 *   globalThis.navigator.gpu = createMockGPU();
 *   globalThis.GPUShaderStage = GPUShaderStage;
 *   globalThis.GPUBufferUsage = GPUBufferUsage;
 *   globalThis.GPUTextureUsage = GPUTextureUsage;
 *
 * @return {{ requestAdapter: function }}
 */
export function createMockGPU() {

	return {
		requestAdapter: async ( _options ) => makeAdapter(),
		getPreferredCanvasFormat: () => 'bgra8unorm',
		wgslLanguageFeatures: new Set( [ 'readonly_and_readwrite_storage_textures', 'packed_4x8_integer_dot_product', 'pointer_composite_access' ] ),
	};

}

/**
 * WebGPU shader-stage bitmask. Three.js reads these off the global scope
 * during backend init, not through an import.
 */
export const GPUShaderStage = Object.freeze( { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 } );

export const GPUBufferUsage = Object.freeze( {
	MAP_READ: 0x0001, MAP_WRITE: 0x0002,
	COPY_SRC: 0x0004, COPY_DST: 0x0008,
	INDEX: 0x0010, VERTEX: 0x0020,
	UNIFORM: 0x0040, STORAGE: 0x0080,
	INDIRECT: 0x0100, QUERY_RESOLVE: 0x0200,
} );

export const GPUTextureUsage = Object.freeze( {
	COPY_SRC: 0x01, COPY_DST: 0x02,
	TEXTURE_BINDING: 0x04, STORAGE_BINDING: 0x08,
	RENDER_ATTACHMENT: 0x10,
} );

export const GPUMapMode = Object.freeze( { READ: 0x0001, WRITE: 0x0002 } );

export const GPUColorWrite = Object.freeze( {
	RED: 0x1, GREEN: 0x2, BLUE: 0x4, ALPHA: 0x8, ALL: 0xF,
} );

/**
 * Install the mock globals. Call once at the start of the Node harness
 * before importing `three/webgpu`.
 *
 * @param {Object} [globalTarget=globalThis]
 */
export function installMockWebGPU( globalTarget = globalThis ) {

	if ( ! globalTarget.navigator ) globalTarget.navigator = {};
	globalTarget.navigator.gpu = createMockGPU();
	globalTarget.GPUShaderStage = GPUShaderStage;
	globalTarget.GPUBufferUsage = GPUBufferUsage;
	globalTarget.GPUTextureUsage = GPUTextureUsage;
	globalTarget.GPUMapMode = GPUMapMode;
	globalTarget.GPUColorWrite = GPUColorWrite;

}
