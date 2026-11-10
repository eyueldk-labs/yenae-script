/**
 * Yenae Script engine. The desktop app starts it as a background process:
 *
 *   bun main.js --data <app data dir> [--workspace <dir>] [--port 47321] [--exit-with-stdin]
 *
 * It prints one line, `YENAE_READY {"port":…,"token":…}`, once it is listening.
 */
import { resolve } from "node:path";
import { Engine } from "./engine";
import { serve } from "./server";

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const data = resolve(arg("data") ?? ".yenae-data");
const workspace = arg("workspace");
const port = arg("port") ? Number(arg("port")) : undefined;

const engine = new Engine(data, { workspace: workspace ? resolve(workspace) : undefined, port });
let server;
try {
  server = serve(engine);
} catch (e: any) {
  console.error(`Can't listen on port ${engine.settings.port}: ${e?.message ?? e}`);
  process.exit(3);
}
engine.start();
console.log(`YENAE_READY ${JSON.stringify({ port: server.port, token: engine.settings.token, workspace: engine.settings.workspace })}`);

const shutdown = () => {
  engine.stop();
  setTimeout(() => process.exit(0), 200);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// The app passes --exit-with-stdin and closes our stdin when it quits, so we never outlive it.
if (process.argv.includes("--exit-with-stdin")) {
  process.stdin.on("end", shutdown);
  process.stdin.resume();
}
