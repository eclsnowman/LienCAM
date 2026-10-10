import type { StockBounds, VoxelGridDims } from './VoxelField'

export const SPARSE_VOXEL_BRICK_SIZE = 8
export const SPARSE_VOXEL_BRICK_VOXELS =
  SPARSE_VOXEL_BRICK_SIZE * SPARSE_VOXEL_BRICK_SIZE * SPARSE_VOXEL_BRICK_SIZE
export const SPARSE_VOXEL_BRICK_BYTES = SPARSE_VOXEL_BRICK_VOXELS * Float32Array.BYTES_PER_ELEMENT
export const SPARSE_VOXEL_MAX_RESIDENT_BRICKS = 32_768
export const SPARSE_VOXEL_MAX_RESIDENT_BYTES =
  SPARSE_VOXEL_MAX_RESIDENT_BRICKS * SPARSE_VOXEL_BRICK_BYTES

export const SPARSE_VOXEL_SNAPSHOT_KIND = 'sparse-voxel-v1' as const

export interface SparseVoxelBrickDims {
  readonly nbx: number
  readonly nby: number
  readonly nbz: number
}

export interface SparseVoxelGridPlan {
  readonly dims: Readonly<VoxelGridDims>
  readonly brickDims: Readonly<SparseVoxelBrickDims>
  readonly requestedVoxelSize: number
  readonly logicalVoxelCount: number
}

export interface SparseVoxelFieldOptions {
  maxResidentBricks?: number
}

export interface SparseVoxelAddress {
  brickKey: number
  bx: number
  by: number
  bz: number
  lx: number
  ly: number
  lz: number
  brickOffset: number
}

export type SparseVoxelBrickState = 'implicit-stock' | 'saturated-air' | 'resident'

export interface SparseVoxelDirtyState {
  revision: number
  fullReset: boolean
  residentBrickKeys: readonly number[]
  pageBrickKeys: readonly number[]
}

export interface SparseVoxelAllocationStats {
  logicalVoxelCount: number
  logicalDenseBytes: number
  logicalBrickCount: number
  residentBrickCount: number
  residentBytes: number
  maxResidentBricks: number
  maxResidentBytes: number
  saturatedAirBrickCount: number
  columnTopOverrideCount: number
}

export interface SparseVoxelSnapshot {
  readonly kind: typeof SPARSE_VOXEL_SNAPSHOT_KIND
  readonly dimsSignature: string
  readonly band: number
  readonly bricks: ReadonlyMap<number, Float32Array>
  readonly airBrickKeys: ReadonlySet<number>
  readonly byteLength: number
}

export class SparseVoxelFieldError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'SparseVoxelFieldError'
    this.code = code
  }
}

export class SparseVoxelConfigError extends SparseVoxelFieldError {
  constructor(message: string) {
    super('SPARSE_VOXEL_INVALID_CONFIG', message)
    this.name = 'SparseVoxelConfigError'
  }
}

export class SparseVoxelBoundsError extends SparseVoxelFieldError {
  constructor(message: string) {
    super('SPARSE_VOXEL_OUT_OF_BOUNDS', message)
    this.name = 'SparseVoxelBoundsError'
  }
}

export class SparseVoxelPoolExhaustedError extends SparseVoxelFieldError {
  readonly residentBricks: number
  readonly additionalBricks: number
  readonly maxResidentBricks: number

  constructor(residentBricks: number, additionalBricks: number, maxResidentBricks: number) {
    super(
      'SPARSE_VOXEL_POOL_EXHAUSTED',
      `SparseVoxelField: resident brick pool exhausted: ${residentBricks} resident + ` +
        `${additionalBricks} requested exceeds limit ${maxResidentBricks}`,
    )
    this.name = 'SparseVoxelPoolExhaustedError'
    this.residentBricks = residentBricks
    this.additionalBricks = additionalBricks
    this.maxResidentBricks = maxResidentBricks
  }
}

export class SparseVoxelRevisionError extends SparseVoxelFieldError {
  constructor(expectedRevision: number, actualRevision: number) {
    super(
      'SPARSE_VOXEL_STALE_REVISION',
      `SparseVoxelField.clearDirty: expected revision ${expectedRevision}, current revision is ${actualRevision}`,
    )
    this.name = 'SparseVoxelRevisionError'
  }
}

export class SparseVoxelSnapshotError extends SparseVoxelFieldError {
  constructor(message: string) {
    super('SPARSE_VOXEL_INVALID_SNAPSHOT', message)
    this.name = 'SparseVoxelSnapshotError'
  }
}

function requireFinite(label: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new SparseVoxelConfigError(`SparseVoxelField: ${label} must be finite, got ${value}`)
  }
}

function requireSafePositiveInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SparseVoxelConfigError(
      `SparseVoxelField: ${label} must be a positive safe integer, got ${value}`,
    )
  }
}

function checkedProduct(label: string, values: readonly number[]): number {
  let product = 1
  for (const value of values) {
    product *= value
    if (!Number.isSafeInteger(product)) {
      throw new SparseVoxelConfigError(
        `SparseVoxelField: ${label} exceeds JavaScript safe-integer addressing`,
      )
    }
  }
  return product
}

function brickDimsFor(dims: Readonly<VoxelGridDims>): Readonly<SparseVoxelBrickDims> {
  return Object.freeze({
    nbx: Math.ceil(dims.nx / SPARSE_VOXEL_BRICK_SIZE),
    nby: Math.ceil(dims.ny / SPARSE_VOXEL_BRICK_SIZE),
    nbz: Math.ceil(dims.nz / SPARSE_VOXEL_BRICK_SIZE),
  })
}

function validateDims(dims: Readonly<VoxelGridDims>): void {
  requireSafePositiveInteger('dims.nx', dims.nx)
  requireSafePositiveInteger('dims.ny', dims.ny)
  requireSafePositiveInteger('dims.nz', dims.nz)
  requireFinite('dims.voxelSize', dims.voxelSize)
  if (!(dims.voxelSize > 0)) {
    throw new SparseVoxelConfigError(
      `SparseVoxelField: dims.voxelSize must be > 0, got ${dims.voxelSize}`,
    )
  }
  requireFinite('dims.x0', dims.x0)
  requireFinite('dims.y0', dims.y0)
  requireFinite('dims.z0', dims.z0)
  checkedProduct('logical voxel count', [dims.nx, dims.ny, dims.nz])
  const brickDims = brickDimsFor(dims)
  checkedProduct('logical brick count', [brickDims.nbx, brickDims.nby, brickDims.nbz])
}

export function planSparseVoxelGrid(
  bounds: StockBounds,
  requestedVoxelSize: number,
): SparseVoxelGridPlan {
  requireFinite('requestedVoxelSize', requestedVoxelSize)
  if (!(requestedVoxelSize > 0)) {
    throw new SparseVoxelConfigError(
      `planSparseVoxelGrid: requestedVoxelSize must be > 0, got ${requestedVoxelSize}`,
    )
  }
  for (const [label, value] of Object.entries(bounds)) {
    requireFinite(`bounds.${label}`, value)
  }

  const ex = Math.max(0, bounds.x1 - bounds.x0)
  const ey = Math.max(0, bounds.y1 - bounds.y0)
  const ez = Math.max(0, bounds.z1 - bounds.z0)
  const dims: Readonly<VoxelGridDims> = Object.freeze({
    nx: Math.max(1, Math.ceil(ex / requestedVoxelSize)),
    ny: Math.max(1, Math.ceil(ey / requestedVoxelSize)),
    nz: Math.max(1, Math.ceil(ez / requestedVoxelSize)),
    voxelSize: requestedVoxelSize,
    x0: bounds.x0,
    y0: bounds.y0,
    z0: bounds.z0,
  })
  validateDims(dims)
  const brickDims = brickDimsFor(dims)
  return Object.freeze({
    dims,
    brickDims,
    requestedVoxelSize,
    logicalVoxelCount: checkedProduct('logical voxel count', [dims.nx, dims.ny, dims.nz]),
  })
}

export function sparseVoxelDimsSignature(dims: Readonly<VoxelGridDims>): string {
  return [
    SPARSE_VOXEL_BRICK_SIZE,
    dims.nx,
    dims.ny,
    dims.nz,
    dims.voxelSize,
    dims.x0,
    dims.y0,
    dims.z0,
  ].join(':')
}

/**
 * Sparse CPU storage for the future brick-backed voxel simulation.
 *
 * Unrepresented bricks are analytic solid stock. Fully removed bricks use a
 * saturated-air sentinel set. Only mixed bricks consume a 512-float resident
 * allocation. This class intentionally has no dense `data` property and no
 * materialization method.
 */
export class SparseVoxelField {
  readonly dims: Readonly<VoxelGridDims>
  readonly brickDims: Readonly<SparseVoxelBrickDims>
  readonly band: number
  readonly saturatedAirValue: number
  readonly maxResidentBricks: number
  readonly dimsSignature: string

  private readonly logicalVoxelCount: number
  private readonly logicalBrickCount: number
  private bricks = new Map<number, Float32Array>()
  private airBrickKeys = new Set<number>()
  private readonly columnTopOverrides = new Map<number, number>()

  private revisionValue = 0
  private fullResetDirty = false
  private readonly dirtyResidentBrickKeys = new Set<number>()
  private readonly dirtyPageBrickKeys = new Set<number>()

  constructor(
    dims: Readonly<VoxelGridDims>,
    band: number,
    options: SparseVoxelFieldOptions = {},
  ) {
    validateDims(dims)
    requireFinite('band', band)
    if (!(band > 0)) {
      throw new SparseVoxelConfigError(`SparseVoxelField: band must be > 0, got ${band}`)
    }

    const maxResidentBricks =
      options.maxResidentBricks ?? SPARSE_VOXEL_MAX_RESIDENT_BRICKS
    if (
      !Number.isSafeInteger(maxResidentBricks) ||
      maxResidentBricks < 1 ||
      maxResidentBricks > SPARSE_VOXEL_MAX_RESIDENT_BRICKS
    ) {
      throw new SparseVoxelConfigError(
        `SparseVoxelField: maxResidentBricks must be an integer in [1, ` +
          `${SPARSE_VOXEL_MAX_RESIDENT_BRICKS}], got ${maxResidentBricks}`,
      )
    }

    this.dims = Object.freeze({ ...dims })
    this.brickDims = brickDimsFor(dims)
    Object.defineProperty(this, 'dims', {
      value: this.dims,
      writable: false,
      configurable: false,
      enumerable: true,
    })
    Object.defineProperty(this, 'brickDims', {
      value: this.brickDims,
      writable: false,
      configurable: false,
      enumerable: true,
    })
    this.band = band
    this.saturatedAirValue = Math.fround(-band)
    this.maxResidentBricks = maxResidentBricks
    this.dimsSignature = sparseVoxelDimsSignature(dims)
    this.logicalVoxelCount = checkedProduct('logical voxel count', [
      dims.nx,
      dims.ny,
      dims.nz,
    ])
    this.logicalBrickCount = checkedProduct('logical brick count', [
      this.brickDims.nbx,
      this.brickDims.nby,
      this.brickDims.nbz,
    ])
  }

  get revision(): number {
    return this.revisionValue
  }

  get dirty(): SparseVoxelDirtyState {
    return {
      revision: this.revisionValue,
      fullReset: this.fullResetDirty,
      residentBrickKeys: [...this.dirtyResidentBrickKeys].sort((a, b) => a - b),
      pageBrickKeys: [...this.dirtyPageBrickKeys].sort((a, b) => a - b),
    }
  }

  get allocationStats(): SparseVoxelAllocationStats {
    return {
      logicalVoxelCount: this.logicalVoxelCount,
      logicalDenseBytes: this.logicalVoxelCount * Float32Array.BYTES_PER_ELEMENT,
      logicalBrickCount: this.logicalBrickCount,
      residentBrickCount: this.bricks.size,
      residentBytes: this.bricks.size * SPARSE_VOXEL_BRICK_BYTES,
      maxResidentBricks: this.maxResidentBricks,
      maxResidentBytes: this.maxResidentBricks * SPARSE_VOXEL_BRICK_BYTES,
      saturatedAirBrickCount: this.airBrickKeys.size,
      columnTopOverrideCount: this.columnTopOverrides.size,
    }
  }

  inBounds(ix: number, iy: number, iz: number): boolean {
    const { nx, ny, nz } = this.dims
    return ix >= 0 && ix < nx && iy >= 0 && iy < ny && iz >= 0 && iz < nz
  }

  voxelCenterWorld(
    ix: number,
    iy: number,
    iz: number,
  ): { x: number; y: number; z: number } {
    this.assertVoxelInBounds(ix, iy, iz)
    const { x0, y0, z0, voxelSize } = this.dims
    return {
      x: x0 + (ix + 0.5) * voxelSize,
      y: y0 + (iy + 0.5) * voxelSize,
      z: z0 + (iz + 0.5) * voxelSize,
    }
  }

  worldToVoxel(x: number, y: number, z: number): { ix: number; iy: number; iz: number } {
    const { x0, y0, z0, voxelSize } = this.dims
    return {
      ix: Math.floor((x - x0) / voxelSize),
      iy: Math.floor((y - y0) / voxelSize),
      iz: Math.floor((z - z0) / voxelSize),
    }
  }

  addressOf(ix: number, iy: number, iz: number): SparseVoxelAddress {
    this.assertVoxelInBounds(ix, iy, iz)
    const bx = Math.floor(ix / SPARSE_VOXEL_BRICK_SIZE)
    const by = Math.floor(iy / SPARSE_VOXEL_BRICK_SIZE)
    const bz = Math.floor(iz / SPARSE_VOXEL_BRICK_SIZE)
    const lx = ix - bx * SPARSE_VOXEL_BRICK_SIZE
    const ly = iy - by * SPARSE_VOXEL_BRICK_SIZE
    const lz = iz - bz * SPARSE_VOXEL_BRICK_SIZE
    return {
      brickKey: this.brickKey(bx, by, bz),
      bx,
      by,
      bz,
      lx,
      ly,
      lz,
      brickOffset:
        lz * SPARSE_VOXEL_BRICK_SIZE * SPARSE_VOXEL_BRICK_SIZE +
        ly * SPARSE_VOXEL_BRICK_SIZE +
        lx,
    }
  }

  brickKey(bx: number, by: number, bz: number): number {
    this.assertBrickInBounds(bx, by, bz)
    return bz * this.brickDims.nbx * this.brickDims.nby + by * this.brickDims.nbx + bx
  }

  decodeBrickKey(brickKey: number): { bx: number; by: number; bz: number } {
    this.assertBrickKey(brickKey)
    const { nbx, nby } = this.brickDims
    return {
      bx: brickKey % nbx,
      by: Math.floor(brickKey / nbx) % nby,
      bz: Math.floor(brickKey / (nbx * nby)),
    }
  }

  brickState(brickKey: number): SparseVoxelBrickState {
    this.assertBrickKey(brickKey)
    if (this.bricks.has(brickKey)) return 'resident'
    if (this.airBrickKeys.has(brickKey)) return 'saturated-air'
    return 'implicit-stock'
  }

  residentBrickKeys(): readonly number[] {
    return [...this.bricks.keys()].sort((a, b) => a - b)
  }

  saturatedAirBrickKeys(): readonly number[] {
    return [...this.airBrickKeys].sort((a, b) => a - b)
  }

  /** Defensive resident copy for future atlas upload. */
  residentBrick(brickKey: number): Float32Array | undefined {
    this.assertBrickKey(brickKey)
    return this.bricks.get(brickKey)?.slice()
  }

  get(ix: number, iy: number, iz: number): number {
    const address = this.addressOf(ix, iy, iz)
    const resident = this.bricks.get(address.brickKey)
    if (resident !== undefined) return resident[address.brickOffset]
    if (this.airBrickKeys.has(address.brickKey)) return this.saturatedAirValue
    return this.implicitStockValue(ix, iy, iz)
  }

  set(ix: number, iy: number, iz: number, value: number): void {
    if (!Number.isFinite(value)) {
      throw new SparseVoxelConfigError(`SparseVoxelField.set: value must be finite, got ${value}`)
    }
    const address = this.addressOf(ix, iy, iz)
    const storedValue = Math.fround(value)
    let resident = this.bricks.get(address.brickKey)
    if (resident !== undefined) {
      if (Object.is(resident[address.brickOffset], storedValue)) return
      resident[address.brickOffset] = storedValue
      this.raiseColumnTopForSolidWrite(ix, iy, iz, storedValue)
      this.recordMutation(address.brickKey, true, false)
      return
    }

    const implicitValue = this.airBrickKeys.has(address.brickKey)
      ? this.saturatedAirValue
      : this.implicitStockValue(ix, iy, iz)
    if (Object.is(implicitValue, storedValue)) return

    this.assertResidentCapacity(1)
    resident = this.makeResidentBrick(address.brickKey)
    resident[address.brickOffset] = storedValue
    this.bricks.set(address.brickKey, resident)
    this.airBrickKeys.delete(address.brickKey)
    this.raiseColumnTopForSolidWrite(ix, iy, iz, storedValue)
    this.recordMutation(address.brickKey, true, true)
  }

  /**
   * Mark a whole logical brick as saturated air without allocating 512 floats.
   * The state change is recorded as a page-table mutation for the future GPU
   * backing.
   */
  markBrickSaturatedAir(brickKey: number): void {
    this.assertBrickKey(brickKey)
    if (this.airBrickKeys.has(brickKey) && !this.bricks.has(brickKey)) return
    this.bricks.delete(brickKey)
    this.dirtyResidentBrickKeys.delete(brickKey)
    this.airBrickKeys.add(brickKey)
    this.recordMutation(brickKey, false, true)
  }

  /** Return a brick to the implicit analytic-stock state. */
  markBrickImplicitStock(brickKey: number): void {
    this.assertBrickKey(brickKey)
    if (!this.bricks.has(brickKey) && !this.airBrickKeys.has(brickKey)) return
    this.bricks.delete(brickKey)
    this.dirtyResidentBrickKeys.delete(brickKey)
    this.airBrickKeys.delete(brickKey)
    this.clearColumnTopOverridesForBrick(brickKey)
    this.recordMutation(brickKey, false, true)
  }

  /**
   * Fail before mutation if `additionalBricks` cannot fit. Phase 2 can call this
   * once with a complete sweep's candidate-brick count.
   */
  assertResidentCapacity(additionalBricks: number): void {
    if (!Number.isSafeInteger(additionalBricks) || additionalBricks < 0) {
      throw new SparseVoxelConfigError(
        `SparseVoxelField.assertResidentCapacity: additionalBricks must be a non-negative integer, got ${additionalBricks}`,
      )
    }
    if (this.bricks.size + additionalBricks > this.maxResidentBricks) {
      throw new SparseVoxelPoolExhaustedError(
        this.bricks.size,
        additionalBricks,
        this.maxResidentBricks,
      )
    }
  }

  getColumnTop(ix: number, iy: number): number {
    this.assertColumnInBounds(ix, iy)
    return this.columnTopOverrides.get(this.columnKey(ix, iy)) ?? this.dims.nz - 1
  }

  /**
   * Store only lowered column tops. `-1` represents a provably all-air column.
   * Raising to nz-1 deletes the override and restores the conservative default.
   */
  setColumnTop(ix: number, iy: number, iz: number): void {
    this.assertColumnInBounds(ix, iy)
    if (!Number.isInteger(iz) || iz < -1 || iz >= this.dims.nz) {
      throw new SparseVoxelBoundsError(
        `SparseVoxelField.setColumnTop: iz ${iz} is outside [-1, ${this.dims.nz - 1}]`,
      )
    }
    const key = this.columnKey(ix, iy)
    if (iz === this.dims.nz - 1) this.columnTopOverrides.delete(key)
    else this.columnTopOverrides.set(key, iz)
  }

  resetColumnTops(): void {
    this.columnTopOverrides.clear()
  }

  clearDirty(expectedRevision: number): void {
    if (expectedRevision !== this.revisionValue) {
      throw new SparseVoxelRevisionError(expectedRevision, this.revisionValue)
    }
    this.fullResetDirty = false
    this.dirtyResidentBrickKeys.clear()
    this.dirtyPageBrickKeys.clear()
  }

  /** Restore the O(1) implicit analytic-stock baseline. */
  reset(): void {
    this.bricks.clear()
    this.airBrickKeys.clear()
    this.columnTopOverrides.clear()
    this.revisionValue++
    this.fullResetDirty = true
    this.dirtyResidentBrickKeys.clear()
    this.dirtyPageBrickKeys.clear()
  }

  snapshot(): SparseVoxelSnapshot {
    const bricks = new Map<number, Float32Array>()
    for (const [key, data] of this.bricks) bricks.set(key, data.slice())
    const airBrickKeys = new Set(this.airBrickKeys)
    return {
      kind: SPARSE_VOXEL_SNAPSHOT_KIND,
      dimsSignature: this.dimsSignature,
      band: this.band,
      bricks,
      airBrickKeys,
      byteLength:
        bricks.size * SPARSE_VOXEL_BRICK_BYTES +
        (bricks.size + airBrickKeys.size) * Float64Array.BYTES_PER_ELEMENT,
    }
  }

  /**
   * Validate and deep-copy a snapshot completely before replacing live state.
   * Any failure leaves values, allocation counts, revision, and dirty state
   * unchanged.
   */
  restore(snapshot: SparseVoxelSnapshot): void {
    const replacement = this.validateAndCopySnapshot(snapshot)
    this.bricks = replacement.bricks
    this.airBrickKeys = replacement.airBrickKeys
    this.columnTopOverrides.clear()
    this.revisionValue++
    this.fullResetDirty = true
    this.dirtyResidentBrickKeys.clear()
    this.dirtyPageBrickKeys.clear()
  }

  private implicitStockValue(ix: number, iy: number, iz: number): number {
    const { nx, ny, nz, voxelSize, x0, y0, z0 } = this.dims
    const x = x0 + (ix + 0.5) * voxelSize
    const y = y0 + (iy + 0.5) * voxelSize
    const z = z0 + (iz + 0.5) * voxelSize
    const x1 = x0 + nx * voxelSize
    const y1 = y0 + ny * voxelSize
    const z1 = z0 + nz * voxelSize
    const distance = Math.min(x - x0, x1 - x, y - y0, y1 - y, z - z0, z1 - z)
    return Math.fround(distance < 0 ? 0 : distance > this.band ? this.band : distance)
  }

  private makeResidentBrick(brickKey: number): Float32Array {
    const brick = new Float32Array(SPARSE_VOXEL_BRICK_VOXELS)
    if (this.airBrickKeys.has(brickKey)) {
      brick.fill(this.saturatedAirValue)
      return brick
    }

    const { bx, by, bz } = this.decodeBrickKey(brickKey)
    let offset = 0
    for (let lz = 0; lz < SPARSE_VOXEL_BRICK_SIZE; lz++) {
      const iz = bz * SPARSE_VOXEL_BRICK_SIZE + lz
      for (let ly = 0; ly < SPARSE_VOXEL_BRICK_SIZE; ly++) {
        const iy = by * SPARSE_VOXEL_BRICK_SIZE + ly
        for (let lx = 0; lx < SPARSE_VOXEL_BRICK_SIZE; lx++, offset++) {
          const ix = bx * SPARSE_VOXEL_BRICK_SIZE + lx
          brick[offset] = this.inBounds(ix, iy, iz)
            ? this.implicitStockValue(ix, iy, iz)
            : this.saturatedAirValue
        }
      }
    }
    return brick
  }

  private recordMutation(
    brickKey: number,
    residentDataChanged: boolean,
    pageChanged: boolean,
  ): void {
    this.revisionValue++
    if (residentDataChanged) this.dirtyResidentBrickKeys.add(brickKey)
    if (pageChanged) this.dirtyPageBrickKeys.add(brickKey)
  }

  private raiseColumnTopForSolidWrite(
    ix: number,
    iy: number,
    iz: number,
    value: number,
  ): void {
    if (value === this.saturatedAirValue) return
    const key = this.columnKey(ix, iy)
    const current = this.columnTopOverrides.get(key) ?? this.dims.nz - 1
    if (iz <= current) return
    if (iz === this.dims.nz - 1) this.columnTopOverrides.delete(key)
    else this.columnTopOverrides.set(key, iz)
  }

  private clearColumnTopOverridesForBrick(brickKey: number): void {
    const { bx, by } = this.decodeBrickKey(brickKey)
    const ix0 = bx * SPARSE_VOXEL_BRICK_SIZE
    const iy0 = by * SPARSE_VOXEL_BRICK_SIZE
    const ix1 = Math.min(this.dims.nx, ix0 + SPARSE_VOXEL_BRICK_SIZE)
    const iy1 = Math.min(this.dims.ny, iy0 + SPARSE_VOXEL_BRICK_SIZE)
    for (let iy = iy0; iy < iy1; iy++) {
      for (let ix = ix0; ix < ix1; ix++) {
        this.columnTopOverrides.delete(this.columnKey(ix, iy))
      }
    }
  }

  private validateAndCopySnapshot(snapshot: SparseVoxelSnapshot): {
    bricks: Map<number, Float32Array>
    airBrickKeys: Set<number>
  } {
    if (snapshot === null || typeof snapshot !== 'object') {
      throw new SparseVoxelSnapshotError('SparseVoxelField.restore: snapshot must be an object')
    }
    if (snapshot.kind !== SPARSE_VOXEL_SNAPSHOT_KIND) {
      throw new SparseVoxelSnapshotError(
        `SparseVoxelField.restore: unsupported snapshot kind ${String(snapshot.kind)}`,
      )
    }
    if (snapshot.dimsSignature !== this.dimsSignature) {
      throw new SparseVoxelSnapshotError(
        `SparseVoxelField.restore: dims signature ${snapshot.dimsSignature} does not match ${this.dimsSignature}`,
      )
    }
    if (!Object.is(snapshot.band, this.band)) {
      throw new SparseVoxelSnapshotError(
        `SparseVoxelField.restore: band ${snapshot.band} does not match ${this.band}`,
      )
    }
    if (!(snapshot.bricks instanceof Map) || !(snapshot.airBrickKeys instanceof Set)) {
      throw new SparseVoxelSnapshotError(
        'SparseVoxelField.restore: bricks must be a Map and airBrickKeys must be a Set',
      )
    }
    if (snapshot.bricks.size > this.maxResidentBricks) {
      throw new SparseVoxelPoolExhaustedError(
        0,
        snapshot.bricks.size,
        this.maxResidentBricks,
      )
    }

    const bricks = new Map<number, Float32Array>()
    for (const [key, data] of snapshot.bricks) {
      this.assertSnapshotBrickKey(key)
      if (!(data instanceof Float32Array) || data.length !== SPARSE_VOXEL_BRICK_VOXELS) {
        throw new SparseVoxelSnapshotError(
          `SparseVoxelField.restore: brick ${key} must contain exactly ${SPARSE_VOXEL_BRICK_VOXELS} float32 values`,
        )
      }
      bricks.set(key, data.slice())
    }

    const airBrickKeys = new Set<number>()
    for (const key of snapshot.airBrickKeys) {
      this.assertSnapshotBrickKey(key)
      if (bricks.has(key)) {
        throw new SparseVoxelSnapshotError(
          `SparseVoxelField.restore: brick ${key} cannot be resident and saturated air`,
        )
      }
      airBrickKeys.add(key)
    }
    return { bricks, airBrickKeys }
  }

  private assertVoxelInBounds(ix: number, iy: number, iz: number): void {
    if (
      !Number.isInteger(ix) ||
      !Number.isInteger(iy) ||
      !Number.isInteger(iz) ||
      !this.inBounds(ix, iy, iz)
    ) {
      throw new SparseVoxelBoundsError(
        `SparseVoxelField: voxel (${ix}, ${iy}, ${iz}) outside ` +
          `[0,${this.dims.nx})x[0,${this.dims.ny})x[0,${this.dims.nz})`,
      )
    }
  }

  private assertColumnInBounds(ix: number, iy: number): void {
    if (
      !Number.isInteger(ix) ||
      !Number.isInteger(iy) ||
      ix < 0 ||
      ix >= this.dims.nx ||
      iy < 0 ||
      iy >= this.dims.ny
    ) {
      throw new SparseVoxelBoundsError(
        `SparseVoxelField: column (${ix}, ${iy}) outside [0,${this.dims.nx})x[0,${this.dims.ny})`,
      )
    }
  }

  private assertBrickInBounds(bx: number, by: number, bz: number): void {
    if (
      !Number.isInteger(bx) ||
      !Number.isInteger(by) ||
      !Number.isInteger(bz) ||
      bx < 0 ||
      bx >= this.brickDims.nbx ||
      by < 0 ||
      by >= this.brickDims.nby ||
      bz < 0 ||
      bz >= this.brickDims.nbz
    ) {
      throw new SparseVoxelBoundsError(
        `SparseVoxelField: brick (${bx}, ${by}, ${bz}) outside ` +
          `[0,${this.brickDims.nbx})x[0,${this.brickDims.nby})x[0,${this.brickDims.nbz})`,
      )
    }
  }

  private assertBrickKey(brickKey: number): void {
    if (
      !Number.isSafeInteger(brickKey) ||
      brickKey < 0 ||
      brickKey >= this.logicalBrickCount
    ) {
      throw new SparseVoxelBoundsError(
        `SparseVoxelField: brick key ${brickKey} outside [0, ${this.logicalBrickCount})`,
      )
    }
  }

  private assertSnapshotBrickKey(brickKey: number): void {
    try {
      this.assertBrickKey(brickKey)
    } catch {
      throw new SparseVoxelSnapshotError(
        `SparseVoxelField.restore: invalid brick key ${brickKey}`,
      )
    }
  }

  private columnKey(ix: number, iy: number): number {
    return iy * this.dims.nx + ix
  }
}
