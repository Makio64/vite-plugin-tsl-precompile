export interface ThreeEmitterIdentityOptions {
	threeVersion?: string;
	threeRevision?: string;
	threeCommit?: string;
}
export interface ThreeEmitterHashFields { threeRevision?: string; threeCommit?: string }
export interface ThreeEmitterSourceFields { sourceThreeRevision?: string; sourceThreeCommit?: string }
export function createThreeEmitterHashFields( options?: ThreeEmitterIdentityOptions ): ThreeEmitterHashFields;
export function createThreeEmitterSourceFields( options?: ThreeEmitterIdentityOptions ): ThreeEmitterSourceFields;
export function assertArtifactThreeEmitterIdentity( artifact: object | null | undefined, expectedOptions: ThreeEmitterIdentityOptions, label?: string ): void;
export function threeEmitterIdentityHashLines( options?: ThreeEmitterIdentityOptions ): string[];
