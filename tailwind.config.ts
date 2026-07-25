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
        // LEGO-inspired palette
        brand: {
          50:  '#fff2f2',
          100: '#ffdde0',
          300: '#ff8080',
          500: '#E3000B',   // LEGO red — primary actions & CTAs
          600: '#c40009',
          700: '#9e0007',
          900: '#1A1A2E',   // deep navy — headings / text
        },
        lego: {
          yellow:   '#FFD700',   // header background
          yellowDk: '#E6C200',
          cream:    '#F5F3EE',   // page background
        },
        // Status colours for scan overlay + progress
        status: {
          needed:     '#22c55e',   // green  — found / needed in set
          haveEnough: '#eab308',   // yellow — have enough
          notInSet:   '#9ca3af',   // grey   — not in set
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 3px 0 rgb(0 0 0 / 0.06), 0 1px 2px -1px rgb(0 0 0 / 0.06)',
        'card-hover': '0 4px 12px 0 rgb(0 0 0 / 0.10)',
      },
    },
  },
  plugins: [],
}

export default config
