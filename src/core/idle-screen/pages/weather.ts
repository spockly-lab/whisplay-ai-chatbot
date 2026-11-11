import moment from "moment";
import { proxyFetch } from "../../../cloud-api/proxy-fetch";
import { idleScreenConfig } from "../config";
import { IdlePage, IdlePageContent } from "../types";

const FETCH_TIMEOUT_MS = 15000;
const config = idleScreenConfig.weather;

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

const fetchWeather = async (): Promise<IdlePageContent> => {
  const unit = config.useCelsius ? "celsius" : "fahrenheit";
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${config.latitude}&longitude=${config.longitude}` +
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
  const unitLabel = config.useCelsius ? "C" : "F";
  return {
    emoji,
    text: [
      config.locationName,
      `${temp}°${unitLabel}  ${label}`,
      `H ${high}°  L ${low}°`,
      `Updated ${moment().format("h:mm A")}`,
    ].join("\n"),
  };
};

// Weather is fetched on its own schedule; rotations only show the cached result.
let cached: IdlePageContent | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
let generation = 0;

export const weatherPage: IdlePage = {
  name: "weather",
  activate(ctx) {
    const current = ++generation;
    const refresh = async () => {
      try {
        const weather = await fetchWeather();
        if (current !== generation) return;
        cached = weather;
        ctx.requestRedraw();
      } catch (e: any) {
        // Keep the last result; its "Updated" line shows staleness.
        console.error("[IdleScreen] Failed to fetch weather:", e.message);
      }
    };
    void refresh();
    refreshTimer = setInterval(() => void refresh(), config.refreshMinutes * 60 * 1000);
  },
  deactivate() {
    generation += 1;
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  },
  async render() {
    return cached;
  },
};
