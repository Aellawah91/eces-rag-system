import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        navy: "#1e3a5f",
        gold: "#c8a85a",
        parchment: "#fafaf7",
        ink: "#2c3e50",
        muted: "#7a8595",
      },
      fontFamily: {
        serif: ["var(--font-serif)", "Cormorant Garamond", "Georgia", "serif"],
        sans: ["var(--font-sans)", "Inter", "system-ui", "sans-serif"],
      },
      maxWidth: {
        prose: "1000px",
      },
    },
  },
  plugins: [],
};

export default config;
