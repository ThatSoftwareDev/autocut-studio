/** 83.4 -> "1:23,40" ; 3725.1 -> "1:02:05,10" */
export const fmtTime = (seconds: number): string => {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const secStr = sec.toFixed(2).replace(".", ",").padStart(5, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${secStr}` : `${m}:${secStr}`;
};

export const fmtSeconds = (s: number, digits = 2) => s.toFixed(digits).replace(".", ",") + " s";

export const fmtPercent = (part: number, whole: number) =>
  whole > 0 ? ((part / whole) * 100).toFixed(1).replace(".", ",") + " %" : "–";
