// Lists the biggest files in a folder you pick.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ask, show } from "yenae-script";

const dir = await ask.folder("Folder to measure");
const rows = readdirSync(dir)
  .map((f) => {
    try {
      const s = statSync(join(dir, f));
      return s.isFile() ? { file: f, kb: Math.round(s.size / 1024) } : null;
    } catch {
      return null;
    }
  })
  .filter((r): r is { file: string; kb: number } => !!r)
  .sort((a, b) => b.kb - a.kb)
  .slice(0, 20);
show.table(rows);
