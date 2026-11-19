import { useRef, useState } from "react";
import { Combobox, ComboboxButton, ComboboxInput, ComboboxOption, ComboboxOptions } from "@headlessui/react";
import { CheckIcon, CloseIcon } from "./icons";

export type EditablePickerProps = {
  value: string;
  options: string[];
  disabled: boolean;
  required?: boolean;
  onChange: (value: string) => void;
};

export function EditablePicker({
  id, label, toggleLabel, helpId, type = "text", clearId, filterOptions = false,
  value, options, disabled, required = true, onChange,
}: EditablePickerProps & {
  id: string;
  label: string;
  toggleLabel: string;
  helpId?: string;
  type?: "text" | "url";
  clearId?: string;
  filterOptions?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const choices = filterOptions
    ? options.filter(option => option.toLowerCase().includes(query))
    : [...new Set([value, ...options].filter(option => option.trim()))];
  const clearLabel = `清空 ${label}`;
  return <Combobox as="div" className="select-control picker-control"
    value={value} disabled={disabled} onClose={() => setQuery("")}
    onChange={next => { if (next !== null && next !== value) onChange(next); }}>
    <ComboboxInput id={id} ref={input} type={type} aria-label={label} aria-describedby={helpId} data-value={value}
      displayValue={(selected: string) => selected} onChange={event => {
        const next = event.target.value;
        if (filterOptions) setQuery(next.trim().toLowerCase());
        onChange(next);
      }}
      placeholder={`输入或选择${label}`} required={required} autoComplete="off" spellCheck={false} />
    {clearId && <button id={clearId} type="button" className="key-action picker-clear"
      aria-label={clearLabel} title={clearLabel} aria-controls={id} disabled={disabled || !value}
      onClick={() => { setQuery(""); onChange(""); input.current?.focus({ preventScroll: true }); }}>
      <CloseIcon />
    </button>}
    <ComboboxButton id={`${id}-toggle`} className="picker-toggle" aria-label={toggleLabel} title={toggleLabel}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </ComboboxButton>
    <ComboboxOptions className="select-menu picker-menu" anchor={{ to: "bottom start", gap: 6, padding: 8 }} modal={false} portal aria-label={label}>
      {choices.map(option => (
        <ComboboxOption as="div" key={option} value={option} data-testid={`select-option-${option}`} className="select-option">
          {({ selected }) => <><span>{option}</span>{selected && <CheckIcon />}</>}
        </ComboboxOption>
      ))}
      {filterOptions && choices.length === 0 &&
        <ComboboxOption as="div" value="" disabled className="select-option">没有匹配的预设地址</ComboboxOption>}
    </ComboboxOptions>
  </Combobox>;
}
