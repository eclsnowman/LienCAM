// WO-3009: the independent reader ships no types; only what parse.ts calls.
declare module 'gcode-toolpath' {
  interface Point3 { x: number; y: number; z: number }
  interface Modal { motion: string; plane: string; units: string; [key: string]: string }
  // The constructor returns the cncjs Interpreter it drives.
  export default class Toolpath {
    constructor(options: {
      addLine: (modal: Modal, start: Point3, end: Point3) => void
      addArcCurve: (modal: Modal, start: Point3, end: Point3, centre: Point3) => void
    })
    getModal(): Modal
    loadFromStringSync(text: string, callback: (data: { words: [string, number | string][]; line: string; cmds?: string[]; ln?: number }) => void): unknown[]
  }
}
