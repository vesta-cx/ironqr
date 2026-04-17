export interface ComponentStats {
  readonly id: number;
  readonly color: number;
  readonly pixelCount: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly centroidX: number;
  readonly centroidY: number;
}

interface ComponentAccumulator {
  readonly id: number;
  readonly color: number;
  pixelCount: number;
  sumX: number;
  sumY: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Labels 4-connected same-colour components in a binary image. */
export const labelConnectedComponents = (
  binary: Uint8Array,
  width: number,
  height: number,
): Uint32Array => {
  const labels = new Uint32Array(width * height);
  const parent: number[] = [0];

  const findRoot = (label: number): number => {
    let current = label;
    while (parent[current] !== current) {
      const parentIndex = parent[current] as number;
      parent[current] = parent[parentIndex] as number;
      current = parent[current] as number;
    }
    return current;
  };

  const union = (a: number, b: number): number => {
    const rootA = findRoot(a);
    const rootB = findRoot(b);
    if (rootA === rootB) return rootA;
    if (rootA < rootB) {
      parent[rootB] = rootA;
      return rootA;
    }
    parent[rootA] = rootB;
    return rootB;
  };

  let nextId = 1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const color = binary[index] ?? 255;
      const leftLabel = x > 0 && (binary[index - 1] ?? 255) === color ? labels[index - 1] : 0;
      const upLabel = y > 0 && (binary[index - width] ?? 255) === color ? labels[index - width] : 0;

      if (leftLabel && upLabel) {
        labels[index] = union(leftLabel, upLabel);
      } else if (leftLabel) {
        labels[index] = leftLabel;
      } else if (upLabel) {
        labels[index] = upLabel;
      } else {
        labels[index] = nextId;
        parent[nextId] = nextId;
        nextId += 1;
      }
    }
  }

  for (let index = 0; index < labels.length; index += 1) {
    labels[index] = findRoot(labels[index] ?? 0);
  }

  return labels;
};

/** Computes centroid and bounds for each connected component id. */
export const collectComponentStats = (
  labels: Uint32Array,
  binary: Uint8Array,
  width: number,
  height: number,
): ComponentStats[] => {
  const byId = new Map<number, ComponentAccumulator>();
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const id = labels[index] ?? 0;
      if (id === 0) continue;

      let stats = byId.get(id);
      if (!stats) {
        stats = {
          id,
          color: binary[index] ?? 255,
          pixelCount: 0,
          sumX: 0,
          sumY: 0,
          minX: x,
          maxX: x,
          minY: y,
          maxY: y,
        };
        byId.set(id, stats);
      }

      stats.pixelCount += 1;
      stats.sumX += x;
      stats.sumY += y;
      if (x < stats.minX) stats.minX = x;
      if (x > stats.maxX) stats.maxX = x;
      if (y < stats.minY) stats.minY = y;
      if (y > stats.maxY) stats.maxY = y;
    }
  }

  return Array.from(byId.values(), (stats) => ({
    id: stats.id,
    color: stats.color,
    pixelCount: stats.pixelCount,
    minX: stats.minX,
    maxX: stats.maxX,
    minY: stats.minY,
    maxY: stats.maxY,
    centroidX: stats.sumX / stats.pixelCount,
    centroidY: stats.sumY / stats.pixelCount,
  }));
};

/**
 * Returns each component id mapped to the id of the component that immediately
 * contains it, or 0 for top-level components.
 */
export const computeContainingComponents = (
  labels: Uint32Array,
  components: readonly ComponentStats[],
  width: number,
  _height: number,
): Record<number, number> => {
  const parents: Record<number, number> = { 0: 0 };
  for (const component of components) {
    if (component.minY === 0) {
      parents[component.id] = 0;
      continue;
    }

    const probeX = Math.round((component.minX + component.maxX) / 2);
    const probeY = component.minY - 1;
    parents[component.id] = labels[probeY * width + probeX] ?? 0;
  }
  return parents;
};
