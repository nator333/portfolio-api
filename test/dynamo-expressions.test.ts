import { unusedExpressionAttributes } from './dynamo-expressions';

describe('spotting expression attributes DynamoDB would reject', () => {
  it('should name the declared keys no expression uses', () => {
    // The shape of the bug that broke every day's first health note.
    expect(
      unusedExpressionAttributes({
        UpdateExpression: 'SET #notes = :first, #notesUpdatedAt = :now',
        ConditionExpression: 'attribute_exists(#measured) AND attribute_not_exists(#notes)',
        ExpressionAttributeNames: { '#measured': 'measured', '#notes': 'notes', '#notesUpdatedAt': 'n', '#id': 'x' },
        ExpressionAttributeValues: { ':now': 'n', ':first': {}, ':note': {} },
      }),
    ).toEqual(['#id', ':note']);
  });

  it('should match whole tokens, so #n1 does not count as using #n10', () => {
    expect(
      unusedExpressionAttributes({
        UpdateExpression: 'REMOVE #n10',
        ExpressionAttributeNames: { '#n1': 'a', '#n10': 'b' },
      }),
    ).toEqual(['#n1']);
  });

  it('should read every expression field, and pass a request that uses everything', () => {
    expect(
      unusedExpressionAttributes({
        KeyConditionExpression: '#pk = :pk',
        FilterExpression: 'contains(#t, :t)',
        ProjectionExpression: '#d',
        ExpressionAttributeNames: { '#pk': 'pk', '#t': 'themes', '#d': 'date' },
        ExpressionAttributeValues: { ':pk': 'x', ':t': 'sleep' },
      }),
    ).toEqual([]);
  });
});
