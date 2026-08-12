/**
 * The CLI as a library, so tests drive it without a subprocess.
 *
 * `bin` points at `main.ts`; everything it needs is exported here.
 */
export { run, USAGE, type RunOptions } from './cli.ts'
export { EXIT_CODES, exitCodeForApiError, type ExitCode } from './exit-codes.ts'
export {
  CLI_CLIENT_ID,
  DEFAULT_LOGIN_SCOPES,
  parseScopes,
  type CommandContext,
} from './commands.ts'
export {
  createCredentialStore,
  credentialPath,
  describeProtection,
  type CredentialStore,
  type Protection,
  type StoredCredential,
} from './credentials.ts'
export {
  ApiClient,
  CliError,
  pollForDeviceToken,
  refreshAccessToken,
  requestDeviceAuthorization,
  type DeviceAuthorization,
  type DeviceToken,
} from './client.ts'
