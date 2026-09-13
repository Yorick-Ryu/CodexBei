import { useEffect, useState } from "react";
import { MonitorIcon, MoonIcon, SunIcon } from "./icons";
import {
  applyAppearance,
  media,
  savedAppearance,
  type Appearance,
} from "./theme";

export function ThemeSelector() {
  const [appearance, setAppearance] = useState<Appearance>(savedAppearance);
  useEffect(() => {
    const update = () => applyAppearance(appearance);
    update();
    media.addEventListener("change", update);
    try {
      localStorage.setItem("codexbei.appearance", appearance);
    } catch {
      /* Keep the preference in memory. */
    }
    return () => media.removeEventListener("change", update);
  }, [appearance]);
  const icons = [<MonitorIcon />, <MoonIcon />, <SunIcon />];
  return (
    <div
      id="theme"
      className="theme-switch"
      role="radiogroup"
      aria-label="外观主题"
    >
      {(["system", "dark", "light"] as const).map((value, i) => (
        <label key={value} title={["跟随系统", "石墨灰", "雾白"][i]}>
          <input
            type="radio"
            name="appearance"
            value={value}
            aria-label={["跟随系统", "石墨灰", "雾白"][i]}
            checked={appearance === value}
            onChange={() => setAppearance(value)}
          />
          {icons[i]}
        </label>
      ))}
    </div>
  );
}
