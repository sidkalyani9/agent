import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };
delete env.NODE_TLS_REJECT_UNAUTHORIZED;
const children = [
  spawn(process.execPath, ["--watch", "server/index.js"], { cwd: root, stdio: "inherit", env }),
  spawn(process.execPath, ["node_modules/vite/bin/vite.js"], { cwd: root, stdio: "inherit", env }),
];

function stop() {
  for (const child of children) child.kill();
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
