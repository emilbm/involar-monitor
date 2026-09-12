/**
 * All bucketing is done in the configured local time zone: a "day" on the
 * dashboard is the day you actually lived through, not a UTC day.
 */
export function createClock(timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });

  function fields(at) {
    const f = Object.fromEntries(
      parts.formatToParts(at).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
    );
    // Some ICU versions render midnight as hour "24".
    if (f.hour === '24') f.hour = '00';
    return f;
  }

  return {
    timeZone,

    /** `YYYY-MM-DD` in local time. */
    day(at = new Date()) {
      const f = fields(at);
      return `${f.year}-${f.month}-${f.day}`;
    },

    /** `YYYY-MM-DDTHH` in local time - the key for hourly rollups. */
    hour(at = new Date()) {
      const f = fields(at);
      return `${f.year}-${f.month}-${f.day}T${f.hour}`;
    },

    /** Unix seconds at the start of the local hour containing `at`. */
    hourStart(at = new Date()) {
      const f = fields(at);
      return Math.floor(at.getTime() / 1000) - (Number(f.minute) * 60 + Number(f.second));
    },

    /** Offset from UTC in seconds at that instant, e.g. +7200 for CEST. */
    offsetSeconds(at = new Date()) {
      const f = fields(at);
      const asUtc = Date.UTC(
        Number(f.year), Number(f.month) - 1, Number(f.day),
        Number(f.hour), Number(f.minute), Number(f.second),
      );
      return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 1000);
    },

    /** `HH:mm` in local time, for log lines. */
    hhmm(at = new Date()) {
      const f = fields(at);
      return `${f.hour}:${f.minute}`;
    },
  };
}
