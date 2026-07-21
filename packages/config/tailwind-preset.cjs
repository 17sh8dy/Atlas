/**
 * Atlas Tailwind preset.
 * Maps semantic color names to CSS variables defined in @atlas/tokens.
 * Colors are stored as raw RGB channels so Tailwind's `/<alpha>` opacity works.
 */
const rgb = (v) => `rgb(var(${v}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        background: rgb('--color-background'),
        surface: {
          DEFAULT: rgb('--color-surface'),
          raised: rgb('--color-surface-raised'),
        },
        border: {
          DEFAULT: rgb('--color-border'),
          strong: rgb('--color-border-strong'),
        },
        foreground: {
          DEFAULT: rgb('--color-foreground'),
          muted: rgb('--color-foreground-muted'),
          subtle: rgb('--color-foreground-subtle'),
        },
        primary: {
          DEFAULT: rgb('--color-primary'),
          foreground: rgb('--color-primary-foreground'),
        },
        accent: rgb('--color-accent'),
        ring: rgb('--color-ring'),
        danger: rgb('--color-danger'),
        success: rgb('--color-success'),
        warning: rgb('--color-warning'),
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
        '2xl': 'var(--radius-2xl)',
      },
      fontFamily: {
        sans: 'var(--font-sans)',
        mono: 'var(--font-mono)',
      },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        glow: 'var(--shadow-glow)',
      },
      transitionTimingFunction: {
        out: 'var(--ease-out)',
        'in-out': 'var(--ease-in-out)',
      },
      transitionDuration: {
        fast: 'var(--duration-fast)',
        base: 'var(--duration-base)',
        slow: 'var(--duration-slow)',
      },
    },
  },
  plugins: [],
};
