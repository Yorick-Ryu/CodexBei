import { EditablePicker, type EditablePickerProps } from "./EditablePicker";

export function ModelPicker(props: EditablePickerProps) {
  return <EditablePicker {...props} id="model" label="模型" toggleLabel="选择模型" helpId="models-help" />;
}
