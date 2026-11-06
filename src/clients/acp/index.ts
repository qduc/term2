/** Direct ACP entry points. App composition supplies the direct Host and workspace authority. */
export { createAcpAgent } from './agent.js';
export type { AcpAgentOptions } from './agent.js';
export { createAcpBackend } from './session-backend.js';
export { createStdioAcpIo, serveAcp } from './serve.js';
export type { AcpIo } from './serve.js';
export type { AcpBackend, AcpLogger, AcpWorkspaces, BackendOptions } from './contract.js';
