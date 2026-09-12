export function repairEnabled(value: string | undefined): boolean {
  if (value === undefined || value === '' || value === 'true') return true
  if (value === 'false') return false
  throw new Error('EZ_REPAIR_ENABLED must be true or false')
}
