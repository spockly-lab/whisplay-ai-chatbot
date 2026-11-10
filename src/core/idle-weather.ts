import moment from "moment";
import dotEnv from "dotenv";
import { display, getCurrentStatus } from "../device/display";
import { proxyFetch } from "../cloud-api/proxy-fetch";
import { FlowName } from "./chat-flow/types";

dotEnv.config();

/**
 * Idle weather screen.
 *
 * After the chat flow has stayed in "sleep" for IDLE_WEATHER_IDLE_MINUTES, the
 * last chat on screen is replaced with current weather from Open-Meteo, which
 * refreshes every IDLE_WEATHER_REFRESH_MINUTES. Any flow transition (button
 * press, wake word, text input, IM message) ends weather mode, so the button
 * keeps its normal behavior.
 */

const parseMinutes = (value: string | undefined, fallback: number): number => {
  const minutes = parseFloat(value || "");
  return Number.isFinite(minutes) && minutes > 0 ? minutes : fallback;
};

const enabled =
  (process.env.IDLE_WEATHER_ENABLED || "").toLowerCase() === "true";
const idleMinutes = parseMinutes(process.env.IDLE_WEATHER_IDLE_MINUTES, 5);
const refreshMinutes = parseMinutes(process.env.IDLE_WEATHER_REFRESH_MINUTES, 20);
const latitude = process.env.IDLE_WEATHER_LATITUDE || "35.2271";
const longitude = process.env.IDLE_WEATHER_LONGITUDE || "-80.8431";
const locationName = process.env.IDLE_WEATHER_LOCATION_NAME || "Charlotte, NC";
const useCelsius =
  (process.env.IDLE_WEATHER_UNITS || "").toLowerCase() === "celsius";

const FETCH_TIMEOUT_MS = 15000;

// WMO weather codes used by Open-Meteo. Emoji are bare codepoints (no U+FE0F)
// because the renderer looks up one emoji_svg file per character.
const describeWeatherCode = (code: number): { label: string; emoji: string } => {
  if (code === 0) return { label: "Clear", emoji: "☀" };
  if (code === 1) return { label: "Mainly clear", emoji: "🌤" };
  if (code === 2) return { label: "Partly cloudy", emoji: "⛅" };
  if (code === 3) return { label: "Overcast", emoji: "☁" };
  if (code === 45 || code === 48) return { label: "Fog", emoji: "🌫" };
  if (code >= 51 && code <= 57) return { label: "Drizzle", emoji: "🌦" };
  if (code >= 61 && code <= 67) return { label: "Rain", emoji: "🌧" };
  if (code >= 71 && code <= 77) return { label: "Snow", emoji: "🌨" };
  if (code >= 80 && code <= 82) return { label: "Rain showers", emoji: "🌦" };
  if (code === 85 || code === 86) return { label: "Snow showers", emoji: "🌨" };
  if (code >= 95) return { label: "Thunderstorm", emoji: "⛈" };
  return { label: "Unknown", emoji: "🌡" };
};

const fetchWeather = async (): Promise<{ emoji: string; text: string }> => {
  const unit = useCelsius ? "celsius" : "fahrenheit";
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
    `&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min` +
    `&temperature_unit=${unit}&timezone=auto&forecast_days=1`;
  const response = await proxyFetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Open-Meteo responded with HTTP ${response.status}`);
  }
  const data: any = await response.json();
  const temp = Math.round(data.current.temperature_2m);
  const high = Math.round(data.daily.temperature_2m_max[0]);
  const low = Math.round(data.daily.temperature_2m_min[0]);
  const { label, emoji } = describeWeatherCode(data.current.weather_code);
  const unitLabel = useCelsius ? "C" : "F";
  return {
    emoji,
    text: [
      locationName,
      `${temp}°${unitLabel}  ${label}`,
      `H ${high}°  L ${low}°`,
      `Updated ${moment().format("h:mm A")}`,
    ].join("\n"),
  };
};

let idleTimer: NodeJS.Timeout | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
// Bumped whenever weather mode ends so late fetch results are discarded.
let session = 0;
let weatherText = "";

const refreshWeather = async (currentSession: number): Promise<void> => {
  try {
    const weather = await fetchWeather();
    if (currentSession !== session) return;
    if (getCurrentStatus().status !== "idle") return;
    weatherText = weather.text;
    display({ emoji: weather.emoji, text: weather.text });
  } catch (e: any) {
    // Keep whatever is on screen; the "Updated" line shows staleness.
    console.error("[IdleWeather] Failed to fetch weather:", e.message);
  }
};

const stopWeather = (): void => {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  session += 1;
  if (weatherText && getCurrentStatus().text === weatherText) {
    // Clear the weather so the next flow (e.g. sleep's hint text) starts clean.
    display({ text: "" });
  }
  weatherText = "";
};

/** Called by ChatFlow before every flow transition. */
export const notifyIdleWeatherFlowChange = (flowName: FlowName): void => {
  if (!enabled) return;
  stopWeather();
  if (flowName !== "sleep") return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    const currentSession = session;
    console.log("[IdleWeather] Idle timeout reached, showing weather.");
    void refreshWeather(currentSession);
    refreshTimer = setInterval(
      () => void refreshWeather(currentSession),
      refreshMinutes * 60 * 1000,
    );
  }, idleMinutes * 60 * 1000);
};

if (enabled) {
  console.log(
    `[IdleWeather] Enabled for ${locationName}: idle ${idleMinutes} min, refresh ${refreshMinutes} min.`,
  );
}
