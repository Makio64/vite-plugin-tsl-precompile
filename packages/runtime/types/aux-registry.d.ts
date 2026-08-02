export interface AuxArtifactRegistration<TArtifact = unknown> {
	shape: string;
	configHash: string;
	artifact: TArtifact;
	name?: string;
	threeVersion?: string;
	pluginVersion?: string;
}

/** Build-generated auxiliary artifact registration entry. */
export function registerAuxArtifacts<TArtifact = unknown>( entries: Iterable<AuxArtifactRegistration<TArtifact>> ): void;
