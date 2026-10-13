/// <reference types="vite/client" />
declare module "*.mod?inline" { const url: string; export default url; }
declare module "*.xm?inline" { const url: string; export default url; }

/** the version from package.json, injected by Vite */
declare const __APP_VERSION__: string;
