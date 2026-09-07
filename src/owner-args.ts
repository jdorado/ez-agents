export const parseOwnerArgs = (argv: string[]): { command?: string; value?: string } => {
  const [command, value] = argv.filter((arg) => arg !== '--')
  return { command, value }
}
