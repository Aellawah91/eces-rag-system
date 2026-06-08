import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Editorial palette — deeper inks, warmer paper, oxblood accent.
        ink: "#10162a",          // near-black blue, used for type
        navy: "#1a2747",         // primary brand navy
        "navy-deep": "#0c1428",
        oxblood: "#7a1d2b",      // editorial accent — replaces gold for emphasis
        "oxblood-soft": "#a8404f",
        gold: "#b8924a",         // restrained, used as fine accent
        "gold-soft": "#d8b977",
        parchment: "#f4ede0",    // warmer cream
        paper: "#fbf6ea",        // primary surface — softer than parchment
        "paper-bright": "#fffaef",
        rule: "rgba(16, 22, 42, 0.18)",
        "rule-soft": "rgba(16, 22, 42, 0.08)",
      },
      fontFamily: {
        display: ["var(--font-display)", "Fraunces", "Georgia", "serif"],
        serif: ["var(--font-serif)", "Newsreader", "Georgia", "serif"],
        sans: ["var(--font-sans)", "Inter", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "JetBrains Mono", "ui-monospace", "monospace"],
      },
      maxWidth: {
        prose: "1080px",
        column: "720px",
      },
      letterSpacing: {
        masthead: "-0.04em",
        rubric: "0.32em",
      },
    },
  },
  plugins: [],
};

export default config;
