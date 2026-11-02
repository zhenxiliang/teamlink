// 带设备签名的 HTTP 客户端。每个请求都带协议版本头；响应里没有协议版本的，说明对面不是这一版的服务器。

import { randomBytes } from 'node:crypto';
import { signRequest } from '../shared/crypto.ts';
import { PROTOCOL, PROTOCOL_HEADER } from '../shared/protocol.ts';
import type { Identity } from './config.ts';

/** 服务器回了错误（状态码不是 2xx），或者回的不是这一版的协议。status 是 HTTP 状态码。 */
export class ClientError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** 连不上服务器或者超时：hook 据此设退避，命令行据此改存发件箱。 */
export class NetworkError extends Error {}

/** 错误的文字（不是 Error 的也转成字符串）。 */
export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** fetch 失败的原因，尽量写具体（ECONNREFUSED、超时……）。 */
function reasonOf(e: unknown): string {
  if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) return '超时';
  const code = (e as { cause?: { code?: string } })?.cause?.code;
  return code ?? (e instanceof Error ? e.message : String(e));
}

export async function call<T>(server: string, identity: Identity | null, method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
  // 签名请求的请求体里加一个随机数（服务器不认识的字段一律忽略）：ed25519 签名是确定的，
  // Codex 并行的几条 hook 在同一毫秒发出同样的请求时签名完全相同，后到的会被当成重放
  const sent = identity && method === 'POST' && body && typeof body === 'object' && !Array.isArray(body) ? { ...body, nonce: randomBytes(8).toString('hex') } : body;
  const raw = sent === undefined ? '' : JSON.stringify(sent);
  const headers: Record<string, string> = { 'content-type': 'application/json', [PROTOCOL_HEADER]: String(PROTOCOL) };
  if (identity) {
    const ts = String(Date.now());
    headers['x-tl-device'] = identity.deviceId;
    headers['x-tl-ts'] = ts;
    headers['x-tl-sig'] = signRequest(identity.privateKey, method, path, ts, raw);
  }
  const signal = AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs)));
  let res: Response;
  let text: string;
  try {
    res = await fetch(server.replace(/\/+$/, '') + path, { method, headers, body: method === 'GET' ? undefined : raw, signal });
    text = await res.text();
  } catch (e) {
    throw new NetworkError(`连不上服务器 ${server}（${reasonOf(e)}）`);
  }
  if (!(Number(res.headers.get(PROTOCOL_HEADER)) >= PROTOCOL)) {
    throw new ClientError(426, `${server} 没有返回协议版本：多半是旧版的 teamlink 服务器（请管理员先升级服务器），或者地址不对`);
  }
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new ClientError(res.status, `服务器返回的不是 JSON（HTTP ${res.status}）`);
  }
  if (!res.ok) throw new ClientError(res.status, (data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}
