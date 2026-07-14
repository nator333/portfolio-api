import type { APIGatewayProxyEvent } from 'aws-lambda';

/**
 * REST API Lambda proxy integrations must set CORS headers on actual responses
 * themselves (defaultCorsPreflightOptions only covers the OPTIONS preflight).
 */
export function corsHeaders(event: APIGatewayProxyEvent): Record<string, string> {
  const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean);
  const origin = event.headers?.['origin'] ?? event.headers?.['Origin'] ?? '';

  if (!allowedOrigins.includes(origin)) {
    return {};
  }

  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
  };
}
