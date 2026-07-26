// Every way a connect attempt can end, in language meant for whoever clicked
// the link — often not the admin, and never someone who can read the server
// log. Each outcome says what happened and what to do about it; the connect
// page renders `fix` as the next step and `canRetry` decides whether the
// "add a mailbox" buttons are shown again.

export type OutcomeCode =
  | 'connected'
  | 'reconnected'
  | 'denied'
  | 'missing_scopes'
  | 'no_refresh_token'
  | 'other_workspace'
  | 'quota'
  | 'suspended'
  | 'link_malformed'
  | 'link_expired'
  | 'link_revoked'
  | 'wrong_provider'
  | 'provider_disabled'
  | 'state'
  | 'provider_error';

export interface ConnectOutcome {
  code: OutcomeCode;
  tone: 'ok' | 'error';
  title: string;
  detail: string;
  fix: string | null;
  canRetry: boolean;
}

export function isOutcomeCode(v: string): v is OutcomeCode {
  return OUTCOMES.has(v as OutcomeCode);
}

const OUTCOMES = new Set<OutcomeCode>([
  'connected',
  'reconnected',
  'denied',
  'missing_scopes',
  'no_refresh_token',
  'other_workspace',
  'quota',
  'suspended',
  'link_malformed',
  'link_expired',
  'link_revoked',
  'wrong_provider',
  'provider_disabled',
  'state',
  'provider_error',
]);

export interface OutcomeContext {
  email?: string | null;
  // Extra specifics the server knows: the quota message, the missing scopes,
  // the provider's own error text.
  detail?: string | null;
  provider?: string | null;
}

const mailbox = (ctx: OutcomeContext) => ctx.email ?? 'That mailbox';

export function describeOutcome(code: OutcomeCode, ctx: OutcomeContext = {}): ConnectOutcome {
  switch (code) {
    case 'connected':
      return {
        code,
        tone: 'ok',
        title: 'Mailbox connected',
        detail: `${mailbox(ctx)} is connected and ready to send and receive.`,
        fix: 'You can connect the next mailbox with the same link.',
        canRetry: true,
      };
    case 'reconnected':
      return {
        code,
        tone: 'ok',
        title: 'Mailbox re-authorized',
        detail: `${mailbox(ctx)} was already connected to this workspace, so its access was refreshed instead of adding a second copy.`,
        fix: 'To add a different mailbox, connect again and pick another account on the provider’s sign-in screen.',
        canRetry: true,
      };
    case 'denied':
      return {
        code,
        tone: 'error',
        title: 'Permission was not granted',
        detail: 'The sign-in was cancelled, or access was declined on the consent screen.',
        fix: 'Start again and choose Allow / Accept to finish connecting the mailbox.',
        canRetry: true,
      };
    case 'missing_scopes':
      return {
        code,
        tone: 'error',
        title: 'Some permissions were left unchecked',
        detail: `The mailbox was not connected because these permissions were not granted: ${ctx.detail ?? 'mail send and modify access'}. Without them mail cannot be sent or read.`,
        fix: 'Start again and leave every checkbox on the consent screen ticked.',
        canRetry: true,
      };
    case 'no_refresh_token':
      return {
        code,
        tone: 'error',
        title: 'The provider did not return long-lived access',
        detail:
          'Sign-in succeeded but no long-lived token came back, so the connection would stop working within the hour. Nothing was saved.',
        fix:
          ctx.provider === 'microsoft'
            ? 'Remove this app under myapps.microsoft.com → your account → app permissions, then connect again.'
            : 'Remove this app at myaccount.google.com/permissions, then connect again.',
        canRetry: true,
      };
    case 'other_workspace':
      return {
        code,
        tone: 'error',
        title: 'Mailbox belongs to another workspace',
        detail: `${mailbox(ctx)} is already connected in a different workspace on this server, and a mailbox can only live in one.`,
        fix: 'Ask an admin to disconnect it there first, or use a different mailbox.',
        canRetry: true,
      };
    case 'quota':
      return {
        code,
        tone: 'error',
        title: 'Workspace mailbox limit reached',
        detail: ctx.detail ?? 'This workspace cannot hold any more mailboxes on its current plan.',
        fix: 'Ask an admin to upgrade the plan, or to disconnect a mailbox that is no longer used.',
        canRetry: false,
      };
    case 'suspended':
      return {
        code,
        tone: 'error',
        title: 'Workspace is suspended',
        detail: 'This workspace is suspended, so new mailboxes cannot be connected.',
        fix: 'Ask an admin to reactivate the workspace, then try again.',
        canRetry: false,
      };
    case 'link_malformed':
      return {
        code,
        tone: 'error',
        title: 'This link is not valid',
        detail:
          'The link could not be read. It was probably truncated when it was copied, pasted, or wrapped by a chat or email client.',
        fix: 'Ask for the link again and open it in full — it must end exactly as it was sent.',
        canRetry: false,
      };
    case 'link_expired':
      return {
        code,
        tone: 'error',
        title: 'This link has expired',
        detail: 'Connect links can be given a lifetime, and this one has passed it.',
        fix: 'Ask an admin for a fresh link from the dashboard.',
        canRetry: false,
      };
    case 'link_revoked':
      return {
        code,
        tone: 'error',
        title: 'This link was revoked',
        detail:
          'An admin regenerated this workspace’s connect links, which switches off every link handed out before.',
        fix: 'Ask for the current link from the dashboard.',
        canRetry: false,
      };
    case 'wrong_provider':
      return {
        code,
        tone: 'error',
        title: 'Wrong provider for this link',
        detail: `This link only connects ${ctx.provider ?? 'one kind of'} mailboxes.`,
        fix: 'Ask for a link for the provider you need, or use the workspace connect page that offers both.',
        canRetry: false,
      };
    case 'provider_disabled':
      return {
        code,
        tone: 'error',
        title: 'That provider is not available',
        detail: `${ctx.provider ?? 'This provider'} sign-in is not configured on this server.`,
        fix: 'Ask an admin to configure it, or connect a mailbox from the other provider.',
        canRetry: false,
      };
    case 'state':
      return {
        code,
        tone: 'error',
        title: 'Sign-in did not complete',
        detail:
          'The sign-in took too long, was opened from a stale tab, or was interrupted on the way back. Nothing was saved.',
        fix: 'Start again from the connect link and finish the consent screen within 30 minutes.',
        canRetry: true,
      };
    case 'provider_error':
      return {
        code,
        tone: 'error',
        title: 'The provider refused the sign-in',
        detail: ctx.detail
          ? `The provider reported: ${ctx.detail}`
          : 'The provider returned an error while completing sign-in.',
        fix: 'This is usually temporary — wait a minute and try again. If it keeps happening, send this message to an admin.',
        canRetry: true,
      };
  }
}
