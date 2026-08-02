/**
 * Build an isolated NodeFrame-compatible scheduler for full-renderer effects.
 *
 * Effect nodes can recursively ask a frame to update their dependencies. The
 * slim renderer's ReplayNodeFrame is renderer-owned state, so borrowing it for
 * a full-renderer effect can corrupt an in-flight slim graph. This helper keeps
 * the dependency maps and recursion state private to one effect invocation.
 */

import { NodeUpdateType } from "../slim-replay-node-core-primitives.js";

function isWeakKey(value) {
  return (
    value !== null && (typeof value === "object" || typeof value === "function")
  );
}

function updateReference(node, frame) {
  if (typeof node.updateReference !== "function") return node;
  const reference = node.updateReference(frame);
  return isWeakKey(reference) ? reference : node;
}

function resolveUpdateMethod(node, suffix, resolveUpdateBefore) {
  if (suffix === "Before" && typeof resolveUpdateBefore === "function") {
    return resolveUpdateBefore(node);
  }
  const method = "update" + suffix;
  return typeof node[method] === "function" ? node[method] : null;
}

function resolveUpdateType(node, suffix) {
  const getter = "getUpdate" + suffix + "Type";
  if (typeof node[getter] === "function") return node[getter]();
  const property = "update" + suffix + "Type";
  return node[property] ?? NodeUpdateType.NONE;
}

function getUpdateStamps(referenceMap, reference) {
  let stamps = referenceMap.get(reference);
  if (stamps === undefined) {
    // Match Three r185's NodeFrame._getMaps() initialization. Renderer-owned
    // frames advance both identifiers before scheduling their first update.
    stamps = {
      renderId: 0,
      frameId: 0,
    };
    referenceMap.set(reference, stamps);
  }
  return stamps;
}

/**
 * @param {{
 *   renderer: object,
 *   context?: object,
 *   frameId?: number|string,
 *   renderId?: number|string,
 *   time?: number|null,
 *   resolveUpdateBefore?: (node: object) => Function|null|undefined,
 * }} options
 * @return {object}
 */
export function createIsolatedFrameEffectNodeFrame(options = {}) {
  const {
    renderer,
    context = {},
    frameId = 0,
    renderId = frameId,
    time = null,
    resolveUpdateBefore = null,
  } = options;
  const frame = {
    renderer,
    context: context && typeof context === "object" ? context : {},
    frameId,
    renderId,
    time,
    updateMap: new WeakMap(),
    updateBeforeMap: new WeakMap(),
    updateAfterMap: new WeakMap(),
  };
  const active = {
    update: new WeakSet(),
    updateBefore: new WeakSet(),
    updateAfter: new WeakSet(),
  };

  function invoke(node, suffix) {
    if (!isWeakKey(node)) return;
    const method = "update" + suffix;
    const updateType = resolveUpdateType(node, suffix);
    const referenceMap = frame[method + "Map"];
    const reference = updateReference(node, frame);
    if (updateType === NodeUpdateType.NONE) return;
    if (active[method].has(node)) return;

    if (
      updateType === NodeUpdateType.FRAME ||
      updateType === NodeUpdateType.RENDER
    ) {
      const stamps = getUpdateStamps(referenceMap, reference);
      const stampName =
        updateType === NodeUpdateType.FRAME ? "frameId" : "renderId";
      if (stamps[stampName] === frame[stampName]) return;

      if (suffix === "Before") {
        // Three pre-stamps updateBefore so nested dependencies can safely
        // re-enter the same FRAME/RENDER reference. A false result rolls the
        // stamp back and leaves the dependency eligible for retry.
        const previousStamp = stamps[stampName];
        stamps[stampName] = frame[stampName];
        active[method].add(node);
        try {
          const update = resolveUpdateMethod(
            node,
            suffix,
            resolveUpdateBefore,
          );
          if (typeof update !== "function") return;
          const value = update.call(node, frame);
          if (value === false) stamps[stampName] = previousStamp;
          return value;
        } finally {
          active[method].delete(node);
        }
      }

      // update() and updateAfter() commit only after successful work. The
      // active set is solely a synchronous re-entry guard; it is not a cache.
      active[method].add(node);
      try {
        const update = resolveUpdateMethod(node, suffix, resolveUpdateBefore);
        if (typeof update !== "function") return;
        const value = update.call(node, frame);
        if (value !== false) stamps[stampName] = frame[stampName];
        return value;
      } finally {
        active[method].delete(node);
      }
    }

    if (updateType !== NodeUpdateType.OBJECT) return;

    // OBJECT updates intentionally have no persistent stamp. Only prevent a
    // node from synchronously invoking itself through the isolated frame.
    active[method].add(node);
    try {
      const update = resolveUpdateMethod(node, suffix, resolveUpdateBefore);
      if (typeof update !== "function") return;
      return update.call(node, frame);
    } finally {
      active[method].delete(node);
    }
  }

  frame.updateNode = (node) => invoke(node, "");
  frame.updateBeforeNode = (node) => invoke(node, "Before");
  frame.updateAfterNode = (node) => invoke(node, "After");
  return frame;
}
