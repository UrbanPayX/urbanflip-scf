import { defineConfig } from 'vitest/config';

/**
 * The authorization path (SCF D1 completion criterion #3: ">= 90% coverage on
 * the authorization path"): the code that decides and executes trustline
 * authorization and offboarding.
 *
 *   compliance gate port + adapters   decides: approved / rejected / pending / unavailable
 *   TrustlineAuthorizer               executes: authorize (gate first), freeze, clawback
 *   clawback journal + in-flight guard  clawback exactly once per clawbackId
 *   pending-tx resolution             a PENDING tx: applied / never applies / may still apply
 *   IssuerProvisioner                 flags (REQUIRED|REVOCABLE|CLAWBACK) before any trustline
 *   TxSubmitter                       rejected (did not apply) vs unknown (may apply)
 *
 * Every file listed here must reach 90% statements, branches, functions and
 * lines on its own; `npm run coverage` fails otherwise. The rest of src/ is
 * reported but not held to the threshold (settlement, SEP-1, stores other than
 * the clawback journal, audit log, config and the composition root).
 */
export const AUTHORIZATION_PATH = [
  'src/gate/compliance-gate.ts',
  'src/gate/static-gate.ts',
  'src/gate/urbanflip-gate.ts',
  'src/issuance/trustline-authorizer.ts',
  'src/store/clawback-store.ts',
  'src/issuance/in-flight.ts',
  'src/issuance/pending-tx.ts',
  'src/issuance/issuer-provisioner.ts',
  'src/stellar/tx-submitter.ts',
] as const;

const NINETY_PER_FILE = { statements: 90, branches: 90, functions: 90, lines: 90, perFile: true };

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      // skipFull: false so 100%-covered authorization-path files still appear in the console table
      reporter: [['text', { skipFull: false }], 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      // src/types.ts holds type declarations only (no runtime code to cover).
      exclude: ['test/**', '**/*.test.ts', 'demo/**', 'src/testkit/**', 'dist/**', 'src/types.ts'],
      thresholds: Object.fromEntries(AUTHORIZATION_PATH.map((file) => [file, NINETY_PER_FILE])),
    },
  },
});
