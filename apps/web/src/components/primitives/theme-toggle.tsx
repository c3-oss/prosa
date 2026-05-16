import { Monitor, Moon, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'

type ThemePreference = 'light' | 'dark' | 'system'
type ResolvedTheme = 'light' | 'dark'

const THEME_STORAGE_KEY = 'prosa:theme'

// Cycle order: system -> light -> dark -> system.
const CYCLE_NEXT: Record<ThemePreference, ThemePreference> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
}

function readStoredPreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system'
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
    return 'system'
  } catch {
    return 'system'
  }
}

function prefersDark(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}

function resolvePreference(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === 'system') return systemDark ? 'dark' : 'light'
  return preference
}

function applyResolvedTheme(resolved: ResolvedTheme) {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', resolved)
}

function persistPreference(preference: ThemePreference) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference)
  } catch {
    // Ignore storage errors; theme is cosmetic.
  }
}

// Shared hook so both the icon button and the radio group reflect the same source of truth.
function useThemePreference(): {
  preference: ThemePreference
  resolved: ResolvedTheme
  setPreference: (next: ThemePreference) => void
} {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readStoredPreference())
  const [systemDark, setSystemDark] = useState<boolean>(() => prefersDark())

  // Subscribe to OS-level color-scheme changes so 'system' stays in sync.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])

  // Apply + persist whenever preference or system value changes.
  useEffect(() => {
    applyResolvedTheme(resolvePreference(preference, systemDark))
    persistPreference(preference)
  }, [preference, systemDark])

  // Cross-tab sync via the storage event.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const handler = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return
      const next = event.newValue
      if (next === 'light' || next === 'dark' || next === 'system') setPreferenceState(next)
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [])

  return {
    preference,
    resolved: resolvePreference(preference, systemDark),
    setPreference: setPreferenceState,
  }
}

function describePreference(preference: ThemePreference): string {
  if (preference === 'system') return 'Theme: system (auto)'
  if (preference === 'light') return 'Theme: light'
  return 'Theme: dark'
}

export function ThemeToggle() {
  const { preference, resolved, setPreference } = useThemePreference()

  const Icon = preference === 'system' ? Monitor : resolved === 'dark' ? Sun : Moon
  const next = CYCLE_NEXT[preference]
  const label = `${describePreference(preference)} — switch to ${next}`

  return (
    <button
      type="button"
      className="console-icon-button"
      onClick={() => setPreference(next)}
      aria-label={label}
      title={describePreference(preference)}
    >
      <Icon size={18} />
    </button>
  )
}

const RADIO_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
]

export function ThemeToggleRadioGroup() {
  const { preference, setPreference } = useThemePreference()

  return (
    <fieldset className="console-theme-radio-group">
      <legend>Theme</legend>
      <div className="console-theme-radio-options" role="radiogroup" aria-label="Theme preference">
        {RADIO_OPTIONS.map((option) => (
          <label key={option.value} className="console-theme-radio-option">
            <input
              type="radio"
              name="prosa-theme"
              value={option.value}
              checked={preference === option.value}
              onChange={() => setPreference(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}
