// Fork: a new session holding a copy of a session's conversation (POST
// /api/sessions/:id/fork). Pure helpers for which messages it can start from and for
// the notice that marks a fork.

// "Fork from here" is offered on the user's own turns: not the messages sent to model
// agents, not those still queued or cancelled, not in the Trash, and not the history a
// Codex import brought along (it is not in a Claude Code transcript to copy from).
export function canForkFrom(message, session) {
  if (message?.role !== 'user' || !message.id || !session || session.removed) return false;
  if (message.parentToolId || message.delivery === 'queued' || message.delivery === 'cancelled') return false;
  return !(message.imported && session.source?.kind === 'codex');
}

// A fork notice reads Forked from “Title”. (the one for a fork from a message adds words
// after the title): the text around the title, so the title can link to the original.
export function splitForkNotice(text) {
  const match = /^([^“]*“)([\s\S]*)(”[\s\S]*)$/.exec(String(text || ''));
  return match ? { before: match[1], title: match[2], after: match[3] } : null;
}
