import type { Tool } from "./api";
import chatgpt from "../assets/agents/chatgpt.svg";
import claudeCode from "../assets/agents/claude-code.svg";
import claudeDesktop from "../assets/agents/claude.svg";

export type AppTool = Tool | "claude-desktop";
export const toolTabs = [
  { id: "codex", name: "ChatGPT", icon: chatgpt, iconClass: "chatgpt-icon" },
  { id: "claude", name: "Claude Code", icon: claudeCode, iconClass: "" },
  { id: "claude-desktop", name: "Claude 桌面版", icon: claudeDesktop, iconClass: "" },
] as const;

export function ToolTabs({ activeTool, onChange, disabled = false }: {
  activeTool: AppTool; onChange: (tool: AppTool) => void; disabled?: boolean;
}) {
  return <div className="tabs" role="tablist" aria-label="选择工具">
    {toolTabs.map((tool, index) => <button key={tool.id} role="tab" id={`${tool.id}-tab`}
      aria-selected={activeTool === tool.id} aria-controls={activeTool === tool.id ? `${tool.id}-panel` : undefined}
      disabled={disabled} onClick={() => onChange(tool.id)} onKeyDown={event => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          onChange(toolTabs[(index + (event.key === "ArrowRight" ? 1 : toolTabs.length - 1)) % toolTabs.length].id);
        }
      }}>
      <img className={`agent-icon ${tool.iconClass}`} src={tool.icon} alt="" />{tool.name}
    </button>)}
  </div>;
}
