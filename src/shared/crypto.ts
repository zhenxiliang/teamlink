// 设备密钥与请求签名：每台设备持有 ed25519 私钥，服务器只存公钥。

import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';

export function generateDeviceKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

export function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 被签名的内容：方法、路径（含查询串）、时间戳、请求体摘要。 */
export function signingString(method: string, path: string, timestamp: string, body: string): string {
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${sha256(body)}`;
}

export function signRequest(privateKeyPem: string, method: string, path: string, timestamp: string, body: string): string {
  return sign(null, Buffer.from(signingString(method, path, timestamp, body)), privateKeyPem).toString('base64');
}

export function verifyRequest(
  publicKeyPem: string,
  method: string,
  path: string,
  timestamp: string,
  body: string,
  signature: string,
): boolean {
  try {
    return verify(null, Buffer.from(signingString(method, path, timestamp, body)), publicKeyPem, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}
