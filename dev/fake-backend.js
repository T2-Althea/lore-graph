// A stand-in for the user's real AI, for local testing. No dependencies.
// - POST /v1/chat/completions: recognises the extension's background requests by their
//   system prompt and answers with plausible JSON (built from the text with simple rules,
//   no AI). Anything else is treated as a normal roleplay reply.
// - POST /v1/embeddings: word-overlap vectors (hashed bag of words), so "meaning search"
//   finds texts that share words. Good enough to exercise the code paths, not real meaning.
// - GET /__requests: every chat request received (newest last), for e2e checks.
//   POST /__reset clears it.
//
// Usage: node dev/fake-backend.js [port]   (default 8124)

import http from 'node:http';
import { embed, pickAnswer } from './fake-answers.js';

const PORT = Number(process.argv[2] || process.env.FAKE_PORT || 8124);
const requests = [];

// ---------------------------------------------------------------- server

function send(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function completion(content, model) {
    return {
        id: `fake-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
}

const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : {};
    const url = req.url.replace(/^\/v1/, '');

    if (req.method === 'GET' && url === '/models') {
        return send(res, 200, { object: 'list', data: [{ id: 'fake-model', object: 'model' }, { id: 'fake-embed', object: 'model' }] });
    }
    if (req.method === 'GET' && url === '/__requests') return send(res, 200, requests);
    if (req.method === 'POST' && url === '/__reset') { requests.length = 0; return send(res, 200, { ok: true }); }

    if (req.method === 'POST' && url === '/embeddings') {
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        return send(res, 200, { object: 'list', model: body.model, data: inputs.map((t, index) => ({ object: 'embedding', index, embedding: embed(t) })) });
    }

    if (req.method === 'POST' && url === '/chat/completions') {
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const scripted = pickAnswer(messages);
        requests.push({ at: Date.now(), kind: scripted ? 'background' : 'chat', messages });
        const content = scripted ?? 'The fake model nods. "Understood." (This is a scripted test reply.)';
        if (body.stream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content } }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
            return res.end('data: [DONE]\n\n');
        }
        return send(res, 200, completion(content, body.model ?? 'fake-model'));
    }
    send(res, 404, { error: `fake backend: no route for ${req.method} ${req.url}` });
});

server.listen(PORT, '127.0.0.1', () => console.log(`Fake backend listening on http://127.0.0.1:${PORT}`));
