/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "#123f2e",
          dark: "#0b2b1f",
          accent: "#f2b705",
        },
      },
    },
  },
  plugins: [],
};
