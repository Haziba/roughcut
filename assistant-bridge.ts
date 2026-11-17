import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Dev-server endpoint for the in-app assistant. It runs your installed Claude Code CLI in
 * headless mode, so replies use your own Claude login through the official client.
 * Claude gets no tools at all (no files, no shell, no web, no MCP): it only sees the text the
 * app sends and answers with text. It runs from an empty temp folder, away from the project.
 */
const CWD = join(tmpdir(), 'room-planner-assistant');
const TIMEOUT_MS = 180_000;
const MAX_BODY = 1_000_000;

/** Read a JSON object body, capped at MAX_BODY; null for oversized, malformed or non-object bodies. */
const readJson = (req: import('node:http').IncomingMessage, then: (body: Record<string, unknown> | null) => void) => {
  let raw = '', over = false;
  req.on('data', (c) => {
    if (over) return;
    raw += c;
    if (raw.length > MAX_BODY) { over = true; raw = ''; }
  });
  req.on('end', () => {
    if (over) return then(null);
    try {
      const b = JSON.parse(raw);
      then(b && typeof b === 'object' && !Array.isArray(b) ? b : null);
    } catch {
      then(null);
    }
  });
};
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assistantBridge(): Plugin {
  return {
    name: 'room-planner-assistant',
    configureServer(server) {
      mkdirSync(CWD, { recursive: true, mode: 0o700 });
      server.middlewares.use('/api/assistant', (req, res) => {
        const send = (status: number, body: object) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(body));
        };
        // Only the app's own page may call this: other sites open in the browser can't.
        const origin = req.headers.origin;
        if (req.method !== 'POST' || !origin || new URL(origin).host !== req.headers.host) return send(403, { error: 'Forbidden' });

        readJson(req, (b) => {
          if (!b) return send(400, { error: 'Bad JSON' });
          const body = { prompt: str(b.prompt), system: str(b.system), sessionId: str(b.sessionId) };
          if (!body.prompt || !body.system) return send(400, { error: 'Missing prompt' });
          // The instructions go in a private temp file, not argv, so the process list never shows them.
          const sysFile = join(CWD, `system-${randomUUID()}.txt`);
          writeFileSync(sysFile, body.system, { mode: 0o600 });
          const args = [
            '-p', '--output-format', 'json',
            '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', '',
            '--system-prompt-file', sysFile,
          ];
          if (UUID.test(body.sessionId)) args.push(`--resume=${body.sessionId}`);

          const child = spawn('claude', args, { cwd: CWD, stdio: ['pipe', 'pipe', 'pipe'] });
          let out = '', err = '';
          const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
          child.stdout.on('data', (c) => { out += c; });
          child.stderr.on('data', (c) => { err += c; });
          child.on('error', (e) => {
            clearTimeout(timer);
            rmSync(sysFile, { force: true });
            send(500, { error: `Couldn't start Claude Code (${e.message}). Is \`claude\` installed and logged in?` });
          });
          child.on('close', (code) => {
            clearTimeout(timer);
            rmSync(sysFile, { force: true });
            if (res.writableEnded) return;
            try {
              const r = JSON.parse(out);
              if (r.is_error) return send(502, { error: String(r.result || 'Claude Code returned an error') });
              send(200, { text: String(r.result ?? ''), sessionId: r.session_id });
            } catch {
              send(502, { error: (err || out || `Claude Code exited with code ${code}`).slice(0, 500) });
            }
          });
          // The prompt goes over stdin, so it never shows up in the process list.
          child.stdin.end(body.prompt);
        });
      });

      // --- AI props: one AssetFurnace job at a time, since each one uses the whole GPU ------
      const propsDir = join(server.config.root, 'props');
      const af = process.env.ASSETFURNACE ?? join(homedir(), 'image-to-3dlab');
      const queue: string[] = [];
      let running: string | null = null;
      const statusOf = (id: string) => {
        try {
          return JSON.parse(readFileSync(join(propsDir, id, 'status.json'), 'utf8'));
        } catch {
          return null;
        }
      };
      const setStatus = (id: string, s: object) =>
        writeFileSync(join(propsDir, id, 'status.json'), JSON.stringify({ ...statusOf(id), ...s, updated: Date.now() / 1000 }));
      const pump = () => {
        if (running || !queue.length) return;
        const id = (running = queue.shift()!);
        const child = spawn(join(af, '.venv', 'bin', 'python'), [
          join(server.config.root, 'tools', 'make_prop.py'), '--out', join(propsDir, id), `--prompt=${statusOf(id)?.prompt ?? ''}`,
        ], { cwd: server.config.root, stdio: 'ignore' });
        const done = (why?: string) => {
          if (running !== id) return;
          running = null;
          if (why || statusOf(id)?.stage !== 'done') setStatus(id, { stage: 'error', error: statusOf(id)?.error ?? why ?? 'Generation failed' });
          pump();
        };
        child.on('error', (e) => done(`Couldn't start AssetFurnace (${e.message}). Is it installed at ${af}?`));
        child.on('close', () => done());
      };

      server.middlewares.use('/api/props', (req, res) => {
        const send = (status: number, body: object) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(body));
        };
        const [id, file] = (req.url ?? '').split('?')[0].split('/').filter(Boolean);
        // Browsers send no Origin on same-origin GETs, so use Sec-Fetch-Site to refuse other sites.
        const site = req.headers['sec-fetch-site'];
        if (site && site !== 'same-origin' && site !== 'none') return send(403, { error: 'Forbidden' });
        if (req.method === 'GET' && id && /^[a-z0-9]{6,16}$/.test(id)) {
          if (file === 'model.glb') {
            try {
              const glb = readFileSync(join(propsDir, id, 'prop.glb'));
              res.setHeader('Content-Type', 'model/gltf-binary');
              return res.end(glb);
            } catch {
              return send(404, { error: 'Not ready' });
            }
          }
          const s = statusOf(id);
          if (!s) return send(404, { error: 'Unknown prop' });
          // A job that was mid-way when the dev server stopped will never finish.
          if (!['done', 'error'].includes(s.stage) && running !== id && !queue.includes(id)) {
            setStatus(id, { stage: 'error', error: 'Interrupted: the dev server restarted. Ask again to retry.' });
            return send(200, statusOf(id));
          }
          return send(200, { ...s, ahead: queue.indexOf(id) + 1 });
        }
        const origin = req.headers.origin;
        if (req.method !== 'POST' || !origin || new URL(origin).host !== req.headers.host) return send(403, { error: 'Forbidden' });
        readJson(req, (body) => {
          if (!body) return send(400, { error: 'Bad JSON' });
          const pid = str(body.id), prompt = str(body.prompt).trim().slice(0, 500);
          if (!/^[a-z0-9]{6,16}$/.test(pid) || !prompt) return send(400, { error: 'Needs id and prompt' });
          if (statusOf(pid)) return send(200, statusOf(pid));
          mkdirSync(join(propsDir, pid), { recursive: true });
          setStatus(pid, { stage: 'queued', prompt, created: Date.now() / 1000 });
          queue.push(pid);
          pump();
          send(200, statusOf(pid));
        });
      });
    },
  };
}
