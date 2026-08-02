export const MAX_GRAPH_DEPTH: 128;

export interface MaterialRegistrationDescriptor {
	type: string;
	properties?: readonly string[];
	nodeProperties?: readonly string[];
}

export interface MaterialSourceHashOptions {
	name: string;
	threeVersion: string;
	pluginVersion?: string;
	toolchainVersion?: string;
}

export function registerMaterial(
	MaterialCtor: abstract new ( ...args: never[] ) => object,
	descriptor: MaterialRegistrationDescriptor,
): string;
export function unregisterMaterial(
	MaterialCtor: abstract new ( ...args: never[] ) => object,
): boolean;
export function materialIdentity( material: unknown ): string;
export function normalizeMaterialGraph( material: unknown ): string;
export function createMaterialSourceHashPayload(
	material: unknown,
	options: MaterialSourceHashOptions,
): string;
export function normalizeRenderContextSignature( signature: unknown ): string;
export function normalizeNode(
	node: unknown,
	seen?: Set<unknown>,
	depth?: number,
): string;
