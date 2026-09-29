// Convenience launcher only. All application/backend behavior runs in Python.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function pythonCommand() {
  const local = path.join(root, 'backend', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  return process.env.PANTRY_PYTHON || (fs.existsSync(local) ? local : process.platform === 'win32' ? 'python' : 'python3');
}
export function backendEnv(extra = {}) {
  const env = { ...process.env, PYTHONPATH: path.join(root, 'backend'), ...extra };
  delete env.NODE_TLS_REJECT_UNAUTHORIZED;
  return env;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...rest] = process.argv.slice(2);
  const args = mode === '--test' ? ['-m', 'pytest', '-c', 'backend/pyproject.toml', 'backend/tests', ...rest] : mode === '--migrate' ? ['-m', 'pantry.migration', ...rest] : ['-m', 'pantry', ...process.argv.slice(2)];
  const child = spawn(pythonCommand(), args, { cwd: root, stdio: 'inherit', env: backendEnv() });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', () => { console.error('Python could not start. Follow the backend setup in README.md.'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
