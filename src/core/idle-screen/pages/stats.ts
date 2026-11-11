import fs from "fs";
import os from "os";
import { IdlePage } from "../types";

const NA = "n/a";

const readFileSafe = async (path: string): Promise<string | null> => {
  try {
    return await fs.promises.readFile(path, "utf8");
  } catch {
    return null;
  }
};

const cpuTemp = async (): Promise<string> => {
  const raw = await readFileSafe("/sys/class/thermal/thermal_zone0/temp");
  const milli = parseInt(raw || "", 10);
  return Number.isFinite(milli) ? `${(milli / 1000).toFixed(1)}°C` : NA;
};

const cpuLoad = (): string => {
  const [oneMinute] = os.loadavg();
  const cores = os.cpus().length || 1;
  if (os.platform() === "win32") return NA;
  return `${oneMinute.toFixed(2)} (${Math.round((oneMinute / cores) * 100)}%)`;
};

const memoryUsed = async (): Promise<string> => {
  const total = os.totalmem();
  // MemAvailable counts reclaimable cache; os.freemem() would overstate usage.
  const meminfo = await readFileSafe("/proc/meminfo");
  const match = meminfo ? /^MemAvailable:\s+(\d+) kB/m.exec(meminfo) : null;
  const available = match ? parseInt(match[1], 10) * 1024 : os.freemem();
  const used = total - available;
  const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);
  return `${mb(used)}/${mb(total)} MB (${Math.round((used / total) * 100)}%)`;
};

const uptime = (): string => {
  const seconds = Math.floor(os.uptime());
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
};

const diskFree = async (): Promise<string> => {
  try {
    const stats = await fs.promises.statfs("/");
    const free = stats.bavail * stats.bsize;
    return `${(free / 1024 ** 3).toFixed(1)} GB free`;
  } catch {
    return NA;
  }
};

const wifiSignal = async (): Promise<string> => {
  const content = await readFileSafe("/proc/net/wireless");
  if (!content) return NA;
  // Skip the two header lines. Columns: iface status quality level noise ...
  for (const line of content.split("\n").slice(2)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const level = parseFloat(parts[3]);
    if (Number.isFinite(level) && level < 0) return `${Math.round(level)} dBm`;
  }
  return NA;
};

export const statsPage: IdlePage = {
  name: "stats",
  async render() {
    const [temp, mem, disk, wifi] = await Promise.all([
      cpuTemp(),
      memoryUsed(),
      diskFree(),
      wifiSignal(),
    ]);
    return {
      emoji: "📊",
      text: [
        "Pi Stats",
        `CPU ${temp}`,
        `Load ${cpuLoad()}`,
        `Mem ${mem}`,
        `Disk ${disk}`,
        `Wi-Fi ${wifi}`,
        `Up ${uptime()}`,
      ].join("\n"),
    };
  },
};
