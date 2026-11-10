import {
  Archive, Bell, BookOpen, Bookmark, Bot, Box, Calendar, Camera, ChartColumn, CircleCheck, Clock, Cloud, Code, Copy, Cpu,
  Database, DollarSign, Download, HardDrive, File, FileText, Film, Flame, Folder, GitBranch, Globe, Heart, House, Image, Key,
  Languages, Link, List, Lock, Mail, Map as MapIcon, MessageSquare, Monitor, Moon, Music, Package, PenLine, Smartphone, Play, Printer,
  Puzzle, RefreshCw, Rocket, Scissors, Search, Send, Server, Settings, Shield, ShoppingCart, Sparkles, Star, Sun, Table,
  Terminal, Timer, Trash2, Upload, User, Users, WandSparkles, Wifi, Wrench, Zap, ScrollText, type LucideIcon,
} from "lucide-react";
import type { Script } from "./api";

/** The SDK's icon names (ICONS in yenae-script) mapped to drawn icons. */
const ICONS: Record<string, LucideIcon> = {
  archive: Archive, bell: Bell, book: BookOpen, bookmark: Bookmark, bot: Bot, box: Box, calendar: Calendar, camera: Camera,
  chart: ChartColumn, check: CircleCheck, clock: Clock, cloud: Cloud, code: Code, copy: Copy, cpu: Cpu, database: Database,
  dollar: DollarSign, download: Download, drive: HardDrive, file: File, "file-text": FileText, film: Film, flame: Flame,
  folder: Folder, git: GitBranch, globe: Globe, heart: Heart, home: House, image: Image, key: Key, languages: Languages,
  link: Link, list: List, lock: Lock, mail: Mail, map: MapIcon, message: MessageSquare, monitor: Monitor, moon: Moon,
  music: Music, package: Package, pen: PenLine, phone: Smartphone, play: Play, printer: Printer, puzzle: Puzzle,
  refresh: RefreshCw, rocket: Rocket, scissors: Scissors, search: Search, send: Send, server: Server, settings: Settings,
  shield: Shield, shopping: ShoppingCart, sparkles: Sparkles, star: Star, sun: Sun, table: Table, terminal: Terminal,
  timer: Timer, trash: Trash2, upload: Upload, user: User, users: Users, wand: WandSparkles, wifi: Wifi, wrench: Wrench, zap: Zap,
};

/**
 * Packet colours. Each script keeps its colour (it starts from a hash of its id), and
 * colours are handed out so none repeats until all are used. Red and orange are left
 * out on purpose: red means "failed".
 */
export const HUES = 10;
let hues = new Map<string, number>();
let hueKey = "";
export function setHueIds(ids: string[]) {
  const sorted = [...ids].sort();
  const key = sorted.join("\n");
  if (key === hueKey) return;
  hueKey = key;
  hues = new Map();
  let used = new Set<number>();
  for (const id of sorted) {
    if (used.size === HUES) used = new Set();
    let h = hashHue(id);
    while (used.has(h)) h = (h + 1) % HUES;
    used.add(h);
    hues.set(id, h);
  }
}
function hashHue(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % HUES;
}
export const hueOf = (id: string) => hues.get(id) ?? hashHue(id);

export function Glyph({ script, size = 26 }: { script: Pick<Script, "name" | "icon">; size?: number }) {
  const Icon = script.icon ? ICONS[script.icon] : undefined;
  // No icon chosen: a generic script page, not a lone letter that reads like a placeholder.
  const Shown = Icon ?? ScrollText;
  return <Shown size={size} strokeWidth={1.9} aria-hidden />;
}

/** A small square in the script's packet colour with its icon, for lists and folder fronts. */
export function ScriptIcon({ script, size = 40 }: { script: Pick<Script, "id" | "name" | "icon">; size?: number }) {
  return (
    <span className={`glyph hue-${hueOf(script.id)}`} style={{ width: size, height: size, borderRadius: Math.round(size / 4.5) }} aria-hidden>
      <Glyph script={script} size={Math.round(size * 0.52)} />
    </span>
  );
}
