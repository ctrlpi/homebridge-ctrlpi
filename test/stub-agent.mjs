// Stand-in for pi-gpio-api, enough for the plugin's startup + control paths.
import { createServer } from 'node:http';

export function startMockAgent(port, name = 'mockpi') {
  const state = { config: { name, bridges: {}, gpios: {} }, pins: new Map(), calls: [], sensors: {} };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type':'application/json' }); res.end(JSON.stringify(obj)); 
      };
      // The key is recorded before the 403 below, so a call the mock refuses still
      // says which key was on it.
      state.calls.push({ method: req.method, path: p, key: req.headers['api-key'],
        body: body ? JSON.parse(body) : null });

      if (p === '/hello') {
        return send(200, { name, version: '0.9.20' });
      }
      if (req.headers['api-key'] !== 'test-key') {
        return send(403, { error: 'Forbidden' });
      }
      if (p === '/config/read') {
        return send(200, state.config);
      }
      if (p === '/config/update') {
        const b = JSON.parse(body || '{}');
        if (b.bridges) {
          Object.assign(state.config.bridges, b.bridges);
        }
        return send(200, { ok: true });
      }
      let m;
      if ((m = p.match(/^\/gpio\/config\/(\d+)$/))) {
        state.config.gpios[m[1]] = JSON.parse(body || '{}');
        if (!state.pins.has(m[1])) {
          state.pins.set(m[1], 0);
        }
        return send(200, { gpio: +m[1], ...JSON.parse(body || '{}') });
      }
      if ((m = p.match(/^\/gpio\/read\/(\d+)$/))) {
        const v = state.pins.get(m[1]) ?? 0;
        return send(200, { gpio: +m[1], value: v, type: (state.config.gpios[m[1]]?.type) || 'input' });
      }
      if ((m = p.match(/^\/gpio\/write\/(\d+)$/))) {
        const b = JSON.parse(body || '{}');
        state.pins.set(m[1], b.value === 'toggle' ? (state.pins.get(m[1]) ? 0 : 1) : (b.value ? 1 : 0));
        return send(200, { gpio: +m[1], value: state.pins.get(m[1]), duration: b.duration });
      }
      if ((m = p.match(/^\/sensor\/config\/(.+)$/))) {
        const b = JSON.parse(body || '{}');
        state.sensors[m[1]] = b.script;
        return send(200, { [m[1]]: { script: b.script } });
      }
      if ((m = p.match(/^\/sensor\/read\/(.+)$/))) {
        // a multi-field reading, so the `field` picker has something to pick
        return send(200, { [m[1]]: { temp: 21.5, humidity: 55 } });
      }
      send(404, { error: 'Not found' });
    });
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ server, state })));
}
