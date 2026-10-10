import { textFor, useText } from '../../i18n'
import { useMemo } from 'react'

const shellText = textFor('app-shell-settings-menus')

// Fixed QR version 10-L comfortably fits the LAN pairing URL while keeping the
// encoder small, deterministic, offline, and free of another runtime package.
const VERSION = 10
const SIZE = VERSION * 4 + 17
const DATA_CODEWORDS = 274
const ECC_CODEWORDS = 18
const BLOCK_DATA_LENGTHS = [68, 68, 69, 69] as const

function appendBits(target: number[], value: number, count: number) {
  for (let bit = count - 1; bit >= 0; bit--) target.push((value >>> bit) & 1)
}

function gfMultiply(left: number, right: number): number {
  let product = 0
  for (let bit = 7; bit >= 0; bit--) {
    product = (product << 1) ^ ((product >>> 7) * 0x11d)
    product ^= ((right >>> bit) & 1) * left
  }
  return product
}

function reedSolomonDivisor(degree: number): Uint8Array {
  const result = new Uint8Array(degree)
  result[degree - 1] = 1
  let root = 1
  for (let index = 0; index < degree; index++) {
    for (let term = 0; term < degree; term++) {
      result[term] = gfMultiply(result[term], root)
      if (term + 1 < degree) result[term] ^= result[term + 1]
    }
    root = gfMultiply(root, 2)
  }
  return result
}

function reedSolomonRemainder(data: Uint8Array): Uint8Array {
  const divisor = reedSolomonDivisor(ECC_CODEWORDS)
  const result = new Uint8Array(ECC_CODEWORDS)
  for (const value of data) {
    const factor = value ^ result[0]
    result.copyWithin(0, 1)
    result[result.length - 1] = 0
    for (let index = 0; index < result.length; index++) {
      result[index] ^= gfMultiply(divisor[index], factor)
    }
  }
  return result
}

function makeCodewords(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value)
  const bits: number[] = []
  appendBits(bits, 0b0100, 4)
  appendBits(bits, bytes.length, 16)
  for (const byte of bytes) appendBits(bits, byte, 8)
  const capacity = DATA_CODEWORDS * 8
  if (bits.length > capacity) throw new Error(shellText('LocalQrCode.pendantPairingURLIsTooLongForTheLocal'))
  for (let count = Math.min(4, capacity - bits.length); count > 0; count--) bits.push(0)
  while (bits.length % 8 !== 0) bits.push(0)
  const data: number[] = []
  for (let offset = 0; offset < bits.length; offset += 8) {
    data.push(Number.parseInt(bits.slice(offset, offset + 8).join(''), 2))
  }
  for (let pad = 0; data.length < DATA_CODEWORDS; pad++) data.push(pad % 2 === 0 ? 0xec : 0x11)

  const blocks: Uint8Array[] = []
  const eccBlocks: Uint8Array[] = []
  let offset = 0
  for (const length of BLOCK_DATA_LENGTHS) {
    const block = Uint8Array.from(data.slice(offset, offset + length))
    blocks.push(block)
    eccBlocks.push(reedSolomonRemainder(block))
    offset += length
  }
  const interleaved: number[] = []
  for (let index = 0; index < 69; index++) {
    for (const block of blocks) if (index < block.length) interleaved.push(block[index])
  }
  for (let index = 0; index < ECC_CODEWORDS; index++) {
    for (const block of eccBlocks) interleaved.push(block[index])
  }
  return Uint8Array.from(interleaved)
}

function makeQrMatrix(value: string): boolean[][] {
  const modules = Array.from({ length: SIZE }, () => Array<boolean>(SIZE).fill(false))
  const functionModule = Array.from({ length: SIZE }, () => Array<boolean>(SIZE).fill(false))
  const setFunction = (x: number, y: number, dark: boolean) => {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return
    modules[y][x] = dark
    functionModule[y][x] = true
  }
  const finder = (centerX: number, centerY: number) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const distance = Math.max(Math.abs(dx), Math.abs(dy))
      setFunction(centerX + dx, centerY + dy, distance !== 2 && distance !== 4)
    }
  }
  finder(3, 3)
  finder(SIZE - 4, 3)
  finder(3, SIZE - 4)

  for (const centerY of [6, 28, 50]) for (const centerX of [6, 28, 50]) {
    if (functionModule[centerY][centerX]) continue
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      setFunction(centerX + dx, centerY + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }
  }
  for (let index = 0; index < SIZE; index++) {
    if (!functionModule[6][index]) setFunction(index, 6, index % 2 === 0)
    if (!functionModule[index][6]) setFunction(6, index, index % 2 === 0)
  }

  let versionRemainder = VERSION
  for (let index = 0; index < 12; index++) {
    versionRemainder = (versionRemainder << 1) ^ ((versionRemainder >>> 11) * 0x1f25)
  }
  const versionBits = (VERSION << 12) | versionRemainder
  for (let index = 0; index < 18; index++) {
    const dark = ((versionBits >>> index) & 1) !== 0
    const first = SIZE - 11 + (index % 3)
    const second = Math.floor(index / 3)
    setFunction(first, second, dark)
    setFunction(second, first, dark)
  }

  // Error correction L (01) with mask 0, including the required XOR mask.
  const formatData = 0b01000
  let formatRemainder = formatData << 10
  for (let bit = 14; bit >= 10; bit--) {
    if (((formatRemainder >>> bit) & 1) !== 0) formatRemainder ^= 0x537 << (bit - 10)
  }
  const formatBits = ((formatData << 10) | formatRemainder) ^ 0x5412
  const formatBit = (index: number) => ((formatBits >>> index) & 1) !== 0
  for (let index = 0; index <= 5; index++) setFunction(8, index, formatBit(index))
  setFunction(8, 7, formatBit(6))
  setFunction(8, 8, formatBit(7))
  setFunction(7, 8, formatBit(8))
  for (let index = 9; index < 15; index++) setFunction(14 - index, 8, formatBit(index))
  for (let index = 0; index < 8; index++) setFunction(SIZE - 1 - index, 8, formatBit(index))
  for (let index = 8; index < 15; index++) setFunction(8, SIZE - 15 + index, formatBit(index))
  setFunction(8, SIZE - 8, true)

  const codewords = makeCodewords(value)
  const dataBits: number[] = []
  for (const byte of codewords) appendBits(dataBits, byte, 8)
  let bitIndex = 0
  let upward = true
  for (let right = SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vertical = 0; vertical < SIZE; vertical++) {
      const y = upward ? SIZE - 1 - vertical : vertical
      for (let offsetX = 0; offsetX < 2; offsetX++) {
        const x = right - offsetX
        if (functionModule[y][x]) continue
        const source = bitIndex < dataBits.length ? dataBits[bitIndex] !== 0 : false
        modules[y][x] = source !== ((x + y) % 2 === 0)
        bitIndex++
      }
    }
    upward = !upward
  }
  return modules
}

export function LocalQrCode({ value, size = 164 }: { value: string; size?: number }) {
  useText('app-shell-settings-menus')
  const matrix = useMemo(() => makeQrMatrix(value), [value])
  const quiet = 4
  const path = matrix.flatMap((row, y) => row.flatMap((dark, x) => (
    dark ? [`M${x + quiet} ${y + quiet}h1v1h-1z`] : []
  ))).join('')
  const viewSize = SIZE + quiet * 2
  return (
    <svg
      className="pendant-qr"
      width={size}
      height={size}
      viewBox={`0 0 ${viewSize} ${viewSize}`}
      role="img"
      aria-label={shellText('LocalQrCode.mobilePendantPairingQRCode')}
      shapeRendering="crispEdges"
    >
      <rect width={viewSize} height={viewSize} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  )
}
