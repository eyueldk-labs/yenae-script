import {
  Archive, Bell, BookOpen, Bookmark, Bot, Box, Calendar, Camera, ChartColumn, CircleCheck, Clock, Cloud, Code, Copy, Cpu,
  Database, DollarSign, Download, HardDrive, File, FileText, Film, Flame, Folder, GitBranch, Globe, Heart, House, Image, Key,
  Languages, Link, List, Lock, Mail, Map, MessageSquare, Monitor, Moon, Music, Package, PenLine, Smartphone, Play, Printer,
  Puzzle, RefreshCw, Rocket, Scissors, Search, Send, Server, Settings, Shield, ShoppingCart, Sparkles, Star, Sun, Table,
  Terminal, Timer, Trash2, Upload, User, Users, WandSparkles, Wifi, Wrench, Zap, type LucideIcon,
} from "lucide-react";
import type { Script } from "./api";

/** The SDK's icon names (ICONS in yenae-script) mapped to drawn icons. */
const ICONS: Record<string, LucideIcon> = {
  archive: Archive, bell: Bell, book: BookOpen, bookmark: Bookmark, bot: Bot, box: Box, calendar: Calendar, camera: Camera,
  chart: ChartColumn, check: CircleCheck, clock: Clock, cloud: Cloud, code: Code, copy: Copy, cpu: Cpu, database: Database,
  dollar: DollarSign, download: Download, drive: HardDrive, file: File, "file-text": FileText, film: Film, flame: Flame,
  folder: Folder, git: GitBranch, globe: Globe, heart: Heart, home: House, image: Image, key: Key, languages: Languages,
  link: Link, list: List, lock: Lock, mail: Mail, map: Map, message: MessageSquare, monitor: Monitor, moon: Moon,
  music: Music, package: Package, pen: PenLine, phone: Smartphone, play: Play, printer: Printer, puzzle: Puzzle,
  refresh: RefreshCw, rocket: Rocket, scissors: Scissors, search: Search, send: Send, server: Server, settings: Settings,
  shield: Shield, shopping: ShoppingCart, sparkles: Sparkles, star: Star, sun: Sun, table: Table, terminal: Terminal,
  timer: Timer, trash: Trash2, upload: Upload, user: User, users: Users, wand: WandSparkles, wifi: Wifi, wrench: Wrench, zap: Zap,
};

/** Eight tile colours; a script keeps the same one because it comes from its id. */
export const HUES = 8;
export function hueOf(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % HUES;
}

/** A script's tile: its icon, or the first letter of its name, on its colour. */
export function ScriptIcon({ script, size = 52 }: { script: Pick<Script, "id" | "name" | "icon">; size?: number }) {
  const Icon = script.icon ? ICONS[script.icon] : undefined;
  return (
    <span className={`glyph hue-${hueOf(script.id)}`} style={{ width: size, height: size, borderRadius: Math.round(size / 4.2) }} aria-hidden>
      {Icon ? <Icon size={Math.round(size * 0.48)} strokeWidth={1.8} /> : <span className="letter" style={{ fontSize: Math.round(size * 0.42) }}>{[...script.name.trim()][0]?.toUpperCase() ?? "?"}</span>}
    </span>
  );
}

/** A folder's tile: small versions of its first four scripts' icons. */
export function FolderIcon({ scripts, size = 52 }: { scripts: Pick<Script, "id" | "name" | "icon">[]; size?: number }) {
  const pad = Math.round(size / 8);
  const mini = Math.floor((size - pad * 2 - 3) / 2);
  return (
    <span className="glyph folder-glyph" style={{ width: size, height: size, borderRadius: Math.round(size / 4.2), padding: pad }} aria-hidden>
      {scripts.slice(0, 4).map((s) => (
        <ScriptIcon key={s.id} script={s} size={mini} />
      ))}
    </span>
  );
}
