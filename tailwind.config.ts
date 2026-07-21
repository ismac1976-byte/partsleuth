import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // PartSleuth brand — deep detective navy + amber accent
        brand: {
          50:  '#fdf8ed',
          100: '#f9edcb',
          500: '#d97706',   // amber — primary action
          600: '#b45309',
          900: '#1e1b4b',   // deep navy — header / dark bg
        },
        // Status colours for scan overlay
        status: {
          needed:     '#22c55e',   // green
          haveEnough: '#eab308',   // yellow
          notInSet:   '#9ca3af',   // grey
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}

export default config
