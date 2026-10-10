import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs helper shared with pendant/server.mjs
import { orderLanIps } from '../../../pendant/lanIps.mjs'

describe('pendant pairing address', () => {
  it('puts the card that carries the default route first, not the controller link', () => {
    // Operator 09-25: the pendant offered 192.0.2.10, the AXBB-E controller card.
    expect(orderLanIps(['192.0.2.10', '192.0.2.17'], '192.0.2.17')).toEqual(['192.0.2.17', '192.0.2.10'])
  })

  it('keeps the OS order when no route is known', () => {
    expect(orderLanIps(['192.0.2.10', '192.0.2.17'], null)).toEqual(['192.0.2.10', '192.0.2.17'])
  })
})
