// WO-3026 (alpha.3 A3-12): the 3D lane's move record as the kernel linkers emit it.
// A structural copy of src/cam3d/ir/types.ts IrMove / IrMoveRole (the kernel may not
// import cam3d); the parity test pins the two together, field for field.

/** The 3D lane's 8 roles (the IR roles today's 3D linkers emit). */
export type IrMoveRole =
  | 'rapid'
  | 'cut'
  | 'plunge'
  | 'ramp'
  | 'lead_in'
  | 'lead_out'
  | 'stepover'
  | 'finish'

export type IrMove = {
  t: 'rapid' | 'feed' | 'arc'
  x: number
  y: number
  z: number
  f?: number
  i?: number
  j?: number
  cw?: boolean
  role?: IrMoveRole
}
