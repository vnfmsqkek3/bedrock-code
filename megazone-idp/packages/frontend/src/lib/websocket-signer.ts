import { SignatureV4 } from '@aws-sdk/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-browser';
import { HttpRequest } from '@smithy/protocol-http';

interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

interface SignedUrlParams {
  websocketUrl: string;
  credentials: Credentials;
  region: string;
  service?: string;
}

/**
 * AWS SigV4 서명된 WebSocket URL 생성
 */
export async function createSignedWebSocketUrl({
  websocketUrl,
  credentials,
  region,
  service = 'execute-api',
}: SignedUrlParams): Promise<string> {
  const urlObject = new URL(websocketUrl);

  const httpRequest = new HttpRequest({
    headers: {
      host: urlObject.hostname,
    },
    hostname: urlObject.hostname,
    path: urlObject.pathname,
    protocol: urlObject.protocol,
    query: Object.fromEntries(urlObject.searchParams),
  });

  const signatureV4 = new SignatureV4({
    credentials,
    region,
    service,
    sha256: Sha256,
  });

  const signedHttpRequest = await signatureV4.presign(httpRequest);

  // presign으로 생성된 쿼리 파라미터를 URL에 추가
  const query = signedHttpRequest.query;
  if (query) {
    Object.keys(query).forEach((param) => {
      urlObject.searchParams.set(param, query[param] as string);
    });
  }

  // API Gateway WebSocket connect URLs must use the ws/wss scheme. runtime-config
  // may hand us an http(s):// endpoint; SigV4 signs host/path/query (not the
  // scheme), so rewriting http→ws / https→wss after presigning stays valid.
  // Without this, `new WebSocket('https://…')` throws and the chat never connects.
  const signedUrl = urlObject.toString().replace(/^http/i, 'ws');
  console.log('Signed WebSocket URL:', signedUrl);

  return signedUrl;
}
