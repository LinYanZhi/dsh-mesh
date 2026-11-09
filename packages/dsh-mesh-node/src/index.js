export { startMeshServer, buildMcpServer } from './server.js'
export {
  MESH_VERSION,
  CONFIG_VERSION,
  DEFAULT_ALLOW,
  meshHome,
  loadConfig,
  saveConfig,
  loadSecrets,
  configPath,
  secretsPath,
  defaultConfig,
  createConfigLoader,
  verifyBearer,
  isInsideRoots
} from './core/config.js'
export { makeAudit, tailAudit, auditPath } from './core/audit.js'
export { JobRunner, pruneJobs, TERMINAL_STATES } from './core/jobs.js'
export { buildAll, toolNames, isAllowed, dispatch, registerTools } from './tools/index.js'
export { runSelftest } from './selftest.js'
