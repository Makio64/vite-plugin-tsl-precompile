export const ARTIFACT_CONTENT_HASH_VERSION: 'artifact-content@3';

export function stringifyArtifactJson( value: unknown ): string | undefined;
export function stripPrivateArtifactFieldsInPlace<T>( value: T ): T;

export interface ArtifactContentHashOptionsBase {
	shape: string;
	threeVersion: string;
}

export type ArtifactContentHashOptions = ArtifactContentHashOptionsBase & (
	| { toolchainVersion: string; pluginVersion?: string }
	| { toolchainVersion?: undefined; pluginVersion: string }
);

export function createArtifactContentHashPayload(
	artifact: unknown,
	options: ArtifactContentHashOptions,
): string;
