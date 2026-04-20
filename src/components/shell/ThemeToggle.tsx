"use client";

import { useEffect, useState } from "react";
import { Sun, Moon } from "lucide-react";

type Theme = "dark" | "light";

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    // Read whatever the boot script landed on
    const cur = document.documentElement.getAttribute("data-theme");
    if (cur === "light" || cur === "dark") setTheme(cur);
  }, []);

  function apply(next: Theme) {
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("theme", next);
    } catch {
      // ignore — private browsing, storage full, etc.
    }
  }

  return (
    <div className="theme-toggle" role="radiogroup" aria-label="Theme">
      <button
        type="button"
        role="radio"
        aria-checked={theme === "light"}
        aria-label="Light theme"
        className={theme === "light" ? "active" : ""}
        onClick={() => apply("light")}
      >
        <Sun size={14} />
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={theme === "dark"}
        aria-label="Dark theme"
        className={theme === "dark" ? "active" : ""}
        onClick={() => apply("dark")}
      >
        <Moon size={14} />
      </button>
    </div>
  );
}
