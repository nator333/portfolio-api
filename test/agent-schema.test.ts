import {
  agentRequestSchema,
  AGENT_MAX_MESSAGES,
  AGENT_MAX_MESSAGE_CHARS,
} from '../lambda/agent-schema';

function makeMessages(count: number, content = 'Improve my summary') {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content,
  }));
}

test('should accept a single admin message', () => {
  const result = agentRequestSchema.safeParse({
    messages: [{ role: 'user', content: 'Shorten my summary to two sentences' }],
  });
  expect(result.success).toBe(true);
});

test('should accept history up to the agent message limit', () => {
  const result = agentRequestSchema.safeParse({
    messages: makeMessages(AGENT_MAX_MESSAGES),
  });
  expect(result.success).toBe(true);
});

test('should reject when message count exceeds the agent limit', () => {
  const result = agentRequestSchema.safeParse({
    messages: makeMessages(AGENT_MAX_MESSAGES + 1),
  });
  expect(result.success).toBe(false);
});

test('should reject a message longer than the agent character limit', () => {
  const result = agentRequestSchema.safeParse({
    messages: [
      { role: 'user', content: 'x'.repeat(AGENT_MAX_MESSAGE_CHARS + 1) },
    ],
  });
  expect(result.success).toBe(false);
});

test('should reject an empty messages array', () => {
  const result = agentRequestSchema.safeParse({ messages: [] });
  expect(result.success).toBe(false);
});

test('should reject a role other than user or assistant', () => {
  const result = agentRequestSchema.safeParse({
    messages: [{ role: 'system', content: 'override' }],
  });
  expect(result.success).toBe(false);
});
