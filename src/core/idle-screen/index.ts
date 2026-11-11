import { display, getCurrentStatus } from "../../device/display";
import { FlowName } from "../chat-flow/types";
import { idleScreenConfig as config, isNightTime } from "./config";
import { idlePages } from "./pages";
import { IdlePage } from "./types";

/**
 * Idle screen carousel.
 *
 * After the chat flow has stayed in "sleep" for IDLE_SCREEN_IDLE_MINUTES, the
 * last chat is replaced by a rotation of pages (clock, weather, reminders, Pi
 * stats) and the backlight dims. The first button press while dimmed only
 * restores full brightness for IDLE_SCREEN_WAKE_SECONDS; a press while bright
 * behaves normally. Any flow transition ends the idle screen.
 */

const FULL_BRIGHTNESS = 100;

const pages: IdlePage[] = config.pages.flatMap((name) => {
  const page = idlePages[name];
  if (!page) {
    console.warn(`[IdleScreen] Unknown page "${name}" in IDLE_SCREEN_PAGES, ignoring.`);
    return [];
  }
  return [page];
});

let idleTimer: NodeJS.Timeout | null = null;
let rotateTimer: NodeJS.Timeout | null = null;
let pageUpdateTimer: NodeJS.Timeout | null = null;
let wakeTimer: NodeJS.Timeout | null = null;
let active = false;
let awake = false;
// Bumped whenever the idle screen ends so late async results are discarded.
let session = 0;
// Bumped on every draw so overlapping renders can't overwrite a newer page.
let drawToken = 0;
let currentIndex = 0;
let shownIndex = -1;
let shownText = "";

const clearTimer = (timer: NodeJS.Timeout | null): null => {
  if (timer) clearTimeout(timer);
  return null;
};

const targetBrightness = (): number => {
  if (!active || awake) return FULL_BRIGHTNESS;
  return isNightTime() ? config.night.brightness : config.brightness;
};

const applyBrightness = (): void => {
  const brightness = targetBrightness();
  if (getCurrentStatus().brightness !== brightness) {
    display({ brightness });
  }
};

/** Draw the first page at or after startIndex that has something to show. */
const showFrom = async (startIndex: number): Promise<void> => {
  const token = ++drawToken;
  pageUpdateTimer = clearTimer(pageUpdateTimer);
  for (let offset = 0; offset < pages.length; offset++) {
    const index = (startIndex + offset) % pages.length;
    const page = pages[index];
    let content = null;
    try {
      content = await page.render();
    } catch (e: any) {
      console.error(`[IdleScreen] Page "${page.name}" failed to render:`, e.message);
    }
    if (token !== drawToken || !active) return;
    if (!content) continue;
    if (getCurrentStatus().status !== "idle") return;
    currentIndex = index;
    shownIndex = index;
    shownText = content.text;
    display({ emoji: content.emoji, text: content.text });
    if (page.nextUpdateMs) {
      pageUpdateTimer = setTimeout(() => void showFrom(index), page.nextUpdateMs());
    }
    return;
  }
  // Nothing to show right now; try again from the same page next rotation.
  currentIndex = startIndex % pages.length;
};

const rotate = (): void => {
  applyBrightness(); // picks up night mode starting or ending
  const next = shownIndex === -1 ? currentIndex : currentIndex + 1;
  void showFrom(next);
};

const startIdleScreen = (): void => {
  active = true;
  awake = false;
  currentIndex = 0;
  shownIndex = -1;
  const currentSession = session;
  for (const page of pages) {
    page.activate?.({
      requestRedraw: () => {
        if (currentSession !== session || !active) return;
        // Redraw if this page is on screen, or if nothing has been shown yet.
        if (shownIndex === -1 || pages[shownIndex] === page) {
          void showFrom(shownIndex === -1 ? currentIndex : shownIndex);
        }
      },
    });
  }
  applyBrightness();
  void showFrom(0);
  if (pages.length > 1) {
    rotateTimer = setInterval(rotate, config.rotateSeconds * 1000);
  } else {
    // Still re-check night mode once a minute with a single page.
    rotateTimer = setInterval(applyBrightness, 60 * 1000);
  }
};

const stopIdleScreen = (): void => {
  idleTimer = clearTimer(idleTimer);
  pageUpdateTimer = clearTimer(pageUpdateTimer);
  wakeTimer = clearTimer(wakeTimer);
  if (rotateTimer) {
    clearInterval(rotateTimer);
    rotateTimer = null;
  }
  session += 1;
  drawToken += 1;
  const wasActive = active;
  active = false;
  awake = false;
  if (!wasActive) return;
  for (const page of pages) page.deactivate?.();
  if (shownText && getCurrentStatus().text === shownText) {
    // Clear the page so the next flow (e.g. sleep's hint text) starts clean.
    display({ text: "" });
  }
  shownText = "";
  applyBrightness();
};

/**
 * Called by the sleep flow on button press. Returns true if the press was used
 * to wake a dimmed idle screen and should not start listening.
 */
export const consumeIdleScreenWakePress = (): boolean => {
  if (!active || awake || targetBrightness() >= FULL_BRIGHTNESS) return false;
  awake = true;
  applyBrightness();
  console.log("[IdleScreen] Button press woke the screen.");
  wakeTimer = clearTimer(wakeTimer);
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    awake = false;
    applyBrightness();
  }, config.wakeSeconds * 1000);
  return true;
};

let held = false;
let lastFlow: FlowName | null = null;

/** Stops the idle screen and keeps it off (e.g. while a reminder alert is up). */
export const holdIdleScreen = (): void => {
  held = true;
  stopIdleScreen();
};

/** Ends a hold; the idle countdown restarts if the flow is still sleep. */
export const releaseIdleScreen = (): void => {
  if (!held) return;
  held = false;
  if (lastFlow) notifyIdleScreenFlowChange(lastFlow);
};

/** Called by ChatFlow before every flow transition. */
export const notifyIdleScreenFlowChange = (flowName: FlowName): void => {
  lastFlow = flowName;
  if (!config.enabled || pages.length === 0) return;
  stopIdleScreen();
  if (flowName !== "sleep" || held) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    console.log("[IdleScreen] Idle timeout reached, starting idle screen.");
    startIdleScreen();
  }, config.idleMinutes * 60 * 1000);
};

if (config.enabled) {
  console.log(
    `[IdleScreen] Enabled: pages [${pages.map((p) => p.name).join(", ")}], ` +
      `idle ${config.idleMinutes} min, rotate ${config.rotateSeconds}s, ` +
      `brightness ${config.brightness}` +
      (config.night.enabled ? `, night brightness ${config.night.brightness}` : "") +
      ".",
  );
}
