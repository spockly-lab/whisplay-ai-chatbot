import dotEnv from "dotenv";

dotEnv.config();

const env = process.env;

const parsePositive = (value: string | undefined, fallback: number): number => {
  const n = parseFloat(value || "");
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// The Python renderer ignores brightness 0, so clamp to 1-100.
const parseBrightness = (value: string | undefined, fallback: number): number => {
  const n = parseInt(value || "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(1, n));
};

/** Parses "HH:MM" into minutes after midnight, or null if invalid. */
const parseClockTime = (value: string | undefined): number | null => {
  const match = /^(\d{1,2}):(\d{2})$/.exec((value || "").trim());
  if (!match) return null;
  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
};

const parseBool = (value: string | undefined): boolean =>
  (value || "").trim().toLowerCase() === "true";

export const idleScreenConfig = {
  // IDLE_WEATHER_* names are kept as fallbacks for existing .env files.
  enabled: parseBool(env.IDLE_SCREEN_ENABLED ?? env.IDLE_WEATHER_ENABLED),
  idleMinutes: parsePositive(
    env.IDLE_SCREEN_IDLE_MINUTES ?? env.IDLE_WEATHER_IDLE_MINUTES,
    5,
  ),
  pages: (env.IDLE_SCREEN_PAGES || "clock,weather,reminders,stats")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean),
  rotateSeconds: parsePositive(env.IDLE_SCREEN_ROTATE_SECONDS, 60),
  brightness: parseBrightness(env.IDLE_SCREEN_BRIGHTNESS, 40),
  wakeSeconds: parsePositive(env.IDLE_SCREEN_WAKE_SECONDS, 30),
  night: {
    enabled: parseBool(env.IDLE_SCREEN_NIGHT_ENABLED),
    start: parseClockTime(env.IDLE_SCREEN_NIGHT_START || "22:00"),
    end: parseClockTime(env.IDLE_SCREEN_NIGHT_END || "07:00"),
    brightness: parseBrightness(env.IDLE_SCREEN_NIGHT_BRIGHTNESS, 10),
  },
  clock: {
    use24Hour: (env.IDLE_CLOCK_FORMAT || "").trim().toLowerCase() === "24h",
  },
  reminders: {
    file: env.IDLE_REMINDERS_FILE || "/home/itninja/pet/reminders.txt",
    count: Math.round(parsePositive(env.IDLE_REMINDERS_COUNT, 3)),
  },
  weather: {
    refreshMinutes: parsePositive(env.IDLE_WEATHER_REFRESH_MINUTES, 20),
    latitude: env.IDLE_WEATHER_LATITUDE || "35.2271",
    longitude: env.IDLE_WEATHER_LONGITUDE || "-80.8431",
    locationName: env.IDLE_WEATHER_LOCATION_NAME || "Charlotte, NC",
    useCelsius: (env.IDLE_WEATHER_UNITS || "").toLowerCase() === "celsius",
  },
};

/** True if the given time falls inside the night window (which may cross midnight). */
export const isNightTime = (date: Date = new Date()): boolean => {
  const { enabled, start, end } = idleScreenConfig.night;
  if (!enabled || start === null || end === null || start === end) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  return start < end ? now >= start && now < end : now >= start || now < end;
};
