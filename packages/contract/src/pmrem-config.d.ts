export const PMREM_LAYOUT_SCHEMA: 'pmrem-layout@1';
export const PMREM_SUPPORT_SCHEMA: 'pmrem-support@1';
export const PMREM_CUBE_UV_MAPPING: 306;
export const PMREM_UNIFORM_SLOT_KINDS: readonly string[];
export const PMREM_CUBE_LAYOUT_SCHEMA: 'pmrem-cube-layout@1';
export const PMREM_CUBE_KERNEL: Readonly<{ minSize: 256; minMipSize: 8; ggxSamples: 256; integrationSize: 16; integrationLevels: 3 }>;
export const PMREM_CUBE_UNIFORM_BINDING_ROLES: Readonly<Record<'blur' | 'ggx' | 'integration', Readonly<Record<string, string>>>>;
export interface PMREMSphericalGaussianBlurConfig {
	algorithm: 'spherical-gaussian';
	samples: 20;
}
export const PMREM_SPHERICAL_GAUSSIAN_BLUR: Readonly<PMREMSphericalGaussianBlurConfig>;

export type PMREMSupportProfile = 'texture-equirect' | 'texture-cubemap' | 'scene';

export interface PMREMAtlasLayoutConfig {
	schema: typeof PMREM_LAYOUT_SCHEMA;
	cubeSize: number;
	lodMax: number;
	target: {
		width: number;
		height: number;
	};
}
export interface PMREMCubeLayoutConfig extends Omit<PMREMAtlasLayoutConfig, 'schema'> {
	schema: typeof PMREM_CUBE_LAYOUT_SCHEMA;
}
export type PMREMLayoutConfig = PMREMAtlasLayoutConfig | PMREMCubeLayoutConfig;

export interface PMREMSourceTopology {
	kind: 'cubemap' | 'equirect';
	dimension: 'cube' | '2d';
	componentType: 'f32' | 'i32' | 'u32';
	sampleType: 'float' | 'unfilterable-float' | 'sint' | 'uint';
	samplingMode: 'sample-implicit' | 'sample-level' | 'manual-linear' | 'load';
	samplerType: 'filtering' | 'none';
	wrapS: 'repeat' | 'clamp' | 'mirror' | null;
	wrapT: 'repeat' | 'clamp' | 'mirror' | null;
	float32Filterable: boolean | null;
	samples: 1;
}

export interface PMREMSourceTopologyOptions {
	renderer?: {
		hasFeature?: ( name: string ) => boolean;
		backend?: {
			utils?: {
				getTextureSampleData?: ( texture: object ) => { primarySamples?: number };
			};
		};
	};
	float32Filterable?: boolean;
	primarySamples?: number;
}

export interface PMREMSupportConfigOptions extends PMREMSourceTopologyOptions {
	blur?: PMREMSphericalGaussianBlurConfig;
}

export type PMREMSupportConfig =
	| {
		schema: typeof PMREM_SUPPORT_SCHEMA;
		profile: 'texture-equirect' | 'texture-cubemap';
		layout: PMREMLayoutConfig;
		source: PMREMSourceTopology;
	}
	| {
		schema: typeof PMREM_SUPPORT_SCHEMA;
		profile: 'scene';
		layout: PMREMLayoutConfig;
		blur?: PMREMSphericalGaussianBlurConfig;
	};

export interface PMREMConfigValidationIssue {
	code: string;
	path: string;
	message: string;
}

export const PMREM_PROFILE_STAGE_REQUIREMENTS: Readonly<Record<PMREMSupportProfile, readonly string[]>>;
export const PMREM_SUPPORT_PROFILES: readonly PMREMSupportProfile[];

export function assertPMREMAtlasCaptureSupport( generator: object | null, renderTarget?: object | null ): void;
export function createPMREMLayoutConfig( cubeSize: number ): PMREMLayoutConfig;
export function pmremProfileForSource( texture: object ): Exclude<PMREMSupportProfile, 'scene'>;
export function createPMREMSourceTopology(
	texture: object,
	profile?: Exclude<PMREMSupportProfile, 'scene'>,
	options?: PMREMSourceTopologyOptions,
): PMREMSourceTopology;
export function createPMREMSupportConfig(
	layout: PMREMLayoutConfig,
	profile: PMREMSupportProfile,
	sourceTexture?: object | null,
	options?: PMREMSupportConfigOptions,
): PMREMSupportConfig;
export function getPMREMBlurConfig( config: PMREMSupportConfig ): Readonly<PMREMSphericalGaussianBlurConfig | { algorithm: 'weighted-separable'; samples: 20 }>;
export function pmremRequiredStages( profile: string, config?: PMREMSupportConfig | null ): string[];
export function createPMREMCubeLayoutConfig( cubeSize: number ): PMREMCubeLayoutConfig;
export function createPMREMCubeCaptureLayout( generator: object, target: object, revision: string ): PMREMCubeLayoutConfig;
export function assertPMREMCubeCaptureGenerator( generator: object, revision: string ): void;
export function isPMREMCubeLayout( layout: unknown ): layout is PMREMCubeLayoutConfig;
export function validatePMREMCubeLayoutConfig( value: unknown, path?: string ): PMREMConfigValidationIssue[];
export function createPMREMSourceTopologyKey(
	texture: object,
	profile?: Exclude<PMREMSupportProfile, 'scene'>,
	options?: PMREMSourceTopologyOptions,
): string;
export function pmremSourceInputTopology( source: PMREMSourceTopology | null | undefined ): Record<string, unknown> | null;
export function validatePMREMLayoutConfig( value: unknown, path?: string ): PMREMConfigValidationIssue[];
export function validatePMREMSupportConfig( value: unknown, path?: string ): PMREMConfigValidationIssue[];
export function validatePMREMSourceTopology(
	value: unknown,
	profile: string,
	path?: string,
): PMREMConfigValidationIssue[];
export function samePMREMConfig( left: unknown, right: unknown ): boolean;
