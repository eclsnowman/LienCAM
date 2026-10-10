import { PendantBridgeClient } from './pendantBridge'
import { executePendantMachineCommand } from './pendantMachine'

/** One session-local bridge authority for the retained Control workspace. */
export const pendantBridge = new PendantBridgeClient(executePendantMachineCommand)

