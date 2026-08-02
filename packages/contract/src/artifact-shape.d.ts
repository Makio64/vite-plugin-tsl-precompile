export interface ArtifactShapeDiff {
	ok: boolean;
	missing: string[];
	extra: string[];
}

export function fingerprintArtifactShape( input: unknown ): readonly string[];
export function diffArtifactShapes(
	expected: Iterable<string> | null | undefined,
	actual: Iterable<string> | null | undefined,
): ArtifactShapeDiff;
