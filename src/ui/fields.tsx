import { useEffect, useState } from 'react';

/** text input that commits on blur / Enter (so typing doesn't make one undo step per letter) */
export function TextField({ value, onCommit, className = 'txt', ...rest }: {
  value: string; onCommit: (v: string) => void; className?: string; maxLength?: number; title?: string; placeholder?: string; 'aria-label'?: string;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const done = () => { if (v !== value) onCommit(v); };
  return (
    <input type="text" className={className} value={v} {...rest}
      onChange={(e) => setV(e.target.value)} onBlur={done}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { done(); (e.target as HTMLInputElement).blur(); } if (e.key === 'Escape') { setV(value); (e.target as HTMLInputElement).blur(); } }} />
  );
}

/** integer input that commits on blur / Enter and clamps to min..max */
export function NumField({ value, onCommit, min, max, className = 'txt num', ...rest }: {
  value: number; onCommit: (v: number) => void; min: number; max: number; className?: string; title?: string; 'aria-label'?: string;
}) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const done = () => {
    const n = Math.max(min, Math.min(max, Math.trunc(Number(v))));
    if (!Number.isFinite(n) || v.trim() === '') { setV(String(value)); return; }
    setV(String(n));
    if (n !== value) onCommit(n);
  };
  return (
    <input type="text" inputMode="numeric" className={className} value={v} {...rest}
      onChange={(e) => setV(e.target.value)} onBlur={done}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { done(); (e.target as HTMLInputElement).blur(); }
        if (e.key === 'Escape') { setV(String(value)); (e.target as HTMLInputElement).blur(); }
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const n = Math.max(min, Math.min(max, (Number(v) || 0) + (e.key === 'ArrowUp' ? 1 : -1)));
          setV(String(n)); if (n !== value) onCommit(n);
        }
      }} />
  );
}
