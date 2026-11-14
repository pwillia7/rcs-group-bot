import { defineSchedule } from "eve/schedules";

import { fireDueReminders } from "../lib/reminders";

// Every minute: post due reminders straight to the outbox (no model call).
export default defineSchedule({
  cron: "* * * * *",
  async run() {
    await fireDueReminders();
  },
});
