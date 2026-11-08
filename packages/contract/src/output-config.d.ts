export type OutputTopologyScalar = string | number | boolean | null;

export interface RendererOutputConfig {
	schema: 'renderer-output@1';
	toneMapping: OutputTopologyScalar;
	currentColorSpace: OutputTopologyScalar;
	logarithmicDepthBuffer: boolean;
	sampledTexture: '2d' | '2d-array';
	sampledTextureDataType?: Exclude<OutputTopologyScalar, null>;
	multiview: boolean;
}

export interface RenderPipelineConfig {
	schema: 'render-pipeline@1';
	outputNode: unknown;
	outputColorTransform: boolean;
	toneMapping: OutputTopologyScalar;
	outputColorSpace: OutputTopologyScalar;
	logarithmicDepthBuffer?: true;
	reversedDepthBuffer?: true;
}

export function createRendererOutputConfig( renderer: unknown, outputTexture: unknown ): RendererOutputConfig;
export function createRenderPipelineConfig( pipeline: unknown ): RenderPipelineConfig;

export function createEffectPassCaptureName( pipelineName: string | null | undefined, handlerName: string, effectIndex: number, passIndex: number ): string | null;
