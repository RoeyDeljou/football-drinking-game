import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        pitch: {
          50: '#eafbef',
          100: '#c9f3d3',
          500: '#1fa34a',
          600: '#178a3d',
          700: '#116b30',
          900: '#0a3d1b',
        },
        ink: {
          950: '#0a0e14',
        },
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

export default config;
