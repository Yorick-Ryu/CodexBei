import { Children, isValidElement, type ReactNode } from "react";
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from "@headlessui/react";
import { CheckIcon } from "./icons";

type Props = {
  id: string;
  value?: string;
  disabled?: boolean;
  required?: boolean;
  "aria-label"?: string;
  children: ReactNode;
  onChange: (event: { target: { value: string } }) => void;
};

export function Select({ id, value, disabled, children, onChange, "aria-label": label }: Props) {
  const options = Children.toArray(children).filter(isValidElement).map(child => {
    const props = child.props as { value: string; children: ReactNode; disabled?: boolean };
    return { value: props.value, label: props.children, disabled: props.disabled };
  });
  const selectedValue = value ?? options[0]?.value ?? "";
  const selected = options.find(option => option.value === selectedValue) ?? options[0];
  return <Listbox as="div" className="select-control" value={selectedValue} disabled={disabled}
    onChange={(next: string) => { if (next !== value) onChange({ target: { value: next } }); }}>
    <ListboxButton id={id} type="button" value={selectedValue} data-value={selectedValue} className="select-trigger" aria-label={label || id}>
      <span>{selected?.label}</span><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </ListboxButton>
    <ListboxOptions className="select-menu" modal={false} portal={false} aria-label={label}>
      {options.map(option => <ListboxOption as="div" key={option.value} value={option.value} disabled={option.disabled} data-testid={`select-option-${option.value}`} className="select-option">
        {({ selected }) => <><span>{option.label}</span>{selected && <CheckIcon />}</>}
      </ListboxOption>)}
    </ListboxOptions>
  </Listbox>;
}
