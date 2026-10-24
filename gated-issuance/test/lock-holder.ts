/**
 * Test fixture, run as a separate process (node --import tsx): opens a JSON
 * state store and prints "ready <pid>". With "exit" it then exits normally
 * (the lock must be released); otherwise it holds the lock until killed.
 */
import { JsonFileClawbackStore } from '../src/store/clawback-store';

const [path, mode] = process.argv.slice(2);
try {
  new JsonFileClawbackStore(path!);
} catch (err) {
  process.stdout.write(`error ${(err as Error).message}\n`);
  process.exit(1);
}
process.stdout.write(`ready ${process.pid}\n`);
if (mode === 'exit') process.exit(0);
setInterval(() => undefined, 1 << 30);
