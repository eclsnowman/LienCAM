// WO-3301: the Relief session, as the New UI ribbon reads it (see ../form/modePort).
import { createModePort } from '../form/modePort'
import type { ReliefSession } from './useReliefSession'

export const reliefModePort = createModePort<ReliefSession>()
