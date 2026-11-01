import { resolve } from 'node:path'

export const config = {
  runner: 'local',
  framework: 'mocha',
  specs: ['./tests/desktop.e2e.mjs'],
  maxInstances: 1,
  logLevel: 'warn',
  waitforTimeout: 15000,
  connectionRetryTimeout: 30000,
  connectionRetryCount: 0,
  mochaOpts: { timeout: 150000 },
  services: [
    [
      '@wdio/tauri-service',
      { driverProvider: 'embedded', captureBackendLogs: true, captureFrontendLogs: true },
    ],
  ],
  capabilities: [
    {
      browserName: 'tauri',
      'tauri:options': {
        application: resolve(
          process.env.SAY_CLEAR_E2E_APPLICATION ??
            `src-tauri/target/debug/say-clear${process.platform === 'win32' ? '.exe' : ''}`,
        ),
      },
    },
  ],
}
