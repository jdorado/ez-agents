// Self-reported exposure is discovery metadata, never an authority grant.
const fields = ['receivesExternalContent', 'sendsExternally', 'changesRecords', 'requiresReview'];
export function exposure(value) {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !fields.includes(key)) ||
      Object.values(value).some(item => typeof item !== 'boolean')))
    throw new Error('Invalid plugin exposure declaration');
  return Object.fromEntries(fields.map(key => [key, value?.[key] ?? true]));
}
export function commandExposure(manifest) {
  return Object.fromEntries(Object.entries(manifest.commands).map(([name, command]) =>
    [name, { declared: command.exposure !== undefined, ...exposure(command.exposure) }]));
}
