import { Combobox, ComboboxButton, ComboboxInput, ComboboxOption, ComboboxOptions } from "@headlessui/react";
import { CheckIcon } from "./icons";

export function ModelPicker({ value, options, disabled, onChange }: {
  value: string;
  options: string[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return <Combobox as="div" className="select-control model-control" value={value} disabled={disabled}
    onChange={(next) => { if (next !== null && next !== value) onChange(next); }}>
    <ComboboxInput id="model" aria-label="模型" aria-describedby="models-help" data-value={value}
      displayValue={(selected: string) => selected} onChange={event => onChange(event.target.value)}
      placeholder="输入或选择模型" required autoComplete="off" spellCheck={false} />
    <ComboboxButton id="model-toggle" className="model-toggle" aria-label="选择模型" title="选择模型">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </ComboboxButton>
    <ComboboxOptions className="select-menu model-menu" anchor={{ to: "bottom start", gap: 6, padding: 8 }} modal={false} portal aria-label="模型">
      {[...new Set([value, ...options].filter(option => option.trim()))].map(option => (
        <ComboboxOption as="div" key={option} value={option} data-testid={`select-option-${option}`} className="select-option">
          {({ selected }) => <><span>{option}</span>{selected && <CheckIcon />}</>}
        </ComboboxOption>
      ))}
    </ComboboxOptions>
  </Combobox>;
}
