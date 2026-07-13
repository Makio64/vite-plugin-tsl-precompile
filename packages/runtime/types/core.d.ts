/**
 * Narrow AOT runtime surface for advanced non-slim integrations.
 *
 * These declarations intentionally do not re-export `./index`: importing
 * `/core` must not install the root entry's dev-only `three.Material`
 * augmentation in the consumer's type graph.
 */

export interface UserArtifactEntry<TArtifactModule = unknown> {
	name: string;
	artifact: TArtifactModule;
}

export function __applyPrecompiled( material: unknown, artifactModule: unknown, expectedHash: string ): unknown;

export function registerArtifact<TArtifactModule = unknown>( name: string, artifactModule: TArtifactModule ): void;
export function getArtifact<TArtifactModule = unknown>( name: string ): TArtifactModule | null;
export function listUserArtifacts<TArtifactModule = unknown>(): UserArtifactEntry<TArtifactModule>[];

export function writeF32( view: DataView, byteOffset: number, value: number ): void;
export function writeI32( view: DataView, byteOffset: number, value: number ): void;
export function writeU32( view: DataView, byteOffset: number, value: number ): void;
export function writeVec2( view: DataView, byteOffset: number, value: { x: number; y: number } ): void;
export function writeVec3( view: DataView, byteOffset: number, value: { x: number; y: number; z: number } ): void;
export function writeVec4( view: DataView, byteOffset: number, value: { x: number; y: number; z: number; w: number } ): void;
export function writeColor( view: DataView, byteOffset: number, value: { r: number; g: number; b: number } ): void;
export function writeColorRGBA( view: DataView, byteOffset: number, color: { r: number; g: number; b: number }, alpha: number ): void;
export function writeMat3( view: DataView, byteOffset: number, mat: { elements: ArrayLike<number> } ): void;
export function writeMat4( view: DataView, byteOffset: number, mat: { elements: ArrayLike<number> } ): void;
export function writeMat4FromEuler( view: DataView, byteOffset: number, euler: unknown, background: unknown ): void;
export function writeBytes( view: DataView, byteOffset: number, source: ArrayBufferView, sourceByteOffset: number, byteLength: number ): void;
