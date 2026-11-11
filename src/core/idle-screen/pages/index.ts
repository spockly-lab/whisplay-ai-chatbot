import { IdlePage } from "../types";
import { clockPage } from "./clock";
import { remindersPage } from "./reminders";
import { statsPage } from "./stats";
import { weatherPage } from "./weather";

/** All available idle pages, keyed by the name used in IDLE_SCREEN_PAGES. */
export const idlePages: Record<string, IdlePage> = {
  [clockPage.name]: clockPage,
  [weatherPage.name]: weatherPage,
  [remindersPage.name]: remindersPage,
  [statsPage.name]: statsPage,
};
