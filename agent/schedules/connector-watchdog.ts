import { defineSchedule } from "eve/schedules";

import { notify } from "../lib/notify";
import { keys, redis } from "../lib/redis";

// The connector writes a heartbeat every minute. If it goes quiet (daemon crash
// loop, quota, Redis trouble) it can't alert about itself, so check from here.
// Pure code: no model call, no session.
export default defineSchedule({
  cron: "*/10 * * * *",
  async run() {
    const beat = Number((await redis().get<number | string>(keys.heartbeat)) ?? 0);
    const ageMin = (Date.now() / 1000 - beat) / 60;
    if (!beat || ageMin > 10) {
      await notify(
        "heartbeat",
        "bot connector is down",
        `No heartbeat for ${beat ? Math.round(ageMin) : "∞"} min. Check: vercel daemons ls / vercel logs --query 'source:daemon'`,
        { priority: 4, everySeconds: 2 * 3600 },
      );
    }
  },
});
