// WO-425 - the VFD link. One import point for the rest of the product.
//
// The spindle on this machine is a Modbus inverter on its own serial link, not
// a controller output. Nothing here talks to a port: the bridge does that
// (pendant/uccnc-bridge/Vfd.cs). This is the definition format, the arithmetic
// and the safety rules.

export * from './vfdDefinition'
export * from './vfdExpr'
export * from './vfdRuntime'
export * from './vfdSafety'
export * from './huanyangGt'
