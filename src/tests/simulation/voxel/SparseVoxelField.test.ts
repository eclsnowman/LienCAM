import { describe, expect, it } from 'vitest'
import {
  SPARSE_VOXEL_BRICK_BYTES,
  SPARSE_VOXEL_BRICK_SIZE,
  SPARSE_VOXEL_BRICK_VOXELS,
  SPARSE_VOXEL_MAX_RESIDENT_BRICKS,
  SPARSE_VOXEL_MAX_RESIDENT_BYTES,
  SPARSE_VOXEL_SNAPSHOT_KIND,
  SparseVoxelBoundsError,
  SparseVoxelConfigError,
  SparseVoxelField,
  SparseVoxelPoolExhaustedError,
  SparseVoxelRevisionError,
  SparseVoxelSnapshotError,
  planSparseVoxelGrid,
  type SparseVoxelSnapshot,
} from '../../../lib/simulation/voxel/SparseVoxelField'
import type { StockBounds, VoxelGridDims } from '../../../lib/simulation/voxel/VoxelField'

const bounds = (
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
): StockBounds => ({ x0, y0, z0, x1, y1, z1 })

const dims = (
  nx: number,
  ny: number,
  nz: number,
  voxelSize = 1,
  x0 = 0,
  y0 = 0,
  z0 = 0,
): VoxelGridDims => ({ nx, ny, nz, voxelSize, x0, y0, z0 })

describe('planSparseVoxelGrid', () => {
  it('keeps exact 0.1mm logical dimensions without total-voxel coarsening', () => {
    const plan = planSparseVoxelGrid(bounds(0, 0, 0, 100, 100, 20), 0.1)

    expect(plan.dims).toEqual({
      nx: 1000,
      ny: 1000,
      nz: 200,
      voxelSize: 0.1,
      x0: 0,
      y0: 0,
      z0: 0,
    })
    expect(plan.logicalVoxelCount).toBe(200_000_000)
    expect(plan.brickDims).toEqual({ nbx: 125, nby: 125, nbz: 25 })
    expect(plan.requestedVoxelSize).toBe(0.1)
  })

  it('ceils partial extents, floors empty axes at one, and rejects invalid input', () => {
    const plan = planSparseVoxelGrid(bounds(5, 7, 9, 5.81, 7, 8), 0.2)
    expect(plan.dims).toEqual({
      nx: 5,
      ny: 1,
      nz: 1,
      voxelSize: 0.2,
      x0: 5,
      y0: 7,
      z0: 9,
    })

    expect(() => planSparseVoxelGrid(bounds(0, 0, 0, 1, 1, 1), 0)).toThrow(
      SparseVoxelConfigError,
    )
    expect(() =>
      planSparseVoxelGrid(bounds(0, 0, 0, Number.POSITIVE_INFINITY, 1, 1), 1),
    ).toThrow(SparseVoxelConfigError)
  })
})

describe('SparseVoxelField allocation and addressing', () => {
  it('constructs a 200-million-voxel field with zero resident volume allocation', () => {
    const plan = planSparseVoxelGrid(bounds(0, 0, 0, 100, 100, 20), 0.1)
    const field = new SparseVoxelField(plan.dims, 0.3)
    const stats = field.allocationStats

    expect(stats.logicalVoxelCount).toBe(200_000_000)
    expect(stats.logicalDenseBytes).toBe(800_000_000)
    expect(stats.logicalBrickCount).toBe(125 * 125 * 25)
    expect(stats.residentBrickCount).toBe(0)
    expect(stats.residentBytes).toBe(0)
    expect(stats.maxResidentBricks).toBe(SPARSE_VOXEL_MAX_RESIDENT_BRICKS)
    expect(stats.maxResidentBytes).toBe(64 * 1024 * 1024)
    expect(stats.maxResidentBytes).toBe(SPARSE_VOXEL_MAX_RESIDENT_BYTES)
    expect('data' in field).toBe(false)
  })

  it('uses exact 8x8x8 brick and x-fastest local addressing', () => {
    const field = new SparseVoxelField(dims(17, 17, 17), 3)
    const address = field.addressOf(8, 9, 10)

    expect(SPARSE_VOXEL_BRICK_SIZE).toBe(8)
    expect(SPARSE_VOXEL_BRICK_VOXELS).toBe(512)
    expect(SPARSE_VOXEL_BRICK_BYTES).toBe(2048)
    expect(field.brickDims).toEqual({ nbx: 3, nby: 3, nbz: 3 })
    expect(address).toEqual({
      brickKey: 13,
      bx: 1,
      by: 1,
      bz: 1,
      lx: 0,
      ly: 1,
      lz: 2,
      brickOffset: 136,
    })
    expect(field.decodeBrickKey(address.brickKey)).toEqual({ bx: 1, by: 1, bz: 1 })
    expect(() => field.addressOf(17, 0, 0)).toThrow(SparseVoxelBoundsError)
  })

  it('freezes public dimensions so addressing metadata cannot be desynchronized', () => {
    const plan = planSparseVoxelGrid(bounds(0, 0, 0, 17, 17, 17), 1)
    const field = new SparseVoxelField(plan.dims, 3)
    field.setColumnTop(2, 3, 4)
    const addressBefore = field.addressOf(8, 9, 10)
    const valueBefore = field.get(8, 9, 10)
    const revisionBefore = field.revision
    const dirtyBefore = field.dirty
    const hwmBefore = field.getColumnTop(2, 3)

    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.dims)).toBe(true)
    expect(Object.isFrozen(plan.brickDims)).toBe(true)
    expect(Object.isFrozen(field.dims)).toBe(true)
    expect(Object.isFrozen(field.brickDims)).toBe(true)
    expect(Object.getOwnPropertyDescriptor(field, 'dims')?.writable).toBe(false)
    expect(Object.getOwnPropertyDescriptor(field, 'brickDims')?.writable).toBe(false)
    expect(() => Object.assign(field.dims, { nx: 999 })).toThrow(TypeError)
    expect(() => Object.assign(field.brickDims, { nbx: 999 })).toThrow(TypeError)
    expect(() => Object.assign(field, { dims: dims(1, 1, 1) })).toThrow(TypeError)

    expect(field.dims.nx).toBe(17)
    expect(field.brickDims.nbx).toBe(3)
    expect(field.addressOf(8, 9, 10)).toEqual(addressBefore)
    expect(field.get(8, 9, 10)).toBe(valueBefore)
    expect(field.revision).toBe(revisionBefore)
    expect(field.dirty).toEqual(dirtyBefore)
    expect(field.getColumnTop(2, 3)).toBe(hwmBefore)
  })

  it('reads unallocated voxels from the analytic narrow-band stock field', () => {
    const field = new SparseVoxelField(dims(10, 10, 10, 1, -2, 3, 5), 3)

    expect(field.get(0, 0, 0)).toBe(0.5)
    expect(field.get(9, 9, 9)).toBe(0.5)
    expect(field.get(5, 5, 5)).toBe(3)
    expect(field.voxelCenterWorld(0, 0, 0)).toEqual({ x: -1.5, y: 3.5, z: 5.5 })
    expect(field.worldToVoxel(-1.5, 3.5, 5.5)).toEqual({ ix: 0, iy: 0, iz: 0 })
    expect(field.allocationStats.residentBrickCount).toBe(0)
  })

  it('allocates one mixed brick on first differing write and preserves implicit neighbors', () => {
    const field = new SparseVoxelField(dims(16, 8, 8), 3)
    const key = field.addressOf(2, 2, 2).brickKey
    const implicitNeighbor = field.get(3, 3, 3)

    field.set(2, 2, 2, -1.25)

    expect(field.get(2, 2, 2)).toBe(-1.25)
    expect(field.get(3, 3, 3)).toBe(implicitNeighbor)
    expect(field.brickState(key)).toBe('resident')
    expect(field.residentBrickKeys()).toEqual([key])
    expect(field.residentBrick(key)?.length).toBe(SPARSE_VOXEL_BRICK_VOXELS)
    expect(field.allocationStats.residentBrickCount).toBe(1)
    expect(field.allocationStats.residentBytes).toBe(SPARSE_VOXEL_BRICK_BYTES)

    field.set(3, 3, 3, 2)
    expect(field.allocationStats.residentBrickCount).toBe(1)
  })

  it('returns a defensive resident copy that cannot bypass field bookkeeping', () => {
    const field = new SparseVoxelField(dims(8, 8, 8), 3)
    field.set(1, 1, 1, -1)
    field.setColumnTop(1, 1, 4)
    const key = field.brickKey(0, 0, 0)
    const address = field.addressOf(1, 1, 1)
    const valueBefore = field.get(1, 1, 1)
    const revisionBefore = field.revision
    const dirtyBefore = field.dirty
    const hwmBefore = field.getColumnTop(1, 1)

    const copy = field.residentBrick(key)!
    copy.fill(99)
    copy[address.brickOffset] = field.saturatedAirValue

    expect(field.get(1, 1, 1)).toBe(valueBefore)
    expect(field.residentBrick(key)?.[address.brickOffset]).toBe(valueBefore)
    expect(field.revision).toBe(revisionBefore)
    expect(field.dirty).toEqual(dirtyBefore)
    expect(field.getColumnTop(1, 1)).toBe(hwmBefore)
  })

  it('represents saturated-air bricks without residents and seeds later residents from air', () => {
    const field = new SparseVoxelField(dims(16, 8, 8), 3)
    const airKey = field.brickKey(1, 0, 0)

    field.markBrickSaturatedAir(airKey)
    expect(field.brickState(airKey)).toBe('saturated-air')
    expect(field.saturatedAirBrickKeys()).toEqual([airKey])
    expect(field.get(8, 0, 0)).toBe(Math.fround(-3))
    expect(field.get(15, 7, 7)).toBe(Math.fround(-3))
    expect(field.allocationStats).toMatchObject({
      residentBrickCount: 0,
      saturatedAirBrickCount: 1,
    })

    field.set(8, 0, 0, 1)
    expect(field.brickState(airKey)).toBe('resident')
    expect(field.get(8, 0, 0)).toBe(1)
    expect(field.get(9, 0, 0)).toBe(Math.fround(-3))
    expect(field.allocationStats).toMatchObject({
      residentBrickCount: 1,
      saturatedAirBrickCount: 0,
    })

    field.setColumnTop(8, 0, -1)
    field.markBrickImplicitStock(airKey)
    expect(field.brickState(airKey)).toBe('implicit-stock')
    expect(field.get(8, 0, 0)).toBe(0.5)
    expect(field.getColumnTop(8, 0)).toBe(7)
    expect(field.allocationStats.residentBrickCount).toBe(0)
  })

  it('fails before mutation when the bounded resident pool is exhausted', () => {
    const field = new SparseVoxelField(dims(16, 8, 8), 3, {
      maxResidentBricks: 1,
    })
    field.set(0, 0, 0, -1)
    const revisionBefore = field.revision
    const dirtyBefore = field.dirty
    const untouchedBefore = field.get(8, 0, 0)

    expect(() => field.set(8, 0, 0, -1)).toThrow(SparseVoxelPoolExhaustedError)
    expect(field.revision).toBe(revisionBefore)
    expect(field.dirty).toEqual(dirtyBefore)
    expect(field.get(8, 0, 0)).toBe(untouchedBefore)
    expect(field.allocationStats.residentBrickCount).toBe(1)

    expect(() => field.assertResidentCapacity(1)).toThrow(SparseVoxelPoolExhaustedError)
    expect(field.revision).toBe(revisionBefore)
  })
})

describe('SparseVoxelField sparse HWM and dirty revisions', () => {
  it('stores only lowered HWM overrides and conservatively raises them on solid writes', () => {
    const field = new SparseVoxelField(dims(8, 8, 16), 3)

    expect(field.getColumnTop(2, 3)).toBe(15)
    expect(field.allocationStats.columnTopOverrideCount).toBe(0)

    field.setColumnTop(2, 3, 4)
    expect(field.getColumnTop(2, 3)).toBe(4)
    expect(field.allocationStats.columnTopOverrideCount).toBe(1)

    field.set(2, 3, 7, 1)
    expect(field.getColumnTop(2, 3)).toBe(7)

    field.setColumnTop(2, 3, 15)
    expect(field.getColumnTop(2, 3)).toBe(15)
    expect(field.allocationStats.columnTopOverrideCount).toBe(0)

    field.setColumnTop(1, 1, -1)
    expect(field.getColumnTop(1, 1)).toBe(-1)
    expect(() => field.setColumnTop(1, 1, 16)).toThrow(SparseVoxelBoundsError)
  })

  it('tracks resident/page changes and refuses stale dirty acknowledgements', () => {
    const field = new SparseVoxelField(dims(8, 8, 8), 3)

    field.set(1, 1, 1, -1)
    expect(field.dirty).toEqual({
      revision: 1,
      fullReset: false,
      residentBrickKeys: [0],
      pageBrickKeys: [0],
    })
    field.clearDirty(1)
    expect(field.dirty).toEqual({
      revision: 1,
      fullReset: false,
      residentBrickKeys: [],
      pageBrickKeys: [],
    })

    field.set(1, 1, 1, -2)
    expect(field.dirty).toEqual({
      revision: 2,
      fullReset: false,
      residentBrickKeys: [0],
      pageBrickKeys: [],
    })
    expect(() => field.clearDirty(1)).toThrow(SparseVoxelRevisionError)
    expect(field.dirty.residentBrickKeys).toEqual([0])

    field.markBrickSaturatedAir(0)
    expect(field.dirty).toEqual({
      revision: 3,
      fullReset: false,
      residentBrickKeys: [],
      pageBrickKeys: [0],
    })
  })

  it('reset returns to implicit stock and publishes one full-reset revision', () => {
    const field = new SparseVoxelField(dims(16, 8, 8), 3)
    field.set(0, 0, 0, -1)
    field.markBrickSaturatedAir(field.brickKey(1, 0, 0))
    field.setColumnTop(0, 0, 2)
    const beforeReset = field.revision

    field.reset()

    expect(field.revision).toBe(beforeReset + 1)
    expect(field.dirty).toEqual({
      revision: beforeReset + 1,
      fullReset: true,
      residentBrickKeys: [],
      pageBrickKeys: [],
    })
    expect(field.allocationStats).toMatchObject({
      residentBrickCount: 0,
      saturatedAirBrickCount: 0,
      columnTopOverrideCount: 0,
    })
    expect(field.get(0, 0, 0)).toBe(0.5)
    expect(field.getColumnTop(0, 0)).toBe(7)
  })
})

describe('SparseVoxelField snapshot and restore', () => {
  it('deep-copies resident and air state in both snapshot directions', () => {
    const field = new SparseVoxelField(dims(16, 8, 8), 3)
    const residentKey = field.brickKey(0, 0, 0)
    const airKey = field.brickKey(1, 0, 0)
    field.set(1, 1, 1, -1)
    field.markBrickSaturatedAir(airKey)

    const snapshot = field.snapshot()
    expect(snapshot.kind).toBe(SPARSE_VOXEL_SNAPSHOT_KIND)
    expect(snapshot.byteLength).toBe(SPARSE_VOXEL_BRICK_BYTES + 16)

    field.set(1, 1, 1, -2)
    expect(snapshot.bricks.get(residentKey)?.[field.addressOf(1, 1, 1).brickOffset]).toBe(-1)

    field.restore(snapshot)
    expect(field.get(1, 1, 1)).toBe(-1)
    expect(field.brickState(airKey)).toBe('saturated-air')
    expect(field.dirty.fullReset).toBe(true)

    snapshot.bricks.get(residentKey)![field.addressOf(1, 1, 1).brickOffset] = 99
    expect(field.get(1, 1, 1)).toBe(-1)
  })

  it('rejects mismatched or malformed snapshots before changing live state', () => {
    const field = new SparseVoxelField(dims(8, 8, 8), 3)
    field.set(1, 1, 1, -1)
    const revisionBefore = field.revision
    const valueBefore = field.get(1, 1, 1)
    const dirtyBefore = field.dirty

    const other = new SparseVoxelField(dims(16, 8, 8), 3)
    expect(() => field.restore(other.snapshot())).toThrow(SparseVoxelSnapshotError)

    const malformed: SparseVoxelSnapshot = {
      kind: SPARSE_VOXEL_SNAPSHOT_KIND,
      dimsSignature: field.dimsSignature,
      band: field.band,
      bricks: new Map([[0, new Float32Array(7)]]),
      airBrickKeys: new Set(),
      byteLength: 28,
    }
    expect(() => field.restore(malformed)).toThrow(SparseVoxelSnapshotError)

    const overlap: SparseVoxelSnapshot = {
      kind: SPARSE_VOXEL_SNAPSHOT_KIND,
      dimsSignature: field.dimsSignature,
      band: field.band,
      bricks: new Map([[0, new Float32Array(SPARSE_VOXEL_BRICK_VOXELS)]]),
      airBrickKeys: new Set([0]),
      byteLength: SPARSE_VOXEL_BRICK_BYTES + 16,
    }
    expect(() => field.restore(overlap)).toThrow(SparseVoxelSnapshotError)

    expect(field.revision).toBe(revisionBefore)
    expect(field.get(1, 1, 1)).toBe(valueBefore)
    expect(field.dirty).toEqual(dirtyBefore)
  })

  it('rejects a snapshot larger than the target pool before mutation', () => {
    const source = new SparseVoxelField(dims(16, 8, 8), 3, {
      maxResidentBricks: 2,
    })
    source.set(0, 0, 0, -1)
    source.set(8, 0, 0, -1)

    const target = new SparseVoxelField(dims(16, 8, 8), 3, {
      maxResidentBricks: 1,
    })
    const revisionBefore = target.revision

    expect(() => target.restore(source.snapshot())).toThrow(SparseVoxelPoolExhaustedError)
    expect(target.revision).toBe(revisionBefore)
    expect(target.allocationStats.residentBrickCount).toBe(0)
  })

  it('rejects unsupported snapshot tags explicitly', () => {
    const field = new SparseVoxelField(dims(8, 8, 8), 3)
    const wrongKind = {
      ...field.snapshot(),
      kind: 'sparse-voxel-future',
    } as unknown as SparseVoxelSnapshot

    expect(() => field.restore(wrongKind)).toThrow(SparseVoxelSnapshotError)
    expect(field.revision).toBe(0)
  })
})
