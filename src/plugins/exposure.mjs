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
// Restricted-task eligibility of an installed command for one granted capability.
// Channel queries are read-only; scoped commands bind one application scope and
// declare `taskScope` read or write. None may send externally or need review.
export function taskCommandAllowed(command, capability) {
  const declared = command?.exposure;
  if (declared?.receivesExternalContent !== true || declared.sendsExternally !== false || declared.requiresReview !== false) return false;
  if (capability.access !== undefined)
    return command.taskScope === capability.access && (capability.access === 'write' ? typeof declared.changesRecords === 'boolean' : declared.changesRecords === false);
  return declared.changesRecords === false && (capability.output === 'file' ? command.channelFile : command.channelQuery) === true;
}
