import { defineConfig } from 'vitest/config';

/**
 * The computation logic (SCF D3 completion criterion #3: "Test coverage >=90%
 * on computation logic"): the exact money arithmetic, both allocation models
 * and both replays.
 *
 *   money/stroops        exact decimals, half-up division, unit conversion
 *   compute/pro-rata     principal + interest pro-rata, dust policies
 *   compute/replay       replay of the simple model
 *   compute/waterfall    Urbanflip's participative-loan waterfall
 *   compute/waterfall-replay  replay of the 3 real deals, every component
 *
 * Every file listed here must reach 90% statements, branches, functions and
 * lines on its own; `npm run coverage` fails otherwise. The rest of src/ (USDC
 * conversion and SDP emission, trustline checker, HTTP facade) is reported but
 * not held to the threshold.
 */
export const COMPUTATION_LOGIC = [
  'src/money/stroops.ts',
  'src/compute/pro-rata.ts',
  'src/compute/replay.ts',
  'src/compute/waterfall.ts',
  'src/compute/waterfall-replay.ts',
] as const;

const NINETY_PER_FILE = { statements: 90, branches: 90, functions: 90, lines: 90, perFile: true };

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: [['text', { skipFull: false }], 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: ['test/**', 'demo/**', 'tools/**'],
      thresholds: Object.fromEntries(COMPUTATION_LOGIC.map((file) => [file, NINETY_PER_FILE])),
    },
  },
});
