/**
 * DynamoDB refuses a request whose ExpressionAttributeNames or
 * ExpressionAttributeValues hold a key no expression uses (ValidationException:
 * "Value provided in ExpressionAttributeNames unused in expressions"). A mocked
 * client accepts anything, so a test can pass while every real call fails.
 * This checks a captured command input the way DynamoDB would.
 */
const EXPRESSION_FIELDS = [
  'UpdateExpression',
  'ConditionExpression',
  'KeyConditionExpression',
  'FilterExpression',
  'ProjectionExpression',
] as const;

export function unusedExpressionAttributes(input: Record<string, unknown>): string[] {
  const text = EXPRESSION_FIELDS.map((field) => input[field])
    .filter((v): v is string => typeof v === 'string')
    .join(' ');
  const used = new Set(text.match(/[#:][A-Za-z0-9_]+/g) ?? []);
  const declared = [
    ...Object.keys((input.ExpressionAttributeNames as Record<string, unknown>) ?? {}),
    ...Object.keys((input.ExpressionAttributeValues as Record<string, unknown>) ?? {}),
  ];
  return declared.filter((key) => !used.has(key));
}

/** Fail, naming the keys, if any command `send` was called with has unused attributes. */
export function expectNoUnusedExpressionAttributes(send: jest.Mock): void {
  for (const [command] of send.mock.calls) {
    const input = (command as { input?: Record<string, unknown> })?.input;
    if (!input) continue;
    const unused = unusedExpressionAttributes(input);
    if (unused.length > 0) {
      throw new Error(
        `DynamoDB would reject this request: unused ${unused.join(', ')} in\n${JSON.stringify(
          EXPRESSION_FIELDS.reduce((o, f) => (input[f] ? { ...o, [f]: input[f] } : o), {}),
          null,
          2,
        )}`,
      );
    }
  }
}
