export function textureMatchesSource( texture: unknown, source: Record<string, unknown> | null | undefined ): boolean;
export function textureMatchesArtifactSource( texture: unknown, source: Record<string, unknown> | null | undefined ): boolean;
export function artifactHasTextureSource( artifact: unknown, predicate?: ( source: Record<string, unknown>, entry: Record<string, unknown>, group: Record<string, unknown> ) => boolean ): boolean;
export function countArtifactTextureSources( artifact: unknown, predicate?: ( source: Record<string, unknown>, entry: Record<string, unknown>, group: Record<string, unknown> ) => boolean ): number;
export function singleArtifactTextureUuid( artifact: unknown, predicate?: ( source: Record<string, unknown>, entry: Record<string, unknown>, group: Record<string, unknown> ) => boolean ): string | null;
export function attachTextureRefsWhere( artifact: unknown, texture: unknown, predicate: ( source: Record<string, unknown>, entry: Record<string, unknown>, group: Record<string, unknown> ) => boolean ): boolean;
export function attachArtifactTextureRefsWhere( artifact: unknown, texture: unknown, predicate: ( source: Record<string, unknown>, entry: Record<string, unknown>, group: Record<string, unknown> ) => boolean ): boolean;
