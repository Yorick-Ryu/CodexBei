const TOML = require('@iarna/toml');

const tomlLiteral = (value) => value && typeof value === 'object' && !Array.isArray(value)
  ? '{ ' + Object.entries(value).map(([key, child]) => `${JSON.stringify(key)} = ${TOML.stringify.value(child)}`).join(', ') + ' }'
  : TOML.stringify.value(value);

// The managed preset has one provider table; keep headers inline, as in the recommended config.
function formatPreset(preset) {
  const { model_providers, ...root } = preset;
  const lines = Object.entries(root).map(([key, value]) => `${key} = ${tomlLiteral(value)}`);
  lines.push('', '[model_providers.custom]');
  for (const [key, value] of Object.entries(model_providers.custom)) lines.push(`${key} = ${tomlLiteral(value)}`);
  return lines.join('\n') + '\n';
}
module.exports = { formatPreset, tomlLiteral };
