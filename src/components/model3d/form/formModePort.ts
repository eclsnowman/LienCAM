// WO-3301: the Form session, as the New UI ribbon reads it (see ./modePort).
import { createModePort } from './modePort'
import type { FormSession } from './useFormSession'

export const formModePort = createModePort<FormSession>()
