// WO-1987: installing the LinuxCNC backend for the `linuxcnc`/`gateway` route
// (backendRegistry.ts). machineSession attaches this as that route's connector.

import type { BackendConnectContext } from '../backendRegistry'
import { LinuxcncGatewayTransport, linuxcncGatewayUrl, parseLinuxcncGatewayAddress } from './gatewayTransport'
import { LinuxCncController } from './linuxcncController'

/** Install a LinuxCncController and connect it to the gateway. `url` defaults
 *  to the address the machine definition states (WO-2101) - the LinuxCNC PC
 *  on the network - or, stating none, gateway.py's default port on this
 *  computer. */
export async function connectLinuxcncBackend(
  context: BackendConnectContext,
  url: string = linuxcncGatewayUrlFor(context.machine.linuxcncGatewayAddress),
  transport: LinuxcncGatewayTransport = new LinuxcncGatewayTransport(url),
): Promise<LinuxCncController> {
  const installed = context.install((events) => new LinuxCncController(events))
  await installed.controller.connect({ kind: 'messages', transport })
  return installed.controller
}

function linuxcncGatewayUrlFor(address: string | undefined): string {
  const { host, port } = parseLinuxcncGatewayAddress(address)
  return linuxcncGatewayUrl(port, host)
}
