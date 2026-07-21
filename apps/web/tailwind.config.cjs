const preset = require('@atlas/config/tailwind-preset');
const animate = require('tailwindcss-animate');

/** @type {import('tailwindcss').Config} */
module.exports = {
  presets: [preset],
  plugins: [animate],
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
};
