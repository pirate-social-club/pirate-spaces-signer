export type JsonRpcSuccess<T> = {
  jsonrpc: "2.0";
  id: string | number | null;
  result: T;
};

export type JsonRpcError = {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
  };
};

export async function rpc<T>(
  url: string,
  authToken: string | null,
  method: string,
  params: unknown[] = [],
): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (authToken) {
    headers.authorization = `Basic ${authToken}`;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: method,
      method,
      params,
    }),
  });

  const body = (await response.json()) as JsonRpcSuccess<T> | JsonRpcError;
  if (!response.ok || "error" in body) {
    const message = "error" in body ? body.error.message : `http ${response.status}`;
    throw new Error(`spaced rpc ${method} failed: ${message}`);
  }
  return body.result;
}
