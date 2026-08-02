/**
 * Narrow AOT runtime surface for full-Three consumers that need passive
 * artifact validation/registration, registry lookup, and generated uniform
 * writers without the dev marker, auxiliary capture, hydrator, or
 * slim-support barrels.
 *
 * Generated modules deliberately keep using the still-smaller mode-owned
 * `/apply` or `/apply/full` entry, plus `/loader` and `/writers` where needed.
 * This combined entry is an additive convenience for advanced integrations,
 * not a replacement for them.
 */

export { __applyPrecompiled } from './apply-precompiled-full.js';
export { registerArtifact, getArtifact, listUserArtifacts } from './artifact-loader.js';
export {
	writeF32,
	writeI32,
	writeU32,
	writeVec2,
	writeVec3,
	writeVec4,
	writeColor,
	writeColorRGBA,
	writeMat3,
	writeMat4,
	writeMat4FromEuler,
	writeEnvironmentRotation,
	writePMREMScalar,
	writeTextureUVFlip,
	writeBytes,
} from './writers.js';
