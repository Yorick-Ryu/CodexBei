import {
  ArrowRight, Check, ChevronLeft, ChevronRight, Copy, Eye, EyeOff, History, Monitor, Moon,
  Settings, SlidersHorizontal, Sun, X, type LucideIcon,
} from "lucide-react";

// Named imports keep the bundle limited to the Lucide icons used by the app.
// CSS may adjust size for a specific control; all icons share the same stroke.
function appIcon(Component: LucideIcon) {
  return function AppIcon() {
    return <Component size={16} strokeWidth={1.6} aria-hidden="true" />;
  };
}
export const GearIcon = appIcon(Settings);
export const SettingsIcon = appIcon(SlidersHorizontal);
export const ChevronRightIcon = appIcon(ChevronRight);
export const ArrowRightIcon = appIcon(ArrowRight);
export const ChevronLeftIcon = appIcon(ChevronLeft);
export const CheckIcon = appIcon(Check);
export const CloseIcon = appIcon(X);
export const CopyIcon = appIcon(Copy);
export const EyeIcon = appIcon(Eye);
export const EyeOffIcon = appIcon(EyeOff);
export const HistoryIcon = appIcon(History);
export const MonitorIcon = appIcon(Monitor);
export const MoonIcon = appIcon(Moon);
export const SunIcon = appIcon(Sun);
