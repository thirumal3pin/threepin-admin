// Starts the Firestore emulator (a Java program), runs the rule tests against it, stops it.
//   cd tests/rules && npm test
// Needs Java (JAVA_HOME, or `java` on PATH) and the emulator jar — downloaded once to
// ~/.cache/firebase/emulators/ if it is not there yet. Nothing here touches the live database.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, createWriteStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const VERSION = '1.19.8';
const DIR = join(homedir(), '.cache', 'firebase', 'emulators');
const JAR = join(DIR, `cloud-firestore-emulator-v${VERSION}.jar`);
const URL_ = `https://storage.googleapis.com/firebase-preview-drop/emulator/cloud-firestore-emulator-v${VERSION}.jar`;
const PORT = 8181;
const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', 'java') : 'java';

if (!existsSync(JAR)) {
  mkdirSync(DIR, { recursive: true });
  console.log('Downloading the Firestore emulator once…');
  const res = await fetch(URL_);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(JAR));
}

const emu = spawn(java, ['-jar', JAR, '--host', '127.0.0.1', '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
emu.stdout.on('data', d => { log += d; });
emu.stderr.on('data', d => { log += d; });

const up = () => new Promise(res => {
  const s = net.connect(PORT, '127.0.0.1', () => { s.end(); res(true); });
  s.on('error', () => res(false));
});
const t0 = Date.now();
while (!(await up())) {
  if (emu.exitCode !== null || Date.now() - t0 > 60000) {
    console.error('The emulator did not start:\n' + log);
    process.exit(1);
  }
  await new Promise(r => setTimeout(r, 300));
}

const tests = spawn(process.execPath, ['--test', '--test-concurrency=1', 'rules.test.mjs'], { stdio: 'inherit' });
const code = await new Promise(res => tests.on('exit', res));
emu.kill();
process.exit(code);
