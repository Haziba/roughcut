import { useEffect, useRef, useState } from 'react';
import { type ChatMsg, SYSTEM_PROMPT, applyActions, ask, describeModel, parseReply } from '../app/assistant';
import type { Editor } from '../app/editor';

const STORE = 'room-planner:chat';

interface ChatState {
  sessionId: string | null;
  messages: ChatMsg[];
  /** Failed actions from the last reply, reported to the assistant with the next message. */
  failed: string[];
  /** The instructions the session was started with; when they change, a fresh session starts. */
  system?: string;
}

const load = (): ChatState => {
  try {
    const s = JSON.parse(localStorage.getItem(STORE) ?? '');
    if (Array.isArray(s.messages)) return { sessionId: s.sessionId ?? null, messages: s.messages, failed: s.failed ?? [], system: s.system };
  } catch {
    // Nothing saved yet, or storage blocked.
  }
  return { sessionId: null, messages: [], failed: [] };
};

export function Chat({ editor }: { editor: Editor }) {
  const [state, setState] = useState(load);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const log = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify(state));
    } catch {
      // Storage full or blocked: the chat still works for this session.
    }
    log.current?.scrollTo(0, log.current.scrollHeight);
  }, [state]);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    setBusy(true);
    const before = state;
    setState({ ...before, messages: [...before.messages, { role: 'user', text }] });
    const failed = before.failed.length ? `<last_actions_result>\n${before.failed.join('\n')}\n</last_actions_result>\n\n` : '';
    // A session started under older instructions sticks to what it said it could do then, so start
    // afresh and pass the recent chat along instead.
    let sessionId = before.system === SYSTEM_PROMPT ? before.sessionId : null, errors: string[] = [];
    const recap = !sessionId && before.messages.length
      ? `<earlier_chat note="from before your abilities were updated; what you can do now is in your instructions, not in this">\n${
        before.messages.slice(-20).map((m) => `${m.role}: ${m.text}`).join('\n\n')}\n</earlier_chat>\n\n`
      : '';
    const prompt = `${recap}<model>\n${describeModel(editor)}\n</model>\n\n${failed}${text}`;
    const added: ChatMsg[] = [{ role: 'user', text }];
    try {
      const r = await ask(prompt, sessionId);
      sessionId = r.sessionId;
      const { prose, actions, error } = parseReply(r.text);
      if (prose) added.push({ role: 'assistant', text: prose });
      if (error) errors = [error];
      if (actions.length) {
        errors = [...errors, ...applyActions(editor, actions)];
        const ok = actions.length - errors.length;
        added.push({ role: 'note', text: `Applied ${ok} change${ok === 1 ? '' : 's'} (⌘Z to undo)${errors.length ? `. Failed: ${errors.join('; ')}` : ''}` });
      } else if (error) {
        added.push({ role: 'note', text: error });
      }
    } catch (e) {
      added.push({ role: 'note', text: `Error: ${(e as Error).message}` });
    }
    setState({ sessionId, messages: [...before.messages, ...added], failed: errors, system: SYSTEM_PROMPT });
    setBusy(false);
  };

  return (
    <aside className="chat" data-testid="chat">
      <div className="chat-head">
        <h3>Assistant</h3>
        <button
          onClick={() => setState({ sessionId: null, messages: [], failed: [] })}
          disabled={busy || !state.messages.length}
          data-testid="chat-new"
        >
          New chat
        </button>
      </div>
      <div className="chat-log" ref={log} data-testid="chat-log">
        {!state.messages.length && (
          <p className="chat-empty">
            Ask about your model or tell me what to put where, e.g. “add a 600 × 300 × 18 shelf 900 up the back wall”.
            Runs through your local Claude Code login. Every change I make is one undo step.
          </p>
        )}
        {state.messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>{m.text}</div>
        ))}
        {busy && <div className="msg note">Thinking…</div>}
      </div>
      <form className="chat-input" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <textarea
          value={draft}
          placeholder="Message the assistant…"
          rows={3}
          data-testid="chat-input"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button type="submit" disabled={busy || !draft.trim()} data-testid="chat-send">Send</button>
      </form>
    </aside>
  );
}
