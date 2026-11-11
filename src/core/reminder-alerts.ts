import fs from "fs";
import path from "path";
import moment from "moment";
import dotEnv from "dotenv";
import { display, getCurrentStatus, Status } from "../device/display";
import { playAudioData, stopPlaying } from "../device/audio";
import { ttsProcessor } from "../cloud-api/server";
import { purifyTextForTTS } from "../utils";
import { FlowName } from "./chat-flow/types";
import { holdIdleScreen, releaseIdleScreen } from "./idle-screen";
import { idleScreenConfig } from "./idle-screen/config";
import { formatReminder, parseReminders } from "./idle-screen/pages/reminders";

/**
 * Proactive reminder alerts.
 *
 * Once a minute the reminders file is re-read. Each reminder gets alert stages:
 * timed reminders at REMINDER_ALERT_LEADS ("evening" = the evening before,
 * numbers = minutes before), "anytime" reminders at REMINDER_ALERT_ANYTIME_TIME
 * on their date. A due alert waits until the chat flow is in "sleep", then
 * wakes the screen, flashes the LED, shows the text and (outside quiet hours,
 * if enabled) speaks it. A button press dismisses it. Fired stages are kept in
 * a state file so each fires once, even across restarts.
 *
 * Hooks: ChatFlow.transitionTo() calls notifyReminderAlertsFlowChange(), and
 * the sleep flow's button handler calls consumeReminderAlertPress().
 */

dotEnv.config();

const env = process.env;
const TAG = "[ReminderAlerts]";
const MINUTE_MS = 60 * 1000;
const FLASH_INTERVAL_MS = 500;
const STATE_RETENTION_DAYS = 7;
const DEFAULT_HINT = "Long Press the button to say something.";

// ---------- config ----------

const parseBool = (value: string | undefined, fallback: boolean): boolean => {
  const v = (value || "").trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  return fallback;
};

const parseNonNegative = (value: string | undefined, fallback: number): number => {
  const n = parseFloat(value || "");
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** Parses "HH:MM" into minutes after midnight, or the fallback if invalid. */
const parseClockTime = (value: string | undefined, fallback: number): number => {
  const match = /^(\d{1,2}):(\d{2})$/.exec((value || "").trim());
  if (!match || +match[1] > 23 || +match[2] > 59) return fallback;
  return +match[1] * 60 + +match[2];
};

type Lead = { id: string; kind: "evening" } | { id: string; kind: "minutes"; minutes: number };

const parseLeads = (value: string | undefined): Lead[] => {
  const leads: Lead[] = [];
  for (const raw of (value ?? "evening,60,0").split(",")) {
    const token = raw.trim().toLowerCase();
    if (!token) continue;
    if (token === "evening") {
      leads.push({ id: "evening", kind: "evening" });
    } else if (/^\d+$/.test(token)) {
      leads.push({ id: `m${+token}`, kind: "minutes", minutes: +token });
    } else {
      console.warn(`${TAG} Ignoring unknown lead "${raw}" in REMINDER_ALERT_LEADS.`);
    }
  }
  return leads;
};

const remindersFile =
  env.REMINDER_ALERTS_FILE || env.IDLE_REMINDERS_FILE || "/home/itninja/pet/reminders.txt";

const config = {
  enabled: parseBool(env.REMINDER_ALERTS_ENABLED, false),
  file: remindersFile,
  // Kept beside the reminders file by default: CLEAN_DATA_FOLDER_ON_START wipes data/.
  stateFile:
    env.REMINDER_ALERT_STATE_FILE ||
    path.join(path.dirname(remindersFile), "reminder-alerts.json"),
  leads: parseLeads(env.REMINDER_ALERT_LEADS),
  eveningTime: parseClockTime(env.REMINDER_ALERT_EVENING_TIME, 18 * 60),
  anytimeTime: parseClockTime(env.REMINDER_ALERT_ANYTIME_TIME, 8 * 60),
  maxLateMinutes: parseNonNegative(env.REMINDER_ALERT_MAX_LATE_MINUTES, 30),
  flashSeconds: parseNonNegative(env.REMINDER_ALERT_FLASH_SECONDS, 30),
  ledColor: env.REMINDER_ALERT_LED_COLOR || "#ffa000",
  speechEnabled: parseBool(env.REMINDER_ALERT_SPEECH_ENABLED, true),
  quietStart: parseClockTime(env.REMINDER_QUIET_START, 22 * 60),
  quietEnd: parseClockTime(env.REMINDER_QUIET_END, 7 * 60),
};

const isQuietTime = (now: moment.Moment = moment()): boolean => {
  const { quietStart: start, quietEnd: end } = config;
  if (start === end) return false;
  const minutes = now.hours() * 60 + now.minutes();
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
};

// ---------- state file ----------

/** Fired stage keys mapped to the ISO time they fired. */
let fired: Record<string, string> = {};

const loadState = (): void => {
  try {
    const data = JSON.parse(fs.readFileSync(config.stateFile, "utf8"));
    fired = data && typeof data.fired === "object" ? data.fired : {};
  } catch (e: any) {
    if (e.code !== "ENOENT") {
      console.warn(`${TAG} Could not read state file ${config.stateFile}:`, e.message);
    }
    fired = {};
  }
};

const saveState = (): void => {
  const cutoff = moment().subtract(STATE_RETENTION_DAYS, "days");
  for (const [key, at] of Object.entries(fired)) {
    if (moment(at).isBefore(cutoff)) delete fired[key];
  }
  try {
    fs.mkdirSync(path.dirname(config.stateFile), { recursive: true });
    const tmp = `${config.stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ fired }, null, 2));
    fs.renameSync(tmp, config.stateFile);
  } catch (e: any) {
    console.error(`${TAG} Could not write state file ${config.stateFile}:`, e.message);
  }
};

// ---------- scheduling ----------

type Reminder = ReturnType<typeof parseReminders>[number];

interface PendingAlert {
  reminderId: string;
  reminder: Reminder;
  /** Every due stage key for this reminder; all are marked fired when shown. */
  stageKeys: string[];
}

const reminderId = (r: Reminder): string =>
  `${r.date.format("YYYY-MM-DD")}|${r.minutes === null ? "anytime" : r.minutes}|${r.description}`;

const eventTime = (r: Reminder): moment.Moment | null =>
  r.minutes === null ? null : r.date.clone().add(r.minutes, "minutes");

/** The alert for this reminder that is due now and not yet fired, if any. */
const dueAlert = (r: Reminder, now: moment.Moment): PendingAlert | null => {
  const id = reminderId(r);
  const at = eventTime(r);
  let stages: { key: string; fireAt: moment.Moment }[];
  let expiresAt: moment.Moment;
  if (at === null) {
    stages = [{ key: `${id}|anytime`, fireAt: r.date.clone().add(config.anytimeTime, "minutes") }];
    expiresAt = r.date.clone().endOf("day");
  } else {
    stages = config.leads.map((lead) => ({
      key: `${id}|${lead.id}`,
      fireAt:
        lead.kind === "evening"
          ? r.date.clone().subtract(1, "day").add(config.eveningTime, "minutes")
          : at.clone().subtract(lead.minutes, "minutes"),
    }));
    expiresAt = at.clone().add(config.maxLateMinutes, "minutes");
  }
  if (!now.isBefore(expiresAt)) return null;
  const due = stages
    .filter((s) => !s.fireAt.isAfter(now))
    .sort((a, b) => a.fireAt.valueOf() - b.fireAt.valueOf());
  if (due.length === 0) return null;
  // Only the latest due stage counts; earlier ones are superseded by it.
  if (fired[due[due.length - 1].key]) return null;
  return { reminderId: id, reminder: r, stageKeys: due.map((s) => s.key) };
};

/** Due alerts waiting for the chatbot to be idle, keyed by reminder id. */
const pending = new Map<string, PendingAlert>();

const refreshPending = async (): Promise<void> => {
  let content: string;
  try {
    content = await fs.promises.readFile(config.file, "utf8");
  } catch {
    return;
  }
  const now = moment();
  const reminders = parseReminders(content);
  const ids = new Set(reminders.map(reminderId));
  // Drop queued alerts whose reminder was removed from the file.
  for (const id of pending.keys()) if (!ids.has(id)) pending.delete(id);
  for (const r of reminders) {
    const alert = dueAlert(r, now);
    if (!alert) continue;
    const existing = pending.get(alert.reminderId);
    // Queued alerts stay queued past their expiry, but merge in newer stages.
    pending.set(alert.reminderId, {
      ...alert,
      stageKeys: Array.from(new Set([...(existing?.stageKeys ?? []), ...alert.stageKeys])),
    });
  }
};

// ---------- presentation ----------

const timeText = (m: moment.Moment): string =>
  m.format(idleScreenConfig.clock.use24Hour ? "HH:mm" : "h:mm A");

/** A short, friendly sentence for TTS, phrased relative to now. */
const speechFor = (r: Reminder, now: moment.Moment): string => {
  const at = eventTime(r);
  if (at === null) {
    const greeting = now.hours() < 12 ? "Good morning!" : "Hi there!";
    const day = r.date.isSame(now, "day") ? "today" : r.date.format("dddd");
    return `${greeting} Don't forget ${day}: ${r.description}.`;
  }
  const minutes = Math.round(at.diff(now, "minutes", true));
  if (minutes <= 1) return `It's time! ${r.description}, at ${timeText(at)}.`;
  if (minutes < 120) {
    const span = minutes === 60 ? "an hour" : `${minutes} minutes`;
    return `Just a reminder: ${r.description} is in ${span}, at ${timeText(at)}.`;
  }
  if (at.isSame(now, "day")) {
    return `Just a reminder: ${r.description} today at ${timeText(at)}.`;
  }
  if (at.isSame(now.clone().add(1, "day"), "day")) {
    return `Heads up! Tomorrow at ${timeText(at)}: ${r.description}.`;
  }
  return `Heads up! ${at.format("dddd")} at ${timeText(at)}: ${r.description}.`;
};

interface ShowingAlert {
  id: number;
  alerts: PendingAlert[];
  text: string;
  previous: Pick<Status, "status" | "emoji" | "text" | "RGB" | "scroll_speed">;
}

let currentFlow: FlowName | null = null;
let showing: ShowingAlert | null = null;
let alertSeq = 0;
let flashTimer: NodeJS.Timeout | null = null;
let flashStopTimer: NodeJS.Timeout | null = null;
let speechPlaying = false;

const stopFlashing = (): void => {
  if (flashTimer) clearInterval(flashTimer);
  if (flashStopTimer) clearTimeout(flashStopTimer);
  flashTimer = null;
  flashStopTimer = null;
};

const startFlashing = (): void => {
  stopFlashing();
  if (config.flashSeconds <= 0) return;
  let on = true;
  flashTimer = setInterval(() => {
    on = !on;
    display({ RGB: on ? config.ledColor : "#000000" });
  }, FLASH_INTERVAL_MS);
  flashStopTimer = setTimeout(() => {
    stopFlashing();
    if (showing) display({ RGB: config.ledColor }); // stay solid until dismissed
  }, config.flashSeconds * 1000);
};

const drawAlert = (alert: ShowingAlert): void => {
  display({
    status: "Reminder",
    emoji: "🔔",
    text: alert.text,
    RGB: config.ledColor,
    brightness: 100,
    scroll_speed: 3,
  });
};

const speak = async (alertId: number, text: string): Promise<void> => {
  try {
    const result = await ttsProcessor(purifyTextForTTS(text));
    // Skip playback if the alert was dismissed while TTS was generating.
    if (!result || showing?.id !== alertId) return;
    speechPlaying = true;
    await playAudioData(result);
  } catch (e: any) {
    console.error(`${TAG} Speech failed:`, e?.message ?? e);
  } finally {
    speechPlaying = false;
  }
};

const showPending = (): void => {
  if (showing || currentFlow !== "sleep" || pending.size === 0) return;
  const alerts = Array.from(pending.values()).sort(
    (a, b) =>
      a.reminder.date.valueOf() - b.reminder.date.valueOf() ||
      (a.reminder.minutes ?? -1) - (b.reminder.minutes ?? -1),
  );
  pending.clear();
  const now = moment();
  const firedAt = now.toISOString();
  for (const alert of alerts) for (const key of alert.stageKeys) fired[key] = firedAt;
  saveState();

  holdIdleScreen(); // stops the carousel and dimming; capture state after
  const current = getCurrentStatus();
  const lines = alerts.map((a) =>
    formatReminder(a.reminder, now, idleScreenConfig.clock.use24Hour),
  );
  showing = {
    id: ++alertSeq,
    alerts,
    text: ["Reminder", ...lines, "", "Press the button to dismiss."].join("\n"),
    previous: {
      status: current.status,
      emoji: current.emoji,
      text: current.text,
      RGB: current.RGB,
      scroll_speed: current.scroll_speed,
    },
  };
  console.log(`${TAG} Showing: ${lines.join(" / ")}`);
  drawAlert(showing);
  startFlashing();

  if (!config.speechEnabled) return;
  if (isQuietTime(now)) {
    console.log(`${TAG} Quiet hours, not speaking.`);
    return;
  }
  void speak(showing.id, alerts.map((a) => speechFor(a.reminder, now)).join(" "));
};

/**
 * Ends the alert. restoreDisplay is false when a flow change ended it, since
 * the new flow has already drawn its own screen.
 */
const dismiss = (restoreDisplay: boolean): void => {
  if (!showing) return;
  const { previous } = showing;
  showing = null;
  stopFlashing();
  if (speechPlaying) stopPlaying();
  if (restoreDisplay) {
    display({ ...previous, text: previous.text || DEFAULT_HINT, brightness: 100 });
  }
  releaseIdleScreen();
  // Anything that came due while this alert was up shows next.
  if (pending.size > 0) setTimeout(showPending, 2000);
};

const tick = async (): Promise<void> => {
  try {
    await refreshPending();
    showPending();
  } catch (e: any) {
    console.error(`${TAG} Check failed:`, e?.message ?? e);
  }
};

// ---------- hooks ----------

/**
 * Called by the sleep flow on button press. Returns true if the press
 * dismissed an alert and should not start listening.
 */
export const consumeReminderAlertPress = (): boolean => {
  if (!showing) return false;
  console.log(`${TAG} Dismissed by button press.`);
  dismiss(true);
  return true;
};

/** Called by ChatFlow after every flow transition. */
export const notifyReminderAlertsFlowChange = (flowName: FlowName): void => {
  currentFlow = flowName;
  if (!config.enabled) return;
  if (flowName !== "sleep") {
    // A conversation started (wake word, text input, IM message): end the alert.
    if (showing) {
      console.log(`${TAG} Dismissed by switch to ${flowName}.`);
      dismiss(false);
    }
    return;
  }
  // Defer so the sleep handler's own display update lands first.
  setImmediate(() => {
    if (currentFlow !== "sleep") return;
    if (showing) drawAlert(showing); // re-entered sleep while showing; redraw
    else showPending();
  });
};

if (config.enabled) {
  loadState();
  // Check on each minute boundary.
  const msToNextMinute = MINUTE_MS - (Date.now() % MINUTE_MS) + 1000;
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), MINUTE_MS);
  }, msToNextMinute);
  console.log(
    `${TAG} Enabled: file ${config.file}, leads [${config.leads.map((l) => l.id).join(", ")}], ` +
      `speech ${config.speechEnabled ? "on" : "off"}, state ${config.stateFile}.`,
  );
}
