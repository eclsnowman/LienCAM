// Shipped embedded-WASM factory; the package only declares its public wrappers.
declare module '@opencamlib/opencamlib/build/ocl.js' {
  const createModule: () => Promise<unknown>;
  export default createModule;
}
