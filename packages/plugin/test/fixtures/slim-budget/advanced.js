import {
	DataTexture,
	Mesh,
	PerspectiveCamera,
	PlaneGeometry,
	PostProcessing,
	PrecompiledComputeNode,
	PrecompiledMaterial,
	RenderPipeline,
	RenderTarget,
	Scene,
	setSlimRenderFallback,
	StorageBufferAttribute,
	WebGPURenderer,
} from 'three/webgpu';
import { Color, Vector3 } from 'three';

globalThis.__tslpSlimBudgetAdvanced = [
	WebGPURenderer,
	Scene,
	PerspectiveCamera,
	Mesh,
	PlaneGeometry,
	PrecompiledMaterial,
	PrecompiledComputeNode,
	RenderTarget,
	PostProcessing,
	RenderPipeline,
	StorageBufferAttribute,
	DataTexture,
	setSlimRenderFallback,
	Color,
	Vector3,
];
