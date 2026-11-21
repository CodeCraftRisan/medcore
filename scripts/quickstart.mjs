import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const envPath = '.env';
let env = readFileSync(existsSync(envPath) ? envPath : '.env.example', 'utf8');

function get(key) {
  return new RegExp('^' + key + '=(.*)$', 'm').exec(env)?.[1]?.trim();
}

function set(key, value) {
  const line = new RegExp('^' + key + '=.*$', 'm');
  if (line.test(env)) env = env.replace(line, () => key + '=' + value);
  else env += '\n' + key + '=' + value + '\n';
}

if (!get('JWT_ACCESS_SECRET'))
  set('JWT_ACCESS_SECRET', randomBytes(32).toString('hex'));
if (!get('PRESCRIPTION_KEKS') || get('PRESCRIPTION_KEKS') === '{}') {
  const id = get('PRESCRIPTION_ACTIVE_KEK_ID') || 'kek-v1';
  set(
    'PRESCRIPTION_KEKS',
    JSON.stringify({ [id]: randomBytes(32).toString('base64') }),
  );
}

if (!get('AUDIT_ANCHOR_PRIVATE_KEY') && !get('AUDIT_ANCHOR_PUBLIC_KEY')) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  set(
    'AUDIT_ANCHOR_PRIVATE_KEY',
    privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  );
  set(
    'AUDIT_ANCHOR_PUBLIC_KEY',
    publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  );
}
writeFileSync(envPath, env, { mode: 0o600 });

function run(command, args, environment = process.env) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: environment,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run npm run quickstart');
run('docker', ['compose', 'up', '-d', '--wait']);
run(process.execPath, [npm, 'ci']);
run(process.execPath, [npm, 'test'], {
  ...process.env,
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent',
});
