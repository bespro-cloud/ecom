import type { Config } from 'tailwindcss';

/**
 * Palette note: a calm, clinical blue-green. Trust in a healthcare context
 * comes from clarity and restraint, not from badges and colour.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef7f7',
          100: '#d5ecec',
          200: '#aedada',
          300: '#7cc0c2',
          400: '#4c9fa3',
          500: '#328388',
          600: '#276a70',
          700: '#22555b',
          800: '#20464b',
          900: '#1e3c40',
          950: '#0d2225',
        },
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      maxWidth: {
        prose: '68ch',
      },
    },
  },
  plugins: [],
};

export default config;
