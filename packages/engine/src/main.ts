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
  // An earlier Yenae Script engine still running holds it: exit 3 so the app stops that one.
  if (await isOurEngine(engine.settings.port, engine.settings.token)) process.exit(3);
  // Something else has it (on Windows, often a range reserved by Hyper-V or WSL): move to a
  // free port and keep it, so the address AI apps were given stays the same from now on.
  try {
    engine.setPort(0);
    server = serve(engine);
    engine.setPort(server.port!);
    console.error(`Moved to port ${server.port}`);
  } catch (e2: any) {
    console.error(`Can't listen on any port: ${e2?.message ?? e2}`);
    process.exit(4);
  }
}
engine.start();
console.log(`YENAE_READY ${JSON.stringify({ port: server.port, token: engine.settings.token, workspace: engine.settings.workspace })}`);

async function isOurEngine(port: number, token: string) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/busy`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

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
