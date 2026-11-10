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
export const HUES = 10;
export function hueOf(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % HUES;
}

/** The script's icon drawn alone (white on its packet colour), or its first letter. */
export function Glyph({ script, size = 26 }: { script: Pick<Script, "name" | "icon">; size?: number }) {
  const Icon = script.icon ? ICONS[script.icon] : undefined;
  return Icon ? (
    <Icon size={size} strokeWidth={1.9} aria-hidden />
  ) : (
    <span className="letter" style={{ fontSize: Math.round(size * 0.95) }} aria-hidden>
      {[...script.name.trim()][0]?.toUpperCase() ?? "?"}
    </span>
  );
}

/** A small square in the script's packet colour with its icon, for lists and folder fronts. */
export function ScriptIcon({ script, size = 40 }: { script: Pick<Script, "id" | "name" | "icon">; size?: number }) {
  return (
    <span className={`glyph hue-${hueOf(script.id)}`} style={{ width: size, height: size, borderRadius: Math.round(size / 4.5) }} aria-hidden>
      <Glyph script={script} size={Math.round(size * 0.52)} />
    </span>
  );
}
