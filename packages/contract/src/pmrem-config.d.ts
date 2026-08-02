export const PMREM_LAYOUT_SCHEMA: 'pmrem-layout@1';
export const PMREM_SUPPORT_SCHEMA: 'pmrem-support@1';

export type PMREMSupportProfile = 'texture-equirect' | 'texture-cubemap' | 'scene';

export interface PMREMLayoutConfig {
	schema: typeof PMREM_LAYOUT_SCHEMA;
	cubeSize: number;
	lodMax: number;
	target: {
		width: number;
		height: number;
	};
}

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
	};

export interface PMREMConfigValidationIssue {
	code: string;
	path: string;
	message: string;
}

export const PMREM_PROFILE_STAGE_REQUIREMENTS: Readonly<Record<PMREMSupportProfile, readonly string[]>>;
export const PMREM_SUPPORT_PROFILES: readonly PMREMSupportProfile[];

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
	options?: PMREMSourceTopologyOptions,
): PMREMSupportConfig;
export function pmremRequiredStages( profile: string ): string[];
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
