import { EditablePicker, type EditablePickerProps } from "./EditablePicker";

export const apiOrigins = [
  "https://api.beiapi.cn",
  "https://api.beiapi.top",
  "https://api.novapi.cn",
  "https://api.dianapi.cn",
];
const codexAddresses = apiOrigins.map(origin => `${origin}/v1`);
export const defaultCodexAddress = codexAddresses[0];
export const defaultClaudeAddress = apiOrigins[0];

export function ApiAddressPicker({ id, codex = false, clearId, ...props }: Omit<EditablePickerProps, "options"> & {
  id: string;
  codex?: boolean;
  clearId?: string;
}) {
  return <EditablePicker {...props} id={id} label="API 地址" toggleLabel="选择 API 地址" type="url" clearId={clearId} filterOptions
    options={codex ? codexAddresses : apiOrigins} />;
}
