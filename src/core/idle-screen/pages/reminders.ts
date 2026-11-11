import fs from "fs";
import moment from "moment";
import { idleScreenConfig } from "../config";
import { IdlePage } from "../types";

/**
 * Reminders file format, one per line:
 *   YYYY-MM-DD | HH:MM | description
 *   YYYY-MM-DD | anytime | description
 * Blank lines and lines starting with # are ignored.
 */

interface Reminder {
  date: moment.Moment; // start of day
  minutes: number | null; // minutes after midnight, null = anytime
  description: string;
}

const warnedLines = new Set<string>();

export const parseReminders = (content: string): Reminder[] => {
  const reminders: Reminder[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("|").map((part) => part.trim());
    const date = moment(parts[0], "YYYY-MM-DD", true);
    const time = (parts[1] || "").toLowerCase();
    const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(time);
    const description = parts.slice(2).join(" | ");
    const validTime =
      time === "anytime" ||
      (timeMatch !== null && +timeMatch[1] <= 23 && +timeMatch[2] <= 59);
    if (parts.length < 3 || !date.isValid() || !validTime || !description) {
      if (!warnedLines.has(line)) {
        warnedLines.add(line);
        console.warn(`[IdleScreen] Skipping malformed reminder: "${line}"`);
      }
      continue;
    }
    reminders.push({
      date,
      minutes: timeMatch ? +timeMatch[1] * 60 + +timeMatch[2] : null,
      description,
    });
  }
  return reminders;
};

/** Upcoming reminders, soonest first; anytime items lead their day. */
export const upcomingReminders = (
  reminders: Reminder[],
  now: moment.Moment = moment(),
): Reminder[] => {
  const today = now.clone().startOf("day");
  const nowMinutes = now.hours() * 60 + now.minutes();
  return reminders
    .filter((r) => {
      if (r.date.isBefore(today)) return false;
      if (r.date.isSame(today) && r.minutes !== null) return r.minutes >= nowMinutes;
      return true;
    })
    .sort(
      (a, b) =>
        a.date.valueOf() - b.date.valueOf() || (a.minutes ?? -1) - (b.minutes ?? -1),
    );
};

export const formatReminder = (
  r: Reminder,
  now: moment.Moment = moment(),
  use24Hour = false,
): string => {
  const days = r.date.diff(now.clone().startOf("day"), "days");
  const day =
    days === 0 ? "Today" : days === 1 ? "Tomorrow" : r.date.format(days < 7 ? "ddd" : "ddd MMM D");
  const time =
    r.minutes === null
      ? ""
      : " " +
        moment(r.date)
          .add(r.minutes, "minutes")
          .format(use24Hour ? "HH:mm" : "h:mm A");
  return `${day}${time}: ${r.description}`;
};

export const remindersPage: IdlePage = {
  name: "reminders",
  async render() {
    const { file, count } = idleScreenConfig.reminders;
    let content: string;
    try {
      // Re-read every time so edits show up without a restart.
      content = await fs.promises.readFile(file, "utf8");
    } catch {
      return null;
    }
    const now = moment();
    const upcoming = upcomingReminders(parseReminders(content), now).slice(0, count);
    if (upcoming.length === 0) return null;
    const use24Hour = idleScreenConfig.clock.use24Hour;
    return {
      emoji: "📅",
      text: ["Reminders", ...upcoming.map((r) => formatReminder(r, now, use24Hour))].join(
        "\n",
      ),
    };
  },
};
