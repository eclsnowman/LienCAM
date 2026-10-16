// Where a Help capture run keeps its evidence. WO-2491 shot the first refresh;
// a later picture run (WO-2848, alpha.2 G8) sets HELP_EVIDENCE to its own
// folder so it never writes into another order's evidence.
export const HELP_EVIDENCE = (process.env.HELP_EVIDENCE || 'src/tests/evidence/WO-2491').replaceAll('\\', '/').replace(/\/$/, '')
