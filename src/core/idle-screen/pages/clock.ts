import moment from "moment";
import { idleScreenConfig } from "../config";
import { IdlePage } from "../types";

export const clockPage: IdlePage = {
  name: "clock",
  async render() {
    const now = moment();
    const time = now.format(idleScreenConfig.clock.use24Hour ? "HH:mm" : "h:mm A");
    return { emoji: "🕐", text: `${time}\n${now.format("dddd, MMMM D")}` };
  },
  // Redraw just after the next minute boundary so the time is never stale.
  nextUpdateMs() {
    const now = Date.now();
    return 60000 - (now % 60000) + 50;
  },
};
