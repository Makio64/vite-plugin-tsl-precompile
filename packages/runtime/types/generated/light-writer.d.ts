export function writeGeneratedLightValue(
	view: DataView,
	offset: number,
	kind: string,
	source: Record<string, unknown>,
	frame: Record<string, unknown>,
): void;

export function linkGeneratedLightIdentitySource(
	source: Readonly<Record<string, unknown>>,
	lightIdentities: ReadonlyArray<Record<string, unknown>>,
): Readonly<Record<string, unknown>>;
