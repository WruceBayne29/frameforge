import { useCallback, useEffect, useState } from 'react';
import { readStored, writeStored } from './storage';

export type Theme = 'light' | 'dark';

const THEME_KEY = 'frameforge-theme';

function initialTheme(): Theme {
  const saved = readStored(THEME_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** The colour theme, applied to the document and remembered between visits. */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    writeStored(THEME_KEY, theme);
  }, [theme]);
  const toggle = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);
  return [theme, toggle];
}
