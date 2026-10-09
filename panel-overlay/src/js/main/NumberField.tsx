import { useEffect, useState } from "react";

type Props = {
  value: number;
  min: number;
  max: number;
  step: number;
  decimals?: number;
  disabled?: boolean;
  onCommit: (v: number) => void;
};

/** Zahlenfeld, das erst beim Verlassen/Enter übernimmt – so kann man „1500“
 *  tippen, ohne dass schon bei „1“ auf das Minimum korrigiert wird. */
export const NumberField = ({ value, min, max, step, decimals = 0, disabled, onCommit }: Props) => {
  const [text, setText] = useState(String(value));

  useEffect(() => setText(String(value)), [value]);

  const commit = () => {
    const n = Number(text.replace(",", "."));
    if (text.trim() === "" || !isFinite(n)) {
      setText(String(value));
      return;
    }
    const f = Math.pow(10, decimals);
    const clamped = Math.min(max, Math.max(min, Math.round(n * f) / f));
    setText(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };

  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={text}
      disabled={disabled}
      onChange={(e: { target: { value: string } }) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e: { key: string }) => {
        if (e.key === "Enter") commit();
      }}
    />
  );
};
