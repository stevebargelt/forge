/**
 * Fetch for an in-process dashboard fixture that can synchronously block its shared
 * event loop between requests. Closing each connection prevents a request after that
 * stall from reusing a server socket whose keep-alive timeout became due while blocked.
 */
export async function fixtureFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const headers = new Headers(request.headers);
  headers.set("connection", "close");
  return fetch(new Request(request, { headers }));
}
