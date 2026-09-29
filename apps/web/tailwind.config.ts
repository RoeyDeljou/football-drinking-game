import type { Config } from 'tailwindcss';
import plugin from 'tailwindcss/plugin';

/**
 * Semantic colours only (see src/styles/tokens.css, ported from the Fantasy3.0 chalkboard theme).
 * Components use `bg-bg-raised`, `text-fg-muted`, `border-border`, `bg-accent text-accent-fg` ...
 * and never a raw hex or palette step.
 */
const channel = (name: string): string => `rgb(var(--${name}-rgb) / <alpha-value>)`;

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: channel('bg'),
        'bg-raised': channel('bg-raised'),
        'bg-sunken': channel('bg-sunken'),
        card: 'var(--bg-card)',
        hover: 'var(--bg-hover)',
        pressed: 'var(--bg-pressed)',
        selected: 'var(--bg-selected)',
        scrim: 'var(--scrim)',
        fg: channel('fg'),
        'fg-muted': channel('fg-muted'),
        'fg-subtle': channel('fg-subtle'),
        border: 'var(--border)',
        'border-strong': 'var(--border-strong)',
        accent: channel('accent'),
        'accent-fg': channel('accent-fg'),
        live: channel('live'),
        up: channel('up'),
        down: channel('down'),
        warn: channel('warn'),
        info: channel('info'),
      },
      borderRadius: {
        sm: 'var(--r-sm)',
        md: 'var(--r-md)',
        lg: 'var(--r-lg)',
      },
      fontFamily: {
        sans: ['var(--font-body)', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        hand: ['var(--font-hand)', 'Segoe Script', 'cursive'],
      },
      boxShadow: {
        sheet: 'var(--shadow-3)',
      },
    },
  },
  plugins: [
    // A phone held sideways: wide enough for two columns, far too short for one tall stack. A plugin
    // variant rather than a `screens` entry, because an object in `screens` disables `min-[...]`.
    plugin(({ addVariant }) => {
      addVariant('land', '@media (orientation: landscape) and (max-height: 500px)');
    }),
  ],
};

export default config;
