import { TOOL_OUTPUTS, type OutputToolName } from '../lambda/mcp-outputs';

/**
 * Fail the test, naming each mismatch, unless `body` is what the tool's
 * outputSchema says. At run time a mismatch is only logged (mcp.ts); here, on
 * real handler output, it is a failure.
 */
export function expectMatchesOutputSchema(tool: OutputToolName, body: unknown): void {
  const result = TOOL_OUTPUTS[tool].safeParse(body);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`${tool} output does not match its outputSchema:\n  ${issues.join('\n  ')}`);
  }
}
