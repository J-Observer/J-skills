import http from 'node:http';
import { execFileSync } from 'node:child_process';

let configured = false;

// Reuse the user's enabled proxy. Keep this process-local: never change the
// registry, credentials, or machine-wide environment. Explicit env wins.
export function configureNetwork() {
  if (configured) return;
  configured = true;
  if (typeof http.setGlobalProxyFromEnv !== 'function') return;
  const env = { ...process.env };
  if (!env.HTTPS_PROXY && !env.https_proxy && !env.HTTP_PROXY && !env.http_proxy && process.platform === 'win32') {
    try {
      const settings = execFileSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
      if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/.test(settings)) return;
      const server = settings.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/)?.[1].trim();
      if (!server) return;
      const protocols = Object.fromEntries(server.split(';').filter((part) => part.includes('=')).map((part) => part.split('=')));
      const url = (value) => value && (/^https?:\/\//i.test(value) ? value : `http://${value}`);
      if (server.includes('=')) {
        env.HTTP_PROXY = url(protocols.http);
        env.HTTPS_PROXY = url(protocols.https);
      } else {
        env.HTTP_PROXY = env.HTTPS_PROXY = url(server);
      }
    } catch { return; }
  }
  if (env.HTTP_PROXY || env.http_proxy || env.HTTPS_PROXY || env.https_proxy) {
    env.no_proxy = [env.no_proxy || env.NO_PROXY, 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(',');
    http.setGlobalProxyFromEnv(env);
  }
}
