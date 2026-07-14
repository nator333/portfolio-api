import type { PreSignUpTriggerEvent } from 'aws-lambda';

/**
 * The user pool federates with Google, which would otherwise let any Google
 * account sign up. This trigger keeps the editor single-admin by rejecting
 * every email not on the allowlist.
 */
export const handler = async (event: PreSignUpTriggerEvent): Promise<PreSignUpTriggerEvent> => {
  const allowedEmails = (process.env.ADMIN_EMAILS ?? '')
    .toLowerCase()
    .split(',')
    .map((email) => email.trim())
    .filter(Boolean);

  const email = (event.request.userAttributes['email'] ?? '').toLowerCase();

  if (!allowedEmails.includes(email)) {
    throw new Error('Sign-up is restricted to the site administrator');
  }

  return event;
};
