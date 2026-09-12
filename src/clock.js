/**
 * PVOutput expects the local wall-clock date/time of the *reading*, in the
 * system's configured time zone. Capturing it when the reading is taken (not
 * when it is finally uploaded) is what makes retries safe.
 */
export function createClock(timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });

  return {
    timeZone,
    /** @returns {{date: string, time: string}} e.g. { date:'20260912', time:'14:35' } */
    stamp(at = new Date()) {
      const parts = Object.fromEntries(
        fmt.formatToParts(at).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
      );
      // Intl renders midnight as "24" in some ICU versions; normalise it.
      const hour = parts.hour === '24' ? '00' : parts.hour;
      return {
        date: `${parts.year}${parts.month}${parts.day}`,
        time: `${hour}:${parts.minute}`,
      };
    },
  };
}
