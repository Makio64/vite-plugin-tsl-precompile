export const VSM_SUPPORT_SCHEMA: 'shadow-vsm-support@1';
export const VSM_SUPPORT_PROFILE: '2d';
export const VSM_REQUIRED_STAGES: readonly [ 'vertical', 'horizontal' ];

export interface VSMSourceTopology {
	dimension: '2d';
	sampleType: 'depth' | 'unfilterable-float';
	samplingMode: 'load';
	samplerType: 'none';
	samples: 1;
	depth: true;
	comparison: false;
}

export interface VSMMomentsTopology {
	dimension: '2d';
	format: 1030;
	type: 1016;
	sampleType: 'float';
	samplingMode: 'sample-implicit';
	samplerType: 'filtering';
	samples: 1;
	depth: false;
	comparison: false;
}

export interface VSMSupportConfig {
	schema: typeof VSM_SUPPORT_SCHEMA;
	profile: typeof VSM_SUPPORT_PROFILE;
	source: VSMSourceTopology;
	moments: VSMMomentsTopology;
}

export interface VSMConfigValidationIssue {
	code: string;
	path: string;
	message: string;
}

export function createVSMSupportConfig( options?: {
	compatibilityMode?: boolean;
	renderer?: { backend?: { compatibilityMode?: boolean } };
} ): VSMSupportConfig;
export function vsmRequiredStages(): string[];
export function vsmSourceInputTopology( config: VSMSupportConfig | null | undefined ): VSMSourceTopology | null;
export function vsmMomentsTopology( config: VSMSupportConfig | null | undefined ): VSMMomentsTopology | null;
export function validateVSMSupportConfig( value: unknown, path?: string ): VSMConfigValidationIssue[];
export function sameVSMConfig( left: unknown, right: unknown ): boolean;
