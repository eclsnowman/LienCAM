export interface TerraceInterval {
  readonly lowerLevelIndex: number;
  readonly lowerZ: number;
  readonly z: number;
  readonly upperZ: number;
}

/** Every interval is anchored to its real adjacent full planes, including pins. */
export function terraceIntervals(stockTopZ: number, fullLevels: readonly number[]): TerraceInterval[] {
  return fullLevels.map((lowerZ, lowerLevelIndex) => {
    const upperZ = lowerLevelIndex === 0 ? stockTopZ : fullLevels[lowerLevelIndex - 1];
    return { lowerLevelIndex, lowerZ, upperZ, z: (upperZ + lowerZ) / 2 };
  });
}
